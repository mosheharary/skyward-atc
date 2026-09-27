// Thin client for the persistence API (server/api-core.mjs). Every call acts on the signed-in user's own profile.

import type { CareerState } from '../sim/career';
import type { WorldSnapshot } from '../sim/world';

export interface CheckpointSummary {
  airport: string;
  mode: 'career' | 'free';
  shiftId: string | null;
  title: string;
  score: number;
  simTime: number;
  remaining: number | null;
  savedAt: number;
}

export interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  master: number;
  engines: number;
  radio: number;
  ambience: number;
  music: number;
  ui: number;
  pilotVoices: boolean;
  controllerVoice: boolean;
  labels3d: boolean;
  autosaveSec: number;
  // ---- interface
  /** Root font scale for the whole HUD (0.8–1.5); 0 = automatic from the window size. */
  uiScale: number;
  theme: 'console' | 'contrast';
  density: 'comfortable' | 'compact';
  reducedMotion: boolean;
  clock24: boolean;
  /** Display units for altitudes in strips and the command panel (the radar always shows hundreds of feet). */
  units: 'ft' | 'm';
  kbdHints: boolean;
  pauseOnBlur: boolean;
  /** 3D label cut-off distance in metres. */
  labelDistance: number;
  // ---- radar
  /** Default range in NM when a session starts; 0 = fit the airspace. */
  radarRange: number;
  radarRings: boolean;
  radarFixes: boolean;
  radarWater: boolean;
  radarIls: boolean;
  radarBlocks: boolean;
  /** History dots per target (0–12). */
  radarTrail: number;
  /** Predicted track vector length in seconds (0, 60, 120). */
  radarVector: number;
  radarFont: number;
  // ---- layout (px)
  stripsW: number;
  rightW: number;
  commsH: number;
  commsCollapsed: boolean;
  stripsCollapsed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  master: 0.8,
  engines: 0.8,
  radio: 0.9,
  ambience: 0.6,
  music: 0.4,
  ui: 0.7,
  pilotVoices: true,
  controllerVoice: true,
  labels3d: true,
  autosaveSec: 20,
  uiScale: 0,
  theme: 'console',
  density: 'comfortable',
  reducedMotion: false,
  clock24: true,
  units: 'ft',
  kbdHints: true,
  pauseOnBlur: false,
  labelDistance: 25000,
  radarRange: 0,
  radarRings: true,
  radarFixes: true,
  radarWater: true,
  radarIls: true,
  radarBlocks: true,
  radarTrail: 6,
  radarVector: 60,
  radarFont: 11,
  stripsW: 272,
  rightW: 384,
  commsH: 156,
  commsCollapsed: false,
  stripsCollapsed: false,
};

/** The signed-in Google account's player profile. */
export interface Profile {
  id: number;
  name: string;
  email: string;
  createdAt: number;
  lastPlayedAt: number;
  settings: Partial<Settings>;
  career: Partial<CareerState> & { summary?: string };
  checkpoint: CheckpointSummary | null;
}

export interface SaveInfo {
  id: number;
  label: string;
  summary: CheckpointSummary;
  createdAt: number;
  updatedAt: number;
}

export interface ResultInfo {
  id: number;
  shiftId: string;
  airport: string;
  score: number;
  stars: number;
  completedAt: number;
}

/** Thrown when the session is missing or expired (HTTP 401). */
export class AuthError extends Error {}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  const msg = (data as { error?: string }).error ?? `HTTP ${r.status}`;
  if (r.status === 401) throw new AuthError(msg);
  if (!r.ok) throw new Error(msg);
  return data as T;
}

/** Full-page navigation to Google's consent screen; the server redirects back to `/`. */
export const LOGIN_URL = '/api/auth/login';

export const api = {
  health: () => req<{ ok: boolean; version: string; auth: boolean }>('GET', '/api/health'),
  me: () => req<Profile>('GET', '/api/me'),
  logout: () => req<void>('POST', '/api/auth/logout'),
  deleteAccount: () => req<void>('DELETE', '/api/me'),
  saveSettings: (s: Settings) => req<{ ok: boolean }>('PUT', '/api/me/settings', s),
  saveCareer: (c: CareerState & { summary: string }) => req<{ ok: boolean }>('PUT', '/api/me/career', c),
  checkpoint: () => req<{ summary: CheckpointSummary; state: WorldSnapshot; updatedAt: number }>('GET', '/api/me/checkpoint'),
  putCheckpoint: (state: WorldSnapshot, summary: CheckpointSummary) =>
    req<{ ok: boolean; updatedAt: number }>('PUT', '/api/me/checkpoint', { state, summary }),
  /** Best-effort save while the page is closing. */
  beaconCheckpoint: (state: WorldSnapshot, summary: CheckpointSummary): boolean =>
    navigator.sendBeacon('/api/me/checkpoint', new Blob([JSON.stringify({ state, summary })], { type: 'application/json' })),
  deleteCheckpoint: () => req<void>('DELETE', '/api/me/checkpoint'),
  saves: () => req<SaveInfo[]>('GET', '/api/me/saves'),
  createSave: (label: string, state: WorldSnapshot, summary: CheckpointSummary) =>
    req<SaveInfo>('POST', '/api/me/saves', { label, state, summary }),
  loadSave: (saveId: number) => req<SaveInfo & { state: WorldSnapshot }>('GET', `/api/me/saves/${saveId}`),
  deleteSave: (saveId: number) => req<void>('DELETE', `/api/me/saves/${saveId}`),
  postResult: (r: { shiftId: string; airport: string; score: number; stars: number; stats: unknown }) =>
    req<{ id: number }>('POST', '/api/me/results', r),
  results: () => req<ResultInfo[]>('GET', '/api/me/results'),
};
