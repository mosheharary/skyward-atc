// Google sign-in (OAuth 2.0 authorization code flow with PKCE) and signed session cookies.
// Shared by the Node server and the Vercel function; uses only node:crypto and fetch.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'skyward_sid';
const OAUTH_COOKIE = 'skyward_oauth';
const SESSION_TTL = 30 * 24 * 3600; // seconds
const OAUTH_TTL = 10 * 60;
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export function authConfig(env = process.env) {
  return {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    sessionSecret: env.SESSION_SECRET || '',
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Never allowed on Vercel: a test-only shortcut that mints sessions without Google.
    testLogin: env.AUTH_TEST_LOGIN === '1' && !env.VERCEL,
  };
}

export const googleConfigured = (cfg) => Boolean(cfg.clientId && cfg.clientSecret && cfg.sessionSecret);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** `base64url(json).base64url(hmac)`; `exp` (seconds since epoch) is required. */
export function sign(payload, secret) {
  if (!secret) throw new Error('SESSION_SECRET is not set');
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verify(token, secret, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(body).digest('base64url'));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, path = '/', secure }) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax', secure ? 'Secure' : '']
    .filter(Boolean)
    .join('; ');
}

/** The public origin of this deployment: PUBLIC_URL, else the (proxy-forwarded) request host. */
export function baseUrl(req, cfg) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const h = req.headers;
  const first = (v) => String(v || '').split(',')[0].trim();
  const host = first(h['x-forwarded-host']) || first(h.host) || 'localhost';
  const proto = first(h['x-forwarded-proto']) || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

export function sessionFrom(req, cfg) {
  const s = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], cfg.sessionSecret);
  return s && Number.isInteger(s.pid) ? s : null;
}

export function sessionCookie(profile, cfg, secure) {
  const token = sign({ pid: profile.id, sub: profile.google_sub, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, cfg.sessionSecret);
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL, secure });
}

export const clearSessionCookie = (secure) => cookie(SESSION_COOKIE, '', { maxAge: 0, secure });

/** Step 1: build the Google consent URL and the short-lived cookie that carries state + PKCE verifier. */
export function startLogin(cfg, base) {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(GOOGLE_AUTH);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${base}/api/auth/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  const token = sign({ state, verifier, exp: Math.floor(Date.now() / 1000) + OAUTH_TTL }, cfg.sessionSecret);
  const secure = base.startsWith('https:');
  return {
    url: url.toString(),
    cookie: cookie(OAUTH_COOKIE, token, { maxAge: OAUTH_TTL, path: '/api/auth', secure }),
  };
}

export const clearOauthCookie = (secure) => cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/api/auth', secure });

/** Checks the claims of an ID token received directly from Google's token endpoint (OIDC Core §3.1.3.7). */
export function checkIdClaims(claims, clientId, now = Date.now()) {
  if (!claims || typeof claims !== 'object') throw new Error('No ID token claims');
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error(`Bad issuer ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('Token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('ID token expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('ID token has no subject');
  if (claims.email && claims.email_verified === false) throw new Error('Google email is not verified');
  return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : '', name: claims.given_name || claims.name || '' };
}

export function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed ID token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** Step 2: validate state, exchange the code and return the verified Google identity. */
export async function finishLogin(req, cfg, base, fetchImpl = fetch) {
  const url = new URL(req.url || '/', base);
  if (url.searchParams.get('error')) throw new Error(`Google returned ${url.searchParams.get('error')}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const pending = verify(parseCookies(req.headers.cookie)[OAUTH_COOKIE], cfg.sessionSecret);
  if (!code || !state || !pending) throw new Error('Missing code, state or login cookie');
  const a = Buffer.from(state);
  const b = Buffer.from(String(pending.state));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('State mismatch');
  const res = await fetchImpl(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: `${base}/api/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: pending.verifier,
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(`Token exchange failed (${res.status} ${data.error || ''})`);
  return checkIdClaims(decodeJwtPayload(data.id_token), cfg.clientId);
}

/** Display name derived from the Google profile, constrained to the profile-name rules. */
export function profileName(raw) {
  const name = String(raw || '')
    .replace(/[^\p{L}\p{N} _.'-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
  return name || 'Controller';
}
