import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ViewerConfig } from './config';

export class ViewerError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

export interface CameraInput {
  ffmpegPath: string;
  inputArguments: string[];
  env?: NodeJS.ProcessEnv;
  codec?: string;
  refreshAt?: number;
  refresh?: () => Promise<number | undefined>;
  warning?: string;
}

interface Session {
  id: string;
  token: string;
  directory?: string;
  process?: ChildProcess;
  exited?: Promise<void>;
  ready: Promise<void>;
  touched: number;
  stopped: boolean;
  error?: ViewerError;
  warning?: string;
  refreshTimer?: NodeJS.Timeout;
}

async function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ViewerError(message)), ms);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}

export class StreamPool {
  private sessions = new Map<string, Session>();
  private closing = false;
  private timer: NodeJS.Timeout;

  constructor(private openInput: (id: string) => Promise<CameraInput>,
    private config: () => ViewerConfig, private idleMs = 45_000,
    private warn: (message: string) => void = console.warn) {
    this.timer = setInterval(() => { void this.sweep(); }, Math.min(idleMs, 5000));
    this.timer.unref();
  }

  async ensure(id: string): Promise<{ playlist: string; warning?: string }> {
    if (this.closing) throw new ViewerError('Viewer is restarting. Retry shortly.');
    let session = this.sessions.get(id);
    if (session?.directory && !session.error) {
      const manifest = await fs.stat(path.join(session.directory, 'index.m3u8')).catch(() => undefined);
      if (manifest && Date.now() - manifest.mtimeMs > 25_000)
        session.error = new ViewerError('Camera stopped delivering video.');
    }
    if (session?.error) { await this.stopSession(session); return this.ensure(id); }
    if (!session) {
      session = { id, token: randomBytes(12).toString('hex'), touched: Date.now(), stopped: false, ready: Promise.resolve() };
      this.sessions.set(id, session);
      const current = session;
      current.ready = this.launch(current).catch(async error => {
        await this.stopSession(current);
        throw error;
      });
    }
    session.touched = Date.now();
    await session.ready;
    this.assertActive(session);
    return { playlist: `hls/${encodeURIComponent(id)}/${session.token}/index.m3u8`, ...(session.warning ? { warning: session.warning } : {}) };
  }

  private assertActive(session: Session) {
    if (session.error) throw session.error;
    if (session.stopped || this.closing) throw new ViewerError('Playback session closed. Reconnect the camera.');
  }

  private async launch(session: Session) {
    const mode = this.config().videoMode;
    const input = await within(this.openInput(session.id), 15_000, 'Camera did not provide a stream. Check its connection and Rebroadcast settings.');
    this.assertActive(session);
    session.warning = input.warning;
    if (!input.inputArguments.length || input.inputArguments.some(arg => typeof arg !== 'string'))
      throw new ViewerError('Camera returned invalid stream arguments.');
    if (mode === 'copy' && input.codec && !['h264', 'avc', 'avc1'].includes(input.codec.toLowerCase()))
      throw new ViewerError('This stream is not H.264. Open Cameras to choose an H.264 source, or enable transcode in the plugin settings.', 422);
    session.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scrypted-live-viewer-'));
    this.assertActive(session);
    const encoding = mode === 'copy' ? ['-c:v', 'copy'] : [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
    ];
    const child = spawn(input.ffmpegPath, [
      '-hide_banner', '-loglevel', 'warning', '-nostdin', ...input.inputArguments,
      '-map', '0:v:0', '-an', '-sn', '-dn', ...encoding,
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '6', '-hls_delete_threshold', '4',
      '-hls_flags', 'delete_segments+temp_file+omit_endlist', '-start_number', '0',
      '-hls_segment_filename', path.join(session.directory, 'segment-%09d.ts'),
      path.join(session.directory, 'index.m3u8'),
    ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...input.env } });
    session.process = child;
    // Drain stderr without exposing source URLs, passwords, or FFmpeg arguments.
    child.stderr?.resume();
    session.exited = new Promise(resolve => {
      child.once('error', () => {
        session.error = new ViewerError('Could not start FFmpeg. Check the Scrypted FFmpeg installation.');
      });
      child.once('close', code => {
        if (!session.stopped && !session.error) {
          session.error = new ViewerError(`Camera playback stopped (FFmpeg exit ${code ?? 'signal'}). Check the camera and video mode in plugin settings.`);
          this.warn(`Viewer playback stopped for camera ${session.id}; FFmpeg exit ${code ?? 'signal'}.`);
        }
        resolve();
      });
    });
    if (input.refresh) this.scheduleRefresh(session, input, input.refreshAt);
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      this.assertActive(session);
      const manifest = await fs.readFile(path.join(session.directory, 'index.m3u8'), 'utf8').catch(() => '');
      if (manifest.includes('#EXTINF:') && /segment-\d+\.ts/.test(manifest)) return;
      await delay(100);
    }
    throw new ViewerError('No video arrived within 25 seconds. Check the camera, select H.264, and set its keyframe interval to 1–2 seconds.');
  }

  private scheduleRefresh(session: Session, input: CameraInput, refreshAt?: number) {
    if (!refreshAt || session.stopped) return;
    session.refreshTimer = setTimeout(() => {
      if (session.stopped) return;
      void within(input.refresh!(), 15_000, 'Camera stream refresh timed out.').then(next => {
        this.scheduleRefresh(session, input, next);
      }).catch(() => {
        if (!session.stopped) session.error = new ViewerError('Camera session expired. Reconnect to request a fresh stream.');
      });
    }, Math.max(1000, refreshAt - Date.now() - 10_000));
    session.refreshTimer.unref();
  }

  async read(id: string, token: string, filename: string): Promise<Buffer> {
    if (!/^(index\.m3u8|segment-\d{9,}\.ts)$/.test(filename)) throw new ViewerError('Not found.', 404);
    const session = this.sessions.get(id);
    if (!session || session.token !== token || session.stopped || !session.directory)
      throw new ViewerError('Playback session expired. Reconnect the camera.', 404);
    this.assertActive(session);
    session.touched = Date.now();
    try { return await fs.readFile(path.join(session.directory, filename)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ViewerError('Live segment expired. Reconnect the camera.', 404);
      throw error;
    }
  }

  async stop(id: string) {
    const session = this.sessions.get(id);
    if (session) await this.stopSession(session);
  }

  private async stopSession(session: Session) {
    session.stopped = true;
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    clearTimeout(session.refreshTimer);
    const child = session.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
      kill.unref();
      await session.exited;
      clearTimeout(kill);
    }
    if (session.directory) await fs.rm(session.directory, { recursive: true, force: true });
  }

  async sweep(now = Date.now()) {
    await Promise.all([...this.sessions.values()].filter(session => now - session.touched > this.idleMs)
      .map(session => this.stopSession(session)));
  }

  killImmediately() {
    for (const session of this.sessions.values()) session.process?.kill('SIGKILL');
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.sessions.values()].map(session => this.stopSession(session)));
  }
}
