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

## End-to-end browser proof (adversarial, naive-probe style)
`tests/browser-export-flow.mjs` drives the **running app** in headless Chromium
like a NAIVE maintainer probe — minimal assumptions, NO tuned waits keyed to the
app's internal timing. It generates tiny real `.webm` speaker videos
(`tests/make-test-videos.mjs`) and runs two tests:

- **Test A (minimal path):** name the episode, upload 2 videos, then — WITHOUT
  clicking any preset or any preview button — assert (a) a real `<video>` is
  visibly playing in the page, (b) the preview canvas has auto-composed
  non-trivial lit pixels, and (c) the **Export** button is ENABLED. Then click
  Export and confirm a real `.webm` Blob (VP8 video + Opus audio, size > 0)
  appears within a few seconds. This passes with the default preset +
  auto-preview, no extra clicks.
- **Test B (preset cycling):** rapidly click each preset 3× and assert no hang
  (each click returns fast) and the preview still composes + export still
  enabled afterward.

The exported file is never committed; it is produced by the app on each run.

Run it from a checkout where `playwright-core` resolves. The repo has no deps of
its own, so symlink a checkout that has `playwright-core` installed (e.g.
`../podcast-scoring`) as `node_modules` (gitignored), then:
```
ln -sfn ../podcast-scoring/node_modules node_modules
LD_LIBRARY_PATH=/path/to/playwrightlibs \
PW_CHROME=/path/to/chrome \
node tests/browser-export-flow.mjs
```
It writes `tests/robust-upload-loaded.png` (videos playing right after upload),
`tests/robust-autopreview.png` (auto-composed preview), and
`tests/robust-export.png` (export complete), and prints the exported byte size,
mime type, audio flag, export wall-clock, and preset-cycle timing.
