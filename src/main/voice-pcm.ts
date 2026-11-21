export const microphoneRate = 16_000;
const fullScale = 32768;
const windowBytes = (microphoneRate / 10) * 2;

export function pcmLevel(pcm: Buffer): number {
  let squares = 0;
  const count = Math.floor(pcm.length / 2);
  for (let offset = 0; offset < count * 2; offset += 2) {
    squares += pcm.readInt16LE(offset) ** 2;
  }
  return count ? Math.sqrt(squares / count) / fullScale : 0;
}

export function meterValue(level: number): number {
  if (!level) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 60));
}

export function inspectMicClip(pcm: Buffer) {
  if (pcm.length < microphoneRate * 2 * 0.25 || pcm.length % 2 !== 0) return { state: 'short' } as const;
  let level = 0;
  for (let offset = 0; offset < pcm.length; offset += windowBytes) {
    level = Math.max(level, pcmLevel(pcm.subarray(offset, offset + windowBytes)));
  }
  if (level < 0.0005) return { state: 'silent' } as const;
  if (level < 0.003) return { state: 'quiet' } as const;
  return { state: 'audible', level } as const;
}

// Auto language detection applies to one decode. Long pauses let two separately
// spoken languages be detected independently without splitting words mid-phrase.
export function splitMicAtPauses(pcm: Buffer): Buffer[] {
  const clips: Buffer[] = [];
  let start = 0;
  let quietSince = -1;
  let hasSpeech = false;
  for (let offset = 0; offset < pcm.length && clips.length < 2; offset += windowBytes) {
    if (pcmLevel(pcm.subarray(offset, offset + windowBytes)) < 0.005) {
      if (quietSince < 0) quietSince = offset;
      continue;
    }
    if (hasSpeech && quietSince >= 0 && offset - quietSince >= 9 * windowBytes &&
        quietSince - start >= 6 * windowBytes && pcm.length - offset >= 6 * windowBytes) {
      const split = quietSince + 4 * windowBytes;
      clips.push(pcm.subarray(start, split));
      start = split;
    }
    quietSince = -1;
    hasSpeech = true;
  }
  return [...clips, pcm.subarray(start)];
}

export function microphoneWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(microphoneRate, 24);
  header.writeUInt32LE(microphoneRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
