// Small geometry helpers used by the airport data files to lay out runways,
// taxiways and gates relative to runway frames instead of raw coordinates.

import { DEG } from '../../core/units';
import type { ApproachLights, GateDef, RunwayDef, RunwayEndDef, TaxiwayDef, TaxiKind, Vec2 } from './types';
import type { SizeClass } from '../types';

export const NM_M = 1852;

export const nm = (x: number, y: number): Vec2 => [x * NM_M, y * NM_M];

/** Point at a compass bearing / distance (NM) from an origin. */
export const polar = (brg: number, distNm: number, origin: Vec2 = [0, 0]): Vec2 => [
  origin[0] + Math.sin(brg * DEG) * distNm * NM_M,
  origin[1] + Math.cos(brg * DEG) * distNm * NM_M,
];

export interface Frame {
  a: Vec2;
  b: Vec2;
  hdg: number;
  len: number;
  dir: Vec2;
  right: Vec2;
}

/** A runway-aligned frame: origin at threshold `a`, +d along `hdg`, +lat to the right. */
export function frame(a: Vec2, hdg: number, len: number): Frame {
  const dir: Vec2 = [Math.sin(hdg * DEG), Math.cos(hdg * DEG)];
  const right: Vec2 = [dir[1], -dir[0]];
  return { a, b: [a[0] + dir[0] * len, a[1] + dir[1] * len], hdg, len, dir, right };
}

export function at(f: Frame, d: number, lat = 0): Vec2 {
  return [f.a[0] + f.dir[0] * d + f.right[0] * lat, f.a[1] + f.dir[1] * d + f.right[1] * lat];
}

/** Heading of the frame rotated by `delta` degrees. */
export const hdgOf = (f: Frame, delta = 0): number => (((f.hdg + delta) % 360) + 360) % 360;

export function end(name: string, ils: boolean, approachLights: ApproachLights = 'full', papi = true): RunwayEndDef {
  return { name, ils, approachLights, papi };
}

export function runway(f: Frame, width: number, e0: RunwayEndDef, e1: RunwayEndDef): RunwayDef {
  return { a: f.a, b: f.b, width, ends: [e0, e1] };
}

export function path(name: string, points: Vec2[], kind: TaxiKind = 'taxiway', width = 23): TaxiwayDef {
  return { name, points, kind, width };
}

/** Taxiway parallel to a runway frame at lateral offset `lat`, from d0 to d1. */
export function parallel(name: string, f: Frame, lat: number, d0: number, d1: number, width = 23): TaxiwayDef {
  return path(name, [at(f, d0, lat), at(f, d1, lat)], 'taxiway', width);
}

/** Straight connector perpendicular to the frame at distance d from lat0 to lat1. */
export function connector(name: string, f: Frame, d: number, lat0: number, lat1: number, width = 23): TaxiwayDef {
  return path(name, [at(f, d, lat0), at(f, d, lat1)], 'taxiway', width);
}

/**
 * High-speed exit leaving the centreline at distance d, turning `angle` degrees towards lateral
 * offset latEnd. `reverse` = for aircraft landing in the opposite direction of the frame.
 */
export function rapidExit(name: string, f: Frame, d: number, latEnd: number, reverse = false, angle = 30): TaxiwayDef {
  const run = Math.abs(latEnd) / Math.tan(angle * DEG);
  const s = reverse ? -1 : 1;
  // Gentle first segment (~11 deg) then the main turn-off, so the exit peels away smoothly.
  return path(name, [at(f, d, 0), at(f, d + s * run * 0.3, latEnd * 0.1), at(f, d + s * run, latEnd)], 'rapid', 23);
}

/** A row of gates along a line. Positions are the nose stop points. */
export function gateRow(
  prefix: string,
  firstNumber: number,
  points: Vec2[],
  hdg: number,
  sizes: SizeClass[],
  jetBridge: boolean,
): GateDef[] {
  return points.map((pos, i) => ({
    id: `${prefix}${firstNumber + i}`,
    pos,
    hdg,
    size: sizes[Math.min(i, sizes.length - 1)],
    jetBridge,
  }));
}
