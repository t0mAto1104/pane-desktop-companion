export type Events = { capture: CaptureState; chat: Update; account: undefined; shown: undefined };
export type Theme = 'system' | 'light' | 'dark';
export type Provider = 'chatgpt' | 'api-key';
export type Settings = { theme: Theme; pinned: boolean; autoCapture: boolean; denied: string[]; provider: Provider; models: Partial<Record<Provider, string>> };
export type Target = { id: string; title: string; executable: string };
export type Screenshot = { id: string; target: Target; image: string };
export type CaptureState = { target: Target | null; bound: boolean; pending: boolean; shot: Screenshot | null; error?: string };
export type Conversation = { id: string; title: string; updatedAt: number };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; imageLabel: string | null; status: 'complete' | 'streaming' | 'stopped' | 'failed'; error: string | null };
export type Run = { id: string; conversationId: string };
export type Update = { type: 'delta'; run: Run; text: string } | { type: 'done'; run: Run };
export type Model = { id: string; name: string };
export type Account = { status: 'disconnected' | 'connecting' | 'connected' | 'reauth_required'; sharing: boolean; label?: string; apiKey: boolean };
export type Snapshot = { settings: Settings; conversationId: string | null; capture: CaptureState; run: Run | null; shortcut: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Actions {
  snapshot(): Snapshot;
  'settings:update'(settings: Partial<Pick<Settings, 'theme' | 'pinned' | 'autoCapture' | 'denied' | 'provider'>>): Settings;
  'window:hide'(): void;
  'window:list'(): Promise<Target[]>;
  'capture:bind'(id: string | null): Promise<void>;
  'capture:refresh'(): Promise<void>;
  'capture:remove'(): void;
  'account:state'(): Promise<Account>;
  'account:signIn'(): Promise<Account>;
  'account:cancel'(): void;
  'account:disconnect'(): Promise<Account>;
  'account:usage'(): Promise<void>;
  'account:addKey'(): Promise<Account>;
  'account:removeKey'(): Promise<Account>;
  'account:models'(): Promise<Model[]>;
  'account:selectModel'(id: string): Settings;
  'chat:list'(): Conversation[];
  'chat:open'(id: string): Message[];
  'chat:new'(): Conversation;
  'chat:delete'(id: string): void;
  'chat:send'(id: string, text: string, shotId: string | null): Promise<Run>;
  'chat:retry'(id: string, shotId: string | null): Promise<Run>;
  'chat:stop'(): void;
}

export interface Desktop {
  call<K extends keyof Actions>(name: K, ...args: Parameters<Actions[K]>): Promise<Result<Awaited<ReturnType<Actions[K]>>>>;
  subscribe<K extends keyof Events>(name: K, listener: (state: Events[K]) => void): () => void;
}
declare global {
  interface Window { pane: Desktop }
}
