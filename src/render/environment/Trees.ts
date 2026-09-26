// Instanced vegetation: broadleaf, conifer, umbrella pine and cypress templates with wind sway.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ParkSpot } from './City';
import { mulberry32, Noise2D } from './noise';
import type { PaletteDef } from './palettes';
import type { SurfaceSample, TerrainField } from './Terrain';

export interface TreeQuality {
  maxTrees: number;
}

function colorize(geo: THREE.BufferGeometry, r: number, g: number, b: number, shadeBottom = 0): THREE.BufferGeometry {
  const g2 = geo.index ? geo.toNonIndexed() : geo;
  const pos = g2.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    minY = Math.min(minY, pos.getY(i));
    maxY = Math.max(maxY, pos.getY(i));
  }
  for (let i = 0; i < pos.count; i++) {
    const t = maxY > minY ? (pos.getY(i) - minY) / (maxY - minY) : 1;
    const s = 1 - shadeBottom * (1 - t);
    col[i * 3] = r * s;
    col[i * 3 + 1] = g * s;
    col[i * 3 + 2] = b * s;
  }
  g2.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g2.deleteAttribute('uv');
  return g2;
}

function jitter(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const n = new Noise2D(seed);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = 1 + n.noise(x * 0.9 + y * 0.3, z * 0.9 - y * 0.2) * amount;
    pos.setXYZ(i, x * k, y, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function trunk(h: number, r: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r * 0.7, r, h, 6, 1, true);
  g.translate(0, h / 2, 0);
  return colorize(g, 0.16, 0.11, 0.07);
}

function broadleaf(seed: number): THREE.BufferGeometry {
  const crownA = jitter(new THREE.IcosahedronGeometry(2.6, 1), 0.28, seed);
  crownA.scale(1, 0.85, 1);
  crownA.translate(0, 5.0, 0);
  const crownB = jitter(new THREE.IcosahedronGeometry(1.7, 1), 0.3, seed + 1);
  crownB.translate(0.9, 6.2, -0.4);
  return mergeGeometries([trunk(3.4, 0.28), colorize(crownA, 1, 1, 1, 0.45), colorize(crownB, 1, 1, 1, 0.3)])!;
}

function conifer(): THREE.BufferGeometry {
  const parts = [trunk(2.2, 0.25)];
  const tiers = [
    [2.6, 3.6, 1.6],
    [2.0, 3.2, 3.6],
    [1.35, 2.8, 5.4],
    [0.7, 2.2, 7.1],
  ];
  for (const [r, h, y] of tiers) {
    const c = new THREE.ConeGeometry(r, h, 8, 1, true);
    c.translate(0, y + h / 2, 0);
    parts.push(colorize(c, 1, 1, 1, 0.5));
  }
  return mergeGeometries(parts)!;
}

function umbrellaPine(seed: number): THREE.BufferGeometry {
  const crown = jitter(new THREE.IcosahedronGeometry(3.2, 1), 0.22, seed);
  crown.scale(1.25, 0.42, 1.25);
  crown.translate(0, 8.2, 0);
  return mergeGeometries([trunk(8.0, 0.3), colorize(crown, 1, 1, 1, 0.5)])!;
}

function cypress(): THREE.BufferGeometry {
  const c = new THREE.SphereGeometry(1.0, 7, 7);
  c.scale(1.1, 5.2, 1.1);
  c.translate(0, 5.8, 0);
  return mergeGeometries([trunk(1.2, 0.2), colorize(c, 1, 1, 1, 0.4)])!;
}

const swayPars = /* glsl */ `
uniform float tTime;
uniform vec2 tWind;
`;
const swayMain = /* glsl */ `
{
  vec3 ip = vec3( instanceMatrix[ 3 ][ 0 ], instanceMatrix[ 3 ][ 1 ], instanceMatrix[ 3 ][ 2 ] );
  float hgt = max( position.y - 2.0, 0.0 ) * 0.06;
  float ph = ip.x * 0.043 + ip.z * 0.037;
  float s = sin( tTime * 1.4 + ph ) * 0.6 + sin( tTime * 2.3 + ph * 1.7 ) * 0.3;
  transformed.xz += ( tWind * ( 0.5 + 0.5 * s ) + vec2( s, s * 0.7 ) * 0.15 ) * hgt;
}
`;

export class TreeSystem {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  readonly uniforms = { tTime: { value: 0 }, tWind: { value: new THREE.Vector2() } };
  readonly count: number;
  private readonly templates: THREE.BufferGeometry[];

  constructor(
    field: TerrainField,
    heightAt: (x: number, z: number) => number,
    palette: PaletteDef,
    q: TreeQuality,
    parks: ParkSpot[],
    seed: number,
  ) {
    this.group.name = 'Trees';
    const med = palette.conifer > 0.4 && palette.dryness > 0.4;
    this.templates = [broadleaf(seed), conifer(), med ? umbrellaPine(seed + 3) : broadleaf(seed + 7), cypress()];
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    const uniforms = this.uniforms;
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${swayPars}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${swayMain}`);
    };
    this.material.customProgramCacheKey = () => 'skyward-trees-v1';

    const rnd = mulberry32(seed + 404);
    const colors = palette.tree.map((c) => new THREE.Color(c));
    interface T {
      x: number;
      y: number;
      z: number;
      s: number;
      rot: number;
      type: number;
      color: THREE.Color;
    }
    const trees: T[] = [];
    const s: SurfaceSample = { h: 0, air: 0, farm: 0, forest: 0, urban: 0, sand: 0, rock: 0, shore: 0, hill: 0 };
    const pickType = (): number => {
      const r = rnd();
      if (med) return r < 0.35 ? 2 : r < 0.55 ? 3 : r < 0.8 ? 0 : 1;
      if (r < palette.conifer) return 1;
      return r < palette.conifer + 0.08 ? 3 : 0;
    };
    const tryPlace = (x: number, z: number, minForest: number, scale = 1): boolean => {
      field.sample(x, z, 30, s);
      if (s.air > 0.02 || s.sand > 0.35 || s.urban > 0.4) return false;
      if (field.flat.signedDistance(x, z, 200) < 90) return false;
      if (s.forest < minForest) return false;
      const y = heightAt(x, z);
      if (y < field.seaY + 1.0) return false;
      const c = colors[Math.floor(rnd() * colors.length)].clone().multiplyScalar(0.8 + rnd() * 0.4);
      trees.push({ x, y: y - 0.2, z, s: (0.7 + rnd() * 0.75) * scale, rot: rnd() * Math.PI * 2, type: pickType(), color: c });
      return true;
    };

    const budget = q.maxTrees;
    // 1) forests (60% of the budget)
    const forestBudget = Math.floor(budget * 0.6);
    const totalArea = field.forests.reduce((a, f) => a + f.r * f.r * f.density, 0) || 1;
    for (const f of field.forests) {
      const n = Math.floor((forestBudget * (f.r * f.r * f.density)) / totalArea);
      let placed = 0;
      for (let tries = 0; tries < n * 3 && placed < n; tries++) {
        // clumped sampling: pick clump centres, then scatter
        const a = rnd() * Math.PI * 2;
        const rr = Math.sqrt(rnd()) * f.r;
        const cx = f.x + Math.cos(a) * rr;
        const cz = f.z + Math.sin(a) * rr;
        const k = 3 + Math.floor(rnd() * 6);
        for (let j = 0; j < k && placed < n; j++) {
          if (tryPlace(cx + (rnd() - 0.5) * 60, cz + (rnd() - 0.5) * 60, 0.35)) placed++;
        }
      }
    }
    // 2) parks
    for (const p of parks) {
      if (trees.length > budget * 0.7) break;
      const k = 4 + Math.floor(rnd() * 8);
      for (let j = 0; j < k; j++) tryPlace(p.x + (rnd() - 0.5) * p.r * 2, p.z + (rnd() - 0.5) * p.r * 2, 0, 0.9);
    }
    // 3) scattered countryside trees & rows, denser near the airport ring (2-8 km)
    let guard = 0;
    while (trees.length < budget && guard++ < budget * 6) {
      const a = rnd() * Math.PI * 2;
      const rr = 1500 + Math.pow(rnd(), 1.4) * 16000;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      const k = rnd() < 0.3 ? 5 + Math.floor(rnd() * 8) : 1;
      const ang = rnd() * Math.PI;
      for (let j = 0; j < k; j++) {
        const t = (j - k / 2) * 9;
        tryPlace(x + Math.cos(ang) * t + (rnd() - 0.5) * 3, z + Math.sin(ang) * t + (rnd() - 0.5) * 3, 0);
      }
    }
    this.count = trees.length;

    // --- instanced tiles per template
    const tile = 2500;
    const buckets = new Map<string, T[]>();
    for (const t of trees) {
      const key = `${t.type}:${Math.floor(t.x / tile)},${Math.floor(t.z / tile)}`;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(t);
    }
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    for (const [key, arr] of buckets) {
      const type = Number(key.split(':')[0]);
      const mesh = new THREE.InstancedMesh(this.templates[type], this.material, arr.length);
      arr.forEach((t, i) => {
        quat.setFromAxisAngle(up, t.rot);
        pos.set(t.x, t.y, t.z);
        const sy = t.s * (0.85 + ((i * 7919) % 100) / 330);
        scl.set(t.s, sy, t.s);
        m.compose(pos, quat, scl);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, t.color);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'trees';
      this.group.add(mesh);
    }
  }

  update(time: number, windX: number, windZ: number): void {
    this.uniforms.tTime.value = time;
    (this.uniforms.tWind.value as THREE.Vector2).set(windX, windZ);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    });
    this.templates.forEach((g) => g.dispose());
    this.material.dispose();
  }
}
