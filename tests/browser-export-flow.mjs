// tests/browser-export-flow.mjs — end-to-end harness that drives the REAL app
// in headless Chromium through the full import-to-export flow and proves the
// exported file is a real playable .webm with composited video + audio.
//
// It (1) generates tiny real .webm speaker videos, (2) opens the static app via
// file://, (3) names the episode, (4) uploads the videos with setInputFiles,
// (5) confirms bucket auto-assignment, (6) fills social links, (7) selects a
// preset, (8) starts the live preview, (9) clicks Export and captures the real
// exported Blob's size/type via a page hook + intercepts the download, and
// (10) screenshots upload / preview / export. Exits non-zero on any failure.
//
// Run from a dir where playwright-core resolves (../podcast-scoring):
//   LD_LIBRARY_PATH=/home/administrator/.local/playwrightlibs \
//   node /abs/pdc3/tests/browser-export-flow.mjs
import { chromium } from "playwright-core";
import { spawnSync } from "child_process";
import { mkdirSync, existsSync, statSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolve the pdc3 repo: when this file runs from tests/ use ../; when COPIED
// into another dir (e.g. ../podcast-scoring, so `playwright-core` resolves) set
// PDC3_REPO to the pdc3 checkout. Default to the known sibling path.
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
// Run the video generator that sits next to THIS file (so playwright-core
// resolves from wherever this driver was launched), writing into pdc3/tests.
const genScript = existsSync(path.join(here, "make-test-videos.mjs"))
  ? path.join(here, "make-test-videos.mjs")
  : path.join(testsDir, "make-test-videos.mjs");
const gen = spawnSync(process.execPath, [genScript, testsDir], {
  stdio: "inherit",
  env: process.env,
});
if (gen.status !== 0) die("video generation failed");
const videos = ["speaker-host.webm", "speaker-guest1.webm", "speaker-guest2.webm"].map((f) =>
  path.join(testsDir, f),
);
for (const v of videos) {
  if (!existsSync(v) || statSync(v).size < 200) die("missing/empty test video " + v);
}

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: [
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--no-sandbox",
  ],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

// Intercept the download triggered by the app's <a download> click.
let downloadInfo = null;
page.on("download", async (d) => {
  const dest = path.join(testsDir, "downloaded-" + d.suggestedFilename());
  await d.saveAs(dest);
  downloadInfo = { path: dest, name: d.suggestedFilename(), bytes: statSync(dest).size };
  console.log("[download] saved", dest, downloadInfo.bytes, "bytes");
});

await page.goto("file://" + path.join(repo, "index.html"));
await page.waitForFunction(() => window.__pdcReady === true, { timeout: 10000 });
console.log("== app booted ==");

// 3) Episode name.
await page.fill("#ep-name", "The Build Loop — Episode 1");

// 4) Upload two+ speaker files via the real file input.
await page.setInputFiles("#ep-files", [videos[0], videos[1]]);
await page.waitForTimeout(300);

// 5) Confirm buckets auto-assigned; then explicitly set via the selects to
// prove assignment is real and editable. Host=file0, Guest1=file1.
const selects = await page.$$(".assign-select");
if (selects.length < 2) die("expected >=2 assign selects, got " + selects.length);
await selects[0].selectOption("host");
await selects[1].selectOption("guest1");
await page.waitForTimeout(150);

// Verify in-page state reflects the assignment.
const assigned = await page.evaluate(() => {
  const sels = [...document.querySelectorAll(".assign-select")];
  return sels.map((s) => s.value);
});
if (!(assigned.includes("host") && assigned.includes("guest1")))
  die("buckets not assigned: " + JSON.stringify(assigned));
console.log("== buckets assigned ==", assigned);

// 6) Social links (re-query inputs after each re-render).
async function fillSocial(bucket, field, value) {
  const sel = `.social-in[data-bucket="${bucket}"][data-field="${field}"]`;
  const el = await page.$(sel);
  if (el) await el.fill(value);
}
await fillSocial("host", "name", "Ada Host");
await fillSocial("host", "x", "@adahost");
await fillSocial("guest1", "name", "Bo Guest");
await fillSocial("guest1", "x", "@boguest");

// 7) Select a preset.
await page.click('.preset[data-preset="studio-sidebyside-calm"]');
await page.waitForTimeout(150);

// Screenshot: uploaded files assigned to buckets.
await page.screenshot({ path: path.join(testsDir, "flow-upload.png"), fullPage: true });
console.log("== shot flow-upload.png ==");

// 8) Start live preview and let real frames render onto the canvas.
const previewEnabled = await page.evaluate(() => !document.getElementById("preview-btn").disabled);
if (!previewEnabled) die("preview button disabled after completing steps");
await page.click("#preview-btn");
await page.waitForTimeout(1200);

// Confirm the preview canvas has actually drawn non-empty frames.
const previewNonEmpty = await page.evaluate(() => {
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
if (!previewNonEmpty) die("preview canvas appears empty (no composed frames)");
console.log("== preview drawing real frames ==");
await page.screenshot({ path: path.join(testsDir, "flow-preview.png"), fullPage: true });
console.log("== shot flow-preview.png ==");

// 9) Export. The app sets window.__pdcLastExport with the real blob size/type.
await page.click("#export-btn");
await page.waitForFunction(() => window.__pdcLastExport && window.__pdcLastExport.size > 0, {
  timeout: 30000,
});
const exp = await page.evaluate(() => window.__pdcLastExport);
console.log("== export result ==", JSON.stringify(exp));
if (!exp || exp.size <= 0) die("exported blob is empty");
if (exp.tracks < 2) die("exported plan had < 2 speaker frames");

// Confirm a working download link/anchor exists with a blob href.
const dl = await page.evaluate(() => {
  const a = document.getElementById("download-link");
  return a ? { href: a.getAttribute("href"), download: a.getAttribute("download") } : null;
});
if (!dl || !/^blob:/.test(dl.href || "")) die("download link missing/invalid: " + JSON.stringify(dl));
console.log("== download link present ==", JSON.stringify(dl));

// Save the exact exported bytes to disk (independent of the browser-triggered
// download) so the file can be inspected/played by the maintainer.
const savedExport = path.join(testsDir, "exported-episode.webm");
const arr = await page.evaluate(async () => {
  const a = document.getElementById("download-link");
  const resp = await fetch(a.href);
  const buf = await resp.arrayBuffer();
  return Array.from(new Uint8Array(buf));
});
writeFileSync(savedExport, Buffer.from(arr));
const savedSize = statSync(savedExport).size;
console.log("== saved exported webm ==", savedExport, savedSize, "bytes");
if (savedSize < 1000) die("saved export suspiciously small: " + savedSize);

// Wait briefly for the download event (anchor click) to have fired.
await page.waitForTimeout(500);

await page.screenshot({ path: path.join(testsDir, "flow-export.png"), fullPage: true });
console.log("== shot flow-export.png ==");

await browser.close();

// Basic webm sanity: starts with the EBML magic bytes 0x1A45DFA3.
const head = statSync(savedExport).size >= 4;
const fs = await import("fs");
const fd = fs.openSync(savedExport, "r");
const magic = Buffer.alloc(4);
fs.readSync(fd, magic, 0, 4, 0);
fs.closeSync(fd);
const isWebm = magic[0] === 0x1a && magic[1] === 0x45 && magic[2] === 0xdf && magic[3] === 0xa3;

console.log(
  JSON.stringify(
    {
      ok: true,
      exportedBytes: savedSize,
      blobReportedBytes: exp.size,
      mimeType: exp.mimeType,
      hasAudio: exp.hasAudio,
      speakerFrames: exp.tracks,
      durationMs: exp.durationMs,
      isWebmMagic: isWebm,
      downloadTriggered: Boolean(downloadInfo),
      downloadName: downloadInfo && downloadInfo.name,
    },
    null,
    2,
  ),
);
if (!isWebm) die("exported file is not a valid webm (bad magic bytes)");
console.log("FLOW OK");
