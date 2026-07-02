// tests/audio.test.mjs — audio quality behavior: the leveling gain math
// (PDC.audio.computeLevelingGains) and the per-episode audio settings state.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const A = PDC.audio;
const E = PDC.episode;

// --- computeLevelingGains -------------------------------------------------

test("loud and quiet speakers converge to the same effective loudness", () => {
  const gains = A.computeLevelingGains({ host: 0.6, guest1: 0.1 });
  assert.ok(gains.host < 1, "loud speaker is attenuated");
  assert.ok(gains.guest1 > 1, "quiet speaker is boosted");
  // Unclamped case: both land exactly on the shared target.
  const hostOut = 0.6 * gains.host;
  const guestOut = 0.1 * gains.guest1;
  assert.ok(Math.abs(hostOut - guestOut) < 1e-9, "leveled outputs converge");
  // And the leveled spread is far smaller than the raw 6x spread.
  assert.ok(Math.max(hostOut, guestOut) / Math.min(hostOut, guestOut) < 1.01);
});

test("gains are clamped so extreme tracks cannot explode or vanish", () => {
  const gains = A.computeLevelingGains({ host: 1, guest1: 0.001 });
  assert.equal(gains.guest1, A.GAIN_MAX, "very quiet track boost is capped");
  const dominant = A.computeLevelingGains({ host: 10, guest1: 0.05, guest2: 0.05 });
  assert.ok(dominant.host < 0.5, "dominant track is attenuated hard");
  assert.equal(dominant.guest1, A.GAIN_MAX);
  for (const g of [...Object.values(gains), ...Object.values(dominant)]) {
    assert.ok(g >= A.GAIN_MIN && g <= A.GAIN_MAX, "every gain stays inside the clamp range, got " + g);
  }
});

test("silent tracks keep gain 1 and do not drag the target down", () => {
  const gains = A.computeLevelingGains({ host: 0.5, guest1: 0 });
  assert.equal(gains.guest1, 1, "silent track is left untouched");
  assert.equal(gains.host, 1, "sole audible track already sits on the target");
});

test("all-silent, empty, and single-speaker inputs are safe", () => {
  assert.deepEqual(A.computeLevelingGains({ host: 0, guest1: 0 }), { host: 1, guest1: 1 });
  assert.deepEqual(A.computeLevelingGains({}), {});
  assert.deepEqual(A.computeLevelingGains(null), {});
  const solo = A.computeLevelingGains({ host: 0.4 });
  assert.ok(Math.abs(solo.host - 1) < 1e-9, "a single speaker needs no leveling");
});

test("three speakers all converge toward one target", () => {
  const rms = { host: 0.6, guest1: 0.2, guest2: 0.1 };
  const gains = A.computeLevelingGains(rms);
  const outs = Object.keys(rms).map((k) => rms[k] * gains[k]);
  const spread = Math.max(...outs) / Math.min(...outs);
  assert.ok(spread < 1.01, "leveled spread ~1, raw spread was 6, got " + spread);
});

// --- episode audio settings state ------------------------------------------

test("new episodes carry creator-sensible audio defaults", () => {
  const ep = E.createEpisode({});
  assert.deepEqual(E.getAudioSettings(ep), { leveling: true, clarity: "off", noiseReduction: "off" });
});

test("setAudioSetting stores each choice and validates values per key", () => {
  const ep = E.createEpisode({});
  E.setAudioSetting(ep, "leveling", false);
  E.setAudioSetting(ep, "clarity", "on");
  E.setAudioSetting(ep, "noiseReduction", "on");
  assert.deepEqual(E.getAudioSettings(ep), { leveling: false, clarity: "on", noiseReduction: "on" });
  // Invalid values and unknown keys are ignored, never stored.
  E.setAudioSetting(ep, "leveling", "yes");
  E.setAudioSetting(ep, "clarity", "loud");
  E.setAudioSetting(ep, "reverb", "on");
  const s = E.getAudioSettings(ep);
  assert.equal(s.leveling, false);
  assert.equal(s.clarity, "on");
  assert.equal(s.reverb, undefined);
});

test("audio settings survive preset switches and media changes", () => {
  const ep = E.createEpisode({});
  E.setAudioSetting(ep, "clarity", "on");
  E.setAudioSetting(ep, "noiseReduction", "on");
  E.assignMedia(ep, "host", { name: "h.webm", size: 10, type: "video/webm" });
  E.assignMedia(ep, "guest1", { name: "g.webm", size: 10, type: "video/webm" });
  E.setPreset(ep, "stack");
  E.setPreset(ep, "split");
  assert.deepEqual(E.getAudioSettings(ep), { leveling: true, clarity: "on", noiseReduction: "on" });
});

test("getAudioSettings backfills defaults for pre-existing episodes", () => {
  const ep = E.createEpisode({});
  delete ep.audioSettings; // an episode created before this feature existed
  assert.deepEqual(E.getAudioSettings(ep), { leveling: true, clarity: "off", noiseReduction: "off" });
  E.setAudioSetting(ep, "clarity", "on");
  assert.equal(E.getAudioSettings(ep).clarity, "on");
});
