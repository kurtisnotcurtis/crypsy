/**
 * Stages the GitHub Pages deployment directory (`_pages/`) by combining the
 * static landing site in `docs/` with freshly built Crypsy app assets so
 * generated bundles never need to be committed to git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(rootDir, '_pages');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'dist'), { recursive: true });

const copies = [
  // Landing page & PWA metadata from docs/
  ['docs/index.html', 'index.html'],
  ['docs/.nojekyll', '.nojekyll'],
  ['docs/icon.svg', 'icon.svg'],
  ['docs/logo.svg', 'logo.svg'],
  ['docs/manifest.webmanifest', 'manifest.webmanifest'],
  // Freshly built Crypsy web app & standalone portable HTML
  ['index.html', 'app.html'],
  ['styles.css', 'styles.css'],
  ['dist/app.bundle.js', 'dist/app.bundle.js'],
  ['Crypsy-Portable.html', 'Crypsy-Portable.html'],
];

for (const [srcRel, destRel] of copies) {
  const srcPath = path.join(rootDir, srcRel);
  const destPath = path.join(rootDir, '_pages', destRel);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing asset for GitHub Pages staging: ${srcPath}`);
  }
  fs.copyFileSync(srcPath, destPath);
}

console.log(`Prepared GitHub Pages bundle in ${outDir} (${copies.length} files).`);
