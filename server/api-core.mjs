// Skyward ATC JSON API: routes, validation and HTTP plumbing shared by the Node server (SQLite)
// and the Vercel function (Postgres). Storage is injected as an async `store` object.

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

const intParam = (v) => {
  if (!/^\d{1,12}$/.test(v)) throw new HttpError(400, 'Invalid id');
  return Number(v);
};

export function createApi(store, { version = '1.0.0' } = {}) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, re, keys, handler });
  };

  async function requireProfile(id) {
    const row = await store.getProfile(id);
    if (!row) throw new HttpError(404, 'Profile not found');
    return row;
  }

  route('GET', '/api/health', async () => ({
    status: 200,
    body: { ok: true, version, uptime: Math.round(process.uptime()), profiles: await store.countProfiles() },
  }));

  route('GET', '/api/profiles', async () => ({ status: 200, body: (await store.listProfiles()).map(profileSummary) }));

  route('POST', '/api/profiles', async ({ req }) => {
    const body = requireObject(await readBody(req), 'Body');
    const name = validName(body.name);
    if (!name) throw new HttpError(400, 'Name must be 1-24 letters, digits, spaces or . _ \' -');
    if (await store.findProfileByName(name)) throw new HttpError(409, 'A profile with that name already exists');
    const now = Date.now();
    const id = await store.insertProfile(name, now);
    return { status: 201, body: { id, name, createdAt: now, lastPlayedAt: now, settings: {}, career: {} } };
  });

  route('GET', '/api/profiles/:id', async ({ params }) => {
    const row = await requireProfile(intParam(params.id));
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

  route('DELETE', '/api/profiles/:id', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    await store.deleteProfile(id);
    return { status: 204 };
  });

  route('PUT', '/api/profiles/:id/settings', async ({ req, params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const settings = requireObject(await readBody(req), 'Settings');
    const text = JSON.stringify(settings);
    if (text.length > 64 * 1024) throw new HttpError(413, 'Settings too large');
    await store.setSettings(id, text);
    return { status: 200, body: { ok: true } };
  });

  route('PUT', '/api/profiles/:id/career', async ({ req, params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const career = requireObject(await readBody(req), 'Career');
    const text = JSON.stringify(career);
    if (text.length > 256 * 1024) throw new HttpError(413, 'Career data too large');
    await store.setCareer(id, text, Date.now());
    return { status: 200, body: { ok: true } };
  });

  async function saveCheckpoint({ req, params }) {
    const id = intParam(params.id);
    await requireProfile(id);
    const body = requireObject(await readBody(req), 'Body');
    const state = requireObject(body.state, 'state');
    const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    const now = Date.now();
    await store.upsertCheckpoint(id, JSON.stringify(summary), JSON.stringify(state), now);
    return { status: 200, body: { ok: true, updatedAt: now } };
  }
  route('PUT', '/api/profiles/:id/checkpoint', saveCheckpoint);
  // sendBeacon() can only POST; accept it too.
  route('POST', '/api/profiles/:id/checkpoint', saveCheckpoint);

  route('GET', '/api/profiles/:id/checkpoint', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const row = await store.getCheckpoint(id);
    if (!row) throw new HttpError(404, 'No checkpoint');
    return {
      status: 200,
      body: { id: row.id, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), updatedAt: row.updated_at },
    };
  });

  route('DELETE', '/api/profiles/:id/checkpoint', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    await store.deleteCheckpoint(id);
    return { status: 204 };
  });

  route('GET', '/api/profiles/:id/saves', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
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

  route('POST', '/api/profiles/:id/saves', async ({ req, params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const body = requireObject(await readBody(req), 'Body');
    const state = requireObject(body.state, 'state');
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
    if ((await store.countSaves(id)) >= MAX_MANUAL_SAVES) throw new HttpError(409, `You can keep up to ${MAX_MANUAL_SAVES} saves. Delete one first.`);
    const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    const now = Date.now();
    const saveId = await store.insertSave(id, label || 'Saved game', JSON.stringify(summary), JSON.stringify(state), now);
    return { status: 201, body: { id: saveId, label: label || 'Saved game', summary, createdAt: now, updatedAt: now } };
  });

  route('GET', '/api/profiles/:id/saves/:saveId', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const row = await store.getSave(intParam(params.saveId), id);
    if (!row) throw new HttpError(404, 'Save not found');
    return {
      status: 200,
      body: { id: row.id, label: row.label, summary: parseJson(row.summary, {}), state: parseJson(row.state, null), createdAt: row.created_at, updatedAt: row.updated_at },
    };
  });

  route('DELETE', '/api/profiles/:id/saves/:saveId', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const deleted = await store.deleteSave(intParam(params.saveId), id);
    if (!deleted) throw new HttpError(404, 'Save not found');
    return { status: 204 };
  });

  route('POST', '/api/profiles/:id/results', async ({ req, params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
    const b = requireObject(await readBody(req), 'Body');
    if (typeof b.shiftId !== 'string' || typeof b.airport !== 'string') throw new HttpError(400, 'shiftId and airport are required');
    const score = Math.round(Number(b.score) || 0);
    const stars = Math.max(0, Math.min(3, Math.round(Number(b.stars) || 0)));
    const now = Date.now();
    const resultId = await store.insertResult(id, b.shiftId.slice(0, 40), b.airport.slice(0, 10), score, stars, JSON.stringify(b.stats ?? {}), now);
    return { status: 201, body: { id: resultId, completedAt: now } };
  });

  route('GET', '/api/profiles/:id/results', async ({ params }) => {
    const id = intParam(params.id);
    await requireProfile(id);
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

  return async function handleApi(req, res, pathname) {
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
  };
}
