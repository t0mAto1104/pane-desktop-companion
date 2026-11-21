import type { Run, Update } from '../shared';
import type { VoiceSettings, VoiceState } from '../voice';
import { UserError } from './native';
import { captureWindows, listWindowsAudio, speakOnWindows, transcribeWindows } from './voice-device';

type Reply = { text: string; status: string };

export class VoiceManager {
  private audio?: AbortController;
  private recording?: ReturnType<typeof captureWindows>;
  private pendingReply?: { run: Run; output: string };
  private revision = 0;
  private playing = false;

  constructor(
    private readonly executable: string,
    private readonly publish: (state: VoiceState) => void,
    private readonly canPlay: (run: Run) => boolean,
    private readonly readReply: (run: Run) => Reply | undefined,
  ) {}

  get generation() { return this.revision; }
  get busy() { return !!this.audio; }

  list() {
    return listWindowsAudio(this.executable, AbortSignal.timeout(5000));
  }

  async start(settings: VoiceSettings) {
    if (this.audio) throw new UserError('请先结束当前语音操作。');
    const operation = new AbortController();
    this.audio = operation;
    this.publish({ phase: 'recording' });
    try {
      this.recording = captureWindows(this.executable, settings.voiceInputId, operation.signal);
      const pcm = await this.recording.result;
      operation.signal.throwIfAborted();
      this.recording = undefined;
      this.publish({ phase: 'transcribing' });
      const text = await transcribeWindows(pcm, settings.voiceLanguage, operation.signal);
      operation.signal.throwIfAborted();
      return text;
    } catch (error) {
      if (operation.signal.aborted) return '';
      throw error;
    } finally { this.finishOperation(operation); }
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
