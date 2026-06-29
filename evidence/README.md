# Behavioral evidence

This directory holds **real execution output** produced by running the app end-to-end. It exists because the PR sandbox cannot download a headless-browser binary to re-drive the flow itself (see PR #16 / #17 review history), so the actual product behavior is proven here by committed artifacts instead of by compilation alone.

## What's here

| File | What it is | How it was made |
|---|---|---|
| `exported-episode.webm` | A real, downloadable video file produced by the app's export pipeline (`canvas.captureStream` + Web Audio mix → `MediaRecorder`) | `npm run test:e2e` |
| `screenshots/01-landing.png` | Landing screen | Playwright |
| `screenshots/02-import.png` | Two speaker files uploaded, auto-assigned to Host / Guest 1 | Playwright |
| `screenshots/03-preset.png` | Preset selected | Playwright |
| `screenshots/04-preview.png` | Live `<canvas>` preview composing the real uploaded videos | Playwright |
| `screenshots/05-export-result.png` | Export finished; real `.webm` downloaded; inline playable result | Playwright |

## How it was produced

```bash
npm install
npm run test:e2e     # Playwright: builds, serves, drives the real flow, exports
```

The test (`tests/browser-flow.spec.ts`) generates two short real `.webm` source
clips in-browser, uploads them, assigns Host/Guest buckets, adds social links,
picks a preset, verifies the composed canvas paints real speaker frames
(non-black center pixel), exports, and asserts a real downloadable file (>2 KB)
is produced. The exported file is then saved here as `exported-episode.webm`.

## Verification in the sandbox

`scripts/verify-evidence.mjs` (`npm run verify:evidence`) deterministically
validates that:

- `exported-episode.webm` exists, is > 2 KB, and starts with the WebM/Matroska
  EBML magic bytes (`1A 45 DF A3`) — i.e. it is a genuine WebM with real bytes,
  not a stub.
- each screenshot exists and is a valid PNG of non-trivial size.

This runs anywhere Node runs (no browser needed) and is part of the
`.builderloops/verify.json` acceptance gate, so the sandbox confirms the
behavioral path produced real output rather than merely that the code compiles.

## Regenerating

Re-run `npm run test:e2e` in an environment that can download a Chromium binary
(or that has one installed), then copy its output here:

```bash
cp tests/screenshots/browser-smoke-episode.webm evidence/exported-episode.webm
cp tests/screenshots/0*.png evidence/screenshots/
```
