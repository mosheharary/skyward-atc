// Parametric geometry helpers used by the procedural aircraft builder.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type SurfaceFn = (u: number, v: number, out: THREE.Vector3) => void;
export type UVFn = (u: number, v: number, out: THREE.Vector2) => void;

export interface SurfaceOptions {
  uv?: UVFn;
  /** Explicit parameter samples (0..1). */
  us?: number[];
  vs?: number[];
}

const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _du = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _n = new THREE.Vector3();
const _uv = new THREE.Vector2();

export function samples(n: number, power = 1): number[] {
  const a: number[] = [];
  for (let i = 0; i <= n; i++) a.push(Math.pow(i / n, power));
  return a;
}

/** Samples clustered towards both ends (cosine spacing). */
export function samplesCos(n: number): number[] {
  const a: number[] = [];
  for (let i = 0; i <= n; i++) a.push(0.5 - 0.5 * Math.cos((Math.PI * i) / n));
  return a;
}

function rawNormal(fn: SurfaceFn, u: number, v: number, out: THREE.Vector3): void {
  const eps = 1e-4;
  const u0 = Math.max(0, u - eps);
  const u1 = Math.min(1, u + eps);
  const v0 = Math.max(0, v - eps);
  const v1 = Math.min(1, v + eps);
  fn(u1, v, _a);
  fn(u0, v, _b);
  _du.subVectors(_a, _b);
  fn(u, v1, _a);
  fn(u, v0, _b);
  _dv.subVectors(_a, _b);
  out.crossVectors(_du, _dv);
}

function normalAt(fn: SurfaceFn, u: number, v: number, out: THREE.Vector3): void {
  rawNormal(fn, u, v, out);
  if (out.lengthSq() < 1e-16) {
    const u2 = u < 0.5 ? Math.min(1, u + 0.004) : Math.max(0, u - 0.004);
    rawNormal(fn, u2, v, out);
    if (out.lengthSq() < 1e-16) {
      const v2 = v < 0.5 ? Math.min(1, v + 0.004) : Math.max(0, v - 0.004);
      rawNormal(fn, u, v2, out);
    }
  }
  if (out.lengthSq() < 1e-20) out.set(0, 1, 0);
  out.normalize();
}

/** Build an indexed grid geometry from a parametric function. Normals via finite differences. */
export function surface(fn: SurfaceFn, nu: number, nv: number, o: SurfaceOptions = {}): THREE.BufferGeometry {
  const us = o.us ?? samples(nu);
  const vs = o.vs ?? samples(nv);
  const NU = us.length;
  const NV = vs.length;
  const pos = new Float32Array(NU * NV * 3);
  const nor = new Float32Array(NU * NV * 3);
  const uvs = new Float32Array(NU * NV * 2);
  for (let i = 0; i < NU; i++) {
    const u = us[i];
    for (let j = 0; j < NV; j++) {
      const v = vs[j];
      const k = i * NV + j;
      fn(u, v, _p);
      pos[k * 3] = _p.x;
      pos[k * 3 + 1] = _p.y;
      pos[k * 3 + 2] = _p.z;
      normalAt(fn, u, v, _n);
      nor[k * 3] = _n.x;
      nor[k * 3 + 1] = _n.y;
      nor[k * 3 + 2] = _n.z;
      if (o.uv) o.uv(u, v, _uv);
      else _uv.set(u, v);
      uvs[k * 2] = _uv.x;
      uvs[k * 2 + 1] = _uv.y;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < NU - 1; i++) {
    for (let j = 0; j < NV - 1; j++) {
      const a = i * NV + j;
      const b = (i + 1) * NV + j;
      const c = (i + 1) * NV + j + 1;
      const d = i * NV + j + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Flip normals and triangle winding in place. */
export function flipGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const index = g.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const t = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, t);
    }
    index.needsUpdate = true;
  }
  n.needsUpdate = true;
  return g;
}

/**
 * Make normals point along `ref(p)` on average (ref returns an "outward" direction for a position).
 * Flips the whole geometry if needed. Returns the geometry.
 */
export function orient(g: THREE.BufferGeometry, ref: (p: THREE.Vector3, out: THREE.Vector3) => void): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const pv = new THREE.Vector3();
  const rv = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < p.count; i++) {
    pv.fromBufferAttribute(p, i);
    ref(pv, rv);
    sum += rv.x * n.getX(i) + rv.y * n.getY(i) + rv.z * n.getZ(i);
  }
  if (sum < 0) flipGeometry(g);
  return g;
}

/** Flip the geometry if the normal of vertex `index` points against `dir`. */
export function orientVertex(g: THREE.BufferGeometry, index: number, dir: THREE.Vector3): THREE.BufferGeometry {
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const d = n.getX(index) * dir.x + n.getY(index) * dir.y + n.getZ(index) * dir.z;
  if (d < 0) flipGeometry(g);
  return g;
}

/** Mirror across the YZ plane (x -> -x) keeping outward normals / front faces. */
export function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, -p.getX(i));
    n.setX(i, -n.getX(i));
  }
  const index = g.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const t = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, t);
    }
  }
  return g;
}

/** Ensure geometry is indexed and has position/normal/uv only (for merging). */
export function normalize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = g;
  if (!out.getIndex()) {
    const count = out.getAttribute('position').count;
    const idx: number[] = [];
    for (let i = 0; i < count; i++) idx.push(i);
    out.setIndex(idx);
  }
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  if (!out.getAttribute('uv')) {
    const count = out.getAttribute('position').count;
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  out.morphAttributes = {};
  return out;
}

export function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const clean = list.filter((g) => g && (g.getAttribute('position')?.count ?? 0) > 0).map((g) => normalize(g));
  if (clean.length === 0) return new THREE.BufferGeometry();
  if (clean.length === 1) return clean[0];
  const m = mergeGeometries(clean, false);
  if (!m) throw new Error('mergeGeometries failed');
  return m;
}

export function xf(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  g.applyMatrix4(m);
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _t = new THREE.Vector3();

/** Compose a matrix from position, Euler angles (radians, order XYZ) and scale. */
export function mat(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  _t.set(px, py, pz);
  return _m.clone().compose(_t, _q, _s);
}

/** Matrix orienting local +Y along `dir`, positioned at `pos`. */
export function alignY(pos: THREE.Vector3, dir: THREE.Vector3, scale = 1): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(scale, scale, scale));
}

export interface LatheOptions {
  /** Axis centre (x, y); the axis runs along +Z. */
  cx: number;
  cy: number;
  nT: number;
  nPhi: number;
  phi0?: number;
  phi1?: number;
  /** Optional non-uniform scale of the cross-section (e.g. flattened bottom). */
  scale?: (phi: number, t: number) => [number, number];
  /** Explicit t samples. */
  ts?: number[];
  uv?: UVFn;
  /** true if the surface should face the axis (inner surfaces). */
  inward?: boolean;
}

/** Surface of revolution around an axis parallel to Z. profile(t) -> [z, r]. */
export function lathe(profile: (t: number) => [number, number], o: LatheOptions): THREE.BufferGeometry {
  const phi0 = o.phi0 ?? 0;
  const phi1 = o.phi1 ?? Math.PI * 2;
  const fn: SurfaceFn = (u, v, out) => {
    const [z, r] = profile(u);
    const phi = phi0 + v * (phi1 - phi0);
    let sx = 1;
    let sy = 1;
    if (o.scale) [sx, sy] = o.scale(phi, u);
    out.set(o.cx + Math.cos(phi) * r * sx, o.cy + Math.sin(phi) * r * sy, z);
  };
  const g = surface(fn, o.nT, o.nPhi, { us: o.ts, uv: o.uv });
  const cx = o.cx;
  const cy = o.cy;
  const inward = !!o.inward;
  return orient(g, (p, out) => {
    out.set(p.x - cx, p.y - cy, 0);
    if (inward) out.negate();
  });
}

/** Flat annulus (ring) facing +Z or -Z at depth z. */
export function annulus(cx: number, cy: number, z: number, r0: number, r1: number, segs: number, facing: 1 | -1): THREE.BufferGeometry {
  const g = surface(
    (u, v, out) => {
      const r = r0 + (r1 - r0) * u;
      const phi = v * Math.PI * 2;
      out.set(cx + Math.cos(phi) * r, cy + Math.sin(phi) * r, z);
    },
    1,
    segs,
  );
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0, facing);
  // fix winding so that the front face matches the normal
  return orientWinding(g);
}

/** Recompute triangle winding to agree with stored vertex normals (for flat pieces). */
export function orientWinding(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const index = g.getIndex();
  if (!index) return g;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const nn = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);
    a.fromBufferAttribute(p, ia);
    b.fromBufferAttribute(p, ib);
    c.fromBufferAttribute(p, ic);
    b.sub(a);
    c.sub(a);
    b.cross(c);
    nn.fromBufferAttribute(n, ia);
    if (b.dot(nn) < 0) {
      index.setX(i + 1, ic);
      index.setX(i + 2, ib);
    }
  }
  return g;
}

/** Simple cylinder between two points (for struts). */
export function strut(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, segs = 10): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(r1, r0, len, segs, 1, false);
  // CylinderGeometry is centred on the origin along +Y: move base to origin
  g.translate(0, len / 2, 0);
  g.applyMatrix4(alignY(a, dir));
  return normalize(g);
}

export function box(w: number, h: number, d: number, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (m) g.applyMatrix4(m);
  return normalize(g);
}

/** Rounded box via extrusion-free approach: a box with bevel approximated by a scaled sphere blend. */
export function roundedBox(w: number, h: number, d: number, r: number, m?: THREE.Matrix4, seg = 3): THREE.BufferGeometry {
  // Build from a box geometry with many segments, then push vertices to a rounded shape.
  const g = new THREE.BoxGeometry(w, h, d, seg * 2 + 1, seg * 2 + 1, seg * 2 + 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const hd = d / 2 - r;
  const v = new THREE.Vector3();
  const inner = new THREE.Vector3();
  const off = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(THREE.MathUtils.clamp(v.x, -hw, hw), THREE.MathUtils.clamp(v.y, -hh, hh), THREE.MathUtils.clamp(v.z, -hd, hd));
    off.subVectors(v, inner);
    if (off.lengthSq() > 1e-12) {
      off.normalize();
      n.setXYZ(i, off.x, off.y, off.z);
      off.multiplyScalar(r);
    }
    v.copy(inner).add(off);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  if (m) g.applyMatrix4(m);
  return normalize(g);
}
