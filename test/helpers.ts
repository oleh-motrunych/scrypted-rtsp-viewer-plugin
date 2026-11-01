import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { HttpResponse, HttpResponseOptions } from '@scrypted/sdk';

export const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
export const temporary = () => fs.mkdtemp(path.join(os.tmpdir(), 'viewer-test-'));
export function makeVideo(filename: string, size = '640x360') {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc2=size=${size}:rate=15`, '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-g', '15', '-an', '-y', filename], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('FFmpeg test fixture failed: ' + (result.error?.message || result.stderr));
}
export class CaptureResponse implements HttpResponse {
  code = 200;
  headers: Record<string, string> = {};
  body: Buffer = Buffer.alloc(0);
  file?: string;
  send(body: string | Buffer, options?: HttpResponseOptions) {
    this.code = options?.code ?? 200;
    this.headers = options?.headers as Record<string, string> || {};
    this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
  }
  sendFile(filename: string, options?: HttpResponseOptions) { this.file = filename; this.send('', options); }
  sendStream(): never { throw new Error('Unexpected streaming response.'); }
  sendSocket(): never { throw new Error('Unexpected socket response.'); }
  json() { return JSON.parse(this.body.toString()); }
}
