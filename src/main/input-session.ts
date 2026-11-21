import { UserError } from './native';

export class InputSessionController {
  private active?: { id: string | null; controller: AbortController };

  get pending() { return this.active !== undefined; }
  get conversationId() { return this.active?.id; }

  assertIdle() {
    if (this.active) throw new UserError('请先等待或停止当前输入。');
  }

  cancel(message: string) { this.active?.controller.abort(new UserError(message)); }

  async prepare<T>(id: string | null, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertIdle();
    const session = { id, controller: new AbortController() };
    this.active = session;
    const deadline = setTimeout(() => session.controller.abort(new UserError('准备本轮输入超时，请重试。')), 15_000);
    try {
      return await execute(session.controller.signal);
    } finally {
      clearTimeout(deadline);
      if (this.active === session) this.active = undefined;
    }
  }
}
