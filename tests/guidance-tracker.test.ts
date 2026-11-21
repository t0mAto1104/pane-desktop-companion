import test from 'node:test';
import assert from 'node:assert/strict';
import type { GuidanceState } from '../src/shared';
import { trackerBounds, trackerDocument } from '../src/main/guidance-tracker-view';

test('the tracker fits at the top right of its work area, including a negative monitor origin', () => {
  assert.deepEqual(trackerBounds({ x: -1920, y: -30, width: 1920, height: 1040 }), {
    x: -320, y: -14, width: 304, height: 174,
  });
  const small = trackerBounds({ x: 30, y: 50, width: 200, height: 110 });
  assert.ok(small.x >= 30 && small.x + small.width <= 230 && small.y >= 50 && small.y + small.height <= 160);
});

test('the read-only tracker renders just the active step and escapes model text', () => {
  const first = {
    stepId: '1', title: '<b>步骤一</b>', explanation: '<img src="bad">说明', targetElement: null,
    expectedState: '预期 & 结果', verificationMethod: 'manual', verifyElement: null, status: 'completed',
  } as const;
  const plan: GuidanceState = { title: '<script>任务</script>', index: 1, mode: 'active', steps: [
    first, { ...first, stepId: '2', title: '第二步', status: 'blocked' },
  ] };
  const result = trackerDocument(plan)!;
  assert.match(result, /第 2 \/ 2 步/);
  assert.match(result, /请检查并手动确认/);
  assert.match(result, /max="2" value="1"/);
  assert.match(result, /&lt;img src=&quot;bad&quot;&gt;说明/);
  assert.ok(!result.includes('<script>') && !result.includes('<b>步骤一'));
  assert.equal(trackerDocument({ ...plan, mode: 'paused' }), null);
  assert.equal(trackerDocument({ ...plan, mode: 'done' }), null);
});
