import { BrowserWindow, screen } from 'electron';
import type { HighlightStyle, PixelRect, WindowGeometry } from '../shared';
import { safeOverlayBounds } from './overlay-geometry';

type Marker = { rect: PixelRect; name: string; source: 'uia' | 'vision' };
type Verify = (signal: AbortSignal) => Promise<{ geometry: WindowGeometry; markers: Marker[] } | null>;
const duration = 16_000;
const escape = (label: string) => label.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);

export class OverlayManager {
  private window?: BrowserWindow;
  private controller?: AbortController;
  private next?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private rendered = '';

  hide() { if (this.window && !this.window.isDestroyed()) this.window.hide(); }

  clear() {
    this.controller?.abort();
    this.controller = undefined;
    clearTimeout(this.next);
    clearTimeout(this.expiry);
    clearTimeout(this.watchdog);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
    this.rendered = '';
  }

  show(style: HighlightStyle, verify: Verify) {
    this.clear();
    const controller = new AbortController();
    this.controller = controller;
    const started = performance.now();
    this.expiry = setTimeout(() => this.clear(), duration);
    const poll = async () => {
      if (controller.signal.aborted) return;
      // If native validation stalls, stop showing the previously verified position.
      this.watchdog = setTimeout(() => this.hide(), 800);
      try {
        const validated = await verify(controller.signal);
        if (controller.signal.aborted) return;
        if (!validated || !validated.geometry.foreground || !validated.markers.length) this.hide();
        else await this.render(validated.geometry, validated.markers, style, Math.floor((performance.now() - started) / 1500), controller.signal);
      } catch { if (!controller.signal.aborted) this.hide(); }
      finally {
        if (!controller.signal.aborted) {
          clearTimeout(this.watchdog);
          this.next = setTimeout(() => void poll(), 420);
        }
      }
    };
    void poll();
  }

  private async render(geometry: WindowGeometry, markers: Marker[], style: HighlightStyle, tick: number, signal: AbortSignal) {
    const mapped = markers.map(marker => safeOverlayBounds(marker.rect, geometry.dpi, {
      toDip: point => screen.screenToDipPoint(point),
      toScreen: point => screen.dipToScreenPoint(point),
      displayAt: point => screen.getDisplayNearestPoint(point),
    }));
    if (mapped.some(item => !item || item.displayId !== mapped[0]?.displayId)) { this.hide(); return; }
    const rects = mapped.map(item => item!.bounds);
    const left = Math.min(...rects.map(rect => rect.x));
    const top = Math.min(...rects.map(rect => rect.y));
    const bounds = { x: left, y: top,
      width: Math.max(...rects.map(rect => rect.x + rect.width)) - left,
      height: Math.max(...rects.map(rect => rect.y + rect.height)) - top };
    const active = tick % markers.length;
    const data = rects.map((rect, index) => {
      if (style === 'sequence' && index !== active) return '';
      const kind = markers[index].source === 'vision' ? ' estimated' : '';
      const text = style === 'label' ? escape(markers[index].name.slice(0, 36))
        : style === 'number' || style === 'sequence' ? String(index + 1) : style === 'arrow' ? '→' : '';
      return `<div class="mark ${style}${kind}" style="left:${rect.x-left}px;top:${rect.y-top}px;width:${rect.width}px;height:${rect.height}px"><span>${text}</span></div>`;
    }).join('');
    let window = this.window;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({ ...bounds, title: 'Pane Overlay', transparent: true, frame: false, show: false,
        focusable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      window.setContentProtection(true);
      window.setIgnoreMouseEvents(true);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.window = window;
    }
    window.setBounds(bounds);
    if (data !== this.rendered) {
      const html = `<!doctype html><title>Pane Overlay</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
        <style>body{margin:0;font:700 12px system-ui;color:white;overflow:hidden}
        .mark{box-sizing:border-box;position:absolute;border:3px solid #6657ff;border-radius:7px;overflow:hidden}
        .shade{background:#6657ff50}.estimated{border-style:dashed;border-color:#e2a22d}
        span:not(:empty){display:inline-block;background:#4435d5;padding:1px 5px;border-radius:2px}
        .arrow span{font-size:20px;line-height:1}.number span,.sequence span{border-radius:40px}</style>${data}`;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      signal.throwIfAborted();
      this.rendered = data;
    }
    if (!window.isVisible()) window.showInactive();
  }
}
