import { readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const roots = ["app", "scripts", "tests"];

function collect(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collect(fullPath));
    } else if (/\.(js|mjs)$/.test(name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = roots.flatMap(collect);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Checked ${files.length} JavaScript files.`);
