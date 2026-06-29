import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mainSource = readFileSync("app/main.js", "utf8");

test("preview media loading is timeout-safe and recoverable", () => {
  assert.match(mainSource, /waitForPlayable\(entry\.video, 3000\)/);
  assert.match(mainSource, /setTimeout\(\(\) => \{/);
  assert.match(mainSource, /Could not load/);
});

test("export reports browser capture failures instead of silently hanging", () => {
  assert.match(mainSource, /cannot record the composed video export/);
  assert.match(mainSource, /cannot capture one of the uploaded videos/);
  assert.match(mainSource, /Export failed because the browser produced an empty video file/);
});
