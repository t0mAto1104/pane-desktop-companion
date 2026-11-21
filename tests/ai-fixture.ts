import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { ResponseInputMessage } from '../vendor/siwc/src/types';

export function diagnostic(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class AI {
  private pausedOnce = false;
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
    const directive = input[0]?.content;
    if (typeof directive === 'string' && directive.includes('requestedControl')) assert.fail('User data must not be placed in a developer directive');
    if (typeof directive === 'string' && directive.includes('Coordinates are normalized')) {
      const current = input.at(-1)?.content;
      assert.ok(Array.isArray(current) && current.some(item => item.type === 'input_image' &&
        item.image_url.startsWith('data:image/jpeg;base64,/9j/')));
      return JSON.stringify({ answer: '这是模拟界面中画布绘制的候选位置。',
        candidates: [{ label: '画布候选控件', region: { x: .55, y: .48, width: .25, height: .18 } }] });
    }
    if (typeof directive === 'string' && directive.includes('Generate read-only user-operated teaching steps')) {
      const current = input.at(-1)?.content;
      assert.equal(typeof current, 'string', 'image permission is off in the guided scenario');
      assert.match(String(current), /买入开仓/);
      assert.ok(!String(current).includes('PRIVATE_FIXTURE_VALUE'));
      return JSON.stringify({ title: '模拟交易教学', steps: [
        { title: '识别模拟开仓入口', explanation: '先核对模拟账户。你可以亲自打开模拟确认页。',
          targetElement: { name: '买入开仓' }, expectedState: '出现模拟确认页',
          verificationMethod: 'uia-visible', verifyElement: { name: '模拟确认页' } },
        { title: '核对模拟状态', explanation: '查看模拟确认页和当前仓位提示。', expectedState: '用户核对模拟结果',
          verificationMethod: 'manual' },
      ] });
    }
    const current = input.at(-1)?.content;
    const question = Array.isArray(current) ? current.find(part => part.type === 'input_text')?.text : current;
    if (question?.startsWith('观察验收：')) {
      const images = input.flatMap(item => Array.isArray(item.content)
        ? item.content.flatMap(part => part.type === 'input_image' ? [part.image_url] : []) : []);
      assert.ok(images.length <= 1, 'only the current turn may provide pixels');
      const note = input.at(-2);
      assert.equal(note?.role, 'developer');
      assert.match(String(note?.content), images.length ? /visual evidence/ : /Do not claim to see the current screen/);
      if (question === '观察验收：中断后重试' && !this.pausedOnce) {
        this.pausedOnce = true;
        onDelta('已发送测试图片，等待停止');
        await setTimeout(30_000, undefined, { signal });
      }
      const fingerprint = images[0] ? createHash('sha256').update(images[0]).digest('hex').slice(0, 12) : '';
      const answer = '当前请求：' + images.length + ' 张' + (fingerprint ? ' · ' + fingerprint : '');
      onDelta(answer);
      return answer;
    }
    if (question === '这个模拟交易窗口显示了什么？') {
      assert.ok(Array.isArray(current) && current.some(part =>
        part.type === 'input_image' && part.image_url.startsWith('data:image/jpeg;base64,/9j/')));
    } else {
      assert.ok(!input.some(item => Array.isArray(item.content)), 'a text-only turn does not attach history images');
      assert.match(String(input.at(-2)?.content), /Do not claim to see the current screen/);
    }
    const followup = question === '这是多少手？';
    if (followup) {
      assert.ok(input.some(item => item.role === 'assistant' && String(item.content).includes('SIM-101')));
      assert.ok(input.some(item => item.role === 'user' && item.content === '这个模拟交易窗口显示了什么？'));
    }
    if (input.at(-1)?.content === '现在停止') {
      onDelta('可保留的部分回答');
      await setTimeout(30_000, undefined, { signal });
    }
    const chunks = followup ? ['模拟持仓是 ', '**10 手**。'] : ['标的为 **SIM-101**，模拟持仓为 10 手。\n\n', '```text\n125.40\n```'];
    for (const chunk of chunks) {
      await setTimeout(180, undefined, { signal });
      onDelta(chunk);
    }
    return chunks.join('');
  }
}
