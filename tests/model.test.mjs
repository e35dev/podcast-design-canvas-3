import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../app/model.js");

function episode(opts = {}) {
  const speakers = {};
  for (const slot of M.SPEAKER_SLOTS) speakers[slot.id] = { hasMedia: false };
  (opts.assigned || []).forEach((id) => {
    speakers[id].hasMedia = true;
  });
  return { presetId: opts.presetId || M.PRESETS[0].id, speakers };
}

test("presets and speaker slots are well-formed", () => {
  assert.equal(M.PRESETS.length, 3);
  assert.equal(new Set(M.PRESETS.map((p) => p.id)).size, 3, "preset ids unique");
  assert.deepEqual(
    M.SPEAKER_SLOTS.map((s) => s.id),
    ["host", "guest1", "guest2"]
  );
});

test("assignedSlotIds counts only buckets with media", () => {
  assert.deepEqual(M.assignedSlotIds(episode({ assigned: [] })), []);
  assert.deepEqual(M.assignedSlotIds(episode({ assigned: ["host"] })), ["host"]);
  assert.deepEqual(M.assignedSlotIds(episode({ assigned: ["host", "guest2"] })), ["host", "guest2"]);
});

test("preview needs at least two assigned speakers", () => {
  assert.equal(M.isReadyToPreview(episode({ assigned: [] })), false);
  assert.equal(M.isReadyToPreview(episode({ assigned: ["host"] })), false);
  assert.equal(M.isReadyToPreview(episode({ assigned: ["host", "guest1"] })), true);
});

test("blockingReason reports the missing speaker count, empty when ready", () => {
  assert.match(M.blockingReason(episode({ assigned: ["host"] })), /at least two/i);
  assert.equal(M.blockingReason(episode({ assigned: ["host", "guest1"] })), "");
});

test("computeLayout: one frame per assigned speaker, in bounds, labeled, every preset", () => {
  const W = 1280;
  const H = 720;
  for (const preset of M.PRESETS) {
    for (const ids of [["host", "guest1"], ["host", "guest1", "guest2"]]) {
      const layout = M.computeLayout(preset.id, ids, W, H);
      assert.equal(layout.frames.length, ids.length, preset.id + " frame count");
      for (const f of layout.frames) {
        assert.ok(f.x >= 0 && f.y >= 0, "origin in bounds");
        assert.ok(f.x + f.w <= W + 1, "width in bounds");
        assert.ok(f.y + f.h <= H + 1, "height in bounds");
        assert.ok(f.w > 0 && f.h > 0, "has area");
        assert.ok(f.label && f.accent, "labeled + accented");
      }
    }
  }
});

test("split places frames side by side; stack stacks them vertically", () => {
  const split = M.computeLayout("split", ["host", "guest1"], 1280, 720).frames;
  assert.ok(split[1].x > split[0].x, "split: second frame is to the right");
  assert.ok(Math.abs(split[0].y - split[1].y) <= 1, "split: frames share a row");
  const stack = M.computeLayout("stack", ["host", "guest1"], 1280, 720).frames;
  assert.ok(stack[1].y > stack[0].y, "stack: second frame is below");
  assert.ok(Math.abs(stack[0].x - stack[1].x) <= 1, "stack: frames share a column");
});

test("spotlight makes the host frame the largest", () => {
  const frames = M.computeLayout("spotlight", ["host", "guest1", "guest2"], 1280, 720).frames;
  const host = frames.find((f) => f.id === "host");
  for (const o of frames.filter((f) => f.id !== "host")) {
    assert.ok(host.w * host.h > o.w * o.h, "host frame larger than guests");
  }
});

test("ACCEPTANCE: two assigned speakers + a preset compose a playable preview layout", () => {
  // A creator adds two real speaker tracks (upload or live recording) and picks a preset.
  const ep = episode({ assigned: ["host", "guest1"], presetId: "spotlight" });
  assert.equal(M.isReadyToPreview(ep), true, "preview unlocks with two tracks");
  const layout = M.computeLayout(ep.presetId, M.assignedSlotIds(ep), 1280, 720);
  assert.equal(layout.frames.length, 2, "both real speakers are composed");
  assert.deepEqual(
    layout.frames.map((f) => f.id),
    ["host", "guest1"],
    "frames map to the assigned buckets"
  );
});
