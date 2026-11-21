import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron as driver } from 'playwright-core';

const temporary = resolve(tmpdir());
const profile = await mkdtemp(join(temporary, 'pane-mascot-test-'));
const packaged = process.argv.includes('--packaged');
const preview = process.argv.find(arg => arg.startsWith('--preview='))?.slice('--preview='.length);
const requestLog = join(profile, 'requests.log');
let desktop, fixture;
const run = promisify(execFile);

async function loadApp() {
  desktop = await driver.launch({
    executablePath: packaged ? resolve('release/win-unpacked/Pane.exe') : electron,
    args: [...(packaged ? [] : [resolve('dist/mascot-test/main.cjs')]), '--user-data-dir=' + join(profile, 'pane')],
    env: { ...process.env, PANE_TEST_REQUEST_LOG: requestLog },
  });
  const main = await desktop.firstWindow();
  main.setDefaultTimeout(10000);
  await main.getByRole('heading', { name: '聊聊屏幕上的内容' }).waitFor({ state: 'attached' });
  let pet;
  for (let attempt = 0; attempt < 80 && !pet; attempt++) {
    pet = desktop.windows().find(page => page.url().endsWith('#mascot'));
    if (!pet) await sleep(100);
  }
  assert.ok(pet, 'the independent mascot surface must load');
  await pet.getByRole('button', { name: '打开或收起浮动聊天' }).waitFor();
  return { main, pet };
}

async function state() {
  return desktop.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#mascot'));
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/index.html'));
    return { mascot: pet?.isVisible(), focused: pet?.isFocused(), pet: pet?.getBounds(), main: main?.isVisible(), chat: main?.getBounds() };
  });
}

async function waitState(check) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await state();
    if (check(value)) return value;
    await sleep(100);
  }
  throw new Error('Unexpected window state: ' + JSON.stringify(await state()));
}

try {
  if (!packaged) await build({
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outdir: 'dist/mascot-test',
    outExtension: { '.js': '.cjs' }, external: ['electron'],
    plugins: [{ name: 'mascot-fixture-ai', setup(build) {
      build.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: resolve('tests/ai-fixture.ts') }));
    } }],
  });
  let { main, pet } = await loadApp();
  const original = await waitState(value => value.mascot && !value.main && !value.focused);
  const petAction = (action) => pet.evaluate(action => window.pane.call(action), action);
  assert.equal((await petAction('account:state')).ok, false);
  assert.equal((await petAction('capture:refresh')).ok, false);
  assert.equal((await petAction('snapshot')).ok, false);
  const bitmap = await pet.locator('img').evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [image.src, ctx.getImageData(0, 0, 1, 1).data[3]];
  });
  assert.ok(bitmap[0].endsWith('/orbit.png'));
  assert.equal(bitmap[1], 0);
  const grip = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const sprite = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#mascot'));
    const area = sprite.getBounds();
    return {
      handle: sprite.getNativeWindowHandle().readBigUInt64LE().toString(),
      point: screen.dipToScreenPoint({ x: area.x + 46, y: area.y + 88 }),
    };
  });
  const hit = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('tests/mascot-hit.ps1'), grip.handle, String(grip.point.x), String(grip.point.y)], { windowsHide: true });
  assert.equal(hit.stdout.trim(), '2', 'Windows recognizes the grip as a native drag region');
  console.log('Transparent non-activating mascot launches alone, with a native drag region and without capture or account IPC.');

  fixture = await driver.launch({ executablePath: electron, args: [resolve('tests/fixture.cjs'), '--user-data-dir=' + join(profile, 'fixture')] });
  const terminal = await fixture.firstWindow();
  await terminal.getByText('纸上交易 · DEMO').waitFor();
  const fixtureId = await fixture.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.focus();
    return win.getNativeWindowHandle().readBigUInt64LE().toString();
  });
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('tests/hotkey.ps1'), fixtureId, 'focus-only'], { windowsHide: true });

  await pet.getByRole('button').click();
  await main.getByRole('button', { name: '截取窗口' }).waitFor();
  const small = await waitState(value => value.mascot && value.main && value.chat.width < 570);
  assert.ok(small.chat.x + small.chat.width <= small.pet.x || small.chat.x >= small.pet.x + small.pet.width ||
    small.chat.y + small.chat.height <= small.pet.y);
  const snapshot = () => main.evaluate(async () => (await window.pane.call('snapshot')).value);
  const initial = await snapshot();
  assert.equal(initial.compact, true);
  assert.equal(initial.capture.target.id.split(':')[0], fixtureId);
  assert.equal(initial.capture.shot, null, 'only explicit screen capture attaches an image');
  const requestCount = async () => (await readFile(requestLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  assert.equal(await requestCount(), 0);
  await main.getByRole('button', { name: '截取窗口' }).click();
  await main.getByRole('button', { name: '预览截图' }).click();
  const previewImage = main.getByRole('dialog').getByRole('img', { name: 'Pane 纸上交易验收' });
  const pixels = await previewImage.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [image.naturalWidth, ...ctx.getImageData(Math.floor(canvas.width * .16), Math.floor(canvas.height * .25), 1, 1).data];
  });
  assert.ok(pixels[0] > 500 && pixels[2] > pixels[1] + 25, JSON.stringify(pixels));
  await main.getByRole('button', { name: '取消发送截图' }).click();
  assert.equal((await snapshot()).capture.shot, null);
  assert.equal(await requestCount(), 0);
  console.log('Real foreground fixture capture has correct WGC pixels, explicit preview and removal before sending.');

  if (!packaged) {
    await main.getByRole('button', { name: '截取窗口' }).click();
    await main.getByRole('button', { name: '预览截图' }).waitFor();
    await main.getByRole('textbox', { name: '输入你的问题' }).fill('这个模拟交易窗口显示了什么？');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await main.getByText('上轮实际来源 · 手动截图', { exact: false }).waitFor();
    await main.getByText('SIM-101', { exact: true }).waitFor();
    await main.getByRole('button', { name: '重发上一条' }).waitFor();
    if (preview) {
      // A user-facing preview uses only the dedicated fixture and a local model substitute.
      await main.screenshot({ path: preview });
    }
    const observedTarget = (await snapshot()).capture.target.id;
    const enabled = await main.evaluate(async id => {
      const settings = await window.pane.call('settings:update', { screenAwarenessEnabled: true });
      return settings.ok && (await window.pane.call('capture:bind', id)).ok;
    }, observedTarget);
    assert.equal(enabled, true);
    await main.waitForFunction(async () => {
      const result = await window.pane.call('snapshot');
      return result.ok && result.value.observation.phase === 'watching' && result.value.observation.latest;
    }, null, { timeout: 10000 });
    await main.getByRole('textbox', { name: '输入你的问题' }).fill('这是多少手？');
    await main.getByRole('button', { name: '发送', exact: true }).click();
    await main.getByText('上轮实际来源 · 仅文字', { exact: true }).waitFor();
    await main.locator('.answer').last().getByText('10 手', { exact: true }).waitFor();
    assert.equal(await requestCount(), 2);
    console.log('Vision and text sends share the chat history; a running observation does not attach an image in compact mode.');
  }

  await main.getByRole('button', { name: '桌面指导' }).click();
  await main.getByRole('dialog', { name: '桌面指导' }).waitFor();
  await waitState(value => value.main && value.mascot && value.chat.width < 570);
  if (packaged) {
    const guide = main.getByRole('dialog', { name: '桌面指导' });
    await guide.getByRole('button', { name: '选择目标窗口' }).click();
    await main.getByRole('dialog', { name: '选择目标窗口' }).getByRole('button', { name: /Pane 纸上交易验收/ }).click();
    await guide.getByRole('textbox', { name: '教学任务' }).waitFor();
    assert.equal((await snapshot()).capture.bound, true);
    assert.equal((await snapshot()).capture.shot, null);
  }
  await main.getByRole('button', { name: '返回聊天' }).click();
  await main.getByRole('button', { name: '展开主窗口' }).click();
  await waitState(value => value.main && !value.mascot && value.chat.width >= 570);
  await main.getByRole('button', { name: '设置', exact: false }).first().click();
  await main.getByLabel('助手外观').selectOption('fox');
  await main.getByRole('button', { name: '隐藏到托盘' }).click();
  await waitState(value => value.mascot && !value.main);
  assert.ok((await pet.locator('img').getAttribute('src')).endsWith('/fox.png'));
  const moved = await desktop.evaluate(({ BrowserWindow, screen }) => {
    const sprite = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#mascot'));
    const area = screen.getDisplayMatching(sprite.getBounds()).workArea;
    const point = { x: area.x + 37, y: area.y + 47 };
    sprite.setPosition(point.x, point.y);
    return point;
  });
  assert.notEqual(moved.x, original.pet.x);

  await desktop.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); });
  await waitState(value => !value.mascot && !value.main);
  await desktop.evaluate(({ powerMonitor }) => { powerMonitor.emit('unlock-screen'); });
  await waitState(value => value.mascot && !value.main);
  const current = await state();
  assert.equal(current.pet.x, moved.x);
  await desktop.close();
  desktop = undefined;
  ({ main, pet } = await loadApp());
  const reopened = await waitState(value => value.mascot && !value.main);
  assert.equal(reopened.pet.x, moved.x);
  assert.equal(reopened.pet.y, moved.y);
  assert.ok((await pet.locator('img').getAttribute('src')).endsWith('/fox.png'));
  console.log('Guidance opens compact and the full window can be restored; character and position persist across restart and the mascot hides on lock.');
} finally {
  await fixture?.close();
  await desktop?.close();
  if (dirname(profile) === temporary && profile.startsWith(join(temporary, 'pane-mascot-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
