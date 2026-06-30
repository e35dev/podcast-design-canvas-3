import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const allowed = /\.(css|html|js|json|md|mjs)$/;
const ignored = new Set([".git", "dist", "node_modules", "tmp"]);
const violations = [];

function visit(dir) {
  for (const name of readdirSync(dir)) {
    if (ignored.has(name)) {
      continue;
    }
    const fullPath = join(dir, name);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (!allowed.test(name)) {
      continue;
    }
    const content = readFileSync(fullPath, "utf8");
    content.split(/\r?\n/).forEach((line, index) => {
      if (/[ \t]+$/.test(line)) {
        violations.push(`${fullPath}:${index + 1} trailing whitespace`);
      }
      if (/\t/.test(line)) {
        violations.push(`${fullPath}:${index + 1} tab character`);
      }
    });
  }
}

visit(".");

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("Lint checks passed.");
