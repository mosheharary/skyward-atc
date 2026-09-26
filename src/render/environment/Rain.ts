// Rain streaks in a box that follows the camera, wind-slanted; plus lightning bolts.
import * as THREE from 'three';
import { mulberry32 } from './noise';

const rainVert = /* glsl */ `
attribute vec4 iSeed; // base position in box (xyz, 0..1) + speed factor
uniform vec3 uBoxOrigin;
uniform vec3 uBoxSize;
uniform vec3 uVel;
uniform float uTime;
uniform float uLength;
uniform float uCount;
varying float vAlpha;
varying float vU;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  float idx = float( gl_InstanceID );
  vec3 vel = uVel * ( 0.85 + 0.3 * iSeed.w );
  vec3 p = iSeed.xyz * uBoxSize + vel * uTime;
  p = uBoxOrigin + mod( p - uBoxOrigin, uBoxSize );
  vec3 dir = normalize( vel );
  vec3 toCam = normalize( cameraPosition - p );
  vec3 side = normalize( cross( dir, toCam ) );
  float width = 0.012 + 0.006 * iSeed.w;
  vec3 wp = p + side * position.x * width - dir * ( position.y + 0.5 ) * uLength * ( 0.8 + 0.4 * iSeed.w );
  vec4 mv = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  float d = length( p - cameraPosition );
  float fadeNear = smoothstep( 3.5, 7.0, d );
  float fadeFar = 1.0 - smoothstep( uBoxSize.x * 0.32, uBoxSize.x * 0.5, d );
  vAlpha = fadeNear * fadeFar * step( idx, uCount );
  vU = position.x;
}
`;

const rainFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying float vU;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float a = vAlpha * uOpacity * ( 1.0 - abs( vU ) * 2.0 );
  if ( a < 0.002 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

export class RainSystem {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly max: number;
  private time = 0;

  constructor(maxDrops: number, seed: number) {
    this.max = maxDrops;
    const rnd = mulberry32(seed);
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    const seeds = new Float32Array(maxDrops * 4);
    for (let i = 0; i < maxDrops * 4; i++) seeds[i] = rnd();
    this.geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geometry.instanceCount = maxDrops;
    this.material = new THREE.ShaderMaterial({
      name: 'Rain',
      uniforms: {
        uBoxOrigin: { value: new THREE.Vector3() },
        uBoxSize: { value: new THREE.Vector3(70, 40, 70) },
        uVel: { value: new THREE.Vector3(0, -9, 0) },
        uTime: { value: 0 },
        uLength: { value: 0.55 },
        uCount: { value: 0 },
        uColor: { value: new THREE.Color(0.6, 0.63, 0.7) },
        uOpacity: { value: 0.25 },
      },
      vertexShader: rainVert,
      fragmentShader: rainFrag,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.mesh.name = 'Rain';
    this.mesh.visible = false;
  }

  update(dt: number, camera: THREE.Camera, intensity: number, windX: number, windZ: number, color: THREE.Color): void {
    this.time += dt;
    const u = this.material.uniforms;
    const count = Math.floor(this.max * Math.min(1, intensity));
    this.mesh.visible = count > 10;
    if (!this.mesh.visible) return;
    this.geometry.instanceCount = count;
    u.uCount.value = count;
    const size = u.uBoxSize.value as THREE.Vector3;
    (u.uBoxOrigin.value as THREE.Vector3).set(camera.position.x - size.x / 2, camera.position.y - size.y / 2, camera.position.z - size.z / 2);
    (u.uVel.value as THREE.Vector3).set(windX * 0.8, -8.5 - intensity * 1.5, windZ * 0.8);
    u.uTime.value = this.time % 1000;
    u.uOpacity.value = 0.16 + 0.2 * intensity;
    (u.uColor.value as THREE.Color).copy(color);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// --- Lightning ---------------------------------------------------------------------------------

const boltVert = /* glsl */ `
attribute vec3 aDir;
attribute float aWidth;
attribute float aSide;
varying float vSide;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 toCam = normalize( cameraPosition - position );
  vec3 side = normalize( cross( aDir, toCam ) );
  vec3 wp = position + side * aSide * aWidth;
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
  #include <logdepthbuf_vertex>
  vSide = aSide;
}
`;

const boltFrag = /* glsl */ `
uniform float uIntensity;
varying float vSide;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float a = 1.0 - abs( vSide );
  vec3 col = vec3( 0.75, 0.8, 1.0 ) * ( pow( a, 6.0 ) * 30.0 + a * 3.0 ) * uIntensity;
  gl_FragColor = vec4( col, 1.0 );
}
`;

interface Bolt {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  pulses: number[];
  strength: number;
}

export class LightningSystem {
  readonly group = new THREE.Group();
  /** Current scene flash 0..~1. */
  flash = 0;
  private readonly bolts: Bolt[] = [];
  private readonly seen = new Set<number>();
  private readonly rnd = mulberry32(99);
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.group.name = 'Lightning';
    this.material = new THREE.ShaderMaterial({
      name: 'LightningBolt',
      uniforms: { uIntensity: { value: 1 } },
      vertexShader: boltVert,
      fragmentShader: boltFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  /** Register a strike (world coords). Returns false if already seen. */
  strike(id: number, x: number, groundY: number, z: number, cloudY: number, camera: THREE.Camera): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 256) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
    const dist = Math.hypot(x - camera.position.x, z - camera.position.z);
    const strength = Math.max(0.15, Math.min(1, 9000 / Math.max(dist, 1500)));
    const pulses = [0, 0.07 + this.rnd() * 0.05];
    if (this.rnd() < 0.6) pulses.push(0.18 + this.rnd() * 0.1);
    const mesh = this.buildBolt(x, groundY, z, cloudY);
    this.group.add(mesh);
    this.bolts.push({ mesh, age: 0, life: 0.45, pulses, strength });
    return true;
  }

  /** Mark a strike id as seen without showing it (stale strikes on load). */
  ignore(id: number): void {
    this.seen.add(id);
  }

  private buildBolt(x: number, groundY: number, z: number, topY: number): THREE.Mesh {
    const positions: number[] = [];
    const dirs: number[] = [];
    const widths: number[] = [];
    const sides: number[] = [];
    const indices: number[] = [];
    const rnd = this.rnd;
    const addSegment = (a: THREE.Vector3, b: THREE.Vector3, w: number): void => {
      const d = new THREE.Vector3().subVectors(b, a).normalize();
      const base = positions.length / 3;
      for (const p of [a, b]) {
        for (const s of [-1, 1]) {
          positions.push(p.x, p.y, p.z);
          dirs.push(d.x, d.y, d.z);
          widths.push(w);
          sides.push(s);
        }
      }
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    };
    const branch = (start: THREE.Vector3, end: THREE.Vector3, w: number, depth: number): void => {
      const segs = 18;
      let prev = start.clone();
      const len = start.distanceTo(end);
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const p = start.clone().lerp(end, t);
        if (i < segs) {
          p.x += (rnd() - 0.5) * len * 0.09;
          p.z += (rnd() - 0.5) * len * 0.09;
          p.y += (rnd() - 0.5) * len * 0.02;
        }
        addSegment(prev, p, w);
        if (depth < 2 && rnd() < 0.18) {
          const bl = len * (0.15 + rnd() * 0.25);
          const bend = p.clone().add(new THREE.Vector3((rnd() - 0.5) * bl, -bl * (0.5 + rnd() * 0.5), (rnd() - 0.5) * bl));
          branch(p, bend, w * 0.5, depth + 1);
        }
        prev = p;
      }
    };
    branch(new THREE.Vector3(x, topY, z), new THREE.Vector3(x + (rnd() - 0.5) * 300, groundY, z + (rnd() - 0.5) * 300), 6, 0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('aDir', new THREE.Float32BufferAttribute(dirs, 3));
    geo.setAttribute('aWidth', new THREE.Float32BufferAttribute(widths, 1));
    geo.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
    geo.setIndex(indices);
    const mat = this.material.clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 40;
    return mesh;
  }

  update(dt: number): void {
    let flash = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      let v = 0;
      for (const p of b.pulses) {
        const t = b.age - p;
        if (t >= 0) v = Math.max(v, Math.exp(-t * 22));
      }
      (b.mesh.material as THREE.ShaderMaterial).uniforms.uIntensity.value = v;
      flash = Math.max(flash, v * b.strength);
      if (b.age > b.life) {
        this.group.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.bolts.splice(i, 1);
      }
    }
    this.flash = flash;
  }

  dispose(): void {
    for (const b of this.bolts) {
      b.mesh.geometry.dispose();
      (b.mesh.material as THREE.Material).dispose();
    }
    this.bolts.length = 0;
    this.material.dispose();
  }
}
