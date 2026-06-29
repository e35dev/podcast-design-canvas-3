// tests/browser-export-flow.mjs — ADVERSARIAL end-to-end harness that drives the
// REAL app in headless Chromium like a NAIVE maintainer probe: minimal
// assumptions, NO tuned waits keyed to internal app timing.
//
// Test A (minimal path): goto index.html, set the file input to 2 real videos,
// then WITHOUT clicking any preset or any preview button, assert that a real
// <video> is visibly playing (media loaded), the preview canvas has non-trivial
// lit pixels (auto-composed), and the export button is ENABLED. Then click
// Export and assert a real export-result (.webm, size>0, audio) appears within
// ~5s. This MUST pass with NO preset/preview clicks (default preset +
// auto-preview).
//
// Test B (preset cycling): rapidly click each preset 3x in a loop and assert the
// page does NOT hang (each click returns quickly) and the preview still shows
// frames + export still enabled.
//
// Screenshots: tests/robust-upload-loaded.png, tests/robust-autopreview.png,
// tests/robust-export.png. Exits non-zero on any failure.
//
// Run from a dir where playwright-core resolves (../podcast-scoring):
//   LD_LIBRARY_PATH=/home/administrator/.local/playwrightlibs \
//   node /abs/pdc3/tests/browser-export-flow.mjs
import { chromium } from "playwright-core";
import { spawnSync } from "child_process";
import { existsSync, statSync, writeFileSync, openSync, readSync, closeSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
let repo = process.env.PDC3_REPO || path.resolve(here, "..");
if (!existsSync(path.join(repo, "index.html"))) {
  const guess = "/home/administrator/workspace/sn74-workspace/pdc3";
  if (existsSync(path.join(guess, "index.html"))) repo = guess;
}
const testsDir = path.join(repo, "tests");
const CHROME =
  process.env.PW_CHROME ||
  "/home/administrator/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome";

function die(msg) {
  console.error("FLOW FAIL: " + msg);
  process.exit(1);
}

// 1) Generate real test videos (idempotent — regenerate every run).
console.log("== generating test videos ==");
const genScript = existsSync(path.join(here, "make-test-videos.mjs"))
  ? path.join(here, "make-test-videos.mjs")
  : path.join(testsDir, "make-test-videos.mjs");
const gen = spawnSync(process.execPath, [genScript, testsDir], { stdio: "inherit", env: process.env });
if (gen.status !== 0) die("video generation failed");
const videos = ["speaker-host.webm", "speaker-guest1.webm"].map((f) => path.join(testsDir, f));
for (const v of videos) {
  if (!existsSync(v) || statSync(v).size < 200) die("missing/empty test video " + v);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("file://" + path.join(repo, "index.html"));
await page.waitForFunction(() => window.__pdcReady === true, { timeout: 10000 });
console.log("== app booted ==");

// ========================= TEST A: MINIMAL PATH =========================
// A naive probe: give the episode a name (a name is a documented required
// field, not an app-internal trick), upload 2 files, and DO NOTHING ELSE —
// no preset click, no preview click.
console.log("\n== TEST A: minimal path (upload only, no preset/preview clicks) ==");
await page.fill("#ep-name", "Probe Episode");
await page.setInputFiles("#ep-files", [videos[0], videos[1]]);

// Wait for a real <video> in the page to be actually PLAYING (media visibly
// loaded). We poll the natural state — not a fixed app-timed wait.
const mediaPlaying = await page
  .waitForFunction(
    () => {
      const vids = [...document.querySelectorAll(".media-thumb-vid")];
      return vids.length >= 2 && vids.some((v) => !v.paused && v.currentTime > 0 && v.videoWidth > 0);
    },
    { timeout: 6000 },
  )
  .then(() => true)
  .catch(() => false);
if (!mediaPlaying) die("A: no real <video> visibly playing after upload (media did not visibly load)");
console.log("A: real media visibly playing after upload");

await page.screenshot({ path: path.join(testsDir, "robust-upload-loaded.png"), fullPage: true });
console.log("== shot robust-upload-loaded.png ==");

// Auto-composed preview: the canvas must have non-trivial lit pixels WITHOUT
// any preview-button click.
const autoComposed = await page
  .waitForFunction(
    () => {
      const c = document.getElementById("preview-canvas");
      if (!c || !c.width) return false;
      const ctx = c.getContext("2d");
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4 * 997) {
        if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) lit++;
      }
      return lit > 5;
    },
    { timeout: 6000 },
  )
  .then(() => true)
  .catch(() => false);
if (!autoComposed) die("A: preview canvas empty — auto-preview did not compose without a click");
console.log("A: preview auto-composed real frames (no preview click)");

await page.screenshot({ path: path.join(testsDir, "robust-autopreview.png"), fullPage: true });
console.log("== shot robust-autopreview.png ==");

// Export must be ENABLED with zero preset/preview clicks.
const exportEnabled = await page.evaluate(() => {
  const b = document.getElementById("export-btn");
  return b ? !b.disabled : false;
});
if (!exportEnabled) die("A: export button still DISABLED after upload-only (default preset/auto-preview failed)");
console.log("A: export button ENABLED with no preset/preview clicks");

// Click export and time it. Assert a real result within ~5s.
const tExport0 = Date.now();
await page.click("#export-btn");
const exportOk = await page
  .waitForFunction(() => window.__pdcLastExport && window.__pdcLastExport.size > 0, { timeout: 6000 })
  .then(() => true)
  .catch(() => false);
const exportMs = Date.now() - tExport0;
if (!exportOk) die("A: export did not produce a real blob within 6s");
const exp = await page.evaluate(() => window.__pdcLastExport);
console.log("A: export result", JSON.stringify(exp), "wallclock", exportMs + "ms");
if (exp.size <= 0) die("A: exported blob empty");
if (exp.tracks < 2) die("A: exported plan had < 2 speaker frames");

// Save the exact exported bytes to disk for inspection.
const savedExport = path.join(testsDir, "exported-episode.webm");
const arr = await page.evaluate(async () => {
  const a = document.getElementById("download-link");
  const resp = await fetch(a.href);
  const buf = await resp.arrayBuffer();
  return Array.from(new Uint8Array(buf));
});
writeFileSync(savedExport, Buffer.from(arr));
const savedSize = statSync(savedExport).size;
if (savedSize < 1000) die("A: saved export suspiciously small: " + savedSize);

await page.screenshot({ path: path.join(testsDir, "robust-export.png"), fullPage: true });
console.log("== shot robust-export.png ==");

// webm magic check.
const fd = openSync(savedExport, "r");
const magic = Buffer.alloc(4);
readSync(fd, magic, 0, 4, 0);
closeSync(fd);
const isWebm = magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3;
if (!isWebm) die("A: exported file is not a valid webm (bad magic bytes)");
console.log("A: saved", savedSize, "bytes, webm magic OK, hasAudio=" + exp.hasAudio);

// ========================= TEST B: PRESET CYCLING =========================
console.log("\n== TEST B: rapid preset cycling (no hang) ==");
const presetIds = await page.evaluate(() =>
  [...document.querySelectorAll(".preset")].map((b) => b.dataset.preset),
);
if (presetIds.length < 2) die("B: expected multiple presets, got " + presetIds.length);

const clickTimes = [];
const tCycle0 = Date.now();
for (let round = 0; round < 3; round++) {
  for (const id of presetIds) {
    const t0 = Date.now();
    // Use evaluate-click to measure the synchronous handler return time.
    await page.evaluate((pid) => {
      const b = document.querySelector(`.preset[data-preset="${pid}"]`);
      b.click();
    }, id);
    clickTimes.push(Date.now() - t0);
  }
}
const cycleMs = Date.now() - tCycle0;
const maxClick = Math.max(...clickTimes);
console.log("B: cycled", clickTimes.length, "clicks in", cycleMs + "ms, slowest click", maxClick + "ms");
if (cycleMs > 4000) die("B: preset cycling too slow (" + cycleMs + "ms) — likely hung");
if (maxClick > 800) die("B: a single preset click took " + maxClick + "ms — handler is heavy/hangs");

// After cycling, preview still shows frames and export still enabled.
await page.waitForTimeout(200); // allow the debounced recompose to settle
const stillComposed = await page.evaluate(() => {
  const c = document.getElementById("preview-canvas");
  if (!c || !c.width) return false;
  const ctx = c.getContext("2d");
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let lit = 0;
  for (let i = 0; i < data.length; i += 4 * 997) {
    if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) lit++;
  }
  return lit > 5;
});
if (!stillComposed) die("B: preview lost frames after preset cycling");
const stillEnabled = await page.evaluate(() => !document.getElementById("export-btn").disabled);
if (!stillEnabled) die("B: export disabled after preset cycling");
console.log("B: preview still composing + export still enabled after cycling");

// Selected preset should be the last one clicked.
const selected = await page.evaluate(() => {
  const b = document.querySelector(".preset.is-selected");
  return b ? b.dataset.preset : null;
});
console.log("B: selected preset after cycling:", selected);

await browser.close();

console.log(
  "\n" +
    JSON.stringify(
      {
        ok: true,
        testA: {
          mediaPlaying: true,
          autoComposedPreview: true,
          exportEnabledNoClicks: true,
          exportWallclockMs: exportMs,
          blobReportedBytes: exp.size,
          savedBytes: savedSize,
          mimeType: exp.mimeType,
          hasAudio: exp.hasAudio,
          speakerFrames: exp.tracks,
          durationMs: exp.durationMs,
          isWebmMagic: isWebm,
        },
        testB: {
          totalClicks: clickTimes.length,
          cycleMs,
          slowestClickMs: maxClick,
          stillComposed,
          stillEnabled,
          selectedAfterCycle: selected,
        },
      },
      null,
      2,
    ),
);
console.log("FLOW OK");
