// Thin client for the persistence API served by the container (server/server.mjs).

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

export interface ProfileSummary {
  id: number;
  name: string;
  createdAt: number;
  lastPlayedAt: number;
  careerSummary: string | null;
  checkpoint: CheckpointSummary | null;
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

export interface Profile {
  id: number;
  name: string;
  createdAt: number;
  lastPlayedAt: number;
  settings: Partial<Settings>;
  career: Partial<CareerState> & { summary?: string };
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

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  health: () => req<{ ok: boolean; version: string }>('GET', '/api/health'),
  profiles: () => req<ProfileSummary[]>('GET', '/api/profiles'),
  createProfile: (name: string) => req<Profile>('POST', '/api/profiles', { name }),
  profile: (id: number) => req<Profile>('GET', `/api/profiles/${id}`),
  deleteProfile: (id: number) => req<void>('DELETE', `/api/profiles/${id}`),
  saveSettings: (id: number, s: Settings) => req<{ ok: boolean }>('PUT', `/api/profiles/${id}/settings`, s),
  saveCareer: (id: number, c: CareerState & { summary: string }) => req<{ ok: boolean }>('PUT', `/api/profiles/${id}/career`, c),
  checkpoint: (id: number) => req<{ summary: CheckpointSummary; state: WorldSnapshot; updatedAt: number }>('GET', `/api/profiles/${id}/checkpoint`),
  putCheckpoint: (id: number, state: WorldSnapshot, summary: CheckpointSummary) =>
    req<{ ok: boolean; updatedAt: number }>('PUT', `/api/profiles/${id}/checkpoint`, { state, summary }),
  /** Best-effort save while the page is closing. */
  beaconCheckpoint: (id: number, state: WorldSnapshot, summary: CheckpointSummary): boolean =>
    navigator.sendBeacon(`/api/profiles/${id}/checkpoint`, new Blob([JSON.stringify({ state, summary })], { type: 'application/json' })),
  deleteCheckpoint: (id: number) => req<void>('DELETE', `/api/profiles/${id}/checkpoint`),
  saves: (id: number) => req<SaveInfo[]>('GET', `/api/profiles/${id}/saves`),
  createSave: (id: number, label: string, state: WorldSnapshot, summary: CheckpointSummary) =>
    req<SaveInfo>('POST', `/api/profiles/${id}/saves`, { label, state, summary }),
  loadSave: (id: number, saveId: number) => req<SaveInfo & { state: WorldSnapshot }>('GET', `/api/profiles/${id}/saves/${saveId}`),
  deleteSave: (id: number, saveId: number) => req<void>('DELETE', `/api/profiles/${id}/saves/${saveId}`),
  postResult: (id: number, r: { shiftId: string; airport: string; score: number; stars: number; stats: unknown }) =>
    req<{ id: number }>('POST', `/api/profiles/${id}/results`, r),
  results: (id: number) => req<ResultInfo[]>('GET', `/api/profiles/${id}/results`),
};
