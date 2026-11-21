import { BrowserWindow, ipcMain, screen } from 'electron';
import { pathToFileURL } from 'node:url';
import type { Run, Target, Update } from '../shared';
import type { VoiceActions, VoiceView } from '../voice';
import { UserError } from './native';
import { ownFrame } from './permission-manager';
import { listenOnWindows, speakOnWindows } from './voice-device';

type Dependencies = {
  html: string; preload: string; blocked: () => boolean; changed: () => void;
  submit: (text: string, target: Target | null, signal: AbortSignal) => Promise<Run>;
  reply: (run: Run) => { text: string; status: string; error: string | null } | undefined;
};

export class VoiceManager {
  private win?: BrowserWindow;
  private audio?: AbortController;
  private preparing?: AbortController;
  private run?: Run;
  private target: Target | null = null;
  private readAloud = false;
  private view: VoiceView = { phase: 'ready', text: '', answer: '' };

  constructor(private readonly deps: Dependencies) {
    const uri = pathToFileURL(deps.html).href + '#voice';
    ipcMain.handle('pane:voice', async (event, name: keyof VoiceActions, args: unknown[]) => {
      const win = this.win;
      if (!win || win.isDestroyed() || !win.isVisible() || deps.blocked() || !ownFrame(event.senderFrame, win.webContents.mainFrame, uri) ||
          !Object.hasOwn(this.actions, name) || !Array.isArray(args)) return { ok: false, error: '语音窗口已关闭。' };
      try {
        const handler = this.actions[name] as (...params: unknown[]) => unknown;
        return { ok: true, value: await handler(...args) };
      } catch (error) {
        return { ok: false, error: error instanceof UserError ? error.message : '语音操作没有完成。' };
      }
    });
  }

  get isOpen() { return !!this.win; }

  async show(target: Target | null) {
    if (this.deps.blocked()) return;
    if (this.win && !this.win.isDestroyed()) { if (this.win.isVisible()) this.win.focus(); return; }
    this.target = target;
    const work = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(396, work.width), height = Math.min(384, work.height);
    const win = new BrowserWindow({
      width, height, x: work.x + work.width - width, y: work.y + work.height - height,
      frame: false, alwaysOnTop: true, show: false, skipTaskbar: true,
      title: 'Pane 语音', webPreferences: { preload: this.deps.preload, sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    this.win = win;
    this.deps.changed();
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('will-attach-webview', e => e.preventDefault());
    win.on('blur', () => setImmediate(() => {
      if (this.win === win && !win.isDestroyed() && !win.isFocused() && this.view.phase === 'listening') this.stopAudio();
    }));
    win.on('closed', () => { if (this.win === win) { this.win = undefined; this.close(); } });
    try {
      await win.loadFile(this.deps.html, { hash: 'voice' });
      if (this.win === win && !this.deps.blocked()) win.show();
    } catch { if (this.win === win) this.close(); }
  }

  private update(update: Partial<VoiceView>) {
    this.view = { ...this.view, ...update };
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('pane:voice:view', this.view);
  }

  private readonly actions: VoiceActions = {
    state: () => this.view,
    listen: async language => {
      if (!this.win?.isFocused() || this.view.phase !== 'ready') throw new UserError('请先打开语音窗口并停止当前操作。');
      if (language !== 'zh' && language !== 'en') throw new UserError('请选择有效的听写语言。');
      const operation = new AbortController();
      this.audio = operation;
      this.update({ phase: 'listening', error: undefined });
      try {
        const text = await listenOnWindows(language, operation.signal);
        if (this.audio === operation) this.update({ text });
      } finally {
        if (this.audio === operation) { this.audio = undefined; this.update({ phase: 'ready' }); }
      }
    },
    stopAudio: () => this.stopAudio(),
    send: async (text, readAloud) => {
      if (this.view.phase !== 'ready' || typeof text !== 'string' || !text.trim() || text.length > 2000 ||
          typeof readAloud !== 'boolean') throw new UserError('请先填写有效的问题或等待当前操作结束。');
      const operation = new AbortController();
      this.preparing = operation;
      this.readAloud = readAloud;
      this.update({ phase: 'sending', answer: '', error: undefined });
      try {
        const run = await this.deps.submit(text.trim(), this.target, operation.signal);
        if (operation.signal.aborted || this.preparing !== operation) return;
        this.run = run;
        const reply = this.deps.reply(run);
        if (reply && reply.status !== 'streaming') this.complete(run);
      } catch (error) {
        if (this.preparing === operation) this.update({ phase: 'ready' });
        throw error;
      } finally { if (this.preparing === operation) this.preparing = undefined; }
    },
    speak: async () => { await this.speak(); },
    close: () => this.close(),
  };

  onChat(event: Update) {
    if (this.run?.id !== event.run.id) return;
    if (event.type === 'delta') this.update({ answer: event.text });
    else this.complete(event.run);
  }

  private complete(run: Run) {
    const reply = this.deps.reply(run);
    this.run = undefined;
    this.update({ phase: 'ready', answer: reply?.text ?? '', error: reply?.error ?? undefined });
    if (this.readAloud && reply?.status === 'complete' && reply.text) void this.speak().catch(error => {
      if (this.win) this.update({ error: error instanceof UserError ? error.message : 'Windows 无法朗读回答。' });
    });
  }

  private async speak() {
    if (!this.win || this.view.phase !== 'ready' || !this.view.answer.trim()) throw new UserError('当前没有可朗读的回答。');
    const operation = new AbortController();
    this.audio = operation;
    this.update({ phase: 'speaking', error: undefined });
    try { await speakOnWindows(this.view.answer, operation.signal); }
    finally { if (this.audio === operation) { this.audio = undefined; this.update({ phase: 'ready' }); } }
  }

  private stopAudio() {
    const operation = this.audio;
    this.audio = undefined;
    operation?.abort(new UserError('已停止语音。'));
    if (operation) this.update({ phase: 'ready' });
  }

  close() {
    const win = this.win;
    this.win = undefined;
    this.stopAudio();
    this.preparing?.abort(new UserError('语音窗口已关闭。'));
    this.preparing = undefined;
    this.run = undefined;
    this.target = null;
    this.view = { phase: 'ready', text: '', answer: '' };
    this.deps.changed();
    if (win && !win.isDestroyed()) {
      win.hide();
      setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
    }
  }
}
