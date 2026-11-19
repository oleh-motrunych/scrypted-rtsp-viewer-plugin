# Developer guide

Build, test, deploy, and release the plugin from this repository. For normal installation and use, see the [README](../README.md) and [viewer guide](USAGE.md).

## Build and local verification

Requires Node.js 20+ and local FFmpeg for the playback tests and preview.

```sh
npm ci
npm run check
npm run preview
```

The preview runs at `http://127.0.0.1:8099/endpoint/scrypted-rtsp-viewer/` and uses generated test video, **not real cameras**. It serves the same HTTP handler and production UI and intentionally simulates an administrator session. It binds only to loopback. FFmpeg must be installed locally. Override its path with `FFMPEG_PATH` if needed.

`npm run build` produces `dist/plugin.zip` for Scrypted and the compiled CommonJS plugin. `npm pack` creates an npm tarball without publishing. Tests exercise explicit/highest-resolution source selection, settings migration, missing-source errors, pinned stream refresh, FFmpeg HLS generation, pipeline sharing, access checks, cleanup, and the production plugin bundle with a simulated Scrypted SDK. Real-camera playback still requires deployment and verification on your Scrypted server.

Scrypted API references: [plugin development](https://developer.scrypted.app/plugins.html), [HTTP handlers](https://developer.scrypted.app/gen/interfaces/HttpRequestHandler.html), and [stream requests](https://developer.scrypted.app/gen/interfaces/RequestMediaStreamOptions.html).

## Deploy to a Scrypted server

Requires Node.js 20+ on the build machine and FFmpeg on the Scrypted server (normally supplied by Scrypted).

```sh
npm ci
npm run check
npm run scrypted-login -- YOUR_SCRYPTED_HOST:10443
npm run scrypted-deploy -- YOUR_SCRYPTED_HOST:10443
```

Use `HOST:PORT`, without `https://`. Login prompts for your Scrypted administrator username and password and saves a token in `~/.scrypted/login.json`. Use the same host for both commands. The deployment helper uploads the compiled plugin to the running server; it does not start another Scrypted instance. Nothing is published to npm by these commands.

Scrypted commonly uses a self-signed certificate. The helper accepts that certificate automatically **only for loopback** (`127.0.0.1`, `::1`, or `localhost`). For other hosts, use a trusted certificate or set `SCRYPTED_CA_FILE=/path/to/your-ca.pem` for both commands. An SSH tunnel can expose a remote server through local loopback if necessary.

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

## Playback and resource use

- One FFmpeg process per viewed camera, shared across browser tabs. Each displayed camera uses network bandwidth and a browser video decoder.
- Playback is on demand. No camera stream starts until a viewer opens it. Sessions stop after **45 seconds** without playlist or segment requests. Browser shutdown and hiding tiles allow sessions to expire; another viewer can keep them active.
- Video-only HLS playback, muted. This is a live viewer and does not save recordings. A short rolling set of temporary segments is deleted as the stream advances and on normal session shutdown. An abrupt server/host crash can leave a temporary `scrypted-live-viewer-*` directory in the server's system temporary directory.
- HLS has several seconds of delay. Copy mode cuts at the camera's existing keyframes; configure H.264 and a 1–2 second keyframe interval for faster startup. Choose transcode for H.265 or other formats, provided FFmpeg can decode them. `libx264` must be available for transcode mode.
- Camera streams with expiring sessions are refreshed through the Scrypted API when the provider supplies a refresh deadline.
- Playback assets, including hls.js, are bundled locally. The browser does not load scripts from a CDN.
- The plugin does not change camera, HomeKit, recording, or Rebroadcast settings.

## Publishing to npm

[Publish to npm](../.github/workflows/publish.yml) runs when a `v*` tag is pushed. It requires the tag to match `package.json` exactly, installs FFmpeg, runs `npm run check`, and verifies that the npm tarball includes the Scrypted plugin ZIP, compiled entry point, README, and licenses. It publishes that tarball to npm. Stable versions use `latest`; prerelease versions such as `0.2.0-beta.1` use `next`.

### Configure npm authentication once

The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) through GitHub OIDC. No `NPM_TOKEN` secret is needed. The package's npm **Settings → Trusted publishing** must match:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `oleh-motrunych` |
| Repository | `scrypted-rtsp-viewer-plugin` (no leading slash) |
| Workflow filename | `publish.yml` |
| Environment name | `scrypted-rtsp-viewer-plugin` |
| Allowed actions | Allow direct publishing with `npm publish` |

A newly configured trusted publisher remains pending until a successful publish from this workflow. Complete that publish within two days of configuring the publisher; if the configuration expires, delete and recreate it in npm.

### Publish a release

To release the next patch, first merge the changes into `main`, then run:

```sh
git switch main
git pull --ff-only
npm version patch
git push origin main --follow-tags
```

`npm version patch` updates both package files and creates a matching version tag. The tag push starts the workflow; check **Actions → Publish to npm** for the result. Each npm version can be published only once. Pushing a branch or opening a pull request does not publish a package.

## Publishing source

Keep Scrypted login tokens, `.env` files, npm credentials, private keys, logs, and local release artifacts out of Git. The ignore rules cover these common files, including `login.json` when `SCRYPTED_AUTH_DIR` points inside this directory. Ignore rules do not remove files already committed or protect files uploaded separately.

After reviewing and committing the public files, export source with `git archive` from the reviewed commit. This avoids the local usernames, file ownership, and Apple metadata that macOS filesystem archives can include:

```sh
mkdir -p artifacts
git archive --format=tar.gz --prefix=scrypted-rtsp-viewer/ \
  --output=artifacts/scrypted-rtsp-viewer-source.tar.gz HEAD
```

Review npm packages and release downloads separately. `npm pack` includes the compiled `dist` directory through the package's `files` allowlist even though Git ignores it.
