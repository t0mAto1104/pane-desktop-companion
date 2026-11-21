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
  const button = name => app.getByRole('button', { name, exact: true });
  const draft = app.getByRole('textbox', { name: '输入你的问题' });
  await app.locator('.settings-trigger').click();
  await app.getByLabel('麦克风（输入）').selectOption('mic-2');
  await app.getByLabel('朗读设备（输出）').selectOption('speaker-2');
  await app.getByLabel('听写语言').selectOption('en');
  const state = await app.evaluate(() => window.pane.call('snapshot'));
  assert.equal(state.value.settings.voiceInputId, 'mic-2');
  assert.equal(state.value.settings.voiceOutputId, 'speaker-2');
  await app.keyboard.press('Escape');

  const composer = app.locator('.composer');
  await composer.getByRole('button', { name: '语音提问' }).click();
  await button('结束录音').waitFor();
  assert.equal(desktop.windows().filter(win => win.url().endsWith('#voice')).length, 0);
  await button('结束录音').click();
  await app.waitForFunction(() => document.querySelector('.composer textarea').value === '这是语音转写测试');
  assert.equal((await readFile(requests, 'utf8').catch(() => '')).length, 0);
  await draft.fill('语音稿已人工确认');
  await button('发送').click();
  await app.getByText('上轮实际来源 · 仅文字').waitFor();
  for (let i = 0; i < 60 && !(await readFile(logs, 'utf8')).includes('speak:speaker-2'); i++) await sleep(60);
  assert.deepEqual((await readFile(logs, 'utf8')).trim().split('\n'),
    ['record:mic-2', 'transcribe:en', 'speak:speaker-2']);
  assert.equal((await readFile(requests, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await app.evaluate(() => window.pane.call('chat:list'))).value.length, 1);

  await button('语音提问').click();
  await button('结束录音').waitFor();
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await button('语音提问').waitFor();
  assert.equal(await draft.inputValue(), '');
  assert.match(await readFile(logs, 'utf8'), /record:mic-2\ncancel\n$/);
  assert.equal((await readFile(requests, 'utf8')).trim().split('\n').length, 1);
  console.log('Inline voice, independent device routing, draft review and suspend cancellation passed (mock audio).');
} finally {
  await desktop?.close();
  if (dirname(profile) === temp && profile.startsWith(join(temp, 'pane-voice-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
