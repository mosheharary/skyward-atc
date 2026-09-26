// Radar scope: a canvas-drawn approach radar with data blocks, trails, conflicts, fixes and runway centrelines.

import type { World } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import { NM, bearing, hdgVec, clamp, KT } from '../core/units';
import { fmtHeading } from '../sim/phraseology';

const TRAIL_EVERY = 4;
const TRAIL_LEN = 6;

export interface RadarCallbacks {
  select(id: string | null): void;
  /** Right click with an airborne aircraft selected: vector it towards the point. */
  vector(id: string, hdg: number): void;
  /** Click on a fix while a fix is being picked. */
  fix(id: string): void;
}

export class RadarScope {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  rangeNm = 22;
  private panX = 0;
  private panY = 0;
  private trails = new Map<string, [number, number][]>();
  private lastTrailT = -1;
  private hover: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; moved: number } | null = null;
  /** When set, clicking a fix calls cb.fix. */
  pickingFix = false;
  private dpr = 1;

  constructor(parent: HTMLElement, private readonly cb: RadarCallbacks) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'radar-canvas';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.bind();
  }

  reset(world: World): void {
    this.trails.clear();
    this.lastTrailT = -1;
    this.panX = 0;
    this.panY = 0;
    this.rangeNm = Math.min(28, world.airport.def.airspace.radiusNm + 2);
  }

  private get size(): { w: number; h: number } {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  private scale(): number {
    const { w, h } = this.size;
    return Math.min(w, h) / 2 / (this.rangeNm * NM);
  }

  private toScreen(x: number, y: number): [number, number] {
    const { w, h } = this.size;
    const s = this.scale();
    return [w / 2 + (x - this.panX) * s, h / 2 - (y - this.panY) * s];
  }

  private toSim(px: number, py: number): [number, number] {
    const { w, h } = this.size;
    const s = this.scale();
    return [(px - w / 2) / s + this.panX, -(py - h / 2) / s + this.panY];
  }

  private world: World | null = null;
  private selected: string | null = null;

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rangeNm = clamp(this.rangeNm * Math.exp(e.deltaY * 0.0012), 1.5, 60);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
        c.setPointerCapture(e.pointerId);
      }
    });
    c.addEventListener('pointermove', (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.moved > 5) {
        const s = this.scale();
        this.panX -= dx / s;
        this.panY += dy / s;
      }
    });
    c.addEventListener('pointerleave', () => (this.hover = null));
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (e.button === 2) return this.rightClick(e.offsetX, e.offsetY);
      if (d && d.moved <= 5) this.click(e.offsetX, e.offsetY);
    });
    c.addEventListener('dblclick', () => {
      this.panX = 0;
      this.panY = 0;
    });
  }

  private click(px: number, py: number): void {
    const w = this.world;
    if (!w) return;
    if (this.pickingFix) {
      const f = this.fixAt(px, py);
      if (f) return this.cb.fix(f);
    }
    let best: string | null = null;
    let bestD = 22;
    for (const a of w.aircraft) {
      if (!this.visible(a)) continue;
      const [sx, sy] = this.toScreen(a.x, a.y);
      let d = Math.hypot(sx - px, sy - py);
      // Data block is clickable too.
      const [bx, by] = this.blockPos(a, sx, sy);
      if (px >= bx - 2 && px <= bx + 78 && py >= by - 12 && py <= by + 26) d = Math.min(d, 8);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    this.cb.select(best);
  }

  private rightClick(px: number, py: number): void {
    const w = this.world;
    if (!w || !this.selected) return;
    const a = w.byId(this.selected);
    if (!a || a.onGround) return;
    const [x, y] = this.toSim(px, py);
    const h = Math.round(bearing(a.x, a.y, x, y) / 5) * 5;
    this.cb.vector(a.id, h % 360 || 360);
  }

  private fixAt(px: number, py: number): string | null {
    const w = this.world!;
    let best: string | null = null;
    let bestD = 16;
    for (const f of w.airport.def.fixes) {
      const [sx, sy] = this.toScreen(f.pos[0], f.pos[1]);
      const d = Math.hypot(sx - px, sy - py);
      if (d < bestD) {
        bestD = d;
        best = f.id;
      }
    }
    return best;
  }

  private visible(a: Aircraft): boolean {
    if (a.phase === 'exited') return false;
    if (a.onGround) return this.rangeNm <= 5 && a.phase !== 'parked';
    return true;
  }

  private blockPos(a: Aircraft, sx: number, sy: number): [number, number] {
    // Place the data block on the side away from the direction of flight.
    const right = a.hdg > 180 || a.hdg < 0;
    return [right ? sx + 14 : sx - 86, sy - 18];
  }

  draw(world: World, selected: string | null, attention: ReadonlySet<string>): void {
    this.world = world;
    this.selected = selected;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w, h } = this.size;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr) || dpr !== this.dpr) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      this.dpr = dpr;
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Background with subtle radial vignette.
    const bg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#07161a');
    bg.addColorStop(1, '#020709');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const s = this.scale();
    const def = world.airport.def;

    // Water / coastline
    g.fillStyle = 'rgba(20,60,90,0.35)';
    g.strokeStyle = 'rgba(60,140,170,0.35)';
    g.lineWidth = 1;
    for (const poly of def.scenery.water) {
      g.beginPath();
      poly.forEach(([x, y], i) => {
        const [sx, sy] = this.toScreen(x, y);
        if (i === 0) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      });
      g.closePath();
      g.fill();
      g.stroke();
    }

    // Range rings
    const [cx, cy] = this.toScreen(0, 0);
    g.strokeStyle = 'rgba(90,170,160,0.16)';
    g.fillStyle = 'rgba(120,190,180,0.4)';
    g.font = '10px "JetBrains Mono", ui-monospace, monospace';
    const step = this.rangeNm > 30 ? 10 : this.rangeNm > 8 ? 5 : 1;
    for (let r = step; r <= Math.max(60, this.rangeNm * 2); r += step) {
      g.beginPath();
      g.arc(cx, cy, r * NM * s, 0, Math.PI * 2);
      g.stroke();
      g.fillText(`${r}`, cx + 3, cy - r * NM * s - 2);
    }
    // Airspace boundary
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(120,200,255,0.35)';
    g.beginPath();
    g.arc(cx, cy, def.airspace.radiusNm * NM * s, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);

    // Extended centrelines for arrival runways (ILS feathers, 1 NM ticks).
    for (const name of world.arrivalEnds) {
      const e = world.airport.ends[name];
      if (!e) continue;
      const [tx, ty] = e.threshold;
      const [dx, dy] = e.dir;
      const [x1, y1] = this.toScreen(tx, ty);
      const [x2, y2] = this.toScreen(tx - dx * 18 * NM, ty - dy * 18 * NM);
      g.strokeStyle = 'rgba(120,220,160,0.45)';
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      const [rx, ry] = e.right;
      for (let n = 1; n <= 18; n++) {
        const px = tx - dx * n * NM;
        const py = ty - dy * n * NM;
        const len = (n % 5 === 0 ? 400 : 180);
        const [a1, b1] = this.toScreen(px - rx * len, py - ry * len);
        const [a2, b2] = this.toScreen(px + rx * len, py + ry * len);
        g.beginPath();
        g.moveTo(a1, b1);
        g.lineTo(a2, b2);
        g.stroke();
      }
      g.fillStyle = 'rgba(140,230,170,0.8)';
      g.fillText(`${name}${e.ils ? ' ILS' : ''}`, x2 + 4, y2);
    }

    // Runways
    g.lineCap = 'round';
    for (const rw of world.airport.runways) {
      const [ax, ay] = this.toScreen(rw.a[0], rw.a[1]);
      const [bx, by] = this.toScreen(rw.b[0], rw.b[1]);
      g.strokeStyle = '#d9e6ea';
      g.lineWidth = Math.max(2, rw.width * s);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
    }
    g.lineWidth = 1;
    // Taxiways when zoomed in.
    if (this.rangeNm < 6) {
      g.strokeStyle = 'rgba(200,200,120,0.25)';
      g.lineWidth = Math.max(1, 18 * s);
      for (const t of def.taxiways) {
        g.beginPath();
        t.points.forEach(([x, y], i) => {
          const [sx, sy] = this.toScreen(x, y);
          if (i === 0) g.moveTo(sx, sy);
          else g.lineTo(sx, sy);
        });
        g.stroke();
      }
      g.lineWidth = 1;
    }

    // Fixes
    for (const f of def.fixes) {
      const [sx, sy] = this.toScreen(f.pos[0], f.pos[1]);
      const col = f.role === 'entry' ? '#6fb8ff' : f.role === 'exit' ? '#f0a860' : f.role === 'if' ? '#7fe0a0' : '#9fb4bb';
      g.strokeStyle = col;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(sx, sy - 5);
      g.lineTo(sx + 4.5, sy + 3.5);
      g.lineTo(sx - 4.5, sy + 3.5);
      g.closePath();
      if (this.pickingFix) {
        g.lineWidth = 2;
        g.fill();
        g.lineWidth = 1;
      } else g.stroke();
      g.globalAlpha = 0.8;
      g.fillText(f.id, sx + 7, sy + 4);
      g.globalAlpha = 1;
    }

    // Trails sampling
    if (this.lastTrailT < 0 || world.t - this.lastTrailT >= TRAIL_EVERY || world.t < this.lastTrailT) {
      this.lastTrailT = world.t;
      const live = new Set<string>();
      for (const a of world.aircraft) {
        live.add(a.id);
        if (a.onGround) continue;
        let tr = this.trails.get(a.id);
        if (!tr) this.trails.set(a.id, (tr = []));
        tr.push([a.x, a.y]);
        if (tr.length > TRAIL_LEN) tr.shift();
      }
      for (const id of this.trails.keys()) if (!live.has(id)) this.trails.delete(id);
    }

    // Conflict lines
    const conflicts = world.conflictPairs();
    for (const p of conflicts) {
      const a = world.byId(p.ids[0]);
      const b = world.byId(p.ids[1]);
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.y);
      const [x2, y2] = this.toScreen(b.x, b.y);
      g.strokeStyle = p.level === 'loss' ? 'rgba(255,70,70,0.9)' : 'rgba(255,190,60,0.8)';
      g.setLineDash(p.level === 'loss' ? [] : [4, 4]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
    }

    // Selected aircraft route
    const sel = selected ? world.byId(selected) : undefined;
    if (sel && !sel.onGround) {
      const target = sel.direct ?? sel.route[0] ?? (sel.hold ? sel.hold.fix : null);
      const f = target ? world.airport.fixes[target] : undefined;
      if (f) {
        const [x1, y1] = this.toScreen(sel.x, sel.y);
        const [x2, y2] = this.toScreen(f.pos[0], f.pos[1]);
        g.strokeStyle = 'rgba(120,230,255,0.6)';
        g.setLineDash([3, 5]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.setLineDash([]);
      }
      if (this.hover && !this.pickingFix) {
        // Heading preview for right-click vectoring.
        const [x1, y1] = this.toScreen(sel.x, sel.y);
        const [hx, hy] = this.toSim(this.hover.x, this.hover.y);
        const hdg = Math.round(bearing(sel.x, sel.y, hx, hy) / 5) * 5;
        g.strokeStyle = 'rgba(255,255,255,0.15)';
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(this.hover.x, this.hover.y);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.fillText(`R-click: hdg ${fmtHeading(hdg)}`, this.hover.x + 10, this.hover.y + 14);
      }
    }

    // Aircraft
    g.font = '11px "JetBrains Mono", ui-monospace, monospace';
    for (const a of world.aircraft) {
      if (!this.visible(a)) continue;
      const [sx, sy] = this.toScreen(a.x, a.y);
      const lvl = world.conflictLevel(a.id);
      const isSel = a.id === selected;
      const needs = attention.has(a.id);
      let col = a.kind === 'arr' ? '#7fe8ff' : '#a6f59a';
      if (a.handedOff) col = '#6d8a86';
      if (a.emergency) col = '#ff6adf';
      if (needs) col = '#ffc24a';
      if (lvl === 'predicted') col = '#ffb030';
      if (lvl === 'loss') col = '#ff4d4d';
      if (isSel) col = '#ffffff';

      // trail
      const tr = this.trails.get(a.id);
      if (tr) {
        tr.forEach(([x, y], i) => {
          const [tx, ty] = this.toScreen(x, y);
          g.fillStyle = `rgba(160,230,230,${0.12 + (i / TRAIL_LEN) * 0.3})`;
          g.fillRect(tx - 1.5, ty - 1.5, 3, 3);
        });
      }
      if (a.onGround) {
        g.fillStyle = col;
        g.beginPath();
        g.arc(sx, sy, 3, 0, Math.PI * 2);
        g.fill();
        g.fillText(a.callsign, sx + 6, sy - 4);
        continue;
      }
      // leader: 1 minute prediction
      const [vx, vy] = hdgVec(a.trk || a.hdg);
      const d1 = a.gsKt * KT * 60;
      const [lx, ly] = this.toScreen(a.x + vx * d1, a.y + vy * d1);
      g.strokeStyle = col;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(lx, ly);
      g.stroke();
      g.globalAlpha = 1;
      // target symbol
      g.lineWidth = isSel ? 2 : 1.4;
      g.beginPath();
      g.rect(sx - 4, sy - 4, 8, 8);
      g.stroke();
      if (isSel) {
        g.beginPath();
        g.arc(sx, sy, 10, 0, Math.PI * 2);
        g.stroke();
      }
      g.lineWidth = 1;
      // data block
      const [bx, by] = this.blockPos(a, sx, sy);
      g.strokeStyle = col;
      g.globalAlpha = 0.5;
      g.beginPath();
      g.moveTo(sx + (bx > sx ? 5 : -5), sy - 3);
      g.lineTo(bx > sx ? bx - 2 : bx + 80, by - 3);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = col;
      const alt = Math.round(a.altFt / 100);
      const trend = a.vs > 300 ? '↑' : a.vs < -300 ? '↓' : ' ';
      const asg = Math.round(a.asgAlt / 100);
      const l1 = `${a.callsign}${a.emergency ? ' EMRG' : ''}`;
      const l2 = `${String(alt).padStart(3, '0')}${trend}${asg !== alt ? String(asg).padStart(3, '0') : '   '} ${Math.round(a.gsKt / 10)}`;
      const l3 = `${a.type.icao}${a.type.wake === 'H' ? '/H' : a.type.wake === 'J' ? '/J' : ''} ${a.appr ? a.appr : a.kind === 'dep' ? (a.exitFix ?? '') : (a.direct ?? '')}`;
      if (isSel) {
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(bx - 3, by - 12, 90, 42);
        g.fillStyle = col;
      }
      g.fillText(l1, bx, by);
      g.fillText(l2, bx, by + 13);
      g.globalAlpha = 0.8;
      g.fillText(l3, bx, by + 26);
      g.globalAlpha = 1;
    }

    // Scale / hints
    g.fillStyle = 'rgba(160,210,210,0.6)';
    g.font = '11px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(`RANGE ${Math.round(this.rangeNm)} NM`, 10, h - 10);
    if (this.pickingFix) {
      g.fillStyle = '#ffd36a';
      g.fillText('Click a fix on the scope…', 10, 18);
    }
  }
}
