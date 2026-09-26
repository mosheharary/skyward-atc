// Procedural cities: instanced buildings with shader-driven facades (windows, night lighting),
// skyscrapers with obstruction lights, street lights along the same grid the terrain draws.
import * as THREE from 'three';
import { GlowPoints, emptyGlowData, pushGlow } from './GlowPoints';
import { mulberry32, Noise2D } from './noise';
import type { PaletteDef } from './palettes';
import { CITY_BLOCK, CITY_STREET, type TerrainField } from './Terrain';

export interface CityQuality {
  maxBuildings: number;
  streetLightSpacing: number;
}

const buildingVertexPars = /* glsl */ `
attribute vec2 aBld;
varying vec3 vBLocal;
varying vec3 vBNormal;
varying vec2 vBld;
varying vec3 vBSize;
`;
const buildingVertexMain = /* glsl */ `
vec3 bScale = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
vBLocal = position * bScale;
vBNormal = normal;
vBld = aBld;
vBSize = bScale;
`;

const buildingFragmentPars = /* glsl */ `
uniform float bNight;
varying vec3 vBLocal;
varying vec3 vBNormal;
varying vec2 vBld;
varying vec3 vBSize;
float bHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
void buildingSurface( inout vec3 col, out vec3 emissive, out float rough, out float metal ) {
  emissive = vec3( 0.0 );
  rough = 0.85;
  metal = 0.0;
  float style = vBld.x;
  float seed = vBld.y;
  if ( vBNormal.y > 0.5 ) {
    // roof: gravel / membrane with a parapet rim
    vec2 rp = vBLocal.xz;
    float rim = min( vBSize.x * 0.5 - abs( rp.x ), vBSize.z * 0.5 - abs( rp.y ) );
    float gr = bHash( floor( rp * 1.5 ) + seed * 91.0 );
    col = col * 0.45 * ( 0.9 + 0.2 * gr );
    col = mix( col * 1.4, col, smoothstep( 0.4, 0.9, rim ) );
    rough = 0.92;
    return;
  }
  if ( vBNormal.y < -0.5 ) { col *= 0.2; return; }
  float u = abs( vBNormal.x ) > 0.5 ? vBLocal.z : vBLocal.x;
  float v = vBLocal.y;
  float floorH = 3.1;
  float winW = 3.3;
  vec2 frac = vec2( 0.42, 0.5 );
  if ( style > 0.5 && style < 1.5 ) { floorH = 3.7; winW = 3.0; frac = vec2( 0.68, 0.55 ); }
  else if ( style > 1.5 && style < 2.5 ) { floorH = 3.9; winW = 1.6; frac = vec2( 0.9, 0.78 ); }
  else if ( style > 2.5 ) { floorH = 7.0; winW = 9.0; frac = vec2( 0.25, 0.12 ); }
  vec2 cuv = vec2( u / winW + seed * 17.0, v / floorH );
  vec2 cid = floor( cuv );
  vec2 f = fract( cuv );
  vec2 fw = fwidth( cuv ) + 1e-4;
  vec2 lo = 0.5 - frac * 0.5;
  vec2 hi = 0.5 + frac * 0.5;
  vec2 m = smoothstep( lo - fw, lo + fw, f ) * ( 1.0 - smoothstep( hi - fw, hi + fw, f ) );
  float win = m.x * m.y;
  float aa = clamp( max( fw.x, fw.y ) * 1.6 - 0.35, 0.0, 1.0 );
  float winAvg = frac.x * frac.y;
  // no windows on the parapet band or ground-floor plinth of industrial boxes
  float top = step( v, vBSize.y - 1.2 );
  float plinth = style > 2.5 ? 0.0 : 1.0;
  float ground = step( 4.0, v );
  float winF = mix( win, winAvg, aa ) * top;
  // storefront glazing at street level
  float shop = ( 1.0 - ground ) * step( 0.6, v ) * plinth * ( style < 0.5 ? 0.0 : 0.7 );
  winF = max( winF * ground, shop );
  vec3 glassC = style > 1.5 && style < 2.5 ? vec3( 0.05, 0.085, 0.1 ) : vec3( 0.06, 0.07, 0.08 );
  float facadeN = bHash( vec2( floor( u / 7.0 ), floor( v / 11.0 ) ) + seed * 13.0 );
  vec3 wall = col * ( 0.9 + 0.12 * facadeN );
  col = mix( wall, glassC, winF );
  rough = mix( 0.88, 0.12, winF );
  metal = style > 1.5 && style < 2.5 ? mix( 0.0, 0.85, winF ) : mix( 0.0, 0.4, winF );
  // night: lit windows (whole office floors for glass towers)
  if ( bNight > 0.01 ) {
    float litRatio = mix( 0.18, 0.62, bHash( vec2( seed, 3.7 ) ) );
    float r = bHash( cid + seed * 57.0 );
    if ( style > 1.5 && style < 2.5 ) r = mix( r, bHash( vec2( cid.y, seed ) ), 0.75 );
    float lit = step( r, litRatio );
    float warm = bHash( cid + 9.1 + seed );
    vec3 lc = mix( vec3( 1.0, 0.72, 0.42 ), vec3( 0.85, 0.92, 1.0 ), step( 0.7, warm ) );
    lc *= 0.7 + 0.6 * bHash( cid * 1.7 + seed );
    float litF = mix( lit * win, litRatio * winAvg, aa ) * top * ground;
    litF = max( litF, shop * 0.8 );
    emissive = lc * litF * 2.4 * bNight;
  }
}
`;

export interface ParkSpot {
  x: number;
  z: number;
  r: number;
}

export class CitySystem {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly parks: ParkSpot[] = [];
  readonly uniforms = { bNight: { value: 0 } };
  readonly buildingCount: number;
  private lights: GlowPoints | null = null;
  private obstruction: GlowPoints | null = null;
  private readonly baseGeo: THREE.BufferGeometry;

  constructor(field: TerrainField, heightAt: (x: number, z: number) => number, palette: PaletteDef, q: CityQuality, seed: number) {
    this.group.name = 'City';
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    this.baseGeo = box;
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
    const uniforms = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${buildingVertexPars}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${buildingVertexMain}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${buildingFragmentPars}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>\n vec3 bEmissive; float bRough; float bMetal;\n { vec3 c = diffuseColor.rgb; buildingSurface( c, bEmissive, bRough, bMetal ); diffuseColor.rgb = c; }`,
        )
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = bRough;`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n metalnessFactor = bMetal;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n totalEmissiveRadiance += bEmissive;`);
    };
    this.material.customProgramCacheKey = () => 'skyward-buildings-v1';

    const rnd = mulberry32(seed);
    const noise = new Noise2D(seed + 5);
    interface Bld {
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      d: number;
      rot: number;
      style: number;
      color: THREE.Color;
    }
    const blds: Bld[] = [];
    const street = emptyGlowData();
    const obst = emptyGlowData();
    const facades = palette.facade.map((c) => new THREE.Color(c));
    const glassTints = ['#8fa3ad', '#9fb4b8', '#7f8f99', '#a9b3b8'].map((c) => new THREE.Color(c));
    const industrial = ['#9aa0a6', '#b7b1a5', '#8c8f93', '#a8a298'].map((c) => new THREE.Color(c));

    // Estimate total blocks so the density can be scaled to the quality budget.
    let expected = 0;
    for (const c of field.cities) expected += Math.PI * (c.r / CITY_BLOCK) ** 2 * c.density * 3.2;
    const budgetScale = Math.min(1, q.maxBuildings / Math.max(1, expected));

    field.cities.forEach((c, ci) => {
      const cos = Math.cos(c.angle);
      const sin = Math.sin(c.angle);
      const toWorld = (qx: number, qz: number): [number, number] => [c.x + cos * qx + sin * qz, c.z - sin * qx + cos * qz];
      const nb = Math.ceil(c.r / CITY_BLOCK) + 1;
      const towers: [number, number][] = [];
      for (let bj = -nb; bj < nb; bj++) {
        for (let bi = -nb; bi < nb; bi++) {
          const qx = (bi + 0.5) * CITY_BLOCK;
          const qz = (bj + 0.5) * CITY_BLOCK;
          const [wx, wz] = toWorld(qx, qz);
          const d = Math.hypot(wx - c.x, wz - c.z) / c.r;
          if (d > 1.02) continue;
          const nv = noise.noise(wx / 1500 + ci * 10, wz / 1500) * 0.5 + 0.5;
          const p = c.density * (1 - smoothstep(0.55, 1.02, d)) * (0.65 + 0.7 * nv);
          const roll = rnd();
          if (roll > Math.min(0.97, p)) {
            if (roll < 0.97 && d < 0.95 && rnd() < 0.25) this.parks.push({ x: wx, z: wz, r: CITY_BLOCK * 0.4 });
            continue;
          }
          // terrain checks
          const inner = (CITY_BLOCK - CITY_STREET) * 0.5 - 3;
          const corners = [toWorld(qx - inner, qz - inner), toWorld(qx + inner, qz - inner), toWorld(qx - inner, qz + inner), toWorld(qx + inner, qz + inner)];
          let hmin = Infinity;
          let hmax = -Infinity;
          for (const [cx, cz] of corners) {
            const h = heightAt(cx, cz);
            hmin = Math.min(hmin, h);
            hmax = Math.max(hmax, h);
          }
          if (hmin < field.seaY + 0.6 || hmax - hmin > 14) continue;
          if (field.flat.signedDistance(wx, wz, 400) < 250) continue;
          if (rnd() > budgetScale) {
            // still light the street in thinned-out blocks
            this.streetLights(street, toWorld, qx, qz, heightAt, q.streetLightSpacing, rnd);
            continue;
          }
          this.streetLights(street, toWorld, qx, qz, heightAt, q.streetLightSpacing, rnd);
          const base = hmin - 0.6;
          const coreH = c.maxHeight * Math.exp(-d * d * 4.2) + 9;
          const isIndustrial = d > 0.55 && rnd() < 0.12;
          if (isIndustrial) {
            const n = 1 + Math.floor(rnd() * 2);
            for (let k = 0; k < n; k++) {
              const w = 45 + rnd() * 40;
              const dd = 35 + rnd() * 45;
              const off = n === 2 ? (k === 0 ? -1 : 1) * (inner * 0.5) : 0;
              const [bx, bz] = toWorld(qx + off, qz + (rnd() - 0.5) * 10);
              blds.push({ x: bx, y: base, z: bz, w: Math.min(w, inner * (n === 2 ? 0.95 : 1.9)), h: 8 + rnd() * 7, d: Math.min(dd, inner * 1.9), rot: c.angle, style: 3, color: industrial[Math.floor(rnd() * industrial.length)] });
            }
            continue;
          }
          const lots = d < 0.3 ? 1 + Math.floor(rnd() * 2) : d < 0.65 ? 2 : 3;
          const lotSize = (inner * 2) / lots;
          for (let lj = 0; lj < lots; lj++) {
            for (let li = 0; li < lots; li++) {
              if (lots === 1 && (li > 0 || lj > 0)) continue;
              if (rnd() < 0.08) continue;
              const lx = qx - inner + (li + 0.5) * lotSize;
              const lz = qz - inner + (lj + 0.5) * lotSize;
              const [bx, bz] = toWorld(lx + (rnd() - 0.5) * lotSize * 0.1, lz + (rnd() - 0.5) * lotSize * 0.1);
              const w = lotSize * (0.62 + rnd() * 0.3);
              const dd = lotSize * (0.62 + rnd() * 0.3);
              let h: number;
              let style: number;
              if (lots === 3) {
                h = 5 + rnd() * 9;
                style = 0;
              } else {
                const t = Math.pow(rnd(), 1.6);
                h = Math.max(8, Math.min(coreH, 10 + t * coreH));
                style = h > 45 && rnd() < 0.55 ? 2 : h > 18 ? 1 : 0;
              }
              const color = style === 2 ? glassTints[Math.floor(rnd() * glassTints.length)] : facades[Math.floor(rnd() * facades.length)];
              blds.push({ x: bx, y: base, z: bz, w, h, d: dd, rot: c.angle, style, color });
              if (h > 45) this.pushObstruction(obst, bx, base + h, bz, w, dd, c.angle, h > 100, rnd());
            }
          }
          if (d < 0.35) towers.push([qx, qz]);
        }
      }
      // skyscrapers in the core
      const sky = Math.min(towers.length, c.towers);
      for (let s = 0; s < sky; s++) {
        const idx = Math.floor(rnd() * towers.length);
        const [qx, qz] = towers.splice(idx, 1)[0];
        const [bx, bz] = toWorld(qx + (rnd() - 0.5) * 20, qz + (rnd() - 0.5) * 20);
        const h0 = heightAt(bx, bz);
        const H = c.maxHeight * (0.5 + rnd() * 0.5);
        const w = 26 + rnd() * 22;
        const dd = 26 + rnd() * 22;
        const color = glassTints[Math.floor(rnd() * glassTints.length)];
        const tiers = rnd() < 0.5 ? 1 : 2 + Math.floor(rnd() * 2);
        let y = h0 - 0.6;
        let tw = w;
        let td = dd;
        for (let t = 0; t < tiers; t++) {
          const th = tiers === 1 ? H : (H / tiers) * (t === 0 ? 1.3 : 0.85);
          blds.push({ x: bx, y, z: bz, w: tw, h: th, d: td, rot: c.angle, style: 2, color });
          y += th;
          tw *= 0.78;
          td *= 0.78;
        }
        this.pushObstruction(obst, bx, y, bz, tw, td, c.angle, true, rnd());
        // antenna mast
        blds.push({ x: bx, y, z: bz, w: 1.2, h: 12 + rnd() * 25, d: 1.2, rot: c.angle, style: 3, color: new THREE.Color('#9a9a9a') });
        pushGlow(obst, bx, y + 30, bz, 3.0, 0.08, 0.05, 5, 1, rnd());
      }
    });

    // --- build instanced tiles
    const tile = 1500;
    const buckets = new Map<string, Bld[]>();
    for (const b of blds) {
      const key = `${Math.floor(b.x / tile)},${Math.floor(b.z / tile)}`;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(b);
    }
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const arr of buckets.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', box.getAttribute('position'));
      geo.setAttribute('normal', box.getAttribute('normal'));
      geo.setAttribute('uv', box.getAttribute('uv'));
      geo.setIndex(box.getIndex());
      const extra = new Float32Array(arr.length * 2);
      const mesh = new THREE.InstancedMesh(geo, this.material, arr.length);
      arr.forEach((b, i) => {
        quat.setFromAxisAngle(up, b.rot);
        pos.set(b.x, b.y, b.z);
        scl.set(b.w, b.h, b.d);
        m.compose(pos, quat, scl);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, b.color);
        extra[i * 2] = b.style;
        extra[i * 2 + 1] = rnd();
      });
      geo.setAttribute('aBld', new THREE.InstancedBufferAttribute(extra, 2));
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'buildings';
      this.group.add(mesh);
    }
    this.buildingCount = blds.length;

    if (street.sizes.length > 0) {
      const lights = new GlowPoints(street, { minPx: 1.4, maxPx: 22 });
      lights.points.name = 'StreetLights';
      this.group.add(lights.points);
      this.lights = lights;
    }
    if (obst.sizes.length > 0) {
      const ob = new GlowPoints(obst, { minPx: 2.0, maxPx: 26 });
      ob.points.name = 'ObstructionLights';
      this.group.add(ob.points);
      this.obstruction = ob;
    }
  }

  private streetLights(
    d: ReturnType<typeof emptyGlowData>,
    toWorld: (qx: number, qz: number) => [number, number],
    qx: number,
    qz: number,
    heightAt: (x: number, z: number) => number,
    spacing: number,
    rnd: () => number,
  ): void {
    const e = CITY_BLOCK * 0.5 - CITY_STREET * 0.5 + 1.5;
    const steps = Math.max(1, Math.floor((2 * e) / spacing));
    const sodium = rnd() < 0.6;
    const cr = sodium ? 1.0 : 0.95;
    const cg = sodium ? 0.62 : 0.9;
    const cb = sodium ? 0.28 : 0.78;
    for (let s = 0; s <= steps; s++) {
      const t = -e + (s / steps) * 2 * e;
      const pts: [number, number][] = [
        [qx + t, qz - e],
        [qx + t, qz + e],
        [qx - e, qz + t],
        [qx + e, qz + t],
      ];
      for (const [px, pz] of pts) {
        if (rnd() < 0.5) continue; // neighbouring block lights the other side
        const [wx, wz] = toWorld(px, pz);
        const y = heightAt(wx, wz) + 8.5;
        pushGlow(d, wx, y, wz, cr * 1.6, cg * 1.6, cb * 1.6, 7, 0, 0);
      }
    }
  }

  private pushObstruction(
    d: ReturnType<typeof emptyGlowData>,
    x: number,
    y: number,
    z: number,
    w: number,
    dd: number,
    rot: number,
    flash: boolean,
    phase: number,
  ): void {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const hx = w * 0.45;
    const hz = dd * 0.45;
    for (const [lx, lz] of [
      [-hx, -hz],
      [hx, -hz],
      [-hx, hz],
      [hx, hz],
    ]) {
      const wx = x + c * lx + s * lz;
      const wz = z - s * lx + c * lz;
      pushGlow(d, wx, y + 0.6, wz, 2.6, 0.06, 0.04, 3.2, flash ? 1 : 2, flash ? 0 : phase);
    }
  }

  update(time: number, nightFactor: number, camera: THREE.PerspectiveCamera, viewportH: number, pixelRatio: number): void {
    this.uniforms.bNight.value = nightFactor;
    this.lights?.update(time, smoothstep(0.25, 0.75, nightFactor), camera, viewportH, pixelRatio);
    this.obstruction?.update(time, Math.max(0.35, nightFactor), camera, viewportH, pixelRatio);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).geometry.dispose();
    });
    this.baseGeo.dispose();
    this.material.dispose();
    this.lights?.dispose();
    this.obstruction?.dispose();
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

