import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import type { VoiceDevice } from '../voice';
import { meterValue, microphoneRate, pcmLevel } from './voice-pcm';
import { UserError } from './native';

const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const captureLimit = microphoneRate * 2 * 24;
const maxSpeechBytes = 22050 * 2 * 90;
const helperArgs = (command: string, device = '') => [command, String(process.pid), device];
const header = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
`;

const synthesize = header + String.raw`
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$pcm = [IO.MemoryStream]::new()
try {
    $match = $speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $request.language
    } | Select-Object -First 1
    if ($match) { $speaker.SelectVoice($match.VoiceInfo.Name) }
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(22050,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToAudioStream($pcm, $format)
    $speaker.Speak([string]$request.text)
    $speaker.SetOutputToNull()
    [Console]::Write((ConvertTo-Json -Compress @{pcm=[Convert]::ToBase64String($pcm.ToArray())}))
} finally { $speaker.Dispose(); $pcm.Dispose() }
`;

function speechProcess(script: string, data: unknown, signal: AbortSignal, timeout: number, maxBuffer: number) {
  signal.throwIfAborted();
  return new Promise<{ text?: string; pcm?: string; error?: string }>((resolve, reject) => {
    // Only fixed scripts reach the command line. Audio and transcript data travel through stdin.
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', maxBuffer, signal, timeout }, (error, output) => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (error) { reject(new UserError('Windows 语音服务不可用或超时。')); return; }
      try { resolve(JSON.parse(output)); }
      catch { reject(new UserError('Windows 无法返回语音结果。')); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(data), 'utf8');
  });
}

export function listWindowsAudio(executable: string, signal: AbortSignal): Promise<VoiceDevice[]> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(executable, helperArgs('audio-list'),
      { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, signal }, (error, output) => {
        if (signal.aborted) { reject(signal.reason); return; }
        try {
          if (error) throw error;
          const devices: unknown = JSON.parse(output);
          if (!Array.isArray(devices)) throw new Error('Invalid device list');
          resolve(devices.filter((device): device is VoiceDevice => !!device &&
            (device.kind === 'input' || device.kind === 'output') &&
            typeof device.id === 'string' && device.id.length > 0 && device.id.length <= 512 &&
            typeof device.label === 'string' && device.label.length > 0));
        } catch {
          reject(new UserError('无法读取 Windows 音频设备。'));
        }
      });
  });
}

export function captureWindows(executable: string, device: string, signal: AbortSignal, onMeter: (level: number) => void) {
  signal.throwIfAborted();
  const child = spawn(executable, helperArgs('audio-record', device), { windowsHide: true, signal });
  const result = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let lastMeter = 0;
    let lastSampleByte: Buffer | undefined;
    const waiting = setTimeout(() => { child.kill(); }, 5000);
    const deadline = setTimeout(() => { child.kill(); }, 29_000);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('error', () => {}); // Every spawn failure also reports a close event.
    child.stdout.on('data', (data: Buffer) => {
      if (bytes + data.length > captureLimit) { child.kill(); return; }
      chunks.push(data);
      bytes += data.length;
      clearTimeout(waiting);
      const aligned = lastSampleByte ? Buffer.concat([lastSampleByte, data]) : data;
      const end = aligned.length - (aligned.length % 2);
      lastSampleByte = end < aligned.length ? aligned.subarray(end) : undefined;
      const now = Date.now();
      if (now - lastMeter < 90) return;
      lastMeter = now;
      onMeter(meterValue(pcmLevel(aligned.subarray(0, end))));
    });
    child.on('close', code => {
      clearTimeout(waiting);
      clearTimeout(deadline);
      if (signal.aborted) reject(signal.reason);
      else if (code !== 0 || !bytes) reject(new UserError('无法从所选麦克风读取音频。请检查连接、输入设备和 Windows 麦克风权限。'));
      else resolve(Buffer.concat(chunks, bytes));
    });
  });
  return { result, finish: () => { if (child.stdin.writable && !child.stdin.writableEnded) child.stdin.end('s'); } };
}

export async function speakOnWindows(executable: string, device: string, text: string, signal: AbortSignal) {
  const speech = text.replace(new RegExp('```[\\s\\S]*?```', 'g'), ' ').replace(/\[(.*?)\]\([^)]+\)/g, '$1').replace(/[#*_~`]/g, '').trim();
  if (!speech) return;
  const data = await speechProcess(synthesize, { language: /\p{Script=Han}/u.test(speech) ? 'zh' : 'en',
    text: Array.from(speech).slice(0, 4000).join('') }, signal, 30_000, maxSpeechBytes * 2);
  const pcm = Buffer.from(data.pcm ?? '', 'base64');
  if (!pcm.length || pcm.length % 2 !== 0) throw new UserError('Windows 无法生成朗读音频。');
  await playWindowsAudio(executable, device, pcm.subarray(0, maxSpeechBytes), signal);
}

export async function playWindowsAudio(executable: string, device: string, pcm: Buffer, signal: AbortSignal, microphonePreview = false) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = execFile(executable, helperArgs(microphonePreview ? 'audio-preview' : 'audio-play', device),
      { windowsHide: true, signal, timeout: 95_000 }, error => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(new UserError('无法使用所选朗读输出设备。请检查设备是否连接。')); return; }
        resolve();
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(pcm);
  });
}
