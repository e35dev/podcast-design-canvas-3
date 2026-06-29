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

// Strip HTML comments before structural checks so explanatory comments that
// mention file names or attributes can't produce false positives.
const htmlCode = html.replace(/<!--[\s\S]*?-->/g, "");

// #2 — app must run from file://: no ES modules in the page.
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

// #3 — no duplicate global declarations: each app script must be IIFE-wrapped
// so it leaks no top-level const/let that could collide between classic scripts.
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

// PRESETS is declared exactly once, in the model only (root cause of a prior
// "Identifier 'PRESETS' has already been declared" crash).
const presetDeclsInMain = (main.match(/\b(?:var|let|const)\s+PRESETS\b/g) || []).length;
if (presetDeclsInMain > 0) {
  fail("app/main.js redeclares PRESETS — keep it solely in app/model.js.");
}

// #8/#9 — no fake/sample/demo media generated as the product path.
if (/load\s+sample|sample\s+synced|generateSample|fakeVideo|demoMedia/i.test(main)) {
  fail("app/main.js looks like it ships a sample/demo media path — not allowed.");
}

// Export must use real recording primitives.
if (!/MediaRecorder/.test(main) || !/captureStream/.test(main)) {
  fail("export must use canvas captureStream + MediaRecorder for a real WebM.");
}

// Tabs / trailing whitespace hygiene across source.
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
console.log("lint: ok (file://-safe, no global collisions, real export, no demo path)");
