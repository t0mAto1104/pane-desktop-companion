import assert from 'node:assert/strict';
import test from 'node:test';
import { awarenessOptions, type Screenshot, type Target } from '../src/shared';
import { SAMPLE_BYTES, SAMPLE_WIDTH, CaptureError, type CaptureWorker, type FrameSample } from '../src/main/native';
import { compareFrames, ObservationManager } from '../src/main/observation';
import { Store } from '../src/main/store';

const a: Target = { id: '123:45:600', title: 'Fixture A', executable: 'Fixture.exe' };
const b: Target = { ...a, id: '123:46:700', title: 'Fixture B' };
const enabled = awarenessOptions({ screenAwarenessEnabled: true, maxObservations: 2 });
const frame = (target = a, color = 0, dpi = 96): FrameSample => ({
  target, width: 640, height: 400, dpi, pixels: Buffer.alloc(SAMPLE_BYTES, color),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

class Worker implements CaptureWorker {
  current: FrameSample;
  reads = 0;
  encodes = 0;
  closed = false;
  error?: Error;
  pendingImage?: Promise<Screenshot>;
  constructor(target: Target) { this.current = frame(target); }
  async sample() {
    this.reads++;
    if (this.error) throw this.error;
    return this.current;
  }
  async jpeg() {
    this.encodes++;
    return this.pendingImage ?? { id: `frame-${this.encodes}`, target: this.current.target, image: `memory:${this.current.pixels[0]}`, capturedAt: Date.now() };
  }
  close() { this.closed = true; }
}

function fixture(t: test.TestContext) {
  let time = 0;
  const workers: Worker[] = [];
  const manager = new ObservationManager(target => {
    const worker = new Worker(target);
    workers.push(worker);
    return worker;
  }, () => {}, () => time);
  t.after(() => manager.dispose());
  return { manager, workers, advance: (by: number) => { time += by; } };
}

test('settings are off for V1 databases and normalize old or invalid options', () => {
  const store = new Store(':memory:');
  try {
    store.write('settings', { theme: 'dark', pinned: false });
    assert.equal(store.settings().theme, 'dark');
    assert.equal(store.settings().screenAwarenessEnabled, false);
    assert.equal(store.settings().monitoringIntervalMs, 1000);
    assert.equal(store.settings().maxObservations, 3);
    assert.deepEqual(awarenessOptions({ monitoringIntervalMs: -5, changeThreshold: 1, maxObservations: 9 }), {
      screenAwarenessEnabled: false, monitoringIntervalMs: 350, changeThreshold: 0.5, maxObservations: 8,
    });
    assert.equal(awarenessOptions({ changeThreshold: NaN }).changeThreshold, 0.015);
  } finally { store.close(); }
});

test('samples are pixel-compared locally, including geometry and DPI changes', () => {
  const base = frame();
  const next = frame();
  for (let y = 0; y < 9; y++) next.pixels.fill(180, y * SAMPLE_WIDTH * 3, y * SAMPLE_WIDTH * 3 + 36);
  const delta = compareFrames(base, next);
  assert.equal(delta.score, 1 / 48);
  assert.deepEqual(delta.regions, [{ x: 0, y: 0, width: 1 / 8, height: 1 / 6 }]);
  assert.equal(compareFrames(base, frame(a, 4)).score, 0);
  assert.equal(compareFrames(base, frame(a, 0, 144)).score, 1);
  assert.equal(compareFrames(base, { ...base, width: 641 }).score, 1);
});

test('one initial image, no repeated static images, convergent changes, cooldown and eviction', async t => {
  const { manager, workers, advance } = fixture(t);
  manager.configure(a, enabled, []);
  const first = await manager.fresh(a.id);
  const worker = workers[0];
  assert.ok(first);
  assert.equal(worker.reads, 1, 'the send-time check joins an in-flight sample');
  assert.equal((await manager.fresh(a.id))?.observation.observationId, first.observation.observationId);
  assert.equal(worker.encodes, 1);

  advance(400);
  worker.current = frame(a, 90);
  assert.equal(await manager.fresh(a.id), null);
  assert.equal(manager.current.phase, 'changing');
  advance(400);
  worker.current = frame(a, 130);
  assert.equal(await manager.fresh(a.id), null);
  advance(400);
  assert.equal(await manager.fresh(a.id), null, 'cooldown still applies to a stable change');
  advance(400);
  const second = await manager.fresh(a.id);
  assert.ok(second && second.observation.frameHash !== first.observation.frameHash);
  assert.equal(second.screenshot.image, 'memory:130');
  assert.equal(worker.encodes, 2);

  advance(1700);
  worker.current = frame(a, 210);
  assert.equal(await manager.fresh(a.id), null);
  advance(400);
  assert.ok(await manager.fresh(a.id));
  assert.equal(manager.preview(first.observation.observationId), null);
  assert.ok(manager.preview(second.observation.observationId));
  assert.equal(worker.encodes, 3);
});

test('continuously changing frames converge only after the debounce deadline', async t => {
  const { manager, workers, advance } = fixture(t);
  manager.configure(a, awarenessOptions({ ...enabled, monitoringIntervalMs: 350 }), []);
  assert.ok(await manager.fresh(a.id));
  const worker = workers[0];
  for (let i = 0; i <= 6; i++) {
    advance(350);
    worker.current = frame(a, i % 2 === 0 ? 70 : 150);
    assert.equal(await manager.fresh(a.id), null);
  }
  advance(500);
  worker.current = frame(a, 170);
  const result = await manager.fresh(a.id);
  assert.equal(result?.screenshot.image, 'memory:170');
  assert.equal(worker.encodes, 2);
});

test('rebind, pause and disable discard pending work and old previews', async t => {
  const { manager, workers } = fixture(t);
  manager.configure(a, enabled, []);
  const pending = deferred<Screenshot>();
  workers[0].pendingImage = pending.promise;
  const old = manager.fresh(a.id);
  for (let i = 0; workers[0].encodes === 0 && i < 10; i++) await Promise.resolve();
  assert.equal(workers[0].encodes, 1);
  manager.configure(b, enabled, []);
  const latest = await manager.fresh(b.id);
  assert.ok(latest);
  pending.resolve({ id: 'stale', target: a, image: 'stale', capturedAt: Date.now() });
  assert.equal(await old, null);
  assert.equal(manager.current.latest?.observationId, latest.observation.observationId);
  assert.equal(workers[0].closed, true);

  manager.pause();
  assert.equal(manager.current.phase, 'paused');
  assert.equal(await manager.fresh(b.id), null);
  assert.equal(manager.preview(latest.observation.observationId), null);
  manager.resume();
  assert.ok(await manager.fresh(b.id));
  manager.configure(b, awarenessOptions({}), []);
  assert.equal(manager.current.phase, 'off');
  assert.equal(workers.at(-1)?.closed, true);
});

test('failed identities and denylisted apps cannot leave usable observations', async t => {
  const { manager, workers } = fixture(t);
  manager.configure(a, enabled, ['FIXTURE.EXE']);
  assert.equal(manager.current.phase, 'stopped');
  assert.equal(workers.length, 0);
  manager.configure(a, enabled, [], true);
  const first = await manager.fresh(a.id);
  assert.ok(first);
  workers[0].error = new Error('Window closed or native capture unavailable');
  assert.equal(await manager.fresh(a.id), null);
  assert.match(manager.current.reason ?? '', /capture unavailable/);
  assert.equal(manager.preview(first.observation.observationId), null);
  manager.configure(b, enabled, [], true);
  assert.equal((await manager.fresh(b.id))?.observation.targetId, b.id);
});

test('returning to a cached screen reuses the same JPEG while creating a new observation', async t => {
  const { manager, workers, advance } = fixture(t);
  manager.configure(a, enabled, []);
  const first = await manager.fresh(a.id);
  assert.ok(first);
  const worker = workers[0];
  advance(1700);
  worker.current = frame(a, 100);
  assert.equal(await manager.fresh(a.id), null);
  advance(400);
  const second = await manager.fresh(a.id);
  assert.ok(second && second.screenshot.id !== first.screenshot.id);
  advance(1600);
  worker.current = frame(a);
  assert.equal(await manager.fresh(a.id), null);
  advance(400);
  const returned = await manager.fresh(a.id);
  assert.ok(returned);
  assert.notEqual(returned.observation.observationId, first.observation.observationId);
  assert.equal(returned.screenshot.id, first.screenshot.id);
  assert.equal(worker.encodes, 2);
});

test('send-time observation distinguishes a candidate, transient exit and unsafe failure', async t => {
  const { manager, workers, advance } = fixture(t);
  manager.configure(a, enabled, []);
  assert.equal((await manager.prepare(a.id, new AbortController().signal)).kind, 'confirmed');
  advance(700);
  workers[0].current = frame(a, 100);
  assert.equal((await manager.prepare(a.id, new AbortController().signal)).kind, 'pending');
  workers[0].error = new CaptureError('worker_exit', 'worker exited');
  assert.deepEqual(await manager.prepare(a.id, new AbortController().signal),
    { kind: 'unavailable', reason: 'worker exited', allowInstant: true });
  manager.resume();
  await manager.fresh(a.id);
  workers[1].error = new CaptureError('target_gone', 'window closed');
  assert.deepEqual(await manager.prepare(a.id, new AbortController().signal),
    { kind: 'unavailable', reason: 'window closed', allowInstant: false });
});
