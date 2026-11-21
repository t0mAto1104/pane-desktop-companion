import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Actions, ElementQuery, GuidanceState, HighlightStyle, LocationResult, ObservationState, RegionCapture, ScreenRegion, Target } from '../shared';

async function request<K extends keyof Actions>(action: K, ...args: Parameters<Actions[K]>) {
  const reply = await window.pane.call(action, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}
const full = { x: 0, y: 0, width: 1, height: 1 };
const styles: [HighlightStyle, string][] = [
  ['outline', '边框'], ['shade', '半透明'], ['arrow', '箭头'], ['number', '编号'], ['label', '文字'], ['sequence', '顺序'],
];
const statusLabels = { pending: '待开始', active: '进行中', completed: '已完成', blocked: '待确认', skipped: '已跳过' };

const boxStyle = ({ x, y, width, height }: ScreenRegion) => ({
  left: x * 100 + '%', top: y * 100 + '%', width: width * 100 + '%', height: height * 100 + '%',
});

export function GuidePanel({ target, observation }: { target: Target | null; observation: ObservationState }) {
  const [task, setTask] = useState('');
  const [query, setQuery] = useState('');
  const [allowImage, setAllowImage] = useState(false);
  const [state, setState] = useState<GuidanceState | null>(null);
  const [location, setLocation] = useState<LocationResult | null>(null);
  const [image, setImage] = useState<RegionCapture | null>(null);
  const [crop, setCrop] = useState<RegionCapture | null>(null);
  const [selection, setSelection] = useState<ScreenRegion | null>(null);
  const [style, setStyle] = useState<HighlightStyle>('outline');
  const [mutation, setMutation] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(false);
  const operation = useRef(false);
  const generation = useRef(0);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const clear = () => { setLocation(null); setImage(null); setCrop(null); setSelection(null); setNotice(''); };

  useEffect(() => {
    active.current = true;
    const stop = window.pane.subscribe('guidance', value => {
      setState(value);
      if (!value) clear();
    });
    void request('guidance:state').then(value => { if (active.current) setState(value); }).catch(() => {});
    return () => {
      active.current = false;
      generation.current++;
      stop();
      void request('ui:clear').catch(() => {});
    };
  }, []);
  useEffect(() => {
    generation.current++;
    operation.current = false;
    setBusy('');
    setAllowImage(false);
    clear();
  }, [target?.id]);

  async function perform(label: string, work: (isCurrent: () => boolean) => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    const expected = generation.current;
    setBusy(label);
    setNotice('');
    setError('');
    try { await work(() => active.current && expected === generation.current); }
    catch (reason) {
      if (active.current && expected === generation.current) setError(reason instanceof Error ? reason.message : '桌面指导操作失败。');
    } finally {
      if (expected === generation.current) {
        operation.current = false;
        if (active.current) setBusy('');
      }
    }
  }

  function locate(query: ElementQuery) {
    void perform('正在定位控件…', async isCurrent => {
      setAllowImage(false);
      const value = await request('ui:locate', query, allowImage, crop?.region);
      if (isCurrent()) setLocation(value);
    });
  }

  function highlight(ids: string[], variant = style) {
    void perform('正在验证高亮位置…', async isCurrent => {
      await request('ui:highlight', ids, variant);
      if (isCurrent()) setNotice('切换到目标窗口查看高亮。高亮在 16 秒后结束。');
    });
  }

  function point(event: PointerEvent<HTMLElement>) {
    const b = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - b.left) / b.width)),
      y: Math.max(0, Math.min(1, (event.clientY - b.top) / b.height)) };
  }

  function updateRegion(event: PointerEvent<HTMLElement>) {
    const start = origin.current;
    if (!start) return null;
    const end = point(event);
    const region = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
    setSelection(region);
    return region;
  }

  const step = state?.steps[state.index];
  const done = state?.steps.filter(row => row.status === 'completed' || row.status === 'skipped').length ?? 0;
  const changed = observation.latest?.targetId === target?.id ? observation.latest?.changedRegions ?? [] : [];
  const highlightable = location?.candidates.filter(candidate => candidate.canHighlight) ?? [];
  return <div className="dialog-body guide-panel">
    <div className="guide-target"><strong>{target?.title ?? '请先绑定目标窗口'}</strong>
      <span>仅指导 · 由你亲自操作</span></div>
    {error && <div role="alert" className="notice">{error}</div>}
    {notice && <p role="status" className="muted">{notice}</p>}
    {busy && <p role="status" className="muted">{busy}</p>}
    <fieldset disabled={!target || !!busy}>
      <label className="check-field"><input type="checkbox" checked={allowImage} onChange={event => setAllowImage(event.target.checked)} />
        允许本次定位或教学发送所选画面</label>
      <section className="guide-section">
        <h3>局部截图</h3>
        <div className="guide-actions">
          <button className="button" onClick={() => void perform('正在获取窗口预览…', async isCurrent => {
            const value = await request('ui:roi', full);
            if (isCurrent()) { setImage(value); setSelection(null); setCrop(null); }
          })}>打开窗口预览</button>
          {!!changed.length && <><select aria-label="变化区域" value={Math.min(mutation, changed.length - 1)}
            onChange={event => setMutation(Number(event.target.value))}>
            {changed.map((_, index) => <option key={index} value={index}>变化区域 {index + 1}</option>)}
          </select><button className="button" onClick={() => void perform('正在截图…', async isCurrent => {
            const value = await request('ui:changeRoi', Math.min(mutation, changed.length - 1));
            if (isCurrent()) { setCrop(value); setSelection(value.region); }
          })}>截取变化区域</button></>}
          {crop && <button className="button" onClick={() => { setCrop(null); setSelection(null); }}>清除局部区域</button>}
        </div>
        {image && <div className="guide-image selectable" onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          origin.current = point(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={updateRegion} onPointerCancel={() => { origin.current = null; }}
          onPointerUp={event => {
            const region = updateRegion(event);
            origin.current = null;
            if (region && region.width >= .01 && region.height >= .01) void perform('正在截取所选区域…', async isCurrent => {
              const value = await request('ui:roi', region);
              if (isCurrent()) setCrop(value);
            });
          }}>
          <img src={image.image} alt="拖动框选目标窗口截图" draggable={false} />
          {selection && <span className="guide-box" style={boxStyle(selection)} />}
        </div>}
        {crop && <p className="muted">局部已选 · {crop.pixels.width} × {crop.pixels.height} 原始像素</p>}
        {crop && <img className="guide-crop" src={crop.image} alt="原始像素局部截图" />}
      </section>

      <section className="guide-section">
        <h3>定位控件</h3>
        <form className="guide-actions" onSubmit={event => { event.preventDefault(); if (query.trim()) locate({ name: query.trim() }); }}>
          <input aria-label="控件名称" value={query} maxLength={300} placeholder="例如：平仓" onChange={event => setQuery(event.target.value)} />
          <button className="button" disabled={!query.trim()}>定位</button>
          <select aria-label="高亮样式" value={style} onChange={event => setStyle(event.target.value as HighlightStyle)}>
            {styles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </form>
        {location?.reason && <p className="muted">{location.reason}</p>}
        {location?.answer && <p className="guide-answer">{location.answer}</p>}
        {location?.image && <div className="guide-image">
          <img src={location.image.image} alt="模型定位使用的截图" />
          {location.candidates.map((candidate, index) => candidate.region &&
            <span key={candidate.id} className="guide-box estimated" style={boxStyle(candidate.region)}>{index + 1}</span>)}
        </div>}
        {location?.candidates.map((candidate, index) => <div className="guide-candidate" key={candidate.id}>
          <span>{index + 1}. {candidate.name}<small>{candidate.source === 'uia' ? 'UI Automation' : '图像候选'}{candidate.enabled === false ? ' · 已禁用' : ''}</small></span>
          <button className="button" disabled={!candidate.canHighlight} onClick={() => highlight([candidate.id])}>
            {candidate.source === 'vision' ? '确认候选并高亮' : '在窗口中高亮'}</button>
        </div>)}
        {highlightable.length > 1 && <button className="button" onClick={() => highlight(highlightable.map(candidate => candidate.id), 'sequence')}>按顺序高亮</button>}
      </section>

      <section className="guide-section">
        <h3>分步教学</h3>
        {!state && <form onSubmit={event => {
          event.preventDefault();
          if (task.trim()) void perform('正在生成教学步骤…', async isCurrent => {
            setAllowImage(false);
            const value = await request('guidance:start', task, allowImage, crop?.region);
            if (isCurrent()) setState(value);
          });
        }}><label className="field">教学任务<textarea rows={2} maxLength={1600} value={task} onChange={event => setTask(event.target.value)}
          placeholder="例如：指导我在模拟账户中完成一笔模拟交易" /></label>
          <button className="button primary" disabled={!task.trim()}>生成步骤</button></form>}
        {state && step && <>
          <div className="guide-progress"><strong>{state.title}</strong><span>{done} / {state.steps.length}</span></div>
          <progress max={state.steps.length} value={done} aria-label="教学进度" />
          <ol className="guide-steps">{state.steps.map((row, index) =>
            <li key={row.stepId} aria-current={index === state.index ? 'step' : undefined}>{index + 1}. {row.title}<small>{statusLabels[row.status]}</small></li>)}</ol>
          {state.mode === 'done' ? <p role="status">教学已结束。</p> : <>
            <div className="guide-step"><h4>{step.title}</h4><p>{step.explanation}</p>
              <p className="muted">预期结果 · {step.expectedState}</p>
              {step.reason && <p className="muted">{step.reason}</p>}
              {step.verification && <p className="muted">{step.verification === 'uia' ? 'UI Automation 已验证' : '用户已确认'}</p>}
            </div>
            <div className="guide-actions">
              {state.mode === 'active' && <>
                <button className="button" disabled={!step.targetElement} onClick={() => { if (step.targetElement) locate(step.targetElement); }}>重新定位</button>
                {['active', 'blocked'].includes(step.status) && <>
                  <button className="button" onClick={() => void perform('正在检查预期结果…', async isCurrent => {
                    const value = await request('guidance:check');
                    if (isCurrent()) setState(value);
                  })}>检查结果</button>
                  <button className="button" onClick={() => void perform('正在保存确认…', async isCurrent => {
                    const value = await request('guidance:confirm');
                    if (isCurrent()) setState(value);
                  })}>手动确认完成</button>
                  <button className="button" onClick={() => void perform('正在跳过本步…', async isCurrent => {
                    const value = await request('guidance:confirm', true);
                    if (isCurrent()) setState(value);
                  })}>跳过</button>
                </>}
                <button className="button primary" disabled={!['completed', 'skipped'].includes(step.status)}
                  onClick={() => void perform('正在准备下一步…', async isCurrent => {
                    setLocation(null);
                    const value = await request('guidance:next');
                    if (isCurrent()) setState(value);
                  })}>下一步</button>
              </>}
              <button className="button" onClick={() => void perform('正在更新教学状态…', async isCurrent => {
                setLocation(null);
                const value = await request('guidance:pause', state.mode !== 'paused');
                if (isCurrent()) setState(value);
              })}>{state.mode === 'paused' ? '继续教学' : '暂停教学'}</button>
            </div>
          </>}
        </>}
      </section>
    </fieldset>
    {(state || busy) && <button className="button" onClick={() => {
      generation.current++;
      operation.current = false;
      setBusy('');
      setAllowImage(false);
      clear();
      void request('guidance:exit').catch(reason => setError(String(reason)));
    }}>退出教学</button>}
  </div>;
}
