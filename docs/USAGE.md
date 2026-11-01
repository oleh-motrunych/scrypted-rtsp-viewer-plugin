# Viewer guide

Install `scrypted-rtsp-viewer` through Scrypted's plugin installer and enable **Rebroadcast** on your cameras. Open **RTSP Live Viewer** from Scrypted's launcher, or use **Plugins → RTSP Live Viewer → Settings → Open RTSP Live Viewer**.

Sign in to the Scrypted Management Console as an administrator first. The direct viewer address is `https://YOUR_SCRYPTED_HOST:10443/endpoint/scrypted-rtsp-viewer/`. You can bookmark it for quick access.

## Viewer controls

- **Layout:** one to four columns; mobile screens use a single column.
- **Click a camera:** large spotlight with the other streams in a sidebar. Click another tile to switch; use **Back to Grid** or Escape to return.
- **Show Stats / ℹ:** playback bandwidth estimate, resolution, decoded FPS, buffer, dropped frames, and delay behind the HLS live edge. Bandwidth is an estimate of download capacity, not camera encoding bitrate. Live edge delay excludes camera capture and encoding delay. Native Safari HLS leaves unavailable estimates blank.
- **Reconnect All / Retry:** recreate browser players and reopen stopped or stalled server sessions. Healthy pipelines remain shared with other viewers.
- **Refresh Cameras:** discover newly added or removed devices.
- **Cameras:** each camera has a visibility checkbox and a **Stream** dropdown. Select a named main/substream or a stream policy, then click **Apply**. Source choices are saved in the plugin for all viewers; visibility and column count stay in this browser. Only cameras whose source changed reconnect.
- **Stream** on a tile, or **Choose stream** on an error: opens Cameras and focuses that camera's dropdown.

## Plugin settings

| Setting | Behavior |
| --- | --- |
| Cameras | Empty means all cameras. Select specific devices to restrict which cameras the viewer serves. |
| Default stream policy | `highest-resolution` selects the largest source reported by each camera using an explicit stream ID. `local` follows the camera's Rebroadcast local destination; it does not guarantee full resolution. `low-resolution` follows its low-resolution destination. |
| Camera streams → camera name | Override the default with a specific source, **Highest resolution**, **Scrypted local stream**, or **Scrypted low-resolution stream**. Named sources show reported resolution and codec. **Use default stream policy** removes the override. |
| Video mode | `copy` passes through H.264 video with low CPU usage. `transcode` converts video to H.264 using `libx264`, with a CPU cost for every active camera. |

Settings changes close current playback sessions; open viewers reconnect automatically. Missing Rebroadcast is shown in the camera chooser. Without that extension, the camera provider may open an additional upstream connection when the viewer requests a stream.

Stream choices affect only this plugin's requests. They do not change the camera's Rebroadcast, HomeKit, or recording configuration. Resolution is the camera's native source resolution; choosing a stream does not upscale it. Highest-resolution mode chooses by pixel count and can select an H.265 source; use transcode for that source, or explicitly select an H.264 source with copy mode. If multiple streams have incomplete resolution metadata, playback uses the Scrypted local stream and shows a notice; open **Cameras** and explicitly choose a named source to control its quality. Sources can be selected even when their resolution is not reported. A missing explicitly selected source produces an error with a **Choose stream** action. Reopen Cameras to refresh the choices when camera streams change. Listing choices does not open video playback.

## Playback and troubleshooting

- Playback is video-only and does not record. Streams start when viewed and stop after they are no longer used.
- HLS playback has several seconds of delay. For faster startup in copy mode, configure the camera for H.264 with a 1–2 second keyframe interval.
- For H.265 sources, select **transcode** or choose an H.264 source for **copy** mode. Transcoding uses more server CPU for each active camera.
- If a camera is missing, check that it is configured in Scrypted, click **Refresh Cameras**, and review the plugin's **Cameras** setting.
- If playback fails, use **Retry** or **Reconnect All**. Use **Choose stream** to replace a source that is no longer available.
- Refresh the Scrypted page after upgrading if the launcher tile has not appeared.

[Back to the README](../README.md)
