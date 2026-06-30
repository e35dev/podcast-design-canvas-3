import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { URL };
context.window = context;
vm.createContext(context);
vm.runInContext(readFileSync("app/model.js", "utf8"), context, { filename: "app/model.js" });

const {
  buildExportFilename,
  getEpisodeDuration,
  getFrames,
  validateSetup
} = context.window.PodcastDesignCanvasModel;

test("validateSetup accepts host plus guest with no social links", () => {
  const errors = validateSetup({
    uploads: [
      { bucket: "host", file: { name: "host.webm" } },
      { bucket: "guest1", file: { name: "guest.webm" } }
    ],
    presetId: "conversation-grid"
  });

  assert.equal(errors.length, 0);
});

test("validateSetup requires real assigned host and guest files", () => {
  const errors = validateSetup({
    uploads: [{ bucket: "host", file: { name: "host.webm" } }],
    presetId: "conversation-grid"
  });

  assert.ok(errors.includes("Upload at least two local speaker video files."));
  assert.ok(errors.includes("Assign at least one local video file to a Guest bucket."));
});

test("conversation grid frames anchor host and stack guests", () => {
  const frames = getFrames("conversation-grid", ["host", "guest1", "guest2"], 1280, 720, 0);

  assert.equal(frames.length, 3);
  assert.equal(frames[0].bucket, "host");
  assert.ok(frames[0].width > frames[1].width);
});

test("spotlight frames rotate the main speaker", () => {
  const first = getFrames("spotlight-cycle", ["host", "guest1"], 1280, 720, 0);
  const second = getFrames("spotlight-cycle", ["host", "guest1"], 1280, 720, 4500);

  assert.equal(first[0].bucket, "host");
  assert.equal(second[0].bucket, "guest1");
});

test("filename and duration helpers produce export values", () => {
  assert.equal(buildExportFilename("Founder Roundtable 01", "spotlight-cycle"), "founder-roundtable-01-spotlight-cycle.webm");
  assert.equal(getEpisodeDuration([{ duration: 1.2 }, { duration: 2.5 }]), 2.5);
});
