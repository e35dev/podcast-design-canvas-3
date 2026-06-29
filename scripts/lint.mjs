#!/usr/bin/env node
/*
 * Dependency-free lint. Beyond a syntax pass, this enforces the invariants that
 * broke previous attempts so they can never silently regress:
 *   - index.html must NOT use type="module" (those scripts are blocked under
 *     file:// by CORS and leave the app a dead shell).
 *   - The app must load its classic scripts in order (logic before controller).
 *   - No top-level global declarations that can collide on re-load
 *     (e.g. `Identifier 'PRESETS' has already been declared`).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function collectJs(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJs(full, acc);
    else if (/\.(m?js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

// 1. Syntax check every JS file.
for (const file of collectJs(ROOT, [])) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push('Syntax error in ' + path.relative(ROOT, file) + '\n' + String(err.stderr || err.message));
  }
}

// 2. index.html invariants. Only inspect actual <script> tags, not comments.
const html = read('index.html');
const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
if (scriptTags.some((tag) => /type\s*=\s*["']module["']/i.test(tag))) {
  problems.push('index.html loads a script with type="module" — use classic scripts so the app works under file://.');
}
const logicIdx = html.indexOf('app/logic.js');
const appIdx = html.indexOf('app/app.js');
if (logicIdx === -1 || appIdx === -1) {
  problems.push('index.html must load both app/logic.js and app/app.js as classic scripts.');
} else if (logicIdx > appIdx) {
  problems.push('index.html must load app/logic.js before app/app.js.');
}

// 3. No top-level (column-0) global declarations that can collide on re-load.
for (const file of ['app/logic.js', 'app/app.js']) {
  const src = read(file);
  const offenders = src.split('\n').filter((line) => /^(const|let|var|function|class)\s/.test(line));
  if (offenders.length) {
    problems.push(file + ' has top-level global declaration(s) that can collide on re-load:\n  ' +
      offenders.join('\n  ') + '\n  Wrap browser code in an IIFE/UMD closure.');
  }
}

if (problems.length) {
  console.error('lint failed:\n\n' + problems.join('\n\n'));
  process.exit(1);
}
console.log('lint passed: file://-safety and no-global-collision invariants hold.');
