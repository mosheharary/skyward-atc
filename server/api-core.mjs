// Skyward ATC JSON API: routes, validation and HTTP plumbing shared by the Node server (SQLite)
// and the Vercel function (Postgres). Storage is injected as an async `store` object.
// All player data is scoped to the Google-signed-in user's own profile (see server/auth.mjs).

import {
  authConfig, baseUrl, clearOauthCookie, clearSessionCookie, finishLogin, googleConfigured, profileName, sessionCookie, sessionFrom, startLogin,
} from './auth.mjs';

const MAX_BODY = 4 * 1024 * 1024;
const MAX_MANUAL_SAVES = 10;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

function requireObject(value, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${what} must be a JSON object`);
  return value;
}

function readBody(req) {
  // Vercel exposes an already-buffered body through a lazy `req.body` getter that throws on bad JSON.
  if ('body' in req) {
    let body;
    try {
      body = req.body;
    } catch {
      return Promise.reject(new HttpError(400, 'Invalid JSON body'));
    }
    if (body === undefined || body === null || body === '') return Promise.resolve({});
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      try {
        return Promise.resolve(parseBodyText(body.toString('utf8')));
      } catch (e) {
        return Promise.reject(e);
      }
    }
    return Promise.resolve(body);
  }
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
      try {
        resolve(parseBodyText(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseBodyText(text) {
  if (!text) return {};
  const parsed = parseJson(text, undefined);
  if (parsed === undefined) throw new HttpError(400, 'Invalid JSON body');
  return parsed;
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self' blob:; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};

function sendJson(res, status, body, cookies = []) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
    ...(cookies.length ? { 'Set-Cookie': cookies } : {}),
  });
  res.end(data);
}

const intParam = (v) => {
  if (!/^\d{1,12}$/.test(v)) throw new HttpError(400, 'Invalid id');
  return Number(v);
};

export function createApi(store, { version = '1.0.0', env = process.env, fetchImpl } = {}) {
  const cfg = authConfig(env);
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, re, keys, handler });
  };

  /** The signed-in user's profile row. Every data route goes through this, so a user can only reach their own rows. */
  async function requireSession(req) {
    const s = sessionFrom(req, cfg);
    const row = s ? await store.getProfile(s.pid) : null;
    if (!row || row.google_sub !== s.sub) throw new HttpError(401, 'Not signed in');
    return row;
  }

  const secureFor = (req) => baseUrl(req, cfg).startsWith('https:');

  route('GET', '/api/health', async () => ({
    status: 200,
    body: { ok: true, version, uptime: Math.round(process.uptime()), auth: googleConfigured(cfg) },
  }));

  // ---- Authentication -------------------------------------------------------------------------

  route('GET', '/api/auth/login', async ({ req }) => {
    if (!googleConfigured(cfg)) throw new HttpError(503, 'Google sign-in is not configured on this server');
    const { url, cookie } = startLogin(cfg, baseUrl(req, cfg));
    return { status: 302, redirect: url, cookies: [cookie] };
  });

  route('GET', '/api/auth/callback', async ({ req }) => {
    const base = baseUrl(req, cfg);
    const secure = base.startsWith('https:');
    try {
      if (!googleConfigured(cfg)) throw new Error('Google sign-in is not configured');
      const who = await finishLogin(req, cfg, base, fetchImpl);
      const profile = await store.upsertUserProfile({
        sub: who.sub,
        email: who.email,
        name: profileName(who.name || who.email.split('@')[0]),
        now: Date.now(),
      });
      return { status: 302, redirect: '/', cookies: [sessionCookie(profile, cfg, secure), clearOauthCookie(secure)] };
    } catch (e) {
      console.warn('Google sign-in failed:', e instanceof Error ? e.message : e);
      return { status: 302, redirect: '/?auth_error=1', cookies: [clearOauthCookie(secure)] };
    }
  });

  route('POST', '/api/auth/logout', async ({ req }) => ({ status: 204, cookies: [clearSessionCookie(secureFor(req))] }));

  if (cfg.testLogin) {
    route('POST', '/api/auth/test-login', async ({ req }) => {
      const b = requireObject(await readBody(req), 'Body');
      if (typeof b.sub !== 'string' || !b.sub) throw new HttpError(400, 'sub is required');
      const profile = await store.upsertUserProfile({
        sub: `test:${b.sub}`,
        email: typeof b.email === 'string' ? b.email : '',
        name: profileName(b.name || b.sub),
        now: Date.now(),
      });
      return { status: 200, body: { ok: true, id: profile.id }, cookies: [sessionCookie(profile, cfg, secureFor(req))] };
    });
  }

  // ---- The signed-in user's data ----------------------------------------------------------------

  route('GET', '/api/me', async ({ req }) => {
    const row = await requireSession(req);
    const cp = await store.getCheckpointSummary(row.id);
    return {
      status: 200,
      body: {
        id: row.id,
        name: row.name,
        email: row.email ?? '',
        createdAt: row.created_at,
        lastPlayedAt: row.last_played_at,
        settings: parseJson(row.settings, {}),
        career: parseJson(row.career, {}),
        checkpoint: cp ? parseJson(cp, null) : null,
      },
    };
  });

  route('DELETE', '/api/me', async ({ req }) => {
    const row = await requireSession(req);
    await store.deleteProfile(row.id);
    return { status: 204, cookies: [clearSessionCookie(secureFor(req))] };
  });

  route('PUT', '/api/me/settings', async ({ req }) => {
    const { id } = await requireSession(req);
    const settings = requireObject(await readBody(req), 'Settings');
    const text = JSON.stringify(settings);
    if (text.length > 64 * 1024) throw new HttpError(413, 'Settings too large');
    await store.setSettings(id, text);
    return { status: 200, body: { ok: true } };
  });

  route('PUT', '/api/me/career', async ({ req }) => {
    const { id } = await requireSession(req);
    const career = requireObject(await readBody(req), 'Career');
    const text = JSON.stringify(career);
    if (text.length > 256 * 1024) throw new HttpError(413, 'Career data too large');
    await store.setCareer(id, text, Date.now());
    return { status: 200, body: { ok: true } };
  });

  async function saveCheckpoint({ req }) {
    const { id } = await requireSession(req);
    const body = requireObject(await readBody(req), 'Body');
    const state = requireObject(body.state, 'state');
    const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    const now = Date.now();
    await store.upsertCheckpoint(id, JSON.stringify(summary), JSON.stringify(state), now);
    return { status: 200, body: { ok: true, updatedAt: now } };
  }
  route('PUT', '/api/me/checkpoint', saveCheckpoint);
  // sendBeacon() can only POST; accept it too.
  route('POST', '/api/me/checkpoint', saveCheckpoint);

  route('GET', '/api/me/checkpoint', async ({ req }) => {
    const { id } = await requireSession(req);
    const row = await store.getCheckpoint(id);
    if (!row) throw new HttpError(404, 'No checkpoint');
    return {
      status: 200,
      body: { id: row.id, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), updatedAt: row.updated_at },
    };
  });

  route('DELETE', '/api/me/checkpoint', async ({ req }) => {
    const { id } = await requireSession(req);
    await store.deleteCheckpoint(id);
    return { status: 204 };
  });

  route('GET', '/api/me/saves', async ({ req }) => {
    const { id } = await requireSession(req);
    return {
      status: 200,
      body: (await store.listSaves(id)).map((r) => ({
        id: r.id,
        label: r.label,
        summary: parseJson(r.summary, {}),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    };
  });

  route('POST', '/api/me/saves', async ({ req }) => {
    const { id } = await requireSession(req);
    const body = requireObject(await readBody(req), 'Body');
    const state = requireObject(body.state, 'state');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    if ((await store.countSaves(id)) >= MAX_MANUAL_SAVES) throw new HttpError(409, `You can keep up to ${MAX_MANUAL_SAVES} saves. Delete one first.`);
    const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    const now = Date.now();
    const saveId = await store.insertSave(id, label || 'Saved game', JSON.stringify(summary), JSON.stringify(state), now);
    return { status: 201, body: { id: saveId, label: label || 'Saved game', summary, createdAt: now, updatedAt: now } };
  });

  route('GET', '/api/me/saves/:saveId', async ({ req, params }) => {
    const { id } = await requireSession(req);
    const row = await store.getSave(intParam(params.saveId), id);
    if (!row) throw new HttpError(404, 'Save not found');
    return {
      status: 200,
      body: { id: row.id, label: row.label, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), createdAt: row.created_at, updatedAt: row.updated_at },
    };
  });

  route('DELETE', '/api/me/saves/:saveId', async ({ req, params }) => {
    const { id } = await requireSession(req);
    const deleted = await store.deleteSave(intParam(params.saveId), id);
    if (!deleted) throw new HttpError(404, 'Save not found');
    return { status: 204 };
  });

  route('POST', '/api/me/results', async ({ req }) => {
    const { id } = await requireSession(req);
    const b = requireObject(await readBody(req), 'Body');
    if (typeof b.shiftId !== 'string' || typeof b.airport !== 'string') throw new HttpError(400, 'shiftId and airport are required');
    const score = Math.round(Number(b.score) || 0);
    const stars = Math.max(0, Math.min(3, Math.round(Number(b.stars) || 0)));
    const now = Date.now();
    const resultId = await store.insertResult(id, b.shiftId.slice(0, 40), b.airport.slice(0, 10), score, stars, JSON.stringify(b.stats ?? {}), now);
    return { status: 201, body: { id: resultId, completedAt: now } };
  });

  route('GET', '/api/me/results', async ({ req }) => {
    const { id } = await requireSession(req);
    return {
      status: 200,
      body: (await store.listResults(id)).map((r) => ({
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

  /** Cross-site writes are refused (on top of SameSite=Lax cookies). */
  function checkOrigin(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(baseUrl(req, cfg)).origin) throw new HttpError(403, 'Cross-origin request refused');
  }

  return async function handleApi(req, res, pathname) {
    const started = Date.now();
    let status = 500;
    try {
      const candidates = routes.filter((r) => r.re.test(pathname));
      if (candidates.length === 0) throw new HttpError(404, 'Not found');
      const r = candidates.find((c) => c.method === req.method);
      if (!r) throw new HttpError(405, 'Method not allowed');
      checkOrigin(req);
      const m = r.re.exec(pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler({ req, res, params });
      status = out.status;
      const cookies = out.cookies ?? [];
      if (out.redirect) {
        res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', Location: out.redirect, 'Set-Cookie': cookies });
        res.end();
      } else if (status === 204) {
        res.writeHead(204, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
        res.end();
      } else sendJson(res, status, out.body, cookies);
    } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('API error', req.method, pathname, e);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Internal server error' });
    } finally {
      if (process.env.LOG_REQUESTS !== '0') console.log(`${req.method} ${pathname} ${status} ${Date.now() - started}ms`);
    }
  };
}
