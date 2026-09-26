// ICAO-style phraseology helpers: every message has a display text and a spoken text.

import type { WakeCat } from './types';

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const LETTER_WORDS: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel',
  I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa',
  Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey',
  X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

export interface Phrase {
  text: string;
  speech: string;
}

export const digits = (s: string | number): string =>
  String(s)
    .split('')
    .map((c) => (c >= '0' && c <= '9' ? DIGIT_WORDS[+c] : LETTER_WORDS[c.toUpperCase()] ?? c))
    .join(' ');

export const letter = (c: string): string => LETTER_WORDS[c.toUpperCase()] ?? c;

export function sayHeading(h: number): string {
  const v = Math.round(h) % 360 || 360;
  return digits(String(v).padStart(3, '0'));
}

export function fmtHeading(h: number): string {
  const v = Math.round(h) % 360 || 360;
  return String(v).padStart(3, '0');
}

export function sayAltitude(ft: number): string {
  const a = Math.round(ft / 100) * 100;
  const th = Math.floor(a / 1000);
  const hu = Math.round((a % 1000) / 100);
  const parts: string[] = [];
  if (th > 0) parts.push(`${th >= 10 ? digits(th) : DIGIT_WORDS[th]} thousand`);
  if (hu > 0) parts.push(`${DIGIT_WORDS[hu]} hundred`);
  return parts.join(' ') || 'zero';
}

export const fmtAltitude = (ft: number): string => `${Math.round(ft / 100) * 100}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const saySpeed = (kt: number): string => digits(Math.round(kt));

export function sayRunway(name: string): string {
  const m = /^(\d{2})([LRC]?)$/.exec(name);
  if (!m) return name;
  const side = m[2] === 'L' ? ' left' : m[2] === 'R' ? ' right' : m[2] === 'C' ? ' center' : '';
  return `${digits(m[1])}${side}`;
}

export function sayTaxiway(name: string): string {
  return name
    .split('')
    .map((c) => (c >= '0' && c <= '9' ? DIGIT_WORDS[+c] : letter(c)))
    .join(' ');
}

export function sayFix(id: string): string {
  // Five-letter fixes are pronounceable names.
  return id.charAt(0) + id.slice(1).toLowerCase();
}

export interface CallsignParts {
  telephony: string;
  flightNumber: string;
  wake: WakeCat;
}

export function callsignSpeech(c: CallsignParts): string {
  const name = c.telephony.charAt(0) + c.telephony.slice(1).toLowerCase();
  const num = digits(c.flightNumber);
  const suffix = c.wake === 'H' ? ' heavy' : c.wake === 'J' ? ' super' : '';
  return `${name} ${num}${suffix}`;
}

export function callsignText(c: CallsignParts): string {
  const name = c.telephony.charAt(0) + c.telephony.slice(1).toLowerCase();
  const suffix = c.wake === 'H' ? ' Heavy' : c.wake === 'J' ? ' Super' : '';
  return `${name} ${c.flightNumber}${suffix}`;
}

export function sayWind(dir: number, kt: number, gust = 0): string {
  if (kt < 3) return 'wind calm';
  const g = gust > kt + 5 ? ` gusting ${digits(Math.round(gust))}` : '';
  return `wind ${sayHeading(Math.round(dir / 10) * 10)} at ${digits(Math.round(kt))}${g}`;
}

export function fmtWind(dir: number, kt: number, gust = 0): string {
  if (kt < 3) return 'Calm';
  const g = gust > kt + 5 ? `G${Math.round(gust)}` : '';
  return `${fmtHeading(Math.round(dir / 10) * 10)}/${Math.round(kt)}${g}`;
}

export const ATIS_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
