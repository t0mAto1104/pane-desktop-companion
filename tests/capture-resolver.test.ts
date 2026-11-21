import assert from 'node:assert/strict';
import test from 'node:test';
import type { Screenshot, Target } from '../src/shared';
import { CaptureResolver, sentVisual, type TurnVisual } from '../src/main/capture-resolver';
import { CaptureError } from '../src/main/native';
import type { ObservedFrame, SendObservation } from '../src/main/observation';
import { screenContextNote } from '../src/main/screen-context';

const target: Target = { id: '17:19:22', title: 'Sim terminal', executable: 'Trade.exe' };
const photo = (id: string, window = target): Screenshot => ({ id, target: window, image: 'fixture:' + id, capturedAt: 100 });
const manual = photo('manual');
const instant = photo('instant');
const frame: ObservedFrame = {
  screenshot: photo('confirmed'),
  observation: {
    observationId: 'frame', targetId: target.id, frameHash: 'same-hash', capturedAt: 100,
    changeScore: 0.1, changedRegions: [], screenshotReference: 'confirmed',
  },
};

function rig(state: SendObservation = { kind: 'confirmed', frame }) {
  const calls: string[] = [];
  const defaultInput = {
    use: 'auto' as const, manual: null as Screenshot | null, retry: null as TurnVisual | null,
    awareness: true, paused: false, desktopUnavailable: false, target, denied: [],
    signal: new AbortController().signal,
  };
  const deps: ConstructorParameters<typeof CaptureResolver>[0] = {
    async observation() { calls.push('observation'); return state; },
    async validate() { calls.push('validate'); },
    async capture() { calls.push('capture'); return instant; },
  };
  const resolver = new CaptureResolver(deps);
  const resolve = (change: Partial<Parameters<typeof resolver.resolve>[0]> = {}) => resolver.resolve({ ...defaultInput, ...change });
  return { resolve, deps, calls };
}

test('manual and omit select only the explicitly attached image', async () => {
  const { resolve, calls } = rig();
  assert.deepEqual(await resolve({ manual }), { source: 'manual', shot: manual });
  assert.deepEqual(await resolve({ use: 'omit', manual }), { source: 'manual', shot: manual });
  assert.deepEqual(await resolve({ use: 'omit', retry: { source: 'manual', shot: manual } }), { source: 'text' });
  assert.deepEqual(calls, ['validate', 'validate']);
});

test('auto reuses the confirmed image in the payload for separate questions', async () => {
  const { resolve, calls } = rig();
  const first = await resolve();
  const second = await resolve();
  assert.ok(first.source === 'observation' && second.source === 'observation');
  assert.equal(first.shot, second.shot);
  assert.equal(sentVisual(second).source, 'observation');
  assert.match(screenContextNote(second), /visual evidence/);
  assert.match(screenContextNote({ source: 'text' }), /Do not claim to see the current screen/);
  assert.deepEqual(calls, ['observation', 'observation']);
});

test('changing frames use exactly one bound capture, forced-image accepts only observation', async () => {
  const { resolve, calls } = rig({ kind: 'pending', reason: 'changing' });
  assert.deepEqual(await resolve(), { source: 'instant', shot: instant });
  assert.deepEqual(await resolve({ use: 'image', manual }), { source: 'unavailable', reason: '当前没有可用的观察截图。changing' });
  const confirmed = rig();
  assert.equal((await confirmed.resolve({ use: 'image', manual })).source, 'observation');
  assert.deepEqual(calls, ['observation', 'capture', 'observation']);
});

test('a transient worker failure may fall back once and a failed capture requires confirmation', async () => {
  const { resolve, calls, deps } = rig({ kind: 'unavailable', reason: 'worker exit', allowInstant: true });
  deps.capture = async () => {
    calls.push('capture');
    throw new CaptureError('no_frame', 'Windows 未返回画面。');
  };
  assert.deepEqual(await resolve(), { source: 'unavailable', reason: '即时捕获失败。Windows 未返回画面。' });
  assert.deepEqual(calls, ['observation', 'capture']);
});

test('paused, locked, denied, invalid targets and omit do not recapture', async () => {
  const { resolve, calls } = rig({ kind: 'unavailable', reason: 'target closed', allowInstant: false });
  assert.equal((await resolve({ paused: true })).source, 'text');
  assert.equal((await resolve({ desktopUnavailable: true })).source, 'text');
  assert.equal((await resolve({ desktopUnavailable: true, manual })).source, 'unavailable');
  assert.equal((await resolve({ denied: ['TRADE.EXE'] })).source, 'unavailable');
  assert.equal((await resolve({ use: 'omit' })).source, 'text');
  assert.equal((await resolve()).source, 'unavailable');
  assert.deepEqual(calls, ['observation']);
});

test('a prior manual attachment may be reused for an explicit retry of the same window', async () => {
  const { resolve, calls } = rig();
  const retry = { source: 'manual' as const, shot: manual };
  assert.deepEqual(await resolve({ retry }), retry);
  assert.equal((await resolve({ retry: { ...retry, shot: photo('other', { ...target, id: '17:20:23' }) } })).source, 'observation');
  assert.deepEqual(calls, ['validate', 'observation']);
});

test('a late instant capture cannot escape cancellation or change identity', async () => {
  const { resolve, deps, calls } = rig({ kind: 'pending', reason: 'changing' });
  const abort = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(done => { started = done; });
  let done!: (shot: Screenshot) => void;
  deps.capture = () => new Promise(finish => { done = finish; started(); });
  const result = resolve({ signal: abort.signal });
  await ready;
  abort.abort(new Error('binding changed'));
  done(instant);
  await assert.rejects(result, /binding changed/);
  deps.capture = async () => photo('different', { ...target, executable: 'Other.exe' });
  assert.equal((await resolve()).source, 'unavailable');
  assert.deepEqual(calls, ['observation', 'observation']);
});
