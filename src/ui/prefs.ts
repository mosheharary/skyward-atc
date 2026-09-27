// Interface preferences: applies theme / scale / density to the document and formats values in the chosen units.

import type { Settings } from './api';
import { fmtAltitude } from '../sim/phraseology';

export const prefs = {
  clock24: true,
  units: 'ft' as Settings['units'],
  /** Effective interface scale (resolved from "Auto"). */
  scale: 1,
};

let lastSettings: Settings | null = null;

/** "Auto" scale: grow the HUD on large displays so the console keeps a comfortable density. */
export function autoScale(): number {
  const k = Math.min(window.innerWidth / 1680, window.innerHeight / 940);
  return Math.round(Math.min(1.4, Math.max(0.85, k)) * 20) / 20;
}

window.addEventListener('resize', () => {
  if (lastSettings && !lastSettings.uiScale) applyUiPrefs(lastSettings);
});

export function applyUiPrefs(s: Settings): void {
  lastSettings = s;
  const r = document.documentElement;
  prefs.scale = s.uiScale ? Math.min(1.5, Math.max(0.8, s.uiScale)) : autoScale();
  r.style.setProperty('--ui-scale', String(prefs.scale));
  r.dataset.theme = s.theme;
  r.dataset.density = s.density;
  r.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
  r.dataset.kbd = s.kbdHints ? 'on' : 'off';
  prefs.clock24 = s.clock24;
  prefs.units = s.units;
}

/** Simulation clock as HH:MM (or h:MM am/pm), optionally with seconds. */
export function clock(sec: number, withSec = false): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = withSec ? `:${String(s % 60).padStart(2, '0')}` : '';
  if (prefs.clock24) return `${String(hh).padStart(2, '0')}:${mm}${ss}`;
  return `${hh % 12 || 12}:${mm}${ss}${hh < 12 ? 'a' : 'p'}`;
}

/** Altitude in the display unit, e.g. "9,000" or "2,740". */
export function alt(ft: number): string {
  if (prefs.units === 'm') return (Math.round((ft * 0.3048) / 10) * 10).toLocaleString('en-US');
  return fmtAltitude(ft);
}

export function altUnit(): string {
  return prefs.units === 'm' ? 'm' : 'ft';
}

/** Minutes:seconds, e.g. 2:05. */
export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
