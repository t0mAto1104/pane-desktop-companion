import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { ResponseInputMessage } from '../vendor/siwc/src/types';

export function diagnostic(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class AI {
  async account() { return { status: 'connected', sharing: true, label: '本地验收', apiKey: false }; }
  signIn() { return this.account(); }
  cancelSignIn() {}
  disconnect() { return this.account(); }
  async usage() {}
  addKey() { return this.account(); }
  removeKey() { return this.account(); }
  async models() { return [{ id: 'fixture-vision', name: '本地视觉验收模型' }]; }

  async stream(_provider: string, model: string, input: ResponseInputMessage[], signal: AbortSignal, onDelta: (delta: string) => void) {
    assert.equal(model, 'fixture-vision');
    const file = process.env.PANE_TEST_REQUEST_LOG;
    if (file) appendFileSync(file, 'stream\n');
    const current = input.at(-1)?.content;
    const question = Array.isArray(current) ? current.find(part => part.type === 'input_text')?.text : current;
    if (question?.startsWith('观察验收：')) {
      const images = input.flatMap(item => Array.isArray(item.content)
        ? item.content.flatMap(part => part.type === 'input_image' ? [part.image_url] : []) : []);
      assert.ok(images.length <= 1, 'awareness suppresses the older image history');
      const fingerprint = images[0] ? createHash('sha256').update(images[0]).digest('hex').slice(0, 12) : '';
      const answer = '当前请求：' + images.length + ' 张' + (fingerprint ? ' · ' + fingerprint : '');
      onDelta(answer);
      return answer;
    }
    assert.ok(input.some(item => Array.isArray(item.content) &&
      item.content.some(part => part.type === 'input_image' && part.image_url.startsWith('data:image/jpeg;base64,/9j/'))));
    const followup = input.at(-1)?.content === '这是多少手？';
    if (followup) {
      assert.ok(input.some(item => item.role === 'assistant' && String(item.content).includes('SIM-101')));
      assert.ok(input.some(item => Array.isArray(item.content) &&
        item.content.some(part => part.type === 'input_text' && part.text === '这个模拟交易窗口显示了什么？')));
    }
    if (input.at(-1)?.content === '现在停止') {
      onDelta('可保留的部分回答');
      await setTimeout(30_000, undefined, { signal });
    }
    const chunks = followup ? ['模拟持仓是 ', '**10 手**。'] : ['标的为 **SIM-101**。\n\n', '```text\n125.40\n```'];
    for (const chunk of chunks) {
      await setTimeout(180, undefined, { signal });
      onDelta(chunk);
    }
    return chunks.join('');
  }
}
