import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const requestLog = join(profile, 'inference.log');
const packaged = process.argv.includes('--packaged');
const production = packaged || process.argv.includes('--production');
let fixture;
let desktop;

async function openApp() {
  const executablePath = packaged ? resolve('release/win-unpacked/Pane.exe') : electron;
  const entry = production ? '.' : resolve('dist/test/main.cjs');
  return driver.launch({ executablePath, args: [...(packaged ? [] : [entry]), '--user-data-dir=' + launcher],
    env: { ...process.env, PANE_TEST_REQUEST_LOG: requestLog }, timeout: 25_000 });
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
  async function waitSnapshot(check, expectation) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const state = await snapshot();
      if (check(state)) return state;
      await new Promise(done => setTimeout(done, 60));
    }
    const state = await snapshot();
    throw new Error('Expected ' + expectation + '. Capture: ' + state.capture.error +
      '. Observation: ' + state.observation.phase + ' ' + (state.observation.reason ?? ''));
  }
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
    await waitSnapshot(({ capture }) => capture.shot && capture.shot.id !== previousShot, 'refreshed manual screenshot');
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
    page.setDefaultTimeout(10000);
    await page.getByText('10 手', { exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('button', { name: /^删除对话/ }).focus();
    await page.getByRole('button', { name: /^删除对话/ }).click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('还没有对话', { exact: true }).waitFor();
    console.log('Denylist, theme persistence, SQLite restart, deletion and screenshot ephemerality passed.');
    async function desktopAction(action, ...args) {
      const result = await page.evaluate(([name, params]) => window.pane.call(name, ...params), [action, args]);
      assert.ok(result.ok, result.error);
      return result.value;
    }
    async function openFixture() {
      fixture = await driver.launch({ executablePath: electron,
        args: [resolve('tests/fixture.cjs'), '--user-data-dir=' + join(profile, 'awareness-fixture')], timeout: 25_000 });
      await (await fixture.firstWindow()).getByText('纸上交易 · DEMO').waitFor();
    }
    async function chooseFixture() {
      await page.getByTitle('选择目标窗口').click();
      await page.getByRole('dialog').getByRole('button', { name: /Pane 纸上交易验收/ }).click();
      const state = await waitSnapshot(({ capture }) =>
        capture.bound && capture.target?.title === 'Pane 纸上交易验收', 'fixture window binding');
      return state.capture.target.id;
    }
    async function waitPhase(phase) {
      await waitSnapshot(({ observation }) => observation.phase === phase, 'observation phase ' + phase);
    }
    async function waitObservation(id, previous) {
      const state = await waitSnapshot(({ observation }) => observation.phase === 'watching' &&
        observation.latest?.targetId === id && observation.latest.observationId !== previous, 'latest observation for ' + id);
      return state.observation.latest;
    }
    async function requests() { return (await readFile(requestLog, 'utf8')).trim().split('\n').length; }
    async function ask(text, evidence) {
      const questions = page.getByRole('textbox', { name: '输入你的问题' });
      await questions.fill(text);
      await questions.press('Enter');
      const answer = page.locator('.assistant-message').last();
      await answer.getByText(new RegExp(evidence)).waitFor();
      await answer.getByRole('button', { name: '重发上一条' }).waitFor();
    }

    const oldDeny = initial.settings.denied;
    await desktopAction('settings:update', { denied: oldDeny, monitoringIntervalMs: 350, maxObservations: 2 });
    await page.getByRole('switch', { name: '屏幕感知' }).click();
    await waitPhase('unbound');
    await openFixture();
    const fixtureId = await chooseFixture();
    const firstObservation = await waitObservation(fixtureId);
    await page.getByText('正在观察', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '预览截图', exact: true }).count(), 0,
      'sampling never pushes screenshot pixels through IPC');
    assert.ok(!JSON.stringify((await snapshot()).observation).includes('base64'));
    const before = await requests();
    await new Promise(done => setTimeout(done, 1250));
    assert.equal((await snapshot()).observation.latest.observationId, firstObservation.observationId);
    assert.equal(await requests(), before, 'observation must never trigger inference');

    await page.getByRole('button', { name: '预览最近观察' }).click();
    await page.getByRole('dialog').getByRole('img', { name: 'Pane 纸上交易验收' }).waitFor();
    await page.getByRole('button', { name: '关闭弹窗' }).click();

    await page.getByRole('button', { name: '刷新截图' }).click();
    await shot(page);
    const stale = (await snapshot()).capture.shot;
    await fixture.firstWindow().then(fixturePage => fixturePage.evaluate(() => { document.body.style.backgroundColor = '#854fbc'; }));
    const updated = await waitObservation(fixtureId, firstObservation.observationId);
    assert.ok(updated.changeScore > 0.6);
    const currentShot = await desktopAction('observation:preview', updated.observationId);
    const fingerprint = image => createHash('sha256').update(image).digest('hex').slice(0, 12);
    assert.notEqual(fingerprint(stale.image), fingerprint(currentShot.image));

    await ask('观察验收：使用最新截图', fingerprint(currentShot.image));
    const active = (await snapshot()).conversationId;
    const turns = await desktopAction('chat:open', active);
    assert.equal(turns.find(item => item.role === 'user').imageLabel, '屏幕观察');
    await ask('观察验收：重复观察', '0 张');
    await page.getByRole('button', { name: '预览最近观察' }).click();
    await page.getByRole('button', { name: '本条附上观察截图' }).click();
    await ask('观察验收：明确重附', fingerprint(currentShot.image));
    await page.getByRole('checkbox', { name: '发送时使用最新屏幕观察' }).uncheck();
    await ask('观察验收：仅文字', '0 张');
    assert.equal(await requests(), before + 4);
    console.log('Local observation, deduplicated/forced AI context, manual-shot ordering and explicit send passed.');

    await page.getByRole('button', { name: '暂停监控' }).click();
    await waitPhase('paused');
    assert.equal(await desktopAction('observation:preview', updated.observationId), null);
    await page.getByRole('button', { name: '恢复监控' }).click();
    const resumed = await waitObservation(fixtureId, updated.observationId);

    const resize = await fixture.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const displays = screen.getAllDisplays();
      const from = win.getBounds();
      const other = displays.find(display => display.id !== screen.getDisplayMatching(from).id);
      const here = other?.workArea ?? screen.getDisplayMatching(from).workArea;
      win.setBounds({ x: here.x + 45, y: here.y + 45, width: from.width + 70, height: from.height + 40 });
      return { movedToAnotherDisplay: !!other, scales: displays.map(display => display.scaleFactor) };
    });
    const resized = await waitObservation(fixtureId, resumed.observationId);
    assert.equal(resized.changeScore, 1);
    console.log('WGC resize/recreation passed. Display scale factors:', resize.scales, 'Cross-display move:', resize.movedToAnotherDisplay);

    await page.getByRole('button', { name: '隐藏到托盘' }).click();
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
    await fixture.firstWindow().then(fixturePage => fixturePage.evaluate(() => { document.body.style.backgroundColor = '#ba752c'; }));
    await waitObservation(fixtureId, resized.observationId);
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve('tests/hotkey.ps1'), fixtureId.split(':')[0]], { windowsHide: true });
    await page.waitForFunction(() => document.hasFocus(), undefined, { polling: 80 });
    console.log('Bound-window observation continues while Pane is hidden in the tray.');

    await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await waitPhase('stopped');
    assert.equal((await snapshot()).observation.latest, null);
    await ask('观察验收：捕获停止后仅文字', '0 张');
    await fixture.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await page.getByRole('button', { name: '刷新截图' }).click();
    await shot(page);
    await page.getByRole('button', { name: '移除截图' }).click();
    await page.getByRole('button', { name: '恢复监控' }).click();
    await waitObservation(fixtureId);

    await fixture.close();
    fixture = undefined;
    await waitPhase('stopped');
    assert.equal((await snapshot()).observation.latest, null);
    await openFixture();
    await page.getByRole('button', { name: '恢复监控' }).click();
    await waitPhase('stopped');
    assert.equal((await snapshot()).observation.latest, null, 'a reopened window must be explicitly bound');
    const reopened = await chooseFixture();
    assert.notEqual(reopened, fixtureId);
    const fresh = await waitObservation(reopened);

    const nativeWindow = JSON.parse((await run(helper, ['list', '0'], { windowsHide: true })).stdout).find(item => item.id === reopened);
    assert.ok(nativeWindow);
    await assert.rejects(run(helper, ['observe', '0', reopened, 'ELECTRON.EXE'], { windowsHide: true }), { stderr: 'blocked' });
    const parts = reopened.split(':');
    await assert.rejects(run(helper, ['observe', '0', [parts[0], parts[1], '1'].join(':')], { windowsHide: true }), { stderr: 'target_gone' });

    await desktopAction('settings:update', { denied: ['ELECTRON.EXE'] });
    await waitPhase('stopped');
    assert.match((await snapshot()).observation.reason, /禁止捕获/);
    assert.equal(await desktopAction('observation:preview', fresh.observationId), null);
    assert.ok(!(await desktopAction('window:list')).some(target => target.id === reopened));
    await page.getByRole('switch', { name: '屏幕感知' }).click();
    await waitPhase('off');
    assert.equal(await requests(), before + 5);
    console.log('Pause/resume, failed-capture fallback, window identity and reopen, denylist and disable passed.');


  }
} finally {
  await fixture?.close();
  await desktop?.close();
  if (dirname(profile) === temporary && profile.startsWith(join(temporary, 'pane-qa-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
