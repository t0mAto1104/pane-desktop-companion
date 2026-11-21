import { execFile } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { VoiceLanguage } from '../voice';
import { UserError } from './native';
import { microphoneWav, splitMicAtPauses } from './voice-pcm';

const vadModel = 'silero-v6.2.0.bin';

export async function transcribeWithWhisper(executable: string, model: string, pcm: Buffer, language: VoiceLanguage, signal: AbortSignal) {
  signal.throwIfAborted();
  // Relative arguments work with Windows profiles and installation paths containing non-ASCII characters.
  const cwd = dirname(model);
  await copyFile(join(dirname(executable), vadModel), join(cwd, vadModel)).catch(() => {
    throw new UserError('缺少离线语音组件，请重新安装 Pane。');
  });
  signal.throwIfAborted();
  const clips = language === 'auto' ? splitMicAtPauses(pcm) : [pcm];
  const deadline = AbortSignal.timeout(60_000);
  const active = AbortSignal.any([signal, deadline]);
  const threads = Math.max(1, Math.min(6, availableParallelism() - 1));
  // A non-dash output prefix enables the plain stdout segment callback on Windows.
  // With no output-format flag, the CLI never creates an output file.
  const args = ['--model', basename(model), '--file', '-', '--language', language, '--threads', String(threads),
    '--no-gpu', '--no-timestamps', '--no-prints', '--output-file', 'pane', '--vad', '--vad-model', vadModel, '--suppress-nst'];
  if (language === 'zh') args.push('--prompt', '以下是简体中文口语，可能夹杂英文。');
  const parts: string[] = [];
  try {
    for (const clip of clips) {
      active.throwIfAborted();
      const result = await transcribeClip(executable, args, cwd, clip, active);
      if (result) parts.push(result);
    }
  } catch (error) {
    if (deadline.aborted && !signal.aborted) throw new UserError('本地转写超时，请缩短录音后重试。');
    throw error;
  }
  if (!parts.length) throw new UserError('麦克风已录到声音，但没有识别到清晰语音。可在「设置 → 语音」试录回放后再试。');
  return parts.join(' ').slice(0, 2000);
}

function transcribeClip(executable: string, args: string[], cwd: string, pcm: Buffer, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(executable, args,
      { cwd, signal, windowsHide: true, maxBuffer: 128 * 1024, encoding: 'utf8' },
      (error, output) => {
        if (signal.aborted) { reject(signal.reason); return; }
        if (error) { reject(new UserError('离线语音引擎运行失败或超时。请重试，并确认已安装 Windows x64 版 Pane。')); return; }
        resolve(output.trim().replace(/[\r\n]+/g, ' '));
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(microphoneWav(pcm));
  });
}
