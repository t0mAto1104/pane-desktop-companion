import type { SelectionLanguage } from './selection';

export type SelectionOptions = { selectionEnabled: boolean; selectionAuto: boolean; selectionLanguage: SelectionLanguage };
export function selectionOptions(input: Partial<SelectionOptions>): SelectionOptions {
  return { selectionEnabled: input.selectionEnabled !== false, selectionAuto: input.selectionAuto === true,
    selectionLanguage: input.selectionLanguage === 'en' ? 'en' : 'zh' };
}

export type Events = { interaction: string; capture: CaptureState; observation: ObservationState; chat: Update; guidance: GuidanceState | null; account: Account; shown: WindowSurface; mascot: MascotState; settings: Settings };
export const COMPANION_SKINS = { orbit: '轨道机器人', fox: '灯笼狐', moss: '苔云' } as const;
export type CompanionSkin = keyof typeof COMPANION_SKINS;
export type MascotState = { skin: CompanionSkin; busy: boolean };
export type WindowSurface = { compact: boolean; panel?: 'guide' | 'settings' };
export type CompanionOptions = { companionEnabled: boolean; companionSkin: CompanionSkin };

export function companionOptions(input: Partial<CompanionOptions>): CompanionOptions {
  return {
    companionEnabled: input.companionEnabled !== false,
    companionSkin: typeof input.companionSkin === 'string' && Object.hasOwn(COMPANION_SKINS, input.companionSkin)
      ? input.companionSkin : 'orbit',
  };
}

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

export type Settings = AwarenessOptions & CompanionOptions & SelectionOptions & { theme: Theme; pinned: boolean; autoCapture: boolean; denied: string[]; provider: Provider; models: Partial<Record<Provider, string>> };
export type InputOrigin = 'typed' | 'selected-text' | 'voice' | 'screen';
export interface InteractionContext {
  interactionId: string;
  origin: InputOrigin;
  conversationId: string | null;
  targetId: string | null;
  createdAt: number;
  text?: string;
  selectedText?: string;
  screenshotId?: string;
}
export type Target = { id: string; title: string; executable: string };
export type Screenshot = { id: string; target: Target; image: string; capturedAt: number };
export type CaptureState = { target: Target | null; bound: boolean; pending: boolean; shot: Screenshot | null; error?: string };
export type ObservationUse = 'auto' | 'omit' | 'image';
export type ScreenRegion = { x: number; y: number; width: number; height: number };
export type PixelRect = ScreenRegion;
export type WindowGeometry = { bounds: PixelRect; dpi: number; foreground: boolean };
export type RegionCapture = Screenshot & {
  region: ScreenRegion; pixels: PixelRect; frameSize: { width: number; height: number }; geometry: WindowGeometry;
};
export type UiElement = {
  elementId: string; name: string; automationId: string; controlType: number; role: string;
  boundingRectangle: PixelRect; isEnabled: boolean; isOffscreen: boolean;
  processId: number; parentId: string | null; childrenIds: string[];
};
export type UiInspection = {
  status: 'ready' | 'unavailable'; target: Target; geometry: WindowGeometry;
  elements: UiElement[]; truncated: boolean; reason?: string;
};
export type ElementQuery = { name?: string; automationId?: string; role?: string };
export type UiMatch = { status: 'matched' | 'candidates' | 'missing'; candidates: UiElement[] };
export type LocatedCandidate = {
  id: string; name: string; source: 'uia' | 'vision'; canHighlight: boolean;
  elementId?: string; role?: string; enabled?: boolean; region?: ScreenRegion;
};
export type LocationResult = {
  status: 'verified' | 'ambiguous' | 'visual' | 'unavailable'; candidates: LocatedCandidate[];
  image?: RegionCapture; answer?: string; reason?: string;
};
export type HighlightStyle = 'outline' | 'shade' | 'arrow' | 'number' | 'label' | 'sequence';
export type GuidanceStep = {
  stepId: string; title: string; explanation: string; targetElement: ElementQuery | null;
  expectedState: string; verificationMethod: 'manual' | 'uia-visible'; verifyElement: ElementQuery | null;
  status: 'pending' | 'active' | 'completed' | 'blocked' | 'skipped';
  verification?: 'manual' | 'uia'; reason?: string;
};
export type GuidanceState = { title: string; index: number; mode: 'active' | 'paused' | 'done'; steps: GuidanceStep[] };
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
export type Snapshot = { settings: Settings; conversationId: string | null; capture: CaptureState; observation: ObservationState; run: Run | null; shortcut: boolean; compact: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Actions {
  snapshot(): Snapshot;
  'settings:update'(settings: Partial<AwarenessOptions & CompanionOptions & SelectionOptions & Pick<Settings, 'theme' | 'pinned' | 'autoCapture' | 'denied' | 'provider'>>): Settings;
  'window:hide'(): void;
  'companion:appearance'(): MascotState;
  'companion:toggle'(): Promise<void>;
  'companion:expand'(panel?: WindowSurface['panel']): void;
  'window:list'(): Promise<Target[]>;
  'capture:bind'(id: string | null): Promise<void>;
  'capture:refresh'(): Promise<void>;
  'capture:remove'(): void;
  'observation:pause'(): void;
  'observation:resume'(): void;
  'observation:preview'(id: string): Screenshot | null;
  'guidance:state'(): GuidanceState | null;
  'guidance:open'(): void;
  'guidance:start'(task: string, includeImage: boolean, region?: ScreenRegion): Promise<GuidanceState | null>;
  'guidance:check'(): Promise<GuidanceState | null>;
  'guidance:confirm'(skip?: boolean): GuidanceState | null;
  'guidance:next'(): Promise<GuidanceState | null>;
  'guidance:pause'(pause: boolean): Promise<GuidanceState | null>;
  'guidance:exit'(): void;
  'ui:highlight'(ids: string[], style: HighlightStyle): void;
  'ui:clear'(): void;
  'ui:locate'(query: ElementQuery, allowVision: boolean, region?: ScreenRegion): Promise<LocationResult>;
  'ui:roi'(region: ScreenRegion): Promise<RegionCapture>;
  'ui:changeRoi'(index: number): Promise<RegionCapture>;
  'ui:inspect'(): Promise<UiInspection>;
  'ui:findElement'(query: ElementQuery): Promise<UiMatch>;
  'ui:getElement'(id: string): Promise<{ element: UiElement; geometry: WindowGeometry } | null>;
  'account:state'(): Promise<Account>;
  'account:signIn'(): Promise<Account>;
  'account:cancel'(): void;
  'account:disconnect'(): Promise<Account>;
  'account:usage'(): Promise<void>;
  'account:addKey'(): Promise<Account>;
  'account:removeKey'(): Promise<Account>;
  'account:models'(force?: boolean): Promise<Model[]>;
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
