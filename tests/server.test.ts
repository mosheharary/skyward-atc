// @ts-nocheck -- node builtins without @types/node
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Runs the real server twice against the same DATA_DIR to prove state survives a restart (as the Docker volume does).
const dataDir = mkdtempSync(path.join(tmpdir(), 'skyward-test-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let proc = null;

async function start(): Promise<void> {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/server.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, STATIC_DIR: dataDir, LOG_REQUESTS: '0' },
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

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

afterAll(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('server persistence', () => {
  it('keeps profiles, checkpoints and saves across a restart', async () => {
    await start();
    const created = await fetch(`${base}/api/profiles`, json('POST', { name: 'Persist Test' }));
    expect(created.status).toBe(201);
    const { id } = await created.json();

    expect((await fetch(`${base}/api/profiles/${id}/checkpoint`)).status).toBe(404);
    const state = { version: 1, t: 1234.5, aircraft: [{ id: 'AC1', callsign: 'TST1' }] };
    const summary = { title: 'Shift 1', score: 42 };
    expect((await fetch(`${base}/api/profiles/${id}/checkpoint`, json('PUT', { state, summary }))).status).toBe(200);
    expect((await fetch(`${base}/api/profiles/${id}/saves`, json('POST', { state, summary, label: 'Before storm' }))).status).toBe(201);
    expect((await fetch(`${base}/api/profiles`, json('POST', { name: 'Persist Test' }))).status).toBe(409);

    await stop();
    await start();

    const profiles = await (await fetch(`${base}/api/profiles`)).json();
    expect(profiles.map((p) => p.name)).toContain('Persist Test');
    const cp = await (await fetch(`${base}/api/profiles/${id}/checkpoint`)).json();
    expect(cp.state).toEqual(state);
    expect(cp.summary).toEqual(summary);
    const saves = await (await fetch(`${base}/api/profiles/${id}/saves`)).json();
    expect(saves.map((s) => s.label)).toEqual(['Before storm']);

    expect((await fetch(`${base}/api/profiles/${id}/checkpoint`, json('DELETE'))).status).toBe(204);
    expect((await fetch(`${base}/api/profiles/${id}/checkpoint`)).status).toBe(404);
  });

  it('rejects malformed input', async () => {
    if (!proc) await start();
    expect((await fetch(`${base}/api/profiles`, json('POST', { name: '<script>' }))).status).toBe(400);
    expect((await fetch(`${base}/api/profiles/999999/checkpoint`)).status).toBe(404);
    const bad = await fetch(`${base}/api/profiles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });
});
