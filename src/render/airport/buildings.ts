// Buildings, control tower, floodlight masts, windsocks, ILS antennas, approach light
// structures and the perimeter fence. Geometry is merged per material; anything that moves
// (radar antennas, windsock cones) is a small separate object.

import * as THREE from 'three';
import type { AirportModel, RunwayEnd } from '../../sim/airportModel';
import type { BuildingDef, Vec2 } from '../../sim/airports/types';
import { boxFoot, GeoBuf, mulberry, pointInPoly } from './geo';
import { G_BUILD, G_FLOOD, G_OBST, type LightSpec } from './lights';

export interface Structures {
  glass: GeoBuf;
  punched: GeoBuf;
  garage: GeoBuf;
  metal: GeoBuf;
  roof: GeoBuf;
  plain: GeoBuf;
  towerGlass: GeoBuf;
  screens: GeoBuf;
  fence: GeoBuf;
  pools: GeoBuf;
  lights: LightSpec[];
  radars: { pos: THREE.Vector3; speed: number }[];
  windsocks: THREE.Vector3[];
}

const C = {
  concrete: new THREE.Color('#bdb8ae'),
  concreteDark: new THREE.Color('#8f8a82'),
  white: new THREE.Color('#e8e8e4'),
  steel: new THREE.Color('#9aa0a6'),
  darkSteel: new THREE.Color('#4b5056'),
  hangarDoor: new THREE.Color('#6d7780'),
  blueCladding: new THREE.Color('#6f8fb0'),
  red: new THREE.Color('#b02a22'),
  orange: new THREE.Color('#d45a1a'),
  roof: new THREE.Color('#8d8d8a'),
  black: new THREE.Color('#1c1d20'),
  mullion: new THREE.Color('#2a2e33'),
  console: new THREE.Color('#3a3d42'),
  grass: new THREE.Color('#5d6b3f'),
};

const L_WARM: [number, number, number] = [7, 5.6, 3.6];
const L_OBST: [number, number, number] = [9, 0.4, 0.15];

const add = (p: Vec2, d: Vec2, s: number): Vec2 => [p[0] + d[0] * s, p[1] + d[1] * s];
const axisVec = (deg: number): Vec2 => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
const ptEnd = (e: RunwayEnd, along: number, lat: number): Vec2 => [
  e.threshold[0] + e.dir[0] * along + e.right[0] * lat,
  e.threshold[1] + e.dir[1] * along + e.right[1] * lat,
];

export function buildStructures(model: AirportModel): Structures {
  const S: Structures = {
    glass: new GeoBuf(),
    punched: new GeoBuf(),
    garage: new GeoBuf(),
    metal: new GeoBuf(),
    roof: new GeoBuf(),
    plain: new GeoBuf(),
    towerGlass: new GeoBuf(),
    screens: new GeoBuf(),
    fence: new GeoBuf(),
    pools: new GeoBuf(),
    lights: [],
    radars: [],
    windsocks: [],
  };
  const def = model.def;
  const rnd = mulberry(def.icao ? hash(def.icao) : 7);
  const roofUv = (x: number, y: number): Vec2 => [x / 10, y / 10];

  const nearestRunwayDir = (p: Vec2): Vec2 => {
    let best = Infinity;
    let dir: Vec2 = [0, 1];
    for (const rw of model.runways) {
      const l = model.runwayLocal(rw, p[0], p[1]);
      const al = Math.max(0, Math.min(rw.length, l.along));
      const q: Vec2 = [rw.a[0] + rw.dir[0] * al, rw.a[1] + rw.dir[1] * al];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < best) {
        best = d;
        dir = [(q[0] - p[0]) / (d || 1), (q[1] - p[1]) / (d || 1)];
      }
    }
    return dir;
  };

  /** Flat roof with a parapet and a few rooftop plant units. */
  const flatRoof = (b: BuildingDef, h: number, units = true): void => {
    const foot = boxFoot(b.pos, b.axis, b.w, b.d);
    S.roof.flatPoly(foot, h + 0.05, roofUv, C.roof);
    const pw = 0.4;
    S.plain.prism(boxFoot(b.pos, b.axis, b.w + pw, b.d + pw), h, h + 0.9, 4, 4, null, C.concreteDark);
    if (!units) return;
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    const n = Math.min(8, Math.max(1, Math.floor((b.w * b.d) / 2500)));
    for (let k = 0; k < n; k++) {
      const c = add(add(b.pos, ax, (rnd() - 0.5) * b.w * 0.7), rt, (rnd() - 0.5) * b.d * 0.6);
      S.plain.box(c, b.axis, 4 + rnd() * 8, 3 + rnd() * 5, h, h + 1.5 + rnd() * 2, 4, 4, C.steel);
    }
  };

  /** Glazed terminal / pier with a floating roof and landside canopy. */
  const terminal = (b: BuildingDef): void => {
    S.glass.box(b.pos, b.axis, b.w, b.d, 0, b.h, 24, 36, null, null);
    // Overhanging roof slab.
    S.plain.box(b.pos, b.axis, b.w + 6, b.d + 6, b.h, b.h + 1.2, 4, 4, C.white, S.roof, 10);
    // Fascia band at the base (baggage level).
    S.plain.prism(boxFoot(b.pos, b.axis, b.w + 0.3, b.d + 0.3), 0, Math.min(4, b.h * 0.25), 4, 4, null, C.concrete);
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    const n = Math.min(10, Math.max(2, Math.floor(b.w / 60)));
    for (let k = 0; k < n; k++) {
      const c = add(add(b.pos, ax, ((k + 0.5) / n - 0.5) * b.w * 0.85), rt, (rnd() - 0.5) * b.d * 0.5);
      S.plain.box(c, b.axis, 6 + rnd() * 6, 4 + rnd() * 3, b.h + 1.2, b.h + 3, 4, 4, C.steel);
    }
    // Night-time glow along the roof edge.
    for (let k = 0; k <= n; k++) {
      for (const s of [-1, 1]) {
        S.lights.push({ p: add(add(b.pos, ax, (k / n - 0.5) * b.w), rt, s * (b.d / 2 + 3.2)), h: b.h - 0.2, color: L_WARM, size: 0.9, group: G_BUILD });
      }
    }
  };

  const hangar = (b: BuildingDef): void => {
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    const wallH = b.h * 0.72;
    // Side walls (metal) and end walls follow the arch profile across the depth.
    S.metal.box(b.pos, b.axis, b.w, b.d, 0, wallH, 8, 8, C.steel);
    const seg = 12;
    const prof: [number, number][] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      prof.push([(t - 0.5) * b.d, wallH + Math.sin(t * Math.PI) * (b.h - wallH)]);
    }
    for (let i = 0; i < seg; i++) {
      const [l0, h0] = prof[i];
      const [l1, h1] = prof[i + 1];
      const a0 = add(add(b.pos, ax, -b.w / 2), rt, l0);
      const a1 = add(add(b.pos, ax, b.w / 2), rt, l0);
      const b1 = add(add(b.pos, ax, b.w / 2), rt, l1);
      const b0 = add(add(b.pos, ax, -b.w / 2), rt, l1);
      const dl = l1 - l0;
      const dh = h1 - h0;
      const nl = Math.hypot(dl, dh);
      const nLat = -dh / nl;
      const nUp = dl / nl;
      const nx = rt[0] * nLat;
      const nz = -rt[1] * nLat;
      const v = [a0, a1, b1, b0].map((p, k) => S.roof.vert(p[0], k < 2 ? h0 : h1, -p[1], nx, nUp, nz, (k === 1 || k === 2 ? b.w : 0) / 10, (i + (k >= 2 ? 1 : 0)) * 1.5, C.steel));
      // Orientation check: face normal must point up/out.
      tri2(S.roof, v[0], v[1], v[2], v[3], nx, nUp, nz);
      // Gable end fill.
      for (const s of [-1, 1]) {
        const e0 = add(add(b.pos, ax, (s * b.w) / 2), rt, l0);
        const e1 = add(add(b.pos, ax, (s * b.w) / 2), rt, l1);
        const ec = add(b.pos, ax, (s * b.w) / 2);
        const nn: [number, number, number] = [ax[0] * s, 0, -ax[1] * s];
        const i0 = S.metal.vert(e0[0], h0, -e0[1], ...nn, l0 / 8, h0 / 8, C.steel);
        const i1 = S.metal.vert(e1[0], h1, -e1[1], ...nn, l1 / 8, h1 / 8, C.steel);
        const i2 = S.metal.vert(e1[0], wallH, -e1[1], ...nn, l1 / 8, wallH / 8, C.steel);
        const i3 = S.metal.vert(e0[0], wallH, -e0[1], ...nn, l0 / 8, wallH / 8, C.steel);
        void ec;
        tri2(S.metal, i3, i2, i1, i0, ...nn);
      }
    }
    // Hangar doors on the long side facing the nearest runway.
    const toRw = nearestRunwayDir(b.pos);
    const s = rt[0] * toRw[0] + rt[1] * toRw[1] > 0 ? 1 : -1;
    const doorC = add(b.pos, rt, (s * b.d) / 2 + 0.25);
    S.plain.box(doorC, b.axis, b.w * 0.88, 0.5, 0, wallH * 0.92, 4, 4, C.hangarDoor);
    // Door panel seams.
    const panels = Math.max(4, Math.round(b.w / 12));
    for (let k = 1; k < panels; k++) {
      S.plain.box(add(add(doorC, rt, s * 0.3), ax, (k / panels - 0.5) * b.w * 0.88), b.axis, 0.35, 0.2, 0, wallH * 0.92, 4, 4, C.darkSteel);
    }
    S.plain.box(add(b.pos, rt, (s * b.d) / 2 + 0.6), b.axis, b.w * 0.92, 1.2, wallH * 0.92, wallH * 0.92 + 1.4, 4, 4, C.white);
    // Floodlights over the doors.
    for (let k = 0; k < 4; k++) {
      S.lights.push({ p: add(add(b.pos, rt, s * (b.d / 2 + 1.4)), ax, ((k + 0.5) / 4 - 0.5) * b.w * 0.8), h: wallH * 0.95, color: L_WARM, size: 1.0, group: G_FLOOD });
    }
    // Office annex (windows).
    const annex = add(b.pos, rt, -s * (b.d / 2 + 5));
    S.punched.box(annex, b.axis, b.w * 0.6, 10, 0, Math.min(12, b.h * 0.45), 28.8, 28.8);
    S.roof.flatPoly(boxFoot(annex, b.axis, b.w * 0.6, 10), Math.min(12, b.h * 0.45) + 0.05, roofUv, C.roof);
  };

  const shed = (b: BuildingDef, color: THREE.Color, docks: boolean): void => {
    S.metal.box(b.pos, b.axis, b.w, b.d, 0, b.h, 8, 8, color);
    flatRoof(b, b.h);
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    if (docks) {
      const toRw = nearestRunwayDir(b.pos);
      const s = rt[0] * toRw[0] + rt[1] * toRw[1] > 0 ? 1 : -1;
      const n = Math.max(3, Math.floor(b.w / 14));
      for (let k = 0; k < n; k++) {
        const c = add(add(b.pos, rt, s * (b.d / 2 + 0.1)), ax, ((k + 0.5) / n - 0.5) * b.w * 0.9);
        S.plain.box(c, b.axis, 5, 0.3, 0.2, 5.2, 4, 4, C.darkSteel);
      }
      S.plain.box(add(b.pos, rt, s * (b.d / 2 + 3)), b.axis, b.w, 6, b.h * 0.7, b.h * 0.7 + 0.5, 4, 4, C.white);
      for (let k = 0; k < n; k += 2) {
        S.lights.push({ p: add(add(b.pos, rt, s * (b.d / 2 + 5.5)), ax, ((k + 0.5) / n - 0.5) * b.w * 0.9), h: b.h * 0.7 - 0.2, color: L_WARM, size: 0.8, group: G_FLOOD });
      }
    }
  };

  const office = (b: BuildingDef): void => {
    S.punched.box(b.pos, b.axis, b.w, b.d, 0, b.h, 28.8, 28.8);
    flatRoof(b, b.h);
  };

  const garage = (b: BuildingDef): void => {
    S.garage.box(b.pos, b.axis, b.w, b.d, 0, b.h, 32, 24);
    S.roof.flatPoly(boxFoot(b.pos, b.axis, b.w, b.d), b.h + 0.05, roofUv, C.concreteDark);
    S.plain.prism(boxFoot(b.pos, b.axis, b.w + 0.3, b.d + 0.3), b.h, b.h + 1.1, 4, 4, null, C.concrete);
    // Roof-deck lamp posts.
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    for (let i = -1; i <= 1; i += 2) {
      for (let j = -1; j <= 1; j += 2) {
        const p = add(add(b.pos, ax, i * b.w * 0.3), rt, j * b.d * 0.3);
        S.plain.box(p, 0, 0.25, 0.25, b.h, b.h + 6, 4, 4, C.steel);
        S.lights.push({ p, h: b.h + 6.1, color: L_WARM, size: 0.7, group: G_FLOOD });
      }
    }
  };

  const fireStation = (b: BuildingDef): void => {
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    S.plain.box(b.pos, b.axis, b.w, b.d, 0, b.h, 4, 4, C.white);
    flatRoof(b, b.h, false);
    const toRw = nearestRunwayDir(b.pos);
    const s = rt[0] * toRw[0] + rt[1] * toRw[1] > 0 ? 1 : -1;
    const bays = Math.max(3, Math.floor(b.w / 7));
    for (let k = 0; k < bays; k++) {
      const c = add(add(b.pos, rt, s * (b.d / 2 + 0.1)), ax, ((k + 0.5) / bays - 0.5) * b.w * 0.9);
      S.plain.box(c, b.axis, b.w / bays - 1.2, 0.3, 0, b.h * 0.7, 4, 4, C.red);
    }
    // Watch room with windows.
    const wr = add(b.pos, ax, b.w * 0.3);
    S.punched.box(wr, b.axis, 8, 8, b.h, b.h + 5, 28.8, 28.8);
    S.roof.flatPoly(boxFoot(wr, b.axis, 8, 8), b.h + 5.05, roofUv, C.roof);
    S.plain.box(add(b.pos, rt, s * (b.d / 2 + 2)), b.axis, b.w, 4, b.h * 0.72, b.h * 0.72 + 0.3, 4, 4, C.red);
  };

  const fuel = (b: BuildingDef): void => {
    const ax = axisVec(b.axis);
    const rt: Vec2 = [ax[1], -ax[0]];
    // Bund wall around the farm.
    S.plain.prism(boxFoot(b.pos, b.axis, b.w, b.d), 0, 1.4, 4, 4, null, C.concrete);
    S.plain.prism(boxFoot(b.pos, b.axis, b.w - 0.6, b.d - 0.6), 0, 1.4, 4, 4, null, C.concrete);
    S.roof.flatPoly(boxFoot(b.pos, b.axis, b.w - 0.6, b.d - 0.6), 0.15, roofUv, C.concreteDark);
    const nx = Math.max(1, Math.floor(b.w / 28));
    const ny = Math.max(1, Math.floor(b.d / 28));
    const r = Math.min(b.w / nx, b.d / ny) * 0.36;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const c = add(add(b.pos, ax, ((i + 0.5) / nx - 0.5) * b.w), rt, ((j + 0.5) / ny - 0.5) * b.d);
        S.metal.cylinder(c, r, r, 0, b.h, 20, 8, 8, C.white, false);
        S.plain.cylinder(c, r, r * 0.25, b.h, b.h + r * 0.18, 20, 4, 4, C.white, true);
        S.plain.cylinder(add(c, rt, r), 0.25, 0.25, 0, b.h, 5, 4, 4, C.steel, false);
      }
    }
  };

  const radar = (b: BuildingDef): void => {
    const c = b.pos;
    S.plain.box(c, b.axis, Math.max(8, b.w * 0.6), Math.max(8, b.d * 0.6), 0, 4, 4, 4, C.white);
    S.plain.cylinder(c, 2.4, 1.6, 4, b.h - 3, 12, 4, 4, C.white, true);
    S.plain.box(c, b.axis, 5.5, 5.5, b.h - 3, b.h - 1.5, 4, 4, C.steel);
    S.radars.push({ pos: new THREE.Vector3(c[0], b.h - 1.5, -c[1]), speed: 1.3 + rnd() * 0.5 });
    S.lights.push({ p: c, h: b.h + 3.5, color: L_OBST, size: 1.1, group: G_OBST, flashPeriod: 1.5, flashPhase: rnd(), flashDuty: 0.5 });
  };

  const hotel = (b: BuildingDef): void => {
    S.punched.box(b.pos, b.axis, b.w, b.d, 0, b.h, 28.8, 28.8);
    S.plain.prism(boxFoot(b.pos, b.axis, b.w + 8, b.d + 8), 0, 5, 4, 4, null, C.concrete);
    S.roof.flatPoly(boxFoot(b.pos, b.axis, b.w + 8, b.d + 8), 5.02, roofUv, C.roof);
    flatRoof(b, b.h);
    if (b.h > 40) S.lights.push({ p: b.pos, h: b.h + 2.5, color: L_OBST, size: 1.1, group: G_OBST, flashPeriod: 1.5, flashPhase: rnd(), flashDuty: 0.5 });
  };

  const smallTower = (b: BuildingDef): void => {
    const r = Math.max(2.5, Math.min(b.w, b.d) * 0.25);
    S.plain.cylinder(b.pos, r, r * 0.8, 0, b.h - 4, 10, 4, 4, C.concrete, false);
    S.glass.cylinder(b.pos, r * 1.6, r * 1.7, b.h - 4, b.h, 8, 24, 36, null, false);
    S.plain.cylinder(b.pos, r * 1.9, r * 0.4, b.h, b.h + 1, 8, 4, 4, C.white, true);
  };

  const skipNear = def.tower.pos;
  for (const b of def.buildings) {
    switch (b.kind) {
      case 'terminal':
      case 'pier':
        terminal(b);
        break;
      case 'hangar':
        hangar(b);
        break;
      case 'cargo':
        shed(b, C.blueCladding, true);
        break;
      case 'maintenance':
        shed(b, C.steel, true);
        break;
      case 'office':
        office(b);
        break;
      case 'garage':
        garage(b);
        break;
      case 'firestation':
        fireStation(b);
        break;
      case 'fuel':
        fuel(b);
        break;
      case 'radar':
        radar(b);
        break;
      case 'hotel':
        hotel(b);
        break;
      case 'tower':
        if (Math.hypot(b.pos[0] - skipNear[0], b.pos[1] - skipNear[1]) > 30) smallTower(b);
        break;
    }
  }

  buildTower(S, model);
  buildFloodlights(S, model);
  buildRunwayFurniture(S, model);
  buildFence(S, model);
  return S;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Quad (a,b,c,d) wound so its face normal agrees with (nx, ny, nz). */
function tri2(buf: GeoBuf, a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
  const p = buf.pos;
  const v = (i: number) => new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  const A = v(a);
  const n = new THREE.Vector3().crossVectors(v(b).sub(A), v(c).sub(A));
  if (n.x * nx + n.y * ny + n.z * nz >= 0) {
    buf.tri(a, b, c);
    buf.tri(a, c, d);
  } else {
    buf.tri(a, c, b);
    buf.tri(a, d, c);
  }
}

/** Control tower: shaft, flared junction, octagonal glass cab (the tower camera sits inside). */
function buildTower(S: Structures, model: AirportModel): void {
  const t = model.def.tower;
  const c = t.pos;
  const floor = t.eyeHeight - 1.7;
  const look = Math.atan2(t.lookAt[0] - c[0], t.lookAt[1] - c[1]);
  // Base building.
  const baseAxis = (look * 180) / Math.PI;
  S.glass.box(add(c, axisVec(baseAxis + 180), 10), baseAxis, 30, 18, 0, 9, 24, 36);
  S.roof.flatPoly(boxFoot(add(c, axisVec(baseAxis + 180), 10), baseAxis, 30, 18), 9.05, (x, y) => [x / 10, y / 10], C.roof);
  // Shaft.
  S.plain.cylinder(c, 4.2, 3.6, 0, floor - 6, 16, 6, 6, C.concrete, false);
  // Vertical window slot up the shaft (stairwell).
  const la = axisVec(baseAxis + 180);
  for (let h = 12; h < floor - 8; h += 3.2) {
    S.glass.box(add(c, la, 3.75), baseAxis + 90, 0.9, 0.3, h, h + 2.2, 24, 36);
  }
  // Flared junction / equipment floors.
  S.plain.cylinder(c, 3.6, 7.6, floor - 6, floor - 2.2, 16, 6, 6, C.white, false);
  S.punched.cylinder(c, 7.6, 7.6, floor - 2.2, floor - 0.4, 16, 28.8, 28.8, null, false);
  S.plain.cylinder(c, 7.6, 7.9, floor - 0.4, floor, 16, 6, 6, C.white, false);
  // Cab floor.
  S.plain.disc(c, 7.9, floor, (x, y) => [x / 4, y / 4], 16, C.console);
  // Glass (outward-leaning octagon), mullions, roof. The octagon is rotated so a pane (not a
  // mullion) is centred on the default look direction; sill and consoles stay >= 1.2 m below the eye.
  const R0 = 6.9;
  const R1 = 7.6;
  const sill = floor + 0.35;
  const topH = floor + 4.3;
  const n = 8;
  const ao = Math.atan2(t.lookAt[1] - c[1], t.lookAt[0] - c[0]);
  const p = (a: number, r: number): Vec2 => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
  for (let i = 0; i < n; i++) {
    const a0 = ao + ((i - 0.5) / n) * Math.PI * 2;
    const a1 = ao + ((i + 0.5) / n) * Math.PI * 2;
    const q0 = p(a0, R0);
    const q1 = p(a1, R0);
    const u0 = p(a0, R1);
    const u1 = p(a1, R1);
    const mid = (a0 + a1) / 2;
    const nx = Math.cos(mid);
    const nz = -Math.sin(mid);
    const i0 = S.towerGlass.vert(q0[0], sill, -q0[1], nx, 0.1, nz, 0, 0);
    const i1 = S.towerGlass.vert(q1[0], sill, -q1[1], nx, 0.1, nz, 1, 0);
    const i2 = S.towerGlass.vert(u1[0], topH, -u1[1], nx, 0.1, nz, 1, 1);
    const i3 = S.towerGlass.vert(u0[0], topH, -u0[1], nx, 0.1, nz, 0, 1);
    tri2(S.towerGlass, i0, i1, i2, i3, nx, 0, nz);
    mullion(S.plain, p(a0, R0 + 0.05), p(a0, R1 + 0.05), sill, topH);
    // Low sill band.
    S.plain.wall(p(a0, R0 + 0.1), p(a1, R0 + 0.1), floor, sill, 4, 4, 0, C.mullion, -1);
    S.plain.wall(p(a0, R0 + 0.1), p(a1, R0 + 0.1), floor, sill, 4, 4, 0, C.mullion, 1);
  }
  S.plain.cylinder(c, R1 + 0.9, R1 + 0.9, topH, topH + 0.7, 16, 6, 6, C.white, false);
  S.plain.cylinder(c, R1 + 0.9, 2, topH + 0.7, topH + 1.1, 16, 6, 6, C.white, true);
  S.plain.disc(c, R1 + 0.9, topH - 0.01, (x, y) => [x, y], 16, C.console, true);
  // Low console desks around the glass with flat, dimly glowing screens (all below the eye line).
  const deskTop = floor + 0.45;
  for (let i = 0; i < n; i++) {
    if (i === Math.round(n / 2)) continue; // stair / entrance side
    const a = ao + (i / n) * Math.PI * 2;
    const d: Vec2 = [Math.cos(a), Math.sin(a)];
    const cc = add(c, d, R0 - 0.9);
    const deg = (Math.atan2(d[0], d[1]) * 180) / Math.PI + 90;
    S.plain.box(cc, deg, 3.6, 1.0, floor, deskTop, 4, 4, C.console);
    for (let k = -1; k <= 1; k++) {
      const sc = add(add(cc, d, -0.15), [d[1], -d[0]], k * 1.1);
      S.screens.box(sc, deg, 0.8, 0.5, deskTop, deskTop + 0.03, 1, 1);
    }
  }
  // Antennas and obstruction light.
  S.plain.cylinder(c, 0.12, 0.08, topH + 1.1, topH + 8, 6, 4, 4, C.steel, false);
  S.plain.cylinder(add(c, [1, 0], 3), 0.08, 0.05, topH + 1.1, topH + 4, 6, 4, 4, C.steel, false);
  S.plain.box(add(c, [-1, 0.3], 3.5), 0, 0.6, 0.6, topH + 1.1, topH + 2, 4, 4, C.white);
  S.lights.push({ p: c, h: topH + 8.2, color: L_OBST, size: 1.2, group: G_OBST, flashPeriod: 1.5, flashPhase: 0, flashDuty: 0.5 });
  for (let i = 0; i < 4; i++) {
    const a = ao + ((i + 0.5) / 4) * Math.PI * 2;
    S.lights.push({ p: [c[0] + Math.cos(a) * (R1 + 0.9), c[1] + Math.sin(a) * (R1 + 0.9)], h: topH + 0.8, color: L_OBST, size: 0.8, group: G_OBST });
  }
}

function mullion(buf: GeoBuf, a: Vec2, b: Vec2, h0: number, h1: number): void {
  // Leaning square post from a@h0 to b@h1.
  const w = 0.06;
  const dirs: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const corners = (p: Vec2): Vec2[] => [
    [p[0] - w, p[1] - w],
    [p[0] + w, p[1] - w],
    [p[0] + w, p[1] + w],
    [p[0] - w, p[1] + w],
  ];
  const c0 = corners(a);
  const c1 = corners(b);
  for (let k = 0; k < 4; k++) {
    const n = dirs[(k + 3) % 4];
    const nx = n[1] === 0 ? n[0] : 0;
    const nz = n[0] === 0 ? -n[1] : 0;
    const i0 = buf.vert(c0[k][0], h0, -c0[k][1], nx, 0, nz, 0, 0, C.mullion);
    const i1 = buf.vert(c0[(k + 1) % 4][0], h0, -c0[(k + 1) % 4][1], nx, 0, nz, 1, 0, C.mullion);
    const i2 = buf.vert(c1[(k + 1) % 4][0], h1, -c1[(k + 1) % 4][1], nx, 0, nz, 1, 1, C.mullion);
    const i3 = buf.vert(c1[k][0], h1, -c1[k][1], nx, 0, nz, 0, 1, C.mullion);
    buf.tri(i0, i1, i2);
    buf.tri(i0, i2, i3);
    buf.tri(i0, i2, i1);
    buf.tri(i0, i3, i2);
  }
}

/** High-mast apron floodlights along the apron boundaries plus fake light pools on the ground. */
function buildFloodlights(S: Structures, model: AirportModel): void {
  const spacing = 130;
  const pts: Vec2[] = [];
  for (const ap of model.def.aprons) {
    const poly = ap.polygon;
    let cx = 0;
    let cy = 0;
    for (const p of poly) {
      cx += p[0];
      cy += p[1];
    }
    cx /= poly.length;
    cy /= poly.length;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(L / spacing));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const p: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        // Pull slightly inside the apron.
        const dx = cx - p[0];
        const dy = cy - p[1];
        const dl = Math.hypot(dx, dy) || 1;
        const q: Vec2 = [p[0] + (dx / dl) * 6, p[1] + (dy / dl) * 6];
        if (pts.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1]) < spacing * 0.6)) continue;
        // Keep masts off taxi routes and gate stands.
        if (model.gates.some((g) => Math.hypot(g.pos[0] - q[0], g.pos[1] - q[1]) < 30)) continue;
        if (!pointInPoly(q, poly)) continue;
        pts.push(q);
      }
    }
  }
  const H = 28;
  const pool = new THREE.Color(1, 0.86, 0.62);
  for (const p of pts) {
    S.plain.cylinder(p, 0.45, 0.25, 0, H, 8, 4, 4, C.steel, false);
    S.plain.box(p, 0, 4.2, 1.0, H - 0.3, H + 0.9, 4, 4, C.darkSteel);
    for (let k = -2; k <= 2; k++) {
      S.lights.push({ p: [p[0] + k * 0.8, p[1]], h: H - 0.4, color: [9, 7.8, 5.6], size: 0.8, group: G_FLOOD });
    }
    S.lights.push({ p, h: H + 1.2, color: L_OBST, size: 0.7, group: G_OBST });
    S.pools.rect(p, [0, 1], 70, 70, 0.14, 0, 0, 1, 1, pool);
  }
}

/** Windsocks, ILS localizer / glideslope, approach light structures and PAPI boxes. */
function buildRunwayFurniture(S: Structures, model: AirportModel): void {
  for (const rw of model.runways) {
    for (const e of rw.ends) {
      const W = e.width;
      // Windsock on the right of each landing zone.
      const ws = ptEnd(e, 320, W / 2 + 75);
      S.plain.cylinder(ws, 0.15, 0.1, 0, 7, 6, 4, 4, C.white, false);
      S.plain.box(ws, 0, 1.4, 1.4, 0, 0.3, 4, 4, C.concrete);
      S.windsocks.push(new THREE.Vector3(ws[0], 6.8, -ws[1]));
      S.lights.push({ p: ws, h: 7.3, color: L_OBST, size: 0.6, group: G_OBST });

      // PAPI housings.
      if (e.papi) {
        for (let k = 0; k < 4; k++) {
          const p = ptEnd(e, 290, -(W / 2 + 15 + k * 9));
          S.plain.box(p, e.hdg, 1.8, 1.2, 0.2, 0.9, 4, 4, C.white);
          S.plain.box(add(p, e.dir, 0.4), e.hdg, 1.6, 0.4, 0, 0.25, 4, 4, C.concrete);
        }
      }
      // Localizer array beyond the far end (serves this end).
      if (e.ils) {
        const loc = ptEnd(e, e.length + 300, 0);
        const lat: Vec2 = e.right;
        S.plain.box(add(loc, e.dir, 1.5), e.hdg + 90, 36, 0.6, 0, 0.5, 4, 4, C.concrete);
        for (let k = -8; k <= 8; k++) {
          const p = add(loc, lat, k * 2.2);
          S.plain.cylinder(p, 0.07, 0.07, 0, 3, 5, 4, 4, C.steel, false);
          S.plain.box(p, e.hdg + 90, 1.8, 0.5, 2.6, 3.1, 4, 4, C.white);
        }
        S.plain.box(add(loc, lat, 26), e.hdg, 3.5, 3, 0, 2.8, 4, 4, C.white);
        S.lights.push({ p: add(loc, lat, -19), h: 3.3, color: L_OBST, size: 0.5, group: G_OBST });
        S.lights.push({ p: add(loc, lat, 19), h: 3.3, color: L_OBST, size: 0.5, group: G_OBST });
        // Glideslope mast and shack.
        const gs = ptEnd(e, 300, W / 2 + 125);
        S.plain.cylinder(gs, 0.25, 0.18, 0, 16, 6, 4, 4, C.red, false);
        for (const h of [5.5, 9.5, 13.5]) S.plain.box(add(gs, e.dir, -0.3), e.hdg, 1.2, 0.4, h, h + 1, 4, 4, C.white);
        S.plain.box(add(gs, e.right, 5), e.hdg, 4, 3, 0, 2.6, 4, 4, C.white);
        S.plain.box(add(gs, e.right, 5), e.hdg, 4.4, 3.4, 2.6, 2.8, 4, 4, C.darkSteel);
        S.lights.push({ p: gs, h: 16.3, color: L_OBST, size: 0.6, group: G_OBST });
      }
      // Approach light stands.
      if (e.approachLights !== 'none') {
        const step = e.approachLights === 'full' ? 30 : 60;
        const max = e.approachLights === 'full' ? 900 : 420;
        for (let al = step; al <= max; al += step) {
          const p = ptEnd(e, -al, 0);
          S.plain.box(p, e.hdg, 0.2, 0.2, 0, 1.0, 4, 4, C.orange);
          S.plain.box(p, e.hdg + 90, e.approachLights === 'full' ? 4.6 : 0.6, 0.15, 0.85, 0.95, 4, 4, C.darkSteel);
          if (e.approachLights === 'full' && al <= 270) {
            for (const s of [-1, 1]) S.plain.box(ptEnd(e, -al, s * 12), e.hdg + 90, 3.4, 0.15, 0.85, 0.95, 4, 4, C.darkSteel);
          }
        }
        S.plain.box(ptEnd(e, -300, 0), e.hdg + 90, 30, 0.15, 0.85, 0.95, 4, 4, C.darkSteel);
      }
    }
  }
}

/** Perimeter fence around the flat airfield zone (skipping water). */
function buildFence(S: Structures, model: AirportModel): void {
  const zone = model.def.scenery.flatZone;
  const water = model.def.scenery.water;
  if (!zone || zone.length < 3) return;
  const H = 2.6;
  const post = 3;
  const n = zone.length;
  for (let i = 0; i < n; i++) {
    const a = zone[i];
    const b = zone[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const segs = Math.max(1, Math.ceil(L / 40));
    for (let k = 0; k < segs; k++) {
      const p = add(a, [(b[0] - a[0]) / L, (b[1] - a[1]) / L], (k / segs) * L);
      const q = add(a, [(b[0] - a[0]) / L, (b[1] - a[1]) / L], ((k + 1) / segs) * L);
      const m: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (water.some((w) => pointInPoly(m, w))) continue;
      const u0 = (k / segs) * L;
      // Double-sided chain link panel (walls both ways).
      S.fence.wall(p, q, 0, H, post, H, u0, null, 1);
      S.fence.wall(p, q, 0, H, post, H, u0, null, -1);
      const sl = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const np = Math.max(1, Math.round(sl / 6));
      for (let j = 0; j < np; j++) {
        const pp = add(p, [(q[0] - p[0]) / sl, (q[1] - p[1]) / sl], (j / np) * sl);
        S.plain.box(pp, 0, 0.1, 0.1, 0, H + 0.4, 4, 4, C.steel, null, 4);
      }
    }
  }
}
