import assert from 'node:assert/strict';
import test from 'node:test';
import { apiError } from '../vendor/siwc/src/errors';
import { listModels } from '../vendor/siwc/src/models';
import { RateLimitGate, requestLimit } from '../src/main/rate-limit';
import { openaiClient } from '../src/main/inference';

test('429 cooldown honors the service delay and never calls the network early', async () => {
  let now = 10_000;
  let calls = 0;
  const gate = new RateLimitGate(() => now);
  const request = () => {
    calls++;
    return Promise.reject(apiError({ error: { code: 'rate_limit_exceeded' } }, 429, undefined, '46'));
  };
  await assert.rejects(gate.run('chatgpt:response', request), /46 秒/);
  now += 45_000;
  await assert.rejects(gate.run('chatgpt:response', request), /1 秒/);
  assert.equal(calls, 1);
  assert.equal(await gate.run('api-key:response', async () => 'other provider'), 'other provider');
  now += 1_000;
  assert.equal(await gate.run('chatgpt:response', async () => 'ready'), 'ready');
});

test('both model endpoints pass retry hints and quota errors remain distinct', async context => {
  const cases = [
    { code: 'rate_limit_exceeded', kind: 'temporary' },
    { code: 'insufficient_quota', kind: 'quota' },
    { code: 'subscription_sharing_usage_limit_exceeded', kind: 'subscription' },
  ] as const;
  for (const row of cases) {
    context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: row.code } }), {
      status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' },
    }));
    const signal = new AbortController().signal;
    for (const request of [
      () => listModels('fixture-oauth', signal),
      () => openaiClient('fixture-api-key').models.list({ signal }),
    ]) {
      const gate = new RateLimitGate();
      await assert.rejects(gate.run('models', async () => request()), error =>
        row.kind === 'temporary' ? /60 秒/.test(String(error)) : requestLimit(error) === row.kind);
      if (row.kind === 'temporary') assert.throws(() => gate.check('models'), /60 秒/);
      else assert.doesNotThrow(() => gate.check('models'));
    }
    context.mock.restoreAll();
  }
});
