// Point-sprite light glows (street lights, obstruction lights, car lights) with a minimum pixel size
// so they stay visible at distance like real lights, HDR colour for bloom and fog attenuation.
import * as THREE from 'three';

const vert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute vec2 aBlink; // x = mode (0 steady, 1 flash, 2 slow pulse), y = phase
uniform float uTime;
uniform float uIntensity;
uniform float uProj;
uniform float uMinPx;
uniform float uMaxPx;
varying vec3 vColor;
varying float vFade;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  float px = aSize * uProj / max( -mvPosition.z, 1.0 );
  float size = clamp( px, uMinPx, uMaxPx );
  // lights smaller than the minimum footprint get dimmer instead of vanishing
  float dim = clamp( px / uMinPx, 0.0, 1.0 );
  dim = 0.25 + 0.75 * sqrt( dim );
  float blink = 1.0;
  if ( aBlink.x > 0.5 && aBlink.x < 1.5 ) {
    float t = fract( uTime * 0.75 + aBlink.y );
    blink = smoothstep( 0.0, 0.03, t ) * ( 1.0 - smoothstep( 0.12, 0.22, t ) );
  } else if ( aBlink.x > 1.5 ) {
    blink = 0.35 + 0.65 * ( 0.5 + 0.5 * sin( uTime * 2.1 + aBlink.y * 6.28 ) );
  }
  vColor = aColor * uIntensity * blink * dim;
  vFade = 1.0;
  gl_PointSize = size;
}
`;

const frag = /* glsl */ `
varying vec3 vColor;
varying float vFade;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float core = exp( -r2 * 9.0 );
  float halo = exp( -r2 * 2.6 ) * 0.35;
  float a = core + halo;
  if ( a < 0.01 ) discard;
  vec3 col = vColor * a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col *= 1.0 - fogFactor * 0.97;
  #endif
  gl_FragColor = vec4( col, 1.0 );
}
`;

export interface GlowPointData {
  positions: number[];
  colors: number[];
  sizes: number[];
  blink: number[];
}

export function emptyGlowData(): GlowPointData {
  return { positions: [], colors: [], sizes: [], blink: [] };
}

export function pushGlow(
  d: GlowPointData,
  x: number,
  y: number,
  z: number,
  r: number,
  g: number,
  b: number,
  size: number,
  mode = 0,
  phase = 0,
): void {
  d.positions.push(x, y, z);
  d.colors.push(r, g, b);
  d.sizes.push(size);
  d.blink.push(mode, phase);
}

export class GlowPoints {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly geometry: THREE.BufferGeometry;
  private readonly minPx: number;
  private readonly maxPx: number;

  constructor(data: GlowPointData, opts: { minPx?: number; maxPx?: number; dynamic?: boolean } = {}) {
    this.minPx = opts.minPx ?? 1.6;
    this.maxPx = opts.maxPx ?? 48;
    this.geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(data.positions), 3);
    if (opts.dynamic) pos.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pos);
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(data.colors), 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(data.sizes), 1));
    this.geometry.setAttribute('aBlink', new THREE.BufferAttribute(new Float32Array(data.blink), 2));
    this.geometry.computeBoundingSphere();
    this.material = new THREE.ShaderMaterial({
      name: 'GlowPoints',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uTime: { value: 0 },
          uIntensity: { value: 1 },
          uProj: { value: 800 },
          uMinPx: { value: opts.minPx ?? 1.6 },
          uMaxPx: { value: opts.maxPx ?? 48 },
        },
      ]),
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.renderOrder = 5;
    this.points.name = 'GlowPoints';
  }

  /**
   * Per-frame: time, global intensity, camera and drawing-buffer height in pixels.
   * `pixelRatio` scales the minimum / maximum sprite sizes for high-DPI screens.
   */
  update(time: number, intensity: number, camera: THREE.PerspectiveCamera, viewportHeight: number, pixelRatio = 1): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uIntensity.value = intensity;
    u.uProj.value = (viewportHeight * Math.max(camera.zoom, 1e-3)) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    u.uMinPx.value = this.minPx * pixelRatio;
    u.uMaxPx.value = this.maxPx * pixelRatio;
    this.points.visible = intensity > 0.002;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
