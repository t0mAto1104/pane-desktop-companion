import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, Tray, type Rectangle } from 'electron';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { awarenessOptions, companionOptions, type Actions, type CaptureState, type GuidanceState, type ObservationUse, type ScreenRegion, type Settings, type Target, type WindowSurface } from '../shared';
import { Store } from './store';
import { NativeBridge, sameTarget, UserError } from './native';
import { AI, diagnostic } from './ai';
import { Chat } from './chat';
import { queryDesktop } from './desktop-query';
import { LocationEngine, type ToolScope } from './location';
import { GuidanceEngine } from './guidance';
import { GuidanceTracker } from './guidance-tracker';
import { OverlayManager } from './overlay-manager';
import { regionUnits } from './roi';
import { ElementDetector, matchElements } from './element-detector';
import { ObservationManager } from './observation';
import { CaptureResolver, deniedTarget } from './capture-resolver';

import { CompanionWindow } from './companion';
import { fittedWindow } from './companion-geometry';
import { InputSessionController } from './input-session';
import { InputRouter } from './input-router';
import { ownFrame, restrictSession } from './permission-manager';

const accelerator = 'Control+Shift+Space';
const rendererFile = join(__dirname, '../renderer/index.html');
const expectedURL = pathToFileURL(rendererFile).href;
const executable = app.isPackaged ? join(process.resourcesPath, 'native/window-capture.exe') : join(__dirname, '../../native/bin/window-capture.exe');
const captureBridge = new NativeBridge(executable);
const detector = new ElementDetector((target, denied, signal) => captureBridge.inspectAutomation(target, denied, signal));
let toolScope = new AbortController();

let win: BrowserWindow;
let tray: Tray;
let companion: CompanionWindow;
let compact = false;
let normalBounds: Rectangle | undefined;
let store: Store;
let ai: AI;
let chat: Chat;
const observations = new ObservationManager((target, denied) => captureBridge.observe(target, denied), state => send('observation', state));
const resolver = new CaptureResolver({
  observation: (target, signal) => observations.prepare(target.id, signal),
  validate: (target, denied, signal) => captureBridge.validate(target, denied, signal),
  capture: (target, denied, signal) => captureBridge.capture(target, denied, signal, 2800),
});
const overlay = new OverlayManager();
const tracker = new GuidanceTracker();
const location = new LocationEngine(detector, readEvidence,
  (instructions, data, image, signal) => queryDesktop(ai, settings, instructions, data, image, signal),
  async (id, scope) => {
    const checked = await observations.prepare(scope.target.id, scope.signal);
    return checked.kind === 'confirmed' && checked.frame.observation.observationId === id;
  });
const guidance = new GuidanceEngine(detector, readEvidence,
  (instructions, data, image, signal) => queryDesktop(ai, settings, instructions, data, image, signal),
  publishGuidance);
const inputSessions = new InputSessionController();
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

function publishGuidance(state: GuidanceState | null) {
  send('guidance', state);
  const target = boundTarget();
  if (!state || !target || desktopUnavailable() || quitting) { tracker.clear(); return; }
  const policy = toolScope.signal;
  const denied = settings.denied;
  tracker.present(state, async signal => {
    const result = await captureBridge.geometry(target, denied, AbortSignal.any([signal, policy]));
    return { ...result, foreground: result.foreground && !win.isFocused() };
  });
}

function setCapture(next: Partial<CaptureState>) {
  capture = { ...capture, ...next };
  send('capture', capture);
  syncCompanion();
}

function desktopUnavailable() { return locked || suspended; }

function invalidateSend(message: string) {
  inputSessions.cancel(message);
}

function supersedeCapture() {
  captureJob?.abort();
  return ++invocation;
}

function cancelTools() {
  guidance.clear();
  overlay.clear();
  location.clear();
  toolScope.abort(new UserError('目标窗口或权限已变更，请重试。'));
  toolScope = new AbortController();
}

function authorizedWindow() {
  if (desktopUnavailable()) throw new UserError('请先解锁 Windows 桌面。');
  const target = boundTarget();
  if (!target) throw new UserError('请先明确绑定一个窗口。');
  if (deniedTarget(target, settings.denied)) throw new UserError('该应用在禁止捕获名单中。');
  return { target, denied: settings.denied, signal: toolScope.signal };
}

async function readEvidence(scope: ToolScope, region: ScreenRegion) {
  const prior = observations.current;
  const capture = await captureBridge.captureRegion(scope.target, scope.denied, region, regionUnits(region), scope.signal);
  scope.signal.throwIfAborted();
  const current = observations.current;
  const observationId = prior.phase === 'watching' && prior.latest?.targetId === scope.target.id && current.phase === 'watching' &&
    current.latest?.observationId === prior.latest.observationId ? prior.latest.observationId : undefined;
  return { capture, observationId };
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

function syncCompanion() {
  if (!companion || !ready || quitting) return;
  companion.update(settings.companionEnabled && !desktopUnavailable() && (compact || !win.isVisible()),
    settings.companionSkin, capture.pending || !!chat.run);
}

function show(panel?: WindowSurface['panel']) {
  if (!win || win.isDestroyed() || desktopUnavailable()) return;
  if (win.isMinimized()) win.restore();
  if (compact) {
    compact = false;
    if (normalBounds) win.setBounds(fittedWindow(screen.getDisplayMatching(normalBounds).workArea, normalBounds, normalBounds));
    win.setMinimumSize(570, 490);
    win.setAlwaysOnTop(settings.pinned);
  }
  win.show();
  win.focus();
  syncCompanion();
  send('shown', { compact, panel } satisfies WindowSurface);
}

function hide() {
  if (inputSessions.pending) {
    supersedeCapture();
    if (capture.pending) setCapture({ pending: false });
  } else cancelCapture(true);
  win.hide();
  syncCompanion();
}

function showCompact(panel?: WindowSurface['panel']) {
  if (win.isMinimized()) win.restore();
  if (!compact) normalBounds = win.getBounds();
  compact = true;
  win.setMinimumSize(280, 310);
  win.setBounds(companion.panelBounds);
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  syncCompanion();
  send('shown', { compact, panel } satisfies WindowSurface);
}

function openGuidance() {
  if (!ready || quitting || desktopUnavailable() || credentialPrompt) return;
  showCompact('guide');
}

async function toggleCompanion() {
  if (!ready || quitting || desktopUnavailable() || !settings.companionEnabled || credentialPrompt) return;
  if (win.isVisible()) { if (compact) hide(); return; }
  if (nativeLookupPending) return;
  nativeLookupPending = true;
  const generation = supersedeCapture();
  let target = boundTarget();
  let error: string | undefined;
  try {
    target ??= await captureBridge.foreground(settings.denied);
  } catch (reason) { error = diagnostic(reason); }
  finally { nativeLookupPending = false; }
  if (generation !== invocation || win.isVisible() || desktopUnavailable() || !settings.companionEnabled || quitting) return;
  setCapture({ target, pending: false, shot: null, error });
  showCompact(guidance.state ? 'guide' : undefined);
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
  if (nativeTheme.themeSource !== settings.theme) nativeTheme.themeSource = settings.theme;
  const pinned = compact || settings.pinned;
  if (win.isAlwaysOnTop() !== pinned) win.setAlwaysOnTop(pinned);
  syncCompanion();
  updateTray();
}

function saveSettings(next: Settings) {
  settings = next;
  store.write('settings', settings);
  applySettings();
  if (!desktopUnavailable()) observations.configure(boundTarget(), settings, settings.denied);
  return settings;
}

function denyList(input: unknown) {
  if (!Array.isArray(input) || input.length > 100 || input.some(item => typeof item !== 'string' || item.length > 160 || !/^[^<>:"/\\|?*\x00-\x1f]+\.exe$/i.test(item))) {
    throw new UserError('每行填写一个 .exe 文件名，最多 100 项。');
  }
  return [...new Map(input.map((item: string) => [item.toLowerCase(), item])).values()];
}

const input = new InputRouter({
  sessions: inputSessions, resolver, chat: () => chat, capture: () => capture, settings: () => settings,
  responseReady: provider => ai.assertResponseReady(provider),
  activeConversation: () => activeId, usableConversation: id => store.has(id),
  unavailable: () => quitting || desktopUnavailable(), paused: () => observations.current.phase === 'paused',
  clearAttachment: id => {
    if (id !== null && capture.shot?.id === id) setCapture({ shot: null, error: undefined });
    else if (id === null && capture.error) setCapture({ error: undefined });
    syncCompanion();
  },
});

function assertIdle() { input.assertIdle(); }

const actions: Actions = {
  snapshot: () => ({ settings, conversationId: activeId, capture, observation: observations.current, run: chat.run, shortcut, compact }),
  'settings:update': patch => {
    if (!patch || typeof patch !== 'object') throw new UserError('设置格式无效。');
    const next = { ...settings, ...awarenessOptions({ ...settings, ...patch }), ...companionOptions({
      companionEnabled: typeof patch.companionEnabled === 'boolean' ? patch.companionEnabled : settings.companionEnabled,
      companionSkin: patch.companionSkin ?? settings.companionSkin,
    }) };
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
      cancelTools();
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
  'companion:appearance': () => companion.appearance(),
  'companion:toggle': toggleCompanion,
  'companion:expand': panel => {
    if (panel !== undefined && panel !== 'guide' && panel !== 'settings') throw new UserError('无效的 Pane 页面。');
    if (panel === 'guide') openGuidance(); else show(panel);
  },
  'window:list': () => captureBridge.list(settings.denied),
  'capture:bind': async id => {
    if (desktopUnavailable()) throw new UserError('请先解锁 Windows 桌面。');
    cancelTools();
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
    if (!compact && !settings.screenAwarenessEnabled) await captureWindow(target, generation);
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
  'guidance:state': () => guidance.state,
  'guidance:open': openGuidance,
  'guidance:start': async (task, includeImage, region) => {
    assertIdle();
    overlay.clear();
    location.clear();
    return guidance.start(authorizedWindow(), task, includeImage, region);
  },
  'guidance:check': () => guidance.check(authorizedWindow()),
  'guidance:confirm': skip => guidance.confirm(authorizedWindow(), skip === true),
  'guidance:next': () => {
    overlay.clear();
    location.clear();
    return guidance.next(authorizedWindow());
  },
  'guidance:pause': pause => {
    if (typeof pause !== 'boolean') throw new UserError('无效的教学状态。');
    overlay.clear();
    location.clear();
    return guidance.pause(authorizedWindow(), pause);
  },
  'guidance:exit': () => cancelTools(),
  'ui:clear': () => { overlay.clear(); location.clear(); },
  'ui:highlight': (ids, style) => {
    const scope = authorizedWindow();
    if (!Array.isArray(ids) || !ids.length || ids.length > 6 || ids.some(id => typeof id !== 'string') ||
        !['outline', 'shade', 'arrow', 'number', 'label', 'sequence'].includes(style) || !location.eligible(ids, scope.target)) {
      throw new UserError('高亮目标已失效，或无法安全映射图像坐标。请重新定位。');
    }
    overlay.show(style, async signal => {
      const token = AbortSignal.any([scope.signal, signal]);
      const geometry = await captureBridge.geometry(scope.target, scope.denied, token);
      const markers = await location.resolve(ids, { ...scope, signal: token }, geometry);
      return markers ? { geometry, markers } : null;
    });
  },
  'ui:locate': async (query, allowVision, region) => {
    overlay.clear();
    if (typeof allowVision !== 'boolean') throw new UserError('无效的图像权限选项。');
    return location.locate(authorizedWindow(), query, allowVision, region);
  },
  'ui:roi': async region => {
    const { target, denied, signal } = authorizedWindow();
    return captureBridge.captureRegion(target, denied, region, regionUnits(region), signal);
  },
  'ui:changeRoi': async index => {
    const { target, denied, signal } = authorizedWindow();
    const state = observations.current;
    const region = Number.isSafeInteger(index) && state.phase === 'watching' && state.latest?.targetId === target.id
      ? state.latest.changedRegions[index] : undefined;
    if (!region) throw new UserError('当前没有可用的变化区域。');
    return captureBridge.captureRegion(target, denied, region, regionUnits(region), signal);
  },
  'ui:inspect': async () => {
    const { target, denied, signal } = authorizedWindow();
    return detector.inspect(target, denied, signal);
  },
  'ui:findElement': async query => {
    const { target, denied, signal } = authorizedWindow();
    return matchElements(await detector.inspect(target, denied, signal), query);
  },
  'ui:getElement': async id => {
    const { target, denied, signal } = authorizedWindow();
    return detector.get(target, denied, id, signal);
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
  'account:models': async force => {
    const provider = settings.provider;
    const models = await ai.models(provider, force === true);
    if (models.length && settings.provider === provider && !models.some(model => model.id === settings.models[provider])) {
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
    if (inputSessions.conversationId === id) invalidateSend('该对话已删除。');
    store.remove(id);
    chat.deleteImages(id);
    if (activeId === id) activeId = null;
  },
  'chat:send': (id, text, shotId, use) => input.send(id, text, shotId, false, use),
  'chat:retry': (id, shotId, use) => input.send(id, '', shotId, true, use),
  'chat:stop': () => { invalidateSend('已停止准备本轮请求。'); chat.stop(); },
};

function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Pane 主窗口', click: () => show() },
    { label: '打开桌面指导', click: openGuidance },
    { label: '隐藏聊天窗口', click: hide },
    { label: '显示浮动助手', type: 'checkbox', checked: settings.companionEnabled,
      click: item => { saveSettings({ ...settings, companionEnabled: item.checked }); send('settings', settings); } },
    { type: 'separator' },
    { label: '退出 Pane', click: () => app.quit() },
  ]));
}

function launch() {
  const dataDir = app.getPath('userData');
  store = new Store(join(dataDir, 'pane.sqlite'));
  settings = store.settings();
  const saved = store.read<string>('active');
  activeId = saved && store.has(saved) ? saved : store.list()[0]?.id ?? null;

  for (const key of ['OPENAI_CUSTOM_HEADERS', 'OPENAI_LOG']) delete process.env[key];

  restrictSession(session.defaultSession);
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
  win.on('focus', () => { overlay.hide(); tracker.hide(); });
  companion = new CompanionWindow(rendererFile, join(__dirname, 'preload.cjs'), store.read('companion.position'),
    point => store.write('companion.position', point), () => {
      if (compact && win.isVisible() && !win.isMaximized()) win.setBounds(companion.panelBounds);
    });
  const displaysChanged = () => { overlay.hide(); tracker.hide(); companion.reposition(); };
  screen.on('display-metrics-changed', displaysChanged);
  screen.on('display-added', displaysChanged);
  screen.on('display-removed', displaysChanged);
  ai = new AI(store, dataDir, account => send('account', account));
  chat = new Chat(store, ai, update => { send('chat', update); syncCompanion(); });
  observations.configure(null, settings, settings.denied);
  const pauseDesktop = () => {
    cancelTools();
    invalidateSend('Windows 桌面不可用，本轮发送已停止。');
    chat.stop();
    observations.pause();
    if (compact && win.isVisible()) win.hide();
    cancelCapture(true);
    syncCompanion();
  };
  powerMonitor.on('lock-screen', () => { locked = true; pauseDesktop(); });
  powerMonitor.on('unlock-screen', () => { locked = false; syncCompanion(); });
  powerMonitor.on('suspend', () => { suspended = true; pauseDesktop(); });
  powerMonitor.on('resume', () => { suspended = false; syncCompanion(); });
  ipcMain.handle('pane:call', async (event, action: keyof Actions, args: unknown[]) => {
    const frame = event.senderFrame;
    const fromMain = ownFrame(frame, win.webContents.mainFrame, expectedURL);
    const fromMascot = frame && companion.accepts(frame) &&
      (action === 'companion:appearance' || action === 'companion:toggle');
    if ((!fromMain && !fromMascot) || !Object.hasOwn(actions, action) || !Array.isArray(args)) return { ok: false, error: '此操作不可用。' };
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
  updateTray();
  tray.on('click', () => win.isVisible() && win.isFocused() ? hide() : show());

  win.once('ready-to-show', () => {
    ready = true;
    if (process.argv.includes('--show-main') || (!settings.companionEnabled && (!process.argv.includes('--hidden') || !shortcut))) show();
    else syncCompanion();
  });
  void win.loadFile(rendererFile);
}

const profileDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (isAbsolute(profileDirectory)) app.setPath('userData', profileDirectory);
app.setAppUserModelId('local.pane.desktop-companion');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => show());
  app.on('before-quit', () => { quitting = true; companion?.savePosition(); cancelTools(); invalidateSend('Pane 正在退出。'); supersedeCapture(); observations.dispose(); chat?.shutdown(); ai?.cancelSignIn(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); store?.close(); });
  app.whenReady().then(launch).catch(() => app.exit(1));
}
