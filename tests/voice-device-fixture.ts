import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import type { VoiceDevice } from '../src/voice';

function log(event: string) {
  appendFileSync(process.env.PANE_TEST_VOICE_LOG!, event + '\n');
}

export async function listAudio(): Promise<VoiceDevice[]> {
  return [{ kind: 'input', id: 'mic-2', label: '测试 USB 麦克风' },
    { kind: 'output', id: 'speaker-2', label: '测试扬声器' }];
}

export function captureAudio(_helper: string, device: string, signal: AbortSignal, onMeter: (level: number) => void) {
  log('record:' + device);
  let finish!: () => void;
  const result = new Promise<Buffer>((resolve, reject) => {
    void setTimeout(80, undefined, { signal })
      .then(() => onMeter(0.66)).catch(() => {});
    const cancel = () => { log('cancel'); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    finish = () => {
      signal.removeEventListener('abort', cancel);
      const pcm = Buffer.alloc(16_000);
      for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(2048, offset);
      resolve(pcm);
    };
  });
  return { result, finish };
}

export async function playAudio(_helper: string, device: string, _pcm: Buffer, signal: AbortSignal) {
  log('preview:' + device);
  await setTimeout(90, undefined, { signal });
}

export async function speakOnDevice(_helper: string, device: string, _text: string, signal: AbortSignal) {
  log('speak:' + device);
  await setTimeout(90, undefined, { signal });
}
