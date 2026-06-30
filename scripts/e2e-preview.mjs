// scripts/e2e-preview.mjs — alias for the rendered upload verification gate.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "rendered-verify.mjs");
const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
process.exit(r.status ?? 1);
