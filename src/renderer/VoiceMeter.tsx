import type { VoiceState } from '../voice';

export function VoiceMeter({ state }: { state: VoiceState }) {
  if (state.phase !== 'recording') return null;
  return <meter className="voice-meter" min={0} max={1} value={state.level ?? 0} aria-label="麦克风输入音量" />;
}
