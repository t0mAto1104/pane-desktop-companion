import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectMicClip, meterValue, microphoneRate, microphoneWav, pcmLevel, splitMicAtPauses } from '../src/main/voice-pcm';

function samples(durationMs: number, amplitude: number) {
  const bytes = Buffer.alloc(Math.floor(durationMs * microphoneRate / 1000) * 2);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    bytes.writeInt16LE(offset % 4 === 0 ? amplitude : -amplitude, offset);
  }
  return bytes;
}

test('mic diagnostics distinguish short, silent, quiet, and audible input', () => {
  assert.equal(inspectMicClip(samples(200, 1000)).state, 'short');
  assert.equal(inspectMicClip(samples(500, 0)).state, 'silent');
  assert.equal(inspectMicClip(samples(500, 30)).state, 'quiet');
  const clip = Buffer.concat([samples(1900, 0), samples(300, 1400), samples(600, 0)]);
  assert.equal(inspectMicClip(clip).state, 'audible');
  assert.equal(meterValue(0), 0);
  assert.ok(meterValue(pcmLevel(samples(100, 1400))) > meterValue(pcmLevel(samples(100, 35))));
});

test('the Whisper WAV pipe wraps the original samples as 16 kHz mono PCM', () => {
  const pcm = samples(500, 1400);
  const wav = microphoneWav(pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('auto-language clips split at long gaps, preserving samples and short pauses', () => {
  const first = Buffer.concat([samples(700, 1500), samples(300, 0), samples(700, 1700)]);
  assert.equal(splitMicAtPauses(first).length, 1);
  const bilingual = Buffer.concat([first, samples(1400, 0), samples(1100, 1300)]);
  const clips = splitMicAtPauses(bilingual);
  assert.equal(clips.length, 2);
  assert.deepEqual(Buffer.concat(clips), bilingual);
});
