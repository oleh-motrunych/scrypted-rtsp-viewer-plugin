import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HttpResponseOptions } from '@scrypted/sdk';
import { StreamPool } from '../src/streams';
import { ViewerHttp } from '../src/http';
import { defaults } from '../src/config';
import { ViewerConfig } from '../src/config';
import { inheritChoice, policyChoices, selectedStream, selectionValue, streamChoices, streamRequest } from '../src/selection';
import { ffmpeg, makeVideo, temporary } from './helpers';

async function main() {
  const directory = await temporary(); const source = path.join(directory, 'source.mp4'); makeVideo(source);
  const sub = path.join(directory, 'sub.mp4'); makeVideo(sub, '320x180');
  const cameras = ['Front door', 'Driveway', 'Back garden', 'Garage', 'Side gate', 'Porch', 'Hall'].map((name, index) => ({ id: String(index + 1), name, rebroadcast: true }));
  let config: ViewerConfig = { ...defaults, quality: 'highest-resolution', cameraStreams: {} };
  const optionsFor = (id: string) => [
    { id: 'main', name: 'Main stream', video: ['3', '4', '5'].includes(id) ? { codec: 'h264' } : { width: 640, height: 360, codec: 'h264' } },
    { id: 'sub', name: 'Substream', video: { width: 320, height: 180, codec: 'h264' } },
  ];
  const pool = new StreamPool(async id => {
    let warning: string | undefined;
    const request = await streamRequest(config, id, async () => optionsFor(id), text => { warning = text; });
    const filename = request.id === 'main' ? source : sub;
    return { ffmpegPath: ffmpeg, codec: 'h264', inputArguments: ['-re', '-stream_loop', '-1', '-i', filename], warning };
  }, () => config);
  const handler = new ViewerHttp(() => pool, () => cameras, {
    get: async () => ({ defaultPolicy: config.quality, cameras: cameras.map(camera => ({
      id: camera.id, value: selectionValue(selectedStream(config, camera.id)), choices: [
        { value: 'inherit', label: inheritChoice },
        ...Object.entries(policyChoices).map(([policy, label]) => ({ value: `policy:${policy}`, label })),
        ...streamChoices(optionsFor(camera.id)).map(choice => ({ value: selectionValue({ mode: 'stream', id: choice.id }), label: choice.label })),
      ],
    })) }),
    put: async body => {
      const changes = (body as { selections: { id: string; value: string }[] }).selections;
      for (const change of changes) {
        if (change.value === 'inherit') delete config.cameraStreams[change.id];
        else if (change.value.startsWith('policy:')) config.cameraStreams[change.id] = { mode: 'policy', policy: change.value.slice(7) as any };
        else {
          const stream = optionsFor(change.id).find(stream => selectionValue({ mode: 'stream', id: stream.id }) === change.value);
          if (!stream) throw new Error('Invalid preview choice.');
          config.cameraStreams[change.id] = { mode: 'stream', id: stream.id };
        }
      }
      await Promise.all(changes.map(change => pool.stop(change.id)));
    },
  });
  const server = createServer((request, response) => {
    const options = (value?: HttpResponseOptions) => { response.writeHead(value?.code ?? 200, value?.headers as Record<string, string>); };
    void (async () => {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 64 * 1024) { response.writeHead(413); response.end(); return; }
        chunks.push(chunk);
      }
      await handler.handle({ url: request.url, rootPath: '/endpoint/scrypted-rtsp-viewer', method: request.method,
      username: 'preview-admin', headers: request.headers as Record<string, string>, body: Buffer.concat(chunks).toString() }, {
      send(body: string | Buffer, value?: HttpResponseOptions) { options(value); response.end(body); },
      sendFile(filename: string, value?: HttpResponseOptions) {
        void fs.readFile(path.join('fs', filename)).then(body => { options(value); response.end(body); })
          .catch(() => { response.writeHead(404); response.end('Build the plugin first.'); });
      },
      sendStream() { throw new Error('Unexpected stream.'); }, sendSocket() { throw new Error('Unexpected socket.'); },
      });
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.listen(8099, '127.0.0.1', () => console.log('Generated-video preview: http://127.0.0.1:8099/endpoint/scrypted-rtsp-viewer/'));
  let closing = false;
  async function close() {
    if (closing) return; closing = true;
    server.close(); server.closeAllConnections();
    await pool.close(); await fs.rm(directory, { recursive: true, force: true });
  }
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
}
void main();
