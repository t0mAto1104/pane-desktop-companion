import { randomUUID } from 'node:crypto';
import type { InteractionContext, InputOrigin, Screenshot, Target } from '../shared';
import { sameTarget, UserError } from './native';

export function interactionContext(origin: InputOrigin, conversationId: string | null, target: Target | null,
                                   text: string, screenshot?: Screenshot | null): InteractionContext {
  if (screenshot && (!target || !sameTarget(screenshot.target, target))) {
    throw new UserError('截图所属窗口已变更，请重新选择要发送的截图。');
  }
  return {
    interactionId: randomUUID(), origin, conversationId, targetId: target?.id ?? null,
    createdAt: Date.now(), text, screenshotId: screenshot?.id,
  };
}
