'use strict';
const $ = id => document.getElementById(id);
const grid = $('grid');
const players = new Map();
let cameras = [];
let visible = [];
let spotlightId = null;
let globalStats = false;
let refreshing = false;
let leaving = false;
let previousFocus;
let cameraDialogVersion = 0;
let cameraOptionsAbort;
let cameraSaving = false;
let cameraRows = new Map();
const storageKey = 'scrypted-live-viewer:' + location.pathname;
function preference(key, fallback) {
  try { return JSON.parse(localStorage.getItem(storageKey + key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(storageKey + key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
}
const savedHidden = preference('hidden', []);
let hidden = new Set(Array.isArray(savedHidden) ? savedHidden.filter(id => typeof id === 'string') : []);
const columns = String(preference('columns', 2));
$('layout-select').value = ['1', '2', '3', '4'].includes(columns) ? columns : '2';
grid.style.setProperty('--cols', $('layout-select').value);
$('layout-select').addEventListener('change', () => {
  grid.style.setProperty('--cols', $('layout-select').value);
  save('columns', Number($('layout-select').value));
});

function updateCount() {
  const live = [...players.values()].filter(player => player.state === 'live').length;
  $('stream-count').textContent = `${live} / ${visible.length} live · ${cameras.length} cameras`;
  $('live-dot').classList.toggle('live', live > 0);
}
function message(text) { $('page-message').textContent = text; $('page-message').hidden = !text; }
function stats(card, on) {
  card.querySelector('.stream-stats').classList.toggle('visible', on);
  card.querySelector('.card-stats-btn').classList.toggle('active', on);
  card.querySelector('.card-stats-btn').setAttribute('aria-pressed', String(on));
}
$('stats-toggle-all').addEventListener('click', () => {
  globalStats = !globalStats;
  $('stats-toggle-all').textContent = globalStats ? 'Hide Stats' : 'Show Stats';
  $('stats-toggle-all').classList.toggle('active', globalStats);
  $('stats-toggle-all').setAttribute('aria-pressed', String(globalStats));
  players.forEach(player => stats(player.card, globalStats));
});

function focusCamera(id) {
  if (spotlightId === id) { exitSpotlight(); return; }
  spotlightId = id;
  const wrap = document.createElement('div'); wrap.id = 'spotlight-wrap';
  const main = document.createElement('div'); main.id = 'spotlight-main';
  const sidebar = document.createElement('div'); sidebar.id = 'spotlight-sidebar';
  visible.forEach(camera => (camera.id === id ? main : sidebar).append(players.get(camera.id).card));
  wrap.append(main, sidebar);
  $('stage').replaceChildren(wrap);
  document.body.classList.add('spotlight-mode');
  resumeVideos();
}
function exitSpotlight() {
  spotlightId = null;
  visible.forEach(camera => { const player = players.get(camera.id); if (player) grid.append(player.card); });
  $('stage').replaceChildren(grid);
  document.body.classList.remove('spotlight-mode');
  resumeVideos();
}
function resumeVideos() {
  players.forEach(player => { if (player.state === 'live') void player.video.play().catch(() => {}); });
}
$('back-to-grid').addEventListener('click', exitSpotlight);

function createCard(camera) {
  const card = document.createElement('article');
  card.className = 'stream-card'; card.tabIndex = 0; card.setAttribute('aria-label', camera.name);
  // Only constant markup is inserted here. All camera data uses textContent.
  card.innerHTML = `<div class="stream-label"><span class="stream-status loading"></span>
    <span class="stream-label-name"></span><button class="card-stream-btn" title="Choose camera stream">Stream</button><button class="card-stats-btn" aria-pressed="false" title="Toggle stats">ℹ</button></div>
    <div class="expand-hint">Click to focus</div><video autoplay muted playsinline></video>
    <div class="stream-source-note" hidden></div>
    <div class="stream-stats"><div class="stats-grid"></div></div>
    <div class="stream-overlay"><div class="spinner"></div><span>Connecting…</span></div>`;
  card.querySelector('.stream-label-name').textContent = camera.name;
  card.querySelector('.card-stats-btn').setAttribute('aria-label', 'Toggle stats for ' + camera.name);
  card.querySelector('.card-stream-btn').setAttribute('aria-label', 'Choose stream for ' + camera.name);
  card.querySelector('.card-stream-btn').addEventListener('click', () => { void openCameras(camera.id); });
  const fields = {};
  ['Bandwidth', 'Resolution', 'FPS', 'Buffer', 'Dropped', 'Live edge delay'].forEach(label => {
    const item = document.createElement('div'); item.className = 'stat-item';
    const name = document.createElement('span'); name.className = 'stat-label'; name.textContent = label;
    const value = document.createElement('span'); value.className = 'stat-value'; value.textContent = '—';
    if (label === 'Live edge delay') name.title = 'Delay behind the HLS live edge; excludes camera capture and encoding delay.';
    item.append(name, value); card.querySelector('.stats-grid').append(item); fields[label] = value;
  });
  card.addEventListener('click', event => { if (!event.target.closest('button')) focusCamera(camera.id); });
  card.addEventListener('keydown', event => {
    if (event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); focusCamera(camera.id); }
  });
  card.querySelector('.card-stats-btn').addEventListener('click', () => stats(card, !card.querySelector('.stream-stats').classList.contains('visible')));
  stats(card, globalStats);
  return { card, fields, video: card.querySelector('video'), state: 'loading', dispose: () => {} };
}

function startPlayer(camera, attempt = 0) {
  const player = players.get(camera.id);
  if (!player || leaving) return;
  player.dispose();
  const { card, video, fields } = player;
  const overlay = card.querySelector('.stream-overlay');
  const dot = card.querySelector('.stream-status');
  const abort = new AbortController();
  const listeners = [];
  let disposed = false, failed = false, hls, reconnectTimer, watchdog, polling, requestTimer;
  let lastTime = video.currentTime, lastProgress = performance.now(), previousFrames, previousAt = performance.now();
  const active = () => !disposed && !leaving && card.isConnected;
  const listen = (name, handler) => { video.addEventListener(name, handler); listeners.push([name, handler]); };
  function state(value) {
    player.state = value; dot.className = 'stream-status ' + value; updateCount();
  }
  function loading(text) {
    if (!active()) return;
    state('loading'); overlay.replaceChildren();
    const spinner = document.createElement('div'); spinner.className = 'spinner';
    const label = document.createElement('span'); label.textContent = text;
    overlay.append(spinner, label); overlay.classList.remove('hidden');
  }
  function showError(text, action = () => startPlayer(camera), buttonLabel = 'Retry') {
    if (!active()) return;
    state('error'); overlay.replaceChildren();
    const label = document.createElement('span'); label.className = 'error-message'; label.textContent = text;
    const button = document.createElement('button'); button.className = 'retry-btn'; button.textContent = buttonLabel;
    button.addEventListener('click', event => { event.stopPropagation(); action(); });
    const choose = document.createElement('button'); choose.className = 'retry-btn'; choose.textContent = 'Choose stream';
    choose.addEventListener('click', event => { event.stopPropagation(); void openCameras(camera.id); });
    overlay.append(label, button, choose); overlay.classList.remove('hidden');
  }
  function reconnect(text = 'Connection lost.', retry = true) {
    if (!active() || failed) return;
    failed = true;
    clearInterval(watchdog); clearInterval(polling);
    if (hls) hls.destroy();
    hls = undefined;
    video.pause(); video.removeAttribute('src'); video.load();
    if (attempt >= 5 || !retry) { showError(text); return; }
    const wait = Math.min(3000 * 2 ** attempt, 30000);
    showError(`${text} Retrying in ${wait / 1000}s…`);
    reconnectTimer = setTimeout(() => { if (active()) startPlayer(camera, attempt + 1); }, wait);
  }
  function play() {
    if (!active() || failed) return;
    void video.play().catch(error => {
      if (active() && !failed && error.name !== 'AbortError') showError('Playback needs a click to start.', play, 'Play');
    });
  }
  player.dispose = () => {
    disposed = true; abort.abort(); clearTimeout(requestTimer); clearTimeout(reconnectTimer);
    clearInterval(watchdog); clearInterval(polling);
    listeners.forEach(([name, handler]) => video.removeEventListener(name, handler));
    if (hls) hls.destroy();
    video.pause(); video.removeAttribute('src'); video.load();
  };
  Object.values(fields).forEach(field => { field.textContent = '—'; });
  card.querySelector('.stream-source-note').hidden = true;
  loading(attempt ? 'Reconnecting…' : 'Connecting…');
  listen('loadedmetadata', play);
  listen('playing', () => {
    if (!active() || failed) return;
    attempt = 0; lastProgress = performance.now(); state('live'); overlay.classList.add('hidden');
  });
  listen('waiting', () => { if (!failed) loading('Buffering…'); });
  listen('error', () => reconnect('Browser could not decode the stream. Check that the camera uses H.264.'));
  polling = setInterval(() => {
    if (!active() || failed) return;
    const quality = video.getVideoPlaybackQuality?.();
    const now = performance.now();
    const bps = hls?.bandwidthEstimate;
    fields.Bandwidth.textContent = bps > 0 ? (bps / 1e6).toFixed(2) + ' Mbps' : '—';
    fields.Resolution.textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—';
    fields.FPS.textContent = quality && previousFrames !== undefined ? Math.max(0, (quality.totalVideoFrames - previousFrames) * 1000 / (now - previousAt)).toFixed(1) : '—';
    previousFrames = quality?.totalVideoFrames; previousAt = now;
    fields.Dropped.textContent = quality ? String(quality.droppedVideoFrames) : '—';
    let buffer = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) buffer = video.buffered.end(i) - video.currentTime;
    }
    fields.Buffer.textContent = buffer.toFixed(1) + 's';
    fields['Live edge delay'].textContent = Number.isFinite(hls?.latency) && hls.latency > 0 ? hls.latency.toFixed(1) + 's' : '—';
  }, 1000);
  void (async () => {
    try {
      requestTimer = setTimeout(() => abort.abort(), 45_000);
      const response = await fetch('api/streams/' + encodeURIComponent(camera.id), {
        method: 'POST', headers: { 'X-Viewer-Request': '1' }, signal: abort.signal, credentials: 'same-origin',
      });
      clearTimeout(requestTimer);
      if (!active()) return;
      if (!response.ok) {
        const text = (await response.text()).slice(0, 800);
        reconnect(text || `Scrypted returned HTTP ${response.status}.`, ![400, 401, 403, 404, 422].includes(response.status)); return;
      }
      const result = await response.json();
      if (!active()) return;
      if (result.warning) {
        const note = card.querySelector('.stream-source-note'); note.textContent = result.warning; note.hidden = false;
      }
      const source = new URL(result.playlist, location.href);
      if (source.origin !== location.origin || !source.pathname.startsWith(new URL('hls/', location.href).pathname)) throw new Error('Invalid playlist.');
      lastProgress = performance.now();
      watchdog = setInterval(() => {
        if (!active() || failed || document.hidden) return;
        if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastProgress = performance.now(); }
        else if (performance.now() - lastProgress > 25_000) reconnect('No video received for 25 seconds.');
      }, 2000);
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        hls = new Hls({ liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 4, liveSyncOnStallIncrease: 0,
          lowLatencyMode: true, maxLiveSyncPlaybackRate: 1.1, maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 4, enableWorker: true });
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) reconnect('Playback interrupted.'); });
        hls.attachMedia(video); hls.loadSource(source.href);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = source.href; }
      else reconnect('HLS playback is unavailable in this browser. Try a current Chrome, Firefox, or Safari.', false);
    } catch (error) {
      if (active()) reconnect(error.name === 'AbortError' ? 'Camera connection timed out.' : 'Could not connect to Scrypted.');
    }
  })();
}

function render() {
  visible = cameras.filter(camera => !hidden.has(camera.id));
  const ids = new Set(visible.map(camera => camera.id));
  players.forEach((player, id) => { if (!ids.has(id)) { player.dispose(); player.card.remove(); players.delete(id); } });
  spotlightId = null; document.body.classList.remove('spotlight-mode');
  grid.replaceChildren(); $('stage').replaceChildren(grid);
  const added = [];
  visible.forEach(camera => {
    let player = players.get(camera.id);
    if (!player) { player = createCard(camera); players.set(camera.id, player); added.push(camera); }
    player.card.querySelector('.stream-label-name').textContent = camera.name;
    grid.append(player.card);
  });
  if (!visible.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state';
    empty.textContent = cameras.length ? 'All cameras are hidden. Open Cameras to select cameras.' : 'No cameras found. Add a camera in Scrypted, then click Refresh Cameras.';
    grid.append(empty);
  }
  updateCount(); resumeVideos(); added.forEach(camera => startPlayer(camera));
}
async function refreshCameras() {
  if (refreshing) return;
  refreshing = true; $('refresh-btn').disabled = true; message('');
  try {
    const response = await fetch('api/cameras', { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to the Scrypted Management Console, then refresh.' : 'Could not discover cameras. A Scrypted administrator account is required.');
    const result = await response.json();
    if (!Array.isArray(result.cameras)) throw new Error('Scrypted returned an invalid camera list.');
    cameras = result.cameras; render();
  } catch (error) {
    message(error.message || 'Could not load cameras.');
    if (!cameras.length) $('stream-count').textContent = 'Camera discovery failed';
  } finally { refreshing = false; $('refresh-btn').disabled = false; }
}
$('refresh-btn').addEventListener('click', refreshCameras);
$('reconnect-all-btn').addEventListener('click', () => visible.forEach(camera => startPlayer(camera)));

function cameraStatus(text, error = false) {
  $('camera-settings-status').textContent = text;
  $('camera-settings-status').classList.toggle('error', error);
}
function closeCameras() {
  if (cameraSaving) return;
  cameraOptionsAbort?.abort(); cameraDialogVersion++;
  $('cameras-modal').classList.remove('open');
  (previousFocus?.isConnected ? previousFocus : $('cameras-btn')).focus();
}
async function openCameras(focusId) {
  if (cameraSaving) return;
  cameraOptionsAbort?.abort(); cameraOptionsAbort = new AbortController();
  const version = ++cameraDialogVersion;
  const controller = cameraOptionsAbort;
  const optionsTimeout = setTimeout(() => controller.abort(), 15_000);
  previousFocus = document.activeElement; $('camera-list').replaceChildren(); cameraRows = new Map();
  cameraStatus('Loading stream choices…');
  cameras.forEach(camera => {
    const row = document.createElement('div'); row.className = 'camera-option';
    const heading = document.createElement('label'); heading.className = 'camera-heading';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'camera-visible'; checkbox.value = camera.id; checkbox.checked = !hidden.has(camera.id);
    const name = document.createElement('span'); name.textContent = camera.name;
    const detail = document.createElement('small'); detail.textContent = camera.rebroadcast ? 'Rebroadcast' : 'Enable Rebroadcast';
    heading.append(checkbox, name, detail);
    const source = document.createElement('label'); source.className = 'camera-source';
    const sourceLabel = document.createElement('span'); sourceLabel.textContent = 'Stream for ' + camera.name;
    const select = document.createElement('select'); select.disabled = true;
    const loading = document.createElement('option'); loading.textContent = 'Loading stream choices…'; select.append(loading);
    source.append(sourceLabel, select);
    const warning = document.createElement('p'); warning.className = 'camera-stream-warning'; warning.hidden = true;
    row.append(heading, source, warning); $('camera-list').append(row);
    cameraRows.set(camera.id, { select, warning, initialValue: undefined, loaded: false });
  });
  if (!cameras.length) $('camera-list').textContent = 'No cameras discovered. Add cameras in Scrypted and refresh.';
  $('cameras-modal').classList.add('open'); $('cameras-close').focus();
  try {
    const response = await fetch('api/stream-options', { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error((await response.text()).slice(0, 500) || 'Could not load stream choices.');
    const data = await response.json();
    if (version !== cameraDialogVersion) return;
    if (!Array.isArray(data.cameras)) throw new Error('Invalid stream choices. Reload the viewer.');
    data.cameras.forEach(camera => {
      const row = cameraRows.get(camera.id); if (!row || !Array.isArray(camera.choices)) return;
      row.select.replaceChildren();
      camera.choices.forEach(choice => {
        const option = document.createElement('option'); option.value = choice.value;
        option.textContent = choice.value === 'inherit' ? `${choice.label} (${data.defaultPolicy})` : choice.label;
        row.select.append(option);
      });
      row.select.value = camera.value; row.initialValue = camera.value; row.loaded = true; row.select.disabled = false;
      if (camera.warning) { row.warning.textContent = camera.warning; row.warning.hidden = false; }
    });
    cameraStatus('Choose a named source to use an exact stream. Changes apply to all viewer windows.');
    if (focusId && cameraRows.get(focusId)?.loaded) cameraRows.get(focusId).select.focus();
  } catch (error) {
    if (version === cameraDialogVersion) {
      cameraStatus(error.name === 'AbortError' ? 'Loading stream choices timed out. Close and reopen Cameras to retry.' : error.message || 'Could not load stream choices.', true);
      cameraRows.forEach(row => { if (!row.loaded) row.select.options[0].textContent = 'Stream choices unavailable'; });
    }
  } finally { clearTimeout(optionsTimeout); }
}
$('cameras-btn').addEventListener('click', () => { void openCameras(); });
$('cameras-close').addEventListener('click', closeCameras);
$('cameras-modal').addEventListener('click', event => { if (event.target === $('cameras-modal')) closeCameras(); });
$('select-all').addEventListener('click', () => $('camera-list').querySelectorAll('.camera-visible').forEach(input => { input.checked = true; }));
$('cameras-apply').addEventListener('click', async () => {
  if (cameraSaving) return;
  const selections = [...cameraRows].filter(([, row]) => row.loaded && row.select.value !== row.initialValue)
    .map(([id, row]) => ({ id, value: row.select.value }));
  const nextHidden = new Set([...$('camera-list').querySelectorAll('.camera-visible')].filter(input => !input.checked).map(input => input.value));
  cameraSaving = true;
  $('cameras-modal').querySelectorAll('button, input, select').forEach(control => { control.disabled = true; });
  cameraStatus('Saving…');
  let saved = false;
  try {
    if (selections.length) {
      const response = await fetch('api/stream-options', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Viewer-Request': '1' },
        body: JSON.stringify({ selections }), signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error((await response.text()).slice(0, 500) || 'Could not save stream choices.');
    }
    hidden = nextHidden; save('hidden', [...hidden]);
    const wasVisible = new Set(visible.map(camera => camera.id));
    render();
    selections.forEach(selection => {
      const camera = visible.find(camera => camera.id === selection.id);
      if (camera && wasVisible.has(camera.id)) startPlayer(camera);
    });
    saved = true;
  } catch (error) { cameraStatus(error.message || 'Could not save stream choices. Your changes have not been applied.', true); }
  finally {
    cameraSaving = false;
    $('cameras-modal').querySelectorAll('button, input').forEach(control => { control.disabled = false; });
    cameraRows.forEach(row => { row.select.disabled = !row.loaded; });
    if (saved) closeCameras();
  }
});
document.addEventListener('keydown', event => {
  const modal = $('cameras-modal').classList.contains('open');
  if (event.key === 'Escape') { if (modal) closeCameras(); else if (spotlightId !== null) exitSpotlight(); }
  if (modal && event.key === 'Tab') {
    const focusable = [...$('cameras-modal').querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
window.addEventListener('pagehide', () => { leaving = true; players.forEach(player => player.dispose()); });
window.addEventListener('pageshow', event => { if (event.persisted) { leaving = false; void refreshCameras(); } });
void refreshCameras();
