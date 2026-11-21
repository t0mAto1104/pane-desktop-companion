import { createHash, randomUUID } from 'node:crypto';
import type { AwarenessOptions, Observation, ObservationState, ScreenRegion, Screenshot, Target } from '../shared';
import { SAMPLE_WIDTH, SAMPLE_HEIGHT, type CaptureWorker, type FrameSample } from './native';
const COLUMNS = 8;
const ROWS = 6;
const COLOR_DELTA = 20;
const COOLDOWN_MS = 1500;
const IMAGE_CACHE_BYTES = 24 * 1024 * 1024;

export type ObservedFrame = { observation: Observation; screenshot: Screenshot };

export function compareFrames(previous: FrameSample, current: FrameSample) {
  if (previous.width !== current.width || previous.height !== current.height || previous.dpi !== current.dpi) {
    return { score: 1, regions: [{ x: 0, y: 0, width: 1, height: 1 }] };
  }
  if (previous.pixels.equals(current.pixels)) return { score: 0, regions: [] };
  let changed = 0;
  const counts = new Uint16Array(COLUMNS * ROWS);
  const tileWidth = SAMPLE_WIDTH / COLUMNS;
  const tileHeight = SAMPLE_HEIGHT / ROWS;
  const a = previous.pixels;
  const b = current.pixels;
  for (let y = 0; y < SAMPLE_HEIGHT; y++) {
    for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const p = (y * SAMPLE_WIDTH + x) * 3;
      const delta = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
      if (delta >= COLOR_DELTA) {
        changed++;
        counts[Math.floor(y / tileHeight) * COLUMNS + Math.floor(x / tileWidth)]++;
      }
    }
  }
  const regions: ScreenRegion[] = [];
  for (let tile = 0; tile < counts.length; tile++) {
    if (counts[tile] >= 3) regions.push({ x: (tile % COLUMNS) / COLUMNS, y: Math.floor(tile / COLUMNS) / ROWS, width: 1 / COLUMNS, height: 1 / ROWS });
  }
  return { score: changed / (SAMPLE_WIDTH * SAMPLE_HEIGHT), regions };
}

function hash(sample: FrameSample) {
  return createHash('sha256').update(`${sample.width}x${sample.height}@${sample.dpi}\0`).update(sample.pixels).digest('hex');
}

type Plan = { target: Target | null; options: AwarenessOptions; denied: string[] };
type Session = {
  plan: Plan & { target: Target };
  worker: CaptureWorker;
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  baseline?: FrameSample;
  candidate?: FrameSample;
  candidateSince: number;
  acceptedAt: number;
  entries: ObservedFrame[];
};

export class ObservationManager {
  private plan?: Plan;
  private session?: Session;
  private state: ObservationState = { phase: 'off', target: null, latest: null };

  constructor(
    private readonly open: (target: Target, denied: string[]) => CaptureWorker,
    private readonly publish: (state: ObservationState) => void,
    private readonly clock = () => performance.now(),
  ) {}

  get current() { return this.state; }

  configure(target: Target | null, options: AwarenessOptions, denied: string[], rebind = false) {
    const old = this.plan;
    const plan = { target, options: { ...options }, denied: [...denied] };
    this.plan = plan;
    if (!options.screenAwarenessEnabled) { this.finish('off', target); return; }
    if (!target) { this.finish('unbound', null); return; }

    const identityChanged = !old || old.target?.id !== target.id;
    const settingsChanged = old && (old.denied.join('\0') !== denied.join('\0') ||
      old.options.monitoringIntervalMs !== options.monitoringIntervalMs ||
      old.options.changeThreshold !== options.changeThreshold || old.options.maxObservations !== options.maxObservations);
    if (rebind || identityChanged || !old?.options.screenAwarenessEnabled || (this.session && settingsChanged)) {
      this.start({ ...plan, target });
    }
  }

  pause() {
    if (this.plan?.options.screenAwarenessEnabled && this.plan.target) this.finish('paused', this.plan.target);
  }

  resume() {
    const plan = this.plan;
    if (plan?.options.screenAwarenessEnabled && plan.target && !this.session) this.start({ ...plan, target: plan.target });
  }

  dispose() { this.plan = undefined; this.finish('off', null); }

  preview(observationId: string): Screenshot | null {
    return this.session?.entries.find(entry => entry.observation.observationId === observationId)?.screenshot ?? null;
  }

  async fresh(targetId: string): Promise<ObservedFrame | null> {
    const session = this.session;
    if (!session || session.plan.target.id !== targetId) return null;
    await this.poll(session);
    if (this.session !== session || this.state.phase !== 'watching') return null;
    return session.entries.at(-1) ?? null;
  }

  private setState(next: ObservationState) {
    const before = this.state;
    this.state = next;
    if (before.phase !== next.phase || before.reason !== next.reason ||
        before.target?.id !== next.target?.id || before.target?.title !== next.target?.title ||
        before.latest?.observationId !== next.latest?.observationId) this.publish(next);
  }

  private stopSession() {
    const previous = this.session;
    this.session = undefined;
    if (!previous) return;
    clearTimeout(previous.timer);
    previous.entries.length = 0;
    previous.worker.close();
  }

  private finish(phase: ObservationState['phase'], target: Target | null, reason?: string) {
    this.stopSession();
    this.setState({ phase, target, latest: null, reason });
  }

  private start(plan: Session['plan']) {
    this.stopSession();
    const { target, denied } = plan;
    if (denied.some(executable => executable.toLowerCase() === target.executable.toLowerCase())) {
      this.finish('stopped', target, '该应用在禁止捕获名单中。');
      return;
    }
    try {
      const session: Session = { plan, worker: this.open(target, denied), entries: [], candidateSince: 0, acceptedAt: -Infinity };
      this.session = session;
      this.setState({ phase: 'starting', target, latest: null });
      void this.poll(session);
    } catch (error) { this.fail(target, error); }
  }

  private poll(session: Session): Promise<void> {
    if (this.session !== session) return Promise.resolve();
    if (session.flight) return session.flight;
    clearTimeout(session.timer);
    session.flight = this.sample(session).finally(() => {
      session.flight = undefined;
      if (this.session === session) session.timer = setTimeout(() => void this.poll(session), session.plan.options.monitoringIntervalMs);
    });
    return session.flight;
  }

  private async sample(session: Session) {
    try {
      const next = await session.worker.sample();
      if (this.session !== session) return;
      const capturedAt = Date.now();
      const now = this.clock();
      const { monitoringIntervalMs, changeThreshold, maxObservations } = session.plan.options;
      const delta = session.baseline ? compareFrames(session.baseline, next) : { score: 0, regions: [] };
      if (session.baseline && delta.score < changeThreshold) {
        session.candidate = undefined;
        this.setState({ phase: 'watching', target: next.target, latest: session.entries.at(-1)!.observation });
        return;
      }
      if (session.baseline) {
        const first = !session.candidate;
        if (first) session.candidateSince = now;
        const stable = session.candidate &&
          compareFrames(session.candidate, next).score < Math.max(changeThreshold / 2, 0.002);
        const maxWait = Math.max(2500, monitoringIntervalMs * 3);
        session.candidate = next;
        if (now - session.acceptedAt < COOLDOWN_MS || (!stable && now - session.candidateSince < maxWait)) {
          this.setState({ phase: 'changing', target: next.target, latest: session.entries.at(-1)!.observation });
          return;
        }
      }
      const screenshot = await session.worker.jpeg();
      if (this.session !== session) return;
      if (screenshot.target.id !== next.target.id) throw new Error('截图目标已变更。请重新选择窗口。');
      const observation: Observation = {
        observationId: randomUUID(), targetId: next.target.id, capturedAt,
        frameHash: hash(next), changeScore: delta.score, changedRegions: delta.regions,
        screenshotReference: screenshot.id,
      };
      session.baseline = next;
      session.candidate = undefined;
      session.acceptedAt = now;
      session.entries.push({ observation, screenshot });
      let bytes = session.entries.reduce((total, entry) => total + entry.screenshot.image.length, 0);
      while (session.entries.length > 1 && (session.entries.length > maxObservations || bytes > IMAGE_CACHE_BYTES)) {
        bytes -= session.entries.shift()!.screenshot.image.length;
      }
      this.setState({ phase: 'watching', target: screenshot.target, latest: observation });
    } catch (error) {
      if (this.session === session) this.fail(session.plan.target, error);
    }
  }

  private fail(target: Target, error: unknown) {
    this.finish('stopped', target, error instanceof Error ? error.message : 'Windows 捕获失败。可尝试手动刷新截图。');
  }
}
