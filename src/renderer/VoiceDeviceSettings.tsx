import React, { useEffect, useState } from 'react';
import type { Settings } from '../shared';
import type { VoiceDevice, VoiceSettings } from '../voice';

export function VoiceDeviceSettings({ settings, update }: {
  settings: Settings;
  update: (patch: Partial<VoiceSettings>) => void;
}) {
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState('正在读取设备…');
  useEffect(() => {
    let current = true;
    void window.pane.call('voice:devices').then(result => {
      if (!current) return;
      if (result.ok) { setDevices(result.value); setStatus(''); }
      else setStatus(result.error);
    }).catch(() => { if (current) setStatus('无法读取 Windows 音频设备。'); });
    return () => { current = false; };
  }, [refresh]);
  return <section>
    <h3>语音</h3>
    {(['input', 'output'] as const).map(kind => {
      const field = kind === 'input' ? 'voiceInputId' : 'voiceOutputId';
      const label = kind === 'input' ? '麦克风（输入）' : '朗读设备（输出）';
      const choices = devices.filter(device => device.kind === kind);
      return <label className="field" key={kind}>{label}
        <select aria-label={label} value={settings[field]} onChange={event => update({ [field]: event.target.value })}>
          <option value="">跟随 Windows 默认设备</option>
          {settings[field] && !choices.some(device => device.id === settings[field]) && <option value={settings[field]}>上次选择的设备（当前不可用）</option>}
          {choices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
      </label>;
    })}
    <label className="field">听写语言<select aria-label="听写语言" value={settings.voiceLanguage}
      onChange={event => update({ voiceLanguage: event.target.value === 'en' ? 'en' : 'zh' })}>
      <option value="zh">中文</option><option value="en">英语</option>
    </select></label>
    <label className="check-field"><input type="checkbox" checked={settings.voiceReadReplies}
      onChange={event => update({ voiceReadReplies: event.target.checked })} />朗读语音回答</label>
    <div className="button-row"><button className="button" onClick={() => { setStatus('正在读取设备…'); setRefresh(value => value + 1); }}>刷新音频设备</button>
      {status && <small className="muted" role="status">{status}</small>}</div>
  </section>;
}
