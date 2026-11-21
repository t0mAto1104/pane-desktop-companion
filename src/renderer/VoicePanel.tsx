import { useEffect, useState } from 'react';
import { Mic, Square, Volume2, X } from 'lucide-react';
import type { VoiceActions, VoiceLanguage, VoiceView } from '../voice';
import './voice.css';

export function VoicePanel() {
  const [view, setView] = useState<VoiceView>({ phase: 'ready', text: '', answer: '' });
  const [language, setLanguage] = useState<VoiceLanguage>('zh');
  const [text, setText] = useState('');
  const [readAloud, setReadAloud] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    document.documentElement.classList.add('voice-surface');
    const off = window.paneVoice.subscribe(setView);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') void window.paneVoice.call('close'); };
    window.addEventListener('keydown', key);
    return () => { off(); window.removeEventListener('keydown', key); };
  }, []);
  useEffect(() => { if (view.text) setText(view.text); }, [view.text]);

  async function call<K extends keyof VoiceActions>(action: K, ...args: Parameters<VoiceActions[K]>) {
    setError('');
    const result = await window.paneVoice.call(action, ...args);
    if (!result.ok) setError(result.error);
  }

  const busy = view.phase !== 'ready';
  const status = { ready: '', listening: '正在听写', sending: '正在生成回答', speaking: '正在朗读' }[view.phase];
  return <section className="voice-panel" aria-label="Pane 语音">
    <header><strong>Pane 语音</strong><button className="button" aria-label="关闭语音" onClick={() => void call('close')}><X size={16} /></button></header>
    <div className="voice-tools">
      <label>听写语言 <select value={language} disabled={busy}
        onChange={event => setLanguage(event.currentTarget.value as VoiceLanguage)}><option value="zh">中文</option><option value="en">English</option></select></label>
      {view.phase === 'listening' || view.phase === 'speaking'
        ? <button className="button" onClick={() => void call('stopAudio')}><Square size={15} />停止</button>
        : <button className="button" disabled={busy} onClick={() => void call('listen', language)}><Mic size={15} />使用麦克风</button>}
    </div>
    <p className="muted">听写在本机完成。确认转写后，再把文字发送给 Pane。</p>
    <textarea aria-label="语音转写文字" value={text} maxLength={2000} disabled={busy} rows={3}
      onChange={event => setText(event.currentTarget.value)} placeholder="转写文字会显示在这里，也可手动修改" />
    <div className="voice-tools">
      <label><input type="checkbox" checked={readAloud} disabled={busy}
        onChange={event => setReadAloud(event.currentTarget.checked)} /> 朗读回答</label>
      <button className="button primary" disabled={busy || !text.trim()} onClick={() => void call('send', text, readAloud)}>发送文字</button>
    </div>
    {status && <p role="status">{status}</p>}
    {(error || view.error) && <p role="alert">{error || view.error}</p>}
    {view.answer && <div className="voice-answer" aria-label="语音回答">{view.answer}</div>}
    {view.answer && !busy && <button className="button voice-repeat" onClick={() => void call('speak')}><Volume2 size={15} />再读一遍</button>}
  </section>;
}
