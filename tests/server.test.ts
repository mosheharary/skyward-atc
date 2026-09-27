// @ts-nocheck -- node builtins without @types/node
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Runs the real server (restarted against the same DATA_DIR, as the Docker volume does). Sessions come from the
// test-only /api/auth/test-login route; Google itself is covered by tests/auth.test.ts.
const dataDir = mkdtempSync(path.join(tmpdir(), 'skyward-test-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const AUTH_ENV = {
  SESSION_SECRET: 'test-session-secret',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  AUTH_TEST_LOGIN: '1',
};
let proc = null;

async function start(env: Record<string, string> = AUTH_ENV): Promise<void> {
  const { VERCEL, PUBLIC_URL, AUTH_TEST_LOGIN, ...inherited } = process.env;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.mjs'], {
    env: { ...inherited, ...env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, STATIC_DIR: dataDir, LOG_REQUESTS: '0' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not start');
}

async function stop(): Promise<void> {
  if (!proc) return;
  const p = proc;
  proc = null;
  await new Promise((r) => {
    p.once('exit', r);
    p.kill('SIGTERM');
  });
}

const json = (method: string, body?: unknown, cookie?: string): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (cookie?: string): RequestInit => ({ headers: cookie ? { cookie } : {} });

/** Signs in as a test identity and returns the session cookie. */
async function login(sub: string, name = sub): Promise<string> {
  const r = await fetch(`${base}/api/auth/test-login`, json('POST', { sub, name, email: `${sub}@example.com` }));
  expect(r.status).toBe(200);
  const set = r.headers.get('set-cookie') ?? '';
  expect(set).toMatch(/skyward_sid=[^;]+;.*HttpOnly/);
  return set.split(';')[0];
}

afterAll(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server persistence', () => {
  it('drops ownerless pre-auth profiles when migrating an old database', async () => {
    const db = new DatabaseSync(path.join(dataDir, 'skyward.db'));
    db.exec(`CREATE TABLE profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL, last_played_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}', career TEXT NOT NULL DEFAULT '{}');
      INSERT INTO profiles (name, created_at, last_played_at) VALUES ('Legacy', 1, 1);`);
    db.close();
    await start();
    const cookie = await login('migrated', 'Legacy');
    const me = await (await fetch(`${base}/api/me`, get(cookie))).json();
    expect(me.name).toBe('Legacy'); // the name is free again: names are no longer globally unique
    expect(me.checkpoint).toBeNull();
    await stop();
  });

  it('keeps a user\'s checkpoint and saves across a restart', async () => {
    await start();
    const cookie = await login('persist', 'Persist Test');

    expect((await fetch(`${base}/api/me/checkpoint`, get(cookie))).status).toBe(404);
    const state = { version: 1, t: 1234.5, aircraft: [{ id: 'AC1', callsign: 'TST1' }] };
    const summary = { title: 'Shift 1', score: 42 };
    expect((await fetch(`${base}/api/me/checkpoint`, json('PUT', { state, summary }, cookie))).status).toBe(200);
    expect((await fetch(`${base}/api/me/saves`, json('POST', { state, summary, label: 'Before storm' }, cookie))).status).toBe(201);

    await stop();
    await start();

    const me = await (await fetch(`${base}/api/me`, get(cookie))).json();
    expect(me.name).toBe('Persist Test');
    expect(me.email).toBe('persist@example.com');
    expect(me.checkpoint).toEqual(summary);
    const cp = await (await fetch(`${base}/api/me/checkpoint`, get(cookie))).json();
    expect(cp.state).toEqual(state);
    const saves = await (await fetch(`${base}/api/me/saves`, get(cookie))).json();
    expect(saves.map((s) => s.label)).toEqual(['Before storm']);

    // Signing in again with the same Google account reaches the same profile.
    const again = await login('persist', 'Renamed');
    expect((await (await fetch(`${base}/api/me`, get(again))).json()).id).toBe(me.id);

    expect((await fetch(`${base}/api/me/checkpoint`, json('DELETE', undefined, cookie))).status).toBe(204);
    expect((await fetch(`${base}/api/me/checkpoint`, get(cookie))).status).toBe(404);
  });

  it('keeps every user\'s data private', async () => {
    if (!proc) await start();
    const alice = await login('alice');
    const bob = await login('bob');
    const state = { version: 1, t: 1 };
    await fetch(`${base}/api/me/checkpoint`, json('PUT', { state, summary: { title: 'Alice shift' } }, alice));
    const save = await (await fetch(`${base}/api/me/saves`, json('POST', { state, label: 'Alice save' }, alice))).json();
    await fetch(`${base}/api/me/results`, json('POST', { shiftId: 's1', airport: 'KHPX', score: 10, stars: 1 }, alice));

    expect((await (await fetch(`${base}/api/me`, get(bob))).json()).checkpoint).toBeNull();
    expect((await fetch(`${base}/api/me/checkpoint`, get(bob))).status).toBe(404);
    expect(await (await fetch(`${base}/api/me/saves`, get(bob))).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/me/results`, get(bob))).json()).toEqual([]);
    expect((await fetch(`${base}/api/me/saves/${save.id}`, get(bob))).status).toBe(404);
    expect((await fetch(`${base}/api/me/saves/${save.id}`, json('DELETE', undefined, bob))).status).toBe(404);
    expect((await fetch(`${base}/api/me/saves/${save.id}`, get(alice))).status).toBe(200);
    // The old unauthenticated routes are gone.
    expect((await fetch(`${base}/api/profiles`)).status).toBe(404);
  });

  it('requires a valid session', async () => {
    if (!proc) await start();
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    expect((await fetch(`${base}/api/me/saves`)).status).toBe(401);
    expect((await fetch(`${base}/api/me/checkpoint`, json('PUT', { state: {} }))).status).toBe(401);
    const cookie = await login('tamper');
    const [name, value] = cookie.split('=');
    const [body, mac] = decodeURIComponent(value).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), pid: 1 })).toString('base64url');
    expect((await fetch(`${base}/api/me`, get(`${name}=${forged}.${mac}`))).status).toBe(401);
    expect((await fetch(`${base}/api/me`, get(`${name}=garbage`))).status).toBe(401);
    // Cross-site writes are refused even with a valid cookie.
    const cross = await fetch(`${base}/api/me/settings`, { ...json('PUT', {}, cookie), headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
  });

  it('signs out and deletes accounts', async () => {
    if (!proc) await start();
    const out = await fetch(`${base}/api/auth/logout`, json('POST'));
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/skyward_sid=;.*Max-Age=0/);

    const cookie = await login('leaver');
    await fetch(`${base}/api/me/saves`, json('POST', { state: { t: 1 } }, cookie));
    expect((await fetch(`${base}/api/me`, json('DELETE', undefined, cookie))).status).toBe(204);
    expect((await fetch(`${base}/api/me`, get(cookie))).status).toBe(401);
    // A later sign-in with the same account starts from scratch.
    const fresh = await login('leaver');
    expect(await (await fetch(`${base}/api/me/saves`, get(fresh))).json()).toEqual([]);
  });

  it('starts and guards the Google flow', async () => {
    if (!proc) await start();
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.auth).toBe(true);
    const r = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get('location'));
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('client_id')).toBe(AUTH_ENV.GOOGLE_CLIENT_ID);
    expect(to.searchParams.get('redirect_uri')).toBe(`${base}/api/auth/callback`);
    expect(to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.headers.get('set-cookie')).toMatch(/skyward_oauth=.*Path=\/api\/auth.*HttpOnly/);

    // A callback without the matching state cookie never signs anyone in.
    const cb = await fetch(`${base}/api/auth/callback?code=x&state=y`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/?auth_error=1');
    expect(cb.headers.get('set-cookie') ?? '').not.toMatch(/skyward_sid=[^;]/);
  });

  it('rejects malformed input', async () => {
    if (!proc) await start();
    const cookie = await login('malformed');
    const bad = await fetch(`${base}/api/me/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/me/saves/abc`, get(cookie))).status).toBe(400);
    expect((await fetch(`${base}/api/me/saves/999999`, get(cookie))).status).toBe(404);
  });

  it('has no test login and no Google sign-in unless configured', async () => {
    await stop();
    await start({});
    expect((await (await fetch(`${base}/api/health`)).json()).auth).toBe(false);
    expect((await fetch(`${base}/api/auth/test-login`, json('POST', { sub: 'x' }))).status).toBe(404);
    expect((await fetch(`${base}/api/auth/login`, { redirect: 'manual' })).status).toBe(503);
    await stop();
  });
});
