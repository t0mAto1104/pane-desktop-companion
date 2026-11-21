import assert from 'node:assert/strict';
import test from 'node:test';
import { ElementDetector } from '../src/main/element-detector';
import { GuidanceEngine, parseGuidance } from '../src/main/guidance';

const target = { id: '11:22:33', title: 'Trading fixture', executable: 'Simulator.exe' };
const scope = { target, denied: [], signal: new AbortController().signal };
const geometry = { bounds: { x: 0, y: 0, width: 500, height: 300 }, dpi: 96, foreground: true };
const plan = { title: '模拟交易', steps: [
  { title: '打开确认页', explanation: '手动操作模拟软件。', expectedState: '出现模拟确认页',
    targetElement: { name: '模拟入口' }, verificationMethod: 'uia-visible', verifyElement: { name: '模拟确认页' } },
  { title: '核对数量', explanation: '自己检查模拟订单的数量。', expectedState: '用户核对', verificationMethod: 'manual' },
] };
const element = (elementId: string, name: string, parentId: string | null) => ({
  elementId, name, parentId, automationId: '', controlType: 50000, boundingRectangle: { x: 10, y: 10, width: 100, height: 50 },
  isEnabled: true, isOffscreen: false, processId: 22, childrenIds: [],
});

test('a step completes only when its expected element appears, or the user confirms', async () => {
  let displayed = false;
  const changes: unknown[] = [];
  const detector = new ElementDetector(async () => ({ geometry, tree: { truncated: false, elements: [
    element(':1', 'Root', null), element(':2', '模拟入口', ':1'), ...(displayed ? [element(':3', '模拟确认页', ':1')] : []),
  ] } }));
  const engine = new GuidanceEngine(detector, async () => { throw new Error('no image authorized'); },
    async () => plan, state => changes.push(state));
  assert.equal((await engine.start(scope, '指导模拟操作', false))?.steps[0].status, 'active');
  await assert.rejects(engine.next(scope), /确认或跳过/);
  assert.equal((await engine.check(scope))?.steps[0].status, 'blocked');
  displayed = true;
  assert.equal((await engine.check(scope))?.steps[0].verification, 'uia');
  assert.equal((await engine.next(scope))?.index, 1);
  assert.equal((await engine.pause(scope, true))?.mode, 'paused');
  assert.equal(engine.confirm(scope)?.steps[1].status, 'active');
  assert.equal((await engine.pause(scope, false))?.mode, 'active');
  assert.equal(engine.confirm(scope)?.steps[1].verification, 'manual');
  assert.equal((await engine.next(scope))?.mode, 'done');
  engine.clear();
  assert.equal(engine.state, null);
  assert.equal(changes.at(-1), null);
});

test('an existing visual state is not completion evidence and an aborted plan cannot reappear', async () => {
  const detector = new ElementDetector(async () => ({ geometry, tree: { truncated: false, elements: [
    element(':1', 'Root', null), element(':2', '模拟确认页', ':1'),
  ] } }));
  let plans = async () => plan;
  const engine = new GuidanceEngine(detector, async () => { throw new Error('not authorized'); },
    () => plans(), () => {});
  await engine.start(scope, '指导模拟操作', false);
  assert.equal((await engine.check(scope))?.steps[0].status, 'blocked');
  assert.equal(engine.confirm(scope, true)?.steps[0].status, 'skipped');
  let release!: (value: typeof plan) => void;
  let ready!: () => void;
  const active = new Promise<void>(resolve => { ready = resolve; });
  plans = () => new Promise(resolve => { release = resolve; ready(); });
  const pending = engine.start(scope, '取消的任务', false);
  await active;
  engine.clear();
  release(plan);
  await assert.rejects(pending);
  assert.equal(engine.state, null);
  assert.throws(() => parseGuidance({ title: 'Invalid', steps: [{ title: 'missing' }] }));
});
