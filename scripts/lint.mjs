// scripts/lint.mjs — dependency-free lint: syntax-check every source file with
// `node --check`. Catches parse errors and broken edits across app/ and scripts/.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSourceFiles } from "./_walk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = listSourceFiles(root);

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`lint: ${path.relative(root, file)}\n${r.stderr}`);
  }
}

if (failed) {
  console.error(`lint: ${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`lint: ${files.length} file(s) OK`);
