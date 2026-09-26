// All airport point lights in one instanced draw call: camera-facing HDR sprites with per-light
// colour, size, directionality, flashing (sequenced flashers / obstruction beacons / guard
// lights), PAPI colour-by-elevation-angle and per-group intensity (runway in use, approach
// lights, stop bars...).

import * as THREE from 'three';
import type { Vec2 } from '../../sim/airports/types';

export const GROUPS = 64;
/** Group index helpers. */
export const G_RWY = 0; // + runway index (<= 8)
export const G_APP = 8; // + end index (<= 16)
export const G_PAPI = 24; // + end index (<= 16)
export const G_STOP = 40; // + runway index (<= 8)
export const G_TAXI_EDGE = 48;
export const G_TAXI_CL = 49;
export const G_FLOOD = 50;
export const G_OBST = 51;
export const G_BUILD = 52;
export const G_ALWAYS = 53;

export interface LightSpec {
  /** Sim coordinates + height (m above field). */
  p: Vec2;
  h: number;
  color: [number, number, number];
  size: number;
  group: number;
  /** Direction the light shines towards (sim, unit) or null = omni. */
  dir?: Vec2 | null;
  /** 0..1 how strictly directional. */
  directional?: number;
  flashPeriod?: number;
  flashPhase?: number;
  flashDuty?: number;
  /** PAPI unit setting angle (deg), 0 = not a PAPI. */
  papi?: number;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPos;
attribute vec3 aCol;
attribute vec4 aDir;
attribute vec4 aP;
attribute vec2 aQ;
uniform float uGroup[${GROUPS}];
uniform float uTime;
uniform float uPx;
uniform float uFog;
uniform float uMinPx;
varying vec3 vCol;
varying vec2 vUv;
void main() {
  int gi = int(aP.y + 0.5);
  float I = uGroup[gi];
  if (aP.z > 0.0) {
    float f = fract(uTime / aP.z - aP.w);
    I *= smoothstep(aQ.x + 0.02, aQ.x, f) * smoothstep(0.0, 0.01, f);
  }
  vec3 toCam = cameraPosition - aPos;
  float d = length(toCam);
  vec3 tc = toCam / max(d, 1e-3);
  if (aDir.w > 0.0) {
    float c = dot(normalize(vec3(tc.x, 0.0, tc.z) + vec3(0.0, 1e-4, 0.0)), aDir.xyz);
    I *= mix(1.0, smoothstep(-0.05, 0.55, c), aDir.w);
  }
  vec3 col = aCol;
  if (aQ.y > 0.0) {
    float el = degrees(atan(toCam.y, length(toCam.xz)));
    float w = smoothstep(aQ.y - 0.07, aQ.y + 0.07, el);
    col = mix(vec3(7.0, 0.35, 0.12), vec3(7.0, 6.6, 6.0), w);
  }
  // Fog: lights carry further than surfaces.
  float fd = uFog * d * 0.55;
  I *= exp(-fd * fd);
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float depth = max(-mv.z, 0.1);
  float pxWorld = depth * uPx;
  float s = aP.x;
  float minS = pxWorld * uMinPx;
  float size = max(s, minS);
  // Distant lights: keep the apparent brightness but fade tiny ones gently.
  I *= mix(1.0, 0.75, smoothstep(1.0, 4.0, minS / s));
  vCol = col * I;
  vUv = position.xy;
  if (I < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // Pull the sprite towards the camera so it is not clipped by the ground.
  mv.xyz += normalize(-mv.xyz) * min(size * 1.2, depth * 0.5);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vCol;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 14.0);
  float halo = exp(-r2 * 4.0) * 0.28;
  gl_FragColor = vec4(vCol * (core + halo), 1.0);
}
`;

export class LightField {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly groups = new Float32Array(GROUPS);
  readonly count: number;

  constructor(specs: LightSpec[]) {
    const n = specs.length;
    this.count = n;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const aPos = new Float32Array(n * 3);
    const aCol = new Float32Array(n * 3);
    const aDir = new Float32Array(n * 4);
    const aP = new Float32Array(n * 4);
    const aQ = new Float32Array(n * 2);
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    specs.forEach((s, i) => {
      aPos[i * 3] = s.p[0];
      aPos[i * 3 + 1] = s.h;
      aPos[i * 3 + 2] = -s.p[1];
      box.expandByPoint(v.set(s.p[0], s.h, -s.p[1]));
      aCol.set(s.color, i * 3);
      if (s.dir) {
        aDir[i * 4] = s.dir[0];
        aDir[i * 4 + 1] = 0;
        aDir[i * 4 + 2] = -s.dir[1];
        aDir[i * 4 + 3] = s.directional ?? 1;
      }
      aP[i * 4] = s.size;
      aP[i * 4 + 1] = s.group;
      aP[i * 4 + 2] = s.flashPeriod ?? 0;
      aP[i * 4 + 3] = s.flashPhase ?? 0;
      aQ[i * 2] = s.flashDuty ?? 0.5;
      aQ[i * 2 + 1] = s.papi ?? 0;
    });
    g.setAttribute('aPos', new THREE.InstancedBufferAttribute(aPos, 3));
    g.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 3));
    g.setAttribute('aDir', new THREE.InstancedBufferAttribute(aDir, 4));
    g.setAttribute('aP', new THREE.InstancedBufferAttribute(aP, 4));
    g.setAttribute('aQ', new THREE.InstancedBufferAttribute(aQ, 2));
    g.instanceCount = n;
    g.boundingBox = box.expandByScalar(50);
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uGroup: { value: this.groups },
        uTime: { value: 0 },
        uPx: { value: 0.001 },
        uFog: { value: 0 },
        uMinPx: { value: 1.6 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
    this.mesh.name = 'AirportLights';
  }

  update(time: number, camera: THREE.PerspectiveCamera, viewportHeight: number, fogDensity: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uPx.value = (2 * Math.tan((camera.fov * Math.PI) / 360)) / (Math.max(1, viewportHeight) * Math.max(camera.zoom, 1e-3));
    u.uFog.value = fogDensity;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
