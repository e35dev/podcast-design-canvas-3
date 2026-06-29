# Tests & verification

This product is a plain static web app — no build step, no runtime dependencies.

## Run the app
Open `index.html` in a browser (or serve the repo statically). Then drive the
flow: create an episode → upload two or more local speaker video files → assign
each to Host / Guest 1 / Guest 2 → add social links → pick a preset → start the
live preview → click **Export episode video** to download a real `.webm`
composed from your uploaded videos (layout + audio).

## Unit tests (zero dependencies)
```
node scripts/run-tests.mjs       # discovers tests/*.test.js, runs each via node
node scripts/preview-build.mjs   # static-shippability check
```
These cover the DOM-free models: episode/bucket/social validation, preset layout
composition, and the export composition plan.

## End-to-end browser proof (real export)
`tests/browser-export-flow.mjs` drives the **running app** in headless Chromium
exactly as a user would: it generates tiny real `.webm` speaker videos
(`tests/make-test-videos.mjs`), uploads them via the file input, assigns buckets,
fills social, selects a preset, starts the preview (asserting real composed
frames are drawn — not a placeholder), clicks Export, and confirms a real
downloadable `.webm` Blob (`video/webm`, VP8 video + Opus audio) is produced
**live** within a couple of seconds. The exported file is never committed; it is
produced by the app on each run.

Run it from a checkout where `playwright-core` is installed (set `PDC3_REPO` to
this repo when the driver is copied elsewhere):
```
LD_LIBRARY_PATH=/path/to/playwrightlibs \
PDC3_REPO=/abs/path/to/this/repo \
node tests/browser-export-flow.mjs
```
It writes `tests/flow-upload.png`, `tests/flow-preview.png`, `tests/flow-export.png`
as evidence and prints the exported byte size, mime type, and whether audio is
present.
