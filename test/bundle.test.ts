import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import * as syncFs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { CaptureResponse, ffmpeg, makeVideo, temporary } from './helpers';

test('production plugin discovers cameras, calls the Scrypted stream API, plays HLS, and applies settings', async () => {
  const directory = await temporary(); const source = path.join(directory, 'source.mp4'); makeVideo(source);
  const lowSource = path.join(directory, 'sub.mp4'); makeVideo(lowSource, '320x180');
  // A saved 0.1.0 config has no per-camera overrides.
  const storage = new Map<string, string>([['config', JSON.stringify({ cameraIds: [], quality: 'low-resolution', videoMode: 'copy' })]]);
  const requests: Record<string, unknown>[] = [];
  let streamOptions = [
    { id: 'main', name: 'Main', video: { width: 640, height: 360, codec: 'h264' } },
    { id: 'sub', name: 'Sub', video: { width: 320, height: 180, codec: 'h264' } },
  ];
  let wrongStream = false;
  const devices: Record<string, any> = {
    one: { id: 'one', name: 'Front door', interfaces: ['VideoCamera'], mixins: ['rebroadcast'],
      async getVideoStreamOptions() { return streamOptions; },
      async getVideoStream(request: Record<string, unknown>) {
        requests.push(request);
        const id = wrongStream ? 'unexpected' : request.id || 'sub';
        return { inputArguments: ['-re', '-stream_loop', '-1', '-i', id === 'main' ? source : lowSource],
          mediaStreamOptions: { id, video: { codec: 'h264' } } };
      } },
    two: { id: 'two', name: 'Back garden', interfaces: ['VideoCamera'], mixins: [] },
    light: { id: 'light', name: 'Lamp', interfaces: ['OnOff'] },
    rebroadcast: { id: 'rebroadcast', pluginId: '@scrypted/prebuffer-mixin', interfaces: [] },
  };
  devices.two.getVideoStream = devices.one.getVideoStream;
  devices.two.getVideoStreamOptions = devices.one.getVideoStreamOptions;
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const AdmZip = require('adm-zip');
  const sdkJson = new AdmZip('dist/plugin.zip').readFile('sdk.json');
  // The real worker sets its working directory beneath the extracted ZIP.
  // Resolve that one SDK-relative file from the actual deployable bundle.
  const workerRequire = (name: string) => name === 'fs' ? {
    ...syncFs, readFileSync: (filename: any, ...args: any[]) => filename === '../sdk.json' ? sdkJson : (syncFs.readFileSync as any)(filename, ...args),
  } : require(name);
  const context = vm.createContext({ exports: {}, require: workerRequire,
    process, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, URL,
    deviceManager: { getDeviceLogger: () => console, getDeviceConsole: () => console,
      getDeviceState: () => ({ id: 'plugin', name: 'RTSP Live Viewer' }),
      getDeviceStorage: () => ({ getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }),
      onDeviceEvent: async () => {} },
    mediaManager: { getFFmpegPath: async () => ffmpeg, convertMediaObjectToJSON: async (value: unknown) => value },
    systemManager: { getSystemState: () => Object.fromEntries(Object.keys(devices).map(id => [id, {}])), getDeviceById: (id: string) => devices[id] },
    endpointManager: { getPath: async () => '/endpoint/scrypted-rtsp-viewer' }, pluginHostAPI: {},
  });
  vm.runInContext(await fs.readFile('dist/main.nodejs.js', 'utf8'), context);
  const Plugin = context.exports.default; assert.equal(typeof Plugin, 'function');
  let plugin = new Plugin();
  async function request(url: string, method = 'GET', body?: unknown) {
    const response = new CaptureResponse();
    await plugin.onRequest({ username: 'admin', rootPath: '/endpoint/plugin', url: '/endpoint/plugin' + url,
      method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'x-viewer-request': '1' } }, response);
    return response;
  }
  try {
    const settings = await plugin.getSettings();
    const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
    assert.ok(manifest.scrypted.interfaces.includes('LauncherApplication'), 'Advertise the app to the Scrypted launcher.');
    assert.equal(plugin.applicationInfo.name, 'RTSP Live Viewer');
    assert.equal(plugin.applicationInfo.href, '/endpoint/scrypted-rtsp-viewer/');
    const launcherTarget = new CaptureResponse();
    await plugin.onRequest({ username: 'admin', url: plugin.applicationInfo.href, rootPath: '/endpoint/scrypted-rtsp-viewer' }, launcherTarget);
    assert.equal(launcherTarget.file, 'web/index.html', 'The launcher must open the actual grid rather than the plugin settings.');
    assert.equal(requests.length, 0, 'Listing stream choices must not start video.');
    assert.match(settings.find((setting: any) => setting.key === 'viewer').value, /endpoint\/scrypted-rtsp-viewer\//);
    assert.equal(settings.find((setting: any) => setting.key === 'quality').value, 'low-resolution', 'Keep the old saved destination.');
    const streamSetting = settings.find((setting: any) => setting.key === 'stream:one');
    const mainChoice = streamSetting.choices.find((choice: string) => choice.startsWith('Main —'));
    const subChoice = streamSetting.choices.find((choice: string) => choice.startsWith('Sub —'));
    assert.match(mainChoice, /640×360/); assert.match(subChoice, /320×180/);
    const catalog = (await request('/api/stream-options')).json();
    assert.equal(requests.length, 0, 'The viewer camera chooser must not start playback.');
    const mainValue = catalog.cameras.find((camera: any) => camera.id === 'one').choices.find((choice: any) => choice.label.startsWith('Main —')).value;
    const subValue = catalog.cameras.find((camera: any) => camera.id === 'one').choices.find((choice: any) => choice.label.startsWith('Sub —')).value;
    const cameras = (await request('/api/cameras')).json().cameras;
    assert.equal(cameras.length, 2); assert.equal(cameras.find((camera: any) => camera.id === 'one').rebroadcast, true);
    const opened = await request('/api/streams/one', 'POST'); assert.equal(opened.code, 200, opened.body.toString());
    assert.equal(requests[0].destination, 'low-resolution'); assert.equal(requests[0].prebuffer, 0);
    const playlist = await request('/' + opened.json().playlist); assert.match(playlist.body.toString(), /#EXTINF:/);
    await plugin.putSetting('quality', 'low-resolution');
    assert.equal((await request('/' + opened.json().playlist)).code, 404);
    await plugin.putSetting('cameraIds', ['one']);
    assert.equal((await request('/api/cameras')).json().cameras.length, 1);
    assert.equal((await request('/api/streams/two', 'POST')).code, 404);
    await assert.rejects(plugin.putSetting('videoMode', 'invalid'), /copy or transcode/);
    const next = await request('/api/streams/one', 'POST'); assert.equal(next.code, 200);
    assert.equal(requests.at(-1)!.destination, 'low-resolution');
    assert.equal(JSON.parse(storage.get('config')!).quality, 'low-resolution');

    await plugin.putSetting('quality', 'highest-resolution');
    const highest = await request('/api/streams/one', 'POST'); assert.equal(highest.code, 200, highest.body.toString());
    assert.equal(requests.at(-1)!.id, 'main');
    const highestManifest = (await request('/' + highest.json().playlist)).body.toString();
    const segment = highestManifest.split('\n').find(line => line.endsWith('.ts'))!;
    const segmentPath = '/' + highest.json().playlist.replace('index.m3u8', segment);
    const sample = path.join(directory, 'highest.ts'); await fs.writeFile(sample, (await request(segmentPath)).body);
    const decode = spawnSync(ffmpeg, ['-hide_banner', '-i', sample, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(decode.status, 0, decode.stderr); assert.match(decode.stderr, /640x360/);

    await plugin.putSetting('stream:one', subChoice);
    assert.equal((await request('/' + highest.json().playlist)).code, 404, 'Changing the source must close the old playback pipeline.');
    let input = await plugin.openInput('one'); assert.equal(requests.at(-1)!.id, 'sub');
    await input.refresh(); assert.equal(requests.at(-1)!.id, 'sub', 'Refresh must keep the explicitly selected source.');
    assert.equal(JSON.parse(storage.get('config')!).cameraStreams.one.id, 'sub');
    await plugin.release(); plugin = new Plugin();
    assert.equal((await plugin.getSettings()).find((setting: any) => setting.key === 'stream:one').value, subChoice);
    await plugin.openInput('one'); assert.equal(requests.at(-1)!.id, 'sub', 'Keep the source override after plugin restart.');

    await plugin.putSetting('stream:one', 'Scrypted local stream');
    await plugin.openInput('one'); assert.equal(requests.at(-1)!.destination, 'local'); assert.equal(requests.at(-1)!.id, undefined);
    await plugin.putSetting('quality', 'low-resolution');
    await plugin.putSetting('stream:one', 'Highest resolution');
    await plugin.openInput('one'); assert.equal(requests.at(-1)!.id, 'main');
    await plugin.putSetting('stream:one', 'Use default stream policy');
    await plugin.openInput('one'); assert.equal(requests.at(-1)!.destination, 'low-resolution');
    assert.equal(JSON.parse(storage.get('config')!).cameraStreams.one, undefined);

    await plugin.putSetting('quality', 'highest-resolution');
    await plugin.putSetting('cameraIds', ['one', 'two']);
    // Reproduce the screenshot: a main stream without reported dimensions.
    streamOptions = [{ id: 'main', name: 'Main', video: { codec: 'h264' } } as any,
      { id: 'sub', name: 'Sub', video: { width: 320, height: 180, codec: 'h264' } }];
    const fallback = await request('/api/streams/one', 'POST');
    assert.equal(fallback.code, 200, fallback.body.toString());
    assert.match(fallback.json().warning, /Highest resolution could not be determined/);
    const unaffected = await request('/api/streams/two', 'POST'); assert.equal(unaffected.code, 200);
    const beforeInvalid = storage.get('config');
    const invalid = await request('/api/stream-options', 'POST', { selections: [{ id: 'one', value: mainValue }, { id: 'unknown', value: 'inherit' }] });
    assert.equal(invalid.code, 404); assert.equal(storage.get('config'), beforeInvalid, 'A rejected batch must not partially save.');
    assert.equal((await request('/' + fallback.json().playlist)).code, 200, 'A rejected update must not stop playback.');
    assert.equal((await request('/api/stream-options', 'POST', { selections: [{ id: 'one', value: mainValue }] })).code, 200);
    assert.equal((await request('/' + unaffected.json().playlist)).code, 200, 'Changing one source must keep the other camera pipeline alive.');
    assert.equal((await request('/' + fallback.json().playlist)).code, 404, 'Apply must stop the source being replaced.');
    const selected = await request('/api/streams/one', 'POST');
    assert.equal(selected.code, 200, selected.body.toString()); assert.equal(requests.at(-1)!.id, 'main');
    assert.equal(selected.json().warning, undefined);
    assert.equal(JSON.parse(storage.get('config')!).cameraStreams.one.id, 'main');
    const savedOptions = (await request('/api/stream-options')).json();
    assert.equal(savedOptions.cameras.find((camera: any) => camera.id === 'one').value, mainValue, 'The saved choice must be selected when reopening Cameras.');
    assert.equal((await request('/api/stream-options', 'POST', { selections: [{ id: 'one', value: mainValue }] })).code, 200);
    assert.equal((await request('/' + selected.json().playlist)).code, 200, 'An unchanged choice must not reconnect playback.');
    assert.equal((await request('/api/stream-options', 'POST', { selections: [{ id: 'one', value: subValue }, { id: 'one', value: mainValue }] })).code, 400);
    assert.equal(JSON.parse(storage.get('config')!).cameraStreams.one.id, 'main');
    assert.equal((await request('/api/stream-options', 'POST', { selections: [{ id: 'one', value: 'stream:invalid' }] })).code, 409);
    assert.equal((await request('/api/stream-options', 'POST', { selections: 'invalid' })).code, 400);

    streamOptions = [
      { id: 'main', name: 'Main', video: { width: 640, height: 360, codec: 'h264' } },
      { id: 'sub', name: 'Sub', video: { width: 320, height: 180, codec: 'h264' } },
    ];
    await plugin.putSetting('quality', 'low-resolution');
    await plugin.putSetting('stream:one', mainChoice);
    wrongStream = true;
    await assert.rejects(plugin.openInput('one'), /different stream than selected/);
    wrongStream = false;
    streamOptions = streamOptions.filter(stream => stream.id !== 'main');
    const beforeMissing = requests.length;
    await assert.rejects(plugin.openInput('one'), /selected camera stream is unavailable/);
    assert.equal(requests.length, beforeMissing, 'Do not request a fallback when a selected source disappears.');
    const unavailable = (await plugin.getSettings()).find((setting: any) => setting.key === 'stream:one');
    assert.match(unavailable.value, /unavailable/);
    await assert.rejects(plugin.putSetting('stream:one', 'Not a real choice'), /choices changed/);
    await plugin.putSetting('stream:one', 'Use default stream policy');
    await plugin.openInput('one'); assert.equal(requests.at(-1)!.destination, 'low-resolution');
  } finally { await plugin.release(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('deployable ZIP includes the plugin and offline playback assets', async () => {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const AdmZip = require('adm-zip'); const zip = new AdmZip('dist/plugin.zip');
  const entries = new Set(zip.getEntries().map((entry: { entryName: string }) => entry.entryName));
  for (const name of ['main.nodejs.js', 'sdk.json', 'README.md', 'fs/web/index.html', 'fs/web/app.js', 'fs/web/app.css',
    'fs/web/hls.min.js', 'fs/licenses/LICENSE', 'fs/licenses/THIRD_PARTY_NOTICES.txt', 'fs/licenses/hls.js-LICENSE', 'fs/licenses/Apache-2.0.txt']) assert.ok(entries.has(name), name);
  const html = zip.readAsText('fs/web/index.html'); assert.doesNotMatch(html, /https:\/\/cdn/);
  assert.equal(zip.readAsText('fs/web/app.js'), await fs.readFile('fs/web/app.js', 'utf8'), 'Ship the same stream-picker UI that was verified in the browser.');
});
