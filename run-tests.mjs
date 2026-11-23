/**
 * Cross-platform unit test runner: bundles all `tests/*.test.ts` files with
 * esbuild into `dist/tests/` and runs them via Node's built-in test runner.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(rootDir, 'tests');
const outDir = path.join(rootDir, 'dist', 'tests');

const entryPoints = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => path.join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('No *.test.ts files found in tests/.');
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints,
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});

const builtFiles = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith('.mjs'))
  .sort()
  .map((f) => path.join(outDir, f));

const res = spawnSync(process.execPath, ['--test', ...builtFiles], {
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
