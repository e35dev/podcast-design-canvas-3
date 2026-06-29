import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

test("rendered workflow has committed real media files for upload proof", () => {
  const host = statSync("tests/fixtures/host-fixture.webm");
  const guest = statSync("tests/fixtures/guest-fixture.webm");

  assert.ok(host.size > 1000);
  assert.ok(guest.size > 1000);
});
