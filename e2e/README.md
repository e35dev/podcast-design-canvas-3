# Live issue #25 workflow smoke (Playwright)

This folder keeps a browser-only workflow test that exercises:

- uploading separate synced speaker files
- assigning them to Host / Guest 1 / Guest 2
- selecting a preset
- previewing the composed output
- exporting a real playable artifact
- resetting to a fresh episode state

It is isolated from the main app checks so it does not affect
`npm run typecheck`, `npm run lint`, `npm test`, or the existing
`smoke:live` script.

## Setup

```bash
cd e2e
npm install
```

## Run

```bash
APP_URL=http://127.0.0.1:5174/ LIVE_MEDIA_DIR=/tmp/pdc-media npm test
```

If media is in different filenames, set:

- `LIVE_MEDIA_HOST`
- `LIVE_MEDIA_GUEST1`
- `LIVE_MEDIA_GUEST2`

Optional browser override:

- `PDC_CHROME_PATH=/usr/bin/google-chrome`

### Expected test output

- One passing Playwright test: `issue #25 import-to-export workflow`
- Export artifact blob read from `.download-link` has non-zero size
