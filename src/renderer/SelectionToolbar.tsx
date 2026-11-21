import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, Languages, MessageSquare, ScanText, Sparkles, X } from 'lucide-react';
import type { SelectionActions, SelectionIntent, SelectionLanguage, SelectionView } from '../selection';
import './selection.css';

export function SelectionToolbar() {
  const [view, setView] = useState<SelectionView>();
  const [question, setQuestion] = useState('');
  const [language, setLanguage] = useState<SelectionLanguage>();
  const [attach, setAttach] = useState(false);
  const [error, setError] = useState('');
  const [fading, setFading] = useState(false);
  const [details, showDetails] = useState<'ask' | 'more' | null>(null);
  const closing = useRef(false);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function fade() {
    if (closing.current) return;
    closing.current = true;
    setFading(true);
    fadeTimer.current = setTimeout(() => void window.paneSelection.call('close'), 210);
  }

  useEffect(() => {
    document.documentElement.classList.add('selection-surface');
    let changed = false;
    const off = window.paneSelection.subscribe(value => { changed = true; setView(value); });
    void window.paneSelection.call('state').then(result => { if (!changed && result.ok) setView(result.value); });
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') fade(); };
    window.addEventListener('keydown', key);
    return () => { off(); window.removeEventListener('keydown', key); clearTimeout(fadeTimer.current); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = view?.theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : view?.theme ?? 'light';
  }, [view?.theme]);
  async function call<K extends keyof SelectionActions>(action: K, ...args: Parameters<SelectionActions[K]>) {
    if (closing.current) return;
    setError('');
    const result = await window.paneSelection.call(action, ...args);
    if (!result.ok) { setError(result.error); await window.paneSelection.call('details', true); }
  }

  const detail = (next: 'ask' | 'more') => { showDetails(next); void call('details', true); };
  const submit = (intent: SelectionIntent) => {
    if (!view?.text) return;
    void call('details', true);
    void call('submit', { intent, question: intent === 'ask' ? question : undefined,
      language: language ?? view.language, screen: attach && view.canAttach });
  };
  if (!view) return null;
  const card = !!(view.details || view.notice || view.answer || error);
  const reveal = () => { if (view.badge) void call('reveal'); };
  return <section className={['selection-toolbar', view.badge ? 'selection-badge' : card ? 'selection-card' : 'selection-mini',
    fading && 'selection-fading'].filter(Boolean).join(' ')} aria-label="Pane 划词"
    onPointerEnter={reveal} onPointerLeave={() => { if (view.automatic && !card && !view.busy) fade(); }}>
    {view.badge ? <button className="selection-symbol" aria-label="划词操作" title="划词操作" onClick={reveal}>
      <Sparkles size={16} /></button> : <>
      {view.text && <div className="selection-actions">
        <button disabled={view.busy} aria-label="翻译" title="翻译" onClick={() => submit('translate')}><Languages size={15} /><span>翻译</span></button>
        <button disabled={view.busy} aria-label="解释" title="解释" onClick={() => submit('explain')}><ScanText size={15} /><span>解释</span></button>
        <button disabled={view.busy} aria-label="问 AI" title="问 AI" onClick={() => detail('ask')}><MessageSquare size={15} /><span>问 AI</span></button>
        <button disabled={view.busy} aria-label="更多划词操作" title="更多" onClick={() => detail('more')}><ChevronDown size={15} /></button>
        {card && <button aria-label="关闭划词" title="关闭" onClick={fade}><X size={15} /></button>}
      </div>}
      {card && <div className="selection-details">
        {view.notice && <p role="status">{view.notice}</p>}
        {error && <p role="alert">{error}</p>}
        {view.canImport && !view.text && <button className="selection-command" onClick={() => void call('import')}>导入剪贴板文本</button>}
        {details && view.text && <div className="selection-options">
          <div className="selection-quote" title={view.text}>{view.text}</div>
          {details === 'ask' && <form onSubmit={event => { event.preventDefault(); if (question.trim()) submit('ask'); }}>
            <label>关于选区的问题<input value={question} maxLength={2000}
              onChange={event => setQuestion(event.currentTarget.value)} autoFocus placeholder="输入你的问题" /></label>
            <button type="submit" disabled={view.busy || !question.trim()}>发送</button>
          </form>}
          {details === 'more' && <><label>翻译成
            <select value={language ?? view.language} onChange={event => setLanguage(event.currentTarget.value as SelectionLanguage)}>
              <option value="zh">简体中文</option><option value="en">英文</option>
            </select></label><button className="selection-command" disabled={view.busy} onClick={() => submit('term')}>解释术语</button></>}
          {view.canAttach && <label><input type="checkbox" checked={attach} onChange={event => setAttach(event.currentTarget.checked)} />同时使用绑定窗口截图</label>}
        </div>}
        {view.busy && !view.answer && <p role="status">正在生成回答…</p>}
        {view.answer && <div className="selection-answer" aria-label="AI 回答">{view.answer}</div>}
        {view.conversation && <button className="selection-command" onClick={() => void call('expand')}><ArrowUpRight size={15} />打开完整对话</button>}
      </div>}
    </>}
  </section>;
}
