# Scrypted RTSP Live Viewer

A separate Scrypted plugin with the same dark camera grid, spotlight view, stream stats, and reconnect controls as the RTSP viewer. It discovers cameras already configured in Scrypted and opens their streams through the camera SDK. With the Rebroadcast extension enabled, those requests use the existing rebroadcast pipeline. No RTSP URLs or camera passwords are entered in this plugin.

## Install into an existing Scrypted server

Requires Node.js 20+ on the build machine and FFmpeg on the Scrypted server (normally supplied by Scrypted).

```sh
npm ci
npm run check
npm run scrypted-login -- YOUR_SCRYPTED_HOST:10443
npm run scrypted-deploy -- YOUR_SCRYPTED_HOST:10443
```

Use `HOST:PORT`, without `https://`. Login prompts for your Scrypted administrator username and password and saves a token in `~/.scrypted/login.json`. Use the same host for both commands. The deployment helper uploads the compiled plugin to the running server; it does not start another Scrypted instance. Nothing is published to npm by these commands.

Scrypted commonly uses a self-signed certificate. The helper accepts that certificate automatically **only for loopback** (`127.0.0.1`, `::1`, or `localhost`). For other hosts, use a trusted certificate or set `SCRYPTED_CA_FILE=/path/to/your-ca.pem` for both commands. An SSH tunnel can expose a remote server through local loopback if necessary.

After deployment:

1. In Scrypted, enable **Rebroadcast** on each camera under its extensions.
2. Open **Plugins → RTSP Live Viewer → Settings → Open RTSP Live Viewer**.
3. All `VideoCamera` devices appear automatically. Live video is marked green. Use **Cameras** to hide tiles in this browser.
4. To choose video quality in this plugin, set **Default stream policy** or choose sources per camera under **Camera streams**.

For quick access, open Scrypted's launcher and click **RTSP Live Viewer**. Version 0.1.3 registers a launcher tile automatically, linked directly to the camera grid. Refresh the Scrypted page after upgrading. You can also bookmark the viewer URL. Opening the launcher alone does not start camera playback.

The direct viewer address is `https://YOUR_SCRYPTED_HOST:10443/endpoint/scrypted-rtsp-viewer/`. Sign in to the Scrypted Management Console first. The plugin endpoint requires an administrator session and rejects public access.

After a version is published to npm, users can install it from Scrypted's **Plugins → Install Plugin** by entering `scrypted-rtsp-viewer`. Maintainer release instructions are below under **Publishing to npm**.

## Deploy from a Linux server with Docker

If the Scrypted server has Docker but no Node.js, copy this source directory to it, then run:

```sh
docker build -t scrypted-rtsp-viewer-deploy .
docker run --rm -it --network host \
  -v scrypted-viewer-auth:/root/.scrypted \
  scrypted-rtsp-viewer-deploy login 127.0.0.1:10443
docker run --rm --network host \
  -v scrypted-viewer-auth:/root/.scrypted \
  scrypted-rtsp-viewer-deploy deploy 127.0.0.1:10443
```

These temporary containers build and upload the plugin; playback runs inside the existing Scrypted server. No extra port, persistent streamer container, or recording disk mount is needed. Linux host networking lets the uploader reach Scrypted's published HTTPS port on loopback. Docker Desktop requires host networking to be enabled. For a remote destination, provide a trusted certificate, or mount your CA file and set `SCRYPTED_CA_FILE`.

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

### Update from earlier versions

Deploy 0.1.3 with the same Docker commands and credentials volume, then refresh Scrypted to see the new **RTSP Live Viewer** launcher tile. Existing camera selections, video mode, stream policy, and saved source overrides are preserved. Open **Cameras**, choose the main stream for each affected camera, and **Apply**. Exact source choices work without reported resolution metadata. To change the default for all cameras, use **Default stream policy** in the Scrypted plugin settings. A highest-resolution policy with incomplete metadata keeps playback available using the local stream and a visible notice.

## Playback and resource use

- One FFmpeg process per viewed camera, shared across browser tabs. Each displayed camera uses network bandwidth and a browser video decoder.
- Playback is on demand. No camera stream starts until a viewer opens it. Sessions stop after **45 seconds** without playlist or segment requests. Browser shutdown and hiding tiles allow sessions to expire; another viewer can keep them active.
- Video-only HLS playback, muted. This is a live viewer and does not save recordings. A short rolling set of temporary segments is deleted as the stream advances and on normal session shutdown. An abrupt server/host crash can leave a temporary `scrypted-live-viewer-*` directory in the server's system temporary directory.
- HLS has several seconds of delay. Copy mode cuts at the camera's existing keyframes; configure H.264 and a 1–2 second keyframe interval for faster startup. Choose transcode for H.265 or other formats, provided FFmpeg can decode them. `libx264` must be available for transcode mode.
- Camera streams with expiring sessions are refreshed through the Scrypted API when the provider supplies a refresh deadline.
- Playback assets, including hls.js, are bundled locally. The browser does not load scripts from a CDN.
- The plugin does not change camera, HomeKit, recording, or Rebroadcast settings.

## Build and local verification

```sh
npm run check
npm run preview
```

The preview runs at `http://127.0.0.1:8099/endpoint/scrypted-rtsp-viewer/` and uses generated test video, **not real cameras**. It serves the same HTTP handler and production UI and intentionally simulates an administrator session. It binds only to loopback. FFmpeg must be installed locally. Override its path with `FFMPEG_PATH` if needed.

`npm run build` produces `dist/plugin.zip` for Scrypted and the compiled CommonJS plugin. `npm pack` creates an npm tarball without publishing. Tests exercise explicit/highest-resolution source selection, settings migration, missing-source errors, pinned stream refresh, FFmpeg HLS generation, pipeline sharing, access checks, cleanup, and the production plugin bundle with a simulated Scrypted SDK. Real-camera playback still requires deployment and verification on your Scrypted server.

Scrypted API references: [plugin development](https://developer.scrypted.app/plugins.html), [HTTP handlers](https://developer.scrypted.app/gen/interfaces/HttpRequestHandler.html), and [stream requests](https://developer.scrypted.app/gen/interfaces/RequestMediaStreamOptions.html).

## Publishing to npm

[Publish to npm](.github/workflows/publish-npm.yml) runs when a `v*` tag is pushed. It requires the tag to match `package.json` exactly, installs FFmpeg, runs `npm run check`, and verifies that the npm tarball includes the Scrypted plugin ZIP, compiled entry point, README, and licenses. It publishes that tarball to npm. Stable versions use `latest`; prerelease versions such as `0.2.0-beta.1` use `next`.

### Configure npm authentication once

The workflow supports [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) through GitHub OIDC. Configure the package's npm **Settings → Trusted publishing** with:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `oleh-motrunych` |
| Repository | `scrypted-rtsp-viewer-plugin` |
| Workflow filename | `publish-npm.yml` |
| Environment name | Leave empty |
| Allowed actions | Allow direct publishing with `npm publish` |

For the first publication, before the package has npm settings, add a GitHub repository Actions secret named `NPM_TOKEN`. Use an [npm granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens/) with read/write access that permits creating the package and **Bypass two-factor authentication** enabled. The npm account must be allowed to publish `scrypted-rtsp-viewer`. Do not commit the token. After the first publication, configure the trusted publisher and remove the `NPM_TOKEN` secret; subsequent releases use OIDC. A newly configured trusted publisher must publish successfully within two days or be recreated.

### Publish a release

Merge the workflow and package metadata into `main` before tagging. To publish the current version, push a matching tag; for example, when `package.json` is `0.1.3`:

```sh
git switch main
git pull --ff-only
git tag v0.1.3
git push origin v0.1.3
```

For later releases, increment the version and push the version commit and its tag:

```sh
npm version patch
git push origin main --follow-tags
```

Check the **Publish to npm** run in GitHub Actions. Each npm version can be published only once. Pushing a branch or opening a pull request does not publish a package.

## Publishing source

Keep Scrypted login tokens, `.env` files, npm credentials, private keys, logs, and local release artifacts out of Git. The ignore rules cover these common files, including `login.json` when `SCRYPTED_AUTH_DIR` points inside this directory. Ignore rules do not remove files already committed or protect files uploaded separately.

After reviewing and committing the public files, export source with `git archive` from the reviewed commit. This avoids the local usernames, file ownership, and Apple metadata that macOS filesystem archives can include:

```sh
mkdir -p artifacts
git archive --format=tar.gz --prefix=scrypted-rtsp-viewer/ \
  --output=artifacts/scrypted-rtsp-viewer-source.tar.gz HEAD
```

Review npm packages and release downloads separately. `npm pack` includes the compiled `dist` directory through the package's `files` allowlist even though Git ignores it.
