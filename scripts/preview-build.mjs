#!/usr/bin/env node
// scripts/preview-build.mjs — static shippability check (no bundler, no deps).
// Confirms the app is servable AND openable directly over file://:
//  - index.html present, has a <canvas>, loads every app script
//  - app entry is loaded as a CLASSIC script (NOT type="module"), because ES
//    module imports are CORS-blocked over file:// and would leave a blank page
//  - every referenced app/*.js exists and parses (node --check)
//  - the DOM-free models populate the global PDC namespace when loaded
import { readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const indexPath = path.join(root, "index.html");
if (!existsSync(indexPath)) {
  problems.push("index.html missing");
} else {
  const html = readFileSync(indexPath, "utf8");
  if (!/<canvas/i.test(html)) problems.push("index.html has no <canvas> for the preview");
  if (/<script[^>]*\btype=["']module["']/i.test(html)) {
    problems.push("index.html uses <script type=\"module\">, which fails to load over file:// (use classic scripts)");
  }
  const scriptSrcs = [...html.matchAll(/<script[^>]*\bsrc=["'](app\/[^"']+)["']/gi)].map((m) => m[1]);
  const required = ["app/presets.js", "app/episode.js", "app/export-plan.js", "app/compositor.js", "app/exporter.js", "app/ui.js"];
  for (const r of required) {
    if (!scriptSrcs.includes(r)) problems.push(`index.html does not load ${r}`);
  }
  // ui.js must load after its dependencies.
  if (scriptSrcs.includes("app/ui.js") && scriptSrcs.indexOf("app/ui.js") !== scriptSrcs.length - 1) {
    problems.push("app/ui.js (the entry) must be the last script so its dependencies load first");
  }
  // Every referenced script must exist and parse.
  for (const s of scriptSrcs) {
    const full = path.join(root, s);
    if (!existsSync(full)) { problems.push(`missing script: ${s}`); continue; }
    const res = spawnSync(process.execPath, ["--check", full], { encoding: "utf8" });
    if (res.status !== 0) problems.push(`${s} failed syntax check: ${(res.stderr || "").split("\n")[0]}`);
  }
}

// DOM-free models must populate the global namespace when loaded.
for (const f of ["presets.js", "episode.js", "export-plan.js"]) {
  const full = path.join(root, "app", f);
  if (!existsSync(full)) { problems.push(`missing app/${f}`); continue; }
  try { await import(pathToFileURL(full).href); } catch (e) { problems.push(`app/${f} failed to load: ${e.message}`); }
}
const pdc = globalThis.PDC || {};
for (const ns of ["presets", "episode", "exportPlan"]) {
  if (!pdc[ns]) problems.push(`PDC.${ns} was not registered by its module`);
}

if (problems.length) {
  console.error("preview-build FAILED:");
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log("preview-build OK — static app is self-consistent and servable over http and file://.");
