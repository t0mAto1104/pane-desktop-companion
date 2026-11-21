import type { Observation, ObservationUse, Screenshot, SentVisual, Target } from '../shared';
import { sameTarget, UserError } from './native';
import type { SendObservation } from './observation';

export type TurnVisual = { source: 'text' } | {
  source: 'manual' | 'observation' | 'instant';
  shot: Screenshot;
  observation?: Observation;
};
export type CaptureResolution = TurnVisual | { source: 'unavailable'; reason: string };

type Input = {
  use: ObservationUse;
  manual: Screenshot | null;
  retry: TurnVisual | null;
  target: Target | null;
  awareness: boolean;
  paused: boolean;
  desktopUnavailable: boolean;
  denied: string[];
  signal: AbortSignal;
};
type Dependencies = {
  observation(target: Target, signal: AbortSignal): Promise<SendObservation>;
  validate(target: Target, denied: string[], signal: AbortSignal): Promise<void>;
  capture(target: Target, denied: string[], signal: AbortSignal): Promise<Screenshot>;
};

const text: TurnVisual = { source: 'text' };
const unavailable = (reason: string): CaptureResolution => ({ source: 'unavailable', reason });
const reason = (error: unknown) => error instanceof UserError ? error.message : 'Windows 无法读取当前窗口。';
export const deniedTarget = (target: Target, denied: string[]) =>
  denied.some(app => app.toLowerCase() === target.executable.toLowerCase());

export class CaptureResolver {
  constructor(private readonly deps: Dependencies) {}

  async resolve(input: Input): Promise<CaptureResolution> {
    const { use, manual, retry, target, awareness, paused, desktopUnavailable, denied, signal } = input;
    signal.throwIfAborted();
    if (desktopUnavailable) {
      return manual || use === 'image'
        ? unavailable('Windows 桌面已锁定或正在休眠。当前截图无法验证。') : text;
    }

    if (manual && use !== 'image') return this.validateManual(manual, denied, signal);
    if (use === 'omit') return text;
    if (target && deniedTarget(target, denied)) return unavailable('该应用在禁止捕获名单中。');

    // Clicking retry can reuse a manual attachment from the previous turn on the same window.
    if (use === 'auto' && retry?.source === 'manual' && target && sameTarget(retry.shot.target, target)) {
      return this.validateManual(retry.shot, denied, signal);
    }
    if (!target || !awareness || paused) {
      return use === 'image' ? unavailable('当前没有可用的观察截图。请绑定窗口并恢复观察。') : text;
    }

    const state = await this.deps.observation(target, signal);
    signal.throwIfAborted();
    if (state.kind === 'confirmed') {
      if (!sameTarget(state.frame.screenshot.target, target)) return unavailable('目标窗口已变更。请重新选择窗口。');
      return { source: 'observation', shot: state.frame.screenshot, observation: state.frame.observation };
    }
    if (use === 'image') return unavailable('当前没有可用的观察截图。' + state.reason);
    if (state.kind === 'unavailable' && !state.allowInstant) return unavailable(state.reason);

    try {
      // Native validates the full HWND/PID/start-time identity before and after this one capture.
      const shot = await this.deps.capture(target, denied, signal);
      signal.throwIfAborted();
      if (!sameTarget(shot.target, target)) return unavailable('目标窗口已变更。请重新选择窗口。');
      return { source: 'instant', shot };
    } catch (error) {
      signal.throwIfAborted();
      return unavailable('即时捕获失败。' + reason(error));
    }
  }

  private async validateManual(shot: Screenshot, denied: string[], signal: AbortSignal): Promise<CaptureResolution> {
    if (deniedTarget(shot.target, denied)) return unavailable('该应用在禁止捕获名单中。');
    try {
      await this.deps.validate(shot.target, denied, signal);
      signal.throwIfAborted();
      return { source: 'manual', shot };
    } catch (error) {
      signal.throwIfAborted();
      return unavailable('附加截图无法验证。' + reason(error));
    }
  }
}

export function sentVisual(visual: TurnVisual): SentVisual {
  return visual.source === 'text' ? { source: 'text' } : {
    source: visual.source,
    screenshotId: visual.shot.id,
    targetTitle: visual.shot.target.title,
    capturedAt: visual.observation?.capturedAt ?? visual.shot.capturedAt,
  };
}
