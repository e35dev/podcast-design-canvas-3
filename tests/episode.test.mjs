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

test("social links are stored per speaker bucket and cleared when blank", () => {
  const ep = E.createEpisode({});
  E.setSocialLink(ep, "host", "https://x.com/hostperson");
  E.setSocialLink(ep, "guest1", "  https://x.com/guestperson  ");
  assert.equal(E.getSocialLink(ep, "host"), "https://x.com/hostperson");
  assert.equal(E.getSocialLink(ep, "guest1"), "https://x.com/guestperson", "trimmed");
  E.setSocialLink(ep, "director", "https://x.com/nope"); // unknown bucket ignored
  assert.equal(E.getSocialLink(ep, "director"), "");
  E.setSocialLink(ep, "host", "   "); // blank clears
  assert.equal(E.getSocialLink(ep, "host"), "");
});

test("speakerName derives distinct names from links and falls back to the label", () => {
  const ep = E.createEpisode({});
  assert.equal(E.speakerName(ep, "host"), "Host", "fallback to bucket label with no link");
  E.setSocialLink(ep, "host", "https://x.com/hostperson");
  E.setSocialLink(ep, "guest1", "@guestperson");
  assert.equal(E.speakerName(ep, "host"), "hostperson");
  assert.equal(E.speakerName(ep, "guest1"), "guestperson");
  assert.notEqual(E.speakerName(ep, "host"), E.speakerName(ep, "guest1"), "distinct per speaker");
});

test("deriveHandle reads handles from common profile URL shapes", () => {
  assert.equal(E.deriveHandle("https://x.com/janedoe"), "janedoe");
  assert.equal(E.deriveHandle("https://www.linkedin.com/in/jane-doe"), "jane-doe");
  assert.equal(E.deriveHandle("github.com/foo?tab=repos"), "foo");
  assert.equal(E.deriveHandle("@bar"), "bar");
  assert.equal(E.deriveHandle(""), "");
});

test("removing a speaker clears only its own link, not the others'", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "host", media("h.webm"));
  E.assignMedia(ep, "guest1", media("g.webm"));
  E.setSocialLink(ep, "host", "https://x.com/hostperson");
  E.setSocialLink(ep, "guest1", "https://x.com/guestperson");
  E.clearMedia(ep, "guest1");
  assert.equal(E.getSocialLink(ep, "guest1"), "", "removed speaker's link is dropped");
  assert.equal(E.getSocialLink(ep, "host"), "https://x.com/hostperson", "other speaker's link survives");
});

test("social links survive a preset switch", () => {
  const ep = E.createEpisode({});
  E.setSocialLink(ep, "host", "https://x.com/hostperson");
  E.setPreset(ep, "spotlight");
  assert.equal(E.getSocialLink(ep, "host"), "https://x.com/hostperson");
});

test("audio quality options are stored and validated per episode", () => {
  const ep = E.createEpisode({});
  assert.deepEqual(E.getAudioQuality(ep), {
    leveling: "balanced",
    clarity: "balanced",
    noiseReduction: "balanced",
  });
  E.setAudioQuality(ep, {
    leveling: "strong",
    clarity: "enhanced",
    noiseReduction: "off",
  });
  assert.deepEqual(E.getAudioQuality(ep), {
    leveling: "strong",
    clarity: "enhanced",
    noiseReduction: "off",
  });
  E.setAudioQuality(ep, {
    leveling: "extreme",
    clarity: "broken",
    noiseReduction: "ultra",
  });
  assert.deepEqual(E.getAudioQuality(ep), {
    leveling: "strong",
    clarity: "enhanced",
    noiseReduction: "off",
  });
});

test("audio quality survives preset switches and media updates", () => {
  const ep = E.createEpisode({});
  E.assignMedia(ep, "host", media("h.webm"));
  E.assignMedia(ep, "guest1", media("g.webm"));
  E.setAudioQuality(ep, { leveling: "off", clarity: "natural", noiseReduction: "strong" });
  E.setPreset(ep, "stack");
  E.setPreset(ep, "spotlight");
  E.clearMedia(ep, "guest1");
  E.assignMedia(ep, "guest1", media("g2.webm"));
  assert.deepEqual(E.getAudioQuality(ep), {
    leveling: "off",
    clarity: "natural",
    noiseReduction: "strong",
  });
});
