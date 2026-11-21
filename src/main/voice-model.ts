import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { VoiceModelState } from '../voice';
import { UserError } from './native';

const filename = 'ggml-small-q5_1.bin';
const url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/' + filename + '?download=true';
const sha256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';
const modelBytes = 190085487;

export class VoiceModel {
  private readonly path: string;
  private verified?: Promise<boolean>;
  private download?: AbortController;
  private progress = 0;

  constructor(private readonly directory: string, private readonly publish: (state: VoiceModelState) => void) {
    this.path = join(directory, filename);
  }

  async status(): Promise<VoiceModelState> {
    if (this.download) return { phase: 'downloading', progress: this.progress };
    return { phase: await this.available() ? 'ready' : 'missing' };
  }

  async requirePath() {
    if (this.download) throw new UserError('离线语音模型正在下载。完成后即可开始语音提问。');
    if (!await this.available()) throw new UserError('请先在「设置 → 语音」下载离线 Whisper 模型。');
    return this.path;
  }

  async install() {
    if (this.download || await this.available() || this.download) return;
    const operation = new AbortController();
    this.download = operation;
    this.progress = 0;
    this.publish({ phase: 'downloading', progress: 0 });
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(600_000)]);
    const temporary = join(this.directory, randomUUID() + '.part');
    let ready = false;
    try {
      await mkdir(this.directory, { recursive: true });
      const response = await fetch(url, { signal, credentials: 'omit' });
      if (!response.ok || !response.body) throw new Error('Model unavailable');
      const digest = createHash('sha256');
      let received = 0;
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          if (received > modelBytes) { callback(new Error('Model too large')); return; }
          digest.update(chunk);
          const percentage = Math.floor(received * 100 / modelBytes);
          if (this.progress !== percentage) {
            this.progress = percentage;
            this.publish({ phase: 'downloading', progress: percentage });
          }
          callback(null, chunk);
        },
      }), createWriteStream(temporary, { flags: 'wx' }), { signal });
      if (received !== modelBytes || digest.digest('hex') !== sha256) {
        throw new UserError('离线模型的完整性校验失败，请重新下载。');
      }
      signal.throwIfAborted();
      await rename(temporary, this.path);
      this.verified = Promise.resolve(true);
      ready = true;
    } catch (error) {
      if (!operation.signal.aborted) {
        throw error instanceof UserError ? error : new UserError('离线模型下载失败，请检查网络和磁盘空间后重试。');
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      this.download = undefined;
      this.publish({ phase: ready ? 'ready' : 'missing' });
    }
  }

  cancel() { this.download?.abort(); }

  private available() {
    return this.verified ??= this.verify().then(valid => {
      if (!valid) this.verified = undefined;
      return valid;
    });
  }

  private async verify() {
    try {
      const entry = await stat(this.path);
      if (!entry.isFile() || entry.size !== modelBytes) return false;
      const digest = createHash('sha256');
      for await (const part of createReadStream(this.path)) digest.update(part);
      return digest.digest('hex') === sha256;
    } catch { return false; }
  }
}
