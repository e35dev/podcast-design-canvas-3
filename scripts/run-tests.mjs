// scripts/run-tests.mjs — stable entry point for the verify.json "test" gate.
// Runs the zero-dependency node:test suite over tests/. Test files are
// enumerated explicitly (no `--test` glob) so this works identically on every
// Node version — including ones where `node --test tests/*.test.mjs` glob
// expansion is unsupported and fails with "Could not find tests/*.test.mjs".
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "tests");
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => path.join("tests", f))
  .sort();

if (!files.length) {
  console.error("run-tests: no tests/*.test.mjs files found");
  process.exit(1);
}

const r = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
