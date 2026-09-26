// Static airport layout: pavement surfaces, ICAO markings, signs and the airfield lighting
// (runway, approach, PAPI, taxiway, stop bars) derived from the AirportModel.

import * as THREE from 'three';
import type { AirportModel, Runway, RunwayEnd } from '../../sim/airportModel';
import type { Vec2 } from '../../sim/airports/types';
import { distToSeg, GeoBuf, pointInPoly } from './geo';
import { G_APP, G_PAPI, G_RWY, G_STOP, G_TAXI_CL, G_TAXI_EDGE, type LightSpec } from './lights';
import type { Atlas } from './textures';

export const H = {
  apron: 0.05,
  taxi: 0.07,
  shoulder: 0.08,
  runway: 0.1,
  rubber: 0.115,
  rwyMark: 0.13,
  taxiMark: 0.09,
};

const WHITE = new THREE.Color('#f2f2ee');
const YELLOW = new THREE.Color('#f5b90c');
const RED = new THREE.Color('#b3121b');
const BLACK = new THREE.Color('#111111');

// HDR light colours (linear).
const L_WHITE: [number, number, number] = [5.2, 4.9, 4.3];
const L_YELLOW: [number, number, number] = [5.8, 3.7, 0.55];
const L_RED: [number, number, number] = [6.5, 0.35, 0.12];
const L_GREEN: [number, number, number] = [0.45, 6.2, 1.5];
const L_BLUE: [number, number, number] = [0.5, 1.0, 7.5];
const L_FLASH: [number, number, number] = [11, 11, 12];

export interface HoldInfo {
  node: number;
  runwayId: string;
  runwayIndex: number;
  p: Vec2;
  /** Unit direction from the hold towards the runway. */
  dIn: Vec2;
  width: number;
  taxiway: string;
}

export interface Layout {
  runway: GeoBuf;
  shoulder: GeoBuf;
  taxi: GeoBuf;
  apron: GeoBuf;
  rubber: GeoBuf;
  marks: GeoBuf;
  signFaces: GeoBuf;
  signBody: GeoBuf;
  lights: LightSpec[];
  holds: HoldInfo[];
  endIndex: Record<string, number>;
  runwayIndex: Record<string, number>;
}

const add = (p: Vec2, d: Vec2, s: number): Vec2 => [p[0] + d[0] * s, p[1] + d[1] * s];
const ptEnd = (e: RunwayEnd, along: number, lat: number): Vec2 => [
  e.threshold[0] + e.dir[0] * along + e.right[0] * lat,
  e.threshold[1] + e.dir[1] * along + e.right[1] * lat,
];
const ptRw = (rw: Runway, along: number, lat: number): Vec2 => [
  rw.a[0] + rw.dir[0] * along + rw.right[0] * lat,
  rw.a[1] + rw.dir[1] * along + rw.right[1] * lat,
];
const neg = (d: Vec2): Vec2 => [-d[0], -d[1]];

export function buildLayout(model: AirportModel, atlas: Atlas): Layout {
  const L: Layout = {
    runway: new GeoBuf(),
    shoulder: new GeoBuf(),
    taxi: new GeoBuf(),
    apron: new GeoBuf(),
    rubber: new GeoBuf(),
    marks: new GeoBuf(),
    signFaces: new GeoBuf(),
    signBody: new GeoBuf(),
    lights: [],
    holds: [],
    endIndex: {},
    runwayIndex: {},
  };
  const def = model.def;
  const S = atlas.solid;
  const su = (S[0] + S[2]) / 2;
  const sv = (S[1] + S[3]) / 2;
  const solidUv = (): Vec2 => [su, sv];

  let ei = 0;
  model.runways.forEach((rw, i) => {
    L.runwayIndex[rw.id] = i;
    for (const e of rw.ends) L.endIndex[e.name] = ei++;
  });

  /** Painted rectangle in a runway-end frame. */
  const markEnd = (e: RunwayEnd, alongC: number, latC: number, halfAlong: number, halfLat: number, color: THREE.Color, h = H.rwyMark): void => {
    L.marks.rect(ptEnd(e, alongC, latC), e.dir, halfAlong, halfLat, h, S[0], S[1], S[2], S[3], color);
  };
  const glyph = (buf: GeoBuf, c: Vec2, d: Vec2, ch: string, height: number, h: number, color: THREE.Color): void => {
    const g = atlas.glyph(ch);
    buf.rect(c, d, height / 2, (height * atlas.aspect) / 2, h, g[0], g[1], g[2], g[3], color);
  };
  /** Text laid on the ground, reading along d, centred at c. */
  const groundText = (c: Vec2, d: Vec2, text: string, height: number, h: number, color: THREE.Color, spacing = 0.12): void => {
    const gw = height * atlas.aspect;
    const step = gw + height * spacing;
    const total = step * text.length - height * spacing;
    const r: Vec2 = [d[1], -d[0]];
    for (let k = 0; k < text.length; k++) {
      const off = -total / 2 + gw / 2 + k * step;
      glyph(L.marks, add(c, r, off), d, text[k], height, h, color);
    }
  };

  // ------------------------------------------------------------------ runways
  for (const rw of model.runways) {
    const W = rw.width;
    const Ln = rw.length;
    const ri = L.runwayIndex[rw.id];
    const uvRw = (x: number, y: number): Vec2 => {
      const l = model.runwayLocal(rw, x, y);
      return [l.lat / 24, l.along / 24];
    };
    L.runway.flatQuad(ptRw(rw, 0, -W / 2), ptRw(rw, Ln, -W / 2), ptRw(rw, Ln, W / 2), ptRw(rw, 0, W / 2), H.runway, uvRw);
    const sh = W >= 45 ? 7.5 : 5;
    for (const s of [-1, 1]) {
      L.shoulder.flatQuad(ptRw(rw, -60, s * W / 2 - s * 0.5), ptRw(rw, Ln + 60, s * W / 2 - s * 0.5), ptRw(rw, Ln + 60, s * (W / 2 + sh)), ptRw(rw, -60, s * (W / 2 + sh)), H.shoulder, uvRw);
    }
    // Blast pads.
    L.shoulder.flatQuad(ptRw(rw, -60, -W / 2), ptRw(rw, 0, -W / 2), ptRw(rw, 0, W / 2), ptRw(rw, -60, W / 2), H.shoulder, uvRw);
    L.shoulder.flatQuad(ptRw(rw, Ln, -W / 2), ptRw(rw, Ln + 60, -W / 2), ptRw(rw, Ln + 60, W / 2), ptRw(rw, Ln, W / 2), H.shoulder, uvRw);

    // Side stripes (runway edge lines).
    for (const s of [-1, 1]) {
      L.marks.rect(ptRw(rw, Ln / 2, s * (W / 2 - 1.2)), rw.dir, Ln / 2, 0.45, H.rwyMark, S[0], S[1], S[2], S[3], WHITE);
    }
    // Centreline dashes between the designators (30 m stripe / 20 m gap).
    const c0 = 90;
    const c1 = Ln - 90;
    for (let a = c0; a + 30 <= c1 + 0.01; a += 50) {
      L.marks.rect(ptRw(rw, a + 15, 0), rw.dir, 15, W >= 45 ? 0.45 : 0.3, H.rwyMark, S[0], S[1], S[2], S[3], WHITE);
    }

    for (const e of rw.ends) {
      const ein = L.endIndex[e.name];
      // Threshold piano keys.
      const count = W >= 60 ? 16 : W >= 45 ? 12 : W >= 30 ? 8 : 6;
      for (const s of [-1, 1]) {
        for (let k = 0; k < count / 2; k++) markEnd(e, 21, s * (2.7 + k * 3.6), 15, 0.9, WHITE);
      }
      // Designator: letter nearest the threshold, number beyond.
      const m = /^(\d{2})([LRC]?)$/.exec(e.name);
      const num = m ? m[1] : e.name;
      const letter = m ? m[2] : '';
      let a = 52.5;
      if (letter) {
        glyph(L.marks, ptEnd(e, a, 0), e.dir, letter, 9, H.rwyMark, WHITE);
        a += 15;
      }
      const gw = 9 * atlas.aspect;
      glyph(L.marks, ptEnd(e, a, -(gw / 2 + 0.9)), e.dir, num[0], 9, H.rwyMark, WHITE);
      glyph(L.marks, ptEnd(e, a, gw / 2 + 0.9), e.dir, num[1], 9, H.rwyMark, WHITE);
      // Aiming point and touchdown zone.
      if (Ln >= 1200) {
        for (const s of [-1, 1]) markEnd(e, 425, s * (W >= 45 ? 14 : 10), 25, W >= 45 ? 4 : 3, WHITE);
        const tdz: [number, number][] = [[150, 3], [300, 3], [600, 2], [750, 2], [900, 1], [1050, 1]];
        for (const [al, n] of tdz) {
          if (al + 25 > Ln / 2) continue;
          for (const s of [-1, 1]) for (let k = 0; k < n; k++) markEnd(e, al + 11.25, s * (10.9 + k * 3.3), 11.25, 0.9, WHITE);
        }
      }
      // Blast pad chevrons (yellow), pointing towards the runway.
      for (let k = 0; k < 4; k++) {
        const tip = ptEnd(e, -6 - k * 14, 0);
        for (const s of [-1, 1]) {
          const arm = ptEnd(e, -6 - k * 14 - W * 0.35, s * (W / 2 - 1.5));
          L.marks.ribbon(tip, arm, 1.0, H.rwyMark, solidUv, YELLOW);
        }
      }
      // Tyre rubber in the touchdown zone.
      const rl = W * 0.3;
      L.rubber.rect(ptEnd(e, 600, 0), e.dir, 520, rl, H.rubber, 0, 0, 1, 1);
      L.rubber.rect(ptEnd(e, 280, 0), e.dir, 180, rl * 0.9, H.rubber + 0.002, 0.05, 0.1, 0.95, 0.5);
    }

    // ---------------------------------------------------------------- runway lights
    const G = G_RWY + ri;
    for (const e of rw.ends) {
      const ein = L.endIndex[e.name];
      const other = rw.ends[e.index === 0 ? 1 : 0];
      void other;
      // Edge lights (both directions: last 600 m yellow).
      const nEdge = Math.max(2, Math.ceil(Ln / 60));
      for (let k = 0; k <= nEdge; k++) {
        const al = (k / nEdge) * Ln;
        const remaining = Ln - al;
        for (const s of [-1, 1]) {
          L.lights.push({ p: ptEnd(e, al, s * (W / 2 + 1.5)), h: 0.35, color: remaining < 600 ? L_YELLOW : L_WHITE, size: 0.9, group: G, dir: neg(e.dir), directional: 0.75 });
        }
      }
      // Centreline lights (in-pavement, strongly directional).
      const nCl = Math.floor(Ln / 15);
      for (let k = 1; k < nCl; k++) {
        const al = k * 15;
        const remaining = Ln - al;
        const col = remaining < 300 ? L_RED : remaining < 900 ? (k % 2 ? L_RED : L_WHITE) : L_WHITE;
        L.lights.push({ p: ptEnd(e, al, 0.6), h: 0.12, color: col, size: 0.55, group: G, dir: neg(e.dir), directional: 1 });
      }
      // Threshold (green, towards the approach) and runway end (red, towards the runway).
      for (let lat = -W / 2; lat <= W / 2 + 0.01; lat += 3) {
        L.lights.push({ p: ptEnd(e, -1.5, lat), h: 0.3, color: L_GREEN, size: 1.0, group: G, dir: neg(e.dir), directional: 0.85 });
        L.lights.push({ p: ptEnd(e, -1.5, lat), h: 0.3, color: L_RED, size: 0.9, group: G, dir: e.dir, directional: 0.9 });
      }
      if (e.approachLights === 'full') {
        // Wing bars.
        for (const s of [-1, 1]) {
          for (let k = 0; k < 5; k++) L.lights.push({ p: ptEnd(e, -1.5, s * (W / 2 + 3 + k * 3)), h: 0.4, color: L_GREEN, size: 1.0, group: G, dir: neg(e.dir), directional: 0.9 });
        }
        // Touchdown zone lights.
        for (let al = 60; al <= Math.min(900, Ln / 2); al += 30) {
          for (const s of [-1, 1]) for (let k = 0; k < 3; k++) L.lights.push({ p: ptEnd(e, al, s * (10.5 + k * 1.5)), h: 0.12, color: L_WHITE, size: 0.45, group: G, dir: neg(e.dir), directional: 1 });
        }
      }
      // ---- approach lighting system
      const GA = G_APP + ein;
      if (e.approachLights === 'full') {
        for (let al = -30; al >= -900; al -= 30) {
          for (let k = -2; k <= 2; k++) L.lights.push({ p: ptEnd(e, al, k * 1.05), h: 1.0, color: L_WHITE, size: 0.85, group: GA, dir: neg(e.dir), directional: 0.85 });
          if (al >= -270) {
            for (const s of [-1, 1]) for (let k = 0; k < 3; k++) L.lights.push({ p: ptEnd(e, al, s * (10.5 + k * 1.5)), h: 1.0, color: L_RED, size: 0.8, group: GA, dir: neg(e.dir), directional: 0.85 });
          }
        }
        for (let lat = -15; lat <= 15.01; lat += 1.5) {
          if (Math.abs(lat) < 2.5) continue;
          L.lights.push({ p: ptEnd(e, -300, lat), h: 1.0, color: L_WHITE, size: 0.85, group: GA, dir: neg(e.dir), directional: 0.85 });
        }
        for (let lat = -7.5; lat <= 7.51; lat += 1.5) {
          if (Math.abs(lat) < 2.5) continue;
          L.lights.push({ p: ptEnd(e, -150, lat), h: 1.0, color: L_WHITE, size: 0.8, group: GA, dir: neg(e.dir), directional: 0.85 });
        }
        // Sequenced flashers ("the rabbit"), running towards the threshold twice a second.
        const flashers: number[] = [];
        for (let al = -900; al <= -330; al += 30) flashers.push(al);
        flashers.forEach((al, k) => {
          L.lights.push({ p: ptEnd(e, al, 0), h: 1.6, color: L_FLASH, size: 1.6, group: GA, dir: neg(e.dir), directional: 0.8, flashPeriod: 0.5, flashPhase: (k / flashers.length) * 0.7, flashDuty: 0.045 });
        });
      } else if (e.approachLights === 'simple') {
        for (let al = -60; al >= -420; al -= 60) L.lights.push({ p: ptEnd(e, al, 0), h: 1.0, color: L_WHITE, size: 0.9, group: GA, dir: neg(e.dir), directional: 0.85 });
        for (let lat = -15; lat <= 15.01; lat += 2) {
          if (Math.abs(lat) < 1) continue;
          L.lights.push({ p: ptEnd(e, -300, lat), h: 1.0, color: L_WHITE, size: 0.85, group: GA, dir: neg(e.dir), directional: 0.85 });
        }
      }
      // ---- PAPI (left side, abeam the glide path origin; nearest unit set highest)
      if (e.papi) {
        const angles = [3.5, 3.17, 2.83, 2.5];
        angles.forEach((ang, k) => {
          L.lights.push({ p: ptEnd(e, 290, -(W / 2 + 15 + k * 9)), h: 0.9, color: L_WHITE, size: 1.3, group: G_PAPI + ein, dir: neg(e.dir), directional: 1, papi: ang });
        });
      }
    }
  }

  // ------------------------------------------------------------------ taxiways and aprons
  const uvWorld = (s: number) => (x: number, y: number): Vec2 => [x / s, y / s];
  const asphUv = uvWorld(24);
  const concUv = uvWorld(15);
  for (const ap of def.aprons) L.apron.flatPoly(ap.polygon, H.apron, concUv);

  const edges = model.edges.filter((e) => e.kind !== 'runway');
  const segOf = (e: (typeof edges)[number]): [Vec2, Vec2] => [[model.nodes[e.a].x, model.nodes[e.a].y], [model.nodes[e.b].x, model.nodes[e.b].y]];
  for (const e of edges) {
    const [a, b] = segOf(e);
    if (e.kind === 'taxilane') L.apron.ribbon(a, b, e.width, H.apron, concUv);
    else L.taxi.ribbon(a, b, e.width, H.taxi, asphUv);
  }
  // Joins / fillets.
  for (const n of model.nodes) {
    const inc = n.edges.map((id) => model.edges[id]).filter((e) => e.kind !== 'runway');
    if (!inc.length) continue;
    const p: Vec2 = [n.x, n.y];
    const maxW = Math.max(...inc.map((e) => e.width));
    const paved = inc.some((e) => e.kind !== 'taxilane');
    if (n.runwayId) {
      // Fillets where the taxiway meets the runway edge.
      const rw = model.runwayById(n.runwayId);
      for (const e of inc) {
        const o = model.nodes[model.otherNode(e, n.id)];
        const lo = model.runwayLocal(rw, o.x, o.y);
        const ln = model.runwayLocal(rw, n.x, n.y);
        const edgeLat = (Math.sign(lo.lat - ln.lat) || 1) * (rw.width / 2 + 2);
        const t = (edgeLat - ln.lat) / (lo.lat - ln.lat || 1e-6);
        if (t > 0 && t < 1) {
          const q: Vec2 = [n.x + (o.x - n.x) * t, n.y + (o.y - n.y) * t];
          L.taxi.disc(q, e.width / 2 + 9, H.taxi - 0.004, asphUv, 24);
        }
      }
      continue;
    }
    let sharp = inc.length >= 3;
    if (inc.length === 2) {
      const d0 = model.nodes[model.otherNode(inc[0], n.id)];
      const d1 = model.nodes[model.otherNode(inc[1], n.id)];
      const v0: Vec2 = [d0.x - n.x, d0.y - n.y];
      const v1: Vec2 = [d1.x - n.x, d1.y - n.y];
      const cos = (v0[0] * v1[0] + v0[1] * v1[1]) / (Math.hypot(...v0) * Math.hypot(...v1));
      sharp = cos > -0.9;
    }
    const r = (maxW / 2) * (sharp ? 1.45 : 1.02);
    if (paved) L.taxi.disc(p, r, H.taxi - 0.003, asphUv, 24);
    else L.apron.disc(p, r, H.apron, concUv, 20);
  }

  // Taxiway centrelines (clipped out of the runway pavement).
  const insideRunwayT = (a: Vec2, b: Vec2): [number, number][] => {
    const out: [number, number][] = [];
    for (const rw of model.runways) {
      const la = model.runwayLocal(rw, a[0], a[1]);
      const lb = model.runwayLocal(rw, b[0], b[1]);
      let t0 = 0;
      let t1 = 1;
      const hw = rw.width / 2 + 1;
      const clip = (p: number, q: number): boolean => {
        if (Math.abs(p) < 1e-12) return q >= 0;
        const r = q / p;
        if (p < 0) {
          if (r > t1) return false;
          if (r > t0) t0 = r;
        } else {
          if (r < t0) return false;
          if (r < t1) t1 = r;
        }
        return true;
      };
      const dS = lb.along - la.along;
      const dL = lb.lat - la.lat;
      if (clip(-dS, la.along + 1) && clip(dS, rw.length + 1 - la.along) && clip(-dL, la.lat + hw) && clip(dL, hw - la.lat) && t1 > t0) out.push([t0, t1]);
    }
    return out;
  };
  const outsidePieces = (a: Vec2, b: Vec2): [Vec2, Vec2][] => {
    const cuts = insideRunwayT(a, b).sort((x, y) => x[0] - y[0]);
    const pieces: [number, number][] = [];
    let t = 0;
    for (const [c0, c1] of cuts) {
      if (c0 > t) pieces.push([t, c0]);
      t = Math.max(t, c1);
    }
    if (t < 1) pieces.push([t, 1]);
    const lerp2 = (u: number): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    return pieces.map(([p0, p1]) => [lerp2(p0), lerp2(p1)]);
  };
  for (const e of edges) {
    const [a, b] = segOf(e);
    for (const [p, q] of outsidePieces(a, b)) L.marks.ribbon(p, q, 0.4, H.taxiMark, solidUv, YELLOW);
  }

  // ------------------------------------------------------------------ holding points
  const allEnds = Object.values(model.ends);
  void allEnds;
  for (const n of model.nodes) {
    if (!n.holdFor.length || n.runwayId) continue;
    for (const rid of n.holdFor) {
      const e = n.edges.map((id) => model.edges[id]).find((ed) => ed.kind !== 'runway' && ed.zones.includes(rid));
      if (!e) continue;
      const o = model.nodes[model.otherNode(e, n.id)];
      const len = Math.hypot(o.x - n.x, o.y - n.y) || 1;
      const dIn: Vec2 = [(o.x - n.x) / len, (o.y - n.y) / len];
      const outer = n.edges.map((id) => model.edges[id]).find((ed) => ed.kind !== 'runway' && !ed.zones.includes(rid));
      L.holds.push({ node: n.id, runwayId: rid, runwayIndex: L.runwayIndex[rid], p: [n.x, n.y], dIn, width: e.width, taxiway: (outer ?? e).name });
    }
  }
  for (const h of L.holds) {
    const { p, dIn, width: w } = h;
    const r: Vec2 = [dIn[1], -dIn[0]];
    // Pattern A: two solid lines (holding side), two dashed (runway side).
    for (const off of [-0.9, -0.3]) L.marks.rect(add(p, dIn, off), dIn, 0.15, w / 2, H.taxiMark + 0.004, S[0], S[1], S[2], S[3], YELLOW);
    for (const off of [0.3, 0.9]) {
      for (let lat = -w / 2 + 0.5; lat <= w / 2 - 0.5; lat += 2) {
        L.marks.rect(add(add(p, dIn, off), r, lat), dIn, 0.15, 0.5, H.taxiMark + 0.004, S[0], S[1], S[2], S[3], YELLOW);
      }
    }
    // Mandatory instruction marking (red box, white runway designation) before the hold.
    const text = h.runwayId.replace('/', '-');
    const gh = 1.8;
    const boxW = text.length * gh * atlas.aspect * 1.12 + 1.2;
    for (const s of w > 20 ? [-1, 1] : [0]) {
      const c = add(add(p, dIn, -5), r, s * w * 0.24);
      L.marks.rect(c, dIn, gh * 0.75, boxW / 2, H.taxiMark + 0.003, S[0], S[1], S[2], S[3], RED);
      groundText(c, dIn, text, gh, H.taxiMark + 0.006, WHITE);
    }
    // Signs: location (yellow on black) + mandatory (white on red), both sides.
    for (const s of [-1, 1]) {
      const base = add(add(p, dIn, -1.5), r, s * (w / 2 + 9));
      buildSign(L, atlas, base, neg(dIn), h.taxiway, text);
    }
    // Stop bar and runway guard lights.
    const G = G_STOP + h.runwayIndex;
    for (let lat = -w / 2 + 1.5; lat <= w / 2 - 1.4; lat += 3) {
      L.lights.push({ p: add(add(p, dIn, -0.3), r, lat), h: 0.12, color: L_RED, size: 0.5, group: G, dir: neg(dIn), directional: 0.8 });
    }
    for (const s of [-1, 1]) {
      for (const k of [0, 1]) {
        L.lights.push({ p: add(add(p, dIn, -1), r, s * (w / 2 + 3 + k * 0.8)), h: 0.9, color: L_YELLOW, size: 0.55, group: G, dir: neg(dIn), directional: 0.7, flashPeriod: 1.0, flashPhase: k * 0.5, flashDuty: 0.5 });
      }
    }
  }

  // ------------------------------------------------------------------ taxiway lights
  const rwyZone = (q: Vec2, margin: number): boolean => {
    for (const rw of model.runways) {
      const l = model.runwayLocal(rw, q[0], q[1]);
      if (l.along > -60 && l.along < rw.length + 60 && Math.abs(l.lat) < rw.width / 2 + margin) return true;
    }
    return false;
  };
  const segs = edges.map((e) => ({ e, s: segOf(e) }));
  for (const { e, s } of segs) {
    if (e.kind === 'taxilane') continue;
    const [a, b] = s;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d: Vec2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const r: Vec2 = [d[1], -d[0]];
    // Centreline (green; alternating green/yellow inside a runway protected area).
    const nc = Math.max(1, Math.round(len / 15));
    for (let k = 0; k < nc; k++) {
      const q = add(a, d, ((k + 0.5) / nc) * len);
      if (rwyZone(q, 1)) continue;
      const col = e.zones.length && k % 2 ? L_YELLOW : L_GREEN;
      L.lights.push({ p: q, h: 0.08, color: col, size: 0.42, group: G_TAXI_CL });
    }
    // Edge lights (blue), skipped where the edge borders other pavement.
    const ne = Math.max(1, Math.round(len / 45));
    for (let k = 0; k <= ne; k++) {
      for (const sd of [-1, 1]) {
        const q = add(add(a, d, (k / ne) * len), r, sd * (e.width / 2 + 1.2));
        if (rwyZone(q, 9)) continue;
        if (def.aprons.some((ap) => pointInPoly(q, ap.polygon))) continue;
        let covered = false;
        for (const o of segs) {
          if (o.e === e) continue;
          if (distToSeg(q, o.s[0], o.s[1]) < o.e.width / 2 + 1) {
            covered = true;
            break;
          }
        }
        if (covered) continue;
        L.lights.push({ p: q, h: 0.35, color: L_BLUE, size: 0.55, group: G_TAXI_EDGE });
      }
    }
  }

  // ------------------------------------------------------------------ stands
  const STAND_LEN: Record<string, number> = { S: 36, M: 48, L: 70, H: 78 };
  for (const g of model.gates) {
    const hr = (g.hdg * Math.PI) / 180;
    const f: Vec2 = [Math.sin(hr), Math.cos(hr)];
    const r: Vec2 = [f[1], -f[0]];
    const len = STAND_LEN[g.size] ?? 50;
    const start = add(g.pos, f, -len);
    L.marks.ribbon(start, add(g.pos, f, 1.5), 0.3, H.taxiMark, solidUv, YELLOW);
    const spot = model.nodes[g.spotNode];
    const sp: Vec2 = [spot.x, spot.y];
    if (Math.hypot(sp[0] - start[0], sp[1] - start[1]) > 3) {
      // Curved lead-in from the taxilane: quadratic arc tangent to the stand centreline.
      const ctrl = add(start, f, -Math.min(30, Math.hypot(sp[0] - start[0], sp[1] - start[1]) * 0.6));
      let prev = sp;
      for (let k = 1; k <= 12; k++) {
        const t = k / 12;
        const a = (1 - t) * (1 - t);
        const b = 2 * (1 - t) * t;
        const c = t * t;
        const q: Vec2 = [a * sp[0] + b * ctrl[0] + c * start[0], a * sp[1] + b * ctrl[1] + c * start[1]];
        L.marks.ribbon(prev, q, 0.3, H.taxiMark, solidUv, YELLOW);
        prev = q;
      }
    }
    // Stop line and stand number.
    L.marks.rect(add(g.pos, f, 0.5), f, 0.25, 2.2, H.taxiMark + 0.002, S[0], S[1], S[2], S[3], YELLOW);
    groundText(add(g.pos, f, -len * 0.45), f, g.id.toUpperCase(), 2.4, H.taxiMark + 0.002, YELLOW);
    // Stand safety envelope corners (red).
    const halfSpan = len * 0.5;
    for (const s of [-1, 1]) {
      L.marks.rect(add(add(g.pos, r, s * halfSpan), f, -len * 0.5), f, len * 0.5, 0.12, H.taxiMark + 0.001, S[0], S[1], S[2], S[3], RED);
    }
    L.marks.rect(add(g.pos, f, 3), f, 0.12, halfSpan, H.taxiMark + 0.001, S[0], S[1], S[2], S[3], RED);
  }
  return L;
}

/** A taxiway sign pair (location + mandatory) facing `face` (sim unit vector). */
function buildSign(L: Layout, atlas: Atlas, base: Vec2, face: Vec2, loc: string, rwy: string): void {
  const gh = 0.62;
  const gw = gh * atlas.aspect;
  const pad = 0.25;
  const locW = loc.length * gw * 1.1 + pad * 2;
  const rwyW = rwy.length * gw * 1.1 + pad * 2;
  const total = locW + rwyW;
  const h0 = 0.45;
  const h1 = 1.35;
  // Right of the viewer (viewer looks along -face).
  const r: Vec2 = [-face[1], face[0]];
  const body0 = add(base, r, -total / 2 - 0.1);
  const body1 = add(base, r, total / 2 + 0.1);
  const back = add(base, face, -0.35);
  const grey = new THREE.Color('#3a3a3a');
  L.signBody.box([(base[0] + back[0]) / 2, (base[1] + back[1]) / 2], (Math.atan2(r[0], r[1]) * 180) / Math.PI, total + 0.2, 0.34, h0 - 0.05, h1 + 0.05, 1, 1, grey);
  L.signBody.box(add(body0, face, -0.17), 0, 0.12, 0.12, 0, h0, 1, 1, grey);
  L.signBody.box(add(body1, face, -0.17), 0, 0.12, 0.12, 0, h0, 1, 1, grey);
  const S = atlas.solid;
  const panel = (c0: number, c1: number, color: THREE.Color): void => vquad(L.signFaces, add(base, r, c0), add(base, r, c1), face, h0, h1, S[0], S[1], S[2], S[3], color, 0.01);
  const x0 = -total / 2;
  panel(x0, x0 + locW, BLACK);
  panel(x0 + locW, total / 2, RED);
  const text = (start: number, str: string, color: THREE.Color): void => {
    for (let k = 0; k < str.length; k++) {
      const c = start + pad + gw / 2 + k * gw * 1.1;
      const g = atlas.glyph(str[k]);
      vquad(L.signFaces, add(base, r, c - gw / 2), add(base, r, c + gw / 2), face, (h0 + h1) / 2 - gh / 2, (h0 + h1) / 2 + gh / 2, g[0], g[1], g[2], g[3], color, 0.02);
    }
  };
  text(x0, loc, YELLOW);
  text(x0 + locW, rwy, WHITE);
}

/** Vertical quad from a to b (left to right as seen by a viewer facing -face). */
function vquad(buf: GeoBuf, a: Vec2, b: Vec2, face: Vec2, h0: number, h1: number, u0: number, v0: number, u1: number, v1: number, color: THREE.Color, offset: number): void {
  const A = add(a, face, offset);
  const B = add(b, face, offset);
  const nx = face[0];
  const nz = -face[1];
  const i0 = buf.vert(A[0], h0, -A[1], nx, 0, nz, u0, v0, color);
  const i1 = buf.vert(B[0], h0, -B[1], nx, 0, nz, u1, v0, color);
  const i2 = buf.vert(B[0], h1, -B[1], nx, 0, nz, u1, v1, color);
  const i3 = buf.vert(A[0], h1, -A[1], nx, 0, nz, u0, v1, color);
  buf.tri(i0, i1, i2);
  buf.tri(i0, i2, i3);
}
