import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HttpRequest } from '@scrypted/sdk';
import { ViewerHttp } from '../src/http';
import { StreamPool } from '../src/streams';
import { CaptureResponse } from './helpers';

test('authentication, camera allowlist, method/header checks, and nested endpoint paths', async () => {
  let starts = 0;
  const pool = { ensure: async () => { starts++; return { playlist: 'hls/one/000000000000000000000000/index.m3u8' }; },
    read: async () => Buffer.from('#EXTM3U\n') } as unknown as StreamPool;
  const http = new ViewerHttp(() => pool, () => [{ id: 'one', name: '<script>Camera</script>', rebroadcast: true }]);
  async function request(url: string, extra: Partial<HttpRequest> = {}) {
    const response = new CaptureResponse();
    await http.handle({ username: 'admin', method: 'GET', rootPath: '/endpoint/device-id', url: '/endpoint/device-id' + url, ...extra }, response);
    return response;
  }
  for (const extra of [{ username: undefined }, { isPublicEndpoint: true }, { aclId: 'restricted' }]) {
    const response = await request('/api/cameras', extra);
    assert.ok([401, 403].includes(response.code));
  }
  assert.equal((await request('')).headers.Location, '/endpoint/device-id/');
  assert.equal((await request('/')).file, 'web/index.html');
  assert.equal((await request('/app.js')).file, 'web/app.js');
  assert.equal((await request('/hls.min.js')).file, 'web/hls.min.js');
  assert.equal((await request('/api/cameras')).json().cameras[0].name, '<script>Camera</script>');
  assert.equal((await request('/api/streams/one')).code, 405);
  assert.equal((await request('/api/streams/one', { method: 'POST' })).code, 403);
  assert.equal((await request('/api/streams/unknown', { method: 'POST', headers: { 'x-viewer-request': '1' } })).code, 404);
  assert.equal(starts, 0);
  assert.equal((await request('/api/streams/one', { method: 'POST', headers: { 'x-viewer-request': '1' } })).code, 200);
  assert.equal(starts, 1);
  assert.equal((await request('/api/cameras', { method: 'DELETE' })).code, 405);
  assert.equal((await request('/api/streams/%ZZ', { method: 'POST', headers: { 'x-viewer-request': '1' } })).code, 400);
  const manifest = await request('/hls/one/000000000000000000000000/index.m3u8');
  assert.equal(manifest.headers['Content-Type'], 'application/vnd.apple.mpegurl');
  assert.equal((await request('/api/cameras', { method: 'HEAD' })).body.length, 0);
  assert.equal((await request('/hls/one/000000000000000000000000/secret.txt')).code, 404);
});

test('stream-choice API requires admin access and a custom header, validates JSON, and never starts playback', async () => {
  let updates = 0;
  const http = new ViewerHttp(() => { throw new Error('Settings must not open a video stream.'); }, () => [], {
    get: async () => ({ defaultPolicy: 'highest-resolution', cameras: [{ id: 'one', value: 'inherit', choices: [{ value: 'inherit', label: 'Use default stream policy' }] }] }),
    put: async value => { assert.deepEqual(value, { selections: [] }); updates++; },
  });
  async function request(extra: Partial<HttpRequest> = {}) {
    const response = new CaptureResponse();
    await http.handle({ username: 'admin', url: '/api/stream-options', method: 'GET', ...extra }, response);
    return response;
  }
  assert.equal((await request()).json().cameras[0].value, 'inherit');
  for (const extra of [{ username: undefined }, { isPublicEndpoint: true }, { aclId: 'restricted' }]) {
    assert.ok([401, 403].includes((await request({ method: 'POST', ...extra })).code));
  }
  assert.equal((await request({ method: 'POST', body: '{"selections":[]}' })).code, 403);
  assert.equal((await request({ method: 'POST', headers: { 'x-viewer-request': '1' }, body: 'invalid' })).code, 400);
  assert.equal((await request({ method: 'POST', headers: { 'x-viewer-request': '1' }, body: 'x'.repeat(65537) })).code, 413);
  assert.equal(updates, 0);
  assert.equal((await request({ method: 'POST', headers: { 'x-viewer-request': '1' }, body: '{"selections":[]}' })).code, 200);
  assert.equal(updates, 1);
});
