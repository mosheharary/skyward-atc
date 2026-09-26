// Runtime airport model: runway frames, a taxi graph built by splitting every taxiway /
// runway polyline at intersections, automatic hold-short points at runway protected-area
// boundaries, departure entries, landing exits, gate push-back spots and A* routing.

import { DEG, clamp, wrap360 } from '../core/units';
import type {
  AirportDef,
  ApproachLights,
  FixDef,
  GateDef,
  RunwayConfigDef,
  TaxiKind,
  Vec2,
} from './airports/types';

export const HOLD_DIST = 75;
const ZONE_END_MARGIN = 60;
const MERGE_TOL = 2;

export interface RunwayEnd {
  name: string;
  runwayId: string;
  index: 0 | 1;
  threshold: Vec2;
  far: Vec2;
  hdg: number;
  dir: Vec2;
  right: Vec2;
  length: number;
  width: number;
  ils: boolean;
  approachLights: ApproachLights;
  papi: boolean;
}

export interface Runway {
  id: string;
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  right: Vec2;
  length: number;
  width: number;
  ends: [RunwayEnd, RunwayEnd];
}

export interface TaxiNode {
  id: number;
  x: number;
  y: number;
  edges: number[];
  /** Runway id if the node lies on a runway centreline. */
  runwayId: string | null;
  /** Runway ids whose protected area boundary this node sits on. */
  holdFor: string[];
}

export interface TaxiEdge {
  id: number;
  a: number;
  b: number;
  len: number;
  name: string;
  width: number;
  kind: TaxiKind | 'runway';
  runwayId: string | null;
  /** Runway protected areas this edge lies inside. */
  zones: string[];
}

export interface DepartureEntry {
  end: string;
  holdNode: number;
  junctionNode: number;
  /** Points from the hold node to the junction on the centreline. */
  path: Vec2[];
}

export interface RunwayExit {
  end: string;
  junctionNode: number;
  edge: number;
  /** Distance from the landing threshold (m). */
  along: number;
  /** Turn-off angle relative to the landing direction (deg). */
  angle: number;
  /** +1 = to the right of the landing direction, -1 = left. */
  side: number;
  maxSpeedKt: number;
}

export interface GateInfo extends GateDef {
  spotNode: number;
}

export interface TaxiRoute {
  nodes: number[];
  points: Vec2[];
  /** Taxiway names in order (compressed) for phraseology. */
  names: string[];
  /** Hold points along the route: index into points where the aircraft must stop unless cleared. */
  holds: { idx: number; runwayId: string; exitIdx: number }[];
  length: number;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (v: Vec2): number => Math.hypot(v[0], v[1]);

function localOf(rw: { a: Vec2; dir: Vec2; right: Vec2 }, x: number, y: number): { along: number; lat: number } {
  const dx = x - rw.a[0];
  const dy = y - rw.a[1];
  return { along: dx * rw.dir[0] + dy * rw.dir[1], lat: dx * rw.right[0] + dy * rw.right[1] };
}

interface Seg {
  p: Vec2;
  q: Vec2;
  name: string;
  width: number;
  kind: TaxiKind | 'runway';
  runwayId: string | null;
  splits: number[];
}

export class AirportModel {
  readonly def: AirportDef;
  readonly runways: Runway[] = [];
  readonly ends: Record<string, RunwayEnd> = {};
  readonly nodes: TaxiNode[] = [];
  readonly edges: TaxiEdge[] = [];
  readonly gates: GateInfo[] = [];
  readonly gateById: Record<string, GateInfo> = {};
  readonly fixes: Record<string, FixDef> = {};
  readonly departureEntries: Record<string, DepartureEntry[]> = {};
  readonly exits: Record<string, RunwayExit[]> = {};
  readonly airspaceRadiusM: number;
  private grid = new Map<string, number[]>();

  constructor(def: AirportDef) {
    this.def = def;
    this.airspaceRadiusM = def.airspace.radiusNm * 1852;
    for (const f of def.fixes) this.fixes[f.id] = f;
    this.buildRunways();
    this.buildGraph();
    this.insertHolds();
    this.buildGates();
    this.buildEntriesAndExits();
  }

  // ------------------------------------------------------------------ runways
  private buildRunways(): void {
    for (const r of this.def.runways) {
      const d = sub(r.b, r.a);
      const length = len2(d);
      const dir: Vec2 = [d[0] / length, d[1] / length];
      const right: Vec2 = [dir[1], -dir[0]];
      const id = `${r.ends[0].name}/${r.ends[1].name}`;
      const hdg0 = wrap360(Math.atan2(dir[0], dir[1]) / DEG);
      const mk = (i: 0 | 1): RunwayEnd => {
        const e = r.ends[i];
        const s = i === 0 ? 1 : -1;
        const edir: Vec2 = [dir[0] * s, dir[1] * s];
        return {
          name: e.name,
          runwayId: id,
          index: i,
          threshold: i === 0 ? r.a : r.b,
          far: i === 0 ? r.b : r.a,
          hdg: i === 0 ? hdg0 : wrap360(hdg0 + 180),
          dir: edir,
          right: [edir[1], -edir[0]],
          length,
          width: r.width,
          ils: e.ils,
          approachLights: e.approachLights,
          papi: e.papi,
        };
      };
      const rw: Runway = { id, a: r.a, b: r.b, dir, right, length, width: r.width, ends: [mk(0), mk(1)] };
      this.runways.push(rw);
      this.ends[rw.ends[0].name] = rw.ends[0];
      this.ends[rw.ends[1].name] = rw.ends[1];
    }
  }

  runwayById(id: string): Runway {
    const r = this.runways.find((x) => x.id === id);
    if (!r) throw new Error(`Unknown runway ${id}`);
    return r;
  }

  runwayOfEnd(endName: string): Runway {
    return this.runwayById(this.ends[endName].runwayId);
  }

  /** Local coordinates relative to a runway end (along from threshold in landing direction, lat to the right). */
  endLocal(end: RunwayEnd, x: number, y: number): { along: number; lat: number } {
    return localOf({ a: end.threshold, dir: end.dir, right: end.right }, x, y);
  }

  runwayLocal(rw: Runway, x: number, y: number): { along: number; lat: number } {
    return localOf(rw, x, y);
  }

  /** True if (x,y) is on the runway surface (with lateral margin). */
  onRunway(rw: Runway, x: number, y: number, latMargin = 12, endMargin = 30): boolean {
    const l = localOf(rw, x, y);
    return l.along >= -endMargin && l.along <= rw.length + endMargin && Math.abs(l.lat) <= rw.width / 2 + latMargin;
  }

  /** True if inside the runway protected area (hold-short boundary). */
  inProtectedArea(rw: Runway, x: number, y: number, shrink = 1): boolean {
    const l = localOf(rw, x, y);
    return (
      l.along >= -ZONE_END_MARGIN + shrink &&
      l.along <= rw.length + ZONE_END_MARGIN - shrink &&
      Math.abs(l.lat) <= HOLD_DIST - shrink
    );
  }

  // -------------------------------------------------------------------- graph
  private nodeAt(x: number, y: number, runwayId: string | null): number {
    const gx = Math.floor(x / 10);
    const gy = Math.floor(y / 10);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.grid.get(`${gx + i},${gy + j}`);
        if (!list) continue;
        for (const id of list) {
          const n = this.nodes[id];
          if (Math.hypot(n.x - x, n.y - y) <= MERGE_TOL) {
            if (runwayId && !n.runwayId) n.runwayId = runwayId;
            return id;
          }
        }
      }
    }
    const id = this.nodes.length;
    this.nodes.push({ id, x, y, edges: [], runwayId, holdFor: [] });
    const key = `${gx},${gy}`;
    const list = this.grid.get(key);
    if (list) list.push(id);
    else this.grid.set(key, [id]);
    return id;
  }

  private addEdge(a: number, b: number, s: { name: string; width: number; kind: TaxiKind | 'runway'; runwayId: string | null }): void {
    if (a === b) return;
    const na = this.nodes[a];
    const nb = this.nodes[b];
    const len = Math.hypot(nb.x - na.x, nb.y - na.y);
    if (len < 0.5) return;
    if (na.edges.some((eid) => {
      const e = this.edges[eid];
      return (e.a === a && e.b === b) || (e.a === b && e.b === a);
    })) return;
    const id = this.edges.length;
    this.edges.push({ id, a, b, len, name: s.name, width: s.width, kind: s.kind, runwayId: s.runwayId, zones: [] });
    na.edges.push(id);
    nb.edges.push(id);
  }

  private buildGraph(): void {
    const segs: Seg[] = [];
    for (const rw of this.runways) {
      segs.push({ p: rw.a, q: rw.b, name: `RWY ${rw.id}`, width: rw.width, kind: 'runway', runwayId: rw.id, splits: [0, 1] });
    }
    for (const t of this.def.taxiways) {
      for (let i = 0; i < t.points.length - 1; i++) {
        segs.push({ p: t.points[i], q: t.points[i + 1], name: t.name, width: t.width ?? 23, kind: t.kind ?? 'taxiway', runwayId: null, splits: [0, 1] });
      }
    }
    // Pairwise intersections (including T-junctions within tolerance).
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i];
        const b = segs[j];
        const r = sub(a.q, a.p);
        const s = sub(b.q, b.p);
        const la = len2(r);
        const lb = len2(s);
        const denom = r[0] * s[1] - r[1] * s[0];
        if (Math.abs(denom) > 1e-6 * la * lb) {
          const qp = sub(b.p, a.p);
          const t = (qp[0] * s[1] - qp[1] * s[0]) / denom;
          const u = (qp[0] * r[1] - qp[1] * r[0]) / denom;
          const ea = MERGE_TOL / la;
          const eb = MERGE_TOL / lb;
          if (t >= -ea && t <= 1 + ea && u >= -eb && u <= 1 + eb) {
            a.splits.push(clamp(t, 0, 1));
            b.splits.push(clamp(u, 0, 1));
          }
        }
        // Endpoint proximity (handles near-parallel T-junctions).
        for (const [x, y, other, self, selfT] of [
          [a.p, 0, b, a, 0],
          [a.q, 0, b, a, 1],
          [b.p, 0, a, b, 0],
          [b.q, 0, a, b, 1],
        ] as [Vec2, number, Seg, Seg, number][]) {
          void y;
          const d = sub(other.q, other.p);
          const L2 = d[0] * d[0] + d[1] * d[1];
          const u = ((x[0] - other.p[0]) * d[0] + (x[1] - other.p[1]) * d[1]) / L2;
          if (u < 0 || u > 1) continue;
          const px = other.p[0] + d[0] * u;
          const py = other.p[1] + d[1] * u;
          if (Math.hypot(px - x[0], py - x[1]) <= MERGE_TOL) {
            other.splits.push(u);
            self.splits.push(selfT);
          }
        }
      }
    }
    for (const s of segs) {
      const ts = [...new Set(s.splits.map((t) => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
      let prev = -1;
      for (const t of ts) {
        const x = s.p[0] + (s.q[0] - s.p[0]) * t;
        const y = s.p[1] + (s.q[1] - s.p[1]) * t;
        const id = this.nodeAt(x, y, s.runwayId);
        if (prev >= 0) this.addEdge(prev, id, s);
        prev = id;
      }
    }
  }

  private splitEdge(edgeId: number, t: number): number {
    const e = this.edges[edgeId];
    const na = this.nodes[e.a];
    const nb = this.nodes[e.b];
    const x = na.x + (nb.x - na.x) * t;
    const y = na.y + (nb.y - na.y) * t;
    const mid = this.nodeAt(x, y, null);
    if (mid === e.a || mid === e.b) return mid;
    // Re-point the existing edge to (a, mid) and add (mid, b).
    nb.edges = nb.edges.filter((id) => id !== edgeId);
    e.b = mid;
    e.len = Math.hypot(this.nodes[mid].x - na.x, this.nodes[mid].y - na.y);
    this.nodes[mid].edges.push(edgeId);
    const id = this.edges.length;
    const len = Math.hypot(nb.x - this.nodes[mid].x, nb.y - this.nodes[mid].y);
    this.edges.push({ id, a: mid, b: nb.id, len, name: e.name, width: e.width, kind: e.kind, runwayId: e.runwayId, zones: [...e.zones] });
    this.nodes[mid].edges.push(id);
    nb.edges.push(id);
    return mid;
  }

  private insertHolds(): void {
    for (const rw of this.runways) {
      const s0 = -ZONE_END_MARGIN;
      const s1 = rw.length + ZONE_END_MARGIN;
      const edgeCount = this.edges.length;
      for (let eid = 0; eid < edgeCount; eid++) {
        const e = this.edges[eid];
        if (e.kind === 'runway') continue;
        const A = this.nodes[e.a];
        const B = this.nodes[e.b];
        const la = localOf(rw, A.x, A.y);
        const lb = localOf(rw, B.x, B.y);
        // Liang-Barsky clip against along in [s0,s1], lat in [-H,H].
        const dS = lb.along - la.along;
        const dL = lb.lat - la.lat;
        let t0 = 0;
        let t1 = 1;
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
        if (!clip(-dS, la.along - s0) || !clip(dS, s1 - la.along) || !clip(-dL, la.lat + HOLD_DIST) || !clip(dL, HOLD_DIST - la.lat)) continue;
        if (t1 - t0 < 1e-6) continue;
        const cuts: number[] = [];
        if (t0 > 1e-4) cuts.push(t0);
        if (t1 < 1 - 1e-4) cuts.push(t1);
        // Endpoints exactly on the boundary are hold points too.
        if (t0 <= 1e-4 && Math.abs(Math.abs(la.lat) - HOLD_DIST) < 1) this.markHold(e.a, rw.id);
        if (t1 >= 1 - 1e-4 && Math.abs(Math.abs(lb.lat) - HOLD_DIST) < 1) this.markHold(e.b, rw.id);
        // Split from the far end first so earlier parameters stay valid.
        cuts.sort((x, y) => y - x);
        let curEdge = eid;
        let scale = 1;
        const created: number[] = [];
        for (const t of cuts) {
          const node = this.splitEdge(curEdge, t / scale);
          created.push(node);
          scale = t;
        }
        void curEdge;
        for (const n of created) this.markHold(n, rw.id);
      }
      // Mark every edge whose midpoint lies inside the protected area.
      for (const e of this.edges) {
        const A = this.nodes[e.a];
        const B = this.nodes[e.b];
        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2;
        if (this.inProtectedArea(rw, mx, my, 0.5) && !e.zones.includes(rw.id)) e.zones.push(rw.id);
      }
    }
  }

  private markHold(node: number, runwayId: string): void {
    const n = this.nodes[node];
    if (!n.holdFor.includes(runwayId)) n.holdFor.push(runwayId);
  }

  // -------------------------------------------------------------------- gates
  private buildGates(): void {
    for (const g of this.def.gates) {
      const back: Vec2 = [-Math.sin(g.hdg * DEG), -Math.cos(g.hdg * DEG)];
      let best: { edge: number; t: number; d: number } | null = null;
      for (const e of this.edges) {
        if (e.kind === 'runway' || e.zones.length) continue;
        const A = this.nodes[e.a];
        const B = this.nodes[e.b];
        const s: Vec2 = [B.x - A.x, B.y - A.y];
        const denom = back[0] * s[1] - back[1] * s[0];
        if (Math.abs(denom) < 1e-9) continue;
        const qp: Vec2 = [A.x - g.pos[0], A.y - g.pos[1]];
        const d = (qp[0] * s[1] - qp[1] * s[0]) / denom;
        const t = (qp[0] * back[1] - qp[1] * back[0]) / denom;
        if (d < 20 || d > 260 || t < 0 || t > 1) continue;
        if (!best || d < best.d) best = { edge: e.id, t, d };
      }
      let spot: number;
      if (best) {
        const e = this.edges[best.edge];
        const L = e.len;
        const tt = best.t;
        if (tt * L < 3) spot = e.a;
        else if ((1 - tt) * L < 3) spot = e.b;
        else spot = this.splitEdge(best.edge, tt);
      } else {
        spot = this.nearestNode(g.pos[0], g.pos[1], (n) => !n.runwayId && n.holdFor.length === 0);
      }
      const info: GateInfo = { ...g, spotNode: spot };
      this.gates.push(info);
      this.gateById[g.id] = info;
    }
  }

  // ------------------------------------------------------- entries and exits
  private buildEntriesAndExits(): void {
    for (const rw of this.runways) {
      for (const end of rw.ends) {
        const entries: DepartureEntry[] = [];
        const exits: RunwayExit[] = [];
        for (const n of this.nodes) {
          if (n.runwayId !== rw.id) continue;
          const loc = this.endLocal(end, n.x, n.y);
          for (const eid of n.edges) {
            const e = this.edges[eid];
            if (e.kind === 'runway') continue;
            const other = this.nodes[e.a === n.id ? e.b : e.a];
            const v: Vec2 = [other.x - n.x, other.y - n.y];
            const vl = len2(v);
            const cosA = (v[0] * end.dir[0] + v[1] * end.dir[1]) / vl;
            const angle = Math.acos(clamp(cosA, -1, 1)) / DEG;
            const side = Math.sign(v[0] * end.right[0] + v[1] * end.right[1]) || 1;
            if (loc.along >= -15 && loc.along <= 120) {
              const walk = this.walkToHold(n.id, eid, rw.id);
              if (walk) entries.push({ end: end.name, holdNode: walk.hold, junctionNode: n.id, path: walk.points.slice().reverse() });
            }
            if (loc.along >= 250 && loc.along <= end.length - 40 && angle <= 100 && this.exitLeadsSomewhere(n.id, eid, rw.id)) {
              exits.push({ end: end.name, junctionNode: n.id, edge: eid, along: loc.along, angle, side, maxSpeedKt: angle <= 45 ? 45 : 16 });
            }
          }
        }
        exits.sort((a, b) => a.along - b.along);
        this.departureEntries[end.name] = entries;
        this.exits[end.name] = exits;
      }
    }
  }

  /** An exit is usable if, once clear of the runway, a taxi route to the gates exists. */
  private exitLeadsSomewhere(junction: number, edge: number, runwayId: string): boolean {
    const walk = this.walkToHold(junction, edge, runwayId);
    if (!walk || this.gates.length === 0) return false;
    const last = walk.nodes[walk.nodes.length - 1];
    const prev = walk.nodes[walk.nodes.length - 2];
    return this.route(last, this.gates[0].spotNode, { avoidFirstNode: prev }) !== null;
  }

  /** Walk from a runway junction along a taxiway until a hold node for that runway. */
  walkToHold(startNode: number, firstEdge: number, runwayId: string): { hold: number; points: Vec2[]; nodes: number[] } | null {
    let node = startNode;
    let edge = firstEdge;
    const pts: Vec2[] = [[this.nodes[node].x, this.nodes[node].y]];
    const nodes = [node];
    for (let i = 0; i < 12; i++) {
      const e = this.edges[edge];
      const next = e.a === node ? e.b : e.a;
      pts.push([this.nodes[next].x, this.nodes[next].y]);
      nodes.push(next);
      if (this.nodes[next].holdFor.includes(runwayId)) return { hold: next, points: pts, nodes };
      // Continue straight-ish along the same taxiway.
      const cur = this.nodes[next];
      const dirIn: Vec2 = [cur.x - this.nodes[node].x, cur.y - this.nodes[node].y];
      let bestEdge = -1;
      let bestDot = -2;
      for (const eid of cur.edges) {
        if (eid === edge) continue;
        const ee = this.edges[eid];
        if (ee.kind === 'runway') continue;
        const o = this.nodes[ee.a === next ? ee.b : ee.a];
        const v: Vec2 = [o.x - cur.x, o.y - cur.y];
        const dot = (v[0] * dirIn[0] + v[1] * dirIn[1]) / (len2(v) * len2(dirIn));
        const sameName = ee.name === e.name ? 0.5 : 0;
        if (dot + sameName > bestDot) {
          bestDot = dot + sameName;
          bestEdge = eid;
        }
      }
      if (bestEdge < 0) return null;
      node = next;
      edge = bestEdge;
    }
    return null;
  }

  // ------------------------------------------------------------------ queries
  nearestNode(x: number, y: number, filter?: (n: TaxiNode) => boolean): number {
    let best = -1;
    let bd = Infinity;
    for (const n of this.nodes) {
      if (filter && !filter(n)) continue;
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bd) {
        bd = d;
        best = n.id;
      }
    }
    return best;
  }

  otherNode(edge: TaxiEdge, node: number): number {
    return edge.a === node ? edge.b : edge.a;
  }

  /**
   * A* route over taxiways. Runway edges are forbidden except those listed in allowRunways.
   * `avoid` = node to not start moving towards first (prevents U-turns right after an exit).
   */
  route(from: number, to: number, opts: { allowRunways?: string[]; avoidFirstNode?: number } = {}): TaxiRoute | null {
    if (from === to) {
      const n = this.nodes[from];
      return { nodes: [from], points: [[n.x, n.y]], names: [], holds: [], length: 0 };
    }
    const target = this.nodes[to];
    const g = new Map<number, number>([[from, 0]]);
    const came = new Map<number, { node: number; edge: number }>();
    const open: { id: number; f: number }[] = [{ id: from, f: 0 }];
    const closed = new Set<number>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
      const cur = open.splice(bi, 1)[0].id;
      if (cur === to) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      const cn = this.nodes[cur];
      for (const eid of cn.edges) {
        const e = this.edges[eid];
        if (e.kind === 'runway' && !(opts.allowRunways ?? []).includes(e.runwayId!)) continue;
        const nxt = this.otherNode(e, cur);
        if (cur === from && opts.avoidFirstNode === nxt) continue;
        let cost = e.len;
        // Discourage entering runway protected areas (crossings) and sharp reversals.
        if (e.zones.some((z) => cn.holdFor.includes(z))) cost += 250;
        if (e.zones.length) cost += e.len * 1.5;
        const prev = came.get(cur);
        if (prev) {
          const p = this.nodes[prev.node];
          const v1: Vec2 = [cn.x - p.x, cn.y - p.y];
          const nn = this.nodes[nxt];
          const v2: Vec2 = [nn.x - cn.x, nn.y - cn.y];
          const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (len2(v1) * len2(v2) || 1);
          if (cos < -0.2) cost += 2000; // no U-turns / hairpins
          else if (cos < 0.3) cost += 40;
        }
        const ng = (g.get(cur) ?? Infinity) + cost;
        if (ng < (g.get(nxt) ?? Infinity)) {
          g.set(nxt, ng);
          came.set(nxt, { node: cur, edge: eid });
          const h = Math.hypot(this.nodes[nxt].x - target.x, this.nodes[nxt].y - target.y);
          open.push({ id: nxt, f: ng + h });
        }
      }
    }
    if (!came.has(to)) return null;
    const nodes: number[] = [to];
    const edgesUsed: number[] = [];
    let c = to;
    while (c !== from) {
      const p = came.get(c)!;
      edgesUsed.push(p.edge);
      nodes.push(p.node);
      c = p.node;
    }
    nodes.reverse();
    edgesUsed.reverse();
    return this.makeRoute(nodes, edgesUsed);
  }

  makeRoute(nodes: number[], edgesUsed: number[]): TaxiRoute {
    const points: Vec2[] = nodes.map((id) => [this.nodes[id].x, this.nodes[id].y]);
    const names: string[] = [];
    let length = 0;
    for (const eid of edgesUsed) {
      const e = this.edges[eid];
      length += e.len;
      if (e.kind !== 'runway' && names[names.length - 1] !== e.name) names.push(e.name);
    }
    const holds: { idx: number; runwayId: string; exitIdx: number }[] = [];
    for (let i = 0; i < edgesUsed.length; i++) {
      const e = this.edges[edgesUsed[i]];
      const n = this.nodes[nodes[i]];
      for (const rid of e.zones) {
        // Entering a protected area at a hold node.
        if (n.holdFor.includes(rid) && !(i > 0 && this.edges[edgesUsed[i - 1]].zones.includes(rid))) {
          let j = i + 1;
          while (j < edgesUsed.length && this.edges[edgesUsed[j]].zones.includes(rid)) j++;
          holds.push({ idx: i, runwayId: rid, exitIdx: j });
        }
      }
    }
    return { nodes, points, names, holds, length };
  }

  /** Nose-to-reference distance used to park an aircraft of the given length. */
  static noseOffset(length: number): number {
    return length * 0.48;
  }

  /** Reference point (main gear) of an aircraft parked at a gate. */
  parkedPosition(gate: GateDef, length: number): Vec2 {
    const o = AirportModel.noseOffset(length);
    return [gate.pos[0] - Math.sin(gate.hdg * DEG) * o, gate.pos[1] - Math.cos(gate.hdg * DEG) * o];
  }

  activeRunwayIds(cfg: RunwayConfigDef): Set<string> {
    const s = new Set<string>();
    for (const n of [...cfg.arrivals, ...cfg.departures]) if (this.ends[n]) s.add(this.ends[n].runwayId);
    return s;
  }

  /** Glideslope altitude (ft MSL) at a distance (m) from the threshold. */
  glideslopeAlt(distM: number): number {
    return this.def.elevationFt + 50 + (Math.max(0, distM) * Math.tan(3 * DEG)) / 0.3048;
  }
}
