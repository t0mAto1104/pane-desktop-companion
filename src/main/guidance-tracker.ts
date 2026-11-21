import { BrowserWindow, screen } from 'electron';
import { sameRect } from './element-detector';
import type { GuidanceState, WindowGeometry } from '../shared';
import { trackerBounds, trackerDocument } from './guidance-tracker-view';

type Verify = (signal: AbortSignal) => Promise<WindowGeometry>;

export class GuidanceTracker {
  private window?: BrowserWindow;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private rendered = '';

  hide() {
    const win = this.window;
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  clear() {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.timer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
    this.rendered = '';
  }

  present(state: GuidanceState | null, verify: Verify) {
    const document = state && trackerDocument(state);
    if (!document) { this.clear(); return; }
    this.controller?.abort();
    clearTimeout(this.timer);
    const controller = new AbortController();
    this.controller = controller;
    const poll = async () => {
      let interval = 700;
      try {
        const { bounds, foreground } = await verify(controller.signal);
        if (controller.signal.aborted) return;
        if (!foreground) { this.hide(); return; }
        const center = screen.screenToDipPoint({
          x: bounds.x + Math.floor(bounds.width / 2),
          y: bounds.y + Math.floor(bounds.height / 2),
        });
        const placement = trackerBounds(screen.getDisplayNearestPoint(center).workArea);
        const win = this.window ?? this.createWindow(placement);
        if (!sameRect(win.getBounds(), placement)) win.setBounds(placement);
        if (this.rendered !== document) {
          await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(document));
          if (controller.signal.aborted || win.isDestroyed()) return;
          this.rendered = document;
        }
        if (!win.isVisible()) win.showInactive();
      } catch {
        if (!controller.signal.aborted) this.hide();
        interval = 1600;
      } finally {
        if (!controller.signal.aborted) this.timer = setTimeout(() => void poll(), interval);
      }
    };
    void poll();
  }

  private createWindow(bounds: Electron.Rectangle) {
    const win = new BrowserWindow({
      ...bounds, title: 'Pane 指导任务栏', frame: false, transparent: true, show: false, backgroundColor: '#00000000',
      focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.once('closed', () => {
      this.window = undefined;
      this.rendered = '';
    });
    this.window = win;
    return win;
  }
}
