// Procedural textures for the airport: asphalt / concrete (albedo, normal, roughness), a marking
// glyph atlas, tyre rubber streaks, building facades with lit-window emissive maps, corrugated
// metal, apron light pools and chain-link fence.

import * as THREE from 'three';
import { mulberry } from './geo';

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat = true, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise (periodic on a grid of `cells`). */
function periodicNoise(size: number, cells: number, rnd: () => number): Float32Array {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * cells;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const a = g[(y0 % cells) * cells + (x0 % cells)];
      const b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = g[((y0 + 1) % cells) * cells + (x0 % cells)];
      const d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

function fbm(size: number, octaves: [number, number][], rnd: () => number): Float32Array {
  const out = new Float32Array(size * size);
  let norm = 0;
  for (const [cells, amp] of octaves) {
    const n = periodicNoise(size, cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    norm += amp;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Normal map (tangent space) from a height field. */
function normalFromHeight(h: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * size + x) * 4;
      img.data[o] = (nx * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface SurfaceSet {
  map: THREE.Texture;
  normal: THREE.Texture;
  rough: THREE.Texture;
}

/**
 * Asphalt: fine aggregate, patch repairs and cracks. `grooves` adds transverse grooving
 * (runway) along the texture's u axis (the texture v axis is laid along the runway).
 */
export function makeAsphalt(size: number, seed: number, grooves: boolean): SurfaceSet {
  const rnd = mulberry(seed);
  const base = fbm(size, [[4, 1], [8, 0.6], [32, 0.35], [128, 0.25]], rnd);
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const n = base[i];
    const grain = rnd();
    let v = 0.2 + (n - 0.5) * 0.12 + (grain - 0.5) * 0.09;
    if (grain > 0.985) v += 0.13; // light aggregate stones
    if (grain < 0.01) v -= 0.07;
    const o = i * 4;
    img.data[o] = Math.max(0, Math.min(255, v * 255 * 1.02));
    img.data[o + 1] = Math.max(0, Math.min(255, v * 255));
    img.data[o + 2] = Math.max(0, Math.min(255, v * 255 * 0.97));
    img.data[o + 3] = 255;
    height[i] = grain * 0.6 + n * 0.4;
    rough[i] = 0.78 + (grain - 0.5) * 0.25;
  }
  ctx.putImageData(img, 0, 0);
  // Repair patches (darker rectangles) and sealed cracks.
  for (let k = 0; k < 6; k++) {
    ctx.fillStyle = `rgba(20,20,22,${0.12 + rnd() * 0.15})`;
    const w = size * (0.08 + rnd() * 0.2);
    const h = size * (0.05 + rnd() * 0.15);
    ctx.fillRect(rnd() * size, rnd() * size, w, h);
  }
  ctx.strokeStyle = 'rgba(12,12,12,0.55)';
  for (let k = 0; k < 10; k++) {
    ctx.lineWidth = 0.8 + rnd() * 1.4;
    ctx.beginPath();
    let x = rnd() * size;
    let y = rnd() * size;
    ctx.moveTo(x, y);
    for (let s = 0; s < 14; s++) {
      x += (rnd() - 0.5) * size * 0.06;
      y += (rnd() - 0.3) * size * 0.05;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (grooves) {
    for (let y = 0; y < size; y++) {
      const g = y % 4 === 0 ? -0.35 : 0;
      for (let x = 0; x < size; x++) height[y * size + x] += g;
    }
  }
  const [rc, rctx] = canvas(size);
  const rimg = rctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(1, rough[i])) * 255;
    rimg.data[i * 4] = v;
    rimg.data[i * 4 + 1] = v; // roughness is read from G
    rimg.data[i * 4 + 2] = v;
    rimg.data[i * 4 + 3] = 255;
  }
  rctx.putImageData(rimg, 0, 0);
  return { map: tex(c, true), normal: tex(normalFromHeight(height, size, 2.2), false), rough: tex(rc, false) };
}

/** Concrete apron slabs: one texture tile = 2 x 2 slabs with sealed joints. */
export function makeConcrete(size: number, seed: number): SurfaceSet {
  const rnd = mulberry(seed);
  const base = fbm(size, [[4, 1], [16, 0.5], [64, 0.3], [256, 0.2]], rnd);
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const half = size / 2;
  const slabTint = [rnd(), rnd(), rnd(), rnd()].map((v) => (v - 0.5) * 0.07);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const n = base[i];
      const grain = rnd();
      const slab = (y < half ? 0 : 2) + (x < half ? 0 : 1);
      let v = 0.56 + (n - 0.5) * 0.14 + (grain - 0.5) * 0.05 + slabTint[slab];
      const jx = Math.min(x % half, half - (x % half));
      const jy = Math.min(y % half, half - (y % half));
      const joint = Math.min(jx, jy);
      if (joint < 1.5) v *= 0.45;
      else if (joint < 3) v *= 0.85;
      const o = i * 4;
      img.data[o] = v * 255;
      img.data[o + 1] = v * 252;
      img.data[o + 2] = v * 244;
      img.data[o + 3] = 255;
      height[i] = n * 0.5 + grain * 0.2 - (joint < 2 ? 0.8 : 0);
    }
  }
  ctx.putImageData(img, 0, 0);
  // Oil and rubber stains.
  for (let k = 0; k < 14; k++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = size * (0.02 + rnd() * 0.07);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(30,28,25,${0.15 + rnd() * 0.25})`);
    g.addColorStop(1, 'rgba(30,28,25,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const [rc, rctx] = canvas(8);
  rctx.fillStyle = 'rgb(200,200,200)';
  rctx.fillRect(0, 0, 8, 8);
  return { map: tex(c, true), normal: tex(normalFromHeight(height, size, 1.5), false), rough: tex(rc, false) };
}

/** Low-frequency variation used to break up texture repetition. */
export function makeMacro(size: number, seed: number): THREE.Texture {
  const rnd = mulberry(seed);
  const n = fbm(size, [[3, 1], [6, 0.7], [12, 0.5], [24, 0.3]], rnd);
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, ((n[i] - 0.5) * 1.8 + 0.5) * 255));
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return tex(c, false);
}

// ---------------------------------------------------------------------------- glyph atlas

export const ATLAS_CHARS = '0123456789LRCABDEFGHIJKMNOPQSTUVWXYZ-';
const ATLAS_GRID = 7;

export interface Atlas {
  texture: THREE.Texture;
  /** UV rect [u0, v0, u1, v1] of a glyph. */
  glyph(ch: string): [number, number, number, number];
  /** UV rect of the solid (paint) cell. */
  solid: [number, number, number, number];
  /** Glyph width / height ratio. */
  aspect: number;
}

export function makeAtlas(seed: number): Atlas {
  const size = 1024;
  const cell = size / ATLAS_GRID;
  const [c, ctx] = canvas(size);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const rects: Record<string, [number, number, number, number]> = {};
  const toUv = (col: number, row: number, inset: number): [number, number, number, number] => {
    const x0 = col * cell + inset;
    const x1 = (col + 1) * cell - inset;
    const y0 = row * cell + inset;
    const y1 = (row + 1) * cell - inset;
    // flipY: canvas row 0 is at v = 1.
    return [x0 / size, 1 - y1 / size, x1 / size, 1 - y0 / size];
  };
  const aspect = 0.58;
  for (let i = 0; i < ATLAS_CHARS.length; i++) {
    const col = i % ATLAS_GRID;
    const row = Math.floor(i / ATLAS_GRID);
    const cx = col * cell + cell / 2;
    const cy = row * cell + cell / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(0.62, 1);
    ctx.font = `bold ${Math.round(cell * 0.98)}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText(ATLAS_CHARS[i], 0, cell * 0.04);
    ctx.restore();
    // Glyph cell cropped horizontally to the aspect.
    const hw = (cell * aspect) / 2;
    rects[ATLAS_CHARS[i]] = [(cx - hw) / size, 1 - (row + 1) * cell / size + 1 / size, (cx + hw) / size, 1 - row * cell / size - 1 / size];
  }
  // Solid cell = last cell, with slight paint wear.
  const scol = ATLAS_GRID - 1;
  const srow = ATLAS_GRID - 1;
  const rnd = mulberry(seed);
  const img = ctx.getImageData(scol * cell, srow * cell, cell, cell);
  for (let i = 0; i < cell * cell; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 205 + rnd() * 50;
  }
  ctx.putImageData(img, scol * cell, srow * cell);
  // Wear speckles on glyphs.
  ctx.globalCompositeOperation = 'destination-out';
  for (let k = 0; k < 9000; k++) {
    ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.5})`;
    ctx.fillRect(rnd() * size, rnd() * (size - cell), 2, 2);
  }
  ctx.globalCompositeOperation = 'source-over';
  const t = tex(c, true, false, 8);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const solid = toUv(scol, srow, cell * 0.3);
  return {
    texture: t,
    glyph: (ch: string) => rects[ch] ?? rects['-'],
    solid,
    aspect,
  };
}

/** Tyre rubber streaks: u = across the runway, v = along. */
export function makeRubber(seed: number): THREE.Texture {
  const rnd = mulberry(seed);
  const w = 256;
  const h = 1024;
  const [c, ctx] = canvas(w, h);
  ctx.clearRect(0, 0, w, h);
  for (let k = 0; k < 900; k++) {
    // Main gear tracks cluster around +/- 0.2 of the width, nose gear on the centreline.
    const side = rnd();
    let x: number;
    if (side < 0.42) x = 0.3 + (rnd() - 0.5) * 0.16;
    else if (side < 0.84) x = 0.7 + (rnd() - 0.5) * 0.16;
    else x = 0.5 + (rnd() - 0.5) * 0.1;
    const y0 = rnd() * h;
    const len = h * (0.05 + rnd() * 0.35);
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    const a = 0.05 + rnd() * 0.18;
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.15, `rgba(0,0,0,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x * w, y0, 1 + rnd() * 3, len);
  }
  // Overall darkening fading along v (heaviest near touchdown, v ~ 0.2).
  const t = tex(c, false, false, 8);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// ---------------------------------------------------------------------------- facades

export interface FacadeSet {
  map: THREE.Texture;
  emissive: THREE.Texture;
  /** Metres covered by one texture repeat (u, v). */
  cell: [number, number];
}

/**
 * Facade tile of 8 x 8 window cells. kind:
 *  'glass'   curtain wall (terminal, tower base)
 *  'punched' concrete with punched windows (offices, hotel)
 *  'garage'  multi-storey car park (open slots)
 */
export function makeFacade(kind: 'glass' | 'punched' | 'garage', seed: number): FacadeSet {
  const rnd = mulberry(seed);
  const size = 512;
  const n = 8;
  const cw = size / n;
  const [c, ctx] = canvas(size);
  const [e, ectx] = canvas(size);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, size, size);
  let cell: [number, number];
  if (kind === 'glass') {
    cell = [3 * n, 4.5 * n];
    // Reflective blue-grey glass with horizontal gradient variations.
    for (let r = 0; r < n; r++) {
      for (let q = 0; q < n; q++) {
        const x = q * cw;
        const y = r * cw;
        const t = 90 + rnd() * 30;
        const g = ctx.createLinearGradient(x, y, x, y + cw);
        g.addColorStop(0, `rgb(${t * 0.7},${t * 0.85},${t})`);
        g.addColorStop(1, `rgb(${t * 0.45},${t * 0.55},${t * 0.68})`);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, cw, cw);
        // Interior lighting (most cells lit, warm-white to cool-white).
        const lit = rnd() < 0.82;
        if (lit) {
          const k = 0.55 + rnd() * 0.45;
          const warm = rnd() < 0.6;
          ectx.fillStyle = warm ? `rgb(${255 * k},${225 * k},${170 * k})` : `rgb(${235 * k},${240 * k},${255 * k})`;
          ectx.fillRect(x + 2, y + 2, cw - 4, cw - 4);
        }
      }
    }
    // Mullions / transoms.
    ctx.fillStyle = '#c9ccd0';
    ectx.fillStyle = '#000';
    for (let q = 0; q <= n; q++) {
      ctx.fillRect(q * cw - 2, 0, 4, size);
      ectx.fillRect(q * cw - 2, 0, 4, size);
    }
    for (let r = 0; r <= n; r++) {
      ctx.fillRect(0, r * cw - 3, size, 6);
      ectx.fillRect(0, r * cw - 3, size, 6);
    }
  } else if (kind === 'punched') {
    cell = [3.6 * n, 3.6 * n];
    ctx.fillStyle = '#d8d4cc';
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < n; r++) {
      for (let q = 0; q < n; q++) {
        const x = q * cw + cw * 0.18;
        const y = r * cw + cw * 0.22;
        const w = cw * 0.64;
        const h = cw * 0.5;
        const t = 50 + rnd() * 40;
        ctx.fillStyle = `rgb(${t * 0.8},${t * 0.9},${t})`;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x, y, w, h * 0.25);
        if (rnd() < 0.55) {
          const k = 0.4 + rnd() * 0.6;
          const warm = rnd() < 0.7;
          ectx.fillStyle = warm ? `rgb(${255 * k},${205 * k},${140 * k})` : `rgb(${220 * k},${230 * k},${255 * k})`;
          ectx.fillRect(x, y, w, h);
        }
      }
    }
    // Weathering.
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = `rgba(90,85,80,${rnd() * 0.08})`;
      ctx.fillRect(rnd() * size, rnd() * size, 4 + rnd() * 30, 20 + rnd() * 90);
    }
  } else {
    cell = [4 * n, 3 * n];
    ctx.fillStyle = '#b8b5ae';
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < n; r++) {
      const y = r * cw + cw * 0.28;
      ctx.fillStyle = '#26282b';
      ctx.fillRect(0, y, size, cw * 0.55);
      ectx.fillStyle = 'rgb(160,150,120)';
      ectx.fillRect(0, y, size, cw * 0.55);
      // Parked cars glimpsed through the openings.
      for (let q = 0; q < 24; q++) {
        if (rnd() < 0.5) continue;
        const col = [`#8a1c1c`, `#1c2c6a`, `#d9d9d9`, `#222`, `#777`, `#406040`][Math.floor(rnd() * 6)];
        ctx.fillStyle = col;
        ctx.fillRect((q / 24) * size + 2, y + cw * 0.3, size / 24 - 5, cw * 0.25);
      }
    }
  }
  const map = tex(c, true);
  const emissive = tex(e, true);
  return { map, emissive, cell };
}

/** Corrugated metal cladding (vertical ribs): returns albedo (light, tint with vertex colour) + normal. */
export function makeMetal(seed: number): { map: THREE.Texture; normal: THREE.Texture } {
  const rnd = mulberry(seed);
  const size = 256;
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const noise = fbm(size, [[4, 1], [16, 0.4]], rnd);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const rib = Math.sin((x / size) * Math.PI * 2 * 24);
      height[i] = rib * 0.5;
      const v = 0.78 + rib * 0.04 + (noise[i] - 0.5) * 0.08 - (y > size * 0.96 ? 0.1 : 0);
      img.data[i * 4] = v * 255;
      img.data[i * 4 + 1] = v * 255;
      img.data[i * 4 + 2] = v * 255;
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: tex(c, true), normal: tex(normalFromHeight(height, size, 3), false) };
}

/** Gravel / membrane roof. */
export function makeRoof(seed: number): THREE.Texture {
  const rnd = mulberry(seed);
  const size = 256;
  const n = fbm(size, [[4, 1], [16, 0.5], [64, 0.4]], rnd);
  const [c, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 0.5 + (n[i] - 0.5) * 0.2 + (rnd() - 0.5) * 0.12;
    img.data[i * 4] = v * 250;
    img.data[i * 4 + 1] = v * 248;
    img.data[i * 4 + 2] = v * 240;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return tex(c, true);
}

/** Radial gradient used for apron floodlight pools (additive). */
export function makePool(): THREE.Texture {
  const size = 128;
  const [c, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = tex(c, false, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Chain-link fence (alpha-tested). */
export function makeFence(): THREE.Texture {
  const size = 64;
  const [c, ctx] = canvas(size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(200,205,210,1)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(size, size);
  ctx.moveTo(size, 0);
  ctx.lineTo(0, size);
  ctx.stroke();
  const t = tex(c, true);
  return t;
}
