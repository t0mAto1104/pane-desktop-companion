import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { VoiceLanguage } from '../voice';
import { UserError } from './native';

const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const header = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$request = ConvertFrom-Json ([Console]::In.ReadToEnd())
`;

const recognize = header + String.raw`
$voices = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$language = $request.language
$provider = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $language } | Select-Object -First 1
if (-not $provider) { [Console]::Write('{"error":"language"}'); exit 0 }
$engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($provider)
try {
    $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
    $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)
    $engine.BabbleTimeout = [TimeSpan]::FromSeconds(5)
    $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(750)
    try { $engine.SetInputToDefaultAudioDevice() } catch { [Console]::Write('{"error":"device"}'); exit 0 }
    $recognized = $engine.Recognize([TimeSpan]::FromSeconds(11))
    [Console]::Write((ConvertTo-Json -Compress @{text=$recognized.Text}))
} finally { $engine.Dispose() }
`;

const synthesize = header + String.raw`
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $match = $speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $request.language
    } | Select-Object -First 1
    if ($match) { $speaker.SelectVoice($match.VoiceInfo.Name) }
    $speaker.Speak([string]$request.text)
    [Console]::Write('{}')
} finally { $speaker.Dispose() }
`;

function speechProcess(script: string, data: unknown, signal: AbortSignal, timeout: number): Promise<{ text?: string; error?: string }> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Scripts are fixed app resources. Dictation and reply data never become PowerShell code.
    const child = execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024, signal, timeout }, (error, output) => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (error) { reject(new UserError('Windows 语音服务不可用、超时或未获系统权限。')); return; }
      try { resolve(JSON.parse(output)); }
      catch { reject(new UserError('Windows 无法返回语音结果。')); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(data), 'utf8');
  });
}

export async function listenOnWindows(language: VoiceLanguage, signal: AbortSignal): Promise<string> {
  const data = await speechProcess(recognize, { language }, signal, 14_000);
  if (data.error === 'language') throw new UserError('Windows 未安装此听写语言。请在 Windows 语言设置中添加语音包。');
  if (data.error === 'device') throw new UserError('无法使用默认麦克风。请检查 Windows 麦克风权限和输入设备。');
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) throw new UserError('没有识别到语音。请靠近麦克风重试。');
  return text.slice(0, 2000);
}

export async function speakOnWindows(text: string, signal: AbortSignal) {
  const speech = text.replace(/```[\s\S]*?```/g, ' ').replace(/\[(.*?)\]\([^)]+\)/g, '$1').replace(/[#*_~`]/g, '').trim();
  if (!speech) throw new UserError('这条回答没有可朗读的正文。');
  await speechProcess(synthesize, { language: /\p{Script=Han}/u.test(speech) ? 'zh' : 'en', text: Array.from(speech).slice(0, 4000).join('') }, signal, 90_000);
}
