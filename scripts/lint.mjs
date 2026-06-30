// scripts/lint.mjs — syntax-check plus regression guards against rendered-UI
// failure modes that closed PRs #33–#37 (file:// breakage, missing upload path,
// canvas not drawing real uploaded pixels, file inputs not in static HTML).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "./_walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = listSourceFiles(root);

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`lint: ${path.relative(root, file)}\n${r.stderr}`);
  }
}

const problems = [];
const fail = (msg) => problems.push(msg);

const html = readFileSync(path.join(root, "index.html"), "utf8");
const preview = readFileSync(path.join(root, "app/preview.js"), "utf8");
const ui = readFileSync(path.join(root, "app/ui.js"), "utf8");
const htmlCode = html.replace(/<!--[\s\S]*?-->/g, "");

if (/<script[^>]*type=["']module["']/i.test(htmlCode)) {
  fail("index.html uses ES modules — blocked by CORS on file://");
}
if (!htmlCode.includes('data-bucket="host"') || !htmlCode.includes('data-bucket="guest1"')) {
  fail("index.html must declare static host/guest file inputs (not JS-generated)");
}
if (!htmlCode.includes('data-social="host"')) {
  fail("index.html must declare static social link inputs per speaker bucket");
}
if (!htmlCode.includes("stage-canvas")) {
  fail("index.html must include the composed preview canvas");
}
if (!/drawImage\s*\(/.test(preview)) {
  fail("app/preview.js must draw real video frames with ctx.drawImage");
}
if (!/stage-canvas/.test(ui)) {
  fail("app/ui.js must wire the preview canvas");
}
if (/innerHTML\s*=\s*["']/.test(ui) && /buckets/.test(ui)) {
  fail("app/ui.js must not rebuild bucket rows (destroys static file inputs)");
}
if (/load\s+sample|sample\s+synced|generateSample|fakeVideo|seededClip|demoMedia/i.test(ui + preview)) {
  fail("product code must not ship sample/demo media shortcuts");
}

if (failed) {
  console.error(`lint: ${failed} file(s) failed syntax check`);
  process.exit(1);
}
if (problems.length) {
  console.error("lint failed:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`lint: ${files.length} file(s) OK (file://-safe, static upload inputs, real canvas draw)`);
