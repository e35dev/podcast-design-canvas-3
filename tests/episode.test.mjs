// tests/episode.test.mjs — model behavior for the upload -> assign -> preset flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const E = PDC.episode;

const media = (name) => ({ name, size: 10, type: "video/webm" });

test("new episode starts empty with the default preset", () => {
  const ep = E.createEpisode({ title: "Ep 1" });
  assert.equal(ep.title, "Ep 1");
  assert.equal(ep.presetId, PDC.presets.DEFAULT_PRESET_ID);
  assert.deepEqual(E.assignedBuckets(ep), []);
  assert.equal(E.canCompose(ep), false);
});

test("assigning two speakers makes the episode composable", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "host", media("host.webm"));
  assert.equal(E.canCompose(ep), false, "one speaker is not enough");
  assert.match(E.readinessReason(ep), /1 more speaker/);
  E.assignMedia(ep, "guest1", media("guest.webm"));
  assert.equal(E.canCompose(ep), true);
  assert.deepEqual(E.assignedBuckets(ep), ["host", "guest1"]);
  assert.equal(E.readinessReason(ep), "");
});

test("assignedBuckets keeps canonical speaker order regardless of insertion order", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "guest2", media("g2.webm"));
  E.assignMedia(ep, "host", media("h.webm"));
  assert.deepEqual(E.assignedBuckets(ep), ["host", "guest2"]);
});

test("unknown buckets are ignored, not stored", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "director", media("x.webm"));
  assert.deepEqual(E.assignedBuckets(ep), []);
});

test("clearing media drops below the compose threshold", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "host", media("h.webm"));
  E.assignMedia(ep, "guest1", media("g.webm"));
  assert.equal(E.canCompose(ep), true);
  E.clearMedia(ep, "guest1");
  assert.equal(E.canCompose(ep), false);
  assert.deepEqual(E.assignedBuckets(ep), ["host"]);
});

test("setPreset only accepts known presets", () => {
  const ep = E.createEpisode({});
  E.setPreset(ep, "spotlight");
  assert.equal(ep.presetId, "spotlight");
  E.setPreset(ep, "does-not-exist");
  assert.equal(ep.presetId, "spotlight", "invalid preset id is rejected");
});
