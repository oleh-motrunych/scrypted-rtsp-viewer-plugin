import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaults } from '../src/config';
import { CameraInput, StreamPool } from '../src/streams';
import { ffmpeg, makeVideo, temporary } from './helpers';

test('real H.264 copy playback is shared, serves decodable HLS, rejects paths, and expires when idle', async () => {
  const directory = await temporary();
  const source = path.join(directory, 'source.mp4'); makeVideo(source);
  let opened = 0;
  const pool = new StreamPool(async () => {
    opened++;
    return { ffmpegPath: ffmpeg, inputArguments: ['-re', '-stream_loop', '-1', '-i', source], codec: 'h264' };
  }, () => defaults, 60_000);
  try {
    const [a, b] = await Promise.all([pool.ensure('camera/one'), pool.ensure('camera/one')]);
    assert.equal(opened, 1); assert.equal(a.playlist, b.playlist);
    const token = a.playlist.split('/')[2];
    const manifest = (await pool.read('camera/one', token, 'index.m3u8')).toString();
    assert.match(manifest, /#EXTM3U/); assert.match(manifest, /#EXTINF:/);
    const filename = manifest.split('\n').find(line => line.endsWith('.ts'))!;
    const segment = await pool.read('camera/one', token, filename);
    assert.ok(segment.length > 1000); assert.equal(segment[0], 0x47, 'MPEG-TS sync byte');
    const output = path.join(directory, 'playback.ts'); await fs.writeFile(output, segment);
    const { spawnSync } = await import('node:child_process');
    const decode = spawnSync(ffmpeg, ['-v', 'error', '-i', output, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(decode.status, 0, decode.stderr);
    await assert.rejects(pool.read('camera/one', token, '../source.mp4'), /Not found/);
    await assert.rejects(pool.read('camera/one', 'wrong', filename), /expired/);
    await pool.sweep(Date.now() + 61_000);
    await assert.rejects(pool.read('camera/one', token, filename), /expired/);
    const next = await pool.ensure('camera/one'); assert.notEqual(next.playlist, a.playlist); assert.equal(opened, 2);
  } finally { await pool.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('transcode converts a non-H.264 source into browser HLS', async () => {
  const pool = new StreamPool(async () => ({ ffmpegPath: ffmpeg, codec: 'rawvideo',
    inputArguments: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10'] }),
  () => ({ ...defaults, videoMode: 'transcode' }));
  try {
    const { playlist } = await pool.ensure('raw');
    assert.match((await pool.read('raw', playlist.split('/')[2], 'index.m3u8')).toString(), /#EXTINF:/);
  } finally { await pool.close(); }
});

test('unsupported codecs and missing FFmpeg fail cleanly and can be retried', async () => {
  let input: CameraInput = { ffmpegPath: '/missing/ffmpeg', codec: 'h265', inputArguments: ['-i', 'not-used'] };
  const pool = new StreamPool(async () => input, () => defaults);
  try {
    await assert.rejects(pool.ensure('one'), /not H.264/);
    input = { ...input, codec: 'h264' };
    await assert.rejects(pool.ensure('one'), /Could not start FFmpeg/);
  } finally { await pool.close(); }
});

test('closing during a pending camera lookup prevents a late FFmpeg process', async () => {
  let resolve!: (value: CameraInput) => void;
  const pool = new StreamPool(() => new Promise(done => { resolve = done; }), () => defaults);
  const pending = pool.ensure('late');
  const rejected = assert.rejects(pending, /closed/);
  await pool.close();
  resolve({ ffmpegPath: '/must-not-launch', inputArguments: ['-i', 'unused'] });
  await rejected;
  await assert.rejects(pool.ensure('late'), /restarting/);
});

test('simultaneous recovery opens only one replacement stream', async () => {
  let opened = 0;
  const pool = new StreamPool(async () => {
    opened++;
    return { ffmpegPath: ffmpeg, codec: 'rawvideo', inputArguments: ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10'] };
  }, () => ({ ...defaults, videoMode: 'transcode' }));
  try {
    await pool.ensure('one');
    const session = (pool as any).sessions.get('one');
    session.error = new Error('Simulated failed stream.');
    const [a, b] = await Promise.all([pool.ensure('one'), pool.ensure('one')]);
    assert.equal(a.playlist, b.playlist); assert.equal(opened, 2);
  } finally { await pool.close(); }
});
