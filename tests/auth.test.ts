// @ts-nocheck -- plain .mjs module and node builtins without @types/node
import { describe, expect, it } from 'vitest';
import { checkIdClaims, finishLogin, parseCookies, profileName, sign, startLogin, verify } from '../server/auth.mjs';

const SECRET = 'unit-test-secret';
const CFG = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh', sessionSecret: SECRET, publicUrl: '', testLogin: false };
const future = () => Math.floor(Date.now() / 1000) + 600;
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('signed tokens', () => {
  it('round-trips and rejects tampering, other secrets and expiry', () => {
    const t = sign({ pid: 7, exp: future() }, SECRET);
    expect(verify(t, SECRET).pid).toBe(7);
    expect(verify(t, 'other-secret')).toBeNull();
    expect(verify(t.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), SECRET)).toBeNull();
    expect(verify(sign({ pid: 7, exp: 1 }, SECRET), SECRET)).toBeNull();
    expect(verify('nonsense', SECRET)).toBeNull();
    expect(() => sign({ exp: future() }, '')).toThrow();
  });
});

describe('Google ID token claims', () => {
  const good = { iss: 'https://accounts.google.com', aud: CFG.clientId, exp: future(), sub: '1234', email: 'a@b.c', email_verified: true, given_name: 'Ada' };
  it('accepts a valid token', () => {
    expect(checkIdClaims(good, CFG.clientId)).toEqual({ sub: '1234', email: 'a@b.c', name: 'Ada' });
  });
  it('rejects wrong issuer, audience, expiry, subject and unverified email', () => {
    expect(() => checkIdClaims({ ...good, iss: 'https://evil.example' }, CFG.clientId)).toThrow();
    expect(() => checkIdClaims({ ...good, aud: 'someone-else' }, CFG.clientId)).toThrow();
    expect(() => checkIdClaims({ ...good, exp: 10 }, CFG.clientId)).toThrow();
    expect(() => checkIdClaims({ ...good, sub: '' }, CFG.clientId)).toThrow();
    expect(() => checkIdClaims({ ...good, email_verified: false }, CFG.clientId)).toThrow();
  });
});

describe('authorization code flow', () => {
  const base = 'https://skyward.example';

  function callbackReq(state: string, oauthCookie: string) {
    return { url: `/api/auth/callback?code=the-code&state=${state}`, headers: { cookie: oauthCookie.split(';')[0] } };
  }

  it('exchanges the code with the PKCE verifier and returns the identity', async () => {
    const { url, cookie } = startLogin(CFG, base);
    const state = new URL(url).searchParams.get('state');
    let sent = null;
    const fetchImpl = async (u, init) => {
      sent = { u, body: new URLSearchParams(init.body) };
      return { ok: true, status: 200, json: async () => ({ id_token: jwt({ iss: 'accounts.google.com', aud: CFG.clientId, exp: future(), sub: 'g-1', email: 'x@y.z', email_verified: true, name: 'X Y' }) }) };
    };
    const who = await finishLogin(callbackReq(state, cookie), CFG, base, fetchImpl);
    expect(who).toEqual({ sub: 'g-1', email: 'x@y.z', name: 'X Y' });
    expect(sent.u).toBe('https://oauth2.googleapis.com/token');
    expect(sent.body.get('code')).toBe('the-code');
    expect(sent.body.get('redirect_uri')).toBe(`${base}/api/auth/callback`);
    const verifier = verify(parseCookies(cookie.split(';')[0]).skyward_oauth, SECRET).verifier;
    expect(sent.body.get('code_verifier')).toBe(verifier);
  });

  it('refuses a mismatched state without calling Google', async () => {
    const { cookie } = startLogin(CFG, base);
    let called = false;
    const fetchImpl = async () => ((called = true), { ok: true, json: async () => ({}) });
    await expect(finishLogin(callbackReq('forged', cookie), CFG, base, fetchImpl)).rejects.toThrow(/State/);
    expect(called).toBe(false);
  });

  it('surfaces token endpoint errors', async () => {
    const { url, cookie } = startLogin(CFG, base);
    const state = new URL(url).searchParams.get('state');
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) });
    await expect(finishLogin(callbackReq(state, cookie), CFG, base, fetchImpl)).rejects.toThrow(/invalid_grant/);
  });
});

describe('profile names', () => {
  it('keeps names within the profile-name rules', () => {
    expect(profileName('Ada Lovelace')).toBe('Ada Lovelace');
    expect(profileName('<b>Bob</b> 🚀')).toBe('bBobb');
    expect(profileName('')).toBe('Controller');
    expect(profileName('x'.repeat(40))).toHaveLength(24);
  });
});
