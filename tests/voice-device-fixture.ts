import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { VoiceLanguage } from '../src/voice';

function log(event: string) {
  appendFileSync(process.env.PANE_TEST_VOICE_LOG!, event + '\n');
}

export async function listenOnWindows(_language: VoiceLanguage, signal: AbortSignal) {
  log('listen');
  try {
    await setTimeout(410, undefined, { signal });
    return '这是语音转写测试';
  } catch (error) {
    log('cancel');
    throw error;
  }
}

export async function speakOnWindows(_text: string, signal: AbortSignal) {
  log('speak');
  await setTimeout(90, undefined, { signal });
}
