import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
if (!pkg.version) {
  throw new Error('package.json is missing a "version" field.');
}
const isWatch = process.argv.includes('--watch');
const noMinify = process.argv.includes('--no-minify');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'app.ts')],
  outfile: path.join(__dirname, 'dist', 'app.bundle.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  define: {
    __CRYPSY_VERSION__: JSON.stringify(pkg.version),
  },
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch && !noMinify,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching src/ for changes...');
} else {
  await esbuild.build(buildOptions);
}
