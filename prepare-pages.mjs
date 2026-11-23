/**
 * Stages the GitHub Pages deployment directory (`_pages/`) by combining the
 * static landing site in `docs/` with freshly built Crypsy app assets so
 * generated bundles never need to be committed to git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
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
  if (srcRel === 'docs/index.html' && pkg.version) {
    const landingHtml = fs
      .readFileSync(srcPath, 'utf8')
      .replace(
        /(<span class="jk">"appVersion"<\/span>: <span class="js">")[^"]+("<\/span>)/,
        `$1${pkg.version}$2`
      );
    fs.writeFileSync(destPath, landingHtml, 'utf8');
  } else {
    fs.copyFileSync(srcPath, destPath);
  }
}

console.log(`Prepared GitHub Pages bundle in ${outDir} (${copies.length} files).`);
