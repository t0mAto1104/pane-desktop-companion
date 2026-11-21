import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { VoiceDevice, VoiceLanguage } from '../voice';
import { UserError } from './native';

const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const bytesPerSecond = 16000 * 2;
const maxSpeechBytes = 22050 * 2 * 90;
const helperArgs = (command: string, device = '') => [command, String(process.pid), device];
const header = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
`;

const recognize = header + String.raw`
$voices = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$provider = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $request.language } | Select-Object -First 1
if (-not $provider) { [Console]::Write('{"error":"language"}'); exit 0 }
$engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($provider)
$pcm = [IO.MemoryStream]::new([Convert]::FromBase64String($request.pcm))
try {
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
    $engine.BabbleTimeout = [TimeSpan]::FromSeconds(5)
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(750)
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000,
      [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $engine.SetInputToAudioStream($pcm, $format)
    Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier pane-recognized | Out-Null
    Register-ObjectEvent -InputObject $engine -EventName RecognizeCompleted -SourceIdentifier pane-completed | Out-Null
    $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    $completed = Wait-Event -SourceIdentifier pane-completed -Timeout 13
    if (-not $completed -or $completed.SourceEventArgs.Error) { throw 'Recognition failed' }
    $parts = Get-Event -SourceIdentifier pane-recognized -ErrorAction SilentlyContinue |
        ForEach-Object { $_.SourceEventArgs.Result.Text }
    [Console]::Write((ConvertTo-Json -Compress @{text=($parts -join ' ')}))
} finally { $engine.Dispose(); $pcm.Dispose() }
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

export function captureWindows(executable: string, device: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let child: ReturnType<typeof execFile>;
  const result = new Promise<Buffer>((resolve, reject) => {
    child = execFile(executable, helperArgs('audio-record', device),
      { windowsHide: true, encoding: 'buffer', maxBuffer: bytesPerSecond * 12, signal, timeout: 15_000 }, (error, output) => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(new UserError('无法使用所选麦克风。请检查设备是否连接及 Windows 的麦克风权限。')); return; }
        resolve(output);
      });
    child.stdin?.on('error', () => {});
  });
  return { result, finish: () => { if (child.stdin?.writable) child.stdin.end('s'); } };
}

export async function transcribeWindows(pcm: Buffer, language: VoiceLanguage, signal: AbortSignal): Promise<string> {
  if (pcm.length < bytesPerSecond / 8) throw new UserError('录音过短，请重试。');
  const data = await speechProcess(recognize, { language, pcm: pcm.toString('base64') }, signal, 18_000, 64 * 1024);
  if (data.error === 'language') throw new UserError('Windows 未安装此听写语言。请在 Windows 语言设置中添加语音包。');
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) throw new UserError('没有识别到语音。请靠近麦克风重试。');
  return text.slice(0, 2000);
}

export async function speakOnWindows(executable: string, device: string, text: string, signal: AbortSignal) {
  const speech = text.replace(new RegExp('```[\\s\\S]*?```', 'g'), ' ').replace(/\[(.*?)\]\([^)]+\)/g, '$1').replace(/[#*_~`]/g, '').trim();
  if (!speech) return;
  const data = await speechProcess(synthesize, { language: /\p{Script=Han}/u.test(speech) ? 'zh' : 'en',
    text: Array.from(speech).slice(0, 4000).join('') }, signal, 30_000, maxSpeechBytes * 2);
  const pcm = Buffer.from(data.pcm ?? '', 'base64');
  if (!pcm.length || pcm.length % 2 !== 0) throw new UserError('Windows 无法生成朗读音频。');
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = execFile(executable, helperArgs('audio-play', device),
      { windowsHide: true, signal, timeout: 95_000 }, error => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(new UserError('无法使用所选朗读输出设备。请检查设备是否连接。')); return; }
        resolve();
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(pcm.subarray(0, maxSpeechBytes));
  });
}
