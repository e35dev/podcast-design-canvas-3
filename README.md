# Podcast Design Canvas

Repository: `e35dev/podcast-design-canvas-3`

Create a self-serve visual podcast production workspace where creators transform synced multi-speaker raw recordings into polished, personalized, publishable video episodes without needing a traditional editor.

This repository is maintained against the product direction below. The maintainers use this document, `VISION.md`, and `CONTRIBUTING.md` as the standard for accepting or closing work.

## Who It Serves
- Podcast creators who record with Riverside-style separate synced speaker tracks
- Solo hosts who want professional results without learning a complex editing suite
- Podcast teams and agencies producing repeatable show formats for multiple episodes or clients
- Power users who want to design
- save
- reuse
- and eventually monetize custom podcast layouts

## Product Workflows
- Create a new episode by importing a Riverside link or uploading separate synced video files for each speaker
- then assign each file to clear speaker buckets such as Host
- Guest 1
- and Guest 2.
- Add host and guest social links during setup so the product can understand names
- topics
- references
- brands
- and likely transcript spellings before generating the edit.
- Choose a preset visual style with layout and pacing options
- preview how the episode will look
- and apply it without needing to manually position every element.
- Open a canvas editor to build or customize a reusable podcast layout by dragging and layering speaker video frames
- shapes
- backgrounds
- captions
- title elements
- b-roll areas
- and overlays.
- Clean and balance episode audio with simple controls for noise reduction
- leveling
- enhancement
- and speech clarity
- presented as creator-facing quality choices rather than technical audio settings.
- Use contextual editing tools to add captions
- b-roll overlays
- visual callouts
- title moments
- and short-form-style engagement patterns at key moments across a full-length episode.
- Save a finished layout or style as a reusable show template so future episodes can keep the same identity while still adapting to each episode's speakers and topics.
- Export a polished long-form video episode that feels deliberately edited
- visually coherent
- accurately captioned
- and ready to publish.

## Intended End State

A creator can go from raw synced podcast tracks and a few social links to a finished, professional-looking long-form episode with clean audio, accurate text, personalized context, engaging visual moments, and a reusable visual identity for the show.

## Product Taste
- The product should feel like Canva adapted to podcast production: visual
- direct manipulation
- simple defaults
- and creative freedom for advanced users.
- The default experience should emphasize preset quality: users should be able to get a polished result by choosing from clear style
- layout
- and pacing options.
- The pro experience should expose flexible canvas controls for custom layouts
- layered shapes
- branded frames
- captions
- overlays
- and reusable templates.
- The system should support many podcast identities rather than a single house look: every show should be able to feel distinct.
- Visual edits should feel professional and intentional: clean framing
- coherent layouts
- readable captions
- tasteful overlays
- and rhythm that keeps a long episode engaging.
- Social context should make the edit smarter: better transcript spellings
- relevant b-roll choices
- more accurate references
- better on-screen context
- and captions or titles that fit the people speaking.

## Accept Work That
- Merge clean PRs that pass CI, match the Vision Model, and improve an accepted workflow or quality bar.
- Prefer small coherent changes that can ship immediately over broad speculative rewrites.
- Treat product taste and user workflow fit as first-class acceptance criteria.
- Summarize merged work as product progress, not as raw PR activity.

## Close Work That
- Close PRs that are incomplete, off-vision, overlapping, stale, or likely to create product drift.
- Do not leave requested-change queues by default. Close with clear resubmission guidance.
- Close technically correct PRs when they solve the wrong problem or move the product away from the captured vision.
- If a PR is promising but messy, explain the clean smaller PR that should be submitted next.

## Scoring Labels

This repo does not require Gittensor scoring labels on merged PRs. The registry uses `default_label_multiplier: 1.0`, so accepted merged PRs score without a `gittensor:*` label.

Maintainer-only operational labels such as active-step labels may exist, but contributors should not add labels to make work score.

## Verification
- Run or preserve `typecheck` before submitting product work.
- Run or preserve `lint` before submitting product work.
- Run or preserve `test` before submitting product work.
- Run or preserve `preview-build` before submitting product work.

## How to run

Requires Node 18+.

```bash
npm install        # install dependencies
npm run dev        # start the dev server (Vite)
```

Then open the printed local URL, click **New episode**, upload at least two
synced speaker video files, assign Host / Guest 1 / Guest 2, optionally add
social links, pick a preset, preview the composed episode, and click
**Export & download** to produce a real downloadable video file.

### Verification commands

```bash
npm run typecheck    # tsc -b (type-check the whole project)
npm run lint         # eslint, no warnings allowed
npm run test         # vitest run (unit tests)
npm run preview-build # production build (one-shot shippability check)
npm run test:e2e     # Playwright: drives the real import->preset->preview->export flow
```

The end-to-end test (`tests/browser-flow.spec.ts`) generates two short, real,
decodable `.webm` clips in-browser, uploads them, assigns Host/Guest buckets,
adds social links, picks a preset, verifies the composed preview paints the
real frames, triggers an export, and asserts a real downloadable video file
(with real bytes) is produced. It auto-starts and stops a preview server and
saves screenshots under `tests/screenshots/`.

### How export works

Export is fully real and client-side. The preview `<canvas>` (which is already
composing the real uploaded `<video>` streams into the selected layout) is
captured via `canvas.captureStream()`, the per-speaker audio tracks are mixed
through a Web Audio `MediaStreamAudioDestinationNode`, and the combined stream
is recorded with `MediaRecorder` into a downloadable WebM file. Recording runs
in real time and stops automatically at the end of the longest speaker track.

### Scope of the current step

This implements the first product step: the import-to-export flow. Canvas
drag-editing, audio cleanup controls, captions/b-roll, and reusable templates
are intentionally out of scope here and tracked as later steps.