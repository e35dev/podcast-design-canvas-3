import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAssignmentMap,
  buildExportFilename,
  formatSocialLabel,
  getEpisodeDuration,
  getFrames,
  getSpotlightIndex,
  validateSetup
} from "../app/model.js";

test("validateSetup accepts a host plus guest flow with valid socials", () => {
  const errors = validateSetup({
    uploads: [
      { bucket: "host" },
      { bucket: "guest1" }
    ],
    socials: {
      host: "https://x.com/host",
      guest1: "https://youtube.com/@guest",
      guest2: ""
    },
    presetId: "conversation-grid"
  });

  assert.deepEqual(errors, []);
});

test("validateSetup rejects duplicate bucket assignments and missing socials", () => {
  const errors = validateSetup({
    uploads: [
      { bucket: "host" },
      { bucket: "host" }
    ],
    socials: {
      host: "",
      guest1: "",
      guest2: ""
    },
    presetId: "conversation-grid"
  });

  assert.ok(errors.includes("Each speaker bucket can only have one uploaded file."));
  assert.ok(errors.includes("Add a social link for Host."));
});

test("validateSetup rejects unassigned uploads beyond the required speakers", () => {
  const errors = validateSetup({
    uploads: [
      { bucket: "host" },
      { bucket: "guest1" },
      { bucket: "" }
    ],
    socials: {
      host: "https://x.com/host",
      guest1: "https://youtube.com/@guest",
      guest2: ""
    },
    presetId: "conversation-grid"
  });

  assert.ok(errors.includes("Assign every uploaded file to a speaker bucket."));
});

test("validateSetup rejects more files than the supported speaker buckets", () => {
  const errors = validateSetup({
    uploads: [
      { bucket: "host" },
      { bucket: "guest1" },
      { bucket: "guest2" },
      { bucket: "" }
    ],
    socials: {
      host: "https://x.com/host",
      guest1: "https://youtube.com/@guest-one",
      guest2: "https://youtube.com/@guest-two"
    },
    presetId: "conversation-grid"
  });

  assert.ok(errors.includes("Upload no more than three speaker video files for Host, Guest 1, and Guest 2."));
});

test("buildAssignmentMap maps uploads by selected bucket", () => {
  const map = buildAssignmentMap([
    { id: "one", bucket: "host" },
    { id: "two", bucket: "" },
    { id: "three", bucket: "guest2" }
  ]);

  assert.equal(map.host.id, "one");
  assert.equal(map.guest2.id, "three");
  assert.equal(map.guest1, undefined);
});

test("conversation grid frames anchor the host and stack guests", () => {
  const frames = getFrames("conversation-grid", ["host", "guest1", "guest2"], 1280, 720, 0);

  assert.equal(frames[0].bucket, "host");
  assert.ok(frames[0].width > frames[1].width);
  assert.equal(frames.length, 3);
});

test("spotlight cycle rotates by elapsed time", () => {
  const order = ["host", "guest1", "guest2"];
  assert.equal(getSpotlightIndex(order, 0, 8000), 0);
  assert.equal(getSpotlightIndex(order, 9000, 8000), 1);
  assert.equal(getSpotlightIndex(order, 17000, 8000), 2);
});

test("getEpisodeDuration returns the longest uploaded track length", () => {
  assert.equal(
    getEpisodeDuration([
      { duration: 31.2 },
      { duration: 29.5 },
      { duration: 32.05 }
    ]),
    32.05
  );
});

test("formatSocialLabel prefers handle-like output", () => {
  assert.equal(formatSocialLabel("https://x.com/founder"), "@founder");
  assert.equal(formatSocialLabel("https://www.linkedin.com/in/jane-doe/"), "@jane-doe");
});

test("buildExportFilename creates a predictable webm filename", () => {
  assert.equal(
    buildExportFilename("Founder Roundtable Episode 01", "conversation-grid"),
    "founder-roundtable-episode-01-conversation-grid.webm"
  );
});
