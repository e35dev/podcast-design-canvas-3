#!/usr/bin/env node
/*
 * Dependency-free type/syntax check.
 *
 * This project is intentionally a zero-dependency, no-build vanilla app so it
 * runs from file:// or any static host and the sandbox build cannot fail on a
 * missing toolchain. "typecheck" therefore verifies that every source file
 * parses cleanly via `node --check` (the same parser the runtime uses), which
 * catches the class of syntax/declaration errors that broke earlier attempts.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, acc);
    else if (/\.(m?js)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const files = collect(ROOT, []);
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('ok   ' + path.relative(ROOT, file));
  } catch (err) {
    failed++;
    console.error('FAIL ' + path.relative(ROOT, file));
    console.error(String(err.stderr || err.message));
  }
}

if (failed) {
  console.error('\ntypecheck failed: ' + failed + ' file(s) with errors.');
  process.exit(1);
}
console.log('\ntypecheck passed: ' + files.length + ' file(s).');
