export type StreamPolicy = 'local' | 'low-resolution' | 'highest-resolution';
export type StreamSelection = { mode: 'policy'; policy: StreamPolicy } | { mode: 'stream'; id: string };

export interface ViewerConfig {
  cameraIds: string[];
  videoMode: 'copy' | 'transcode';
  quality: StreamPolicy;
  cameraStreams: Record<string, StreamSelection>;
}

export const defaults: ViewerConfig = { cameraIds: [], videoMode: 'copy', quality: 'local', cameraStreams: {} };

export function isStreamPolicy(value: unknown): value is StreamPolicy {
  return value === 'local' || value === 'low-resolution' || value === 'highest-resolution';
}

export function validateSelection(value: unknown): StreamSelection {
  const selection = value as StreamSelection;
  if (selection?.mode === 'policy' && isStreamPolicy(selection.policy)) return { mode: 'policy', policy: selection.policy };
  if (selection?.mode === 'stream' && typeof selection.id === 'string' && selection.id.length > 0 && selection.id.length <= 4096)
    return { mode: 'stream', id: selection.id };
  throw new Error('Choose a valid camera stream or stream policy.');
}

export function validateConfig(value: unknown): ViewerConfig {
  const c = value as ViewerConfig;
  if (!c || !Array.isArray(c.cameraIds) || c.cameraIds.some(id => typeof id !== 'string' || !id || id.length > 256))
    throw new Error('Cameras must be a list of device IDs.');
  if (c.videoMode !== 'copy' && c.videoMode !== 'transcode') throw new Error('Choose copy or transcode.');
  if (!isStreamPolicy(c.quality)) throw new Error('Choose local, low-resolution, or highest-resolution.');
  const overrides = c.cameraStreams ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid camera stream settings.');
  const cameraStreams = Object.fromEntries(Object.entries(overrides).map(([id, selection]) => {
    if (!id || id.length > 256) throw new Error('Invalid camera ID in stream settings.');
    return [id, validateSelection(selection)];
  }));
  return { cameraIds: [...new Set(c.cameraIds)], videoMode: c.videoMode, quality: c.quality, cameraStreams };
}
