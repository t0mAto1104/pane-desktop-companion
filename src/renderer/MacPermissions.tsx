
import { useEffect, useState } from 'react';
import type { Actions, DesktopPermission, DesktopPermissions } from '../shared';

const rows: Array<[DesktopPermission, string, string]> = [
  ['screen', '屏幕与系统音频录制', '窗口截图、屏幕感知和局部截图。Pane 只请求窗口画面。'],
  ['accessibility', '辅助功能', '跨应用划词、控件识别和桌面指导。'],
  ['microphone', '麦克风', '在聊天框中录音和转写。'],
];

export function MacPermissions({ call, onError }: {
  call: <K extends keyof Actions>(name: K, ...args: Parameters<Actions[K]>) => Promise<Awaited<ReturnType<Actions[K]>>>;
  onError: (error: unknown) => void;
}) {
  const [permissions, setPermissions] = useState<DesktopPermissions | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true;
    const refresh = () => void call('permissions:state').then(value => {
      if (current) setPermissions(value);
    }).catch(error => { if (current) onError(error); });
    refresh();
    window.addEventListener('focus', refresh);
    return () => { current = false; window.removeEventListener('focus', refresh); };
  }, [call, onError]);

  async function request(key: DesktopPermission) {
    setPending(true);
    try { setPermissions(await call('permissions:request', key)); }
    catch (error) { onError(error); }
    finally { setPending(false); }
  }

  return <section><h3>macOS 系统权限</h3>
    {rows.map(([key, label, detail]) => <div key={key} className="field">
      <strong>{label}</strong>
      <p className="muted">{detail}</p>
      <div className="button-row">
        <button type="button" className="button" disabled={pending || !permissions || permissions[key]}
          onClick={() => void request(key)}>{permissions?.[key] ? '已授权' : '授权'}</button>
      </div>
    </div>)}
  </section>;
}
