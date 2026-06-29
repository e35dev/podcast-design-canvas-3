#!/usr/bin/env node
/*
 * Dependency-free "build". There is no bundling step — the product is plain
 * static files — so this copies the shippable assets into dist/ and verifies the
 * required entry points are present. It exits non-zero if anything is missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const ASSETS = ['index.html', 'styles.css', 'app/logic.js', 'app/app.js'];

for (const rel of ASSETS) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error('preview-build failed: missing required asset ' + rel);
    process.exit(1);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const rel of ASSETS) {
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

console.log('preview-build passed: copied ' + ASSETS.length + ' asset(s) to dist/.');
console.log('Serve with: npx --yes serve dist  (or: npm run dev)');
