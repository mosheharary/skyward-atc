// 2D polygon utilities in world XZ coordinates (x east, z south).

export type P2 = [number, number];

/** Convert sim Vec2 [x east, y north] to world [x, z]. */
export const simToXZ = (p: readonly [number, number]): P2 => [p[0], -p[1]];

function segDistSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

/** A small polygon (few edges): brute-force exact queries. */
export class SimplePolygon {
  readonly pts: Float64Array;
  readonly n: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;

  constructor(points: P2[]) {
    this.n = points.length;
    this.pts = new Float64Array(this.n * 2);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    points.forEach((p, i) => {
      this.pts[i * 2] = p[0];
      this.pts[i * 2 + 1] = p[1];
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]);
      maxZ = Math.max(maxZ, p[1]);
    });
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
  }

  contains(x: number, z: number): boolean {
    if (this.n < 3 || x < this.minX || x > this.maxX || z < this.minZ || z > this.maxZ) return false;
    let inside = false;
    const p = this.pts;
    for (let i = 0, j = this.n - 1; i < this.n; j = i++) {
      const xi = p[i * 2], zi = p[i * 2 + 1];
      const xj = p[j * 2], zj = p[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  /** Distance to the boundary; returns `cap` early when clearly farther than cap. */
  distance(x: number, z: number, cap = Infinity): number {
    if (this.n < 2) return cap;
    const bx = Math.max(this.minX - x, 0, x - this.maxX);
    const bz = Math.max(this.minZ - z, 0, z - this.maxZ);
    if (bx * bx + bz * bz > cap * cap) return cap;
    let best = Infinity;
    const p = this.pts;
    for (let i = 0, j = this.n - 1; i < this.n; j = i++) {
      const d = segDistSq(x, z, p[j * 2], p[j * 2 + 1], p[i * 2], p[i * 2 + 1]);
      if (d < best) best = d;
    }
    return Math.min(Math.sqrt(best), cap);
  }

  /** Negative inside. */
  signedDistance(x: number, z: number, cap = Infinity): number {
    const d = this.distance(x, z, cap);
    return this.contains(x, z) ? -d : d;
  }

  /** Principal direction (radians, in XZ) of the longest edge. */
  mainAxis(): number {
    let best = -1;
    let ang = 0;
    const p = this.pts;
    for (let i = 0, j = this.n - 1; i < this.n; j = i++) {
      const dx = p[i * 2] - p[j * 2];
      const dz = p[i * 2 + 1] - p[j * 2 + 1];
      const l = dx * dx + dz * dz;
      if (l > best) {
        best = l;
        ang = Math.atan2(dz, dx);
      }
    }
    return ang;
  }
}

/**
 * A set of (possibly large, many-edged) polygons, e.g. sea / bay outlines.
 * Offers: exact scanline inside tests, near-boundary exact distances (edge grid),
 * and a coarse signed distance field (EDT) for far queries.
 */
export class PolygonSet {
  readonly edges: Float64Array;
  readonly nEdges: number;
  readonly empty: boolean;
  private readonly gridCell: number;
  private readonly gridOx: number;
  private readonly gridOz: number;
  private readonly gridNx: number;
  private readonly gridNz: number;
  private readonly gridCells: Int32Array[];
  private sdf: Float32Array | null = null;
  private sdfOx = 0;
  private sdfOz = 0;
  private sdfCell = 1;
  private sdfN = 0;

  constructor(polys: P2[][], gridCell = 400) {
    const e: number[] = [];
    for (const poly of polys) {
      if (poly.length < 3) continue;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        e.push(poly[j][0], poly[j][1], poly[i][0], poly[i][1]);
      }
    }
    this.edges = new Float64Array(e);
    this.nEdges = e.length / 4;
    this.empty = this.nEdges === 0;
    this.gridCell = gridCell;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.nEdges; i++) {
      const o = i * 4;
      minX = Math.min(minX, this.edges[o], this.edges[o + 2]);
      maxX = Math.max(maxX, this.edges[o], this.edges[o + 2]);
      minZ = Math.min(minZ, this.edges[o + 1], this.edges[o + 3]);
      maxZ = Math.max(maxZ, this.edges[o + 1], this.edges[o + 3]);
    }
    if (this.empty) {
      minX = maxX = minZ = maxZ = 0;
    }
    this.gridOx = minX - gridCell;
    this.gridOz = minZ - gridCell;
    this.gridNx = Math.max(1, Math.ceil((maxX - minX) / gridCell) + 2);
    this.gridNz = Math.max(1, Math.ceil((maxZ - minZ) / gridCell) + 2);
    const lists: number[][] = new Array(this.gridNx * this.gridNz);
    for (let i = 0; i < this.nEdges; i++) {
      const o = i * 4;
      const ax = this.edges[o], az = this.edges[o + 1], bx = this.edges[o + 2], bz = this.edges[o + 3];
      // Walk the edge in small steps so long edges only register in cells they pass through.
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(len / (gridCell * 0.5)));
      let lastCell = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = Math.floor((ax + (bx - ax) * t - this.gridOx) / gridCell);
        const cz = Math.floor((az + (bz - az) * t - this.gridOz) / gridCell);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const gx = cx + dx, gz = cz + dz;
            if (gx < 0 || gz < 0 || gx >= this.gridNx || gz >= this.gridNz) continue;
            const c = gz * this.gridNx + gx;
            if (c === lastCell) continue;
            (lists[c] ??= []).push(i);
          }
        }
        lastCell = cz * this.gridNx + cx;
      }
    }
    this.gridCells = new Array(lists.length);
    for (let c = 0; c < lists.length; c++) {
      const l = lists[c];
      this.gridCells[c] = l ? Int32Array.from(new Set(l)) : new Int32Array(0);
    }
  }

  /** Sorted x positions where polygon edges cross the horizontal line at z (even-odd rule). */
  crossingsAtZ(z: number): Float64Array {
    const xs: number[] = [];
    const e = this.edges;
    for (let i = 0; i < this.nEdges; i++) {
      const o = i * 4;
      const az = e[o + 1], bz = e[o + 3];
      if (az > z !== bz > z) {
        const ax = e[o], bx = e[o + 2];
        xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
      }
    }
    const arr = Float64Array.from(xs);
    arr.sort();
    return arr;
  }

  static insideFromCrossings(xs: Float64Array, x: number): boolean {
    // count crossings strictly less than x (binary search)
    let lo = 0, hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return (lo & 1) === 1;
  }

  contains(x: number, z: number): boolean {
    if (this.empty) return false;
    let inside = false;
    const e = this.edges;
    for (let i = 0; i < this.nEdges; i++) {
      const o = i * 4;
      const az = e[o + 1], bz = e[o + 3];
      if (az > z !== bz > z) {
        const ax = e[o], bx = e[o + 2];
        if (x < ax + ((z - az) / (bz - az)) * (bx - ax)) inside = !inside;
      }
    }
    return inside;
  }

  /** Exact distance to the nearest edge, searching at most `maxR` metres. Returns maxR if none closer. */
  nearestDistance(x: number, z: number, maxR: number): number {
    if (this.empty) return maxR;
    const cell = this.gridCell;
    const cx = Math.floor((x - this.gridOx) / cell);
    const cz = Math.floor((z - this.gridOz) / cell);
    let best = maxR * maxR;
    const e = this.edges;
    const maxK = Math.ceil(maxR / cell) + 1;
    for (let k = 0; k <= maxK; k++) {
      // cells at Chebyshev ring k
      for (let dz = -k; dz <= k; dz++) {
        const gz = cz + dz;
        if (gz < 0 || gz >= this.gridNz) continue;
        const onEdgeRow = dz === -k || dz === k;
        for (let dx = -k; dx <= k; dx += onEdgeRow ? 1 : 2 * k || 1) {
          const gx = cx + dx;
          if (gx < 0 || gx >= this.gridNx) continue;
          const list = this.gridCells[gz * this.gridNx + gx];
          for (let li = 0; li < list.length; li++) {
            const o = list[li] * 4;
            const d = segDistSq(x, z, e[o], e[o + 1], e[o + 2], e[o + 3]);
            if (d < best) best = d;
          }
        }
      }
      const ringDist = k * cell;
      if (best < ringDist * ringDist) break;
    }
    return Math.sqrt(best);
  }

  /** Build a coarse signed distance field (negative inside) over [-half, half]^2. */
  buildSdf(half: number, n: number): void {
    if (this.empty) return;
    const cell = (2 * half) / n;
    const size = n + 1;
    const inside = new Uint8Array(size * size);
    for (let j = 0; j < size; j++) {
      const z = -half + j * cell;
      const xs = this.crossingsAtZ(z);
      let k = 0;
      let state = false;
      for (let i = 0; i < size; i++) {
        const x = -half + i * cell;
        while (k < xs.length && xs[k] < x) {
          state = !state;
          k++;
        }
        inside[j * size + i] = state ? 1 : 0;
      }
    }
    const INF = 1e20;
    const fIn = new Float64Array(size * size);
    const fOut = new Float64Array(size * size);
    for (let i = 0; i < size * size; i++) {
      fOut[i] = inside[i] ? 0 : INF; // distance from outside points to inside region
      fIn[i] = inside[i] ? INF : 0; // distance from inside points to outside region
    }
    edt2d(fOut, size);
    edt2d(fIn, size);
    const sdf = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      sdf[i] = inside[i] ? -Math.sqrt(fIn[i]) * cell : Math.sqrt(fOut[i]) * cell;
    }
    this.sdf = sdf;
    this.sdfOx = -half;
    this.sdfOz = -half;
    this.sdfCell = cell;
    this.sdfN = size;
  }

  /** Coarse signed distance (bilinear). Outside the SDF area returns +far. */
  coarseSigned(x: number, z: number): number {
    if (!this.sdf) return 1e7;
    const u = (x - this.sdfOx) / this.sdfCell;
    const v = (z - this.sdfOz) / this.sdfCell;
    const n = this.sdfN;
    if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) {
      // clamp to border
      const cu = Math.min(Math.max(Math.round(u), 0), n - 1);
      const cv = Math.min(Math.max(Math.round(v), 0), n - 1);
      return this.sdf[cv * n + cu];
    }
    const i = Math.floor(u), j = Math.floor(v);
    const fu = u - i, fv = v - j;
    const s = this.sdf;
    const a = s[j * n + i], b = s[j * n + i + 1], c = s[(j + 1) * n + i], d = s[(j + 1) * n + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  }

  /**
   * Signed distance (negative inside). Exact within `exactR` of the coastline, coarse beyond.
   * `rowXs` optionally supplies the crossings for this z (fast inside test in scanline loops).
   */
  signedDistance(x: number, z: number, exactR = 1500, rowXs?: Float64Array): number {
    if (this.empty) return 1e7;
    const coarse = this.coarseSigned(x, z);
    if (Math.abs(coarse) > exactR + this.sdfCell * 1.5) return coarse;
    const d = this.nearestDistance(x, z, exactR + this.sdfCell * 2);
    const inside = rowXs ? PolygonSet.insideFromCrossings(rowXs, x) : this.contains(x, z);
    return inside ? -d : d;
  }
}

// Felzenszwalb & Huttenlocher squared Euclidean distance transform (in place), grid size n x n.
function edt2d(f: Float64Array, n: number): void {
  const col = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const zz = new Float64Array(n + 1);
  // rows
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) col[x] = f[y * n + x];
    edt1d(col, n, d, v, zz);
    for (let x = 0; x < n; x++) f[y * n + x] = d[x];
  }
  // columns
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) col[y] = f[y * n + x];
    edt1d(col, n, d, v, zz);
    for (let y = 0; y < n; y++) f[y * n + x] = d[y];
  }
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}
