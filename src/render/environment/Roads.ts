// Highways draped over the terrain (bridges over water) with animated car head/tail lights at night.
import * as THREE from 'three';
import { GlowPoints, emptyGlowData, pushGlow } from './GlowPoints';
import { mulberry32 } from './noise';

function roadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a3b3d';
  g.fillRect(0, 0, 64, 256);
  // grain
  for (let i = 0; i < 1400; i++) {
    const v = 45 + Math.random() * 30;
    g.fillStyle = `rgb(${v},${v},${v + 2})`;
    g.fillRect(Math.random() * 64, Math.random() * 256, 1, 1);
  }
  g.fillStyle = '#d8d8d0';
  g.fillRect(2, 0, 2, 256);
  g.fillRect(60, 0, 2, 256);
  g.fillStyle = '#c9a53a';
  g.fillRect(31, 0, 2, 256);
  g.fillStyle = '#d8d8d0';
  for (let y = 0; y < 256; y += 64) {
    g.fillRect(16, y, 2, 32);
    g.fillRect(46, y, 2, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface Lane {
  pts: THREE.Vector3[];
  cum: number[];
  length: number;
}

interface Car {
  lane: number;
  s: number;
  speed: number;
  dir: 1 | -1;
}

export class RoadSystem {
  readonly group = new THREE.Group();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly pillarMat: THREE.MeshStandardMaterial;
  private readonly lanes: Lane[] = [];
  private readonly cars: Car[] = [];
  private lights: GlowPoints | null = null;
  private readonly tex: THREE.CanvasTexture;

  constructor(roads: [number, number][][], heightAt: (x: number, z: number) => number, seaY: number, carDensity: number, seed: number) {
    this.group.name = 'Roads';
    this.tex = roadTexture();
    this.material = new THREE.MeshStandardMaterial({
      map: this.tex,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.pillarMat = new THREE.MeshStandardMaterial({ color: 0x8d8b86, roughness: 0.9 });
    const rnd = mulberry32(seed);
    const width = 16;
    const pillarGeo = new THREE.BoxGeometry(3, 1, 3);
    pillarGeo.translate(0, 0.5, 0);
    const pillarMatrices: THREE.Matrix4[] = [];
    for (const road of roads) {
      if (road.length < 2) continue;
      // resample every ~25 m in world XZ
      const samples: THREE.Vector3[] = [];
      for (let i = 0; i < road.length - 1; i++) {
        const ax = road[i][0], az = -road[i][1];
        const bx = road[i + 1][0], bz = -road[i + 1][1];
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len / 25));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          samples.push(new THREE.Vector3(ax + (bx - ax) * t, 0, az + (bz - az) * t));
        }
      }
      const last = road[road.length - 1];
      samples.push(new THREE.Vector3(last[0], 0, -last[1]));
      // heights: follow terrain, bridge over water / dips
      for (const p of samples) {
        const h = heightAt(p.x, p.z);
        p.y = Math.max(h + 0.35, seaY + 7);
      }
      // smooth heights a little (embankments)
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 1; i < samples.length - 1; i++) {
          const target = (samples[i - 1].y + samples[i + 1].y) * 0.5;
          const ground = heightAt(samples[i].x, samples[i].z) + 0.35;
          samples[i].y = Math.max(ground, (samples[i].y + target) * 0.5);
        }
      }
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      let dist = 0;
      const laneL: THREE.Vector3[] = [];
      const laneR: THREE.Vector3[] = [];
      for (let i = 0; i < samples.length; i++) {
        const p = samples[i];
        const a = samples[Math.max(0, i - 1)];
        const b = samples[Math.min(samples.length - 1, i + 1)];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const nx = -dz / l;
        const nz = dx / l;
        if (i > 0) dist += Math.hypot(p.x - samples[i - 1].x, p.z - samples[i - 1].z);
        pos.push(p.x + nx * width * 0.5, p.y, p.z + nz * width * 0.5, p.x - nx * width * 0.5, p.y, p.z - nz * width * 0.5);
        uv.push(0, dist / 24, 1, dist / 24);
        if (i > 0) {
          const k = i * 2;
          idx.push(k - 2, k, k - 1, k - 1, k, k + 1);
        }
        laneL.push(new THREE.Vector3(p.x + nx * 4, p.y + 0.9, p.z + nz * 4));
        laneR.push(new THREE.Vector3(p.x - nx * 4, p.y + 0.9, p.z - nz * 4));
        const ground = heightAt(p.x, p.z);
        if (p.y - ground > 3 && i % 3 === 0) {
          const m = new THREE.Matrix4().compose(
            new THREE.Vector3(p.x, Math.min(ground, seaY) - 2, p.z),
            new THREE.Quaternion(),
            new THREE.Vector3(1, p.y - Math.min(ground, seaY) + 1.5, 1),
          );
          pillarMatrices.push(m);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.receiveShadow = true;
      mesh.name = 'road';
      this.group.add(mesh);
      for (const lane of [laneL, laneR]) {
        const cum = [0];
        for (let i = 1; i < lane.length; i++) cum.push(cum[i - 1] + lane[i].distanceTo(lane[i - 1]));
        this.lanes.push({ pts: lane, cum, length: cum[cum.length - 1] });
      }
    }
    if (pillarMatrices.length) {
      const inst = new THREE.InstancedMesh(pillarGeo, this.pillarMat, pillarMatrices.length);
      pillarMatrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.computeBoundingSphere();
      inst.castShadow = true;
      this.group.add(inst);
    }
    // cars: left lanes (even) drive forward, right lanes (odd) backward
    for (let li = 0; li < this.lanes.length; li++) {
      const lane = this.lanes[li];
      const n = Math.floor((lane.length / 1000) * 7 * carDensity);
      for (let k = 0; k < n; k++) {
        this.cars.push({ lane: li, s: rnd() * lane.length, speed: 22 + rnd() * 12, dir: li % 2 === 0 ? 1 : -1 });
      }
    }
    if (this.cars.length) {
      const d = emptyGlowData();
      for (let k = 0; k < this.cars.length * 2; k++) pushGlow(d, 0, -1000, 0, 0, 0, 0, 1.5, 0, 0);
      this.lights = new GlowPoints(d, { minPx: 1.3, maxPx: 12, dynamic: true });
      this.lights.points.frustumCulled = false;
      this.lights.points.name = 'CarLights';
      this.group.add(this.lights.points);
    }
  }

  private sampleLane(lane: Lane, s: number, out: THREE.Vector3): THREE.Vector3 {
    const cum = lane.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    return out.copy(lane.pts[lo]).lerp(lane.pts[hi], (s - cum[lo]) / seg);
  }

  update(dt: number, time: number, nightFactor: number, camera: THREE.PerspectiveCamera, viewportH: number, pixelRatio: number): void {
    if (!this.lights) return;
    const on = nightFactor > 0.05;
    this.lights.update(time, Math.min(1, nightFactor * 1.3), camera, viewportH, pixelRatio);
    if (!on) return;
    const pos = this.lights.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.lights.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const lane = this.lanes[c.lane];
      c.s += c.speed * dt * c.dir;
      if (c.s > lane.length) c.s -= lane.length;
      if (c.s < 0) c.s += lane.length;
      this.sampleLane(lane, c.s, a);
      this.sampleLane(lane, Math.min(lane.length, Math.max(0, c.s + c.dir * 1.5)), b);
      // two lights per car: headlights when driving towards the camera, tail lights otherwise
      const headlights = (b.x - a.x) * (camera.position.x - a.x) + (b.z - a.z) * (camera.position.z - a.z) > 0;
      const k = i * 2;
      const nx = -(b.z - a.z);
      const nz = b.x - a.x;
      const l = Math.hypot(nx, nz) || 1;
      pos.setXYZ(k, a.x + (nx / l) * 0.8, a.y, a.z + (nz / l) * 0.8);
      pos.setXYZ(k + 1, a.x - (nx / l) * 0.8, a.y, a.z - (nz / l) * 0.8);
      if (headlights) {
        col.setXYZ(k, 3.0, 2.7, 2.2);
        col.setXYZ(k + 1, 3.0, 2.7, 2.2);
      } else {
        col.setXYZ(k, 2.2, 0.12, 0.08);
        col.setXYZ(k + 1, 2.2, 0.12, 0.08);
      }
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    this.material.dispose();
    this.pillarMat.dispose();
    this.tex.dispose();
    this.lights?.dispose();
  }
}
