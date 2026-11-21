import { safeStorage, shell } from 'electron';
import OpenAI from 'openai';
import { join } from 'node:path';
import { CHATGPT_USAGE_URL, ChatGPTError, createChatGPT } from '../../vendor/siwc/src/index';
import type { ResponseInputMessage } from '../../vendor/siwc/src/types';
import type { Account, Model, Provider } from '../shared';
import type { Store } from './store';
import { UserError } from './native';
import { INSTRUCTIONS, openaiClient, streamPlatform } from './inference';

const keySlot = 'openai-key-encrypted';

export function diagnostic(error: unknown) {
  if (error instanceof UserError) return error.message;
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
    if (error.status === 429) return 'OpenAI 使用额度不足或请求过于频繁。';
    if (error.status === 400) return '模型拒绝了输入。请换用支持图片的模型，或缩短对话。';
    if (error.status && error.status >= 500) return 'OpenAI 服务暂时不可用。请重试。';
    return '无法连接 OpenAI。请检查网络后重试。';
  }
  return '操作未完成。请重试。';
}

export class AI {
  private readonly chatgpt;
  private readonly catalogs = new Map<Provider, Model[]>();

  constructor(private readonly store: Store, dataDir: string, updated: () => void) {
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
    this.chatgpt.subscribe(updated);
  }

  async account(): Promise<Account> {
    const session = await this.chatgpt.getSession();
    return { status: session.status, sharing: session.sharing, label: session.identity?.email || session.identity?.name, apiKey: !!this.store.read(keySlot) };
  }

  async signIn() {
    const session = await this.chatgpt.getSession();
    const result = await this.chatgpt.signIn({ reconsent: session.status === 'connected' && !session.sharing });
    this.catalogs.delete('chatgpt');
    if (result.error) throw new UserError(result.error.message);
    return this.account();
  }

  cancelSignIn() { this.chatgpt.cancelSignIn(); }
  async disconnect() { await this.chatgpt.disconnect(); this.catalogs.delete('chatgpt'); return this.account(); }
  usage() { return shell.openExternal(CHATGPT_USAGE_URL); }

  addKey(key: string) {
    if (!/^sk-[A-Za-z0-9_-]{12,}$/.test(key)) throw new UserError('请输入以 sk- 开头的 OpenAI API Key。');
    if (!safeStorage.isEncryptionAvailable()) throw new UserError('Windows 凭据加密不可用。');
    this.store.write(keySlot, safeStorage.encryptString(key).toString('base64'));
    this.catalogs.delete('api-key');
    return this.account();
  }

  removeKey() {
    this.store.clear(keySlot);
    this.catalogs.delete('api-key');
    return this.account();
  }

  private key(): string {
    const encrypted = this.store.read<string>(keySlot);
    if (!encrypted) throw new UserError('请先在设置中添加 OpenAI API Key。');
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
    catch { throw new UserError('无法读取已保存的 API Key。请重新添加。'); }
  }

  async models(provider: Provider, force = false): Promise<Model[]> {
    const cached = this.catalogs.get(provider);
    if (cached && !force) return cached;
    const signal = AbortSignal.timeout(15_000);
    let models: Model[];
    if (provider === 'chatgpt') {
      models = (await this.chatgpt.listModels({ signal })).map(model => ({ id: model.slug, name: model.displayName }));
    } else {
      const modelsById = await openaiClient(this.key()).models.list({ signal });
      models = modelsById.data.map(model => ({ id: model.id, name: model.id })).sort((a, b) => a.id.localeCompare(b.id));
    }
    this.catalogs.set(provider, models);
    return models;
  }

  async stream(provider: Provider, model: string, input: ResponseInputMessage[], signal: AbortSignal, onDelta: (delta: string) => void) {
    if (provider === 'chatgpt') {
      return (await this.chatgpt.streamResponse({ model, input, signal, onDelta, instructions: INSTRUCTIONS })).text;
    }
    return streamPlatform(openaiClient(this.key()), model, input, signal, onDelta);
  }
}
