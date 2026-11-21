import type { Run, Update } from '../shared';
import type { VoiceSettings, VoiceState } from '../voice';
import { UserError } from './native';
import { captureWindows, listWindowsAudio, playWindowsAudio, speakOnWindows } from './voice-device';
import { inspectMicClip } from './voice-pcm';
import { transcribeWithWhisper } from './whisper';

type Reply = { text: string; status: string };

export class VoiceManager {
  private audio?: AbortController;
  private recording?: ReturnType<typeof captureWindows>;
  private pendingReply?: { run: Run; output: string };
  private revision = 0;
  private playing = false;

  constructor(
    private readonly executable: string,
    private readonly whisper: string,
    private readonly requireModel: () => Promise<string>,
    private readonly publish: (state: VoiceState) => void,
    private readonly canPlay: (run: Run) => boolean,
    private readonly readReply: (run: Run) => Reply | undefined,
  ) {}

  get generation() { return this.revision; }
  get busy() { return !!this.audio; }

  list() {
    return listWindowsAudio(this.executable, AbortSignal.timeout(5000));
  }

  start(settings: VoiceSettings) { return this.record(settings, false); }

  testMicrophone(settings: VoiceSettings) { return this.record(settings, true); }

  private async record(settings: VoiceSettings, testing: boolean): Promise<string> {
    if (this.audio) throw new UserError('请先结束当前语音操作。');
    const operation = new AbortController();
    this.audio = operation;
    this.publish({ phase: 'starting', testing });
    let stopTest: ReturnType<typeof setTimeout> | undefined;
    try {
      const model = testing ? '' : await this.requireModel();
      operation.signal.throwIfAborted();
      this.recording = captureWindows(this.executable, settings.voiceInputId, operation.signal, level => {
        if (this.audio !== operation) return;
        this.publish({ phase: 'recording', testing, level });
        if (testing && !stopTest) stopTest = setTimeout(() => {
          if (this.audio === operation) this.recording?.finish();
        }, 4500);
      });
      const pcm = await this.recording.result;
      operation.signal.throwIfAborted();
      this.recording = undefined;
      clearTimeout(stopTest);
      const clip = inspectMicClip(pcm);
      if (clip.state === 'short') throw new UserError('录音太短。看到「可以说话」后再说，结束时稍等片刻。');
      if (clip.state === 'silent') throw new UserError('麦克风几乎没有输入信号。请检查静音键，或在语音设置里换一个麦克风。');
      if (testing) {
        this.publish({ phase: 'previewing', testing });
        await playWindowsAudio(this.executable, settings.voiceOutputId, pcm, operation.signal, true);
        return clip.state === 'quiet' ? '录音音量偏低。请提高麦克风输入音量，或靠近麦克风再试。' : '试录回放完成。';
      }
      if (clip.state === 'quiet') throw new UserError('录音音量过低。请提高麦克风输入音量，也可以先在语音设置试录回放。');
      this.publish({ phase: 'transcribing' });
      const text = await transcribeWithWhisper(this.whisper, model, pcm, settings.voiceLanguage, operation.signal);
      operation.signal.throwIfAborted();
      return text;
    } catch (error) {
      if (operation.signal.aborted) return '';
      throw error;
    } finally {
      clearTimeout(stopTest);
      this.finishOperation(operation);
    }
  }

  stopRecording() { this.recording?.finish(); }

  cancelDictation() {
    if (this.audio && !this.playing) this.cancel();
  }

  cancel() {
    this.revision++;
    this.pendingReply = undefined;
    const operation = this.audio;
    if (operation) {
      operation.abort();
      this.finishOperation(operation);
    }
  }

  track(run: Run, settings: VoiceSettings, generation: number) {
    if (generation !== this.revision || !settings.voiceReadReplies || !this.canPlay(run)) return;
    this.pendingReply = { run, output: settings.voiceOutputId };
    if (this.readReply(run)?.status !== 'streaming') this.complete(run);
  }

  onChat(update: Update) {
    if (update.type === 'done' && this.pendingReply?.run.id === update.run.id) this.complete(update.run);
  }

  private complete(run: Run) {
    const pending = this.pendingReply;
    this.pendingReply = undefined;
    const reply = this.readReply(run);
    if (!pending || !reply?.text || reply.status !== 'complete' || this.busy || !this.canPlay(run)) return;
    const operation = new AbortController();
    this.audio = operation;
    this.playing = true;
    this.publish({ phase: 'speaking' });
    void speakOnWindows(this.executable, pending.output, reply.text, operation.signal).then(
      () => this.finishOperation(operation),
      error => this.finishOperation(operation, error instanceof UserError ? error.message : 'Windows 无法朗读回答。'),
    );
  }

  private finishOperation(operation: AbortController, error?: string) {
    if (this.audio !== operation) return;
    this.recording = undefined;
    this.playing = false;
    this.audio = undefined;
    this.publish({ phase: 'ready', error });
  }
}
