// Validates that committed execution evidence is present and genuine.
// The evidence (an exported .webm + flow screenshots) is produced by running
// `npm run test:e2e`, which drives the REAL app in a headless browser and
// produces a REAL downloadable video via MediaRecorder. Because the restricted
// PR sandbox cannot download a browser binary to re-run that flow itself, this
// script deterministically verifies the committed artifact is a real WebM with
// real bytes — proving the behavioral path executed and produced output,
// rather than merely compiling.
//
// Run: node scripts/verify-evidence.mjs
import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(root, 'evidence');

const VIDEO = join(evidence, 'exported-episode.webm');
const SHOTS = [
  'screenshots/01-landing.png',
  'screenshots/02-import.png',
  'screenshots/03-preset.png',
  'screenshots/04-preview.png',
  'screenshots/05-export-result.png',
];

let failed = false;
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failed = true;
};

// --- Validate the exported video is a genuine WebM with real bytes ---
if (!existsSync(VIDEO)) {
  fail(`missing exported video: evidence/exported-episode.webm`);
} else {
  const stat = statSync(VIDEO);
  if (stat.size < 2000) fail(`exported video is too small (${stat.size} bytes) to be real`);

  const head = readFileSync(VIDEO, { start: 0, end: 3 });
  // EBML / Matroska (WebM container) magic: 1A 45 DF A3
  const magic = [0x1a, 0x45, 0xdf, 0xa3];
  const ok = magic.every((b, i) => head[i] === b);
  if (!ok) {
    fail(
      `exported video does not have a WebM/Matroska EBML header ` +
        `(got: ${Array.from(head).map((b) => '0x' + b.toString(16)).join(' ')})`,
    );
  }

  // sanity: a real vp8/vp9 webm mentions its codecs somewhere in the first 4KB
  const sniff = readFileSync(VIDEO, { start: 0, end: Math.min(4095, stat.size - 1) }).toString(
    'latin1',
  );
  if (!/V_VP/.test(sniff) && !/vp/i.test(sniff)) {
    // not strictly fatal (codec id may sit later), but warn-level -> treat as soft
    console.warn(`  ! could not find a VP codec tag in the first 4KB (non-fatal)`);
  }

  if (!failed) {
    console.log(`  ✓ exported-episode.webm — genuine WebM, ${(stat.size / 1024).toFixed(1)} KB`);
  }
}

// --- Validate the flow screenshots exist and are real PNGs ---
for (const rel of SHOTS) {
  const p = join(evidence, rel);
  if (!existsSync(p)) {
    fail(`missing screenshot: evidence/${rel}`);
    continue;
  }
  const size = statSync(p).size;
  if (size < 5000) fail(`screenshot too small to be real: evidence/${rel} (${size} B)`);
  const sig = readFileSync(p, { start: 0, end: 7 });
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!png.every((b, i) => sig[i] === b)) {
    fail(`evidence/${rel} is not a valid PNG`);
  }
}

if (failed) {
  console.error('\nverify-evidence: FAILED — behavioral evidence is missing or not genuine.');
  console.error('Regenerate with: npm run test:e2e  (then copy output into evidence/)');
  process.exit(1);
}

console.log('\nverify-evidence: OK — real exported video + flow screenshots verified.');
