import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiClient, streamPlatform } from '../src/main/inference';
import { streamResponse } from '../vendor/siwc/src/responses';
import type { ResponseInputMessage } from '../vendor/siwc/src/types';

const input: ResponseInputMessage[] = [
  { role: 'user', content: 'Earlier question' },
  { role: 'assistant', content: 'Earlier answer' },
  { role: 'user', content: [{ type: 'input_text', text: 'Latest question' }, { type:'input_image', detail:'auto', image_url: 'data:image/jpeg;base64,/9j/' }] },
];

test('both providers use the public streaming API, local history, images and no storage', async context => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.ok(new Headers(options.headers).get('authorization')?.startsWith('Bearer fixture-'));
    assert.equal(options.redirect, 'error');
    const request = JSON.parse(String(options.body));
    assert.deepEqual(request.input, input);
    assert.equal(request.store, false);
    assert.equal(request.stream, true);
    requests++;
    return sse(['response.output_text.delta', 'response.refusal.delta', 'response.completed']);
  });
  for (const source of ['oauth', 'api-key']) {
    const received: string[] = [];
    const signal = new AbortController().signal;
    const onDelta = (chunk: string) => received.push(chunk);
    const result = source === 'oauth'
      ? (await streamResponse('fixture-oauth', { model:'fixture-model', input, onDelta }, signal)).text
      : await streamPlatform(openaiClient('fixture-key'), 'fixture-model', input, signal, onDelta);
    assert.equal(result, 'fixturefixture');
    assert.deepEqual(received, ['fixture', 'fixture']);
  }
  assert.equal(requests, 2);
});

test('truncated streams are rejected by both providers', async context => {
  context.mock.method(globalThis, 'fetch', async () => sse(['response.output_text.delta']));
  const signal = new AbortController().signal;
  await assert.rejects(streamPlatform(openaiClient('fixture-key'), 'fixture-model', input, signal, () => {}));
  await assert.rejects(streamResponse('fixture-oauth', { model:'fixture-model', input }, signal), { code: 'stream_interrupted' });
});

function sse(types: string[]) {
  const body = types.map(type => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, delta: 'fixture', response: {} }) + '\n\n').join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}
