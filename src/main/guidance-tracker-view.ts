import type { Rectangle } from 'electron';
import type { GuidanceState } from '../shared';

export function trackerBounds(workArea: Rectangle): Rectangle {
  const horizontal = Math.min(16, Math.floor(workArea.width / 10));
  const vertical = Math.min(16, Math.floor(workArea.height / 10));
  const width = Math.min(304, workArea.width - horizontal * 2);
  const height = Math.min(174, workArea.height - vertical * 2);
  return { x: workArea.x + workArea.width - width - horizontal, y: workArea.y + vertical, width, height };
}

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export function trackerDocument(state: GuidanceState) {
  const step = state.steps[state.index];
  if (state.mode !== 'active' || !step) return null;
  const done = state.steps.filter(item => item.status === 'completed' || item.status === 'skipped').length;
  const status = step.status === 'completed' || step.status === 'skipped' ? '可以进入下一步'
    : step.status === 'blocked' ? '请检查并手动确认' : '进行中';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <title>Pane 指导任务栏</title>
    <style>
      *{box-sizing:border-box}
      html,body{margin:0;height:100%;overflow:hidden;background:transparent}
      body{padding:3px;font:13px/1.4 "Segoe UI Variable","Microsoft YaHei UI",sans-serif;color:#f1f0f8;user-select:none}
      main{max-height:100%;padding:10px 12px;background:#1a1922ec;border:1px solid #9383e676;border-radius:11px;border-left:3px solid #a795ff;overflow:hidden}
      header{display:flex;align-items:center;gap:9px;color:#c4bce6;font-size:11px}
      header span:first-child,footer{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      header span:last-child{margin-left:auto;flex:none;font-variant-numeric:tabular-nums}
      progress{display:block;width:100%;height:3px;margin:6px 0 7px;border:0;accent-color:#ac9eff}
      h1{font-size:15px;line-height:1.25;margin:0 0 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      p{color:#e1deeb;margin:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
      footer{margin-top:5px;color:#c4bce6;font-size:11px}
    </style>
    <main aria-label="指导任务栏">
      <header><span>${escape(state.title)}</span><span>第 ${state.index + 1} / ${state.steps.length} 步</span></header>
      <progress aria-label="指导进度" max="${state.steps.length}" value="${done}"></progress>
      <h1>${escape(step.title)}</h1><p>${escape(step.explanation)}</p>
      <footer>${status} · ${escape(step.expectedState)}</footer>
    </main></html>`;
}
