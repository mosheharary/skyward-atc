// Large terrain built from nested square LOD rings centred on the airport reference point.
// Ring l has cell size c0 * 3^l; ring boundaries are snapped so there are no cracks.
// heightAt() interpolates the stored vertex heights exactly like the rendered triangles.
import * as THREE from 'three';
import type { AirportDef } from '../../sim/airports/types';
import { PolygonSet, SimplePolygon, simToXZ, type P2 } from './geom';
import { Noise2D, mulberry32 } from './noise';
import type { PaletteDef } from './palettes';
import { terrainFragmentPars, terrainVertexMain, terrainVertexPars } from './terrainShader';

const FT = 0.3048;

export interface TerrainQuality {
  /** Finest cell size (m). */
  c0: number;
  /** Half-extent of each ring in its own cells (must be multiples of 3 for rings that have a successor). */
  halfCells: number[];
  /** Tiles per ring side (frustum-culling granularity). */
  tiles: number;
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Smooth max(a, b) with softness k. */
function smax(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + (h * h * k) / 4;
}

export interface CityXZ {
  x: number;
  z: number;
  r: number;
  density: number;
  angle: number;
  maxHeight: number;
  towers: number;
}
interface HillXZ {
  x: number;
  z: number;
  r: number;
  h: number;
}
interface ForestXZ {
  x: number;
  z: number;
  r: number;
  density: number;
}

export interface SurfaceSample {
  h: number;
  air: number;
  farm: number;
  forest: number;
  urban: number;
  sand: number;
  rock: number;
  shore: number;
  hill: number;
}

/** Analytic terrain description: heights + surface weights at any world (x, z). */
export class TerrainField {
  readonly seaY: number;
  readonly water: PolygonSet;
  readonly flat: SimplePolygon;
  readonly flatBlend: number;
  readonly cities: CityXZ[];
  readonly hills: HillXZ[];
  readonly forests: ForestXZ[];
  readonly roughness: number;
  readonly palette: PaletteDef;
  readonly farmAngle: number;
  readonly mowAngle: number;
  readonly flatMargin: number;
  private readonly n1: Noise2D;
  private readonly n2: Noise2D;
  private readonly n3: Noise2D;
  private readonly n4: Noise2D;
  private readonly coastRamp: number;

  constructor(airport: AirportDef, palette: PaletteDef, c0: number, extent: number) {
    const sc = airport.scenery;
    this.seaY = -airport.elevationFt * FT;
    this.palette = palette;
    const seed = hashStr(airport.id);
    this.n1 = new Noise2D(seed);
    this.n2 = new Noise2D(seed + 1);
    this.n3 = new Noise2D(seed + 2);
    this.n4 = new Noise2D(seed + 3);
    const waterPolys: P2[][] = sc.water.map((poly) => poly.map(simToXZ));
    this.water = new PolygonSet(waterPolys, 400);
    this.water.buildSdf(extent, 1024);
    this.flat = new SimplePolygon(sc.flatZone.map(simToXZ));
    this.flatBlend = Math.max(50, sc.flatBlend);
    this.flatMargin = c0 * 1.5;
    const rnd = mulberry32(seed + 77);
    this.cities = sc.cities.map((c) => {
      const [x, z] = simToXZ(c.pos);
      return { x, z, r: c.radius, density: c.density, angle: rnd() * Math.PI * 0.5, maxHeight: c.maxHeight, towers: c.skyscrapers };
    });
    this.hills = sc.hills.map((h) => {
      const [x, z] = simToXZ(h.pos);
      return { x, z, r: h.radius, h: h.height };
    });
    this.forests = sc.forests.map((f) => {
      const [x, z] = simToXZ(f.pos);
      return { x, z, r: f.radius, density: f.density };
    });
    this.roughness = sc.roughness;
    this.farmAngle = rnd() * Math.PI;
    this.mowAngle = this.flat.n >= 2 ? this.flat.mainAxis() : 0;
    this.coastRamp = Math.min(15000, Math.max(500, Math.abs(this.seaY) * 260));
  }

  /** Full surface evaluation. `lodCell` limits noise octaves; `rowXs` speeds up water inside tests. */
  sample(x: number, z: number, lodCell: number, out: SurfaceSample, rowXs?: Float64Array): SurfaceSample {
    const sdW = this.water.empty ? 1e7 : this.water.signedDistance(x, z, 1500, rowXs);
    const sdF = this.flat.signedDistance(x, z, this.flatBlend + this.flatMargin + 500);

    // --- natural land height
    let base = 0;
    if (!this.water.empty && this.seaY < -0.5) base = lerp(this.seaY + 1.2, 0, smoothstep(0, this.coastRamp, sdW));
    const r = this.roughness;
    const nz = this.n1.fbm(x / 12000, z / 12000, lodCell < 900 ? 4 : 3) * 0.5 + 0.35;
    let nn = nz * 42 * r;
    nn += this.n2.fbm(x / 3000, z / 3000, lodCell < 250 ? 4 : lodCell < 800 ? 3 : 2) * 13 * r;
    if (lodCell < 120) nn += this.n3.fbm(x / 650, z / 650, 3) * 3.5 * r;
    nn *= smoothstep(0, 700, sdW);
    let hill = 0;
    let ridgeCache = -1;
    for (const hl of this.hills) {
      const dx = x - hl.x;
      const dz = z - hl.z;
      const t2 = (dx * dx + dz * dz) / (hl.r * hl.r);
      if (t2 > 4) continue;
      if (ridgeCache < 0) ridgeCache = this.n4.ridged(x / 2400, z / 2400, lodCell < 300 ? 5 : 3);
      const shape = Math.exp(-t2 * 1.7) - Math.exp(-4 * 1.7);
      hill += hl.h * Math.max(0, shape) * (0.62 + 0.55 * ridgeCache);
    }
    let land = base + nn + hill;

    // --- coast
    let hc: number;
    if (sdW < 0) {
      hc = Math.max(this.seaY - 40, this.seaY + 0.45 + sdW * 0.035);
    } else {
      land = smax(land, this.seaY + 0.9, 3);
      hc = lerp(this.seaY + 0.45, land, smoothstep(0, 110, sdW));
    }

    // --- flat airport zone
    const wFlat = smoothstep(0, this.flatBlend, sdF - this.flatMargin);
    out.h = hc * wFlat;

    // --- surface weights
    out.air = 1 - smoothstep(-30, 70, sdF);
    let urban = 0;
    for (const c of this.cities) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.r * 1.4) continue;
      const jitter = this.n3.noise(x / 900 + 13, z / 900 - 7) * 0.14 * c.r;
      urban = Math.max(urban, (1 - smoothstep(0.72 * c.r, 1.05 * c.r, d + jitter)) * Math.min(1, 0.35 + c.density));
    }
    let forest = 0;
    for (const f of this.forests) {
      const d = Math.hypot(x - f.x, z - f.z);
      if (d > f.r * 1.5) continue;
      const jitter = this.n2.noise(x / 1400 - 3, z / 1400 + 9) * 0.35 * f.r;
      forest = Math.max(forest, (1 - smoothstep(0.45 * f.r, 1.0 * f.r, d + jitter)) * Math.min(1, f.density * 1.3));
    }
    // scattered woods
    const woods = smoothstep(0.66, 0.78, this.n4.fbm(x / 2300 + 40, z / 2300 - 11, 3) * 0.5 + 0.5);
    forest = Math.max(forest, woods * 0.9);
    const awayFromAirport = smoothstep(80, 400, sdF);
    const awayFromWater = smoothstep(100, 350, sdW);
    urban *= smoothstep(20, 150, sdW) * smoothstep(0, 150, sdF);
    forest *= (1 - urban) * awayFromWater * awayFromAirport;
    const fl = this.palette.farmland;
    const farmN = this.n2.fbm(x / 6500 + 31, z / 6500 - 17, 3) * 0.5 + 0.5;
    let farm = smoothstep(1 - fl - 0.1, 1 - fl + 0.1, farmN);
    farm *= (1 - urban) * (1 - forest) * awayFromWater * awayFromAirport * (1 - smoothstep(60, 180, hill));
    let sand = sdW < 0 ? 1 : 1 - smoothstep(15, 95, sdW);
    if (this.palette.dryness > 0.7) sand = Math.max(sand, smoothstep(0.6, 0.75, this.n1.noise(x / 1800, z / 1800) * 0.5 + 0.5) * 0.8);
    sand *= 1 - out.air;
    out.urban = urban * (1 - out.air);
    out.forest = forest;
    out.farm = farm;
    out.sand = sand;
    out.rock = smoothstep(140, 420, hill) * (0.45 + 0.55 * Math.max(0, ridgeCache));
    out.shore = sdW < 0 ? 1 : 1 - smoothstep(0, 28, sdW);
    out.hill = hill;
    return out;
  }

  /** Height only (used outside the meshed area). */
  heightOnly(x: number, z: number): number {
    return this.sample(x, z, 2000, SCRATCH).h;
  }
}

const SCRATCH: SurfaceSample = { h: 0, air: 0, farm: 0, forest: 0, urban: 0, sand: 0, rock: 0, shore: 0, hill: 0 };

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

interface Ring {
  level: number;
  cell: number;
  half: number;
  hole: number;
  halfCells: number;
  n: number;
  heights: Float32Array;
}

export interface TerrainTextures {
  detail: THREE.Texture;
  macro: THREE.Texture;
  normal: THREE.Texture;
}

export class Terrain {
  readonly group = new THREE.Group();
  readonly field: TerrainField;
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  readonly extent: number;
  private rings: Ring[] = [];

  constructor(airport: AirportDef, palette: PaletteDef, q: TerrainQuality, tex: TerrainTextures) {
    this.group.name = 'Terrain';
    // Ring extents
    let cell = q.c0;
    let prevHalf = 0;
    const ringDefs: { cell: number; half: number; hole: number; halfCells: number }[] = [];
    for (let l = 0; l < q.halfCells.length; l++) {
      const half = q.halfCells[l] * cell;
      ringDefs.push({ cell, half, hole: prevHalf, halfCells: q.halfCells[l] });
      prevHalf = half;
      cell *= 3;
    }
    this.extent = prevHalf;
    this.field = new TerrainField(airport, palette, q.c0, this.extent);

    this.uniforms = makeTerrainUniforms(palette, this.field, tex);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
      normalMap: tex.normal,
      normalScale: new THREE.Vector2(0.55, 0.55),
    });
    const uniforms = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${terrainVertexPars}`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>\n${terrainVertexMain}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${terrainFragmentPars}`)
        .replace(
          '#include <map_fragment>',
          `float tRough; vec3 tEmissive;\n diffuseColor.rgb = terrainAlbedo( tRough, tEmissive );`,
        )
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = tRough;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n totalEmissiveRadiance += tEmissive;`);
    };
    this.material.customProgramCacheKey = () => 'skyward-terrain-v1';

    const sample: SurfaceSample = { h: 0, air: 0, farm: 0, forest: 0, urban: 0, sand: 0, rock: 0, shore: 0, hill: 0 };
    for (let l = 0; l < ringDefs.length; l++) {
      const rd = ringDefs[l];
      const next = ringDefs[l + 1];
      this.buildRing(l, rd, next ? next.cell : 0, q.tiles, sample);
    }
  }

  private buildRing(
    level: number,
    rd: { cell: number; half: number; hole: number; halfCells: number },
    nextCell: number,
    tiles: number,
    s: SurfaceSample,
  ): void {
    const n = rd.halfCells * 2 + 1;
    const cell = rd.cell;
    const half = rd.half;
    const heights = new Float32Array(n * n);
    const surf0 = new Float32Array(n * n * 4);
    const surf1 = new Float32Array(n * n * 4);
    const holeV = rd.hole > 0 ? rd.hole - cell * 1.01 : -1;
    const field = this.field;
    for (let j = 0; j < n; j++) {
      const z = -half + j * cell;
      const rowXs = field.water.empty ? undefined : field.water.crossingsAtZ(z);
      const edgeRow = j === 0 || j === n - 1;
      for (let i = 0; i < n; i++) {
        const x = -half + i * cell;
        if (holeV > 0 && Math.abs(x) < holeV && Math.abs(z) < holeV) continue;
        const edge = edgeRow || i === 0 || i === n - 1;
        // Outer boundary vertices use the coarser ring's LOD so they match its vertices exactly.
        field.sample(x, z, edge && nextCell > 0 ? nextCell : cell, s, rowXs);
        const k = j * n + i;
        heights[k] = s.h;
        surf0[k * 4] = s.air;
        surf0[k * 4 + 1] = s.farm;
        surf0[k * 4 + 2] = s.forest;
        surf0[k * 4 + 3] = s.urban;
        surf1[k * 4] = s.sand;
        surf1[k * 4 + 1] = s.rock;
        surf1[k * 4 + 2] = s.shore;
        surf1[k * 4 + 3] = 0;
      }
    }
    // Snap outer boundary to the coarser ring's linear edges (every 3rd vertex is shared).
    if (nextCell > 0) {
      const snap = (idx: (t: number) => number): void => {
        for (let t = 0; t < n - 1; t += 3) {
          const a = idx(t);
          const b = idx(Math.min(t + 3, n - 1));
          for (let m = 1; m < 3 && t + m < n - 1; m++) {
            const k = idx(t + m);
            const f = m / 3;
            heights[k] = heights[a] + (heights[b] - heights[a]) * f;
            for (let c = 0; c < 4; c++) {
              surf0[k * 4 + c] = surf0[a * 4 + c] + (surf0[b * 4 + c] - surf0[a * 4 + c]) * f;
              surf1[k * 4 + c] = surf1[a * 4 + c] + (surf1[b * 4 + c] - surf1[a * 4 + c]) * f;
            }
          }
        }
      };
      snap((t) => t); // j = 0 row
      snap((t) => (n - 1) * n + t); // j = n-1 row
      snap((t) => t * n); // i = 0 column
      snap((t) => t * n + (n - 1)); // i = n-1 column
    }
    const ring: Ring = { level, cell, half, hole: rd.hole, halfCells: rd.halfCells, n, heights };
    this.rings.push(ring);

    // normals from the grid
    const normals = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const hl = heights[j * n + Math.max(0, i - 1)];
        const hr = heights[j * n + Math.min(n - 1, i + 1)];
        const hu = heights[Math.max(0, j - 1) * n + i];
        const hd = heights[Math.min(n - 1, j + 1) * n + i];
        const dx = (i === 0 || i === n - 1 ? 1 : 2) * cell;
        const dz = (j === 0 || j === n - 1 ? 1 : 2) * cell;
        let nx = -(hr - hl) / dx;
        let nz = -(hd - hu) / dz;
        const len = Math.hypot(nx, 1, nz);
        nx /= len;
        nz /= len;
        normals[k * 3] = nx;
        normals[k * 3 + 1] = 1 / len;
        normals[k * 3 + 2] = nz;
      }
    }

    // tiles
    const cellsPerSide = n - 1;
    const cpt = Math.ceil(cellsPerSide / tiles);
    for (let ty = 0; ty < tiles; ty++) {
      for (let tx = 0; tx < tiles; tx++) {
        const i0 = tx * cpt;
        const j0 = ty * cpt;
        const i1 = Math.min(i0 + cpt, cellsPerSide);
        const j1 = Math.min(j0 + cpt, cellsPerSide);
        if (i1 <= i0 || j1 <= j0) continue;
        const w = i1 - i0 + 1;
        const hgt = j1 - j0 + 1;
        const indices: number[] = [];
        for (let j = j0; j < j1; j++) {
          for (let i = i0; i < i1; i++) {
            const cx = -half + (i + 0.5) * cell;
            const cz = -half + (j + 0.5) * cell;
            if (rd.hole > 0 && Math.abs(cx) < rd.hole && Math.abs(cz) < rd.hole) continue;
            const a = (j - j0) * w + (i - i0);
            const b = a + 1;
            const c = a + w;
            const d = c + 1;
            indices.push(a, c, b, b, c, d);
          }
        }
        if (indices.length === 0) continue;
        const vcount = w * hgt;
        const pos = new Float32Array(vcount * 3);
        const nor = new Float32Array(vcount * 3);
        const uv = new Float32Array(vcount * 2);
        const s0 = new Float32Array(vcount * 4);
        const s1 = new Float32Array(vcount * 4);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const v = (j - j0) * w + (i - i0);
            const k = j * n + i;
            const x = -half + i * cell;
            const z = -half + j * cell;
            pos[v * 3] = x;
            pos[v * 3 + 1] = heights[k];
            pos[v * 3 + 2] = z;
            nor[v * 3] = normals[k * 3];
            nor[v * 3 + 1] = normals[k * 3 + 1];
            nor[v * 3 + 2] = normals[k * 3 + 2];
            uv[v * 2] = x;
            uv[v * 2 + 1] = z;
            for (let c = 0; c < 4; c++) {
              s0[v * 4 + c] = surf0[k * 4 + c];
              s1[v * 4 + c] = surf1[k * 4 + c];
            }
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        geo.setAttribute('aSurf0', new THREE.BufferAttribute(s0, 4));
        geo.setAttribute('aSurf1', new THREE.BufferAttribute(s1, 4));
        geo.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
        geo.computeBoundingSphere();
        geo.computeBoundingBox();
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.receiveShadow = level <= 1;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.name = `terrain-L${level}-${tx}-${ty}`;
        this.group.add(mesh);
      }
    }
  }

  /** Height (world Y) matching the rendered triangles. */
  heightAt(x: number, z: number): number {
    for (const r of this.rings) {
      if (Math.abs(x) <= r.half && Math.abs(z) <= r.half) {
        const u = (x + r.half) / r.cell;
        const v = (z + r.half) / r.cell;
        const n = r.n;
        let i = Math.floor(u);
        let j = Math.floor(v);
        if (i >= n - 1) i = n - 2;
        if (j >= n - 1) j = n - 2;
        if (i < 0) i = 0;
        if (j < 0) j = 0;
        const fu = u - i;
        const fv = v - j;
        const h = r.heights;
        const ha = h[j * n + i];
        const hb = h[j * n + i + 1];
        const hc = h[(j + 1) * n + i];
        const hd = h[(j + 1) * n + i + 1];
        if (fu + fv <= 1) return ha + (hb - ha) * fu + (hc - ha) * fv;
        return hd + (hc - hd) * (1 - fu) + (hb - hd) * (1 - fv);
      }
    }
    return this.field.heightOnly(x, z);
  }

  update(nightFactor: number, wetness: number): void {
    this.uniforms.tNight.value = nightFactor;
    this.uniforms.tWetness.value = wetness;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.material.dispose();
  }
}

function makeTerrainUniforms(p: PaletteDef, f: TerrainField, tex: TerrainTextures): Record<string, THREE.IUniform> {
  const crops: THREE.Color[] = [];
  for (let i = 0; i < 8; i++) crops.push(new THREE.Color(p.crops[i % p.crops.length]));
  const cities: THREE.Vector4[] = [];
  for (let i = 0; i < 4; i++) {
    const c = f.cities[i];
    cities.push(c ? new THREE.Vector4(c.x, c.z, c.r, c.angle) : new THREE.Vector4(1e7, 1e7, 1, 0));
  }
  const hedge = new THREE.Color(p.forestFloor).lerp(new THREE.Color(p.soil), 0.3);
  return {
    tDetail: { value: tex.detail },
    tMacro: { value: tex.macro },
    tGrass: { value: new THREE.Color(p.grass) },
    tGrassDry: { value: new THREE.Color(p.grassDry) },
    tSoil: { value: new THREE.Color(p.soil) },
    tRock: { value: new THREE.Color(p.rock) },
    tSand: { value: new THREE.Color(p.sand) },
    tForest: { value: new THREE.Color(p.forestFloor) },
    tUrban: { value: new THREE.Color(p.urban) },
    tAirA: { value: new THREE.Color(p.airportGrass) },
    tAirB: { value: new THREE.Color(p.airportGrassAlt) },
    tHedge: { value: hedge },
    tCrops: { value: crops },
    tCropCount: { value: Math.min(8, p.crops.length) },
    tDryness: { value: p.dryness },
    tFarmAngle: { value: f.farmAngle },
    tMowDir: { value: new THREE.Vector2(Math.cos(f.mowAngle), Math.sin(f.mowAngle)) },
    tWetness: { value: 0 },
    tNight: { value: 0 },
    tCities: { value: cities },
    tCityCount: { value: Math.min(4, f.cities.length) },
    tBlock: { value: CITY_BLOCK },
    tStreet: { value: CITY_STREET },
    tStreetGlow: { value: new THREE.Color(1.0, 0.55, 0.22).multiplyScalar(0.55) },
  };
}

/** Street grid shared with the city generator (m). */
export const CITY_BLOCK = 120;
export const CITY_STREET = 14;
