// Skyward ATC server: serves the built client and a small JSON API that persists
// player profiles, checkpoints (autosave), manual saves and shift results in SQLite.
// Zero dependencies: node:http + node:sqlite (Node >= 22.13).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createApi, SECURITY_HEADERS } from './api-core.mjs';
import { createSqliteStore } from './store-sqlite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));
const VERSION = process.env.APP_VERSION || '1.0.0';

const store = createSqliteStore(DATA_DIR);
const handleApi = createApi(store, { version: VERSION });

// ------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const gzCache = new Map();

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let file = path.normalize(path.join(STATIC_DIR, rel));
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat && stat.isDirectory()) {
    file = path.join(file, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat) {
    // SPA fallback for navigations; real 404 for missing assets.
    if (path.extname(rel)) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    file = path.join(STATIC_DIR, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Client build missing');
    }
  }
  const ext = path.extname(file).toLowerCase();
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  };
  if (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']) >= new Date(stat.mtime.toUTCString())) {
    res.writeHead(304, headers);
    return res.end();
  }
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024) {
    const key = file + ':' + stat.mtimeMs;
    let gz = gzCache.get(key);
    if (!gz) {
      gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
      gzCache.set(key, gz);
    }
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': gz.length });
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end();
  }
  try {
    serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('Static error', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.keepAliveTimeout = 30_000;
server.listen(PORT, HOST, () => {
  console.log(`Skyward ATC ${VERSION} listening on http://${HOST}:${PORT} (data: ${DATA_DIR}, static: ${STATIC_DIR})`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    try {
      store.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
