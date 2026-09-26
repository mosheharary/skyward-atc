// Deterministic noise + PRNG helpers for procedural environment generation.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of a 2D lattice point -> [0, 1). */
export function hash2i(ix: number, iy: number, seed = 0): number {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const GRAD = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071],
];

/** Seeded 2D gradient (Perlin-style) noise with optional periodic tiling. Output ~[-1, 1]. */
export class Noise2D {
  private readonly perm = new Uint16Array(512);

  constructor(seed: number) {
    const rnd = mulberry32(seed);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(ix: number, iy: number, fx: number, fy: number): number {
    const g = GRAD[this.perm[(this.perm[ix & 255] + iy) & 511] & 7];
    return g[0] * fx + g[1] * fy;
  }

  /** Gradient noise. If period > 0 the lattice wraps every `period` units (tileable). */
  noise(x: number, y: number, period = 0): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    let ix0 = x0;
    let iy0 = y0;
    let ix1 = x0 + 1;
    let iy1 = y0 + 1;
    if (period > 0) {
      ix0 = ((ix0 % period) + period) % period;
      iy0 = ((iy0 % period) + period) % period;
      ix1 = ((ix1 % period) + period) % period;
      iy1 = ((iy1 % period) + period) % period;
    }
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const n00 = this.grad(ix0 & 255, iy0 & 255, fx, fy);
    const n10 = this.grad(ix1 & 255, iy0 & 255, fx - 1, fy);
    const n01 = this.grad(ix0 & 255, iy1 & 255, fx, fy - 1);
    const n11 = this.grad(ix1 & 255, iy1 & 255, fx - 1, fy - 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 1.414;
  }

  /** Fractal sum, normalised to roughly [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2, gain = 0.5, period = 0): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * f, y * f, period > 0 ? period * f : 0);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] (sharp crests). */
  ridged(x: number, y: number, octaves = 5): number {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let prev = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise(x * f, y * f));
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = n;
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / norm;
  }
}
