#!/usr/bin/env node
// scripts/preview-build.mjs — static-shippability check.
// Confirms the app can ship as a plain static site: index.html exists, every
// <script src> / <link href> it references resolves on disk, no build step is
// required, and the DOM-free models load cleanly in Node. Prints an OK line.
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const indexPath = path.join(root, "index.html");
if (!existsSync(indexPath)) {
  console.error("preview-build: index.html missing");
  process.exit(1);
}
const html = readFileSync(indexPath, "utf8");

// Collect referenced local assets.
const refs = [
  ...[...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]),
];
const localRefs = refs.filter((r) => !/^https?:\/\//.test(r));
if (!localRefs.length) problems.push("index.html references no local assets");

for (const r of localRefs) {
  if (!existsSync(path.join(root, r))) problems.push(`missing referenced asset: ${r}`);
}

// The DOM-free models must load in Node (no DOM needed) so they are testable
// and the static site has no build/transpile requirement.
const models = ["app/presets.js", "app/episode.js", "app/export-plan.js"];
for (const m of models) {
  try {
    const mod = await import(pathToFileURL(path.join(root, m)).href);
    if (!mod || typeof mod.default !== "object") {
      // module.exports interop: dynamic import of a CJS file exposes it on default
      problems.push(`${m} did not export an object`);
    }
  } catch (e) {
    problems.push(`${m} failed to load in node: ${e.message}`);
  }
}

// No package.json deps should be required to ship.
const pkgPath = path.join(root, "package.json");
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const deps = Object.keys(pkg.dependencies || {});
  if (deps.length) problems.push(`package.json has runtime dependencies: ${deps.join(", ")}`);
}

if (problems.length) {
  for (const p of problems) console.error("preview-build: " + p);
  process.exit(1);
}

console.log(`preview-build OK — static site ships as-is (${localRefs.length} local assets, ${models.length} DOM-free models load in node, 0 deps).`);
