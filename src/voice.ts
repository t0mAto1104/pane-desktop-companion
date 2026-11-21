export type VoiceLanguage = 'auto' | 'zh' | 'en';
export type VoicePhase = 'ready' | 'starting' | 'recording' | 'transcribing' | 'previewing' | 'speaking';
export type VoiceState = { phase: VoicePhase; testing?: boolean; level?: number; error?: string };
export type VoiceModelState = { phase: 'ready' | 'missing' } | { phase: 'downloading'; progress: number };
export type VoiceDevice = { kind: 'input' | 'output'; id: string; label: string };
export type VoiceSettings = {
  voiceInputId: string;
  voiceOutputId: string;
  voiceLanguage: VoiceLanguage;
  voiceReadReplies: boolean;
};

export function voiceSettings(input: Partial<VoiceSettings>): VoiceSettings {
  const deviceId = (id: unknown) =>
    typeof id === 'string' && id.length <= 512 && !id.includes('\0') ? id : '';
  return {
    voiceInputId: deviceId(input.voiceInputId),
    voiceOutputId: deviceId(input.voiceOutputId),
    voiceLanguage: input.voiceLanguage === 'en' || input.voiceLanguage === 'zh' ? input.voiceLanguage : 'auto',
    voiceReadReplies: input.voiceReadReplies !== false,
  };
}
