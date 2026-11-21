import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../shared';
import type { VoiceDevice, VoiceLanguage, VoiceModelState, VoiceSettings, VoiceState } from '../voice';
import { VoiceMeter } from './VoiceMeter';

function VoiceModelSetting() {
  const [model, setModel] = useState<VoiceModelState>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let updated = false;
    const unsubscribe = window.pane.subscribe('voice:model', state => { updated = true; setModel(state); });
    void window.pane.call('voice:modelStatus').then(result => {
      if (!live || updated) return;
      if (result.ok) setModel(result.value);
      else setError(result.error);
    }).catch(() => { if (live) setError('无法检查离线语音模型。'); });
    return () => { live = false; unsubscribe(); };
  }, []);

  async function download() {
    setError('');
    try {
      const result = await window.pane.call('voice:modelDownload');
      if (!result.ok) setError(result.error);
    } catch { setError('无法下载离线语音模型。'); }
  }

  if (model?.phase === 'ready') return <p className="muted">本地 Whisper 模型已就绪</p>;
  return <div className="voice-model">
    {model?.phase === 'missing' && <button className="button" onClick={() => void download()}>下载离线 Whisper 模型（约 190 MB）</button>}
    {model?.phase === 'downloading' && <div className="button-row">
      <progress max={100} value={model.progress} aria-label="离线模型下载进度" />
      <small>{model.progress}%</small>
      <button className="button" onClick={() => void window.pane.call('voice:modelCancel')}>取消下载</button>
    </div>}
    {!model && !error && <small className="muted">正在检查离线模型…</small>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function VoiceDeviceSettings({ settings, update, voice }: {
  settings: Settings;
  update: (patch: Partial<VoiceSettings>) => void;
  voice: VoiceState;
}) {
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState('正在读取设备…');
  const [trial, setTrial] = useState('');
  const trialActive = useRef(false);
  useEffect(() => {
    let current = true;
    void window.pane.call('voice:devices').then(result => {
      if (!current) return;
      if (result.ok) { setDevices(result.value); setStatus(''); }
      else setStatus(result.error);
    }).catch(() => { if (current) setStatus('无法读取 Windows 音频设备。'); });
    return () => { current = false; };
  }, [refresh]);
  useEffect(() => () => { if (trialActive.current) void window.pane.call('voice:cancel'); }, []);

  async function testMic() {
    if (trialActive.current) return;
    trialActive.current = true;
    setTrial('');
    try {
      const result = await window.pane.call('voice:testMic');
      setTrial(result.ok ? result.value : result.error);
    } catch { setTrial('试录未完成，请重试。'); }
    finally { trialActive.current = false; }
  }

  const busy = voice.phase !== 'ready';
  return <section>
    <h3>语音</h3>
    {(['input', 'output'] as const).map(kind => {
      const field = kind === 'input' ? 'voiceInputId' : 'voiceOutputId';
      const label = kind === 'input' ? '麦克风（输入）' : '朗读设备（输出）';
      const choices = devices.filter(device => device.kind === kind);
      return <label className="field" key={kind}>{label}
        <select aria-label={label} disabled={busy} value={settings[field]} onChange={event => { setTrial(''); update({ [field]: event.target.value }); }}>
          <option value="">跟随 Windows 默认设备</option>
          {settings[field] && !choices.some(device => device.id === settings[field]) && <option value={settings[field]}>上次选择的设备（当前不可用）</option>}
          {choices.map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
        </select>
      </label>;
    })}
    <div className="voice-mic-test">
      <div className="button-row">
        <button className="button" disabled={busy} onClick={() => void testMic()}>试录并回放</button>
        {voice.testing && <button className="button" onClick={() => void window.pane.call('voice:cancel')}>停止试录</button>}
        <button className="button" onClick={() => { setStatus('正在读取设备…'); setRefresh(value => value + 1); }}>刷新音频设备</button>
      </div>
      {voice.testing && <div className="voice-level-row">
        <small role="status">{voice.phase === 'recording' ? '可以说话，试录约 4 秒' :
          voice.phase === 'previewing' ? '正在回放试录' : '正在连接麦克风…'}</small>
        <VoiceMeter state={voice} />
      </div>}
      {(trial || status) && <small className="muted" role="status">{trial || status}</small>}
    </div>
    <label className="field">听写语言<select aria-label="听写语言" value={settings.voiceLanguage}
      onChange={event => update({ voiceLanguage: event.target.value as VoiceLanguage })}>
      <option value="auto">自动识别</option><option value="zh">中文</option><option value="en">英语</option>
    </select></label>
    <label className="check-field"><input type="checkbox" checked={settings.voiceReadReplies}
      onChange={event => update({ voiceReadReplies: event.target.checked })} />朗读语音回答</label>
    <VoiceModelSetting />
  </section>;
}
