import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Screenshot, Target } from '../shared';

export class UserError extends Error {}

const messages: Record<string, string> = {
  no_target: '没有可捕获的前台窗口。请先切换到目标窗口，或在窗口列表中选择。',
  target_gone: '目标窗口已关闭或不可用。请重新选择窗口。',
  process_unavailable: '无法验证目标应用的身份。请切换到可访问的普通窗口。',
  minimized: '目标窗口已最小化。还原后再刷新截图。',
  blocked: '该应用在禁止捕获名单中。',
  protected: '目标窗口启用了 Windows 内容保护。',
  unsupported: '此设备或桌面会话无法使用 Windows.Graphics.Capture。',
  resized: '捕获时窗口尺寸发生了变化。请重试。',
  no_frame: 'Windows 在限时内没有返回画面。请还原窗口并重试。',
  invalid_size: '窗口尺寸超出可捕获范围。请缩小窗口。',
  image_too_large: '截图过大，请缩小目标窗口。',
  key_dialog_failed: '无法打开 Windows 凭据输入框。',
};

export class NativeBridge {
  constructor(private readonly path: string) {}

  private run(command: string, args: string[], timeout = 5000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(this.path, [command, String(process.pid), ...args], {
        windowsHide: true, encoding: 'buffer', timeout, maxBuffer: 13 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = stderr.toString().trim();
        if (code === 'key_cancelled') return resolve(Buffer.alloc(0));
        if (messages[code]) return reject(new UserError(messages[code]));
        if (/^capture_hresult:[0-9A-F]{8}$/.test(code)) {
          return reject(new UserError(`Windows 无法捕获该窗口（0x${code.split(':')[1]}）。请确认窗口开放且允许捕获。`));
        }
        reject(new UserError(error.killed ? 'Windows 操作超时。请重试。'
          : error.code === 'ENOENT' ? '缺少 Windows 捕获组件。请重新安装应用。' : 'Windows 操作失败。请重试。'));
      });
    });
  }

  async foreground(denied: string[]): Promise<Target> { return JSON.parse((await this.run('foreground', denied)).toString()); }
  async list(denied: string[]): Promise<Target[]> { return JSON.parse((await this.run('list', denied)).toString()); }

  async capture(target: Target, denied: string[]): Promise<Screenshot> {
    const result = await this.run('capture', [target.id, ...denied]);
    const separator = result.indexOf(10);
    const jpeg = result.subarray(separator + 1);
    if (separator < 1 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new UserError('Windows 返回了无效的截图。');
    return { id: randomUUID(), target: JSON.parse(result.subarray(0, separator).toString()), image: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
  }

  async keyPrompt(hwnd: Buffer): Promise<string | undefined> {
    const handle = hwnd.length === 8 ? hwnd.readBigUInt64LE() : BigInt(hwnd.readUInt32LE());
    const buffer = await this.run('credential', [handle.toString()], 180_000);
    try { return buffer.toString().trim() || undefined; }
    finally { buffer.fill(0); }
  }
}
