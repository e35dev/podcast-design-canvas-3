/*
 * Zero-dependency lint that doubles as a regression guard against the exact
 * rendered-UI failures that closed earlier attempts. Each check maps to a
 * known failure mode so the app can never silently regress into it.
 */
import { readFileSync } from "node:fs";

const problems = [];
const fail = (msg) => problems.push(msg);

const html = readFileSync("index.html", "utf8");
const model = readFileSync("app/model.js", "utf8");
const main = readFileSync("app/main.js", "utf8");

// Strip HTML comments before structural checks so explanatory comments can't
// produce false positives.
const htmlCode = html.replace(/<!--[\s\S]*?-->/g, "");

// Must run from file://: no ES module scripts, no ES import in app scripts.
if (/<script[^>]*type=["']module["']/i.test(htmlCode)) {
  fail('index.html uses <script type="module"> — blocked by CORS on file://.');
}
if (/\bimport\s+[^;]*\sfrom\s+["']/.test(main) || /\bimport\s+[^;]*\sfrom\s+["']/.test(model)) {
  fail("app scripts use ES `import` — must be classic scripts for file://.");
}

// model must load before main.
const idxModel = htmlCode.indexOf("app/model.js");
const idxMain = htmlCode.indexOf("app/main.js");
if (idxModel === -1 || idxMain === -1) {
  fail("index.html must reference both app/model.js and app/main.js.");
} else if (idxModel > idxMain) {
  fail("app/model.js must be referenced before app/main.js.");
}

// No global collisions: each app script must be IIFE-wrapped so it leaks no
// top-level declaration that could clash between classic scripts.
for (const [name, src] of [
  ["app/model.js", model],
  ["app/main.js", main],
]) {
  const firstCode = src
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*"));
  if (!firstCode || !/^\(function/.test(firstCode)) {
    fail(`${name} must start with an IIFE "(function" to avoid global leakage.`);
  }
}

// PRESETS declared exactly once, in the model only.
if (/\b(?:var|let|const)\s+PRESETS\b/.test(main)) {
  fail("app/main.js redeclares PRESETS — keep it solely in app/model.js.");
}

// Real media only: no fake/sample/demo/seeded media generated as the product path.
if (/load\s+sample|sample\s+synced|generateSample|fakeVideo|seededClip|demoMedia/i.test(main)) {
  fail("app/main.js looks like it ships a sample/demo media path — not allowed.");
}

// The composed preview must draw the real <video> pixels onto the canvas.
if (!/drawImage\s*\(/.test(main)) {
  fail("app/main.js must draw real video frames with ctx.drawImage.");
}
// Both real-media inputs must exist: file upload and live capture.
if (!/getUserMedia/.test(main)) {
  fail("app/main.js must offer a live capture path (getUserMedia).");
}
if (!/type="file"/.test(main)) {
  fail("app/main.js must offer a file-upload path (input type=file).");
}

// Whitespace hygiene.
for (const [name, src] of [
  ["index.html", html],
  ["app/model.js", model],
  ["app/main.js", main],
]) {
  if (/\t/.test(src)) fail(`${name} contains tab characters.`);
  if (/[ \t]+\n/.test(src)) fail(`${name} has trailing whitespace.`);
}

if (problems.length) {
  console.error("lint failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("lint: ok (file://-safe, no global collisions, real upload + capture, real canvas draw)");
