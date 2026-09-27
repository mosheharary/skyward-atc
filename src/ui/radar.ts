// Radar scope: a canvas-drawn approach radar with data blocks, trails, predicted vectors, conflicts, fixes, runway
// centrelines, a compass rose and a DOM overlay (range buttons, layer toggles, measuring tool and legend).

import type { World } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import { NM, bearing, hdgVec, clamp, KT } from '../core/units';
import { fmtHeading } from '../sim/phraseology';
import { h } from './dom';
import { icon } from './icons';
import { togglePopover } from './notifications';
import { prefs } from './prefs';

const TRAIL_EVERY = 4;

export interface RadarOptions {
  rings: boolean;
  fixes: boolean;
  water: boolean;
  ils: boolean;
  blocks: boolean;
  /** History dots per target. */
  trail: number;
  /** Predicted vector length (s). */
  vector: number;
  /** Data block font size (px). */
  font: number;
}

export interface RadarCallbacks {
  select(id: string | null): void;
  /** Right click with an airborne aircraft selected: vector it towards the point. */
  vector(id: string, hdg: number): void;
  /** Click on a fix while a fix is being picked. */
  fix(id: string): void;
  /** A layer toggle / range button changed the options. */
  options?(o: RadarOptions): void;
}

const RANGES = [5, 10, 20, 40];

export class RadarScope {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  rangeNm = 22;
  private panX = 0;
  private panY = 0;
  private trails = new Map<string, [number, number][]>();
  private lastTrailT = -1;
  private hover: { x: number; y: number } | null = null;
  private drag: { x: number; y: number; moved: number; block?: string; ox?: number; oy?: number; measure?: boolean } | null = null;
  /** Manual data block offsets (screen px) keyed by aircraft id. */
  private offsets = new Map<string, [number, number]>();
  /** Screen rectangles of the data blocks drawn last frame, for hit testing. */
  private blockRects = new Map<string, [number, number, number, number]>();
  private measure: { a: [number, number]; b: [number, number] } | null = null;
  private measuring = false;
  /** When set, clicking a fix calls cb.fix. */
  pickingFix = false;
  private dpr = 1;
  opts: RadarOptions;
  private readonly tools: HTMLElement;
  private readonly status: HTMLElement;
  private readonly legend: HTMLElement;
  private rangeSeg!: HTMLElement;
  private toggleBtns = new Map<string, HTMLElement>();
  private defaultRange = 0;

  constructor(parent: HTMLElement, private readonly cb: RadarCallbacks, opts?: Partial<RadarOptions>) {
    this.opts = { rings: true, fixes: true, water: true, ils: true, blocks: true, trail: 6, vector: 60, font: 11, ...opts };
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'radar-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Radar scope. Click a target to select it, right-click to vector the selected aircraft, wheel to zoom, drag to pan.');
    this.ctx = this.canvas.getContext('2d')!;
    this.legend = this.buildLegend();
    this.tools = this.buildTools(parent);
    this.status = h('div', { class: 'radar-status' });
    parent.append(this.canvas, this.tools, this.status);
    this.bind();
  }

  reset(world: World, defaultRange = 0): void {
    this.trails.clear();
    this.offsets.clear();
    this.measure = null;
    this.lastTrailT = -1;
    this.panX = 0;
    this.panY = 0;
    this.defaultRange = defaultRange;
    this.rangeNm = defaultRange || Math.min(28, world.airport.def.airspace.radiusNm + 2);
  }

  setOptions(o: Partial<RadarOptions>): void {
    this.opts = { ...this.opts, ...o };
    this.syncTools();
  }

  // ------------------------------------------------------------ overlay
  private buildTools(parent: HTMLElement): HTMLElement {
    const seg = (...b: HTMLElement[]): HTMLElement => h('div', { class: 'seg' }, ...b);
    const rbtn = (label: string | HTMLElement, title: string, on: () => void): HTMLElement => h('button', { title, 'aria-label': title, onclick: on }, label);
    this.rangeSeg = seg(
      rbtn(icon('minus'), 'Zoom out', () => this.zoom(1.35)),
      ...RANGES.map((r) => {
        const b = rbtn(String(r), `${r} NM range`, () => {
          this.rangeNm = r;
          this.syncTools();
        });
        b.dataset.r = String(r);
        return b;
      }),
      rbtn(icon('plus'), 'Zoom in', () => this.zoom(1 / 1.35)),
      rbtn(icon('home'), 'Re-centre and reset range (double-click)', () => this.home()),
    );
    const tog = (key: keyof RadarOptions, ic: string, title: string): HTMLElement => {
      const b = rbtn(icon(ic), title, () => {
        const v = this.opts[key];
        if (key === 'trail') this.opts.trail = v ? 0 : 6;
        else if (key === 'vector') this.opts.vector = v === 0 ? 60 : v === 60 ? 120 : 0;
        else (this.opts as unknown as Record<string, boolean>)[key] = !v;
        this.syncTools();
        this.cb.options?.(this.opts);
      });
      this.toggleBtns.set(key, b);
      return b;
    };
    const measureBtn = rbtn(icon('ruler'), 'Measure bearing & distance (or Shift-drag)', () => {
      this.measuring = !this.measuring;
      if (!this.measuring) this.measure = null;
      measureBtn.classList.toggle('active', this.measuring);
    });
    const legendBtn = rbtn(icon('info'), 'Legend', () => togglePopover(parent, this.legend, legendBtn));
    const wrap = h('div', { class: 'radar-tools' },
      h('div', { class: 'rt-row' }, this.rangeSeg),
      h('div', { class: 'rt-row rt-opt' },
        seg(tog('rings', 'rings', 'Range rings'), tog('fixes', 'fix', 'Fixes'), tog('ils', 'ils', 'Extended centrelines'), tog('water', 'water', 'Coastline'),
          tog('trail', 'trail', 'History trails'), tog('vector', 'vector', 'Predicted vector: off / 1 min / 2 min'), tog('blocks', 'tag', 'Full data blocks')),
        seg(measureBtn, legendBtn),
      ),
    );
    this.syncTools();
    return wrap;
  }

  private syncTools(): void {
    for (const b of this.rangeSeg?.children ?? []) {
      const r = (b as HTMLElement).dataset.r;
      if (r) b.classList.toggle('active', Math.abs(Number(r) - this.rangeNm) < 0.5);
    }
    for (const [k, b] of this.toggleBtns) {
      const v = this.opts[k as keyof RadarOptions];
      b.classList.toggle('active', !!v);
      if (k === 'vector') b.title = `Predicted vector: ${v ? `${Number(v) / 60} min` : 'off'} (click to cycle)`;
    }
  }

  private buildLegend(): HTMLElement {
    const row = (sw: HTMLElement, label: string): HTMLElement => h('div', { class: 'lg' }, sw, h('span', null, label));
    const sq = (c: string): HTMLElement => h('span', { class: 'sw', style: `background:${c}` });
    const tri = (c: string): HTMLElement => h('span', { class: 'tri', style: `color:${c}` });
    return h('div', { class: 'popover rt-legend', role: 'dialog', 'aria-label': 'Radar legend' },
      h('h4', null, 'Targets'),
      row(sq('#7fe8ff'), 'Arrival'), row(sq('#a6f59a'), 'Departure'), row(sq('#ffc24a'), 'Waiting for you'), row(sq('#ffb030'), 'Conflict predicted'),
      row(sq('#ff4d4d'), 'Separation lost'), row(sq('#ff6adf'), 'Emergency'), row(sq('#6d8a86'), 'Handed off'),
      h('h4', { style: 'margin-top:10px' }, 'Fixes'),
      row(tri('#6fb8ff'), 'Entry fix'), row(tri('#7fe0a0'), 'Intermediate fix (on final)'), row(tri('#f0a860'), 'Exit fix'), row(tri('#9fb4bb'), 'Waypoint'),
      h('h4', { style: 'margin-top:10px' }, 'Data block'),
      h('div', { class: 'dim', style: 'font:11px var(--mono);line-height:1.5' }, 'CALLSIGN', h('br'), 'ALT↑ASG  GS/10', h('br'), 'TYPE/WAKE  CLEARANCE'),
    );
  }

  private zoom(f: number): void {
    this.rangeNm = clamp(this.rangeNm * f, 1.5, 60);
    this.syncTools();
  }

  private home(): void {
    this.panX = 0;
    this.panY = 0;
    const w = this.world;
    this.rangeNm = this.defaultRange || (w ? Math.min(28, w.airport.def.airspace.radiusNm + 2) : 22);
    this.syncTools();
  }

  // ------------------------------------------------------------ geometry
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

  private blockAt(px: number, py: number): string | null {
    for (const [id, [x, y, w, hh]] of this.blockRects) if (px >= x && px <= x + w && py >= y && py <= y + hh) return id;
    return null;
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.rangeNm = clamp(this.rangeNm * Math.exp(e.deltaY * 0.0012), 1.5, 60);
      this.syncTools();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      const measure = this.measuring || e.shiftKey;
      const block = measure ? null : this.blockAt(e.offsetX, e.offsetY);
      const off = block ? this.offsets.get(block) ?? [0, 0] : [0, 0];
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, block: block ?? undefined, ox: off[0], oy: off[1], measure };
      if (measure) {
        const p = this.toSim(e.offsetX, e.offsetY);
        this.measure = { a: p, b: p };
      }
    });
    c.addEventListener('pointermove', (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      const d = this.drag;
      if (!d) {
        c.style.cursor = this.measuring ? 'crosshair' : this.blockAt(e.offsetX, e.offsetY) ? 'move' : '';
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.measure && this.measure) {
        this.measure.b = this.toSim(e.offsetX, e.offsetY);
      } else if (d.block && d.moved > 3) {
        d.ox! += dx;
        d.oy! += dy;
        this.offsets.set(d.block, [d.ox!, d.oy!]);
      } else if (d.moved > 5) {
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
      if (d?.measure) {
        if (d.moved <= 5) this.measure = null;
        return;
      }
      if (d && d.moved <= 5) this.click(e.offsetX, e.offsetY);
    });
    c.addEventListener('dblclick', (e) => {
      const b = this.blockAt(e.offsetX, e.offsetY);
      if (b) this.offsets.delete(b);
      else this.home();
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
      const r = this.blockRects.get(a.id);
      if (r && px >= r[0] && px <= r[0] + r[2] && py >= r[1] && py <= r[1] + r[3]) d = Math.min(d, 8);
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

  private blockPos(a: Aircraft, sx: number, sy: number, bw: number): [number, number] {
    const off = this.offsets.get(a.id);
    if (off) return [sx + 14 + off[0], sy - 18 + off[1]];
    // Place the data block on the side away from the direction of flight.
    const right = a.hdg > 180 || a.hdg < 0;
    return [right ? sx + 14 : sx - bw - 8, sy - 18];
  }

  // ------------------------------------------------------------ drawing
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
    const o = this.opts;
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Background with subtle radial vignette.
    const bg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#081a1f');
    bg.addColorStop(1, '#020709');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const s = this.scale();
    const def = world.airport.def;
    const mono = '"JetBrains Mono", ui-monospace, monospace';
    const k = prefs.scale;
    const px = (n: number): string => `${Math.round(n * k * 10) / 10}px ${mono}`;

    // Water / coastline
    if (o.water) {
      g.fillStyle = 'rgba(20,60,90,0.35)';
      g.strokeStyle = 'rgba(70,160,190,0.45)';
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
    }

    const [cx, cy] = this.toScreen(0, 0);
    const ringR = def.airspace.radiusNm * NM * s;
    // Range rings
    if (o.rings) {
      g.strokeStyle = 'rgba(100,190,180,0.24)';
      g.fillStyle = 'rgba(140,210,200,0.6)';
      g.font = px(10);
      const step = this.rangeNm > 30 ? 10 : this.rangeNm > 8 ? 5 : 1;
      for (let r = step; r <= Math.max(60, this.rangeNm * 2); r += step) {
        g.beginPath();
        g.arc(cx, cy, r * NM * s, 0, Math.PI * 2);
        g.stroke();
        g.fillText(`${r}`, cx + 3, cy - r * NM * s - 2);
      }
    }
    // Airspace boundary with a compass rose on it.
    g.setLineDash([6, 6]);
    g.strokeStyle = 'rgba(120,200,255,0.45)';
    g.beginPath();
    g.arc(cx, cy, ringR, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = 'rgba(120,200,255,0.45)';
    g.fillStyle = 'rgba(150,210,255,0.7)';
    g.font = px(10);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const r = (d * Math.PI) / 180;
      const len = d % 30 === 0 ? 9 : 4;
      g.beginPath();
      g.moveTo(cx + Math.sin(r) * ringR, cy - Math.cos(r) * ringR);
      g.lineTo(cx + Math.sin(r) * (ringR - len), cy - Math.cos(r) * (ringR - len));
      g.stroke();
      if (d % 30 === 0) g.fillText(String(d).padStart(3, '0'), cx + Math.sin(r) * (ringR - 18), cy - Math.cos(r) * (ringR - 18));
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';

    // Extended centrelines for arrival runways (ILS feathers, 1 NM ticks).
    if (o.ils) {
      for (const name of world.arrivalEnds) {
        const e = world.airport.ends[name];
        if (!e) continue;
        const [tx, ty] = e.threshold;
        const [dx, dy] = e.dir;
        const [x1, y1] = this.toScreen(tx, ty);
        const [x2, y2] = this.toScreen(tx - dx * 18 * NM, ty - dy * 18 * NM);
        g.strokeStyle = 'rgba(120,220,160,0.55)';
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
        g.fillStyle = 'rgba(150,240,180,0.9)';
        g.font = px(11);
        g.fillText(`${name}${e.ils ? ' ILS' : ''}`, x2 + 4, y2);
      }
    }

    // Runways
    g.lineCap = 'round';
    for (const rw of world.airport.runways) {
      const [ax, ay] = this.toScreen(rw.a[0], rw.a[1]);
      const [bx, by] = this.toScreen(rw.b[0], rw.b[1]);
      g.strokeStyle = '#e3eef1';
      g.lineWidth = Math.max(2.5, rw.width * s);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.stroke();
    }
    g.lineWidth = 1;
    // Taxiways when zoomed in.
    if (this.rangeNm < 6) {
      g.strokeStyle = 'rgba(210,210,130,0.3)';
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
    if (o.fixes || this.pickingFix) {
      g.font = px(10);
      for (const f of def.fixes) {
        const [sx, sy] = this.toScreen(f.pos[0], f.pos[1]);
        const col = f.role === 'entry' ? '#6fb8ff' : f.role === 'exit' ? '#f0a860' : f.role === 'if' ? '#7fe0a0' : '#a9bec4';
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
        g.fillText(f.id, sx + 7, sy + 4);
      }
    }

    // Trails sampling
    const trailLen = Math.max(0, Math.min(12, o.trail));
    if (this.lastTrailT < 0 || world.t - this.lastTrailT >= TRAIL_EVERY || world.t < this.lastTrailT) {
      this.lastTrailT = world.t;
      const live = new Set<string>();
      for (const a of world.aircraft) {
        live.add(a.id);
        if (a.onGround) continue;
        let tr = this.trails.get(a.id);
        if (!tr) this.trails.set(a.id, (tr = []));
        tr.push([a.x, a.y]);
        while (tr.length > 12) tr.shift();
      }
      for (const id of this.trails.keys()) if (!live.has(id)) {
        this.trails.delete(id);
        this.offsets.delete(id);
      }
    }

    // Conflict lines
    const conflicts = world.conflictPairs();
    for (const p of conflicts) {
      const a = world.byId(p.ids[0]);
      const b = world.byId(p.ids[1]);
      if (!a || !b) continue;
      const [x1, y1] = this.toScreen(a.x, a.y);
      const [x2, y2] = this.toScreen(b.x, b.y);
      g.strokeStyle = p.level === 'loss' ? 'rgba(255,70,70,0.95)' : 'rgba(255,190,60,0.85)';
      g.lineWidth = p.level === 'loss' ? 2 : 1.3;
      g.setLineDash(p.level === 'loss' ? [] : [4, 4]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
      // Separation read-out at the middle of the line.
      const dnm = Math.hypot(a.x - b.x, a.y - b.y) / NM;
      const dft = Math.abs(a.altFt - b.altFt);
      g.fillStyle = p.level === 'loss' ? '#ff8a8a' : '#ffcf70';
      g.font = px(10);
      g.fillText(`${dnm.toFixed(1)}NM ${Math.round(dft / 100) * 100}ft`, (x1 + x2) / 2 + 4, (y1 + y2) / 2 - 4);
    }

    // Selected aircraft route
    const sel = selected ? world.byId(selected) : undefined;
    if (sel && !sel.onGround) {
      const target = sel.direct ?? sel.route[0] ?? (sel.hold ? sel.hold.fix : null);
      const f = target ? world.airport.fixes[target] : undefined;
      if (f) {
        const [x1, y1] = this.toScreen(sel.x, sel.y);
        const [x2, y2] = this.toScreen(f.pos[0], f.pos[1]);
        g.strokeStyle = 'rgba(120,230,255,0.7)';
        g.setLineDash([3, 5]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.setLineDash([]);
      }
      if (this.hover && !this.pickingFix && !this.measuring && !this.drag) {
        // Heading preview for right-click vectoring.
        const [x1, y1] = this.toScreen(sel.x, sel.y);
        const [hx, hy] = this.toSim(this.hover.x, this.hover.y);
        const hdg = Math.round(bearing(sel.x, sel.y, hx, hy) / 5) * 5;
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(this.hover.x, this.hover.y);
        g.stroke();
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.font = px(11);
        g.fillText(`R-click: hdg ${fmtHeading(hdg)}`, this.hover.x + 10, this.hover.y + 14);
      }
    }

    // Aircraft
    const fs = Math.round(clamp(o.font, 9, 15) * k);
    g.font = `${fs}px ${mono}`;
    const lh = fs + 2;
    this.blockRects.clear();
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
      if (tr && trailLen) {
        const pts = tr.slice(-trailLen);
        pts.forEach(([x, y], i) => {
          const [tx, ty] = this.toScreen(x, y);
          g.fillStyle = `rgba(160,230,230,${0.14 + (i / trailLen) * 0.36})`;
          g.fillRect(tx - 1.5, ty - 1.5, 3, 3);
        });
      }
      if (a.onGround) {
        g.fillStyle = col;
        g.beginPath();
        g.arc(sx, sy, 3, 0, Math.PI * 2);
        g.fill();
        g.fillText(a.callsign, sx + 6, sy - 4);
        this.blockRects.set(a.id, [sx + 4, sy - 4 - fs, a.callsign.length * fs * 0.62 + 4, fs + 4]);
        continue;
      }
      // Predicted vector
      if (o.vector > 0) {
        const [vx, vy] = hdgVec(a.trk || a.hdg);
        const d1 = a.gsKt * KT * o.vector;
        const [lx, ly] = this.toScreen(a.x + vx * d1, a.y + vy * d1);
        g.strokeStyle = col;
        g.globalAlpha = 0.75;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(lx, ly);
        g.stroke();
        g.globalAlpha = 1;
      }
      // target symbol
      g.strokeStyle = col;
      g.lineWidth = isSel ? 2 : 1.5;
      g.beginPath();
      g.rect(sx - 4, sy - 4, 8, 8);
      g.stroke();
      if (isSel) {
        g.beginPath();
        g.arc(sx, sy, 11, 0, Math.PI * 2);
        g.stroke();
      }
      if (needs && !isSel) {
        g.globalAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 180);
        g.beginPath();
        g.arc(sx, sy, 9, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
      g.lineWidth = 1;
      // data block
      const alt = Math.round(a.altFt / 100);
      const trend = a.vs > 300 ? '↑' : a.vs < -300 ? '↓' : ' ';
      const asg = Math.round(a.asgAlt / 100);
      const l1 = `${a.callsign}${a.emergency ? ' EMRG' : ''}`;
      const l2 = `${String(alt).padStart(3, '0')}${trend}${asg !== alt ? String(asg).padStart(3, '0') : '   '} ${Math.round(a.gsKt / 10)}`;
      const l3 = `${a.type.icao}${a.type.wake === 'H' ? '/H' : a.type.wake === 'J' ? '/J' : ''} ${a.appr ? a.appr : a.kind === 'dep' ? (a.exitFix ?? '') : (a.direct ?? '')}`;
      const full = o.blocks || isSel;
      const lines = full ? [l1, l2, l3] : [l1, l2];
      const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + 6;
      const bh = lines.length * lh + 4;
      const [bx, by] = this.blockPos(a, sx, sy, bw);
      this.blockRects.set(a.id, [bx - 3, by - fs, bw, bh]);
      // Leader line to the nearest block edge.
      const ex = bx - 3 > sx ? bx - 3 : bx + bw - 3 < sx ? bx + bw - 3 : sx;
      const ey = by - fs > sy ? by - fs : by - fs + bh < sy ? by - fs + bh : sy;
      g.strokeStyle = col;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.moveTo(sx, sy);
      g.lineTo(ex, ey);
      g.stroke();
      g.globalAlpha = 1;
      if (isSel || lvl || needs) {
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillRect(bx - 3, by - fs, bw, bh);
        g.strokeStyle = col;
        g.globalAlpha = isSel ? 0.8 : 0.5;
        g.strokeRect(bx - 3 + 0.5, by - fs + 0.5, bw - 1, bh - 1);
        g.globalAlpha = 1;
      }
      g.fillStyle = col;
      lines.forEach((l, i) => {
        g.globalAlpha = i === 2 ? 0.8 : 1;
        g.fillText(l, bx, by + i * lh);
      });
      g.globalAlpha = 1;
    }

    // Measuring line
    if (this.measure) {
      const [x1, y1] = this.toScreen(...this.measure.a);
      const [x2, y2] = this.toScreen(...this.measure.b);
      const dnm = Math.hypot(this.measure.b[0] - this.measure.a[0], this.measure.b[1] - this.measure.a[1]) / NM;
      const brg = Math.round(bearing(this.measure.a[0], this.measure.a[1], this.measure.b[0], this.measure.b[1])) % 360 || 360;
      g.strokeStyle = '#ffd36a';
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#ffd36a';
      g.beginPath();
      g.arc(x1, y1, 3, 0, Math.PI * 2);
      g.fill();
      const label = `${String(brg).padStart(3, '0')}° ${dnm.toFixed(1)} NM`;
      g.font = px(12);
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(0,0,0,0.7)';
      g.fillRect(x2 + 8, y2 - 14, tw + 10, 20);
      g.fillStyle = '#ffd36a';
      g.fillText(label, x2 + 13, y2 + 1);
    }

    this.updateStatus(world);
  }

  private statusKey = '';

  private updateStatus(world: World): void {
    const parts: string[] = [`RNG ${Math.round(this.rangeNm)} NM`];
    if (this.hover) {
      const [x, y] = this.toSim(this.hover.x, this.hover.y);
      const d = Math.hypot(x, y) / NM;
      const b = Math.round(bearing(0, 0, x, y)) % 360 || 360;
      parts.push(`${world.airport.def.icao} ${String(b).padStart(3, '0')}°/${d.toFixed(1)}`);
    }
    const key = `${parts.join('|')}|${this.pickingFix}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.status.replaceChildren(...parts.map((p) => h('span', null, p)), this.pickingFix ? h('span', { class: 'pick' }, 'Click a fix on the scope… (Esc cancels)') : '');
  }
}
