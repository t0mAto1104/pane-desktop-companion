import { BrowserWindow, screen, type Point, type WebFrameMain } from 'electron';
import { pathToFileURL } from 'node:url';
import type { CompanionSkin, MascotState } from '../shared';
import { mascotBounds, panelBounds, savedPoint } from './companion-geometry';

const title = 'Pane · 浮动助手';

export class CompanionWindow {
  private window?: BrowserWindow;
  private loaded = false;
  private visible = false;
  private state: MascotState = { skin: 'orbit', busy: false };
  private position: Point | undefined;
  private positionTimer?: ReturnType<typeof setTimeout>;
  private readonly url: string;

  constructor(private readonly html: string, private readonly preload: string, initialPosition: unknown,
              private readonly persist: (point: Point) => void, private readonly moved: () => void) {
    this.url = pathToFileURL(html).href + '#mascot';
    this.position = savedPoint(initialPosition);
  }

  accepts(frame: WebFrameMain) {
    return !!this.window && !this.window.isDestroyed() && frame === this.window.webContents.mainFrame && frame.url === this.url;
  }

  appearance(): MascotState { return this.state; }

  update(visible: boolean, skin: CompanionSkin, busy: boolean) {
    this.visible = visible;
    const changed = this.state.skin !== skin || this.state.busy !== busy;
    this.state = { skin, busy };
    if (visible && !this.window) this.createWindow();
    const win = this.window;
    if (!win || win.isDestroyed() || !this.loaded) return;
    if (changed) win.webContents.send('pane:mascot', this.state);
    if (visible && !win.isVisible()) win.showInactive();
    else if (!visible && win.isVisible()) win.hide();
  }

  private get workArea() {
    return this.position ? screen.getDisplayNearestPoint(this.position).workArea : screen.getPrimaryDisplay().workArea;
  }

  get panelBounds() {
    const current = this.window?.getBounds();
    const work = current ? screen.getDisplayMatching(current).workArea : this.workArea;
    return panelBounds(work, mascotBounds(work, current ?? this.position));
  }

  reposition() {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    const current = win.getBounds();
    const next = mascotBounds(screen.getDisplayMatching(current).workArea, current);
    if (current.x !== next.x || current.y !== next.y) win.setPosition(next.x, next.y);
    this.remember(next.x, next.y);
    this.moved();
  }

  savePosition() {
    clearTimeout(this.positionTimer);
    this.reposition();
  }

  private remember(x: number, y: number) {
    if (this.position?.x === x && this.position.y === y) return;
    this.position = { x, y };
    this.persist(this.position);
  }

  private createWindow() {
    const win = new BrowserWindow({
      ...mascotBounds(this.workArea, this.position),
      title, frame: false, transparent: true, backgroundColor: '#00000000',
      alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false,
      resizable: false, maximizable: false, minimizable: false, hasShadow: false,
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    this.window = win;
    win.setContentProtection(true);
    win.on('page-title-updated', event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.once('ready-to-show', () => {
      this.loaded = true;
      win.webContents.send('pane:mascot', this.state);
      if (this.visible) win.showInactive();
    });
    win.on('move', () => {
      clearTimeout(this.positionTimer);
      this.positionTimer = setTimeout(() => this.savePosition(), 125);
    });
    win.on('moved', () => this.savePosition());
    win.once('closed', () => {
      clearTimeout(this.positionTimer);
      this.loaded = false;
      this.window = undefined;
    });
    void win.loadFile(this.html, { hash: 'mascot' }).catch(() => { if (!win.isDestroyed()) win.destroy(); });
  }
}
