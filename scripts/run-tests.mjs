// scripts/run-tests.mjs — stable entry point for the verify.json "test" gate.
// Runs the zero-dependency node:test suite over tests/.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = spawnSync(process.execPath, ["--test", "tests/*.test.mjs"], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
