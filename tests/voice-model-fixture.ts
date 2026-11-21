import { setTimeout } from 'node:timers/promises';
import type { VoiceModelState } from '../src/voice';
import { UserError } from '../src/main/native';

export class VoiceModel {
  private view: VoiceModelState = { phase: 'missing' };

  constructor(_directory: string, private readonly publish: (state: VoiceModelState) => void) {}
  async status() { return this.view; }
  async requirePath() {
    if (this.view.phase !== 'ready') throw new UserError('请先在「设置 → 语音」下载离线 Whisper 模型。');
    return 'mock-whisper.bin';
  }

  async install() {
    this.publish(this.view = { phase: 'downloading', progress: 42 });
    await setTimeout(350);
    this.publish(this.view = { phase: 'ready' });
  }

  cancel() {}
}
