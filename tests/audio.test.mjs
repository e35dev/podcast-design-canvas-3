// tests/audio.test.mjs — DOM-free unit tests for the pure leveling helper in
// app/audio.js. The browser mixer (AudioContext/analysers) is exercised by the
// headless audio-balance gate; here we only verify the math: equal levels stay
// equal, quiet-vs-loud converges, silence is left alone, and applying the gains
// actually brings two real levels closer together.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load app/audio.js under a minimal window shim (same approach as tests/_load.mjs):
// the IIFE defines PDC.audio without touching AudioContext (lazy ensureCtx), so
// the pure leveling helper is reachable with zero dependencies and no DOM.
function loadComputeLevelingGains() {
  globalThis.window = {};
  const code = fs.readFileSync(path.join(root, "app/audio.js"), "utf8");
  vm.runInThisContext(code, { filename: "app/audio.js" });
  return globalThis.window.PDC.audio.computeLevelingGains;
}
const computeLevelingGains = loadComputeLevelingGains();

test("equal levels produce ~equal gains", () => {
  const gains = computeLevelingGains({ host: 0.3, guest1: 0.3 });
  assert.ok(Math.abs(gains.host - gains.guest1) < 1e-6, "equal levels -> equal gains");
  assert.ok(Math.abs(gains.host - 1) < 1e-6, "equal levels at mean target -> gain ~1");
});

test("a loud + quiet pair gives the quiet speaker a higher gain, both clamped", () => {
  const gains = computeLevelingGains({ host: 0.6, guest1: 0.1 });
  assert.ok(gains.guest1 > gains.host, "quiet speaker should be boosted more than the loud one");
  for (const b of ["host", "guest1"]) {
    assert.ok(gains[b] >= 0.1 && gains[b] <= 4, b + " gain within clamp 0.1..4");
  }
});

test("a silent input keeps gain 1", () => {
  const gains = computeLevelingGains({ host: 0.4, guest1: 0 });
  assert.equal(gains.guest1, 1, "silent speaker -> gain 1 (cannot amplify silence)");
  assert.ok(gains.host > 0, "non-silent speaker still gets a real gain");
});

test("all-silent input leaves every gain at 1", () => {
  const gains = computeLevelingGains({ host: 0, guest1: 0 });
  assert.equal(gains.host, 1);
  assert.equal(gains.guest1, 1);
});

test("applying the gains moves two levels closer together", () => {
  const levels = { host: 0.6, guest1: 0.12 };
  const gains = computeLevelingGains(levels);
  const rawSpread = Math.abs(levels.host - levels.guest1);
  const leveledSpread = Math.abs(levels.host * gains.host - levels.guest1 * gains.guest1);
  assert.ok(
    leveledSpread < rawSpread,
    `leveled spread ${leveledSpread} should be < raw spread ${rawSpread}`,
  );
});

test("gains respect a custom clamp", () => {
  const gains = computeLevelingGains({ host: 1.0, guest1: 0.01 }, { minGain: 0.5, maxGain: 2 });
  for (const b of ["host", "guest1"]) {
    assert.ok(gains[b] >= 0.5 && gains[b] <= 2, b + " respects custom clamp");
  }
});
