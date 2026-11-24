import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { RegionCapture, ScreenRegion, Screenshot, Target, UiElement, WindowGeometry } from '../shared';

import type { SelectionRead } from '../selection';

export class UserError extends Error {}

export class CaptureError extends UserError {
  constructor(readonly code: string, message: string) { super(message); }
}

export function sameTarget(actual: Target, expected: Target) {
  return actual.id === expected.id && actual.executable.toLowerCase() === expected.executable.toLowerCase();
}

function windowArgs(target: Target, denied: string[]) {
  return [target.id, '--expected-executable', target.executable, ...denied];
}

const messages: Record<string, string> = {
  desktop_locked: '桌面已锁定或不可访问。解锁后可恢复屏幕观察。',
  screen_permission: 'Pane 缺少屏幕录制权限。请在 Pane 设置中打开系统权限并允许捕获。',
  accessibility_permission: 'Pane 缺少辅助功能权限。在 Pane 设置中打开系统权限后可使用划词和控件定位。',
  uia_unavailable: '目标窗口未提供可用的辅助功能控件树。可使用截图定位。',
  roi_invalid: '局部截图超出目标窗口。',
  roi_too_large: '局部截图超过 1200 万像素。请选择较小区域。',
  no_target: '没有可捕获的前台窗口。请先切换到目标窗口，或在窗口列表中选择。',
  target_gone: '目标窗口已关闭或不可用。请重新选择窗口。',
  process_unavailable: '无法验证目标应用的身份。请切换到可访问的普通窗口。',
  minimized: '目标窗口已最小化。还原后可恢复观察或刷新截图。',
  blocked: '该应用在禁止捕获名单中。',
  protected: '目标窗口启用了内容保护。',
  unsupported: '此设备或桌面会话无法使用 Windows.Graphics.Capture。',
  resized: '捕获时窗口尺寸发生了变化。请重试。',
  no_frame: '系统在限时内没有返回画面。请还原窗口并重试。',
  invalid_size: '窗口尺寸超出可捕获范围。请缩小窗口。',
  image_too_large: '截图过大，请缩小目标窗口。',
  key_dialog_failed: '无法打开系统凭据输入框。',
};

function nativeDiagnostic(code: string, fallback: string, fallbackCode = 'native_failed'): CaptureError {
  if (Object.hasOwn(messages, code)) return new CaptureError(code, messages[code]);
  if (/^capture_hresult:[0-9A-F]{8}$/.test(code)) {
    return new CaptureError("capture_hresult", "Windows 无法捕获该窗口（0x" + code.split(':')[1] + "）。请确认窗口开放且允许捕获。");
  }
  return new CaptureError(fallbackCode, fallback);
}

export class NativeBridge {
  constructor(private readonly path: string) {}

  private run(command: string, args: string[], timeout = 5000, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(this.path, [command, String(process.pid), ...args], {
        windowsHide: true, encoding: 'buffer', timeout, signal, maxBuffer: 13 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (signal?.aborted) return reject(signal.reason);
        if (!error) return resolve(stdout);
        const code = stderr.toString().trim();
        if (code === 'key_cancelled') return resolve(Buffer.alloc(0));
        reject(nativeDiagnostic(code, error.killed ? '系统操作超时。请重试。'
          : error.code === 'ENOENT' ? '缺少原生组件。请重新安装应用。' : '系统操作失败。请重试。', error.killed ? 'timeout' : 'native_failed'));
      });
    });
  }

  async readSelection(denied: string[], signal: AbortSignal): Promise<SelectionRead> {
    const result = await this.run('selection', denied, 1800, signal);
    return JSON.parse(result.toString());
  }

  watchSelection(signal: AbortSignal, notify: (event: string) => void, denied: string[]) {
    const worker = spawn(this.path, ['selection-watch', String(process.pid), ...(process.platform === 'darwin' ? denied : [])], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal,
    });
    worker.on('error', () => {});
    worker.stdout.setEncoding('utf8');
    let pending = '';
    worker.stdout.on('data', (text: string) => {
      if (signal.aborted) return;
      pending = (pending + text).slice(-4096);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (['focus', 'click', 'drag', 'selection'].includes(line)) notify(line);
    });
  }

  async foreground(denied: string[]): Promise<Target> { return JSON.parse((await this.run('foreground', denied)).toString()); }
  async list(denied: string[]): Promise<Target[]> { return JSON.parse((await this.run('list', denied)).toString()); }

  async requestScreenPermission(): Promise<boolean> {
    return JSON.parse((await this.run('screen-permission', [], 30_000)).toString()) === true;
  }

  async validate(target: Target, denied: string[], signal?: AbortSignal): Promise<void> {
    const verified: Target = JSON.parse((await this.run('verify', windowArgs(target, denied), 1000, signal)).toString());
    if (!sameTarget(verified, target)) throw new CaptureError('target_gone', messages.target_gone);
  }

  async geometry(target: Target, denied: string[], signal?: AbortSignal): Promise<WindowGeometry> {
    return JSON.parse((await this.run('geometry', windowArgs(target, denied), 900, signal)).toString());
  }

  async inspectAutomation(target: Target, denied: string[], signal: AbortSignal): Promise<{
    geometry: WindowGeometry; tree: { elements: Array<Omit<UiElement, 'role'>>; truncated: boolean };
  }> {
    return JSON.parse((await this.run('uia', windowArgs(target, denied), 1900, signal)).toString());
  }

  async capture(target: Target, denied: string[], signal?: AbortSignal, timeout = 5000): Promise<Screenshot> {
    const capturedAt = Date.now();
    const result = await this.run('capture', windowArgs(target, denied), timeout, signal);
    const separator = result.indexOf(10);
    const jpeg = result.subarray(separator + 1);
    if (separator < 1 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new CaptureError('invalid_image', '捕获组件返回了无效的截图。');
    const verified: Target = JSON.parse(result.subarray(0, separator).toString());
    if (!sameTarget(verified, target)) throw new CaptureError('target_gone', messages.target_gone);
    return { id: randomUUID(), target: verified, image: 'data:image/jpeg;base64,' + jpeg.toString('base64'), capturedAt };
  }

  async captureRegion(target: Target, denied: string[], region: ScreenRegion,
                      units: number[], signal: AbortSignal): Promise<RegionCapture> {
    const [id, option, executable, ...blocked] = windowArgs(target, denied);
    const capturedAt = Date.now();
    const result = await this.run('roi', [id, option, executable, ...units.map(String), ...blocked], 3400, signal);
    const separator = result.indexOf(10);
    const jpeg = result.subarray(separator + 1);
    if (separator < 1 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new CaptureError('invalid_image', '捕获组件返回了无效的局部截图。');
    const metadata = JSON.parse(result.subarray(0, separator).toString()) as Pick<RegionCapture, 'target' | 'geometry' | 'pixels' | 'frameSize'>;
    if (!sameTarget(metadata.target, target)) throw new CaptureError('target_gone', messages.target_gone);
    return { ...metadata, region, capturedAt, id: randomUUID(), image: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
  }

  observe(target: Target, denied: string[]): CaptureWorker {
    return new NativeCaptureWorker(this.path, target, denied);
  }

  async keyPrompt(hwnd: Buffer): Promise<string | undefined> {
    const args = process.platform === 'win32'
      ? [(hwnd.length === 8 ? hwnd.readBigUInt64LE() : BigInt(hwnd.readUInt32LE())).toString()] : [];
    const buffer = await this.run('credential', args, 180_000);
    try { return buffer.toString().trim() || undefined; }
    finally { buffer.fill(0); }
  }
}

export type FrameSample = { target: Target; width: number; height: number; dpi: number; pixels: Buffer };

export interface CaptureWorker {
  sample(): Promise<FrameSample>;
  jpeg(): Promise<Screenshot>;
  close(): void;
}

export const SAMPLE_WIDTH = 96;
export const SAMPLE_HEIGHT = 54;
export const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3;
const MAX_JPEG_BYTES = 12 * 1024 * 1024;
type Kind = 'sample' | 'jpeg';
type Header = Omit<FrameSample, 'pixels'> & { kind: Kind; bytes: number };
type Packet = { header: Header; payload: Buffer };
type Pending = {
  kind: Kind; resolve: (packet: Packet) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
  header?: Header; prefix: Buffer; chunks: Buffer[]; length: number;
};

class NativeCaptureWorker implements CaptureWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: Pending;
  private failure?: UserError;
  private stderr = '';

  constructor(path: string, private readonly target: Target, denied: string[]) {
    this.child = spawn(path, ['observe', String(process.pid), ...windowArgs(target, denied)], { windowsHide: true, stdio: 'pipe' });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(0, 512); });
    this.child.stdin.on('error', () => undefined); // The exit handler supplies the diagnostic from stderr.
    this.child.once('error', () => this.abort(new CaptureError('native_failed', '无法启动屏幕观察组件。可尝试手动刷新截图。')));
    this.child.once('close', () => this.abort(nativeDiagnostic(this.stderr.trim(), '屏幕观察组件已退出。可尝试手动刷新截图。', 'worker_exit')));
  }

  async sample(): Promise<FrameSample> {
    const { header, payload } = await this.request('sample');
    return { target: header.target, width: header.width, height: header.height, dpi: header.dpi, pixels: payload };
  }

  async jpeg(): Promise<Screenshot> {
    const { header, payload } = await this.request('jpeg');
    if (payload[0] !== 0xff || payload[1] !== 0xd8) throw new UserError('Windows 返回了无效的观察截图。');
    return { id: randomUUID(), target: header.target, image: 'data:image/jpeg;base64,' + payload.toString('base64'), capturedAt: Date.now() };
  }

  close() { this.abort(new UserError('屏幕观察已停止。')); }

  private abort(error: UserError) {
    if (this.failure) return;
    this.failure = error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
    this.child.kill();
  }

  private request(kind: Kind): Promise<Packet> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new UserError('已有屏幕观察请求正在处理。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.abort(new CaptureError('timeout', '屏幕观察超时。可尝试手动刷新截图。')), 5000);
      this.pending = { kind, resolve, reject, timer, prefix: Buffer.alloc(0), chunks: [], length: 0 };
      this.child.stdin.write(kind + '\n');
    });
  }

  private onData(data: Buffer) {
    const pending = this.pending;
    if (!pending) { this.invalidPacket(); return; }
    if (!pending.header) {
      const joined = pending.prefix.length ? Buffer.concat([pending.prefix, data]) : data;
      const end = joined.indexOf(10);
      if (end < 0 && joined.length <= 8192) { pending.prefix = joined; return; }
      if (end < 0 || end > 8192) { this.invalidPacket(); return; }
      try {
        const header = JSON.parse(joined.subarray(0, end).toString()) as Header;
        if (!this.validHeader(header, pending.kind)) { this.invalidPacket(); return; }
        pending.header = header;
      } catch { this.invalidPacket(); return; }
      pending.prefix = Buffer.alloc(0);
      data = joined.subarray(end + 1);
    }
    pending.chunks.push(data);
    pending.length += data.length;
    if (pending.length > pending.header.bytes) { this.invalidPacket(); return; }
    if (pending.length === pending.header.bytes) {
      clearTimeout(pending.timer);
      this.pending = undefined;
      pending.resolve({ header: pending.header, payload: Buffer.concat(pending.chunks, pending.length) });
    }
  }

  private invalidPacket() { this.abort(new UserError('观察组件返回了无效数据。')); }

  private validHeader(header: Header, kind: Kind) {
    if (!header || header.kind !== kind || header.target?.id !== this.target.id ||
        typeof header.target.title !== 'string' || typeof header.target.executable !== 'string' ||
        header.target.executable.toLowerCase() !== this.target.executable.toLowerCase()) return false;
    const geometry = Number.isInteger(header.width) && header.width >= 1 && header.width <= 8192 &&
      Number.isInteger(header.height) && header.height >= 1 && header.height <= 8192 &&
      Number.isInteger(header.dpi) && header.dpi > 0;
    return geometry && (kind === 'sample' ? header.bytes === SAMPLE_BYTES :
      Number.isInteger(header.bytes) && header.bytes >= 2 && header.bytes <= MAX_JPEG_BYTES);
  }
}
