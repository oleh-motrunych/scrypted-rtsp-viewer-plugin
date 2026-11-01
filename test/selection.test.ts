import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validateConfig } from '../src/config';
import { inheritChoice, policyChoices, streamChoices, streamRequest, usableStreams } from '../src/selection';

const main = { id: 'main', name: 'Main', video: { width: 2560, height: 1440, codec: 'h265' } };
const sub = { id: 'sub', name: 'Sub', video: { width: 800, height: 448, codec: 'h264' } };

test('highest-resolution selects the largest source explicitly, even when the local destination points elsewhere', async () => {
  const request = await streamRequest({ ...defaults, quality: 'highest-resolution' }, 'one', async () => [sub, main]);
  assert.equal(request.id, 'main');
  assert.equal(request.prebuffer, 0);
  assert.equal(request.destinationType, 'scrypted-rtsp-viewer');
});

test('per-camera stream and policy overrides take precedence and do not affect other cameras', async () => {
  const config = validateConfig({ ...defaults, quality: 'highest-resolution', cameraStreams: {
    one: { mode: 'stream', id: 'sub' }, two: { mode: 'policy', policy: 'low-resolution' },
  } });
  assert.equal((await streamRequest(config, 'one', async () => [main, sub])).id, 'sub');
  const low = await streamRequest(config, 'two', async () => { throw new Error('Destination mode should not query source metadata.'); });
  assert.equal(low.destination, 'low-resolution'); assert.equal(low.id, undefined);
  assert.equal((await streamRequest(config, 'three', async () => [main, sub])).id, 'main');
});

test('unknown resolution keeps playback available with a warning; a removed explicit source remains an actionable error', async () => {
  const config = { ...defaults, quality: 'highest-resolution' as const };
  let warning = '';
  const fallback = await streamRequest(config, 'one', async () => [sub, { id: 'unknown-main', name: 'Main' }], message => { warning = message; });
  assert.equal(fallback.destination, 'local'); assert.equal(fallback.id, undefined);
  assert.match(warning, /Highest resolution could not be determined/);
  assert.match(warning, /Open Cameras/);
  const explicit = await streamRequest({ ...config, cameraStreams: { one: { mode: 'stream', id: 'unknown-main' } } }, 'one', async () => [sub, { id: 'unknown-main', name: 'Main' }]);
  assert.equal(explicit.id, 'unknown-main', 'Explicit selection works without resolution metadata.');
  await assert.rejects(streamRequest(config, 'one', async () => []), /no selectable video/);
  assert.equal((await streamRequest(config, 'one', async () => [{ id: 'only' }])).id, 'only');
  await assert.rejects(streamRequest({ ...defaults, cameraStreams: { one: { mode: 'stream', id: 'removed' } } }, 'one', async () => [sub]), /selected camera stream is unavailable/);
});

test('settings from 0.1.0 keep their camera list and stream destination; malformed overrides are rejected', () => {
  const migrated = validateConfig({ cameraIds: ['one'], videoMode: 'copy', quality: 'low-resolution' });
  assert.deepEqual(migrated.cameraIds, ['one']); assert.equal(migrated.quality, 'low-resolution');
  assert.deepEqual(migrated.cameraStreams, {});
  assert.throws(() => validateConfig({ ...defaults, cameraStreams: [] }), /Invalid camera stream/);
  assert.throws(() => validateConfig({ ...defaults, cameraStreams: { one: { mode: 'stream', id: '' } } }), /valid camera stream/);
  assert.throws(() => validateConfig({ ...defaults, cameraStreams: { one: { mode: 'policy', policy: 'invalid' } } }), /valid camera stream/);
});

test('stream labels identify native resolution and codec and remain distinct for duplicate source names', () => {
  const choices = streamChoices([main, sub, { ...sub, id: 'another-sub' }]);
  assert.match(choices[0].label, /Main.*2560×1440.*H265/);
  assert.match(choices[1].label, /Sub.*800×448.*H264/);
  assert.notEqual(choices[1].label, choices[2].label);
  const reversed = streamChoices([{ ...sub, id: 'another-sub' }, sub, main]);
  assert.equal(choices[1].label, reversed.find(choice => choice.id === 'sub')!.label, 'Identical labels must still identify the same source after reordering.');
  assert.ok(!streamChoices([sub]).some(choice => choice.label === choices[2].label), 'A removed duplicate source must not be mistaken for a remaining source.');
  assert.ok(choices.every(choice => ![inheritChoice, ...Object.values(policyChoices)].includes(choice.label)));
  assert.deepEqual(usableStreams([main, main, { id: 'audio', video: null }, { name: 'invalid' }]).map(stream => stream.id), ['main']);
});
