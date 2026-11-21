import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import { _electron as driver } from 'playwright-core';
import electron from 'electron';

const temp = resolve(tmpdir());
const profile = await mkdtemp(join(temp, 'pane-voice-'));
const logs = join(profile, 'voice.log');
const requests = join(profile, 'requests.log');
let desktop;
try {
  await build({
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' }, bundle: true,
    platform: 'node', target: 'node24', format: 'cjs', outdir: 'dist/voice-test',
    outExtension: { '.js': '.cjs' }, external: ['electron'],
    plugins: [{ name: 'voice-test', setup(build) {
      build.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: resolve('tests/ai-fixture.ts') }));
      build.onResolve({ filter: /^\.\/voice-device$/ }, () => ({ path: resolve('tests/voice-device-fixture.ts') }));
    } }],
  });
  desktop = await driver.launch({
    executablePath: electron, args: [resolve('dist/voice-test/main.cjs'), '--show-main', '--user-data-dir=' + join(profile, 'pane')],
    env: { ...process.env, PANE_TEST_VOICE_LOG: logs, PANE_TEST_REQUEST_LOG: requests },
  });
  const app = await desktop.firstWindow();
  await app.getByText('本地视觉验收模型', { exact: true }).waitFor();
  for (let i = 0; i < 40 && !await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(w => w.isVisible() && w.webContents.getURL().endsWith('index.html'))); ++i) await sleep(100);
  async function open() {
    const opened = await app.evaluate(() => window.pane.call('voice:open'));
    assert.equal(opened.ok, true, JSON.stringify(opened));
    for (let i = 0; i < 40; ++i) {
      const page = desktop.windows().find(win => win.url().endsWith('#voice') && !win.isClosed());
      if (page) { await page.getByRole('button', { name: '使用麦克风' }).waitFor(); return page; }
      await sleep(100);
    }
    throw new Error('Voice pane did not open: ' + JSON.stringify(await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map(win => ({ url: win.webContents.getURL(), visible: win.isVisible() })))));
  }
  let voice = await open();
  assert.equal(await voice.evaluate(() => typeof window.pane), 'undefined');
  assert.equal((await readFile(logs, 'utf8').catch(() => '')).length, 0);
  await voice.getByRole('button', { name: '使用麦克风' }).click();
  await voice.getByText('正在听写', { exact: true }).waitFor();
  await voice.getByRole('button', { name: '关闭语音' }).click();
  for (let i = 0; i < 40 && !voice.isClosed(); i++) await sleep(25);
  assert.ok(voice.isClosed());
  voice = await open();
  await voice.getByRole('button', { name: '使用麦克风' }).click();
  const draft = voice.getByRole('textbox', { name: '语音转写文字' });
  await voice.waitForFunction(() => document.querySelector('textarea').value === '这是语音转写测试');
  assert.equal((await readFile(requests, 'utf8').catch(() => '')).length, 0);
  await draft.fill('语音稿已人工确认');
  await voice.getByRole('button', { name: '发送文字' }).click();
  await voice.getByRole('button', { name: '再读一遍' }).waitFor();
  assert.ok((await readFile(logs, 'utf8')).includes('cancel'));
  assert.equal((await readFile(logs, 'utf8')).trim().split('\n').filter(line => line === 'speak').length, 1);
  assert.equal((await readFile(requests, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await app.evaluate(() => window.pane.call('chat:list'))).value.length, 1);
  await voice.getByRole('button', { name: '使用麦克风' }).click();
  await voice.getByText('正在听写', { exact: true }).waitFor();
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  for (let i = 0; i < 40 && !voice.isClosed(); i++) await sleep(25);
  assert.ok(voice.isClosed(), 'suspend cancels the voice window');
  assert.equal((await readFile(logs, 'utf8')).trim().split('\n').filter(line => line === 'cancel').length, 2);
  console.log('Voice mic consent, local review, shared chat, reply playback, close and suspend cancellation passed (device mock).');
} finally {
  await desktop?.close();
  if (dirname(profile) === temp && profile.startsWith(join(temp, 'pane-voice-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
