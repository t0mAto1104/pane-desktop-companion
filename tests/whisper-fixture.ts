import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { VoiceLanguage } from '../src/voice';

export async function transcribeWithWhisper(_exe: string, _model: string, _pcm: Buffer, language: VoiceLanguage, signal: AbortSignal) {
  appendFileSync(process.env.PANE_TEST_VOICE_LOG!, 'transcribe:' + language + '\n');
  await setTimeout(40, undefined, { signal });
  return '这是语音转写测试';
}
