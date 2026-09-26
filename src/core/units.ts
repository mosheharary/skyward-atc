// Units, conversions and small math helpers shared by sim, render and audio.
// Sim coordinates: x = east (m), y = north (m), altitude in feet MSL.
// Three.js world: X = east (m), Y = up (m above airport field elevation), Z = south (m) => Z = -y.

export const NM = 1852;
export const FT = 0.3048;
export const KT = 1852 / 3600;
export const G = 9.80665;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const wrap360 = (a: number): number => ((a % 360) + 360) % 360;
/** Signed shortest angular difference (b - a) in degrees, range (-180, 180]. */
export const angleDiff = (a: number, b: number): number => {
  let d = wrap360(b - a);
  if (d > 180) d -= 360;
  return d;
};
/** Compass bearing in degrees true from (x1,y1) to (x2,y2). */
export const bearing = (x1: number, y1: number, x2: number, y2: number): number =>
  wrap360(Math.atan2(x2 - x1, y2 - y1) * RAD);
export const dist = (x1: number, y1: number, x2: number, y2: number): number => Math.hypot(x2 - x1, y2 - y1);
/** Unit vector [east, north] for a compass heading in degrees. */
export const hdgVec = (hdg: number): [number, number] => [Math.sin(hdg * DEG), Math.cos(hdg * DEG)];
/** Exponential smoothing factor for frame-rate independent damping. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Convert sim coordinates to three.js world coordinates. */
export function simToWorld(x: number, y: number, altFt: number, fieldElevFt: number, out: XYZ = { x: 0, y: 0, z: 0 }): XYZ {
  out.x = x;
  out.y = (altFt - fieldElevFt) * FT;
  out.z = -y;
  return out;
}

/** Stable 32-bit string hash (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
