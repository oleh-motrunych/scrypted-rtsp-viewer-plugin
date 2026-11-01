import type { HttpRequest, HttpResponse } from '@scrypted/sdk';
import { StreamPool, ViewerError } from './streams';

export interface ViewerCamera { id: string; name: string; rebroadcast: boolean; }
export interface CameraStreamChoices {
  id: string;
  value: string;
  choices: { value: string; label: string }[];
  warning?: string;
}
export interface ViewerStreamSettings { defaultPolicy: string; cameras: CameraStreamChoices[]; }
export interface StreamSettingsApi {
  get(): Promise<ViewerStreamSettings>;
  put(value: unknown): Promise<void>;
}

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
};

export class ViewerHttp {
  constructor(private pool: () => StreamPool, private cameras: () => ViewerCamera[], private settings?: StreamSettingsApi) {}

  async handle(request: HttpRequest, response: HttpResponse): Promise<void> {
    const method = request.method || 'GET';
    const send = (body: string | Buffer, code = 200, extra: Record<string, string> = {}) => {
      const options = { code, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', ...extra } };
      if (typeof body === 'string') response.send(method === 'HEAD' ? '' : body, options);
      else response.send(method === 'HEAD' ? Buffer.alloc(0) : body, options);
    };
    if (request.isPublicEndpoint) return send('Public access is disabled.', 403);
    if (!request.username) return send('Sign in to the Scrypted Management Console first.', 401);
    if (request.aclId) return send('The viewer requires a Scrypted administrator account.', 403);
    if (!['GET', 'HEAD', 'POST'].includes(method)) return send('Method not allowed.', 405, { Allow: 'GET, HEAD, POST' });
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      const root = (request.rootPath || '').replace(/\/$/, '');
      const pathname = root && (url.pathname === root || url.pathname.startsWith(root + '/')) ? url.pathname.slice(root.length) : url.pathname;
      if (pathname === '') return send('', 302, { Location: root + '/' });
      const assets: Record<string, [string, string]> = {
        '/': ['web/index.html', 'text/html; charset=utf-8'],
        '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
        '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
        '/app.css': ['web/app.css', 'text/css; charset=utf-8'],
        '/hls.min.js': ['web/hls.min.js', 'text/javascript; charset=utf-8'],
      };
      if (assets[pathname] && method !== 'POST') {
        if (method === 'HEAD') return send('', 200, { 'Content-Type': assets[pathname][1] });
        response.sendFile(assets[pathname][0], { headers: { ...headers, 'Content-Type': assets[pathname][1] } });
        return;
      }
      if (pathname === '/api/cameras' && method !== 'POST')
        return send(JSON.stringify({ cameras: this.cameras() }), 200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (pathname === '/api/stream-options' && this.settings) {
        if (method !== 'POST') return send(JSON.stringify(await this.settings.get()), 200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (request.headers?.['x-viewer-request'] !== '1' && request.headers?.['X-Viewer-Request'] !== '1')
          return send('Missing viewer request header.', 403);
        if (Buffer.byteLength(request.body || '', 'utf8') > 64 * 1024) return send('Too many stream changes in one request.', 413);
        let body: unknown;
        try { body = JSON.parse(request.body || ''); } catch { return send('Invalid JSON.', 400); }
        await this.settings.put(body);
        return send(JSON.stringify({ saved: true }), 200, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      const start = /^\/api\/streams\/([^/]+)$/.exec(pathname);
      if (start) {
        if (method !== 'POST') return send('Use POST to open playback.', 405, { Allow: 'POST' });
        // Custom header makes cross-origin form submissions unable to open streams.
        if (request.headers?.['x-viewer-request'] !== '1' && request.headers?.['X-Viewer-Request'] !== '1')
          return send('Missing viewer request header.', 403);
        const id = decodeURIComponent(start[1]);
        if (!this.cameras().some(camera => camera.id === id)) return send('Camera is unavailable or excluded in plugin settings.', 404);
        return send(JSON.stringify(await this.pool().ensure(id)), 200, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      const media = /^\/hls\/([^/]+)\/([a-f0-9]{24})\/(index\.m3u8|segment-\d{9,}\.ts)$/.exec(pathname);
      if (media && method !== 'POST') {
        const id = decodeURIComponent(media[1]);
        if (!this.cameras().some(camera => camera.id === id)) return send('Camera is unavailable.', 404);
        const data = await this.pool().read(id, media[2], media[3]);
        return send(data, 200, { 'Content-Type': media[3].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
      }
      send('Not found.', 404);
    } catch (error) {
      if (error instanceof ViewerError) return send(error.message, error.status);
      if (error instanceof URIError) return send('Invalid path.', 400);
      send('Could not open camera playback. Check the plugin console and camera connection.', 503);
    }
  }
}
