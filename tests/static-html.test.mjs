import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("index can hydrate when opened directly as a static file", () => {
  assert.equal(html.includes('type="module"'), false);
  assert.match(html, /<script src="app\/model\.js"><\/script>/);
  assert.match(html, /<script src="app\/main\.js"><\/script>/);
});

test("raw rendered HTML includes the core workflow controls before JavaScript runs", () => {
  for (const fragment of [
    'id="speaker-files"',
    'name="host"',
    'name="guest1"',
    'name="guest2"',
    'value="conversation-grid"',
    'value="spotlight-cycle"',
    'id="compose-preview"',
    'id="export-episode"',
    'id="download-export"'
  ]) {
    assert.ok(html.includes(fragment), `Missing ${fragment}`);
  }
});
