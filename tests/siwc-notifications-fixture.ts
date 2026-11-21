import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiError } from '../vendor/siwc/src/errors';
import type { SessionState } from '../vendor/siwc/src/types';
export { ChatGPTError } from '../vendor/siwc/src/errors';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com';

export function createChatGPT() {
  const connected: SessionState = { status: 'connected', sharing: true, identity: { name: '限流验收' } };
  let listener: (state: SessionState) => void = () => {};
  let catalogRequests = 0;
  const log = (name: string) => appendFileSync(process.env.PANE_TEST_REQUEST_LOG!, name + '\n');
  function limited() {
    const error = apiError({ error: { code: 'rate_limit_exceeded' } }, 429, undefined, '45');
    listener({ ...connected, error: error.toJSON() });
    throw error;
  }
  return {
    subscribe(fn: typeof listener) { listener = fn; fn({ status: 'disconnected', sharing: false }); },
    async getSession() { log('read'); listener({ ...connected }); return connected; },
    async listModels({ signal }: { signal: AbortSignal }) {
      log('models');
      catalogRequests++;
      listener({ ...connected });
      await sleep(75, undefined, { signal });
      if (catalogRequests === 1) limited();
      return [{ slug: 'fixture-model', displayName: '验收模型' }];
    },
    async streamResponse() { log('response'); listener({ ...connected }); return limited(); },
    async signIn() { return connected; },
    async disconnect() {},
    cancelSignIn() {},
  };
}
