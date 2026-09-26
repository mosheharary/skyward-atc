// Lifting surfaces: wings (with flaps / spoilers / slats), stabilisers, fin, winglets, pylons.
import * as THREE from 'three';
import type { EngineDef, ShapeDef, TailDef, WingDef } from './shapes';
import type { FuselageModel } from './fuselage';
import { smooth } from './fuselage';
import { lathe, merge, mirrorX, orient, orientVertex, surface, samples } from './geom';

const DEG = Math.PI / 180;

/** NACA 4-digit half-thickness distribution for unit t/c (returns t/2 at max). */
export function thick(xc: number): number {
  const x = Math.min(1, Math.max(0, xc));
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

export function camberLine(xc: number, m: number, p = 0.4): number {
  if (m === 0) return 0;
  const x = Math.min(1, Math.max(0, xc));
  return x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
}

export interface Planform {
  /** Spanwise extent (x for wings / stabs). */
  x0: number;
  x1: number;
  chord(x: number): number;
  leZ(x: number): number;
  y(x: number): number;
  tc(x: number): number;
  /** Thickness multiplier for tip rounding (1 inboard, 0 at the very tip). */
  round(x: number): number;
  camber: number;
}

export function airfoilPoint(pf: Planform, x: number, xc: number, upper: boolean, out: THREE.Vector3, tMul = 1, leShift = 0, yOff = 0): THREE.Vector3 {
  const c = pf.chord(x);
  const t = pf.tc(x) * pf.round(x) * tMul;
  const yc = camberLine(xc, pf.camber) * c;
  const yt = thick(xc) * t * c;
  out.set(x, pf.y(x) + yc + (upper ? yt : -yt) + yOff, pf.leZ(x) - leShift + xc * (c + leShift));
  return out;
}

function spanSamples(x0: number, x1: number, breaks: number[], n: number, tipDense = false): number[] {
  const pts = new Set<number>();
  for (let i = 0; i <= n; i++) {
    let t = i / n;
    if (tipDense) t = 1 - Math.pow(1 - t, 1.6);
    pts.add(x0 + (x1 - x0) * t);
  }
  for (const b of breaks) if (b > x0 && b < x1) pts.add(b);
  return Array.from(pts)
    .sort((a, b) => a - b)
    .map((x) => (x - x0) / (x1 - x0));
}

/** Closed airfoil wrap (TE upper -> LE -> TE lower) over the chord range [0, c1]. */
function wrapSurface(pf: Planform, xa: number, xb: number, c1: number, us: number[], nChord: number, tMul = 1, leShift = 0): THREE.BufferGeometry {
  const g = surface(
    (u, v, out) => {
      const x = xa + (xb - xa) * u;
      const phi = v * Math.PI * 2;
      const xn = (1 + Math.cos(phi)) / 2;
      airfoilPoint(pf, x, xn * c1, v < 0.5, out, tMul, leShift);
    },
    0,
    nChord,
    {
      us,
      uv: (u, v, out) => {
        const x = xa + (xb - xa) * u;
        const xn = (1 + Math.cos(v * Math.PI * 2)) / 2;
        out.set(xn * c1, x / 4);
      },
    },
  );
  return orient(g, (p, out) => {
    const x = p.x;
    const c = pf.chord(x);
    out.set(0, p.y - pf.y(x), p.z - (pf.leZ(x) + c * c1 * 0.45));
  });
}

/** Upper or lower surface strip over the chord range [c0, c1]. */
function strip(pf: Planform, xa: number, xb: number, c0: number, c1: number, upper: boolean, us: number[], nChord: number, tMul = 1, yOff = 0): THREE.BufferGeometry {
  const g = surface(
    (u, v, out) => {
      const x = xa + (xb - xa) * u;
      airfoilPoint(pf, x, c0 + (c1 - c0) * v, upper, out, tMul, 0, yOff);
    },
    0,
    nChord,
    {
      us,
      uv: (u, v, out) => out.set(c0 + (c1 - c0) * v, (xa + (xb - xa) * u) / 4),
    },
  );
  const s = upper ? 1 : -1;
  return orient(g, (_p, out) => out.set(0, s, 0));
}

/** Vertical face between lower and upper surface at chord station xc (spanwise strip). */
function chordFace(pf: Planform, xa: number, xb: number, xc: number, us: number[], facing: 1 | -1): THREE.BufferGeometry {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const g = surface(
    (u, v, out) => {
      const x = xa + (xb - xa) * u;
      airfoilPoint(pf, x, xc, false, a);
      airfoilPoint(pf, x, xc, true, b);
      out.lerpVectors(a, b, v);
    },
    0,
    1,
    { us },
  );
  return orient(g, (_p, out) => out.set(0, 0, facing));
}

/** Flat section cap at span station x between chord c0..c1. facing: +1 outboard (+x), -1 inboard. */
function sectionCap(pf: Planform, x: number, c0: number, c1: number, facing: 1 | -1): THREE.BufferGeometry {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const g = surface(
    (u, v, out) => {
      const xc = c0 + (c1 - c0) * u;
      airfoilPoint(pf, x, xc, false, a);
      airfoilPoint(pf, x, xc, true, b);
      out.lerpVectors(a, b, v);
    },
    10,
    1,
  );
  return orient(g, (_p, out) => out.set(facing, 0, 0));
}

export class WingModel implements Planform {
  readonly def: WingDef;
  readonly x0: number;
  readonly x1: number;
  readonly b: number;
  readonly xk: number;
  readonly xa: number;
  readonly xRake: number;
  readonly yr: number;
  readonly zr: number;
  readonly camber = 0.022;
  private readonly tanS: number;
  private readonly tanD: number;
  private readonly tanRake: number;
  readonly rTip: number;
  private readonly cRakeEnd: number;

  constructor(def: WingDef, span: number, fm: FuselageModel, gearX: number, gearZ: number) {
    this.def = def;
    const wingletOut = def.tip === 'sharklet' || def.tip === 'blended' || def.tip === 'curved' || def.tip === 'small' ? def.wingletH * 0.12 : 0;
    this.b = span / 2 - wingletOut;
    this.x1 = this.b;
    this.x0 = fm.R * (def.high ? 0.2 : 0.45);
    this.xk = this.b * def.kinkFrac;
    this.xa = this.b * def.aileronFrac;
    this.xRake = def.tip === 'raked' ? this.b * (def.rakeFrac ?? 0.9) : this.b;
    this.tanS = Math.tan(def.sweep * DEG);
    this.tanD = Math.tan(def.dihedral * DEG);
    this.tanRake = Math.tan((def.rakeSweep ?? def.sweep) * DEG);
    this.cRakeEnd = def.tipChord * 0.3;
    this.rTip = Math.min(def.tipChord * 0.35, 0.5);
    const H = fm.H;
    this.yr = def.high ? fm.f.centerY + 0.93 * H : fm.f.centerY - 0.62 * H;
    const cg = this.chord(gearX);
    this.zr = gearZ - def.gearChordFrac * cg - (gearX - this.x0) * this.tanS;
  }

  chord(x: number): number {
    const d = this.def;
    if (x <= this.xk) return d.rootChord + (d.kinkChord - d.rootChord) * ((x - this.x0) / Math.max(1e-6, this.xk - this.x0));
    if (x <= this.xRake) {
      const cAt = (xx: number) => d.kinkChord + (d.tipChord - d.kinkChord) * ((xx - this.xk) / Math.max(1e-6, this.b - this.xk));
      return cAt(x);
    }
    const cR = d.kinkChord + (d.tipChord - d.kinkChord) * ((this.xRake - this.xk) / Math.max(1e-6, this.b - this.xk));
    const t = (x - this.xRake) / Math.max(1e-6, this.b - this.xRake);
    return cR + (this.cRakeEnd - cR) * Math.pow(t, 0.8);
  }

  leZ(x: number): number {
    if (x <= this.xRake) return this.zr + (x - this.x0) * this.tanS;
    return this.zr + (this.xRake - this.x0) * this.tanS + (x - this.xRake) * this.tanRake;
  }

  y(x: number): number {
    return this.yr + (x - this.x0) * this.tanD;
  }

  tc(x: number): number {
    const t = Math.min(1, Math.max(0, (x - this.x0) / (this.b - this.x0)));
    return this.def.tcRoot + (this.def.tcTip - this.def.tcRoot) * t;
  }

  round(x: number): number {
    const s = x - (this.b - this.rTip);
    if (s <= 0) return 1;
    const q = Math.min(1, s / this.rTip);
    return Math.sqrt(Math.max(0, 1 - q * q));
  }

  lowerY(x: number, xc: number): number {
    return airfoilPoint(this, x, xc, false, new THREE.Vector3()).y;
  }

  upperY(x: number, xc: number): number {
    return airfoilPoint(this, x, xc, true, new THREE.Vector3()).y;
  }
}

export interface HingedPart {
  geometry: THREE.BufferGeometry;
  /** Hinge point in model space (geometry is relative to it). */
  pivot: THREE.Vector3;
  /** Hinge axis (unit, x component > 0: positive angle moves the trailing edge down). */
  axis: THREE.Vector3;
  /** Translation at full deployment (model space). */
  travel: THREE.Vector3;
  maxAngle: number;
}

export interface WingBuild {
  wing: THREE.BufferGeometry;
  /** Bare-metal leading-edge slats (retracted position), or null. */
  slats: THREE.BufferGeometry | null;
  slatTravel: THREE.Vector3;
  flaps: HingedPart[];
  spoilers: HingedPart[];
  winglets: THREE.BufferGeometry | null;
  model: WingModel;
}

function hinged(
  geoms: THREE.BufferGeometry[],
  pivot: THREE.Vector3,
  p2: THREE.Vector3,
  travel: THREE.Vector3,
  maxAngle: number,
  mirror: boolean,
): HingedPart {
  let g = merge(geoms);
  let pv = pivot.clone();
  let q2 = p2.clone();
  let tr = travel.clone();
  if (mirror) {
    g = mirrorX(g);
    pv.x = -pv.x;
    q2.x = -q2.x;
    tr = tr.clone();
    tr.x = -tr.x;
  }
  const axis = new THREE.Vector3().subVectors(q2, pv).normalize();
  if (axis.x < 0) axis.negate();
  g.translate(-pv.x, -pv.y, -pv.z);
  return { geometry: g, pivot: pv, axis, travel: tr, maxAngle };
}

export function buildWing(shape: ShapeDef, fm: FuselageModel, span: number, gearX: number, gearZ: number): WingBuild {
  const def = shape.wing;
  const wm = new WingModel(def, span, fm, gearX, gearZ);
  const hasFlaps = true;
  const flapC = 0.72;
  const breaks = [wm.xk, wm.xa, wm.xRake, wm.b - wm.rTip];
  const nChord = 30;
  const rightParts: THREE.BufferGeometry[] = [];

  // inboard box with flap cut-out
  const usIn = spanSamples(wm.x0, wm.xa, breaks, 10);
  rightParts.push(wrapSurface(wm, wm.x0, wm.xa, flapC, usIn, nChord));
  rightParts.push(chordFace(wm, wm.x0, wm.xa, flapC, usIn, 1));
  // outboard (aileron) box, full chord, dense near the tip
  const usOut = spanSamples(wm.xa, wm.b, breaks, 16, true);
  rightParts.push(wrapSurface(wm, wm.xa, wm.b, 1, usOut, nChord));
  rightParts.push(sectionCap(wm, wm.xa, flapC, 1, -1));

  // flap track fairings
  if (def.flapTracks > 0) {
    for (let i = 0; i < def.flapTracks; i++) {
      const x = wm.x0 + fm.R * 0.8 + ((wm.xa - wm.x0 - fm.R * 0.8) * (i + 0.8)) / (def.flapTracks + 0.3);
      const c = wm.chord(x);
      const z0 = wm.leZ(x) + 0.52 * c;
      const z1 = wm.leZ(x) + 1.2 * c;
      const rf = Math.max(0.12, 0.055 * c);
      const cy = wm.lowerY(x, 0.8) - rf * 0.45;
      rightParts.push(
        lathe(
          (t) => [z0 + (z1 - z0) * t, rf * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.55) + 1e-3],
          { cx: x, cy, nT: 14, nPhi: 12, scale: () => [0.6, 1] },
        ),
      );
    }
  }

  const wing = merge([merge(rightParts), mirrorX(merge(rightParts))]);

  // flaps
  const flaps: HingedPart[] = [];
  if (hasFlaps) {
    const flapSpans: [number, number][] = [
      [fm.R * 0.98, wm.xk],
      [wm.xk, wm.xa - 0.04],
    ];
    for (const [xa, xb] of flapSpans) {
      if (xb - xa < 0.3) continue;
      const us = spanSamples(xa, xb, [], 6);
      const parts = [
        strip(wm, xa, xb, flapC, 1, true, us, 12),
        strip(wm, xa, xb, flapC, 1, false, us, 12),
        chordFace(wm, xa, xb, flapC, us, -1),
        sectionCap(wm, xa, flapC, 1, -1),
        sectionCap(wm, xb, flapC, 1, 1),
      ];
      const cMean = (wm.chord(xa) + wm.chord(xb)) / 2;
      const h1 = airfoilPoint(wm, xa, 0.74, false, new THREE.Vector3());
      h1.y -= 0.035 * wm.chord(xa);
      const h2 = airfoilPoint(wm, xb, 0.74, false, new THREE.Vector3());
      h2.y -= 0.035 * wm.chord(xb);
      const travel = new THREE.Vector3(0, -0.02 * cMean, 0.12 * cMean);
      const maxAngle = shape.engine.kind === 'prop' ? 30 * DEG : 36 * DEG;
      flaps.push(hinged(parts, h1, h2, travel, maxAngle, false));
      flaps.push(hinged(parts.map((p) => p.clone()), h1, h2, travel, maxAngle, true));
    }
  }

  // spoilers (jets only)
  const spoilers: HingedPart[] = [];
  if (shape.engine.kind === 'fan' && shape.id !== 'C56X') {
    const spans: [number, number][] = [
      [fm.R * 1.08, wm.xk * 0.96],
      [wm.xk * 1.03, wm.xa * 0.97],
    ];
    for (const [xa, xb] of spans) {
      if (xb - xa < 0.3) continue;
      const us = spanSamples(xa, xb, [], 5);
      const top = strip(wm, xa, xb, 0.56, flapC - 0.005, true, us, 6, 1, 0.012);
      const under = orient(strip(wm, xa, xb, 0.56, flapC - 0.005, true, us, 6, 1, 0.004), (_p, out) => out.set(0, -1, 0));
      const h1 = airfoilPoint(wm, xa, 0.56, true, new THREE.Vector3());
      const h2 = airfoilPoint(wm, xb, 0.56, true, new THREE.Vector3());
      spoilers.push(hinged([top, under], h1, h2, new THREE.Vector3(), 48 * DEG, false));
      spoilers.push(hinged([top.clone(), under.clone()], h1, h2, new THREE.Vector3(), 48 * DEG, true));
    }
  }

  // slats (bare metal leading edge shells)
  let slats: THREE.BufferGeometry | null = null;
  const slatTravel = new THREE.Vector3();
  if (def.slats) {
    const xa = fm.R * 1.05;
    const xb = wm.b - wm.rTip * 1.3;
    const us = spanSamples(xa, xb, [wm.xk, wm.xRake], 12);
    const shell = wrapSurface(wm, xa, xb, 0.13, us, 18, 1.06, 0.006 * def.rootChord);
    const back = chordFace(wm, xa, xb, 0.13, us, 1);
    const r = merge([shell, back]);
    slats = merge([r, mirrorX(r)]);
    const cMean = (wm.chord(xa) + wm.chord(xb)) / 2;
    slatTravel.set(0, -0.04 * cMean, -0.075 * cMean);
  }

  const winglets = buildWinglets(wm);
  return { wing, slats, slatTravel, flaps, spoilers, winglets, model: wm };
}

/** Winglet / sharklet / fence surfaces (both sides). */
function buildWinglets(wm: WingModel): THREE.BufferGeometry | null {
  const def = wm.def;
  if (def.tip === 'none' || def.tip === 'raked' || def.wingletH <= 0) return null;
  const xT = wm.b - wm.rTip * 0.6;
  const yT = wm.y(xT);
  const cT = wm.chord(xT);
  const zT = wm.leZ(xT);
  const h = def.wingletH;
  const parts: THREE.BufferGeometry[] = [];
  const makePlate = (dirUp: 1 | -1, height: number, cBase: number, cTop: number, sweep: number, zOff: number) => {
    const g = surface(
      (u, v, out) => {
        const hh = v * height;
        const c = cBase + (cTop - cBase) * v;
        const zl = zT + zOff + hh * Math.tan(sweep * DEG);
        const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
        const side = u < 0.5 ? 1 : -1;
        const t = 0.07 * c * thick(xn) * (1 - 0.6 * v);
        out.set(wm.b + side * t, yT + dirUp * hh, zl + xn * c);
      },
      24,
      8,
    );
    return orient(g, (p, out) => out.set(p.x - wm.b, 0, 0));
  };
  if (def.tip === 'fence') {
    parts.push(makePlate(1, h, cT * 1.1, cT * 0.3, 58, -0.18 * cT));
    parts.push(makePlate(-1, h * 0.65, cT * 0.95, cT * 0.35, 58, -0.18 * cT));
  } else {
    const cfg = {
      sharklet: { rb: 0.38, cant: 12, sweep: 42, cTop: 0.33 },
      blended: { rb: 0.6, cant: 14, sweep: 38, cTop: 0.3 },
      curved: { rb: 1.05, cant: 22, sweep: 46, cTop: 0.25 },
      small: { rb: 0.45, cant: 18, sweep: 38, cTop: 0.45 },
    }[def.tip as 'sharklet' | 'blended' | 'curved' | 'small'];
    const rb = cfg.rb * h;
    const phiE = (90 - cfg.cant) * DEG;
    const arcH = rb * (1 - Math.cos(phiE));
    const Ls = Math.max(0, (h - arcH) / Math.sin(phiE));
    const La = rb * phiE;
    const Lt = La + Ls;
    const path = (v: number) => {
      const s = v * Lt;
      if (s <= La) {
        const a = s / rb;
        return { x: xT + rb * Math.sin(a), y: yT + rb * (1 - Math.cos(a)), a };
      }
      const e = s - La;
      return { x: xT + rb * Math.sin(phiE) + e * Math.cos(phiE), y: yT + arcH + e * Math.sin(phiE), a: phiE };
    };
    const g = surface(
      (u, v, out) => {
        const p = path(v);
        const c = cT * (0.95 + (cfg.cTop - 0.95) * smooth(0, 1, v));
        const hh = p.y - yT;
        const zl = zT + hh * Math.tan(cfg.sweep * DEG) + (cT - c) * 0.35;
        const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
        const side = u < 0.5 ? 1 : -1;
        const tc = 0.085 * (1 - 0.5 * v);
        const off = side * thick(xn) * tc * c + 0.012 * c * (1 - xn) * xn;
        // offset along the path normal (-sin a, cos a)
        out.set(p.x - Math.sin(p.a) * off, p.y + Math.cos(p.a) * off, zl + xn * c);
      },
      24,
      22,
    );
    // vertex (u = 0.25, v = 0.5) lies on the +normal side of the camber sheet
    const pm = path(0.5);
    orientVertex(g, 6 * 23 + 11, new THREE.Vector3(-Math.sin(pm.a), Math.cos(pm.a), 0));
    parts.push(g);
  }
  const right = merge(parts);
  return merge([right, mirrorX(right)]);
}

// ---------------------------------------------------------------- tail surfaces

class LinearPlanform implements Planform {
  x0: number;
  x1: number;
  camber = 0;
  constructor(
    x0: number,
    x1: number,
    private c0: number,
    private c1: number,
    private z0: number,
    private sweep: number,
    private y0: number,
    private dihedral: number,
    private t0: number,
    private t1: number,
    private rTip: number,
  ) {
    this.x0 = x0;
    this.x1 = x1;
  }
  private f(x: number): number {
    return Math.min(1, Math.max(0, (x - this.x0) / (this.x1 - this.x0)));
  }
  chord(x: number): number {
    return this.c0 + (this.c1 - this.c0) * this.f(x);
  }
  leZ(x: number): number {
    return this.z0 + (x - this.x0) * Math.tan(this.sweep * DEG);
  }
  y(x: number): number {
    return this.y0 + (x - this.x0) * Math.tan(this.dihedral * DEG);
  }
  tc(x: number): number {
    return this.t0 + (this.t1 - this.t0) * this.f(x);
  }
  round(x: number): number {
    const s = x - (this.x1 - this.rTip);
    if (s <= 0) return 1;
    const q = Math.min(1, s / this.rTip);
    return Math.sqrt(Math.max(0, 1 - q * q));
  }
}

export interface FinInfo {
  zMin: number;
  zMax: number;
  yMin: number;
  yMax: number;
  /** Outline in (z, y): root LE, tip LE, tip TE, root TE. */
  outline: [number, number][];
  topY: number;
  tipLE: number;
  tipChord: number;
}

export interface TailBuild {
  fin: THREE.BufferGeometry;
  stab: THREE.BufferGeometry;
  finInfo: FinInfo;
}

export function buildTail(shape: ShapeDef, fm: FuselageModel, height: number): TailBuild {
  const t: TailDef = shape.tail;
  const zTail = fm.zTail;
  const zRootTE = zTail - t.finTEOffset;
  const zRootLE = zRootTE - t.finRootChord;
  // fin root below the fuselage crown along its whole root chord
  let yRoot = Infinity;
  for (let i = 0; i <= 10; i++) {
    const z = zRootLE + (t.finRootChord * i) / 10;
    yRoot = Math.min(yRoot, fm.topY(fm.dAtZ(z)));
  }
  const yVisible = yRoot;
  yRoot -= 0.12 * fm.R;
  const stabThick = t.tTail ? t.stabRootChord * 0.1 : 0;
  const yTip = height - stabThick * 0.5;
  const finSpan = yTip - yRoot;
  const tanS = Math.tan(t.finSweep * DEG);
  const leAt = (y: number) => zRootLE + (y - yRoot) * tanS;
  const chordAt = (y: number) => t.finRootChord + (t.finTipChord - t.finRootChord) * ((y - yRoot) / finSpan);
  const zMin = leAt(yVisible) - 0.3;
  const zMax = Math.max(zRootTE, leAt(yTip) + t.finTipChord) + 0.1;
  const rTip = Math.min(0.35, t.finTipChord * (t.tTail ? 0.06 : 0.1));
  const finTc = 0.11;

  const fin = surface(
    (u, v, out) => {
      const y = yRoot + finSpan * v;
      const c = chordAt(y);
      const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
      const side = u < 0.5 ? 1 : -1;
      let r = 1;
      const s = y - (yTip - rTip);
      if (s > 0) r = Math.sqrt(Math.max(0, 1 - (s / rTip) ** 2));
      const xw = side * thick(xn) * finTc * c * r;
      out.set(xw, y, leAt(y) + xn * c);
    },
    0,
    0,
    {
      us: samples(30),
      vs: samples(16, 1),
      uv: (u, v, out) => {
        const y = yRoot + finSpan * v;
        const c = chordAt(y);
        const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
        const z = leAt(y) + xn * c;
        out.set((z - zMin) / (zMax - zMin), (y - yVisible) / (yTip - yVisible));
      },
    },
  );
  orient(fin, (p, out) => out.set(p.x, 0, 0));
  const finParts: THREE.BufferGeometry[] = [fin];
  if (t.dorsal) {
    const dl = t.finRootChord * 0.55;
    const dh = finSpan * 0.16;
    const g = surface(
      (u, v, out) => {
        const y = yRoot + dh * v;
        const zLeD = zRootLE - dl * (1 - v) * (1 - v) + (leAt(yRoot + dh) - zRootLE) * v * v;
        const zTe = zRootLE + t.finRootChord * 0.35;
        const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
        const side = u < 0.5 ? 1 : -1;
        const c = zTe - zLeD;
        const xw = side * thick(xn) * 0.1 * c * 0.6;
        out.set(xw, y, zLeD + xn * c);
      },
      0,
      0,
      {
        us: samples(20),
        vs: samples(6),
        uv: (u, v, out) => {
          const y = yRoot + dh * v;
          const zLeD = zRootLE - dl * (1 - v) * (1 - v) + (leAt(yRoot + dh) - zRootLE) * v * v;
          const zTe = zRootLE + t.finRootChord * 0.35;
          const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
          const z = zLeD + xn * (zTe - zLeD);
          out.set((z - zMin) / (zMax - zMin), (y - yVisible) / (yTip - yVisible));
        },
      },
    );
    finParts.push(orient(g, (p, out) => out.set(p.x, 0, 0)));
  }

  // horizontal stabiliser
  let stabPf: LinearPlanform;
  const bS = t.stabSpan / 2;
  if (t.tTail) {
    const zLE = leAt(yTip) - 0.08 * t.finTipChord;
    stabPf = new LinearPlanform(0, bS, t.stabRootChord, t.stabTipChord, zLE, t.stabSweep, yTip + stabThick * 0.1, t.stabDihedral, 0.1, 0.09, Math.min(0.3, t.stabTipChord * 0.25));
  } else {
    const zLE = zTail - t.stabFromTail;
    const dMid = fm.dAtZ(zLE + t.stabRootChord * 0.4);
    const st = fm.station(dMid);
    const x0 = st.hw * 0.35;
    stabPf = new LinearPlanform(x0, bS, t.stabRootChord, t.stabTipChord, zLE, t.stabSweep, st.yWide + st.hUp * 0.12, t.stabDihedral, 0.11, 0.09, Math.min(0.3, t.stabTipChord * 0.25));
  }
  const usS = spanSamples(stabPf.x0, stabPf.x1, [], 12, true);
  const stabR = wrapSurface(stabPf, stabPf.x0, stabPf.x1, 1, usS, 22);
  const stab = merge([stabR, mirrorX(stabR)]);

  const finInfo: FinInfo = {
    zMin,
    zMax,
    yMin: yVisible,
    yMax: yTip,
    outline: [
      [leAt(yVisible), yVisible],
      [leAt(yTip), yTip],
      [leAt(yTip) + t.finTipChord, yTip],
      [zRootTE, yVisible],
    ],
    topY: yTip,
    tipLE: leAt(yTip),
    tipChord: t.finTipChord,
  };
  return { fin: merge(finParts), stab, finInfo };
}

// ---------------------------------------------------------------- pylons

/** Vertical pylon between a nacelle top and the wing lower surface. */
export function buildWingPylon(
  wm: WingModel,
  e: EngineDef,
  xe: number,
  nacTopY: number,
  nacFrontZ: number,
): THREE.BufferGeometry {
  const len = e.length;
  const yb = nacTopY - 0.12 * e.radius;
  const yt = wm.lowerY(xe, 0.2) + 0.12;
  const zb0 = nacFrontZ + 0.3 * len;
  const zb1 = nacFrontZ + len * 1.02;
  const c = wm.chord(xe);
  const zt0 = wm.leZ(xe) + 0.03 * c;
  const zt1 = wm.leZ(xe) + 0.62 * c;
  const halfW = 0.16 * e.radius;
  const g = surface(
    (u, v, out) => {
      const y = yb + (yt - yb) * v;
      const z0 = zb0 + (zt0 - zb0) * v;
      const z1 = zb1 + (zt1 - zb1) * v;
      const xn = (1 + Math.cos(u * Math.PI * 2)) / 2;
      const side = u < 0.5 ? 1 : -1;
      const w = side * (thick(xn) / 0.5) * halfW;
      out.set(xe + w, y, z0 + xn * (z1 - z0));
    },
    24,
    4,
    { uv: (u, v, out) => out.set(u, v) },
  );
  return orient(g, (p, out) => out.set(p.x - xe, 0, 0));
}

/** Horizontal pylon from the rear fuselage to a nacelle. */
export function buildRearPylon(fm: FuselageModel, xn: number, yc: number, zFront: number, len: number, r: number): THREE.BufferGeometry {
  const side = Math.sign(xn);
  const zc = zFront + len * 0.45;
  const x0 = side * fm.halfWidthAtY(fm.dAtZ(zc), yc) * 0.8;
  const x1 = xn;
  const z0 = zFront + len * 0.28;
  const chord = len * 0.5;
  const halfT = 0.14 * r;
  const g = surface(
    (u, v, out) => {
      const x = x0 + (x1 - x0) * v;
      const xnn = (1 + Math.cos(u * Math.PI * 2)) / 2;
      const s = u < 0.5 ? 1 : -1;
      const c = chord * (1 - 0.25 * v);
      const zl = z0 + 0.35 * v * chord * 0.3;
      out.set(x, yc + s * (thick(xnn) / 0.5) * halfT, zl + xnn * c);
    },
    24,
    4,
    { uv: (u, v, out) => out.set(u, v) },
  );
  return orient(g, (p, out) => out.set(0, p.y - yc, 0));
}
