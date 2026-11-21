import OpenAI from 'openai';
import { ChatGPTError } from '../../vendor/siwc/src/errors';
import { UserError } from './native';

export function requestLimit(error: unknown): 'quota' | 'subscription' | 'temporary' | undefined {
  if (!(error instanceof ChatGPTError || error instanceof OpenAI.APIError)) return;
  if (error.code === 'subscription_sharing_usage_limit_exceeded') return 'subscription';
  if (error.code === 'insufficient_quota' || error.code === 'organization_usage_limit_exceeded' ||
      error.code === 'billing_hard_limit_reached') return 'quota';
  if (error.status === 429 || error.code === 'rate_limit_exceeded' || error.code === 'slow_down') return 'temporary';
}

function retryDelay(error: unknown, now: number): number {
  const header = error instanceof ChatGPTError ? error.retryAfter
    : error instanceof OpenAI.APIError ? error.headers?.get('retry-after') : undefined;
  if (!header) return 0;
  const value = header.trim();
  const milliseconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000
    : /GMT$/i.test(value) ? Date.parse(value) - now : 0;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < Number.MAX_SAFE_INTEGER - now
    ? milliseconds : 0;
}

type Wait = { until: number; attempts: number };

export class RateLimitGate {
  private readonly waiting = new Map<string, Wait>();

  constructor(private readonly now = () => Date.now()) {}

  clear(key: string) { this.waiting.delete(key); }

  check(key: string) {
    const remaining = (this.waiting.get(key)?.until ?? 0) - this.now();
    if (remaining > 0) throw new UserError('请求过于频繁，请等待约 ' + Math.ceil(remaining / 1000) + ' 秒后再重试。');
  }

  async run<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.check(key);
    const previous = this.waiting.get(key);
    try {
      const result = await operation();
      signal?.throwIfAborted();
      if (this.waiting.get(key) === previous) this.clear(key);
      return result;
    } catch (error) {
      if (!signal?.aborted && requestLimit(error) === 'temporary') {
        const current = this.waiting.get(key);
        const attempts = Math.min((current?.attempts ?? 0) + 1, 5);
        const now = this.now();
        const delay = Math.max(15_000 * 2 ** (attempts - 1), retryDelay(error, now));
        this.waiting.set(key, { attempts, until: Math.max(current?.until ?? 0, now + delay) });
        this.check(key);
      }
      throw error;
    }
  }
}
