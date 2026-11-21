import { safeStorage, shell } from 'electron';
import OpenAI from 'openai';
import { join } from 'node:path';
import { CHATGPT_USAGE_URL, ChatGPTError, createChatGPT } from '../../vendor/siwc/src/index';
import type { ResponseInputMessage, SessionState } from '../../vendor/siwc/src/types';
import type { Account, Model, Provider } from '../shared';
import type { Store } from './store';
import { UserError } from './native';
import { INSTRUCTIONS, openaiClient, streamPlatform } from './inference';
import { RateLimitGate, requestLimit } from './rate-limit';

const catalogFreshFor = 300_000;
const keySlot = 'openai-key-encrypted';

export function diagnostic(error: unknown) {
  if (error instanceof UserError) return error.message;
  const limit = requestLimit(error);
  if (limit === 'quota') return 'OpenAI API 额度或支出上限已达到，请检查 API 项目的用量和账单。';
  if (limit === 'subscription') return '已达到 ChatGPT 套餐共享上限，请在 ChatGPT 设置中查看用量。';
  if (limit === 'temporary') return '请求过于频繁，请稍后重试。';
  if (error instanceof ChatGPTError) {
    const known: Record<string, string> = {
      sign_in_required: '请登录 ChatGPT。',
      reauth_required: 'ChatGPT 会话已过期，请重新连接。',
      token_sharing_required: '请在 ChatGPT 授权时允许使用套餐额度。',
      cancelled: '操作已取消。',
      response_incomplete: '回答未完成，可重试。',
      stream_interrupted: '回答流中断，可重试。',
      model_not_available: '该模型对当前账户不可用，请更换模型。',
    };
    return known[error.code] ?? error.message;
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return 'API Key 无效或已撤销。请在设置中更新。';
    if (error.status === 403 || error.status === 404) return '当前账户无权使用此模型，请更换模型。';
    if (error.status === 400) return '模型拒绝了输入。请换用支持图片的模型，或缩短对话。';
    if (error.status && error.status >= 500) return 'OpenAI 服务暂时不可用。请重试。';
    return '无法连接 OpenAI。请检查网络后重试。';
  }
  return '操作未完成。请重试。';
}

export class AI {
  private readonly chatgpt;
  private readonly catalogs = new Map<Provider, { models: Model[]; savedAt: number }>();
  private readonly modelRequests = new Map<Provider, { controller: AbortController; result: Promise<Model[]> }>();
  private readonly limits = new RateLimitGate();
  private lastAccount?: Account;

  constructor(private readonly store: Store, dataDir: string, private readonly updated: (account: Account) => void) {
    this.chatgpt = createChatGPT({
      appName: 'Pane Desktop Companion',
      appId: 'pane-desktop-companion',
      sendHostId: true,
      redirectPort: 8787,
      storageDir: join(dataDir, 'chatgpt'),
      credentialEncryption: {
        id: 'electron-safe-storage-v1',
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: text => safeStorage.encryptString(text),
        decrypt: data => safeStorage.decryptString(Buffer.from(data)),
      },
      async openBrowser(url) {
        const target = new URL(url);
        if (target.origin !== 'https://auth.openai.com') throw new UserError('登录地址验证失败。');
        await shell.openExternal(target.href);
      },
    });
    this.chatgpt.subscribe(session => this.publishAccount(session));
  }

  private accountView(session: SessionState): Account {
    return { status: session.status, sharing: session.sharing, label: session.identity?.email || session.identity?.name, apiKey: !!this.store.read(keySlot) };
  }

  private publishAccount(session: SessionState) {
    const account = this.accountView(session);
    const last = this.lastAccount;
    if (last && last.status === account.status && last.sharing === account.sharing &&
        last.label === account.label && last.apiKey === account.apiKey) return;
    this.lastAccount = account;
    this.updated(account);
  }

  async account(): Promise<Account> {
    return this.accountView(await this.chatgpt.getSession());
  }

  async signIn() {
    const session = await this.chatgpt.getSession();
    const result = await this.limits.run('sign-in', () => this.chatgpt.signIn({ reconsent: session.status === 'connected' && !session.sharing }));
    this.resetProvider('chatgpt');
    if (result.error) throw new ChatGPTError(result.error.code, result.error.message, result.error.retryable, result.error.status);
    return this.account();
  }

  cancelSignIn() { this.chatgpt.cancelSignIn(); }
  async disconnect() { await this.chatgpt.disconnect(); this.resetProvider('chatgpt'); return this.account(); }
  usage() { return shell.openExternal(CHATGPT_USAGE_URL); }

  addKey(key: string) {
    if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key)) throw new UserError('请输入以 sk- 开头的 OpenAI API Key。');
    if (!safeStorage.isEncryptionAvailable()) throw new UserError('Windows 凭据加密不可用。');
    this.store.write(keySlot, safeStorage.encryptString(key).toString('base64'));
    this.resetProvider('api-key');
    return this.account();
  }

  removeKey() {
    this.store.clear(keySlot);
    this.resetProvider('api-key');
    return this.account();
  }

  private key(): string {
    const encrypted = this.store.read<string>(keySlot);
    if (!encrypted) throw new UserError('请先在设置中添加 OpenAI API Key。');
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { throw new UserError('无法读取已保存的 API Key。请重新添加。'); }
  }

  private resetProvider(provider: Provider) {
    this.modelRequests.get(provider)?.controller.abort(new UserError('账户已变更，请重新读取模型。'));
    this.modelRequests.delete(provider);
    this.catalogs.delete(provider);
    this.limits.clear(provider + ':models');
    this.limits.clear(provider + ':response');
  }

  private async loadModels(provider: Provider, signal: AbortSignal): Promise<Model[]> {
    if (provider === 'chatgpt') {
      return (await this.chatgpt.listModels({ signal })).map(model => ({ id: model.slug, name: model.displayName }));
    }
    const listing = await openaiClient(this.key()).models.list({ signal });
    return listing.data.map(model => ({ id: model.id, name: model.id })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async models(provider: Provider, force = false): Promise<Model[]> {
    const cached = this.catalogs.get(provider);
    if (cached && !force && Date.now() - cached.savedAt < catalogFreshFor) return cached.models;
    const pending = this.modelRequests.get(provider);
    if (pending) return pending.result;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const result = this.limits.run(provider + ':models', () => this.loadModels(provider, signal), signal).then(models => {
      controller.signal.throwIfAborted();
      this.catalogs.set(provider, { models, savedAt: Date.now() });
      return models;
    }).finally(() => {
      if (this.modelRequests.get(provider)?.controller === controller) this.modelRequests.delete(provider);
    });
    this.modelRequests.set(provider, { controller, result });
    return result;
  }

  assertResponseReady(provider: Provider) { this.limits.check(provider + ':response'); }

  async stream(provider: Provider, model: string, input: ResponseInputMessage[], signal: AbortSignal, onDelta: (delta: string) => void) {
    return this.limits.run(provider + ':response', async () => {
      if (provider === 'chatgpt') {
        return (await this.chatgpt.streamResponse({ model, input, signal, onDelta, instructions: INSTRUCTIONS })).text;
      }
      return streamPlatform(openaiClient(this.key()), model, input, signal, onDelta);
    }, signal);
  }
}
