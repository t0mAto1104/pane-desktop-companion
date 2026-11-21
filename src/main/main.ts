import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, session, Tray } from 'electron';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { awarenessOptions, type Actions, type CaptureState, type ObservationUse, type Settings, type Target } from '../shared';
import { Store } from './store';
import { NativeBridge, UserError } from './native';
import { AI, diagnostic } from './ai';
import { Chat } from './chat';
import { ObservationManager } from './observation';
import { ScreenContextEngine } from './screen-context';

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
const screenContext = new ScreenContextEngine();
let startingChat = false;
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

function cancelCapture(clearTarget = false) {
  invocation += 1;
  setCapture({ pending: false, shot: null, error: undefined, ...(clearTarget && !capture.bound ? { target: null } : {}) });
}

async function captureWindow(target: Target, generation: number) {
  if (generation !== invocation) return;
  setCapture({ pending: true, shot: null, error: undefined, target });
  try {
    const shot = await captureBridge.capture(target, settings.denied);
    if (generation === invocation) setCapture({ target: shot.target, shot, pending: false });
  } catch (error) {
    if (generation === invocation) setCapture({ pending: false, shot: null, error: diagnostic(error) });
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
  if (!ready || credentialPrompt) return;
  if (win.isVisible() && win.isFocused()) { hide(); return; }
  if (nativeLookupPending) return;
  nativeLookupPending = true;
  const generation = ++invocation;
  try {
    const target = capture.bound && capture.target ? capture.target : await captureBridge.foreground(settings.denied);
    if (generation !== invocation) return;
    setCapture({ target, pending: false, shot: null, error: undefined });
    show();
    if (settings.autoCapture && !monitoring()) await captureWindow(target, generation);
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
  observations.configure(boundTarget(), settings, settings.denied);
  return settings;
}

function selectedShot(id: string | null) {
  if (id === null) return null;
  if (capture.shot?.id !== id || capture.pending) throw new UserError('截图已更新或清除，请重新选择要发送的截图。');
  return capture.shot;
}

function denyList(input: unknown) {
  if (!Array.isArray(input) || input.length > 100 || input.some(item => typeof item !== 'string' || item.length > 160 || !/^[^<>:"/\\|?*\x00-\x1f]+\.exe$/i.test(item))) {
    throw new UserError('每行填写一个 .exe 文件名，最多 100 项。');
  }
  return [...new Map(input.map((item: string) => [item.toLowerCase(), item])).values()];
}

function assertIdle() {
  if (chat.run || startingChat) throw new UserError('请先等待或停止当前回答。');
}

async function beginChat(id: string, text: string, shotId: string | null, retry: boolean, use: ObservationUse = 'omit') {
  assertIdle();
  if (id !== activeId) throw new UserError('请先打开此对话。');
  if (typeof text !== 'string' || text.length > 20_000) throw new UserError('每条消息最多 20,000 个字符。');
  if (use !== 'auto' && use !== 'omit' && use !== 'image') throw new UserError('屏幕上下文选项无效。');
  const selected = selectedShot(shotId);
  const target = boundTarget();
  const awareness = settings.screenAwarenessEnabled && !!target;
  const question = retry ? store.lastTurn(id)[0]?.text : text.trim();
  startingChat = true;
  try {
    const observation = target && awareness && use !== 'omit' && question
      ? await observations.fresh(target.id) : null;
    if (quitting || activeId !== id || !store.has(id)) throw new UserError('对话已切换，请重新发送。');
    // Re-read the state after native I/O. Pausing, rebinding or changing the denylist clears the old cache.
    const valid = observation && boundTarget()?.id === observation.observation.targetId &&
      observations.current.latest?.observationId === observation.observation.observationId && observations.current.phase === 'watching';
    if (use === 'image' && !valid) throw new UserError('当前没有可用的观察截图。请等待画面稳定或改为仅发送文字。');
    const context = valid ? screenContext.select(id, observation, use === 'image') : undefined;
    const automatic = awareness && use !== 'omit' && !!question;
    const shot = !automatic && selected && capture.shot?.id === selected.id ? selected : null;
    const run = chat.start(id, text.trim(), shot, settings, retry, {
      screen: context,
      includeHistoryImages: !awareness,
      onComplete: context ? () => screenContext.complete(id, context) : undefined,
    });
    if (selected && capture.shot?.id === selected.id) cancelCapture();
    return run;
  } finally {
    startingChat = false;
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
    if (patch.denied !== undefined) {
      next.denied = denyList(patch.denied);
      invocation += 1;
      chat.enforceDenyList(next.denied);
      setCapture({ pending: false, shot: null, error: undefined,
        ...(!next.screenAwarenessEnabled ? { target: null, bound: false } : {}) });
    }
    return saveSettings(next);
  },
  'window:hide': hide,
  'window:list': () => captureBridge.list(settings.denied),
  'capture:bind': async id => {
    if (id === null) {
      invocation += 1;
      setCapture({ target: null, bound: false, pending: false, shot: null, error: undefined });
      observations.configure(null, settings, settings.denied);
      return;
    }
    const generation = ++invocation;
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
    const target = capture.target;
    if (!target) throw new UserError('请先绑定窗口，或切换到目标应用后按快捷键。');
    await captureWindow(target, ++invocation);
  },
  'capture:remove': () => cancelCapture(),
  'observation:pause': () => observations.pause(),
  'observation:resume': () => observations.resume(),
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
    activeId = id;
    store.write('active', id);
    return store.messages(id);
  },
  'chat:new': () => {
    const item = store.create();
    activeId = item.id;
    return item;
  },
  'chat:delete': id => {
    if (chat.run?.conversationId === id) throw new UserError('请先停止此对话的生成。');
    store.remove(id);
    chat.deleteImages(id);
    screenContext.forget(id);
    if (activeId === id) activeId = null;
  },
  'chat:send': (id, text, shotId, use) => beginChat(id, text, shotId, false, use),
  'chat:retry': (id, shotId, use) => beginChat(id, '', shotId, true, use),
  'chat:stop': () => chat.stop(),
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
  powerMonitor.on('lock-screen', () => { observations.pause(); cancelCapture(true); });
  powerMonitor.on('suspend', () => { observations.pause(); cancelCapture(true); });
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
  app.on('before-quit', () => { quitting = true; observations.dispose(); chat?.stop(); ai?.cancelSignIn(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
  app.whenReady().then(launch).catch(() => app.exit(1));
}
