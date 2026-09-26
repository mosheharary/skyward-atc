// Geometry accumulation helpers for the airport renderer. Builders work in sim coordinates
// (x east, y north, metres) and emit three.js world vertices (x, h, -y).

import * as THREE from 'three';
import type { Vec2 } from '../../sim/airports/types';

export class GeoBuf {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: THREE.Color | null = null): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    if (c) this.col.push(c.r, c.g, c.b);
    else this.col.push(1, 1, 1);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  append(o: GeoBuf): void {
    const base = this.count;
    this.pos.push(...o.pos);
    this.nor.push(...o.nor);
    this.uv.push(...o.uv);
    this.col.push(...o.col);
    for (const i of o.idx) this.idx.push(i + base);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  // ------------------------------------------------------------------ flat (horizontal) helpers

  /** Horizontal triangle facing up; points in sim coordinates. */
  flatTri(a: Vec2, b: Vec2, c: Vec2, h: number, uvFn: (x: number, y: number) => Vec2, color: THREE.Color | null = null): void {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) < 1e-9) return;
    const pts = cross > 0 ? [a, b, c] : [a, c, b];
    const ids = pts.map((p) => {
      const uv = uvFn(p[0], p[1]);
      return this.vert(p[0], h, -p[1], 0, 1, 0, uv[0], uv[1], color);
    });
    this.tri(ids[0], ids[1], ids[2]);
  }

  /** Horizontal quad (convex, any winding). */
  flatQuad(a: Vec2, b: Vec2, c: Vec2, d: Vec2, h: number, uvFn: (x: number, y: number) => Vec2, color: THREE.Color | null = null): void {
    this.flatTri(a, b, c, h, uvFn, color);
    this.flatTri(a, c, d, h, uvFn, color);
  }

  /** Horizontal polygon (possibly concave), triangulated with earcut. */
  flatPoly(pts: Vec2[], h: number, uvFn: (x: number, y: number) => Vec2, color: THREE.Color | null = null): void {
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const t of tris) this.flatTri(pts[t[0]], pts[t[1]], pts[t[2]], h, uvFn, color);
  }

  /** Horizontal rectangle between a and b with the given width. */
  ribbon(a: Vec2, b: Vec2, w: number, h: number, uvFn: (x: number, y: number) => Vec2, color: THREE.Color | null = null): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    const nx = (-dy / L) * w * 0.5;
    const ny = (dx / L) * w * 0.5;
    this.flatQuad([a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny], h, uvFn, color);
  }

  /** Horizontal disc (fan). */
  disc(c: Vec2, r: number, h: number, uvFn: (x: number, y: number) => Vec2, seg = 20, color: THREE.Color | null = null, down = false): void {
    const ny = down ? -1 : 1;
    const uv0 = uvFn(c[0], c[1]);
    const ci = this.vert(c[0], h, -c[1], 0, ny, 0, uv0[0], uv0[1], color);
    const ring: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const x = c[0] + Math.cos(a) * r;
      const y = c[1] + Math.sin(a) * r;
      const uv = uvFn(x, y);
      ring.push(this.vert(x, h, -y, 0, ny, 0, uv[0], uv[1], color));
    }
    // CCW in sim => CCW from above (reversed for a downward-facing ceiling).
    for (let i = 0; i < seg; i++) {
      if (down) this.tri(ci, ring[(i + 1) % seg], ring[i]);
      else this.tri(ci, ring[i], ring[(i + 1) % seg]);
    }
  }

  /** Rectangle in a local frame: centre c, along-axis unit vector d, extents (along, lateral). */
  rect(c: Vec2, d: Vec2, halfAlong: number, halfLat: number, h: number, u0: number, v0: number, u1: number, v1: number, color: THREE.Color | null = null): void {
    // Lateral to the right of d.
    const r: Vec2 = [d[1], -d[0]];
    const P = (sa: number, sl: number): Vec2 => [c[0] + d[0] * sa * halfAlong + r[0] * sl * halfLat, c[1] + d[1] * sa * halfAlong + r[1] * sl * halfLat];
    // Texture: u across (left -> right), v along (near -> far) so glyphs read "upwards" along d.
    const bl = P(-1, -1);
    const br = P(-1, 1);
    const tr = P(1, 1);
    const tl = P(1, -1);
    const i0 = this.vert(bl[0], h, -bl[1], 0, 1, 0, u0, v0, color);
    const i1 = this.vert(br[0], h, -br[1], 0, 1, 0, u1, v0, color);
    const i2 = this.vert(tr[0], h, -tr[1], 0, 1, 0, u1, v1, color);
    const i3 = this.vert(tl[0], h, -tl[1], 0, 1, 0, u0, v1, color);
    // bl -> br -> tr is counter-clockwise in sim (r is to the right of d) => faces up.
    this.tri(i0, i1, i2);
    this.tri(i0, i2, i3);
  }

  // ------------------------------------------------------------------ solids

  /** Vertical wall quad from sim a to sim b between heights h0..h1, outward normal to the right of a->b... computed. */
  wall(a: Vec2, b: Vec2, h0: number, h1: number, uScale: number, vScale: number, u0 = 0, color: THREE.Color | null = null, outward: 1 | -1 = 1): void {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-6) return;
    // Right-hand normal in sim (dy, -dx)/L; world normal (nx, 0, -ny).
    const nsx = (dy / L) * outward;
    const nsy = (-dx / L) * outward;
    const nx = nsx;
    const nz = -nsy;
    const ua = u0 / uScale;
    const ub = (u0 + L) / uScale;
    const i0 = this.vert(a[0], h0, -a[1], nx, 0, nz, ua, h0 / vScale, color);
    const i1 = this.vert(b[0], h0, -b[1], nx, 0, nz, ub, h0 / vScale, color);
    const i2 = this.vert(b[0], h1, -b[1], nx, 0, nz, ub, h1 / vScale, color);
    const i3 = this.vert(a[0], h1, -a[1], nx, 0, nz, ua, h1 / vScale, color);
    // Determine winding so the face normal matches (nx, 0, nz).
    const ex = b[0] - a[0];
    const ez = -(b[1] - a[1]);
    // face normal of (i0,i1,i2) = (e) x (up) = (ex,0,ez) x (0,1,0) = (-ez, 0, ex)
    const fx = -ez;
    const fz = ex;
    if (fx * nx + fz * nz > 0) {
      this.tri(i0, i1, i2);
      this.tri(i0, i2, i3);
    } else {
      this.tri(i0, i2, i1);
      this.tri(i0, i3, i2);
    }
  }

  /** Extruded prism from a CCW-or-CW footprint, walls + top (optionally bottom). */
  prism(foot: Vec2[], h0: number, h1: number, wallU: number, wallV: number, topUv: ((x: number, y: number) => Vec2) | null, color: THREE.Color | null = null, top: GeoBuf | null = null): void {
    let area = 0;
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i];
      const b = foot[(i + 1) % foot.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const ccw = area > 0;
    let u = 0;
    for (let i = 0; i < foot.length; i++) {
      const a = foot[i];
      const b = foot[(i + 1) % foot.length];
      // For a CCW footprint the outward normal is to the right of a->b.
      this.wall(a, b, h0, h1, wallU, wallV, u, color, ccw ? 1 : -1);
      u += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (topUv) (top ?? this).flatPoly(foot, h1, topUv, color);
  }

  /** Oriented box: centre (sim), axis heading (deg) of the w dimension, from h0 to h1. */
  box(c: Vec2, axisDeg: number, w: number, d: number, h0: number, h1: number, wallU: number, wallV: number, color: THREE.Color | null = null, top: GeoBuf | null = null, topScale = 8): void {
    this.prism(boxFoot(c, axisDeg, w, d), h0, h1, wallU, wallV, (x, y) => [x / topScale, y / topScale], color, top);
  }

  /** Generic vertical cylinder / frustum. */
  cylinder(c: Vec2, r0: number, r1: number, h0: number, h1: number, seg: number, uScale: number, vScale: number, color: THREE.Color | null = null, cap = true): void {
    const ring0: number[] = [];
    const ring1: number[] = [];
    const slope = (r0 - r1) / Math.max(1e-6, h1 - h0);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const sy = Math.sin(a);
      const n = new THREE.Vector3(cx, slope, -sy).normalize();
      const u = (a * (r0 + r1) * 0.5) / uScale;
      ring0.push(this.vert(c[0] + cx * r0, h0, -(c[1] + sy * r0), n.x, n.y, n.z, u, h0 / vScale, color));
      ring1.push(this.vert(c[0] + cx * r1, h1, -(c[1] + sy * r1), n.x, n.y, n.z, u, h1 / vScale, color));
    }
    for (let i = 0; i < seg; i++) {
      // CCW sim angle order; outward normals: from outside, ring0[i] -> ring0[i+1] goes counter-clockwise viewed from above,
      // i.e. left-to-right when viewed from outside is ... use explicit winding check.
      this.tri(ring0[i], ring1[i + 1], ring1[i]);
      this.tri(ring0[i], ring0[i + 1], ring1[i + 1]);
    }
    if (cap && r1 > 0) this.disc(c, r1, h1, (x, y) => [x / uScale, y / uScale], seg, color);
  }
}

export function boxFoot(c: Vec2, axisDeg: number, w: number, d: number): Vec2[] {
  const a = (axisDeg * Math.PI) / 180;
  const ax: Vec2 = [Math.sin(a), Math.cos(a)];
  const rt: Vec2 = [ax[1], -ax[0]];
  const hw = w / 2;
  const hd = d / 2;
  const P = (sa: number, sr: number): Vec2 => [c[0] + ax[0] * sa * hw + rt[0] * sr * hd, c[1] + ax[1] * sa * hw + rt[1] * sr * hd];
  return [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)];
}

export const worldUv = (s: number) => (x: number, y: number): Vec2 => [x / s, y / s];

export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

/** Deterministic PRNG. */
export function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
