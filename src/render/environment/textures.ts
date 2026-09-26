// Procedural textures (no external assets): terrain detail, macro variation, water normals, cloud puffs.
import * as THREE from 'three';
import { Noise2D, mulberry32 } from './noise';

function finish(tex: THREE.DataTexture, renderer?: THREE.WebGLRenderer, anisotropy = 8): THREE.DataTexture {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  if (renderer) tex.anisotropy = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  tex.needsUpdate = true;
  return tex;
}

const to8 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

/**
 * Tileable RGBA detail texture. Each channel is a luminance modulation pattern centred on 0.5:
 * R = grass blades/clumps, G = soil/furrow grain, B = rock cracks, A = sand ripples.
 */
export function makeDetailTexture(size: number, seed: number, renderer?: THREE.WebGLRenderer): THREE.DataTexture {
  const n = new Noise2D(seed);
  const n2 = new Noise2D(seed + 17);
  const data = new Uint8Array(size * size * 4);
  const P = 16; // lattice period for the base frequency
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * P;
      const v = (y / size) * P;
      // grass: clumps + fine blades
      const clump = n.fbm(u, v, 3, 2, 0.5, P);
      const blades = n2.noise(u * 8, v * 8, P * 8);
      const grass = 0.5 + clump * 0.22 + blades * 0.16;
      // soil: grainy pebbles
      const grain = n2.fbm(u * 2, v * 2, 4, 2, 0.55, P * 2);
      const pebble = Math.max(0, n.noise(u * 6 + 3.1, v * 6 - 1.7, P * 6)) * 0.35;
      const soil = 0.5 + grain * 0.25 + pebble - 0.08;
      // rock: ridged cracks
      const r1 = 1 - Math.abs(n.fbm(u * 1.5 + 11, v * 1.5 - 5, 4, 2, 0.5, P * 1.5));
      const rock = 0.3 + r1 * r1 * 0.45 + n2.noise(u * 4, v * 4, P * 4) * 0.1;
      // sand: wind ripples
      const warp = n.noise(u * 0.5, v * 0.5, P * 0.5) * 3;
      const ripple = Math.sin((v * 5 + warp) * Math.PI * 2) * 0.12;
      const sand = 0.5 + ripple + n2.noise(u * 10, v * 10, P * 10) * 0.08;
      const o = (y * size + x) * 4;
      data[o] = to8(grass);
      data[o + 1] = to8(soil);
      data[o + 2] = to8(rock);
      data[o + 3] = to8(sand);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finish(tex, renderer, 16);
}

/** Tileable normal map for generic ground bumpiness. */
export function makeDetailNormal(size: number, seed: number, strength: number, renderer?: THREE.WebGLRenderer): THREE.DataTexture {
  const n = new Noise2D(seed);
  const h = new Float32Array(size * size);
  const P = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * P;
      const v = (y / size) * P;
      h[y * size + x] = n.fbm(u, v, 5, 2, 0.55, P) + 0.35 * n.noise(u * 12, v * 12, P * 12);
    }
  }
  return heightToNormal(h, size, strength, renderer);
}

function heightToNormal(h: Float32Array, size: number, strength: number, renderer?: THREE.WebGLRenderer): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = h[y * size + ((x - 1 + size) % size)];
      const xr = h[y * size + ((x + 1) % size)];
      const yu = h[((y - 1 + size) % size) * size + x];
      const yd = h[((y + 1) % size) * size + x];
      let nx = (xl - xr) * strength;
      let ny = (yu - yd) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * size + x) * 4;
      data[o] = to8(nx * 0.5 + 0.5);
      data[o + 1] = to8(ny * 0.5 + 0.5);
      data[o + 2] = to8(nz * 0.5 + 0.5);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finish(tex, renderer, 16);
}

/** Low-frequency tileable noise (R,G fbm; B ridged; A cellular-ish) for macro colour variation. */
export function makeMacroNoise(size: number, seed: number): THREE.DataTexture {
  const n = new Noise2D(seed);
  const n2 = new Noise2D(seed + 99);
  const data = new Uint8Array(size * size * 4);
  const P = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * P;
      const v = (y / size) * P;
      const a = n.fbm(u, v, 5, 2, 0.5, P);
      const b = n2.fbm(u + 3.3, v - 7.1, 5, 2, 0.5, P);
      const r = 1 - Math.abs(n.fbm(u * 2 + 1.7, v * 2 + 9.2, 4, 2, 0.5, P * 2));
      const c = n2.noise(u * 3, v * 3, P * 3);
      const o = (y * size + x) * 4;
      data[o] = to8(a * 0.5 + 0.5);
      data[o + 1] = to8(b * 0.5 + 0.5);
      data[o + 2] = to8(r * r);
      data[o + 3] = to8(c * 0.5 + 0.5);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  return finish(tex);
}

/** Tileable water normal map: sum of periodic directional waves + noise (like the classic waternormals). */
export function makeWaterNormals(size: number, seed: number, renderer?: THREE.WebGLRenderer): THREE.DataTexture {
  const rnd = mulberry32(seed);
  const n = new Noise2D(seed + 5);
  const waves: { kx: number; ky: number; amp: number; ph: number }[] = [];
  for (let i = 0; i < 28; i++) {
    const k = 2 + Math.floor(rnd() * 22);
    const ang = rnd() * Math.PI * 2;
    // integer wave vectors keep the texture tileable
    const kx = Math.round(Math.cos(ang) * k);
    const ky = Math.round(Math.sin(ang) * k);
    if (kx === 0 && ky === 0) continue;
    waves.push({ kx, ky, amp: 1 / Math.pow(Math.hypot(kx, ky), 1.25), ph: rnd() * Math.PI * 2 });
  }
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let s = 0;
      for (const w of waves) s += w.amp * Math.sin((w.kx * u + w.ky * v) * Math.PI * 2 + w.ph);
      s += n.fbm(u * 16, v * 16, 4, 2, 0.5, 16) * 0.25;
      h[y * size + x] = s;
    }
  }
  return heightToNormal(h, size, size / 64, renderer);
}

/**
 * 2x2 atlas of soft cumulus puffs. RGB = self-shadow term (1 = lit rim, 0 = dense core), A = opacity.
 */
export function makeCloudAtlas(size: number, seed: number): THREE.DataTexture {
  const n = new Noise2D(seed);
  const rnd = mulberry32(seed + 3);
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * half;
    const oy = Math.floor(q / 2) * half;
    // several blobs per puff
    const blobs: { x: number; y: number; r: number }[] = [];
    const count = 4 + Math.floor(rnd() * 4);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * 0.22;
      blobs.push({ x: 0.5 + Math.cos(a) * d, y: 0.52 + Math.sin(a) * d * 0.7, r: 0.16 + rnd() * 0.16 });
    }
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const u = x / half;
        const v = y / half;
        let dens = 0;
        for (const b of blobs) {
          const dx = (u - b.x) / b.r;
          const dy = (v - b.y) / b.r;
          dens += Math.exp(-(dx * dx + dy * dy) * 1.6);
        }
        const fb = n.fbm(u * 5 + q * 13.7, v * 5 - q * 7.3, 5, 2.1, 0.55);
        dens = dens * (0.75 + 0.5 * fb) - 0.18;
        // flatter, darker base: fade the bottom edge
        const edge = Math.min(u, 1 - u, v, 1 - v);
        dens *= Math.min(1, edge * 6);
        // Soft, wispy falloff (puffs must blend into one cloud body, not read as individual balls), and only a
        // gentle core darkening: the cloud-scale shading comes from the per-puff height term in the shader.
        const fine = n.fbm(u * 14 - q * 3.1, v * 14 + q * 5.9, 3, 2.2, 0.5);
        const d2 = Math.max(0, dens * (0.7 + 0.6 * fine));
        const alpha = Math.max(0, Math.min(1, Math.pow(Math.min(1, d2 * 1.1), 1.6)));
        const shade = Math.max(0, Math.min(1, 1 - d2 * 0.32 + (1 - v) * 0.12));
        const o = ((oy + y) * size + ox + x) * 4;
        data[o] = to8(shade);
        data[o + 1] = to8(shade);
        data[o + 2] = to8(shade);
        data[o + 3] = to8(alpha);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
