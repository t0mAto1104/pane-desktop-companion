import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, Tray } from 'electron';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { awarenessOptions, type Actions, type CaptureState, type ObservationUse, type SendResult, type Settings, type Target } from '../shared';
import { Store } from './store';
import { NativeBridge, sameTarget, UserError } from './native';
import { AI, diagnostic } from './ai';
import { Chat } from './chat';
import { ObservationManager } from './observation';
import { CaptureResolver, deniedTarget } from './capture-resolver';

const accelerator = 'Control+Shift+Space';
const rendererFile = join(__dirname, '../renderer/index.html');
const expectedURL = pathToFileURL(rendererFile).href;
const executable = app.isPackaged ? join(process.resourcesPath, 'native/window-capture.exe') : join(__dirname, '../../native/bin/window-capture.exe');
const captureBridge = new NativeBridge(executable);

let win: BrowserWindow;
let tray: Tray;
let store: Store;
let ai: AI;
let chat: Chat;
const observations = new ObservationManager((target, denied) => captureBridge.observe(target, denied), state => send('observation', state));
const resolver = new CaptureResolver({
  observation: (target, signal) => observations.prepare(target.id, signal),
  validate: (target, denied, signal) => captureBridge.validate(target, denied, signal),
  capture: (target, denied, signal) => captureBridge.capture(target, denied, signal, 2800),
});
let pendingSend: { id: string; controller: AbortController } | undefined;
let captureJob: AbortController | undefined;
let locked = false;
let suspended = false;
let quitting = false;
let ready = false;
let settings: Settings;
let activeId: string | null = null;
let shortcut = false;
let invocation = 0;
let nativeLookupPending = false;
let credentialPrompt = false;
let capture: CaptureState = { target: null, bound: false, pending: false, shot: null };

function send(channel: string, payload?: unknown) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(`pane:${channel}`, payload);
}

function setCapture(next: Partial<CaptureState>) {
  capture = { ...capture, ...next };
  send('capture', capture);
}

function desktopUnavailable() { return locked || suspended; }

function invalidateSend(message: string) {
  pendingSend?.controller.abort(new UserError(message));
}

function supersedeCapture() {
  captureJob?.abort();
  return ++invocation;
}

function cancelCapture(clearTarget = false) {
  supersedeCapture();
  setCapture({ pending: false, shot: null, error: undefined, ...(clearTarget && !capture.bound ? { target: null } : {}) });
}

async function captureWindow(target: Target, generation: number) {
  if (generation !== invocation || desktopUnavailable()) return;
  const controller = new AbortController();
  captureJob = controller;
  const previous = capture.shot;
  setCapture({ pending: true, shot: previous && sameTarget(previous.target, target) ? previous : null, error: undefined, target });
  try {
    const shot = await captureBridge.capture(target, settings.denied, controller.signal);
    if (generation === invocation) setCapture({ target: shot.target, shot, pending: false });
  } catch (error) {
    if (generation === invocation) setCapture({ pending: false, error: diagnostic(error) });
  } finally {
    if (captureJob === controller) captureJob = undefined;
  }
}

function boundTarget() { return capture.bound ? capture.target : null; }

function monitoring() {
  return ['starting', 'watching', 'changing'].includes(observations.current.phase);
}

function show() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  send('shown');
}

function hide() {
  cancelCapture(true);
  win.hide();
}

async function onHotkey() {
  if (!ready || credentialPrompt || desktopUnavailable()) return;
  if (win.isVisible() && win.isFocused()) { hide(); return; }
  if (nativeLookupPending) return;
  nativeLookupPending = true;
  const generation = supersedeCapture();
  try {
    const target = capture.bound && capture.target ? capture.target : await captureBridge.foreground(settings.denied);
    if (generation !== invocation) return;
    setCapture({ target, pending: false, shot: null, error: undefined });
    show();
    if (settings.autoCapture && !monitoring() && !(capture.bound && settings.screenAwarenessEnabled)) {
      await captureWindow(target, generation);
    }
  } catch (error) {
    if (generation !== invocation) return;
    setCapture({ target: capture.bound ? capture.target : null, pending: false, shot: null, error: diagnostic(error) });
    show();
  } finally {
    nativeLookupPending = false;
  }
}

function applySettings() {
  nativeTheme.themeSource = settings.theme;
  win.setAlwaysOnTop(settings.pinned);
}

function saveSettings(next: Settings) {
  settings = next;
  store.write('settings', settings);
  applySettings();
  if (!desktopUnavailable()) observations.configure(boundTarget(), settings, settings.denied);
  return settings;
}

function selectedShot(id: string | null) {
  if (id === null) return null;
  if (capture.shot?.id !== id) throw new UserError('截图已更新或清除，请重新选择要发送的截图。');
  return capture.shot;
}

function denyList(input: unknown) {
  if (!Array.isArray(input) || input.length > 100 || input.some(item => typeof item !== 'string' || item.length > 160 || !/^[^<>:"/\\|?*\x00-\x1f]+\.exe$/i.test(item))) {
    throw new UserError('每行填写一个 .exe 文件名，最多 100 项。');
  }
  return [...new Map(input.map((item: string) => [item.toLowerCase(), item])).values()];
}

function assertIdle() {
  if (chat.run || pendingSend) throw new UserError('请先等待或停止当前回答。');
}

async function beginChat(id: string, text: string, shotId: string | null, retry: boolean, use: ObservationUse = 'omit'): Promise<SendResult> {
  assertIdle();
  if (id !== activeId) throw new UserError('请先打开此对话。');
  if (typeof text !== 'string' || text.length > 20_000) throw new UserError('每条消息最多 20,000 个字符。');
  if (use !== 'auto' && use !== 'omit' && use !== 'image') throw new UserError('屏幕上下文选项无效。');
  const selected = use === 'image' ? null : selectedShot(shotId);
  const bound = boundTarget();
  const request = { id, controller: new AbortController() };
  pendingSend = request;
  const { signal } = request.controller;
  try {
    const visual = await resolver.resolve({
      use, manual: selected, retry: retry ? chat.retryVisual(id) : null,
      target: bound ?? capture.target, awareness: !!bound && settings.screenAwarenessEnabled,
      paused: observations.current.phase === 'paused', desktopUnavailable: desktopUnavailable(), denied: settings.denied, signal,
    });
    signal.throwIfAborted();
    if (quitting || activeId !== id || !store.has(id)) throw new UserError('对话已切换，请重新发送。');
    if (visual.source === 'unavailable') return { kind: 'confirm-text', reason: visual.reason };
    if (visual.source === 'manual' && selected && capture.shot?.id !== selected.id) {
      throw new UserError('手动附件已更新，请确认当前截图后重新发送。');
    }
    const run = chat.start(id, text.trim(), visual, settings, retry);
    // Clear only the exact attachment that was used, without cancelling a newer capture.
    if (visual.source === 'manual' && capture.shot?.id === visual.shot.id) setCapture({ shot: null, error: undefined });
    else if (visual.source === 'text' && use === 'omit' && capture.error) setCapture({ error: undefined });
    return { kind: 'started', run };
  } finally {
    if (pendingSend === request) pendingSend = undefined;
  }
}

const actions: Actions = {
  snapshot: () => ({ settings, conversationId: activeId, capture, observation: observations.current, run: chat.run, shortcut }),
  'settings:update': patch => {
    if (!patch || typeof patch !== 'object') throw new UserError('设置格式无效。');
    const next = { ...settings, ...awarenessOptions({ ...settings, ...patch }) };
    if (patch.theme === 'light' || patch.theme === 'dark' || patch.theme === 'system') next.theme = patch.theme;
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
    if (typeof patch.autoCapture === 'boolean') next.autoCapture = patch.autoCapture;
    if (patch.provider === 'chatgpt' || patch.provider === 'api-key') {
      assertIdle();
      next.provider = patch.provider;
    }
    if (next.screenAwarenessEnabled !== settings.screenAwarenessEnabled || next.monitoringIntervalMs !== settings.monitoringIntervalMs ||
        next.changeThreshold !== settings.changeThreshold || next.maxObservations !== settings.maxObservations) {
      invalidateSend('屏幕观察设置已变更，请重新发送。');
    }
    if (patch.denied !== undefined) {
      next.denied = denyList(patch.denied);
      invalidateSend('禁止捕获名单已变更，请重新发送。');
      supersedeCapture();
      chat.enforceDenyList(next.denied);
      setCapture({ pending: false, error: undefined,
        shot: capture.shot && !deniedTarget(capture.shot.target, next.denied) ? capture.shot : null,
        ...(!next.screenAwarenessEnabled ? { target: null, bound: false } : {}) });
    }
    return saveSettings(next);
  },
  'window:hide': hide,
  'window:list': () => captureBridge.list(settings.denied),
  'capture:bind': async id => {
    if (desktopUnavailable()) throw new UserError('请先解锁 Windows 桌面。');
    invalidateSend('目标窗口已切换，请重新发送。');
    if (id === null) {
      supersedeCapture();
      setCapture({ target: null, bound: false, pending: false, shot: null, error: undefined });
      observations.configure(null, settings, settings.denied);
      return;
    }
    const generation = supersedeCapture();
    setCapture({ target: null, bound: false, pending: false, shot: null, error: undefined });
    observations.configure(null, settings, settings.denied);
    const target = (await captureBridge.list(settings.denied)).find(item => item.id === id);
    if (generation !== invocation) return;
    if (!target) throw new UserError('该窗口已关闭或在禁止捕获名单中。');
    setCapture({ target, bound: true, pending: false, shot: null, error: undefined });
    observations.configure(target, settings, settings.denied, true);
    if (!settings.screenAwarenessEnabled) await captureWindow(target, generation);
  },
  'capture:refresh': async () => {
    if (desktopUnavailable()) throw new UserError('请先解锁 Windows 桌面。');
    invalidateSend('截图正在刷新，请确认后重新发送。');
    const target = capture.target;
    if (!target) throw new UserError('请先绑定窗口，或切换到目标应用后按快捷键。');
    await captureWindow(target, supersedeCapture());
  },
  'capture:remove': () => { invalidateSend('截图已移除，请重新发送。'); cancelCapture(); },
  'observation:pause': () => {
    invalidateSend('屏幕观察已暂停，请重新发送。');
    supersedeCapture();
    if (capture.pending) setCapture({ pending: false });
    observations.pause();
  },
  'observation:resume': () => {
    if (desktopUnavailable()) throw new UserError('请先解锁 Windows 桌面。');
    observations.configure(boundTarget(), settings, settings.denied);
    observations.resume();
  },
  'observation:preview': id => {
    if (typeof id !== 'string') throw new UserError('无效的观察标识。');
    return observations.preview(id);
  },
  'account:state': () => ai.account(),
  'account:signIn': () => { assertIdle(); return ai.signIn(); },
  'account:cancel': () => ai.cancelSignIn(),
  'account:disconnect': () => { assertIdle(); return ai.disconnect(); },
  'account:usage': () => ai.usage(),
  'account:addKey': async () => {
    assertIdle();
    if (credentialPrompt) throw new UserError('Windows 凭据输入框已打开。');
    credentialPrompt = true;
    try {
      const key = await captureBridge.keyPrompt(win.getNativeWindowHandle());
      if (!key) return ai.account();
      assertIdle();
      return ai.addKey(key);
    } finally { credentialPrompt = false; }
  },
  'account:removeKey': () => { assertIdle(); return ai.removeKey(); },
  'account:models': async () => {
    const provider = settings.provider;
    const models = await ai.models(provider, true);
    if (settings.provider === provider && !models.some(model => model.id === settings.models[provider])) {
      const preferred = models.find(model => /^gpt-[\d.]+-mini$/.test(model.id)) ?? models[0];
      saveSettings({ ...settings, models: { ...settings.models, [provider]: preferred?.id } });
    }
    return models;
  },
  'account:selectModel': id => {
    if (typeof id !== 'string' || !/^[\w.:-]{1,180}$/.test(id)) throw new UserError('模型名称无效。');
    return saveSettings({ ...settings, models: { ...settings.models, [settings.provider]: id } });
  },
  'chat:list': () => store.list(),
  'chat:open': id => {
    if (!store.has(id)) throw new UserError('该对话已删除。');
    if (activeId !== id) invalidateSend('对话已切换，请重新发送。');
    activeId = id;
    store.write('active', id);
    return store.messages(id);
  },
  'chat:new': () => {
    invalidateSend('对话已切换，请重新发送。');
    const item = store.create();
    activeId = item.id;
    return item;
  },
  'chat:delete': id => {
    if (chat.run?.conversationId === id) throw new UserError('请先停止此对话的生成。');
    if (pendingSend?.id === id) invalidateSend('该对话已删除。');
    store.remove(id);
    chat.deleteImages(id);
    if (activeId === id) activeId = null;
  },
  'chat:send': (id, text, shotId, use) => beginChat(id, text, shotId, false, use),
  'chat:retry': (id, shotId, use) => beginChat(id, '', shotId, true, use),
  'chat:stop': () => { invalidateSend('已停止准备本轮请求。'); chat.stop(); },
};

function launch() {
  const dataDir = app.getPath('userData');
  store = new Store(join(dataDir, 'pane.sqlite'));
  settings = store.settings();
  const saved = store.read<string>('active');
  activeId = saved && store.has(saved) ? saved : store.list()[0]?.id ?? null;

  for (const key of ['OPENAI_CUSTOM_HEADERS', 'OPENAI_LOG']) delete process.env[key];

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on('will-download', event => event.preventDefault());
  win = new BrowserWindow({
    width: 940, height: 690, minWidth: 570, minHeight: 490,
    frame: false, show: false, backgroundColor: '#f7f7f8',
    autoHideMenuBar: true, title: 'Pane · 桌面助手',
    icon: join(__dirname, '../renderer/pane.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.on('close', event => {
    if (!quitting) { event.preventDefault(); hide(); }
  });
  win.on('minimize', hide);
  ai = new AI(store, dataDir, () => send('account'));
  chat = new Chat(store, ai, update => send('chat', update));
  observations.configure(null, settings, settings.denied);
  const pauseDesktop = () => {
    invalidateSend('Windows 桌面不可用，本轮发送已停止。');
    chat.stop();
    observations.pause();
    cancelCapture(true);
  };
  powerMonitor.on('lock-screen', () => { locked = true; pauseDesktop(); });
  powerMonitor.on('unlock-screen', () => { locked = false; });
  powerMonitor.on('suspend', () => { suspended = true; pauseDesktop(); });
  powerMonitor.on('resume', () => { suspended = false; });
  ipcMain.handle('pane:call', async (event, action: keyof Actions, args: unknown[]) => {
    const frame = event.senderFrame;
    if (!frame || frame !== win.webContents.mainFrame || frame.url !== expectedURL || !Object.hasOwn(actions, action) || !Array.isArray(args)) return { ok: false, error: '此操作不可用。' };
    try {
      const handler = actions[action] as (...parameters: unknown[]) => unknown;
      return { ok: true, value: await handler(...args) };
    } catch (error) { return { ok: false, error: diagnostic(error) }; }
  });
  applySettings();
  shortcut = globalShortcut.register(accelerator, () => void onHotkey());

  const icon = nativeImage.createFromPath(join(__dirname, '../renderer/pane.png')).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip('Pane · Ctrl+Shift+Space');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Pane', click: show },
    { label: '隐藏 Pane', click: hide },
    { type: 'separator' },
    { label: '退出 Pane', click: () => app.quit() },
  ]));
  tray.on('click', () => win.isVisible() && win.isFocused() ? hide() : show());

  win.once('ready-to-show', () => {
    ready = true;
    if (!process.argv.includes('--hidden') || !shortcut) show();
  });
  void win.loadFile(rendererFile);
}

const profileDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (isAbsolute(profileDirectory)) app.setPath('userData', profileDirectory);
app.setAppUserModelId('local.pane.desktop-companion');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('before-quit', () => { quitting = true; invalidateSend('Pane 正在退出。'); supersedeCapture(); observations.dispose(); chat?.shutdown(); ai?.cancelSignIn(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
  app.whenReady().then(launch).catch(() => app.exit(1));
}
