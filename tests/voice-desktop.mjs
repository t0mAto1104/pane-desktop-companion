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
      build.onResolve({ filter: /^\.\/voice-model$/ }, () => ({ path: resolve('tests/voice-model-fixture.ts') }));
      build.onResolve({ filter: /^\.\/whisper$/ }, () => ({ path: resolve('tests/whisper-fixture.ts') }));
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
  await button('试录并回放').click();
  await app.getByText('可以说话，试录约 4 秒', { exact: true }).waitFor();
  await app.getByLabel('麦克风输入音量').waitFor();
  assert.equal(await app.getByLabel('麦克风输入音量').evaluate(meter => meter.value), 0.66);
  await app.getByText('试录回放完成。', { exact: true }).waitFor();
  assert.equal((await readFile(requests, 'utf8').catch(() => '')).length, 0);
  await button('下载离线 Whisper 模型（约 190 MB）').click();
  await app.getByLabel('离线模型下载进度').waitFor();
  await app.getByText('本地 Whisper 模型已就绪', { exact: true }).waitFor();
  await app.keyboard.press('Escape');

  const composer = app.locator('.composer');
  await composer.getByRole('button', { name: '语音提问' }).click();
  await button('结束录音').waitFor();
  await composer.getByText('可以说话 · 正在录音', { exact: true }).waitFor();
  assert.equal(desktop.windows().filter(win => win.url().endsWith('#voice')).length, 0);
  await button('结束录音').click();
  await app.waitForFunction(() => document.querySelector('.composer textarea').value === '这是语音转写测试');
  assert.equal((await readFile(requests, 'utf8').catch(() => '')).length, 0);
  await draft.fill('语音稿已人工确认');
  await button('发送').click();
  await app.getByText('上轮实际来源 · 仅文字').waitFor();
  for (let i = 0; i < 60 && !(await readFile(logs, 'utf8')).includes('speak:speaker-2'); i++) await sleep(60);
  assert.deepEqual((await readFile(logs, 'utf8')).trim().split('\n'),
    ['record:mic-2', 'preview:speaker-2', 'record:mic-2', 'transcribe:en', 'speak:speaker-2']);
  assert.equal((await readFile(requests, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await app.evaluate(() => window.pane.call('chat:list'))).value.length, 1);

  await button('语音提问').click();
  await button('结束录音').waitFor();
  await desktop.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await button('语音提问').waitFor();
  assert.equal(await draft.inputValue(), '');
  assert.match(await readFile(logs, 'utf8'), /record:mic-2\ncancel\n$/);
  assert.equal((await readFile(requests, 'utf8')).trim().split('\n').length, 1);
  console.log('Input meter, microphone preview, model setup, inline Whisper draft, explicit send and suspend cancellation passed (mock audio).');
} finally {
  await desktop?.close();
  if (dirname(profile) === temp && profile.startsWith(join(temp, 'pane-voice-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
