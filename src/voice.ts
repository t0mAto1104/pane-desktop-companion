export type VoiceLanguage = 'zh' | 'en';
export type VoicePhase = 'ready' | 'recording' | 'transcribing' | 'speaking';
export type VoiceState = { phase: VoicePhase; error?: string };
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
    voiceLanguage: input.voiceLanguage === 'en' ? 'en' : 'zh',
    voiceReadReplies: input.voiceReadReplies !== false,
  };
}
