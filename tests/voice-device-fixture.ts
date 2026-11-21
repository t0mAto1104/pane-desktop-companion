import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { VoiceDevice, VoiceLanguage } from '../src/voice';

function log(event: string) {
  appendFileSync(process.env.PANE_TEST_VOICE_LOG!, event + '\n');
}

export async function listWindowsAudio(): Promise<VoiceDevice[]> {
  return [{ kind: 'input', id: 'mic-2', label: '测试 USB 麦克风' },
    { kind: 'output', id: 'speaker-2', label: '测试扬声器' }];
}

export function captureWindows(_helper: string, device: string, signal: AbortSignal) {
  log('record:' + device);
  let finish!: () => void;
  const result = new Promise<Buffer>((resolve, reject) => {
    const cancel = () => { log('cancel'); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    finish = () => {
      signal.removeEventListener('abort', cancel);
      resolve(Buffer.from('pcm'));
    };
  });
  return { result, finish };
}

export async function transcribeWindows(_pcm: Buffer, language: VoiceLanguage, signal: AbortSignal) {
  log('transcribe:' + language);
  await setTimeout(40, undefined, { signal });
  return '这是语音转写测试';
}

export async function speakOnWindows(_helper: string, device: string, _text: string, signal: AbortSignal) {
  log('speak:' + device);
  await setTimeout(90, undefined, { signal });
}
