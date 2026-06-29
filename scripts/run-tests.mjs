#!/usr/bin/env node
// scripts/run-tests.mjs — zero-dependency test runner.
// Discovers tests/*.test.js and runs each in its own `node` child process.
// Fails (exit 1) if any test file exits non-zero. No frameworks, no deps.
import { readdirSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");

let files = [];
try {
  files = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort();
} catch (e) {
  console.error("No tests/ directory found.");
  process.exit(1);
}

if (!files.length) {
  console.error("No tests/*.test.js files found.");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const full = path.join(testsDir, f);
  const res = spawnSync(process.execPath, [full], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`FAIL ${f}`);
    failed++;
  } else {
    console.log(`PASS ${f}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test file(s) passed.`);
process.exit(failed ? 1 : 0);
