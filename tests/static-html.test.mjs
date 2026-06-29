import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

test("static HTML uses classic scripts for direct file loading", () => {
  assert.equal(html.includes('type="module"'), false);
  assert.match(html, /<script src="app\/model\.js"><\/script>/);
  assert.match(html, /<script src="app\/main\.js"><\/script>/);
});

test("initial render exposes the complete import to export workflow controls", () => {
  for (const fragment of [
    'id="file-host"',
    'id="file-guest1"',
    'id="file-guest2"',
    'id="social-host"',
    'id="social-guest1"',
    'id="social-guest2"',
    'value="conversation-grid"',
    'value="spotlight-cycle"',
    'id="compose-preview"',
    'id="export-episode"',
    'id="download-export"'
  ]) {
    assert.ok(html.includes(fragment), `Missing ${fragment}`);
  }
});

test("speaker buckets are visible before JavaScript-generated state", () => {
  assert.match(html, /<h3>Host<\/h3>/);
  assert.match(html, /<h3>Guest 1<\/h3>/);
  assert.match(html, /<h3>Guest 2<\/h3>/);
});
