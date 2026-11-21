import { BrowserWindow, screen, type Point, type WebFrameMain } from 'electron';
import { pathToFileURL } from 'node:url';
import type { PixelRect } from '../shared';
import type { SelectionView } from '../selection';
import { ownFrame } from './permission-manager';
import { selectionPosition } from './selection-position';

export class SelectionToolbar {
  private win?: BrowserWindow;
  private rectangles: PixelRect[] = [];
  private pointer?: Point;
  private version = 0;
  private readonly url: string;

  constructor(private readonly html: string, private readonly preload: string, private readonly dismiss: () => void) {
    this.url = pathToFileURL(html).href + '#selection';
  }

  accepts(frame: WebFrameMain | null) {
    return !!this.win && !this.win.isDestroyed() && ownFrame(frame, this.win.webContents.mainFrame, this.url);
  }
  get visible() { return this.win?.isVisible() ?? false; }
  get focused() { return this.win?.isFocused() ?? false; }

  contains(point: Point) {
    if (!this.visible || !this.win) return false;
    const b = this.win.getBounds();
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  }

  async show(rectangles: PixelRect[], view: SelectionView, focus = false) {
    const version = ++this.version;
    this.rectangles = rectangles.map(rect => {
      const start = screen.screenToDipPoint({ x: rect.x, y: rect.y });
      const end = screen.screenToDipPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
      return { ...start, width: Math.max(1, end.x - start.x), height: Math.max(1, end.y - start.y) };
    });
    const anchor = this.rectangles.at(-1);
    this.pointer = anchor ? { x: anchor.x, y: anchor.y } : screen.getCursorScreenPoint();
    const bounds = this.placement(view);
    if (!bounds) return false;
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        ...bounds, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, show: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
        title: 'Pane 划词', webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.win = win;
      win.setContentProtection(true);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      const created = win;
      win.on('blur', () => setImmediate(() => {
        if (this.win === created && !created.isDestroyed() && !created.isFocused()) this.dismiss();
      }));
      win.on('closed', () => { if (this.win === created) { this.win = undefined; this.dismiss(); } });
      try { await win.loadFile(this.html, { hash: 'selection' }); }
      catch { if (version === this.version) this.close(); return false; }
    }
    if (version !== this.version || win.isDestroyed()) return false;
    win.setBounds(bounds);
    this.update(view);
    if (focus) win.show();
    else win.showInactive();
    return true;
  }

  update(view: SelectionView) {
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.placement(view);
    if (bounds) this.win.setBounds(bounds);
    this.win.webContents.send('pane:selection:view', view);
  }

  private placement(view: SelectionView) {
    if (!this.pointer) return null;
    const work = screen.getDisplayNearestPoint(this.pointer).workArea;
    const bounds = selectionPosition(work, this.pointer, this.rectangles, !!(view.notice || view.answer || view.details));
    if (!bounds || !view.badge) return bounds;
    return { ...bounds, width: Math.min(32, bounds.width), height: Math.min(32, bounds.height) };
  }

  close() {
    this.version++;
    const win = this.win;
    this.win = undefined;
    this.rectangles = [];
    this.pointer = undefined;
    if (win && !win.isDestroyed()) {
      win.hide();
      setImmediate(() => { if (!win.isDestroyed()) win.destroy(); });
    }
  }
}
