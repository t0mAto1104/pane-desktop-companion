import { clipboard, screen } from 'electron';
import type { Run, Settings, Target, Update } from '../shared';
import { selectionText, type SelectionActions, type SelectionRequest, type SelectionView } from '../selection';
import { sameTarget, UserError } from './native';
import type { SelectionReader } from './selection-reader';
import type { SelectionToolbar } from './selection-toolbar';

const messages = {
  empty: '没有检测到选中文字。可重新选择，或手动复制后导入。',
  unsupported: '该应用没有提供可读取的选区。可手动复制后导入。',
  protected: '该选区受保护。',
  limit: '选区超过 3000 字，请缩小后重试。',
  changed: '选区已变更，请重新选择。',
};

type Dependencies = {
  reader: SelectionReader; toolbar: SelectionToolbar;
  settings: () => Settings; blocked: () => boolean; bound: () => Target | null;
  validate: (target: Target, signal: AbortSignal) => Promise<void>;
  submit: (target: Target, text: string, request: SelectionRequest, signal: AbortSignal) => Promise<Run>;
  answer: (run: Run) => { text: string; error: string | null; done: boolean } | undefined;
  expand: () => void;
};

export class SelectionManager {
  private session?: { target?: Target; view: SelectionView; run?: Run };
  private watcher?: AbortController;
  private query?: AbortController;
  private sending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private lastQuery = 0;

  constructor(private readonly deps: Dependencies) {}

  readonly actions: SelectionActions = {
    state: () => this.require().view,
    import: async () => {
      const session = this.require();
      if (!session.target || !session.view.canImport) throw new UserError('此选区不允许导入剪贴板。');
      await this.deps.validate(session.target, AbortSignal.timeout(1600));
      if (session !== this.session) return;
      const raw = clipboard.readText();
      try {
        const text = selectionText(raw);
        if (!text) throw new Error('剪贴板没有可导入的文本。');
        this.update({ text, notice: undefined });
      } catch (error) { throw new UserError((error as Error).message); }
    },
    submit: request => this.submit(request),
    details: open => { if (typeof open === 'boolean') this.update({ details: open }); },
    expand: () => { this.close(); this.deps.expand(); },
    close: () => this.close(),
  };

  private require() {
    if (!this.session || this.deps.blocked() || !this.deps.settings().selectionEnabled) {
      throw new UserError('划词工具栏已关闭。');
    }
    return this.session;
  }

  private update(patch: Partial<SelectionView>) {
    if (!this.session) return;
    Object.assign(this.session.view, patch);
    this.deps.toolbar.update(this.session.view);
  }

  configure() {
    const props = this.deps.settings();
    if (this.deps.blocked() || !props.selectionEnabled) { this.close(); return; }
    if ((props.selectionAuto || !!this.session) && !this.watcher) {
      const watcher = new AbortController();
      this.watcher = watcher;
      this.deps.reader.watch(watcher.signal, event => this.onEvent(event));
    } else if (!props.selectionAuto && !this.session) {
      this.watcher?.abort();
      this.watcher = undefined;
    }
  }

  private onEvent(event: string) {
    if (this.deps.blocked()) return;
    if (event === 'focus') {
      if (!this.deps.toolbar.focused) this.close();
      return;
    }
    if ((event === 'click' || event === 'drag') && this.deps.toolbar.contains(screen.getCursorScreenPoint())) return;
    if (this.deps.toolbar.focused && event === 'selection') return;
    if (event === 'click') { if (this.session) this.close(); return; }
    if (!this.deps.settings().selectionAuto || (event !== 'drag' && event !== 'selection')) return;
    clearTimeout(this.timer);
    const wait = Math.max(150, 400 - (Date.now() - this.lastQuery));
    this.timer = setTimeout(() => void this.open(false), wait);
  }

  async open(manual: boolean) {
    const d = this.deps;
    const settings = d.settings();
    if (d.blocked() || !settings.selectionEnabled || (!manual && !settings.selectionAuto)) return;
    this.query?.abort();
    const controller = new AbortController();
    this.query = controller;
    this.lastQuery = Date.now();
    try {
      const data = await d.reader.read(settings.denied, controller.signal);
      if (controller.signal.aborted || d.blocked() || this.query !== controller) return;
      const result = data.selection;
      if (result.status !== 'ok' && !manual) { if (!d.toolbar.focused) this.dismissSession(); return; }
      const text = result.status === 'ok' ? selectionText(result.text) : '';
      if (!manual && (!text || result.status !== 'ok' || !result.rectangles.length)) return;
      if (!manual && text === this.session?.view.text && this.session?.target && sameTarget(this.session.target, data.target)) return;
      const bound = d.bound();
      this.sending?.abort();
      this.session = { target: data.target, view: {
        text, source: data.target.executable, notice: result.status === 'ok' ? undefined : messages[result.status],
        canImport: result.status === 'empty' || result.status === 'unsupported',
        canAttach: !!bound && sameTarget(bound, data.target), language: settings.selectionLanguage,
        theme: settings.theme, answer: '', busy: false, conversation: false,
      }};
      if (!await d.toolbar.show(result.status === 'ok' ? result.rectangles : [], this.session.view, manual) &&
          this.query === controller) this.dismissSession();
      this.configure();
    } catch (error) {
      if (controller.signal.aborted || this.query !== controller || !manual) return;
      this.session = { view: { text: '', source: '', notice: error instanceof UserError ? error.message : '无法读取当前选区。',
        canImport: false, canAttach: false, language: settings.selectionLanguage, theme: settings.theme, answer: '', busy: false, conversation: false } };
      await d.toolbar.show([], this.session.view, true);
      this.configure();
    }
  }

  private async submit(request: SelectionRequest) {
    const session = this.require();
    if (!session.target || !session.view.text || session.view.busy || !request ||
        !['ask', 'explain', 'term', 'translate'].includes(request.intent) ||
        !['zh', 'en'].includes(request.language) || typeof request.screen !== 'boolean' ||
        (request.question !== undefined && (typeof request.question !== 'string' || request.question.length > 2000))) {
      throw new UserError('请选择有效的文本和操作。');
    }
    if (request.screen && !session.view.canAttach) throw new UserError('截图授权仅适用于同一绑定窗口。');
    const send = new AbortController();
    this.sending = send;
    this.update({ busy: true, answer: '', notice: undefined });
    try {
      const run = await this.deps.submit(session.target, session.view.text, request, send.signal);
      if (session !== this.session || send.signal.aborted) return;
      session.run = run;
      const response = this.deps.answer(run);
      this.update({ conversation: true, answer: response?.text ?? '', busy: !response?.done });
      if (response?.error) this.update({ busy: false, notice: response.error });
    } catch (error) {
      if (session === this.session) this.update({ busy: false });
      throw error;
    } finally {
      if (this.sending === send) this.sending = undefined;
    }
  }

  onChat(update: Update) {
    if (this.session?.run?.id !== update.run.id) return;
    if (update.type === 'delta') this.update({ answer: update.text });
    else {
      const row = this.deps.answer(update.run);
      this.update({ busy: false, answer: row?.text ?? '', notice: row?.error ?? undefined });
    }
  }

  private dismissSession() {
    this.sending?.abort();
    this.session = undefined;
    this.deps.toolbar.close();
  }

  close() {
    clearTimeout(this.timer);
    this.query?.abort();
    this.dismissSession();
    if (this.deps.blocked() || !this.deps.settings().selectionEnabled || !this.deps.settings().selectionAuto) {
      this.watcher?.abort();
      this.watcher = undefined;
    }
  }
}
