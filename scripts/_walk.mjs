// scripts/_walk.mjs — tiny shared helper: list source JS files, skipping
// dependency and build output directories. Zero dependencies.
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", "dist", ".git", ".builderloops"]);

export function listSourceFiles(root, exts = [".js", ".mjs"]) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.includes(path.extname(entry.name))) out.push(full);
    }
  })(root);
  return out.sort();
}
