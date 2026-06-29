import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const roots = ["app", "scripts", "tests"];

function collectFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      entries.push(...collectFiles(fullPath));
      continue;
    }
    if (/\.(js|mjs)$/.test(name)) {
      entries.push(fullPath);
    }
  }
  return entries;
}

const files = roots.flatMap(collectFiles);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Checked ${files.length} JavaScript files.`);
