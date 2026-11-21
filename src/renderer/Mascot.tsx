import { useEffect, useState } from 'react';
import { COMPANION_SKINS, type CompanionSkin, type MascotState } from '../shared';

export function MascotImage({ skin, className }: { skin: CompanionSkin; className?: string }) {
  return <img className={className} src={'./companion/' + skin + '.png'} alt="" draggable={false} />;
}

export function Mascot() {
  const [appearance, setAppearance] = useState<MascotState>({ skin: 'orbit', busy: false });
  useEffect(() => {
    let alive = true;
    let updated = false;
    const stop = window.pane.subscribe('mascot', state => { updated = true; setAppearance(state); });
    void window.pane.call('companion:appearance').then(result => {
      if (alive && !updated && result.ok) setAppearance(result.value);
    });
    return () => { alive = false; stop(); };
  }, []);
  return <div className="desktop-mascot">
    <button className="mascot-button" aria-label="打开或收起浮动聊天"
        title={COMPANION_SKINS[appearance.skin] + ' · 点击聊天'} onClick={() => void window.pane.call('companion:toggle')}>
      <MascotImage skin={appearance.skin} />
      {appearance.busy && <span className="mascot-busy" title="Pane 正在处理" />}
    </button>
    <div className="mascot-grip" title="拖动角色"><span /></div>
  </div>;
}
