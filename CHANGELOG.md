# Changelog

## 0.1.8 — 2026-11-19

- Update the Scrypted SDK from 0.5.59 to 0.5.61.
- Fix security advisories in build and packaging dependencies: ZIP handling (`adm-zip`), JavaScript serialization (`serialize-javascript`), and file-pattern matching (`glob` and `minimatch`).
- Use a compatible patched Rollup minifier and refresh the SDK's file-cleanup dependency.

Camera playback, stream selection, settings, and the bundled hls.js version remain unchanged. No settings migration is required.
