import { randomUUID } from 'node:crypto';
import type { ResponseInputMessage } from '../../vendor/siwc/src/types';
import type { Message, Run, Screenshot, Settings, Update } from '../shared';
import { diagnostic, type AI } from './ai';
import { UserError } from './native';
import type { Store } from './store';

type ImageEntry = { conversation: string; shot: Screenshot };

export class Chat {
  private active?: { run: Run; controller: AbortController };
  private readonly images = new Map<string, ImageEntry>();

  constructor(private readonly store: Store, private readonly ai: AI, private readonly publish: (update: Update) => void) {}

  get run() { return this.active?.run ?? null; }
  stop() { this.active?.controller.abort(); }

  deleteImages(conversation: string) {
    for (const [id, entry] of this.images) if (entry.conversation === conversation) this.images.delete(id);
  }

  enforceDenyList(denied: string[]) {
    for (const [id, { shot }] of this.images) {
      if (denied.some(app => app.toLowerCase() === shot.target.executable.toLowerCase())) this.images.delete(id);
    }
  }

  start(conversationId: string, text: string, selected: Screenshot | null, settings: Settings, retry: boolean): Run {
    if (this.active) throw new UserError('请先等待或停止当前回答。');
    if (!this.store.has(conversationId)) throw new UserError('该对话已删除。');
    const { provider, models } = settings;
    const model = models[provider];
    if (!model) throw new UserError('请先连接账户，然后选择模型。');

    let shot = selected;
    const [lastUser, lastReply] = retry ? this.store.lastTurn(conversationId) : [];
    let userId: string, replyId: string;
    if (retry) {
      if (!lastUser || !lastReply) throw new UserError('找不到可重新发送的消息。');
      shot ??= this.images.get(lastUser.id)?.shot ?? null;
      if (!lastUser.text && !shot) throw new UserError('原截图已从内存清除。请附上新截图后重试。');
      userId = lastUser.id;
      replyId = lastReply.id;
      this.store.retry(conversationId, userId, replyId, shot?.target.title ?? null);
    } else {
      if (!text && !shot) throw new UserError('请输入问题或附上截图。');
      ({ userId, replyId } = this.store.addTurn(conversationId, text, shot?.target.title ?? null));
    }
    if (shot) {
      this.images.delete(userId);
      this.images.set(userId, { conversation: conversationId, shot });
      while (this.images.size > 8) this.images.delete(this.images.keys().next().value!);
    }

    const input = this.history(conversationId);
    const run = { id: randomUUID(), conversationId };
    const controller = new AbortController();
    this.active = { run, controller };
    void this.generate(run, controller, replyId, provider, model, input);
    return run;
  }

  private history(id: string): ResponseInputMessage[] {
    const source = this.store.messages(id, 61).reverse();
    const input: ResponseInputMessage[] = [];
    let textBudget = 100_000;
    let imageBudget = 4;
    for (const message of source) {
      if (message.status !== 'complete') continue;
      const shot = message.role === 'user' && imageBudget > 0 ? this.images.get(message.id)?.shot : undefined;
      if (message.text.length > textBudget) break;
      textBudget -= message.text.length;
      if (shot) {
        imageBudget -= 1;
        input.push({
          role: 'user',
          content: [
            ...(message.text ? [{ type: 'input_text' as const, text: message.text }] : []),
            { type: 'input_image', detail: 'auto', image_url: shot.image },
          ],
        });
      } else if (message.text) {
        input.push({ role: message.role, content: message.text });
      } else if (message.imageLabel && message.role === 'user') {
        input.push({ role: 'user', content: '[An earlier window screenshot is no longer in memory.]' });
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
        text += delta;
        if (Date.now() - savedAt > 450) {
          this.store.patchReply(replyId, text, 'streaming');
          savedAt = Date.now();
        }
        this.publish({ type: 'delta', run, text });
      }) || text;
      if (!text.trim()) throw new UserError('模型返回了空回答，可重试。');
    } catch (error) {
      status = controller.signal.aborted ? 'stopped' : 'failed';
      reason = status === 'stopped' ? null : diagnostic(error);
    } finally {
      try { this.store.patchReply(replyId, text, status, reason); }
      finally {
        this.active = undefined;
        this.publish({ type: 'done', run });
      }
    }
  }
}
