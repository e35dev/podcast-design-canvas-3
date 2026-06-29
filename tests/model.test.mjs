import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../app/model.js");

function episode(opts = {}) {
  const speakers = {};
  for (const slot of M.SPEAKER_SLOTS) {
    speakers[slot.id] = { hasMedia: false, social: "", name: "" };
  }
  (opts.assigned || []).forEach((id) => {
    speakers[id].hasMedia = true;
  });
  Object.assign(speakers, opts.overrides || {});
  return { title: opts.title || "", presetId: opts.presetId || M.PRESETS[0].id, speakers };
}

test("presets and slots are well-formed", () => {
  assert.equal(M.PRESETS.length, 3);
  const ids = M.PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, 3, "preset ids unique");
  assert.equal(M.SPEAKER_SLOTS.length, 3);
  assert.deepEqual(
    M.SPEAKER_SLOTS.map((s) => s.id),
    ["host", "guest1", "guest2"]
  );
});

test("assignedSlotIds counts only speakers with media", () => {
  assert.deepEqual(M.assignedSlotIds(episode({ assigned: [] })), []);
  assert.deepEqual(M.assignedSlotIds(episode({ assigned: ["host"] })), ["host"]);
  assert.deepEqual(
    M.assignedSlotIds(episode({ assigned: ["host", "guest2"] })),
    ["host", "guest2"]
  );
});

test("preview needs >=2 assigned speakers", () => {
  assert.equal(M.isReadyToPreview(episode({ assigned: [] })), false);
  assert.equal(M.isReadyToPreview(episode({ assigned: ["host"] })), false);
  assert.equal(M.isReadyToPreview(episode({ assigned: ["host", "guest1"] })), true);
});

test("export needs preview-ready + a valid preset", () => {
  const ep = episode({ assigned: ["host", "guest1"], presetId: "spotlight" });
  assert.equal(M.isReadyToExport(ep), true);
  const notReady = episode({ assigned: ["host"], presetId: "spotlight" });
  assert.equal(M.isReadyToExport(notReady), false);
});

test("blockingReasons reports the missing speaker count", () => {
  const reasons = M.blockingReasons(episode({ assigned: ["host"] }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /at least two/i);
  assert.deepEqual(M.blockingReasons(episode({ assigned: ["host", "guest1"] })), []);
});

test("deriveNameFromSocial extracts a likely name", () => {
  assert.equal(M.deriveNameFromSocial("https://instagram.com/jane_doe"), "Jane Doe");
  assert.equal(M.deriveNameFromSocial("@john.smith"), "John Smith");
  assert.equal(M.deriveNameFromSocial("twitter.com/@acme_media"), "Acme Media");
  assert.equal(M.deriveNameFromSocial(""), "");
});

test("normalizeSocialLink adds a scheme and trims", () => {
  assert.equal(M.normalizeSocialLink("  instagram.com/x "), "https://instagram.com/x");
  assert.equal(M.normalizeSocialLink("https://x.com/y"), "https://x.com/y");
  assert.equal(M.normalizeSocialLink(""), "");
});

test("speakerDisplayName precedence: name > social > slot label", () => {
  assert.equal(M.speakerDisplayName("host", { name: "Casey" }), "Casey");
  assert.equal(
    M.speakerDisplayName("guest1", { social: "instagram.com/lee_kim" }),
    "Lee Kim"
  );
  assert.equal(M.speakerDisplayName("guest2", {}), "Guest 2");
});

test("computeLayout yields one frame per active speaker, in bounds, for every preset", () => {
  const W = 1280;
  const H = 720;
  for (const preset of M.PRESETS) {
    for (const ids of [["host", "guest1"], ["host", "guest1", "guest2"]]) {
      const layout = M.computeLayout(preset.id, ids, W, H);
      assert.equal(layout.frames.length, ids.length, preset.id + " frame count");
      assert.ok(layout.titleBox && layout.captionBox, "has title + caption boxes");
      for (const f of layout.frames) {
        assert.ok(f.x >= 0 && f.y >= 0, "frame origin in bounds");
        assert.ok(f.x + f.w <= W + 1, "frame width in bounds");
        assert.ok(f.y + f.h <= H + 1, "frame height in bounds");
        assert.ok(f.w > 0 && f.h > 0, "frame has area");
        assert.ok(f.label, "frame is labeled");
      }
    }
  }
});

test("spotlight makes the host frame the largest", () => {
  const layout = M.computeLayout("spotlight", ["host", "guest1", "guest2"], 1280, 720);
  const host = layout.frames.find((f) => f.id === "host");
  const others = layout.frames.filter((f) => f.id !== "host");
  for (const o of others) {
    assert.ok(host.w * host.h > o.w * o.h, "host frame is larger than guests");
  }
});

test("exportDurationSeconds keeps full finite duration and bounds unknown tracks", () => {
  assert.equal(M.exportDurationSeconds([3, 7, 5]), 7);
  assert.equal(M.exportDurationSeconds([Infinity, 4]), 4);
  assert.equal(M.exportDurationSeconds([120, 30]), 120);
  assert.equal(M.exportDurationSeconds([]), 5);
  assert.equal(M.exportDurationSeconds([Infinity]), 5);
  assert.equal(M.exportDurationSeconds([1]), 2);
});

test("exportFileName slugifies the title", () => {
  assert.equal(M.exportFileName("Episode 12 — Building in Public!"), "episode-12-building-in-public.webm");
  assert.equal(M.exportFileName(""), "episode.webm");
});

test("ACCEPTANCE: import → assign 2 speakers → preset → preview → export ready", () => {
  // A creator assigns two real speaker tracks, adds a social link, picks a preset.
  const ep = episode({
    title: "Pilot",
    assigned: ["host", "guest1"],
    presetId: "studio",
    overrides: {
      host: { hasMedia: true, social: "instagram.com/the_host", name: "" },
      guest1: { hasMedia: true, social: "", name: "Robin" },
    },
  });
  assert.equal(M.isReadyToPreview(ep), true, "preview unlocks with two tracks");
  assert.equal(M.isReadyToExport(ep), true, "export unlocks with a preset");
  const layout = M.computeLayout(ep.presetId, M.assignedSlotIds(ep), 1280, 720);
  assert.equal(layout.frames.length, 2, "both real speakers composed");
  assert.equal(M.speakerDisplayName("host", ep.speakers.host), "The Host");
  assert.equal(M.speakerDisplayName("guest1", ep.speakers.guest1), "Robin");
  assert.equal(M.exportFileName(ep.title), "pilot.webm");
});
