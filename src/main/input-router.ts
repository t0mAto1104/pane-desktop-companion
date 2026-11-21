import type { CaptureState, ObservationUse, SendResult, Settings } from '../shared';
import type { Chat } from './chat';
import type { CaptureResolver } from './capture-resolver';
import type { InputSessionController } from './input-session';
import { interactionContext } from './interaction-context';
import { UserError } from './native';

type Dependencies = {
  sessions: InputSessionController;
  resolver: CaptureResolver;
  chat: () => Chat;
  capture: () => CaptureState;
  settings: () => Settings;
  responseReady: (provider: Settings['provider']) => void;
  activeConversation: () => string | null;
  usableConversation: (id: string) => boolean;
  unavailable: () => boolean;
  paused: () => boolean;
  clearAttachment: (id: string | null) => void;
};

export class InputRouter {
  constructor(private readonly deps: Dependencies) {}

  assertIdle() {
    if (this.deps.chat().run) throw new UserError('请先等待或停止当前回答。');
    this.deps.sessions.assertIdle();
  }

  async send(id: string, text: string, shotId: string | null, retry: boolean, use: ObservationUse = 'omit'): Promise<SendResult> {
    const d = this.deps;
    this.assertIdle();
    if (id !== d.activeConversation()) throw new UserError('请先打开此对话。');
    if (typeof text !== 'string' || text.length > 20_000) throw new UserError('每条消息最多 20,000 个字符。');
    if (use !== 'auto' && use !== 'omit' && use !== 'image') throw new UserError('屏幕上下文选项无效。');
    const { target, bound, shot } = d.capture();
    const manual = use === 'image' || shotId === null ? null : shot;
    if (use !== 'image' && shotId !== null && shot?.id !== shotId) throw new UserError('截图已更新或清除，请重新选择要发送的截图。');
    const context = interactionContext(text.trim() ? 'typed' : 'screen', id, target, text.trim(), manual);
    const settings = d.settings();
    d.responseReady(settings.provider);
    return d.sessions.prepare(id, async signal => {
      const visual = await d.resolver.resolve({
        use, manual, retry: retry ? d.chat().retryVisual(id) : null,
        target, awareness: bound && settings.screenAwarenessEnabled, paused: d.paused(),
        desktopUnavailable: d.unavailable(), denied: settings.denied, signal,
      });
      signal.throwIfAborted();
      if (d.unavailable() || d.activeConversation() !== id || !d.usableConversation(id)) {
        throw new UserError('对话或桌面状态已变更，请重新发送。');
      }
      if (visual.source === 'unavailable') return { kind: 'confirm-text', reason: visual.reason };
      if (manual && d.capture().shot?.id !== context.screenshotId) throw new UserError('手动附件已更新，请确认当前截图后重新发送。');
      const run = d.chat().start(id, context.text!, visual, d.settings(), retry);
      if (manual) d.clearAttachment(manual.id);
      else if (visual.source === 'text' && use === 'omit') d.clearAttachment(null);
      return { kind: 'started', run };
    });
  }
}
