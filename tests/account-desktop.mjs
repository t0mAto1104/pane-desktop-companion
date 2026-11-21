import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import electron from 'electron';
import { _electron as driver } from 'playwright-core';

const temporary = resolve(tmpdir());
const profile = await mkdtemp(join(temporary, 'pane-rate-test-'));
const requestLog = join(profile, 'requests.log');
let desktop;
try {
  await build({
    entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', outdir: 'dist/account-test',
    outExtension: { '.js': '.cjs' }, external: ['electron'],
    plugins: [{ name: 'session-notification-fixture', setup(build) {
      build.onResolve({ filter: /vendor\/siwc\/src\/index$/ }, () => ({ path: resolve('tests/siwc-notifications-fixture.ts') }));
    } }],
  });
  desktop = await driver.launch({
    executablePath: electron,
    args: [resolve('dist/account-test/main.cjs'), '--show-main', '--user-data-dir=' + join(profile, 'pane')],
    env: { ...process.env, PANE_TEST_REQUEST_LOG: requestLog },
  });
  const page = await desktop.firstWindow();
  page.setDefaultTimeout(8000);
  const log = () => readFile(requestLog, 'utf8').then(text => text.trim().split('\n'));
  const call = (name, ...args) => page.evaluate(([key, values]) => window.pane.call(key, ...values), [name, args]);
  await page.getByRole('alert').filter({ hasText: /等待约 45 秒/ }).waitFor();
  await page.evaluate(() => {
    window.accountEvents = 0;
    window.layoutChanges = 0;
    window.pane.subscribe('account', () => { window.accountEvents++; });
    const observer = new MutationObserver(records => { window.layoutChanges += records.length; });
    observer.observe(document.getElementById('root'), { childList: true, attributes: true, subtree: true, characterData: true });
  });
  await sleep(700);
  assert.deepEqual(await log(), ['read', 'models'], 'session notifications caused no repeated account or catalog reads');
  assert.deepEqual(await page.evaluate(() => [window.accountEvents, window.layoutChanges]), [0, 0]);
  await Promise.all([call('account:state'), call('account:state')]);
  await sleep(150);
  assert.deepEqual(await log(), ['read', 'models', 'read', 'read'], 'explicit reads do not start a feedback loop');
  assert.equal(await page.evaluate(() => window.accountEvents), 0);

  const blocked = await Promise.all([call('account:models', true), call('account:models', true)]);
  for (const result of blocked) { assert.equal(result.ok, false); assert.match(result.error, /秒后再重试/); }
  assert.equal((await log()).filter(item => item === 'models').length, 1);

  await desktop.evaluate(() => {
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
  });
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => call('account:models', true)));
  assert.ok(concurrent.every(result => result.ok && result.value[0].id === 'fixture-model'), JSON.stringify(concurrent));
  assert.ok((await call('account:models')).ok);
  assert.equal((await log()).filter(item => item === 'models').length, 2, 'one refresh serviced all callers, then the cache was reused');
  console.log('429 model list recovery, cached single-flight reads and unchanged renderer layout passed.');

  const created = await call('chat:new');
  assert.equal(created.ok, true);
  const id = created.value.id;
  assert.equal((await call('chat:send', id, '测速', null, 'omit')).ok, true);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await call('snapshot')).value.run) break;
    await sleep(50);
  }
  const messages = await call('chat:open', id);
  assert.equal(messages.value.length, 2);
  assert.match(messages.value[1].error, /45 秒/);
  const rejected = await call('chat:send', id, '保留草稿', null, 'omit');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /秒后再重试/);
  assert.equal((await call('chat:open', id)).value.length, 2, 'cooldown did not create an extra turn');
  assert.equal((await log()).filter(item => item === 'response').length, 1);
  console.log('A Responses 429 is displayed once and an immediate resend is blocked locally without creating another turn.');
} finally {
  await desktop?.close();
  if (dirname(profile) === temporary && profile.startsWith(join(temporary, 'pane-rate-test-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
