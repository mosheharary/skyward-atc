// Parametric fuselage model: cross-sections along the length, conforming patches (windows, decals).
import * as THREE from 'three';
import type { DoorDef, FuselageDef, WindowRow } from './shapes';
import { annulus, lathe, merge, orient, surface, samples } from './geom';

export const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Quarter-ellipse style ease: 0 at x=0, 1 at x>=1 with zero slope. p=0.5 is an exact ellipse. */
export const ease = (x: number, p: number): number => {
  if (x >= 1) return 1;
  if (x <= 0) return 0;
  return Math.pow(1 - (1 - x) * (1 - x), p);
};

export interface Station {
  hw: number;
  yWide: number;
  hUp: number;
  hDown: number;
}

export class FuselageModel {
  readonly f: FuselageDef;
  readonly L: number;
  readonly R: number;
  readonly H: number;
  readonly zNose: number;
  readonly zTail: number;
  /** Mean section radius used for texture arc-length mapping. */
  readonly arcR: number;
  /** Half circumference (m) represented by one texture side region. */
  readonly arc: number;
  private readonly e: number;
  private readonly st: Station = { hw: 0, yWide: 0, hUp: 0, hDown: 0 };

  constructor(f: FuselageDef) {
    this.f = f;
    this.L = f.length;
    this.R = f.radius;
    this.H = f.radius * f.hr;
    this.zNose = -f.mainGearFromNose;
    this.zTail = this.zNose + f.length;
    this.arcR = (this.R + this.H) / 2;
    this.arc = Math.PI * this.arcR;
    this.e = 2 / f.nExp;
  }

  station(dIn: number, out: Station = { hw: 0, yWide: 0, hUp: 0, hDown: 0 }): Station {
    const f = this.f;
    const d = Math.min(this.L, Math.max(0, dIn));
    const R = this.R;
    const H = this.H;
    const tipY = f.noseTipY * H;
    let hw = R * ease(d / f.nwLen, f.pw);
    let top = tipY + (H - tipY) * ease(d / f.ntLen, f.pt);
    let bot = tipY - (H + tipY) * ease(d / f.nbLen, f.pb);
    const e = this.L - d;
    if (e < f.tailLen) {
      const te = Math.max(0, e) / f.tailLen;
      const tc = f.tailTipY * H;
      const tr = f.tailTipR * R;
      const sTop = 1 - Math.pow(1 - te, 2.4);
      const sBot = 1 - Math.pow(1 - te, 1.55);
      const sW = 1 - Math.pow(1 - te, 1.9);
      top = Math.min(top, tc + tr + (H - tc - tr) * sTop);
      bot = Math.max(bot, tc - tr + (-H - (tc - tr)) * sBot);
      hw = Math.min(hw, tr + (R - tr) * sW);
    }
    let hump = 0;
    if (f.hump) {
      const h = f.hump;
      hump = h.height * smooth(h.start, h.full, d) * (1 - smooth(h.end, h.tail, d));
    }
    out.yWide = f.centerY + (top + bot) / 2;
    out.hDown = Math.max(1e-4, (top - bot) / 2);
    out.hUp = out.hDown + hump;
    out.hw = Math.max(1e-4, hw);
    return out;
  }

  /** Surface point. theta in radians (-PI/2 belly .. PI/2 crown); side +1 right (+X), -1 left. */
  point(d: number, theta: number, side: number, scale: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.station(d, this.st);
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const cx = Math.pow(Math.abs(c), this.e);
    const sy = Math.sign(sn) * Math.pow(Math.abs(sn), this.e);
    out.x = side * s.hw * cx * scale;
    out.y = s.yWide + (sn >= 0 ? s.hUp : s.hDown) * sy * scale;
    out.z = this.zNose + d;
    return out;
  }

  topY(d: number): number {
    const s = this.station(d, this.st);
    return s.yWide + s.hUp;
  }

  bottomY(d: number): number {
    const s = this.station(d, this.st);
    return s.yWide - s.hDown;
  }

  /** Cross-section angle (rad) at which the surface reaches height y (clamped). */
  thetaForY(d: number, y: number): number {
    const s = this.station(d, this.st);
    const h = y >= s.yWide ? s.hUp : s.hDown;
    const r = Math.min(1, Math.abs(y - s.yWide) / h);
    const sn = Math.pow(r, 1 / this.e);
    return Math.sign(y - s.yWide) * Math.asin(Math.min(1, sn));
  }

  /** Half width of the surface at height y. */
  halfWidthAtY(d: number, y: number): number {
    const th = this.thetaForY(d, y);
    const s = this.station(d, this.st);
    return s.hw * Math.pow(Math.abs(Math.cos(th)), this.e);
  }

  /** Arc length per radian of theta at a station (for converting metres to angles). */
  arcRate(d: number, theta: number): number {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const eps = 0.002;
    this.point(d, theta - eps, 1, 1, a);
    this.point(d, theta + eps, 1, 1, b);
    return a.distanceTo(b) / (2 * eps);
  }

  dAtZ(z: number): number {
    return z - this.zNose;
  }

  /** Texture Y (metres from crown) for a cross-section angle in radians. */
  texY(theta: number): number {
    return (Math.PI / 2 - theta) * this.arcR;
  }

  /** Stations clustered at nose and tail. */
  stationSamples(): number[] {
    const f = this.f;
    const L = this.L;
    const out: number[] = [];
    const noseEnd = Math.min(L * 0.45, Math.max(f.ntLen, f.nwLen, f.nbLen) * 1.05);
    const nn = 34;
    for (let i = 0; i <= nn; i++) out.push(noseEnd * Math.pow(i / nn, 1.7));
    const tailStart = L - f.tailLen;
    const mid = Math.max(2, Math.ceil((tailStart - noseEnd) / (L / 36)));
    for (let i = 1; i < mid; i++) out.push(noseEnd + ((tailStart - noseEnd) * i) / mid);
    const nt = 28;
    for (let i = 0; i <= nt; i++) out.push(tailStart + f.tailLen * (1 - Math.pow(1 - i / nt, 1.25)));
    if (f.hump) {
      for (let d = f.hump.start; d < f.hump.tail; d += 1.2) out.push(d);
    }
    const sorted = Array.from(new Set(out.map((d) => Math.round(d * 1000) / 1000))).sort((a, b) => a - b);
    return sorted.map((d) => d / L);
  }
}

/** Main fuselage skin (both halves) with livery UVs. */
export function buildFuselageSkin(fm: FuselageModel, nv = 40): THREE.BufferGeometry {
  const L = fm.L;
  const us = fm.stationSamples();
  const vs = samples(nv);
  const tmp = new THREE.Vector3();
  const st = { hw: 0, yWide: 0, hUp: 0, hDown: 0 };
  const halves: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const g = surface(
      (u, v, out) => {
        fm.point(u * L, -Math.PI / 2 + v * Math.PI, side, 1, out);
      },
      0,
      0,
      {
        us,
        vs,
        uv: (u, v, out) => {
          if (side > 0) out.set(1 - u, 0.5 + 0.5 * v);
          else out.set(u, 0.5 * (1 - v));
        },
      },
    );
    orient(g, (p, out) => {
      fm.station(fm.dAtZ(p.z), st);
      out.set(p.x, p.y - st.yWide, 0);
      if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
    });
    halves.push(g);
  }
  void tmp;
  return merge(halves);
}

/** Dark APU exhaust disc at the tail tip. */
export function buildApuCap(fm: FuselageModel): THREE.BufferGeometry {
  const s = fm.station(fm.L);
  const r = Math.min(s.hw, s.hDown) * 1.01;
  const cap = annulus(0, s.yWide, fm.zTail - 0.015, 0, r, 16, 1);
  const tube = lathe((t) => [fm.zTail - 0.2 + t * 0.19, r * 0.98], { cx: 0, cy: s.yWide, nT: 1, nPhi: 16, inward: true });
  return merge([cap, tube]);
}

export interface Seg {
  a: number;
  b: number;
  n: number;
}

/** Split a window row into segments avoiding doors; windows are centred in each segment. */
export function windowSegments(row: WindowRow, doors: DoorDef[]): Seg[] {
  const ex = doors
    .filter((d) => d.deck === row.deck && d.kind !== 'cargo')
    .map((d) => {
      const pad = d.kind === 'exit' ? 0.14 : 0.32;
      return [d.s - d.w / 2 - pad, d.s + d.w / 2 + pad] as [number, number];
    })
    .sort((p, q) => p[0] - q[0]);
  const segs: Seg[] = [];
  let cur = row.from;
  const push = (a: number, b: number) => {
    const n = Math.floor((b - a) / row.pitch + 1e-6);
    if (n < 1) return;
    const off = (b - a - n * row.pitch) / 2;
    segs.push({ a: a + off, b: a + off + n * row.pitch, n });
  };
  for (const [e0, e1] of ex) {
    if (e1 <= cur) continue;
    if (e0 >= row.to) break;
    push(cur, Math.min(e0, row.to));
    cur = Math.max(cur, e1);
  }
  if (cur < row.to) push(cur, row.to);
  return segs;
}

/** Angular half-extent (rad) of a band of height h (m) centred at theta. */
export function bandHalfAngle(fm: FuselageModel, d: number, theta: number, h: number): number {
  return h / 2 / Math.max(0.05, fm.arcRate(d, theta));
}

/** Conforming patch on one side of the fuselage. */
export function patch(
  fm: FuselageModel,
  side: number,
  d0: number,
  d1: number,
  th0: number,
  th1: number,
  scale: number,
  nu: number,
  nv: number,
  uv: (u: number, v: number, out: THREE.Vector2) => void,
): THREE.BufferGeometry {
  const g = surface(
    (u, v, out) => {
      fm.point(d0 + (d1 - d0) * u, th0 + (th1 - th0) * v, side, scale, out);
    },
    nu,
    nv,
    { uv },
  );
  const st = { hw: 0, yWide: 0, hUp: 0, hDown: 0 };
  return orient(g, (p, out) => {
    fm.station(fm.dAtZ(p.z), st);
    out.set(p.x, p.y - st.yWide, 0);
  });
}

/** Emissive cabin-window band (night) for all rows, both sides. UV.x repeats once per window. */
export function buildWindowBand(fm: FuselageModel, rows: WindowRow[], doors: DoorDef[], tileFrac: number): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const row of rows) {
    const theta = (row.theta * Math.PI) / 180;
    for (const seg of windowSegments(row, doors)) {
      const dm = (seg.a + seg.b) / 2;
      const half = bandHalfAngle(fm, dm, theta, row.h / tileFrac);
      for (const side of [1, -1]) {
        const nu = Math.max(2, Math.ceil((seg.b - seg.a) / 1.5));
        parts.push(
          patch(fm, side, seg.a, seg.b, theta - half, theta + half, 1.0 + 0.012 / fm.R, nu, 2, (u, v, out) => {
            out.set(u * seg.n, v);
          }),
        );
      }
    }
  }
  return parts.length ? merge(parts) : null;
}

/** Registration decal patches (left + right) near the tail. */
export function buildRegistrationPatch(fm: FuselageModel, thetaW: number): { geometry: THREE.BufferGeometry; aspect: number } {
  const D = fm.R * 2;
  const h = Math.max(0.28, Math.min(0.75, D * 0.1));
  const len = h * 5.4;
  const dc = fm.L - fm.f.tailLen * 0.78;
  const theta = ((thetaW + 11) * Math.PI) / 180;
  const half = bandHalfAngle(fm, dc, theta, h);
  const d0 = dc - len / 2;
  const d1 = dc + len / 2;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    parts.push(
      patch(fm, side, d0, d1, theta - half, theta + half, 1.0 + 0.01 / fm.R, 6, 2, (u, v, out) => {
        out.set(side > 0 ? 1 - u : u, v);
      }),
    );
  }
  return { geometry: merge(parts), aspect: len / h };
}

/** Wing-to-body fairing blister under the fuselage (low wing). */
export function buildBellyFairing(fm: FuselageModel, z0: number, z1: number, widthScale = 0.96): THREE.BufferGeometry {
  const st = { hw: 0, yWide: 0, hUp: 0, hDown: 0 };
  const g = surface(
    (u, v, out) => {
      const z = z0 + (z1 - z0) * u;
      fm.station(fm.dAtZ(z), st);
      const prof = Math.sin(Math.PI * u);
      const a = st.hw * widthScale * Math.pow(prof, 0.32);
      const yc = st.yWide - st.hDown * 0.5;
      const depth = (st.hDown * 0.5 + fm.R * 0.085) * Math.pow(prof, 0.55);
      const phi = -Math.PI - 0.35 + v * (Math.PI + 0.7);
      out.set(Math.cos(phi) * a, yc + Math.sin(phi) * depth, z);
    },
    28,
    28,
    { uv: (u, v, out) => out.set(u, v) },
  );
  return orient(g, (p, out) => {
    const zc = (z0 + z1) / 2;
    fm.station(fm.dAtZ(zc), st);
    out.set(p.x, p.y - (st.yWide - st.hDown * 0.5), 0);
  });
}

/** Landing-gear sponsons for high-wing turboprops. */
export function buildSponsons(fm: FuselageModel, z0: number, z1: number): THREE.BufferGeometry {
  const st = fm.station(fm.dAtZ((z0 + z1) / 2));
  const parts: THREE.BufferGeometry[] = [];
  const r = fm.R * 0.42;
  const cy = st.yWide - st.hDown * 0.62;
  for (const side of [1, -1]) {
    const cx = side * st.hw * 0.78;
    parts.push(
      lathe(
        (t) => {
          const z = z0 + (z1 - z0) * t;
          const prof = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.45);
          return [z, r * prof];
        },
        { cx, cy, nT: 24, nPhi: 20, scale: () => [1, 1.25] },
      ),
    );
  }
  return merge(parts);
}
