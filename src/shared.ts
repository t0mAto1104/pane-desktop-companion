export type Events = { capture: CaptureState; observation: ObservationState; chat: Update; account: undefined; shown: undefined };
export type Theme = 'system' | 'light' | 'dark';
export type Provider = 'chatgpt' | 'api-key';
export type AwarenessOptions = {
  screenAwarenessEnabled: boolean;
  monitoringIntervalMs: number;
  changeThreshold: number;
  maxObservations: number;
};
export const AWARENESS_RANGES = {
  monitoringIntervalMs: { min: 350, max: 5000, default: 1000, step: 50 },
  changeThreshold: { min: 0.002, max: 0.5, default: 0.015, step: 0.001 },
  maxObservations: { min: 1, max: 8, default: 3, step: 1 },
} as const;

export function awarenessOptions(input: Partial<AwarenessOptions>): AwarenessOptions {
  const clamp = (value: number | undefined, range: { min: number; max: number; default: number }) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(range.min, Math.min(range.max, value)) : range.default;
  return {
    screenAwarenessEnabled: input.screenAwarenessEnabled === true,
    monitoringIntervalMs: Math.round(clamp(input.monitoringIntervalMs, AWARENESS_RANGES.monitoringIntervalMs)),
    changeThreshold: clamp(input.changeThreshold, AWARENESS_RANGES.changeThreshold),
    maxObservations: Math.round(clamp(input.maxObservations, AWARENESS_RANGES.maxObservations)),
  };
}

export type Settings = AwarenessOptions & { theme: Theme; pinned: boolean; autoCapture: boolean; denied: string[]; provider: Provider; models: Partial<Record<Provider, string>> };
export type Target = { id: string; title: string; executable: string };
export type Screenshot = { id: string; target: Target; image: string; capturedAt: number };
export type CaptureState = { target: Target | null; bound: boolean; pending: boolean; shot: Screenshot | null; error?: string };
export type ObservationUse = 'auto' | 'omit' | 'image';
export type ScreenRegion = { x: number; y: number; width: number; height: number };
export type Observation = {
  observationId: string;
  targetId: string;
  capturedAt: number;
  frameHash: string;
  changeScore: number;
  changedRegions: ScreenRegion[];
  screenshotReference: string;
};
export type ObservationState = {
  phase: 'off' | 'unbound' | 'starting' | 'watching' | 'changing' | 'paused' | 'stopped';
  target: Target | null;
  latest: Observation | null;
  reason?: string;
};
export type Conversation = { id: string; title: string; updatedAt: number };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; imageLabel: string | null; status: 'complete' | 'streaming' | 'stopped' | 'failed'; error: string | null };
export type VisualSource = 'manual' | 'observation' | 'instant' | 'text';
export type SentVisual = { source: 'text' } | {
  source: Exclude<VisualSource, 'text'>; screenshotId: string; targetTitle: string; capturedAt: number;
};
export type Run = { id: string; conversationId: string; visual: SentVisual };
export type SendResult = { kind: 'started'; run: Run } | { kind: 'confirm-text'; reason: string };
export type Update = { type: 'delta'; run: Run; text: string } | { type: 'done'; run: Run };
export type Model = { id: string; name: string };
export type Account = { status: 'disconnected' | 'connecting' | 'connected' | 'reauth_required'; sharing: boolean; label?: string; apiKey: boolean };
export type Snapshot = { settings: Settings; conversationId: string | null; capture: CaptureState; observation: ObservationState; run: Run | null; shortcut: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Actions {
  snapshot(): Snapshot;
  'settings:update'(settings: Partial<AwarenessOptions & Pick<Settings, 'theme' | 'pinned' | 'autoCapture' | 'denied' | 'provider'>>): Settings;
  'window:hide'(): void;
  'window:list'(): Promise<Target[]>;
  'capture:bind'(id: string | null): Promise<void>;
  'capture:refresh'(): Promise<void>;
  'capture:remove'(): void;
  'observation:pause'(): void;
  'observation:resume'(): void;
  'observation:preview'(id: string): Screenshot | null;
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
  'chat:send'(id: string, text: string, shotId: string | null, observationUse?: ObservationUse): Promise<SendResult>;
  'chat:retry'(id: string, shotId: string | null, observationUse?: ObservationUse): Promise<SendResult>;
  'chat:stop'(): void;
}

export interface Desktop {
  call<K extends keyof Actions>(name: K, ...args: Parameters<Actions[K]>): Promise<Result<Awaited<ReturnType<Actions[K]>>>>;
  subscribe<K extends keyof Events>(name: K, listener: (state: Events[K]) => void): () => void;
}
declare global {
  interface Window { pane: Desktop }
}
