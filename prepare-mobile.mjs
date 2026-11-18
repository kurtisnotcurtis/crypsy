/**
 * Stages minimal runtime web assets into `www/` for Capacitor native packaging
 * so source files, docs landing pages, and Crypsy-Portable.html are not bundled inside APKs/IPAs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(rootDir, 'www');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'dist'), { recursive: true });

const copies = [
  ['index.html', 'index.html'],
  ['styles.css', 'styles.css'],
  ['dist/app.bundle.js', 'dist/app.bundle.js'],
  ['docs/icon.svg', 'icon.svg'],
  ['docs/manifest.webmanifest', 'manifest.webmanifest'],
];

for (const [srcRel, destRel] of copies) {
  const srcPath = path.join(rootDir, srcRel);
  const destPath = path.join(outDir, destRel);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing build asset for Capacitor www/: ${srcPath}`);
  }
  fs.copyFileSync(srcPath, destPath);
}

console.log(`Prepared slim Capacitor web bundle in ${outDir} (${copies.length} files).`);
