import type { PixelRect, Result, Target, Theme } from './shared';

export type SelectionLanguage = 'zh' | 'en';
export type SelectionIntent = 'explain' | 'translate' | 'term' | 'ask';
export type SelectionRequest = { intent: SelectionIntent; question?: string; language: SelectionLanguage; screen: boolean };
export type SelectionRead = {
  target: Target;
  selection: { status: 'ok'; text: string; rectangles: PixelRect[] } |
    { status: 'unsupported' | 'empty' | 'protected' | 'limit' | 'changed' };
};
export type SelectionView = {
  text: string; source: string; notice?: string; canImport: boolean; canAttach: boolean; details?: boolean;
  language: SelectionLanguage; theme: Theme; answer: string; busy: boolean; conversation: boolean;
};
export interface SelectionActions {
  state(): SelectionView;
  import(): Promise<void>;
  submit(request: SelectionRequest): Promise<void>;
  details(open: boolean): void;
  expand(): void;
  close(): void;
}
export interface SelectionBridge {
  call<K extends keyof SelectionActions>(action: K, ...args: Parameters<SelectionActions[K]>): Promise<Result<Awaited<ReturnType<SelectionActions[K]>>>>;
  subscribe(listener: (state: SelectionView) => void): () => void;
}
declare global { interface Window { paneSelection: SelectionBridge } }

export function selectionText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (Array.from(value.slice(0, 6001)).length > 3000 || value.length > 6000) throw new Error('选区超过 3000 字，请缩小后重试。');
  return value.trim();
}
