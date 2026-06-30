// scripts/typecheck.mjs — this is a plain-JavaScript project (no TypeScript), so
// "typecheck" is a structural sanity pass rather than a static type analysis:
// it loads the DOM-free model in a sandbox and asserts the public PDC API shape
// the UI relies on actually exists. A missing/renamed export fails here instead
// of silently breaking the running app.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "../tests/_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);

const required = {
  presets: ["SPEAKER_BUCKETS", "BUCKET_LABELS", "PRESETS", "DEFAULT_PRESET_ID", "getPreset"],
  episode: ["createEpisode", "assignMedia", "clearMedia", "assignedBuckets", "setPreset", "canCompose", "readinessReason", "MIN_SPEAKERS"],
};

const missing = [];
for (const [ns, keys] of Object.entries(required)) {
  if (!PDC[ns]) {
    missing.push(`PDC.${ns} (whole namespace)`);
    continue;
  }
  for (const k of keys) if (!(k in PDC[ns])) missing.push(`PDC.${ns}.${k}`);
}

if (missing.length) {
  console.error("typecheck: missing public API members:\n  " + missing.join("\n  "));
  process.exit(1);
}
console.log("typecheck: PDC model API shape OK");
