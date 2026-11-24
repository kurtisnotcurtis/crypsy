/**
 * Minimal zero-dependency static HTTP server for Playwright E2E tests.
 * Serves `crypsy-note/` on `http://127.0.0.1:<E2E_PORT>` so WebCrypto,
 * IndexedDB, BroadcastChannel, and Web Locks run in a secure context.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT || 4173);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const rawUrl = (req.url || '/').split('?')[0] || '/';
  const relPath = rawUrl === '/' ? 'index.html' : rawUrl.replace(/^\/+/, '');
  const fullPath = path.resolve(rootDir, relPath);

  if (!fullPath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Crypsy E2E static server listening on http://127.0.0.1:${port}`);
});
