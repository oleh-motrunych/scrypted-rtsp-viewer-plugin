import type { RequestMediaStreamOptions, ResponseMediaStreamOptions } from '@scrypted/sdk';
import { createHash } from 'node:crypto';
import type { StreamPolicy, StreamSelection, ViewerConfig } from './config';
import { ViewerError } from './streams';

export const inheritChoice = 'Use default stream policy';
export const unavailableChoice = 'Selected stream unavailable — choose another';
export const policyChoices: Record<StreamPolicy, string> = {
  'highest-resolution': 'Highest resolution',
  local: 'Scrypted local stream',
  'low-resolution': 'Scrypted low-resolution stream',
};

export function selectedStream(config: ViewerConfig, cameraId: string): StreamSelection | undefined {
  return Object.hasOwn(config.cameraStreams, cameraId) ? config.cameraStreams[cameraId] : undefined;
}

export function selectionValue(selection?: StreamSelection): string {
  if (!selection) return 'inherit';
  return selection.mode === 'policy' ? `policy:${selection.policy}` : `stream:${createHash('sha256').update(selection.id).digest('hex')}`;
}

export function streamChoices(streams: ResponseMediaStreamOptions[]): { id: string; label: string }[] {
  const used = new Set([inheritChoice, unavailableChoice, ...Object.values(policyChoices)]);
  const entries = streams.map(stream => {
    const resolution = area(stream) ? `${stream.video!.width}×${stream.video!.height}` : 'resolution not reported';
    const codec = stream.video?.codec ? ` · ${stream.video.codec.toUpperCase()}` : '';
    return { id: stream.id, base: `${stream.name || 'Unnamed stream'} — ${resolution}${codec}` };
  });
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.base, (counts.get(entry.base) || 0) + 1);
  return entries.map(({ id, base }) => {
    // Stable disambiguation prevents reordered identical labels selecting a different
    // source. A fingerprint also avoids displaying potentially private stream IDs.
    const unique = counts.get(base)! > 1 ? `${base} · source ${createHash('sha256').update(id).digest('hex').slice(0, 12)}` : base;
    let label = unique;
    let duplicate = 2;
    while (used.has(label)) label = `${unique} (${duplicate++})`;
    used.add(label);
    return { id, label };
  });
}

function area(stream: ResponseMediaStreamOptions): number {
  const width = stream.video?.width;
  const height = stream.video?.height;
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width * height) && width > 0 && height > 0
    ? width * height : 0;
}

export function usableStreams(streams: unknown): ResponseMediaStreamOptions[] {
  if (!Array.isArray(streams)) throw new ViewerError('Camera returned an invalid stream list.');
  const ids = new Set<string>();
  return streams.filter((stream): stream is ResponseMediaStreamOptions => {
    if (!stream || typeof stream.id !== 'string' || !stream.id || stream.video === null || ids.has(stream.id)) return false;
    ids.add(stream.id);
    return true;
  });
}

export async function streamRequest(config: ViewerConfig, cameraId: string,
  loadStreams: () => Promise<ResponseMediaStreamOptions[]>, warn: (message: string) => void = () => {}): Promise<RequestMediaStreamOptions> {
  const selection = selectedStream(config, cameraId) || { mode: 'policy', policy: config.quality };
  const request: RequestMediaStreamOptions = { destinationType: 'scrypted-rtsp-viewer', prebuffer: 0 };
  if (selection.mode === 'policy' && selection.policy !== 'highest-resolution') return { ...request, destination: selection.policy };
  const streams = usableStreams(await loadStreams());
  let selected: ResponseMediaStreamOptions | undefined;
  if (selection.mode === 'stream') {
    selected = streams.find(stream => stream.id === selection.id);
    if (!selected) throw new ViewerError('The selected camera stream is unavailable. Open Cameras and choose another source.', 422);
  } else {
    if (streams.length > 1 && streams.some(stream => !area(stream))) {
      warn('Highest resolution could not be determined. Showing the Scrypted local stream. Open Cameras to choose a source.');
      return { ...request, destination: 'local' };
    }
    selected = streams.reduce<ResponseMediaStreamOptions | undefined>((best, stream) => !best || area(stream) > area(best) ? stream : best, undefined);
    if (!selected) throw new ViewerError('This camera has no selectable video streams. Check the camera connection and stream settings.');
  }
  // An explicit stream ID selects the source without changing Rebroadcast settings.
  return { ...request, destination: 'local', id: selected.id };
}
