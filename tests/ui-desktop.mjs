import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron as driver } from 'playwright-core';

const temporary = resolve(tmpdir());
const profile = await mkdtemp(join(temporary, 'pane-guide-test-'));
const packaged = process.argv.includes('--packaged');
const requestLog = join(profile, 'requests.log');
let desktop, fixture;
if (!packaged) await build({
  entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', outdir: 'dist/ui-test',
  outExtension: { '.js': '.cjs' }, external: ['electron'],
  plugins: [{ name: 'guide-fixture-ai', setup(build) {
    build.onResolve({ filter: /^\.\/ai$/ }, () => ({ path: resolve('tests/ai-fixture.ts') }));
  } }],
});
try {
  desktop = await driver.launch({
    executablePath: packaged ? resolve('release/win-unpacked/Pane.exe') : electron,
    args: [...(packaged ? [] : [resolve('dist/ui-test/main.cjs')]), '--show-main', '--user-data-dir=' + join(profile, 'pane')],
    env: { ...process.env, PANE_TEST_REQUEST_LOG: requestLog },
  });
  const app = await desktop.firstWindow();
  await app.getByRole('button', { name: '隐藏到托盘' }).click();
  fixture = await driver.launch({ executablePath: electron, args: [resolve('tests/fixture.cjs'), '--user-data-dir=' + join(profile, 'fixture')] });
  const terminal = await fixture.firstWindow();
  await terminal.getByRole('button', { name: '买入开仓' }).waitFor();
  const handle = await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString());
  async function focusFixture() {
    await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      resolve('tests/hotkey.ps1'), handle, 'focus-only'], { windowsHide: true });
  }
  const ipc = (action, ...args) => app.evaluate(([key, values]) => window.pane.call(key, ...values), [action, args]);
  async function call(action, ...args) {
    const result = await ipc(action, ...args);
    assert.equal(result.ok, true, result.error);
    return result.value;
  }
  assert.equal((await ipc('ui:inspect')).ok, false);
  const target = (await call('window:list')).find(window => window.id.split(':')[0] === handle);
  assert.ok(target, 'the fixture is the only window queried');
  await call('capture:bind', target.id);
  const uiaStarted = performance.now();
  let scanned;
  for (let attempt = 0; attempt < 4; attempt++) {
    scanned = await call('ui:inspect');
    if (scanned.elements.some(element => element.name === '买入开仓')) break;
    await sleep(200);
  }
  const uiaMs = Math.round(performance.now() - uiaStarted);
  const element = scanned.elements.find(item => item.name === '买入开仓');
  assert.ok(element?.role === 'button' && element.boundingRectangle.width > 0, JSON.stringify(scanned.elements.map(item => [item.name, item.role])));
  assert.ok(!JSON.stringify(scanned.elements).includes('PRIVATE_FIXTURE_VALUE'));
  const match = await call('ui:findElement', { name: '买入开仓', role: 'button' });
  assert.equal(match.status, 'matched');
  assert.equal((await call('ui:getElement', element.elementId)).element.name, '买入开仓');
  assert.equal((await call('ui:findElement', { name: '查看详情' })).status, 'candidates');
  console.log('Real Windows UIA button positions, duplicate names, no-password scan and bound-window IPC passed.');
  const located = await call('ui:locate', { name: '买入开仓' }, false);
  assert.equal(located.status, 'verified');
  assert.equal(located.candidates[0].elementId, element.elementId);
  const full = await call('ui:roi', { x: 0, y: 0, width: 1, height: 1 });
  const roiStarted = performance.now();
  const crop = await call('ui:roi', { x: .1, y: .2, width: .35, height: .4 });
  const roiMs = Math.round(performance.now() - roiStarted);
  const dimensions = await app.evaluate(async data => {
    const image = new Image();
    image.src = data;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, crop.image);
  assert.deepEqual(dimensions, [crop.pixels.width, crop.pixels.height]);
  assert.ok(crop.pixels.width < full.pixels.width && crop.pixels.height < full.pixels.height);
  assert.equal((await ipc('ui:roi', { x: .8, y: .1, width: .3, height: .2 })).ok, false);
  console.log('Real WGC window ROI retained source pixel resolution and rejected invalid bounds.', { uiaMs, roiMs });
  const readOverlay = () => desktop.evaluate(({ BrowserWindow, screen }) => {
    const marker = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Pane Overlay');
    if (!marker?.isVisible()) return null;
    const bounds = marker.getBounds();
    return { bounds, focused: marker.isFocused(), point: screen.dipToScreenPoint({
      x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2),
    }) };
  });
  async function waitOverlay(check) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const state = await readOverlay();
      if (check(state)) return state;
      await sleep(125);
    }
    const snapshot = await ipc('ui:inspect');
    throw new Error('No verified overlay at the expected location. ' + JSON.stringify({
      marker: await readOverlay(), geometry: snapshot.value?.geometry, status: snapshot.value?.status, error: snapshot.error,
    }));
  }
  await focusFixture();
  const button = element.boundingRectangle;
  const windowBounds = scanned.geometry.bounds;
  const buttonRegion = { x: (button.x - windowBounds.x) / windowBounds.width,
    y: (button.y - windowBounds.y) / windowBounds.height,
    width: button.width / windowBounds.width, height: button.height / windowBounds.height };
  const unobstructed = await call('ui:roi', buttonRegion);
  await call('ui:highlight', [located.candidates[0].id], 'number');
  const marker = await waitOverlay(state => !!state);
  assert.equal(marker.focused, false);
  const observed = (await call('ui:getElement', element.elementId)).element.boundingRectangle;
  assert.ok(marker.point.x >= observed.x && marker.point.x < observed.x + observed.width &&
    marker.point.y >= observed.y && marker.point.y < observed.y + observed.height);
  const hit = await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    resolve('tests/overlay-hit.ps1'), String(marker.point.x), String(marker.point.y)], { windowsHide: true });
  assert.equal(hit.stdout.trim(), handle, 'actual Win32 hit-testing passes through the overlay without clicking');
  assert.equal((await call('ui:roi', buttonRegion)).image, unobstructed.image,
    'the visible overlay is absent from genuine WGC pixels');
  await fixture.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const bounds = win.getBounds();
    const displays = screen.getAllDisplays();
    const there = displays.find(display => display.id !== screen.getDisplayMatching(bounds).id)?.workArea;
    win.setBounds({ ...bounds, x: there ? there.x + 30 : bounds.x + 110,
      y: there ? there.y + 35 : bounds.y + 35, width: bounds.width + 25 });
  });
  await waitOverlay(state => !!state && state.bounds.x !== marker.bounds.x);
  await terminal.evaluate(() => { document.getElementById('open-long').style.display = 'none'; });
  await waitOverlay(state => state === null);
  console.log('Verified transparent overlay, overlay-free WGC, Win32 hit testing, move/resize and stale element cleanup.');
  if (!packaged) {
    await terminal.evaluate(() => {
      document.getElementById('open-long').style.display = 'inline-block';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, { position: 'fixed', left: '55%', top: '48%', width: '25%', height: '18%', pointerEvents: 'none' });
      canvas.getContext('2d').fillRect(0, 0, 300, 150);
      document.body.append(canvas);
    });
    const remoteCalls = async () => (await readFile(requestLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
    assert.equal((await call('ui:locate', { name: '仅在画布上绘制的控件' }, false)).status, 'unavailable');
    assert.equal(await remoteCalls(), 0);
    const visual = await call('ui:locate', { name: '仅在画布上绘制的控件' }, true);
    assert.equal(visual.status, 'visual');
    assert.ok(visual.image.image.startsWith('data:image/jpeg;base64,/9j/'));
    assert.equal(visual.candidates[0].source, 'vision');
    assert.equal(visual.candidates[0].canHighlight, false, 'without a bound observation the visual evidence is preview-only');
    assert.equal(await remoteCalls(), 1);
    await call('ui:clear');

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/index.html')).show());
    await app.getByRole('button', { name: '桌面指导' }).click();
    const panel = app.getByRole('dialog', { name: '桌面指导' });
    await panel.getByRole('button', { name: '打开窗口预览' }).click();
    const image = panel.getByRole('img', { name: '拖动框选目标窗口截图' });
    await image.evaluate(node => node.decode());
    await image.scrollIntoViewIfNeeded();
    const box = await image.boundingBox();
    assert.ok(box);
    await app.mouse.move(box.x + box.width * .18, box.y + box.height * .18);
    await app.mouse.down();
    await app.mouse.move(box.x + box.width * .55, box.y + box.height * .48, { steps: 5 });
    await app.mouse.up();
    await panel.getByRole('img', { name: '原始像素局部截图' }).waitFor();

    await panel.getByRole('textbox', { name: '教学任务' }).fill('如何完成一笔模拟交易？');
    await panel.getByRole('button', { name: '生成步骤' }).click();
    await panel.getByRole('button', { name: '检查结果' }).waitFor();
    assert.equal(await remoteCalls(), 2);
    await panel.getByRole('button', { name: '重新定位' }).click();
    await panel.getByRole('button', { name: '在窗口中高亮' }).waitFor();
    await panel.getByRole('button', { name: '检查结果' }).click();
    await panel.getByText(/界面证据不足/).waitFor();
    assert.equal(await panel.getByRole('button', { name: '下一步' }).isEnabled(), false);

    // Represent the human moving the dedicated fixture to a different interface state.
    await terminal.evaluate(() => {
      const result = document.createElement('button');
      result.textContent = '模拟确认页';
      document.body.append(result);
    });
    await panel.getByRole('button', { name: '检查结果' }).click();
    await panel.getByText('UI Automation 已验证', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '下一步' }).click();
    await panel.getByRole('heading', { name: '核对模拟状态' }).waitFor();
    await panel.getByRole('button', { name: '暂停教学' }).click();
    await panel.getByRole('button', { name: '继续教学' }).click();
    await panel.getByRole('button', { name: '手动确认完成' }).click();
    await panel.getByRole('button', { name: '下一步' }).click();
    await panel.getByText('教学已结束。', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '退出教学' }).click();
    await panel.getByRole('button', { name: '生成步骤' }).waitFor();
    assert.equal(await call('guidance:state'), null);
    assert.equal(await terminal.evaluate(() => window.paneFixtureOrderClicks), 0);
    assert.equal(await remoteCalls(), 2, 'changes and verification never call the model');
    await panel.getByRole('button', { name: '关闭弹窗' }).click();
    await app.getByRole('button', { name: '隐藏到托盘' }).click();
    console.log('Explicit visual fallback, guide UI ROI drag, simulated teaching, observed state transitions and zero order clicks passed.');
  }


  await call('settings:update', { denied: ['ELECTRON.EXE'] });
  assert.equal((await ipc('ui:inspect')).ok, false);
  await call('settings:update', { denied: [] });
  await call('capture:bind', target.id);
  const final = await call('ui:locate', { name: '平仓' }, false);
  await focusFixture();
  await call('ui:highlight', [final.candidates[0].id], 'arrow');
  await waitOverlay(state => !!state);
  await fixture.close();
  fixture = undefined;
  await waitOverlay(state => !state);
  assert.equal((await ipc('ui:inspect')).ok, false);
  console.log('Denylist gate and overlay cleanup after the actual target closed passed.');
} finally {
  await fixture?.close();
  await desktop?.close();
  if (dirname(profile) === temporary && profile.startsWith(join(temporary, 'pane-guide-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
