import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = [".", "app", "scripts", "tests"];
const allowed = /\.(css|html|js|json|md|mjs)$/;
const violations = [];
const seen = new Set();

function visit(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "dist" || name === "node_modules") {
      continue;
    }

    const fullPath = join(dir, name);
    if (seen.has(fullPath)) {
      continue;
    }
    seen.add(fullPath);

    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      visit(fullPath);
      continue;
    }
    if (!allowed.test(name)) {
      continue;
    }

    const content = readFileSync(fullPath, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (/\s+$/.test(line)) {
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
