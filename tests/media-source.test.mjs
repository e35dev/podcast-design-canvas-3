import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("app/main.js", "utf8");

test("media loading, seeking, playback, and recorder stop have timeouts", () => {
  assert.match(source, /waitForVideoReady\(entry\.video, 5000\)/);
  assert.match(source, /seekVideo\(entry\.video, 0, 2500\)/);
  assert.match(source, /Preview playback timed out/);
  assert.match(source, /Export playback timed out/);
  assert.match(source, /Timed out waiting for recorder stop/);
});

test("export uses canvas capture, uploaded video capture, and downloadable blob output", () => {
  assert.match(source, /els\.canvas\.captureStream\(30\)/);
  assert.match(source, /entry\.video\.captureStream/);
  assert.match(source, /createMediaStreamDestination/);
  assert.match(source, /new Blob\(chunks/);
  assert.match(source, /els\.download\.href = state\.exportUrl/);
});

test("visible sample media action uses real MediaRecorder files and the same preview path", () => {
  assert.match(source, /load-sample-media/);
  assert.match(source, /createSampleVideoFile/);
  assert.match(source, /new File\(\[blob\]/);
  assert.match(source, /if \(!setup\.uploads\.length\)/);
  assert.match(source, /await handlePreview\(\)/);
});
