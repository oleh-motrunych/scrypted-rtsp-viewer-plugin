import sdk, { FFmpegInput, HttpRequest, HttpRequestHandler, HttpResponse, LauncherApplication, Readme, ResponseMediaStreamOptions,
  ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { defaults, isStreamPolicy, StreamSelection, validateConfig, ViewerConfig } from './config';
import { CameraStreamChoices, ViewerCamera, ViewerHttp } from './http';
import { CameraInput, StreamPool, ViewerError } from './streams';
import { inheritChoice, policyChoices, selectedStream, selectionValue, streamChoices, streamRequest, unavailableChoice, usableStreams } from './selection';

export default class LiveViewerPlugin extends ScryptedDeviceBase implements Settings, HttpRequestHandler, Readme, LauncherApplication {
  private config: ViewerConfig = { ...defaults, cameraIds: [], cameraStreams: {} };
  private pool: StreamPool;
  private operations: Promise<void> = Promise.resolve();
  private http: ViewerHttp;
  private launcherReady: Promise<void>;
  private readonly exitHandler = () => this.pool.killImmediately();

  constructor() {
    super();
    try {
      const saved = this.storage.getItem('config');
      if (saved) this.config = validateConfig({ ...defaults, ...JSON.parse(saved) });
    } catch { this.console.warn('Invalid saved viewer settings; using defaults.'); }
    this.pool = this.createPool();
    this.http = new ViewerHttp(() => this.pool, () => this.cameras(), {
      get: async () => ({ defaultPolicy: this.config.quality, cameras: await Promise.all(this.cameras().map(camera => this.cameraStreamChoices(camera))) }),
      put: value => this.putStreamChoices(value),
    });
    process.once('exit', this.exitHandler);
    this.launcherReady = this.initializeLauncher().catch(() => {
      this.console.warn('Could not register the viewer launcher link. Restart the plugin to retry.');
    });
  }

  private async initializeLauncher(): Promise<void> {
    this.applicationInfo = {
      name: 'RTSP Live Viewer',
      description: 'Open the live camera grid.',
      icon: 'mdi-view-grid',
      href: (await sdk.endpointManager.getPath()).replace(/\/$/, '') + '/',
    };
  }

  private createPool() {
    return new StreamPool(id => this.openInput(id), () => this.config, 45_000, message => this.console.warn(message));
  }

  private cameras(): ViewerCamera[] {
    const state = sdk.systemManager.getSystemState();
    return Object.keys(state).flatMap(id => {
      const device = sdk.systemManager.getDeviceById<VideoCamera>(id);
      if (!device?.interfaces?.includes(ScryptedInterface.VideoCamera) || (this.config.cameraIds.length && !this.config.cameraIds.includes(id))) return [];
      const rebroadcast = (device.mixins || []).some(mixinId =>
        sdk.systemManager.getDeviceById(mixinId)?.pluginId === '@scrypted/prebuffer-mixin');
      return [{ id, name: device.name || id, rebroadcast }];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async openInput(id: string): Promise<CameraInput> {
    if (!this.cameras().some(camera => camera.id === id)) throw new ViewerError('Camera is unavailable or excluded in plugin settings.', 404);
    const camera = sdk.systemManager.getDeviceById<VideoCamera>(id);
    let warning: string | undefined;
    const request = await streamRequest(this.config, id, () => this.streamOptions(id), message => { warning = message; });
    const media = await camera.getVideoStream(request);
    let input = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
    const verifyStream = (value: FFmpegInput) => {
      if (request.id && value.mediaStreamOptions?.id && request.id !== value.mediaStreamOptions.id)
        throw new ViewerError('The camera returned a different stream than selected. Refresh the stream choices in RTSP Live Viewer settings.');
    };
    verifyStream(input);
    return {
      ffmpegPath: input.ffmpegPath || await sdk.mediaManager.getFFmpegPath(),
      inputArguments: input.inputArguments?.length ? input.inputArguments : input.url ? ['-i', input.url] : [],
      env: input.env, codec: input.mediaStreamOptions?.video?.codec, refreshAt: input.mediaStreamOptions?.refreshAt,
      warning,
      refresh: async () => {
        const refreshed = await camera.getVideoStream({ ...input.mediaStreamOptions, ...request });
        input = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(refreshed, ScryptedMimeTypes.FFmpegInput);
        verifyStream(input);
        return input.mediaStreamOptions?.refreshAt;
      },
    };
  }

  private async cameraStreamChoices(camera: ViewerCamera): Promise<CameraStreamChoices> {
    const selection = selectedStream(this.config, camera.id);
    const choices = [
      { value: 'inherit', label: inheritChoice },
      ...Object.entries(policyChoices).map(([policy, label]) => ({ value: `policy:${policy}`, label })),
    ];
    let warning: string | undefined;
    try {
      choices.push(...streamChoices(await this.streamOptions(camera.id)).map(choice => ({
        value: selectionValue({ mode: 'stream', id: choice.id }), label: choice.label,
      })));
    } catch { warning = 'Stream list unavailable. Check the camera connection and reopen Cameras.'; }
    const value = selectionValue(selection);
    if (!choices.some(choice => choice.value === value)) choices.push({ value, label: unavailableChoice });
    return { id: camera.id, value, choices, ...(warning ? { warning } : {}) };
  }

  private enqueueSettings(operation: () => Promise<void>): Promise<void> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => {});
    return pending;
  }

  private putStreamChoices(value: unknown): Promise<void> {
    return this.enqueueSettings(async () => {
      const changes = (value as { selections?: unknown })?.selections;
      if (!Array.isArray(changes) || changes.length > 1000) throw new ViewerError('Expected a list of camera stream selections.', 400);
      const allowed = new Set(this.cameras().map(camera => camera.id));
      const seen = new Set<string>();
      const cameraStreams = { ...this.config.cameraStreams };
      const changed: string[] = [];
      // Validate the complete batch before changing settings or playback.
      for (const change of changes) {
        if (!change || typeof change.id !== 'string' || typeof change.value !== 'string' || seen.has(change.id))
          throw new ViewerError('Invalid or duplicate camera stream selection.', 400);
        seen.add(change.id);
        if (!allowed.has(change.id)) throw new ViewerError('Camera is unavailable or excluded in plugin settings.', 404);
        const current = selectedStream(this.config, change.id);
        if (change.value === selectionValue(current)) continue;
        let selection: StreamSelection | undefined;
        if (change.value === 'inherit') selection = undefined;
        else if (change.value.startsWith('policy:') && isStreamPolicy(change.value.slice(7)))
          selection = { mode: 'policy', policy: change.value.slice(7) };
        else {
          const choice = streamChoices(await this.streamOptions(change.id))
            .find(choice => selectionValue({ mode: 'stream', id: choice.id }) === change.value);
          if (!choice) throw new ViewerError('The stream choices changed. Reopen Cameras and select the source again.', 409);
          selection = { mode: 'stream', id: choice.id };
        }
        if (selection) Object.defineProperty(cameraStreams, change.id, { value: selection, enumerable: true, configurable: true, writable: true });
        else delete cameraStreams[change.id];
        changed.push(change.id);
      }
      if (!changed.length) return;
      const next = validateConfig({ ...this.config, cameraStreams });
      this.storage.setItem('config', JSON.stringify(next));
      this.config = next;
      await Promise.all(changed.map(id => this.pool.stop(id)));
      await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    });
  }

  private async streamOptions(id: string): Promise<ResponseMediaStreamOptions[]> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const camera = sdk.systemManager.getDeviceById<VideoCamera>(id);
      return usableStreams(await Promise.race([
        camera.getVideoStreamOptions(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Stream lookup timed out.')), 5000);
          timer.unref();
        }),
      ]));
    } catch { throw new ViewerError('Could not list camera streams. Check the camera connection and reopen RTSP Live Viewer settings.'); }
    finally { clearTimeout(timer); }
  }

  private async cameraStreamSetting(camera: ViewerCamera): Promise<Setting> {
    const selection = selectedStream(this.config, camera.id);
    let choices: { id: string; label: string }[] = [];
    let error = '';
    try { choices = streamChoices(await this.streamOptions(camera.id)); }
    catch { error = ' The stream list is unavailable. Check the camera connection and reopen settings to refresh it.'; }
    const value = selection?.mode === 'stream' ? choices.find(choice => choice.id === selection.id)?.label || unavailableChoice
      : selection?.mode === 'policy' ? policyChoices[selection.policy] : inheritChoice;
    return {
      key: 'stream:' + encodeURIComponent(camera.id), title: `${camera.name} stream`, group: 'Camera streams',
      type: 'string', choices: [inheritChoice, ...Object.values(policyChoices), ...choices.map(choice => choice.label),
        ...(value === unavailableChoice ? [unavailableChoice] : [])], value,
      description: 'Choose a source for this viewer only. Named streams show their reported resolution and codec. Highest resolution may require transcode if the source uses H.265.' + error,
    };
  }

  async getSettings(): Promise<Setting[]> {
    const endpoint = (await sdk.endpointManager.getPath()).replace(/\/$/, '') + '/';
    const href = endpoint.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return [
      { key: 'viewer', title: 'Live viewer', type: 'html', readonly: true,
        value: `<a href="${href}" target="_blank" rel="noopener">Open RTSP Live Viewer</a>` },
      { key: 'cameraIds', title: 'Cameras', type: 'device', multiple: true,
        deviceFilter: "interfaces.includes('VideoCamera')", value: this.config.cameraIds,
        description: 'Leave empty to discover all cameras automatically. Select devices to restrict the viewer.' },
      { key: 'quality', title: 'Default stream policy', choices: ['local', 'highest-resolution', 'low-resolution'], value: this.config.quality,
        description: 'highest-resolution selects the largest reported source directly. local and low-resolution follow each camera’s Rebroadcast destination settings. Individual cameras can override this under Camera streams.' },
      { key: 'videoMode', title: 'Video mode', choices: ['copy', 'transcode'], value: this.config.videoMode,
        description: 'copy passes through H.264 with low CPU use. transcode converts to H.264 with libx264 and costs CPU per camera. Playback is muted.' },
      ...await Promise.all(this.cameras().map(camera => this.cameraStreamSetting(camera))),
    ];
  }

  async putSetting(key: string, value: SettingValue): Promise<void> {
    if (!['cameraIds', 'quality', 'videoMode'].includes(key) && !key.startsWith('stream:')) throw new Error('Unknown or read-only setting.');
    await this.enqueueSettings(async () => {
      let next: ViewerConfig;
      if (key.startsWith('stream:')) {
        const id = decodeURIComponent(key.slice('stream:'.length));
        const camera = sdk.systemManager.getDeviceById<VideoCamera>(id);
        if (!camera?.interfaces?.includes(ScryptedInterface.VideoCamera)) throw new Error('Camera is unavailable.');
        if (typeof value !== 'string') throw new Error('Choose a stream from the available choices.');
        const current = selectedStream(this.config, id);
        let selection: StreamSelection | undefined;
        if (value === inheritChoice) selection = undefined;
        else if (value === unavailableChoice && current?.mode === 'stream') selection = current;
        else {
          const policy = (Object.entries(policyChoices) as [keyof typeof policyChoices, string][]).find(([, label]) => label === value)?.[0];
          if (policy) selection = { mode: 'policy', policy };
          else {
            const choice = streamChoices(await this.streamOptions(id)).find(choice => choice.label === value);
            if (!choice) throw new Error('The stream choices changed. Reopen plugin settings and choose the stream again.');
            selection = { mode: 'stream', id: choice.id };
          }
        }
        const cameraStreams = { ...this.config.cameraStreams };
        if (selection) Object.defineProperty(cameraStreams, id, { value: selection, enumerable: true, configurable: true, writable: true });
        else delete cameraStreams[id];
        next = validateConfig({ ...this.config, cameraStreams });
      } else next = validateConfig({ ...this.config, [key]: value });
      await this.pool.close();
      this.config = next;
      this.storage.setItem('config', JSON.stringify(next));
      this.pool = this.createPool();
      await this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    });
  }

  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    await this.http.handle(request, response);
  }

  async getReadmeMarkdown(): Promise<string> {
    return '# RTSP Live Viewer\n\nOpen **Settings → Live viewer → Open RTSP Live Viewer** while signed in as a Scrypted administrator. All cameras appear automatically. Enable **Rebroadcast** on cameras to share existing camera connections.\n\nIn the viewer, open **Cameras**, choose the **Stream** for each camera, then **Apply**. Source choices are saved for all viewers; visibility is saved in this browser. Each tile also has a **Stream** shortcut. A named source can be selected even when its resolution is not reported.\n\nThe default stream policy is configured in plugin Settings. **highest-resolution** chooses the largest reported source. If resolution metadata is incomplete, playback uses the Scrypted local stream with a notice to choose a source. **local** follows the camera’s Rebroadcast local-stream selection and does not guarantee full resolution. H.265 sources require transcode.\n\nThe window includes a camera grid, click-to-focus view, stats, and reconnect controls. Playback starts on demand and stops after 45 seconds without requests. It uses HLS, with several seconds of delay, and no audio. H.264 copy mode is the default; choose transcode if needed. No extra Docker service or port is required. See the project README for deployment.';
  }

  async release(): Promise<void> {
    process.removeListener('exit', this.exitHandler);
    await this.launcherReady;
    await this.operations;
    await this.pool.close();
  }
}
