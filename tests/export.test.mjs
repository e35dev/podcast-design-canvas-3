// tests/export.test.mjs — DOM-free export composition model. buildExportPlan ties
// each uploaded media ref + derived speaker name to the active preset's rect, so
// the recorded video lays the real footage out exactly like the preview. This is
// the testable backbone of the export pipeline (the MediaRecorder/canvas capture
// itself is exercised by scripts/verify-rendered-export.mjs in a real browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const E = PDC.episode;
const X = PDC.exporter;

const media = (name) => ({ name, size: 10, type: "video/webm" });

function ready(presetId) {
  const ep = E.createEpisode({ title: "Episode 1" });
  E.assignMedia(ep, "host", media("host.webm"));
  E.assignMedia(ep, "guest1", media("guest.webm"));
  E.setSocialLink(ep, "host", "https://x.com/hostperson");
  E.setSocialLink(ep, "guest1", "https://x.com/guestperson");
  if (presetId) E.setPreset(ep, presetId);
  return ep;
}

test("the exporter API surface is present", () => {
  assert.equal(typeof X.buildExportPlan, "function");
  assert.equal(typeof X.pickMimeType, "function");
  assert.equal(typeof X.exportFileName, "function");
  assert.equal(typeof X.createExporter, "function");
  assert.ok(Array.isArray(X.EXPORT_MIME_CANDIDATES) && X.EXPORT_MIME_CANDIDATES.length);
  assert.ok(X.DEFAULT_DURATION_MS > 0 && X.DEFAULT_DURATION_MS <= 5000, "duration is short and bounded");
});

test("export plan ties each uploaded media + derived name to the active preset rect", () => {
  const ep = ready("split");
  const plan = X.buildExportPlan(ep);
  assert.equal(plan.presetId, "split");
  assert.equal(plan.speakerCount, 2);
  assert.equal(plan.tiles.length, 2);

  const [host, guest] = plan.tiles;
  assert.equal(host.bucket, "host");
  assert.equal(host.name, "hostperson", "uses the derived speaker name");
  assert.equal(host.mediaName, "host.webm", "carries the real uploaded media ref");
  assert.deepEqual(host.rect, { x: 0, y: 0, w: 50, h: 100 }, "split host rect");

  assert.equal(guest.bucket, "guest1");
  assert.equal(guest.name, "guestperson");
  assert.equal(guest.mediaName, "guest.webm");
  assert.deepEqual(guest.rect, { x: 50, y: 0, w: 50, h: 100 }, "split guest rect");
});

test("switching the preset changes the exported composition rects", () => {
  const split = X.buildExportPlan(ready("split"));
  const stack = X.buildExportPlan(ready("stack"));
  const spotlight = X.buildExportPlan(ready("spotlight"));

  // Same media + names, different geometry per preset — proving a preset switch
  // before export changes what gets recorded.
  assert.notDeepEqual(split.tiles.map((t) => t.rect), stack.tiles.map((t) => t.rect));
  assert.notDeepEqual(stack.tiles.map((t) => t.rect), spotlight.tiles.map((t) => t.rect));

  assert.deepEqual(stack.tiles[0].rect, { x: 0, y: 0, w: 100, h: 50 }, "stack host is a full-width top row");
  assert.deepEqual(stack.tiles[1].rect, { x: 0, y: 50, w: 100, h: 50 }, "stack guest is the bottom row");
  assert.deepEqual(spotlight.tiles[0].rect, { x: 0, y: 0, w: 100, h: 100 }, "spotlight host fills the stage");
  assert.ok(spotlight.tiles[1].rect.w < 50 && spotlight.tiles[1].rect.h < 50, "spotlight guest is a PiP inset");

  // Names/media are preset-independent.
  for (const plan of [split, stack, spotlight]) {
    assert.deepEqual(plan.tiles.map((t) => t.name), ["hostperson", "guestperson"]);
    assert.deepEqual(plan.tiles.map((t) => t.mediaName), ["host.webm", "guest.webm"]);
  }
});

test("export plan falls back to bucket labels when no social link is set", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "host", media("a.webm"));
  E.assignMedia(ep, "guest1", media("b.webm"));
  const plan = X.buildExportPlan(ep);
  assert.deepEqual(plan.tiles.map((t) => t.name), ["Host", "Guest 1"]);
});

test("export plan handles three speakers with the active preset's rects", () => {
  const ep = ready("split");
  E.assignMedia(ep, "guest2", media("g2.webm"));
  E.setSocialLink(ep, "guest2", "@thirdperson");
  const plan = X.buildExportPlan(ep);
  assert.equal(plan.speakerCount, 3);
  assert.equal(plan.tiles.length, 3);
  assert.deepEqual(plan.tiles.map((t) => t.bucket), ["host", "guest1", "guest2"]);
  assert.equal(plan.tiles[2].name, "thirdperson");
});

test("pickMimeType returns a candidate (or null) without a real MediaRecorder", () => {
  // Under Node there is no MediaRecorder; pickMimeType degrades to the last
  // (broadest) candidate rather than throwing.
  const mime = X.pickMimeType();
  assert.equal(mime, "video/webm");
  // An explicit empty list yields null.
  assert.equal(X.pickMimeType([]), null);
});

test("exportFileName is filesystem-safe and carries the preset", () => {
  const ep = E.createEpisode({ title: "My Great Show!! 2026" });
  const plan = X.buildExportPlan(ready("spotlight"));
  const name = X.exportFileName(ep, plan);
  assert.match(name, /^[a-z0-9-]+\.webm$/);
  assert.ok(name.includes("spotlight"));
  assert.equal(name, "my-great-show-2026-spotlight.webm");
  // A title that slugifies to nothing falls back to the literal "episode".
  assert.equal(X.exportFileName({ title: "!!!" }, plan), "episode-spotlight.webm");
});
