# Scrypted RTSP Live Viewer

A live camera grid for cameras already configured in Scrypted, with a spotlight view, stream stats, and reconnect controls. It uses your existing camera streams; no RTSP URLs or camera passwords are entered in this plugin.

## Installation

1. In the Scrypted Management Console, open **Plugins → Install Plugin**.
2. Enter `scrypted-rtsp-viewer` and install it.
3. Enable **Rebroadcast** under each camera's extensions.
4. Open **RTSP Live Viewer** from the Scrypted launcher, or use **Plugins → RTSP Live Viewer → Settings → Open RTSP Live Viewer**.

Sign in to Scrypted as an administrator before opening the viewer.

## Using the viewer

- Choose one to four columns, or click a camera for a larger spotlight view.
- Open **Cameras** to show or hide tiles and select a main stream or substream. Click **Apply** to save stream choices.
- Use **Show Stats** to see resolution, decoded FPS, buffer, and estimated playback bandwidth.
- Use **Retry** or **Reconnect All** if playback stalls.
- Click **Refresh Cameras** after adding or removing cameras in Scrypted.

## Stream settings

Set **Default stream policy** in the plugin settings, or choose a source for each camera in **Cameras**. Select a specific main stream when you want full camera resolution.

Use **copy** mode with H.264 for lower server CPU use. For H.265 sources, select **transcode** or choose an H.264 stream. Transcoding uses more CPU for each active camera.

## Playback notes

- Video-only playback; audio is not supported and the viewer does not record.
- Streams start on demand and stop when no longer used.
- HLS playback has several seconds of delay.
- Stream choices apply to this viewer and do not change recording or HomeKit settings.

For detailed controls, settings, and troubleshooting, see the [viewer guide](https://github.com/oleh-motrunych/scrypted-rtsp-viewer-plugin/blob/main/docs/USAGE.md).

Build, source deployment, and release procedures are in the [developer guide](https://github.com/oleh-motrunych/scrypted-rtsp-viewer-plugin/blob/main/docs/DEVELOPMENT.md).
