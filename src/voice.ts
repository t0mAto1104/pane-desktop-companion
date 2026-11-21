import type { Result } from './shared';

export type VoiceLanguage = 'zh' | 'en';
export type VoiceView = {
  phase: 'ready' | 'listening' | 'sending' | 'speaking';
  text: string;
  answer: string;
  error?: string;
};
export interface VoiceActions {
  state(): VoiceView;
  listen(language: VoiceLanguage): Promise<void>;
  stopAudio(): void;
  send(text: string, readAloud: boolean): Promise<void>;
  speak(): Promise<void>;
  close(): void;
}
export interface VoiceBridge {
  call<K extends keyof VoiceActions>(name: K, ...args: Parameters<VoiceActions[K]>): Promise<Result<Awaited<ReturnType<VoiceActions[K]>>>>;
  subscribe(listener: (view: VoiceView) => void): () => void;
}
declare global { interface Window { paneVoice: VoiceBridge } }
