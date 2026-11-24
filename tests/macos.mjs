
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron as driver } from 'playwright-core';

assert.equal(process.platform, 'darwin', 'macOS tests require a Mac');
const run = promisify(execFile);
let helper = resolve('native/bin/macos/pane-native');
let whisper = resolve('native/bin/macos/whisper/whisper-cli');
let bundle;
if (process.argv.includes('--packaged')) {
  const dirs = await readdir('release', { withFileTypes: true });
  const app = dirs.find(item => item.isDirectory() && /^mac(?:-(arm64|x64))?$/.test(item.name));
  assert.ok(app, 'Packaged Pane.app is missing');
  bundle = resolve('release', app.name, 'Pane.app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  const native = join(bundle, 'Contents/Resources/native');
  helper = join(native, 'pane-native');
  whisper = join(native, 'whisper/whisper-cli');
}

const call = (command, ...values) => run(helper, [command, String(process.pid), ...values],
  { maxBuffer: 13 * 1024 * 1024, timeout: 10_000, encoding: 'buffer' }).then(result => result.stdout);
const json = async (...args) => JSON.parse((await call(...args)).toString());
assert.deepEqual(await json('self-check'), { platform: 'darwin', protocol: 1 });
assert.ok(Array.isArray(await json('audio-list')));
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
for (const binary of [helper, whisper]) {
  const { stdout } = await run('/usr/bin/lipo', ['-archs', binary]);
  assert.equal(stdout.trim(), arch);
}
await run(whisper, ['--help'], { timeout: 10_000 });
console.log('Native helper protocol, audio enumeration, bundle validation (packaged mode), and Whisper CLI architecture passed.');

if (bundle) {
  const profile = await mkdtemp(join(tmpdir(), 'pane-macos-profile-'));
  let desktop;
  try {
    desktop = await driver.launch({ executablePath: join(bundle, 'Contents/MacOS/Pane'),
      args: ['--show-main', '--user-data-dir=' + profile], timeout: 25_000 });
    const page = await desktop.firstWindow();
    await page.getByRole('heading', { name: '聊聊屏幕上的内容' }).waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => typeof require), 'undefined');
    const checks = await page.evaluate(async () => ({
      snapshot: await window.pane.call('snapshot'),
      permissions: await window.pane.call('permissions:state'),
      unknown: await window.pane.call('permissions:arbitrary'),
    }));
    assert.ok(checks.snapshot.ok && checks.snapshot.value.mac);
    assert.ok(checks.permissions.ok &&
      ['screen', 'accessibility', 'microphone'].every(key => typeof checks.permissions.value[key] === 'boolean'));
    assert.equal(checks.unknown.ok, false);
    console.log('Packaged Electron window, platform IPC, and renderer isolation passed.');
  } finally {
    await desktop?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

if (!process.argv.includes('--interactive')) {
  console.log('Interactive screen, AX, and microphone tests require a logged-in Mac and system permissions.');
  process.exit(0);
}

const scratch = await mkdtemp(join(tmpdir(), 'pane-macos-test-'));
let fixture;
const closed = new AbortController();
try {
  const binary = join(scratch, 'pane-mac-fixture');
  await run('xcrun', ['swiftc', 'tests/macos-fixture.swift', '-o', binary], { timeout: 60_000 });
  fixture = spawn(binary, [], { stdio: 'inherit', signal: closed.signal });
  fixture.on('error', () => {});
  let target;
  for (let attempt = 0; attempt < 25 && !target; attempt++) {
    const targets = await json('list');
    target = targets.find(item => item.id.split(':')[1] === String(fixture.pid));
    if (!target) await delay(200);
  }
  assert.ok(target, 'Fixture is not visible');
  const args = [target.id, '--expected-executable', target.executable];
  assert.equal((await json('verify', ...args)).id, target.id);
  assert.equal((await json('foreground')).id, target.id, 'Bring the fixture to the front');
  await assert.rejects(call('verify', ...args, target.executable), /blocked/);
  await assert.rejects(call('verify', target.id + '1', '--expected-executable', target.executable), /target_gone/);

  function image(packet) {
    const end = packet.indexOf(10);
    assert.ok(end > 0 && packet[end + 1] === 0xff && packet[end + 2] === 0xd8);
    return JSON.parse(packet.subarray(0, end).toString());
  }
  assert.equal(image(await call('capture', ...args)).id, target.id);
  const roi = image(await call('roi', ...args, '250000', '250000', '500000', '500000'));
  assert.equal(roi.target.id, target.id);
  assert.ok(Math.abs(roi.pixels.width / roi.frameSize.width - 0.5) < 0.01);
  const inspection = await json('uia', ...args);
  assert.ok(inspection.tree.elements.some(item => item.name === 'Pane test button' && item.controlType === 50000));
  const selected = await json('selection');
  assert.equal(selected.target.id, target.id);
  assert.equal(selected.selection.status, 'ok');
  assert.equal(selected.selection.text, 'margin requirement');
  closed.abort();
  await delay(450);
  await assert.rejects(call('verify', ...args), /target_gone/);
  console.log('Interactive window identity, deny list, actual window JPEG, ROI, AX tree, selected text, and window close passed.');
} finally {
  closed.abort();
  await rm(scratch, { recursive: true, force: true });
}
