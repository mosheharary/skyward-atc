// Skyward ATC server: serves the built client and a small JSON API that persists
// player profiles, checkpoints (autosave), manual saves and shift results in SQLite.
// Zero dependencies: node:http + node:sqlite (Node >= 22.13).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '..', 'dist'));
const VERSION = process.env.APP_VERSION || '1.0.0';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_MANUAL_SAVES = 10;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'skyward.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 3000;
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    last_played_at INTEGER NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    career TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS saves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('auto', 'manual')),
    label TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS saves_one_auto ON saves(profile_id) WHERE kind = 'auto';
  CREATE INDEX IF NOT EXISTS saves_by_profile ON saves(profile_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    shift_id TEXT NOT NULL,
    airport TEXT NOT NULL,
    score INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    stats TEXT NOT NULL DEFAULT '{}',
    completed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS results_by_profile ON results(profile_id, completed_at DESC);
`);

const q = {
  listProfiles: db.prepare(`
    SELECT p.id, p.name, p.created_at, p.last_played_at, p.career,
      (SELECT s.summary FROM saves s WHERE s.profile_id = p.id AND s.kind = 'auto') AS checkpoint
    FROM profiles p ORDER BY p.last_played_at DESC`),
  countProfiles: db.prepare('SELECT COUNT(*) AS n FROM profiles'),
  getProfile: db.prepare('SELECT * FROM profiles WHERE id = ?'),
  findProfileByName: db.prepare('SELECT id FROM profiles WHERE name = ?'),
  insertProfile: db.prepare('INSERT INTO profiles (name, created_at, last_played_at) VALUES (?, ?, ?)'),
  deleteProfile: db.prepare('DELETE FROM profiles WHERE id = ?'),
  touchProfile: db.prepare('UPDATE profiles SET last_played_at = ? WHERE id = ?'),
  setSettings: db.prepare('UPDATE profiles SET settings = ? WHERE id = ?'),
  setCareer: db.prepare('UPDATE profiles SET career = ?, last_played_at = ? WHERE id = ?'),
  getCheckpoint: db.prepare("SELECT id, summary, state, updated_at FROM saves WHERE profile_id = ? AND kind = 'auto'"),
  updateCheckpoint: db.prepare("UPDATE saves SET summary = ?, state = ?, updated_at = ? WHERE profile_id = ? AND kind = 'auto'"),
  insertCheckpoint: db.prepare("INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at) VALUES (?, 'auto', 'Checkpoint', ?, ?, ?, ?)"),
  deleteCheckpoint: db.prepare("DELETE FROM saves WHERE profile_id = ? AND kind = 'auto'"),
  listSaves: db.prepare("SELECT id, label, summary, created_at, updated_at FROM saves WHERE profile_id = ? AND kind = 'manual' ORDER BY updated_at DESC"),
  countSaves: db.prepare("SELECT COUNT(*) AS n FROM saves WHERE profile_id = ? AND kind = 'manual'"),
  getSave: db.prepare("SELECT id, label, summary, state, created_at, updated_at FROM saves WHERE id = ? AND profile_id = ? AND kind = 'manual'"),
  insertSave: db.prepare("INSERT INTO saves (profile_id, kind, label, summary, state, created_at, updated_at) VALUES (?, 'manual', ?, ?, ?, ?, ?)"),
  deleteSave: db.prepare("DELETE FROM saves WHERE id = ? AND profile_id = ? AND kind = 'manual'"),
  insertResult: db.prepare('INSERT INTO results (profile_id, shift_id, airport, score, stars, stats, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  listResults: db.prepare('SELECT id, shift_id, airport, score, stars, stats, completed_at FROM results WHERE profile_id = ? ORDER BY completed_at DESC LIMIT 50'),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

function profileSummary(row) {
  const career = parseJson(row.career, {});
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastPlayedAt: row.last_played_at,
    careerSummary: career && typeof career === 'object' ? career.summary ?? null : null,
    checkpoint: row.checkpoint ? parseJson(row.checkpoint, null) : null,
  };
}

function validName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 24) return null;
  if (!/^[\p{L}\p{N} _.'-]+$/u.test(name)) return null;
  return name;
}

function requireObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${what} must be a JSON object`);
  return value;
}

function requireProfile(id) {
  const row = q.getProfile.get(id);
  if (!row) throw new HttpError(404, 'Profile not found');
  return row;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      const parsed = parseJson(text, undefined);
      if (parsed === undefined) return reject(new HttpError(400, 'Invalid JSON body'));
      resolve(parsed);
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self' blob:; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

// ---------------------------------------------------------------- API routes
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
  );
  routes.push({ method, re, keys, handler });
};

const intParam = (v) => {
  if (!/^\d{1,12}$/.test(v)) throw new HttpError(400, 'Invalid id');
  return Number(v);
};

route('GET', '/api/health', () => ({
  status: 200,
  body: { ok: true, version: VERSION, uptime: Math.round(process.uptime()), profiles: q.countProfiles.get().n },
}));

route('GET', '/api/profiles', () => ({ status: 200, body: q.listProfiles.all().map(profileSummary) }));

route('POST', '/api/profiles', async ({ req }) => {
  const body = requireObject(await readBody(req), 'Body');
  const name = validName(body.name);
  if (!name) throw new HttpError(400, 'Name must be 1-24 letters, digits, spaces or . _ \' -');
  if (q.findProfileByName.get(name)) throw new HttpError(409, 'A profile with that name already exists');
  const now = Date.now();
  const info = q.insertProfile.run(name, now, now);
  return { status: 201, body: { id: Number(info.lastInsertRowid), name, createdAt: now, lastPlayedAt: now, settings: {}, career: {} } };
});

route('GET', '/api/profiles/:id', ({ params }) => {
  const row = requireProfile(intParam(params.id));
  return {
    status: 200,
    body: {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastPlayedAt: row.last_played_at,
      settings: parseJson(row.settings, {}),
      career: parseJson(row.career, {}),
    },
  };
});

route('DELETE', '/api/profiles/:id', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  q.deleteProfile.run(id);
  return { status: 204 };
});

route('PUT', '/api/profiles/:id/settings', async ({ req, params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const settings = requireObject(await readBody(req), 'Settings');
  const text = JSON.stringify(settings);
  if (text.length > 64 * 1024) throw new HttpError(413, 'Settings too large');
  q.setSettings.run(text, id);
  return { status: 200, body: { ok: true } };
});

route('PUT', '/api/profiles/:id/career', async ({ req, params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const career = requireObject(await readBody(req), 'Career');
  const text = JSON.stringify(career);
  if (text.length > 256 * 1024) throw new HttpError(413, 'Career data too large');
  q.setCareer.run(text, Date.now(), id);
  return { status: 200, body: { ok: true } };
});

async function saveCheckpoint({ req, params }) {
  const id = intParam(params.id);
  requireProfile(id);
  const body = requireObject(await readBody(req), 'Body');
  const state = requireObject(body.state, 'state');
  const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const now = Date.now();
  const s = JSON.stringify(summary);
  const st = JSON.stringify(state);
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = q.updateCheckpoint.run(s, st, now, id);
    if (r.changes === 0) q.insertCheckpoint.run(id, s, st, now, now);
    q.touchProfile.run(now, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { status: 200, body: { ok: true, updatedAt: now } };
}
route('PUT', '/api/profiles/:id/checkpoint', saveCheckpoint);
// sendBeacon() can only POST; accept it too.
route('POST', '/api/profiles/:id/checkpoint', saveCheckpoint);

route('GET', '/api/profiles/:id/checkpoint', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const row = q.getCheckpoint.get(id);
  if (!row) throw new HttpError(404, 'No checkpoint');
  return {
    status: 200,
    body: { id: row.id, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), updatedAt: row.updated_at },
  };
});

route('DELETE', '/api/profiles/:id/checkpoint', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  q.deleteCheckpoint.run(id);
  return { status: 204 };
});

route('GET', '/api/profiles/:id/saves', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  return {
    status: 200,
    body: q.listSaves.all(id).map((r) => ({
      id: r.id,
      label: r.label,
      summary: parseJson(r.summary, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  };
});

route('POST', '/api/profiles/:id/saves', async ({ req, params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const body = requireObject(await readBody(req), 'Body');
  const state = requireObject(body.state, 'state');
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  if (q.countSaves.get(id).n >= MAX_MANUAL_SAVES) throw new HttpError(409, `You can keep up to ${MAX_MANUAL_SAVES} saves. Delete one first.`);
  const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
  const now = Date.now();
  const info = q.insertSave.run(id, label || 'Saved game', JSON.stringify(summary), JSON.stringify(state), now, now);
  return { status: 201, body: { id: Number(info.lastInsertRowid), label: label || 'Saved game', summary, createdAt: now, updatedAt: now } };
});

route('GET', '/api/profiles/:id/saves/:saveId', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const row = q.getSave.get(intParam(params.saveId), id);
  if (!row) throw new HttpError(404, 'Save not found');
  return {
    status: 200,
    body: { id: row.id, label: row.label, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), createdAt: row.created_at, updatedAt: row.updated_at },
  };
});

route('DELETE', '/api/profiles/:id/saves/:saveId', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const r = q.deleteSave.run(intParam(params.saveId), id);
  if (r.changes === 0) throw new HttpError(404, 'Save not found');
  return { status: 204 };
});

route('POST', '/api/profiles/:id/results', async ({ req, params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  const b = requireObject(await readBody(req), 'Body');
  if (typeof b.shiftId !== 'string' || typeof b.airport !== 'string') throw new HttpError(400, 'shiftId and airport are required');
  const score = Math.round(Number(b.score) || 0);
  const stars = Math.max(0, Math.min(3, Math.round(Number(b.stars) || 0)));
  const now = Date.now();
  const info = q.insertResult.run(id, b.shiftId.slice(0, 40), b.airport.slice(0, 10), score, stars, JSON.stringify(b.stats ?? {}), now);
  return { status: 201, body: { id: Number(info.lastInsertRowid), completedAt: now } };
});

route('GET', '/api/profiles/:id/results', ({ params }) => {
  const id = intParam(params.id);
  requireProfile(id);
  return {
    status: 200,
    body: q.listResults.all(id).map((r) => ({
      id: r.id,
      shiftId: r.shift_id,
      airport: r.airport,
      score: r.score,
      stars: r.stars,
      stats: parseJson(r.stats, {}),
      completedAt: r.completed_at,
    })),
  };
});

async function handleApi(req, res, pathname) {
  const started = Date.now();
  let status = 500;
  try {
    const candidates = routes.filter((r) => r.re.test(pathname));
    if (candidates.length === 0) throw new HttpError(404, 'Not found');
    const r = candidates.find((c) => c.method === req.method);
    if (!r) throw new HttpError(405, 'Method not allowed');
    const m = r.re.exec(pathname);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.handler({ req, res, params });
    status = out.status;
    if (status === 204) {
      res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
      res.end();
    } else sendJson(res, status, out.body);
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('API error', req.method, pathname, e);
    if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Internal server error' });
  } finally {
    if (process.env.LOG_REQUESTS !== '0') console.log(`${req.method} ${pathname} ${status} ${Date.now() - started}ms`);
  }
}

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
      db.close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
