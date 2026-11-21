import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';

const supplied = process.argv[2];
if (!supplied) throw new Error('Usage: node tests/whisper-desktop.mjs FULL_PATH_TO_ggml-small-q5_1.bin');
const temp = resolve(tmpdir());
const directory = await mkdtemp(join(temp, 'pane-whisper-中文-'));
const model = join(directory, 'ggml-small-q5_1.bin');
const executable = resolve('native/bin/whisper/whisper-cli.exe');
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$stream = [IO.MemoryStream]::new()
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $request.language
    } | Select-Object -First 1
    if (!$voice) { throw "Install a Windows synthesis voice for $($request.language)." }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToAudioStream($stream, $format)
    $speaker.Speak([string]$request.text)
    $speaker.SetOutputToNull()
    [Console]::Write([Convert]::ToBase64String($stream.ToArray()))
} finally { $speaker.Dispose(); $stream.Dispose() }
`;

function synthetic(language, text) {
  return new Promise((resolvePcm, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15_000 }, (error, output) => {
      if (error) reject(error);
      else resolvePcm(Buffer.from(output, 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ language, text }), 'utf8');
  });
}

try {
  await copyFile(supplied, model);
  await build({
    entryPoints: ['src/main/whisper.ts'], bundle: true, platform: 'node', format: 'esm',
    outfile: 'dist/whisper-test/engine.mjs', external: ['electron'],
  });
  const { transcribeWithWhisper } = await import('../dist/whisper-test/engine.mjs');
  const [zh, en] = await Promise.all([
    synthetic('zh', '您好，请帮我解释一下什么是保证金。'),
    synthetic('en', 'Please explain margin requirements.'),
  ]);
  const transcripts = [
    ['zh', zh, [/保[证證]金/]],
    ['en', en, [/margin requirements/i]],
    ['auto', Buffer.concat([zh, Buffer.alloc(20000), en]), [/保[证證]金/, /margin requirements/i]],
  ];
  for (const [language, clip, expected] of transcripts) {
    const started = performance.now();
    const text = await transcribeWithWhisper(executable, model, clip, language, AbortSignal.timeout(60_000));
    for (const term of expected) assert.match(text, term);
    console.log(language, Math.round(performance.now() - started) + ' ms', text);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['ggml-small-q5_1.bin', 'silero-v6.2.0.bin']);
  console.log('Real offline Whisper passed for Mandarin, English and a pause-separated mixed sample. No audio or transcript files created.');
} finally {
  if (dirname(directory) === temp && directory.startsWith(join(temp, 'pane-whisper-中文-'))) {
    await rm(directory, { recursive: true, force: true, maxRetries: 2 });
  }
}
