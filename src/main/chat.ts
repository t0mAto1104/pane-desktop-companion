import { randomUUID } from 'node:crypto';
import type { ResponseInputMessage } from '../../vendor/siwc/src/types';
import type { Message, Run, Settings, Update } from '../shared';
import { diagnostic, type AI } from './ai';
import { UserError } from './native';
import type { Store } from './store';
import { sentVisual, type TurnVisual } from './capture-resolver';
import { screenContextNote } from './screen-context';

type ImageVisual = Exclude<TurnVisual, { source: 'text' }>;
type ImageEntry = { conversation: string; visual: ImageVisual };

export class Chat {
  private closed = false;
  private active?: { run: Run; controller: AbortController };
  private readonly images = new Map<string, ImageEntry>();

  constructor(private readonly store: Store, private readonly ai: AI, private readonly publish: (update: Update) => void) {}

  get run() { return this.active?.run ?? null; }
  stop() { this.active?.controller.abort(); }
  shutdown() { this.closed = true; this.stop(); }

  retryVisual(conversation: string): TurnVisual | null {
    const [message] = this.store.lastTurn(conversation);
    return message ? this.images.get(message.id)?.visual ?? null : null;
  }

  deleteImages(conversation: string) {
    for (const [id, entry] of this.images) if (entry.conversation === conversation) this.images.delete(id);
  }

  enforceDenyList(denied: string[]) {
    for (const [id, { visual: { shot } }] of this.images) {
      if (denied.some(app => app.toLowerCase() === shot.target.executable.toLowerCase())) this.images.delete(id);
    }
  }

  start(conversationId: string, text: string, visual: TurnVisual, settings: Settings, retry: boolean): Run {
    if (this.active) throw new UserError('请先等待或停止当前回答。');
    if (!this.store.has(conversationId)) throw new UserError('该对话已删除。');
    const { provider, models } = settings;
    const model = models[provider];
    if (!model) throw new UserError('请先连接账户，然后选择模型。');

    const withImage = visual.source !== 'text';
    const label = visual.source === 'manual' ? '手动截图 · ' + visual.shot.target.title
      : visual.source === 'observation' ? '屏幕观察' : visual.source === 'instant' ? '即时捕获' : null;
    const [lastUser, lastReply] = retry ? this.store.lastTurn(conversationId) : [];
    let userId: string, replyId: string;
    if (retry) {
      if (!lastUser || !lastReply) throw new UserError('找不到可重新发送的消息。');
      if (!lastUser.text && !withImage) throw new UserError('这条消息需要一张截图。请附上截图后重试。');
      userId = lastUser.id;
      replyId = lastReply.id;
      this.store.retry(conversationId, userId, replyId, label);
    } else {
      if (!text && !withImage) throw new UserError('请输入问题或附上截图。');
      ({ userId, replyId } = this.store.addTurn(conversationId, text, label));
    }
    if (retry) this.images.delete(userId);
    if (withImage && visual.source === 'manual') {
      this.images.set(userId, { conversation: conversationId, visual });
      while (this.images.size > 8) this.images.delete(this.images.keys().next().value!);
    }

    const input = this.history(conversationId, userId, visual);
    const run: Run = { id: randomUUID(), conversationId, visual: sentVisual(visual) };
    const controller = new AbortController();
    this.active = { run, controller };
    void this.generate(run, controller, replyId, provider, model, input);
    return run;
  }

  private history(id: string, currentUser: string, visual: TurnVisual): ResponseInputMessage[] {
    const source = this.store.messages(id, 61).reverse();
    const input: ResponseInputMessage[] = [];
    let textBudget = 100_000;
    for (const message of source) {
      if (message.status !== 'complete') continue;
      if (message.text.length > textBudget) break;
      textBudget -= message.text.length;

      if (message.id === currentUser) {
        const content = visual.source === 'text' ? message.text : [
          ...(message.text ? [{ type: 'input_text' as const, text: message.text }] : []),
          { type: 'input_image' as const, detail: 'auto' as const, image_url: visual.shot.image },
        ];
        if (typeof content === 'string') input.push({ role: 'user', content });
        else input.push({ role: 'user', content });
        input.push({ role: 'developer', content: screenContextNote(visual) });
      } else if (message.text) {
        input.push({ role: message.role, content: message.text });
      } else if (message.imageLabel && message.role === 'user') {
        input.push({ role: 'user', content: '[An earlier message contained an image. Its pixels are not provided in this request.]' });
      }
    }
    return input.reverse();
  }

  private async generate(run: Run, controller: AbortController, replyId: string, provider: Settings['provider'], model: string, input: ResponseInputMessage[]) {
    let text = '';
    let savedAt = 0;
    let status: Message['status'] = 'complete';
    let reason: string | null = null;
    try {
      text = await this.ai.stream(provider, model, input, controller.signal, delta => {
        if (controller.signal.aborted || this.closed) return;
        text += delta;
        if (Date.now() - savedAt > 450) {
          this.store.patchReply(replyId, text, 'streaming');
          savedAt = Date.now();
        }
        this.publish({ type: 'delta', run, text });
      }) || text;
      controller.signal.throwIfAborted();
      if (!text.trim()) throw new UserError('模型返回了空回答，可重试。');
    } catch (error) {
      status = controller.signal.aborted ? 'stopped' : 'failed';
      reason = status === 'stopped' ? null : diagnostic(error);
    } finally {
      try { if (!this.closed) this.store.patchReply(replyId, text, status, reason); }
      finally {
        this.active = undefined;
        if (!this.closed) this.publish({ type: 'done', run });
      }
    }
  }
}
