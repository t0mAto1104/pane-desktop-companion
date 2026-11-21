import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron, chromium } from 'playwright-core';
import { build } from 'esbuild';
import electron from 'electron';

const exec = promisify(execFile);
const profiles = await mkdtemp(join(tmpdir(), 'pane-selection-'));
const log = join(profiles, 'requests');
const helper = resolve('native/bin/window-capture.exe');
const browserPath = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const start = process.hrtime.bigint();
let browser, desktop;
const native = async (...args) => {
  const result = await exec(helper, args, { timeout: 2500, windowsHide: true });
  return JSON.parse(result.stdout);
};
try {
  await stat(browserPath);
  await build({
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outdir: 'dist/selection-test',
    outExtension: { '.js': '.cjs' }, external: ['electron'],
    plugins: [{ name: 'selection-fixtures', setup(build) {
      build.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: resolve('tests/ai-fixture.ts') }));
    } }],
  });
  // Keep the installed Pane instance free to use its normal global shortcuts.
  const fixtureEntry = resolve('dist/selection-test/qa-entry.cjs');
  await writeFile(fixtureEntry, `
    const { globalShortcut } = require('electron');
    const register = globalShortcut.register.bind(globalShortcut);
    globalShortcut.register = (key, callback) => register(key === 'Control+Shift+Q' ? 'Control+Shift+F11' : key, callback);
    require('./main.cjs');
  `);
  desktop = await _electron.launch({ executablePath: electron,
    args: [fixtureEntry, '--user-data-dir=' + join(profiles, 'pane'), '--show-main'],
    env: { ...process.env, PANE_TEST_REQUEST_LOG: log } });
  const app = await desktop.firstWindow();
  const call = (name, ...args) => app.evaluate(([key, ...params]) => window.pane.call(key, ...params), [name, ...args]);
  await app.getByText('本地视觉验收模型', { exact: true }).waitFor();
  await call('window:hide');
  browser = await chromium.launchPersistentContext(join(profiles, 'browser'), {
    executablePath: browserPath, headless: false, viewport: null,
    args: ['--force-renderer-accessibility', '--enable-features=UiaProvider', '--no-first-run', '--disable-background-networking'],
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  const fixture = 'Pane selection fixture QA';
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<title>' + fixture + '</title><main style="padding:60px;font:22px Arial">' +
    '<p id="sample" tabindex="0">margin requirement 测试文字<br>two lines 中文</p>' +
    '<label>Protected<input id="password" type="password" value="never-read-this" /></label></main>'));
  const targets = await native('list', String(process.pid));
  const win = targets.find(target => target.title.includes(fixture));
  assert.ok(win, 'the external browser window is discoverable');
  const hotkey = mode => exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('tests/hotkey.ps1'), win.id.split(':')[0], mode], { windowsHide: true });
  async function focusContent(selector) {
    await hotkey('focus-only');
    const coordinates = await page.locator(selector).evaluate(node => {
      const r = node.getBoundingClientRect();
      const edge = Math.max(0, (outerWidth - innerWidth) / 2);
      return { x: Math.round(screenX + edge + r.left + 12),
        y: Math.round(screenY + outerHeight - innerHeight - edge + r.top + 12) };
    });
    const hit = await desktop.evaluate(({ screen }, pos) => screen.dipToScreenPoint(pos), coordinates);
    await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/selection-click.ps1'),
      win.id.split(':')[0], String(hit.x), String(hit.y)], { windowsHide: true });
  }
  await focusContent('#sample');
  await page.locator('#sample').evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  const sampleStarted = process.hrtime.bigint();
  let data;
  for (let attempt = 0; attempt < 10; attempt++) {
    data = await native('selection', String(process.pid));
    if (data.selection.status === 'ok') break;
    await sleep(180);
  }
  assert.equal(data.selection.status, 'ok', JSON.stringify(data));
  assert.match(data.selection.text, /margin requirement 测试文字/);
  assert.match(data.selection.text, /two lines 中文/);
  assert.ok(data.selection.rectangles.length);
  console.log('Native selection with mixed-language multiline selection in', win.executable,
    'in', Math.round(Number(process.hrtime.bigint() - sampleStarted) / 1e6), 'ms');
  assert.equal((await readFile(log, 'utf8').catch(() => '')).length, 0);
  await hotkey('selection-test');
  let toolbar;
  for (let attempt = 0; attempt < 45; attempt++) {
    toolbar = desktop.windows().find(item => item.url().endsWith('#selection'));
    if (toolbar) break;
    await sleep(100);
  }
  assert.ok(toolbar, 'selection hotkey opens its dedicated isolated surface');
  await toolbar.getByRole('button', { name: '问 AI' }).click();
  assert.equal(await toolbar.evaluate(() => typeof window.pane), 'undefined');
  assert.equal((await readFile(log, 'utf8').catch(() => '')).length, 0);
  assert.equal((await call('chat:list')).value.length, 0);
  await toolbar.getByRole('textbox', { name: '关于选区的问题' }).fill('解释这个概念');
  await toolbar.getByRole('button', { name: '发送' }).click();
  await toolbar.locator('[aria-label="AI 回答"]').waitFor();
  await toolbar.getByRole('button', { name: '打开完整对话' }).click();
  assert.equal((await call('chat:list')).value.length, 1);
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  await call('window:hide');
  await focusContent('#password');
  await page.locator('#password').evaluate(input => input.select());
  const protectedSelection = await native('selection', String(process.pid));
  assert.equal(protectedSelection.selection.status, 'protected');
  await desktop.evaluate(({ BrowserWindow }) => {
    const chat = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('index.html'));
    chat.show();
    chat.focus();
  });
  await app.locator('.settings-trigger').click();
  const toggle = app.getByLabel('开启自动划词');
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await app.getByLabel('主题').selectOption('dark');
  await app.waitForFunction(async () => (await window.pane.call('snapshot')).value.settings.selectionAuto);
  await app.keyboard.press('Escape');
  await call('window:hide');
  await focusContent('#sample');
  await page.locator('#sample').evaluate(node => {
    const range = document.createRange();
    range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 6);
    const current = getSelection(); current.removeAllRanges(); current.addRange(range);
  });
  for (let attempt = 0; attempt < 45; attempt++) {
    toolbar = desktop.windows().find(item => item.url().endsWith('#selection'));
    if (toolbar) break;
    await sleep(100);
  }
  assert.ok(toolbar && !toolbar.isClosed(), 'opt-in UIA selection events open the toolbar without a shortcut');
  assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
  const badge = toolbar.getByRole('button', { name: '划词操作' });
  await badge.waitFor();
  assert.equal(await toolbar.getByRole('button', { name: '问 AI' }).count(), 0);
  const visualSize = await badge.boundingBox();
  assert.ok(visualSize && visualSize.width <= 32 && visualSize.height <= 32, JSON.stringify(visualSize));
  const automatic = await native('selection', String(process.pid));
  assert.equal(automatic.selection.status, 'ok');
  const edge = automatic.selection.rectangles.at(-1);
  const { anchor, bounds } = await desktop.evaluate(({ BrowserWindow, screen }, rect) => ({
    anchor: screen.screenToDipPoint({ x: rect.x + rect.width, y: rect.y + rect.height }),
    bounds: BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('#selection')).getBounds(),
  }), edge);
  assert.ok(bounds.x > anchor.x && bounds.y > anchor.y, JSON.stringify({ anchor, bounds }));

  await badge.hover();
  const action = toolbar.getByRole('button', { name: '问 AI' });
  await action.waitFor();
  const contrast = await action.evaluate(button => {
    const toolbar = button.closest('.selection-toolbar');
    const luminance = color => {
      const values = color.match(/[0-9.]+/g).slice(0, 3).map(channel => {
        const value = Number(channel) / 255;
        return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
      });
      return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
    };
    const foreground = luminance(getComputedStyle(button).color);
    const background = luminance(getComputedStyle(toolbar).backgroundColor);
    return { theme: document.documentElement.dataset.theme, ratio: (foreground + .05) / (background + .05) };
  });
  assert.equal(contrast.theme, 'dark');
  assert.ok(contrast.ratio >= 4.5, JSON.stringify(contrast));
  await toolbar.evaluate(() => document.querySelector('.selection-toolbar')
    .dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null })));
  await toolbar.waitForEvent('close', { timeout: 3000 }).catch(error => { if (!toolbar.isClosed()) throw error; });
  await sleep(425);
  assert.equal(desktop.windows().some(item => item.url().endsWith('#selection') && !item.isClosed()), false);
  await page.locator('#sample').evaluate(node => {
    const range = document.createRange();
    range.setStart(node.firstChild, 7); range.setEnd(node.firstChild, 18);
    const current = getSelection(); current.removeAllRanges(); current.addRange(range);
  });
  toolbar = undefined;
  for (let attempt = 0; attempt < 45; attempt++) {
    toolbar = desktop.windows().find(item => item.url().endsWith('#selection') && !item.isClosed());
    if (toolbar) break;
    await sleep(100);
  }
  assert.ok(toolbar, 'a new selection shows the badge again');
  await toolbar.getByRole('button', { name: '划词操作' }).waitFor();
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('lock-screen'));
  await toolbar.waitForEvent('close', { timeout: 3000 }).catch(error => { if (!toolbar.isClosed()) throw error; });
  console.log('Protected field, explicit network submission and existing Chat persistence verified in',
    Math.round(Number(process.hrtime.bigint() - start) / 1e6), 'ms');
} finally {
  await browser?.close();
  await desktop?.close();
  const temp = resolve(tmpdir());
  if (dirname(profiles) === temp && profiles.startsWith(join(temp, 'pane-selection-'))) {
    await rm(profiles, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
