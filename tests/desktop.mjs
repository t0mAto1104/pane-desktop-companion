import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron as driver } from 'playwright-core';

const run = promisify(execFile);
const temporary = resolve(tmpdir());
const profile = await mkdtemp(join(temporary, 'pane-qa-'));
const helper = resolve('native/bin/window-capture.exe');
const launcher = join(profile, 'mock');
const packaged = process.argv.includes('--packaged');
const production = packaged || process.argv.includes('--production');
let fixture;
let desktop;

async function openApp() {
  const executablePath = packaged ? resolve('release/win-unpacked/Pane.exe') : electron;
  const entry = production ? '.' : resolve('dist/test/main.cjs');
  return driver.launch({ executablePath, args: [...(packaged ? [] : [entry]), '--user-data-dir=' + launcher], timeout: 25_000 });
}

async function shot(page) {
  await page.getByRole('button', { name: '预览截图' }).waitFor({ timeout: 10_000 });
  return page.evaluate(async () => {
    const img = document.querySelector('.attachment img');
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const [r, g, b] = ctx.getImageData(Math.floor(canvas.width * .16), Math.floor(canvas.height * .25), 1, 1).data;
    return { width: canvas.width, height: canvas.height, r, g, b };
  });
}

try {
  if (!production) {
    await build({
      entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
      bundle: true, platform: 'node', target: 'node24', format: 'cjs',
      outdir: 'dist/test', outExtension: { '.js': '.cjs' }, external: ['electron'],
      plugins: [{
        name: 'test-ai-only',
        setup(build) {
          build.onResolve({ filter: /^\.\/ai$/ }, args => args.importer.includes('src') ? { path: resolve('tests/ai-fixture.ts') } : undefined);
        },
      }],
    });
  }

  desktop = await openApp();
  let page = await desktop.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => console.error('Renderer error:', error.message));
  await page.getByRole('heading', { name: '聊聊屏幕上的内容' }).waitFor({ timeout: 10_000 });
  const snapshot = () => page.evaluate(async () => (await window.pane.call('snapshot')).value);
  const initial = await snapshot();
  assert.equal(initial.shortcut, true, 'shortcut registered');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop()), true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  console.log('Desktop, shortcut registration, always-on-top and renderer isolation passed.');

  if (production) {
    await page.getByRole('button', { name: '连接 ChatGPT' }).click();
    await page.getByRole('button', { name: '使用 ChatGPT 登录' }).waitFor();
    assert.deepEqual(await page.evaluate(async () => (await window.pane.call('account:state')).value), { status:'disconnected', sharing:false, apiKey:false, label:undefined });
    assert.ok((await page.evaluate(async () => window.pane.call('window:list'))).ok, 'native helper is included');
    console.log(packaged ? 'Packaged app and bundled helper started.' : 'Production app and native helper started.');
    const displays = await desktop.evaluate(({ screen }) => screen.getAllDisplays().map(display => display.scaleFactor));
    console.log('Host display scale factors:', displays);
    const dpapi = await desktop.evaluate(({ safeStorage }) => {
      const encrypted = safeStorage.encryptString('Pane DPAPI fixture');
      return [safeStorage.isEncryptionAvailable(), encrypted.includes('Pane DPAPI fixture'), safeStorage.decryptString(encrypted)];
    });
    assert.deepEqual(dpapi, [true, false, 'Pane DPAPI fixture']);
    const owner = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
    await page.getByLabel('连接方式', { exact: true }).selectOption('api-key');
    const promptButton = page.getByRole('button', { name: '添加 API Key' });
    await promptButton.waitFor();
    assert.equal(await promptButton.isEnabled(), true);
    const prompt = page.evaluate(() => window.pane.call('account:addKey'));
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/close-credential.ps1'), owner, 'Pane · OpenAI API Key'], { windowsHide: true });
    const promptResult = await prompt;
    assert.equal(promptResult.ok, true);
    assert.equal(promptResult.value.apiKey, false);
    console.log('Windows credential prompt opens and cancels. DPAPI round-trip passed.');
  } else {
    await page.getByText('本地视觉验收模型', { exact: true }).waitFor();
    await page.getByRole('button', { name: '隐藏到托盘' }).click();
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    fixture = await driver.launch({ executablePath: electron, args: [resolve('tests/fixture.cjs'), '--user-data-dir=' + join(profile, 'fixture')], timeout: 25_000 });
    const fixturePage = await fixture.firstWindow();
    await fixturePage.getByText('纸上交易 · DEMO').waitFor();
    const handle = await fixture.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.focus();
      return win.getNativeWindowHandle().readBigUInt64LE().toString();
    });
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/hotkey.ps1'), handle], { windowsHide:true });
    const first = await shot(page);
    assert.ok(first.width > 500 && first.height > 300 && first.g > first.r + 45 && first.g > first.b + 30, JSON.stringify(first));
    assert.equal((await snapshot()).capture.target.id.split(':')[0], handle);
    await page.getByRole('button', { name: '预览截图' }).click();
    await page.getByRole('button', { name: '取消发送截图' }).click();
    await page.getByRole('button', { name: '预览截图' }).waitFor({ state: 'hidden' });
    await page.getByTitle('选择目标窗口').click();
    assert.equal(await page.getByRole('button', { name: /Pane · 桌面助手/ }).count(), 0);
    await page.getByRole('dialog').getByRole('button', { name: /Pane 纸上交易验收/ }).click({ timeout: 10000 });
    assert.ok((await shot(page)).g > 110, 'binding captures an occluded fixture window');
    assert.equal((await snapshot()).capture.bound, true);
    await fixturePage.evaluate(() => { document.body.style.backgroundColor = '#bb5039'; });
    const previousShot = (await snapshot()).capture.shot.id;
    await page.getByRole('button', { name: '刷新截图' }).click();
    await page.waitForFunction(async previous => {
      const shot = (await window.pane.call('snapshot')).value.capture.shot;
      return shot && shot.id !== previous;
    }, previousShot, { timeout: 10000 });
    const second = await shot(page);
    assert.ok(second.r > second.g + 60, JSON.stringify(second));
    console.log('Prior HWND, real WGC pixels, preview dismissal, binding and refresh passed.');

    const question = page.getByRole('textbox', { name: '输入你的问题' });
    await question.fill('这个模拟交易窗口显示了什么？');
    await question.press('Enter');
    await page.getByText('SIM-101', { exact: true }).waitFor();
    await page.locator('pre code').getByText('125.40').waitFor();
    await page.getByRole('button', { name: '重发上一条' }).waitFor();
    await question.fill('这是多少手？');
    await question.press('Enter');
    await page.getByText('10 手', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重发上一条' }).click();
    await page.getByRole('button', { name: '重发上一条' }).waitFor();
    assert.equal(await page.getByText('这是多少手？', { exact: true }).count(), 1);
    await question.fill('现在停止');
    await question.press('Enter');
    await page.getByText('可保留的部分回答', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停止生成' }).click();
    await page.getByText('已停止生成', { exact: true }).waitFor();
    console.log('Mocked image conversation, progress, Markdown, retry and stop passed.');

    await page.getByTitle('配置连接和模型').click();
    await page.getByLabel('主题', { exact: true }).selectOption('dark');
    await page.getByLabel('每行一个可执行文件名').fill('electron.exe');
    await page.getByRole('button', { name: '保存名单' }).click();
    await page.getByText('已保存', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗' }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    const nativeWindows = JSON.parse((await run(helper, ['list', '0'], { windowsHide: true })).stdout);
    const blocked = nativeWindows.find(item => item.id.split(':')[0] === handle);
    assert.ok(blocked);
    await assert.rejects(run(helper, ['capture', '0', blocked.id, 'ELECTRON.EXE'], { windowsHide: true }), { stderr: 'blocked' });
    assert.ok(!(await page.evaluate(async () => (await window.pane.call('window:list')).value)).some(target => target.id === blocked.id));
    await fixture.close();
    fixture = undefined;
    await desktop.close();
    desktop = undefined;
    const database = await readFile(join(launcher, 'pane.sqlite'));
    assert.equal(database.includes(Buffer.from('data:image/jpeg;base64')), false);
    assert.equal((await readdir(launcher)).some(file => /\.(jpg|jpeg|png)$/i.test(file)), false);

    desktop = await openApp();
    page = await desktop.firstWindow();
    await page.getByText('10 手', { exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('button', { name: /^删除对话/ }).focus();
    await page.getByRole('button', { name: /^删除对话/ }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('还没有对话', { exact: true }).waitFor();
    console.log('Denylist, theme persistence, SQLite restart, deletion and screenshot ephemerality passed.');
  }
} finally {
  await fixture?.close();
  await desktop?.close();
  if (dirname(profile) === temporary && profile.startsWith(join(temporary, 'pane-qa-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
