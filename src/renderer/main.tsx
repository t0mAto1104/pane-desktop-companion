import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, ChevronDown, ChevronRight, History, Image, Link2, LoaderCircle, MessageSquare, Minus,
  Monitor, PanelLeft, Pause, Pin, Play, Plus, RefreshCw, ScanLine, Settings2, Square, Trash2, Unlink, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AWARENESS_RANGES, type Account, type Actions, type CaptureState, type Conversation, type Message, type Model,
  type ObservationState, type ObservationUse, type Run, type Screenshot, type Settings, type Target, type VisualSource } from '../shared';
import { GuidePanel } from './GuidePanel';
import './style.css';

async function call<K extends keyof Actions>(name: K, ...args: Parameters<Actions[K]>): Promise<Awaited<ReturnType<Actions[K]>>> {
  const result = await window.pane.call(name, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function Mark() { return <span className="mark"><ScanLine size={17} strokeWidth={1.8} /></span>; }

function IconButton({ title, children, onClick, pressed, disabled }: { title: string; children: React.ReactNode; onClick: () => void; pressed?: boolean; disabled?: boolean }) {
  return <button className={`icon ${pressed ? 'on' : ''}`} title={title} aria-label={title} aria-pressed={pressed} onClick={onClick} disabled={disabled}>{children}</button>;
}

const phaseLabels: Record<ObservationState['phase'], string> = {
  off: '已关闭', unbound: '等待绑定窗口', starting: '正在采样', watching: '正在观察',
  changing: '正在确认变化', paused: '已暂停', stopped: '观察已停止',
};
const observationFields = [
  { key: 'monitoringIntervalMs', title: '采样间隔（毫秒）' },
  { key: 'changeThreshold', title: '变化阈值（比例）' },
  { key: 'maxObservations', title: '保留观察数量' },
] as const;

const visualLabels: Record<VisualSource, string> = {
  manual: '手动截图', observation: '最新屏幕观察', instant: '即时捕获', text: '仅文字',
};
const localTime = (value: number) => new Date(value).toLocaleTimeString('zh-CN');

function App() {
  const [settings, setSettings] = useState<Settings>();
  const [account, setAccount] = useState<Account>();
  const [models, setModels] = useState<Model[]>([]);
  const [modelBusy, setModelBusy] = useState(false);
  const [capture, setCapture] = useState<CaptureState>({ target: null, pending: false, bound: false, shot: null });
  const [observation, setObservation] = useState<ObservationState>({ phase: 'off', target: null, latest: null });
  const [observationUse, setObservationUse] = useState<ObservationUse>('auto');
  const [observedPreview, setObservedPreview] = useState<Screenshot | null>(null);
  const [history, setHistory] = useState<Conversation[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [delta, setDelta] = useState('');
  const [sending, setSending] = useState(false);
  const [sendIssue, setSendIssue] = useState<{ reason: string; retry: boolean } | null>(null);
  const [lastSent, setLastSent] = useState<Run | null>(null);
  const [shortcut, setShortcut] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [overlay, setOverlay] = useState<'settings' | 'windows' | 'preview' | 'observation' | 'delete' | 'guide' | null>(null);
  const [sidebar, setSidebar] = useState(() => window.innerWidth >= 760);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [denyDraft, setDenyDraft] = useState('');
  const [saved, setSaved] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const activeRef = useRef<string | null>(null);
  const providerRef = useRef<Settings['provider']>('chatgpt');
  const latestRun = useRef<Run | null>(null);
  const sendAttempt = useRef<AbortController | null>(null);
  const viewVersion = useRef(0);
  const focusComposer = () => requestAnimationFrame(() => input.current?.focus());

  const apply = useCallback((value: Settings) => { providerRef.current = value.provider; setSettings(value); }, []);
  const fail = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : '操作失败，请重试。'), []);
  const refreshAccount = useCallback(() => call('account:state').then(setAccount).catch(fail), [fail]);
  const refreshHistory = useCallback(() => call('chat:list').then(setHistory).catch(fail), [fail]);

  const openChat = useCallback(async (id: string, resetText = true) => {
    const version = ++viewVersion.current;
    const rows = await call('chat:open', id);
    if (version !== viewVersion.current) return;
    activeRef.current = id;
    setActive(id);
    setMessages(rows);
    if (resetText) { setText(''); setSendIssue(null); }
  }, []);

  useEffect(() => {
    let observed = false;
    const subscriptions = [
      window.pane.subscribe('capture', setCapture),
      window.pane.subscribe('observation', state => { observed = true; setObservation(state); }),
      window.pane.subscribe('shown', () => { setOverlay(value => value === 'guide' ? value : null); focusComposer(); }),
      window.pane.subscribe('account', () => { void refreshAccount(); }),
      window.pane.subscribe('chat', update => {
        setLastSent(update.run);
        if (update.type === 'delta') {
          latestRun.current = update.run;
          setRun(update.run);
          setDelta(update.text);
          return;
        }
        latestRun.current = null;
        setRun(null);
        setDelta('');
        void refreshHistory();
        if (activeRef.current === update.run.conversationId) void openChat(update.run.conversationId, false).catch(fail);
      }),
    ];
    void call('snapshot').then(async state => {
      apply(state.settings);
      setCapture(state.capture);
      if (!observed) setObservation(state.observation);
      setShortcut(state.shortcut);
      setRun(state.run);
      latestRun.current = state.run;
      if (state.run) setLastSent(state.run);
      if (state.conversationId && !viewVersion.current) await openChat(state.conversationId);
    }).catch(fail);
    void refreshHistory();
    void refreshAccount();
    focusComposer();
    return () => subscriptions.forEach(unsubscribe => unsubscribe());
  }, [apply, fail, openChat, refreshAccount, refreshHistory]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => { document.documentElement.dataset.theme = settings?.theme === 'dark' || (settings?.theme !== 'light' && media.matches) ? 'dark' : 'light'; };
    media.addEventListener('change', sync);
    sync();
    return () => media.removeEventListener('change', sync);
  }, [settings?.theme]);

  const provider = settings?.provider ?? 'chatgpt';
  const model = settings?.models[provider] ?? '';
  const connected = provider === 'chatgpt' ? account?.status === 'connected' && account.sharing : !!account?.apiKey;
  const refreshModels = useCallback(async (forProvider: Settings['provider']) => {
    setModelBusy(true);
    try {
      const next = await call('account:models');
      const snapshot = await call('snapshot');
      if (providerRef.current !== forProvider) return;
      setModels(next);
      apply(snapshot.settings);
      if (!next.length) setError('该账户没有返回可选模型。');
    } catch (reason) {
      if (providerRef.current === forProvider) fail(reason);
    } finally {
      if (providerRef.current === forProvider) setModelBusy(false);
    }
  }, [apply, fail]);

  useEffect(() => {
    setModels([]);
    setModelBusy(false);
    if (connected) void refreshModels(provider);
  }, [connected, provider, refreshModels]);

  useEffect(() => {
    const area = scroller.current;
    if (area && area.scrollHeight - area.scrollTop - area.clientHeight < 220) area.scrollTop = area.scrollHeight;
  }, [messages, delta]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [active]);
  useEffect(() => {
    if (overlay) dialog.current?.querySelector('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      if (overlay) { setOverlay(null); focusComposer(); }
      else void call('window:hide').catch(fail);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overlay, fail]);

  const observing = observation.phase === 'starting' || observation.phase === 'watching' || observation.phase === 'changing';
  useEffect(() => {
    if (observedPreview && (overlay !== 'observation' || !observing || observedPreview.target.id !== observation.target?.id)) {
      setObservedPreview(null);
      setOverlay(value => value === 'observation' ? null : value);
    }
  }, [observing, observation.target?.id, observedPreview, overlay]);

  function clearError() { setError(''); setSendIssue(null); setSaved(false); }
  async function change(patch: Parameters<Actions['settings:update']>[0]) {
    clearError();
    try { apply(await call('settings:update', patch)); } catch (reason) { fail(reason); }
  }
  function showSettings() {
    clearError();
    setDenyDraft(settings?.denied.join('\n') ?? '');
    setOverlay('settings');
  }
  async function showWindows() {
    clearError();
    setTargets(null);
    setOverlay('windows');
    try { setTargets(await call('window:list')); }
    catch (reason) { setTargets([]); fail(reason); }
  }
  async function bind(id: string | null) {
    clearError();
    setObservationUse('auto');
    setOverlay(null);
    try { await call('capture:bind', id); focusComposer(); } catch (reason) { fail(reason); }
  }
  async function previewObservation() {
    if (!observation.latest) return;
    clearError();
    try {
      const preview = await call('observation:preview', observation.latest.observationId);
      if (!preview) throw new Error('此观察已过期，请预览当前观察。');
      setObservedPreview(preview);
      setOverlay('observation');
    } catch (reason) { fail(reason); }
  }

  function removeImage() {
    setObservationUse('omit');
    void call('capture:remove').catch(fail);
  }

  async function newChat() {
    clearError();
    try {
      await openChat((await call('chat:new')).id);
      await refreshHistory();
      focusComposer();
    } catch (reason) { fail(reason); }
  }
  async function deleteChat() {
    try {
      await call('chat:delete', deleteId);
      setOverlay(null);
      const remaining = await call('chat:list');
      setHistory(remaining);
      if (activeRef.current !== deleteId) return;
      if (remaining[0]) await openChat(remaining[0].id);
      else {
        activeRef.current = null;
        setActive(null);
        setMessages([]);
        setText('');
      }
    } catch (reason) { fail(reason); }
  }
  async function doAccount(action: 'account:signIn' | 'account:addKey' | 'account:removeKey' | 'account:disconnect') {
    clearError();
    setAccountBusy(true);
    try {
      const next = await call(action);
      setAccount(next);
      if (action === 'account:addKey' && next.apiKey && connected) await refreshModels(provider);
    } catch (reason) { fail(reason); } finally { setAccountBusy(false); }
  }

  async function submit(retry = false, textOnly = false) {
    if (sendAttempt.current || run || (!retry && !text.trim() && (!capture.shot || textOnly))) return;
    if (!connected || !model) { showSettings(); setError('连接账户并选择模型后即可发送。'); return; }
    clearError();
    const attempt = new AbortController();
    sendAttempt.current = attempt;
    setSending(true);
    const question = text;
    const shotId = textOnly ? null : capture.shot?.id ?? null;
    const use = textOnly ? 'omit' : observationUse;
    try {
      let id = activeRef.current;
      if (!id) {
        id = (await call('chat:new')).id;
        await openChat(id, false);
      }
      attempt.signal.throwIfAborted();
      const response = retry
        ? await call('chat:retry', id, shotId, use)
        : await call('chat:send', id, question, shotId, use);
      if (response.kind === 'confirm-text') {
        if (!attempt.signal.aborted) setSendIssue({ reason: response.reason, retry });
        return;
      }
      const started = response.run;
      setLastSent(started);
      if (!retry && !attempt.signal.aborted) setText(current => current === question ? '' : current);
      setObservationUse('auto');
      if ((await call('snapshot')).run?.id === started.id) {
        if (latestRun.current?.id !== started.id) setDelta('');
        latestRun.current = started;
        setRun(started);
      }
      if (activeRef.current === id) await openChat(id, false);
      await refreshHistory();
      requestAnimationFrame(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
    } catch (reason) {
      if (!attempt.signal.aborted) fail(reason);
    } finally {
      sendAttempt.current = null;
      setSending(false);
    }
  }

  function stop() {
    if (sending && !run) {
      sendAttempt.current?.abort();
      setError('已停止准备本轮请求。');
    }
    void call('chat:stop').catch(fail);
  }

  function refreshCapture() {
    clearError();
    void call('capture:refresh').catch(fail);
  }

  const canObserve = settings?.screenAwarenessEnabled && capture.bound && observation.phase !== 'paused';
  const plan = observationUse === 'image' ? (observation.phase === 'watching' ? visualLabels.observation : '等待有效观察截图')
    : capture.shot ? visualLabels.manual
    : observationUse === 'omit' || !canObserve ? visualLabels.text
    : observation.phase === 'watching' ? visualLabels.observation
    : observing ? '发送时即时捕获' : '发送时检查窗口，必要时确认仅文字';
  const receipt = lastSent?.conversationId === active ? lastSent.visual : null;
  const visualError = sendIssue ?? (capture.error ? { reason: capture.error, retry: false } : null);

  const generating = run?.conversationId === active;
  const title = history.find(item => item.id === active)?.title ?? '新对话';
  const activeModel = models.find(item => item.id === model)?.name ?? model;
  return <div className="desktop">
    <header className="titlebar">
      <div className="logo"><Mark /><strong>Pane</strong></div><span className="subtitle">桌面助手</span>
      <div className="title-controls">
        <IconButton title={settings?.pinned ? '取消置顶' : '保持置顶'} pressed={settings?.pinned} onClick={() => void change({ pinned: !settings?.pinned })}><Pin size={15} /></IconButton>
        <span className="divider" />
        <IconButton title="隐藏到托盘" onClick={() => void call('window:hide').catch(fail)}><Minus size={17} /></IconButton>
        <IconButton title="关闭窗口（保留托盘）" onClick={() => void call('window:hide').catch(fail)}><X size={17} /></IconButton>
      </div>
    </header>
    <div className="workspace" inert={!!overlay}>
      {sidebar && <aside className="sidebar">
        <button className="new-chat" onClick={() => void newChat()}><Plus size={17} />新建对话</button>
        <div className="history-label"><History size={14} /> 对话历史</div>
        <nav className="history" aria-label="对话历史">
          {history.map(item => <div key={item.id} className={`history-row ${active === item.id ? 'selected' : ''}`}>
            <button className="history-select" aria-current={active === item.id} title={item.title} onClick={() => { clearError(); void openChat(item.id).catch(fail); }}>
              <MessageSquare size={15} /><span>{item.title}</span>
            </button>
            <IconButton title={`删除对话：${item.title}`} disabled={run?.conversationId === item.id} onClick={() => { setDeleteId(item.id); clearError(); setOverlay('delete'); }}><Trash2 size={13} /></IconButton>
          </div>)}
          {!history.length && <span className="history-empty">还没有对话</span>}
        </nav>
        <button className="settings-trigger" onClick={showSettings}><Settings2 size={17} /><span><strong>设置</strong><small>{connected ? provider === 'chatgpt' ? 'ChatGPT 已连接' : 'API Key 已保存' : '连接与隐私'}</small></span><ChevronRight size={15} /></button>
      </aside>}
      <main>
        <div className="conversation-header">
          <IconButton title={sidebar ? '隐藏侧栏' : '显示侧栏'} pressed={sidebar} onClick={() => setSidebar(!sidebar)}><PanelLeft size={17} /></IconButton>
          <span className="conversation-heading">{title}</span>
          <button className="button guide-launch" onClick={() => { clearError(); setOverlay('guide'); }}>桌面指导</button>
          <button className="model-button" onClick={showSettings} title="配置连接和模型">
            <span className={`status-dot ${connected ? 'online' : ''}`}/><span>{connected && activeModel ? activeModel : '连接模型'}</span><ChevronDown size={14} />
          </button>
        </div>
        <div className="conversation-scroll" ref={scroller}>
          {!messages.length ? <div className="welcome">
            <div className="welcome-art" aria-hidden="true"><ScanLine size={30} strokeWidth={1.55} /></div>
            <h1>聊聊屏幕上的内容</h1>
            <p>切换到任意应用后按 <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd><br />预览窗口截图，随时提问。</p>
            {!connected && <button className="button welcome-connect" onClick={showSettings}>连接 ChatGPT <ChevronRight size={15} /></button>}
          </div> : <div className="message-list" aria-live="polite">
            {messages.map((item, index) => {
              const last = index === messages.length - 1;
              const answer = item.status === 'streaming' && last && generating ? delta || item.text : item.text;
              return item.role === 'user' ? <article key={item.id} className="user-message"><div className="user-bubble">
                {item.imageLabel && <div className="past-shot"><Image size={14} />{item.imageLabel}</div>}{item.text && <div className="user-text">{item.text}</div>}
              </div></article> : <article key={item.id} className="assistant-message"><Mark /><div className="answer">
                <strong>Pane</strong>
                {answer && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span className="link-text">{children}</span> }}>{answer}</Markdown></div>}
                {!answer && item.status === 'streaming' && <div className="waiting"><LoaderCircle className="spin" size={14} /> 正在生成</div>}
                {item.status === 'failed' && <div className="inline-error">{item.error}</div>}
                {item.status === 'stopped' && <div className="waiting">已停止生成</div>}
                {last && !run && item.status !== 'streaming' && <button className="retry" onClick={() => void submit(true)}><RefreshCw size={13} /> 重发上一条</button>}
              </div></article>;
            })}
          </div>}
        </div>
        <div className="composer-shell">
          {!shortcut && <div className="notice" role="alert">Ctrl+Shift+Space 已被占用。可从托盘打开 Pane 并选择窗口。</div>}
          {error && !overlay && <div className="notice" role="alert">{error}<IconButton title="关闭提示" onClick={clearError}><X size={14} /></IconButton></div>}
          {visualError && !overlay && <div className="notice capture-notice" role="alert">
            <span>{visualError.reason}{sendIssue && ' 本轮尚未发送。'}</span>
            <div className="button-row">
              {capture.target && <button className="button" disabled={capture.pending || sending || !!run} onClick={() => { setObservationUse('auto'); refreshCapture(); }}>重新截图</button>}
              {(visualError.retry || text.trim()) && <button className="button" disabled={sending || !!run}
                onClick={() => void submit(visualError.retry, true)}>仅发送文字</button>}
            </div>
          </div>}
          <div className="context-bar">
            <button className={`context-button ${capture.target ? 'target-ready' : ''}`} onClick={() => void showWindows()} title="选择目标窗口">
              {capture.bound ? <Link2 size={15} /> : <Monitor size={15} />}<span>{capture.target?.title ?? '选择窗口'}</span><ChevronDown size={13} />
            </button>
            {capture.target && <><IconButton title="刷新截图" disabled={capture.pending} onClick={refreshCapture}><RefreshCw className={capture.pending ? 'spin' : ''} size={15} /></IconButton>
              {capture.bound && <IconButton title="解除绑定" onClick={() => void bind(null)}><Unlink size={15} /></IconButton>}</>}
            <span className="context-status">{capture.pending ? '正在捕获' : capture.bound ? '已绑定' : capture.target ? '前台窗口' : ''}</span>
            <button className="context-button awareness-switch" role="switch" aria-checked={!!settings?.screenAwarenessEnabled}
              onClick={() => { setObservationUse('auto'); void change({ screenAwarenessEnabled: !settings?.screenAwarenessEnabled }); }}>
              <ScanLine size={14} /><span>屏幕感知</span>
            </button>
          </div>
          {settings?.screenAwarenessEnabled && <div className="observation-bar">
            <div className="observation-description">
              <span className={'status-dot' + (observing ? ' online' : '')} />
              <strong title={observation.target?.title}>{observation.target?.title ?? '请选择要观察的窗口'}</strong>
              <span role="status" className="observation-phase">{phaseLabels[observation.phase]}</span>
              {observation.latest && <time dateTime={new Date(observation.latest.capturedAt).toISOString()} title="最近观察时间">
                {new Date(observation.latest.capturedAt).toLocaleTimeString('zh-CN')} · 变化 {(observation.latest.changeScore * 100).toFixed(1)}%
              </time>}
            </div>
            <div className="observation-actions">
              {observation.latest && <IconButton title="预览最近观察" onClick={() => void previewObservation()}><Image size={15} /></IconButton>}
              {observing && <IconButton title="暂停监控" onClick={() => void call('observation:pause').catch(fail)}><Pause size={15} /></IconButton>}
              {(observation.phase === 'paused' || observation.phase === 'stopped') && <IconButton title="恢复监控" onClick={() => void call('observation:resume').catch(fail)}><Play size={15} /></IconButton>}
            </div>
            {observation.reason && <div className="observation-reason" role="alert">{observation.reason}</div>}
          </div>}
          <div className="composer">
            {capture.shot && <div className="attachment"><button className="attachment-preview" onClick={() => { clearError(); setOverlay('preview'); }} aria-label="预览截图">
              <img src={capture.shot.image} alt="" /><span><strong>手动截图</strong><small>{capture.shot.target.title}</small></span>
            </button><IconButton title="移除截图" onClick={removeImage}><X size={15} /></IconButton></div>}
            <textarea ref={input} value={text} maxLength={20_000} rows={2} placeholder="输入你的问题…" aria-label="输入你的问题"
              onChange={event => setText(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
              }} />
            <div className="composer-footer"><div className="composer-mode">
              <span className="visual-plan">本轮计划 · {plan}</span>
              {(settings?.screenAwarenessEnabled || observationUse === 'image') && <label className="observe-attach">
                <input type="checkbox" disabled={sending} checked={observationUse !== 'omit'}
                  onChange={event => setObservationUse(event.target.checked ? 'auto' : 'omit')} />
                {observationUse === 'image' ? '本条必须附上观察截图' : '发送时使用最新屏幕观察'}</label>}
            </div>
              {run || sending ? <button className="send stop" title={run ? '停止生成' : '停止准备'}
                aria-label={run ? '停止生成' : '停止准备'} onClick={stop}><Square size={13} fill="currentColor" /></button>
                : <button className="send" title="发送" aria-label="发送" disabled={!text.trim() && !capture.shot}
                  onClick={() => void submit()}><ArrowUp size={20} /></button>}
            </div>
          </div>
          {receipt && <div className="sent-visual" role="status">上轮实际来源 · {visualLabels[receipt.source]}
            {receipt.source !== 'text' && <> · {receipt.targetTitle} · {localTime(receipt.capturedAt)}</>}</div>}

          <div className="privacy-note">截图仅在内存中保留 · 发送时提交给 OpenAI</div>
        </div>
      </main>
    </div>
    {overlay && <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) setOverlay(null); }}>
      <section ref={dialog} className={`dialog ${overlay === 'preview' || overlay === 'observation' || overlay === 'guide' ? 'preview-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className="dialog-heading"><h2 id="dialog-title">{{ settings:'设置', windows:'选择目标窗口', preview:'截图预览', observation:'最近观察', delete:'删除对话', guide:'桌面指导' }[overlay]}</h2><IconButton title="关闭弹窗" onClick={() => setOverlay(null)}><X size={18} /></IconButton></div>
        {error && <div className="notice dialog-notice" role="alert">{error}</div>}
        {overlay === 'guide' && <GuidePanel target={capture.bound ? capture.target : null} observation={observation} />}
        {overlay === 'windows' && <div className="dialog-body">
          {!targets && <div className="waiting"><LoaderCircle size={15} className="spin" /> 正在查找窗口</div>}
          {targets?.length === 0 && <p className="muted">当前没有可绑定的窗口。</p>}
          {targets?.map(target => <button className="window-item" key={target.id} onClick={() => void bind(target.id)}>
            <Monitor size={19} /><span><strong>{target.title}</strong><small>{target.executable}</small></span><ChevronRight size={15} />
          </button>)}
        </div>}
        {overlay === 'preview' && (capture.shot ? <div className="dialog-body preview-content">
          <img src={capture.shot.image} alt={capture.shot.target.title} />
          <div className="preview-actions"><span>{capture.shot.target.title}</span><button className="button" onClick={() => { setOverlay(null); removeImage(); }}>取消发送截图</button></div>
        </div> : <p className="muted dialog-body">截图已清除。</p>)}
        {overlay === 'observation' && observedPreview && <div className="dialog-body preview-content">
          <img src={observedPreview.image} alt={observedPreview.target.title} />
          <div className="preview-actions"><span>{observedPreview.target.title}</span><div className="button-row">
            <button className="button" disabled={sending} onClick={() => { setObservationUse('omit'); setOverlay(null); }}>本条不使用观察</button>
            <button className="button primary" disabled={sending} onClick={() => { setObservationUse('image'); setOverlay(null); focusComposer(); }}>本条附上观察截图</button>
          </div></div>
        </div>}
        {overlay === 'delete' && <div className="dialog-body"><p>将从本机删除这段对话及其消息。</p><div className="button-row end"><button className="button" onClick={() => setOverlay(null)}>取消</button><button className="button danger" onClick={() => void deleteChat()}>删除</button></div></div>}
        {overlay === 'settings' && settings && <div className="dialog-body settings-body">
          <section><h3>账户和模型</h3>
            <label className="field">连接方式<select aria-label="连接方式" value={provider} disabled={accountBusy || !!run} onChange={event => void change({ provider: event.target.value as Settings['provider'] })}><option value="chatgpt">ChatGPT 套餐</option><option value="api-key">OpenAI API Key</option></select></label>
            {provider === 'chatgpt' ? <>
              <p className="muted">{account?.sharing ? (account.label ?? 'ChatGPT 已连接') : account?.status === 'reauth_required' ? '会话已过期，请重新连接。' : '在浏览器登录，并允许 Pane 使用符合条件的 ChatGPT 套餐额度。'}</p>
              <div className="button-row">
                {accountBusy ? <button className="button" onClick={() => void call('account:cancel').catch(fail)}>取消登录</button>
                  : account?.sharing ? <button className="button" disabled={!!run} onClick={() => void doAccount('account:disconnect')}>断开连接</button>
                  : <button className="button primary" disabled={!!run} onClick={() => void doAccount('account:signIn')}>{account?.status === 'connected' ? '授权套餐用量' : '使用 ChatGPT 登录'}</button>}
                {account?.sharing && <button className="button" onClick={() => void call('account:usage').catch(fail)}>管理用量</button>}
              </div>
            </> : <>
              <p className="muted">{account?.apiKey ? '已使用 Windows 加密保存 API Key。' : '在 Windows 原生输入框中输入 OpenAI API Key。'}</p>
              <div className="button-row"><button className="button primary" disabled={accountBusy || !!run} onClick={() => void doAccount('account:addKey')}>{account?.apiKey ? '更新 API Key' : '添加 API Key'}</button>
                {account?.apiKey && <button className="button" disabled={accountBusy || !!run} onClick={() => void doAccount('account:removeKey')}>移除</button>}</div>
            </>}
            {connected && <div className="model-field"><label className="field">模型<select aria-label="模型" value={model} disabled={modelBusy || !models.length} onChange={event => { void call('account:selectModel', event.target.value).then(apply).catch(fail); }}>
              <option value="">{modelBusy ? '正在读取模型…' : '选择模型'}</option>{model && !models.some(item => item.id === model) && <option value={model}>{model}</option>}{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label><IconButton title="刷新模型" disabled={modelBusy} onClick={() => { clearError(); void refreshModels(provider); }}><RefreshCw size={16} className={modelBusy ? 'spin' : ''} /></IconButton></div>}
          </section>
          <section><h3>窗口与外观</h3>
            <label className="field">主题<select aria-label="主题" value={settings.theme} onChange={event => void change({ theme: event.target.value as Settings['theme'] })}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label className="check-field"><input type="checkbox" checked={settings.pinned} onChange={event => void change({ pinned: event.target.checked })} /> 聊天窗口保持置顶</label>
            <label className="check-field"><input type="checkbox" checked={settings.autoCapture} onChange={event => void change({ autoCapture: event.target.checked })} /> 快捷键唤出时捕获目标窗口</label>
          </section>
          <section><h3>屏幕感知</h3>
            <label className="check-field"><input type="checkbox" checked={settings.screenAwarenessEnabled}
              onChange={event => { setObservationUse('auto'); void change({ screenAwarenessEnabled: event.target.checked }); }} /> 观察用户绑定的窗口</label>
            <p className="muted">在本机检测画面变化。只有发送问题时才使用观察上下文。</p>
            <div className="observation-fields">
              {observationFields.map(({ key, title }) => {
                const { min, max, step } = AWARENESS_RANGES[key];
                return <label className="field" key={key}>{title}
                  <input type="number" min={min} max={max} step={step} key={settings[key]} defaultValue={settings[key]}
                    onBlur={event => { if (event.target.valueAsNumber !== settings[key]) void change({ [key]: event.target.valueAsNumber }); }}
                    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />
                </label>;
              })}
            </div>
          </section>
          <section><h3>禁止捕获的应用</h3>
            <label className="field">每行一个可执行文件名<textarea rows={4} value={denyDraft} onChange={event => { setDenyDraft(event.target.value); setSaved(false); }} placeholder="example.exe" /></label>
            <div className="button-row"><button className="button" onClick={() => { clearError(); void call('settings:update', { denied: denyDraft.split(/\r?\n/).map(item => item.trim()).filter(Boolean) }).then(value => { apply(value); setSaved(true); }).catch(fail); }}>保存名单</button>{saved && <span className="muted" role="status">已保存</span>}</div>
          </section>
        </div>}
      </section>
    </div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
