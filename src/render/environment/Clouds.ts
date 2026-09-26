// Cumulus clouds as depth-sorted instanced billboard puffs + an overcast deck.
import * as THREE from 'three';
import { mulberry32 } from './noise';

const puffVert = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iData;   // size, rotation, atlas index, visibility threshold
attribute vec4 iLight;  // offset dir (xyz), height fraction in cloud (w)
uniform float uBaseY;
uniform float uCoverage;
uniform float uRadius;
varying vec2 vUv;
varying vec4 vLight;
varying float vOpacity;
varying vec3 vWorld;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  float size = iData.x;
  float rot = iData.y;
  float c = cos( rot ), s = sin( rot );
  vec2 corner = vec2( c * position.x - s * position.y, s * position.x + c * position.y );
  float atlas = iData.z;
  vUv = ( uv + vec2( mod( atlas, 2.0 ), floor( atlas / 2.0 ) ) ) * 0.5;
  vec3 center = vec3( iPos.x, iPos.y + uBaseY, iPos.z );
  vec3 camRight = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 camUp = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 wp = center + ( camRight * corner.x + camUp * corner.y ) * size;
  vWorld = wp;
  vec4 mvPosition = viewMatrix * vec4( wp, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  vLight = iLight;
  // coverage fade in/out per cloud + distance fades
  float vis = smoothstep( iData.w - 0.06, iData.w + 0.06, uCoverage );
  float dCam = length( center - cameraPosition );
  float nearFade = smoothstep( size * 0.35, size * 1.3, dCam );
  float farFade = 1.0 - smoothstep( uRadius * 0.82, uRadius, length( center.xz - cameraPosition.xz ) );
  vOpacity = vis * nearFade * farFade;
  if ( vOpacity < 0.002 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
`;

const puffFrag = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uBaseColor;
uniform float uDarken;
uniform float uFlash;
uniform float uDensity;
varying vec2 vUv;
varying vec4 vLight;
varying float vOpacity;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
uniform float uBaseY;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D( uAtlas, vUv );
  // Cumulus have flat, darker bases: clip the round billboards at the condensation level.
  float base = smoothstep( uBaseY - 30.0, uBaseY + 90.0, vWorld.y );
  float alpha = t.a * vOpacity * uDensity * base * 0.85;
  if ( alpha < 0.004 ) discard;
  float top = vLight.w;
  float nl = dot( normalize( vLight.xyz + vec3( 0.0, 0.35, 0.0 ) ), uSunDir ) * 0.5 + 0.5;
  float lit = mix( 0.24, 1.0, nl ) * mix( 0.36, 1.0, smoothstep( 0.0, 0.8, top ) );
  lit = mix( lit, 1.0, t.r * 0.35 );
  vec3 viewDir = normalize( vWorld - cameraPosition );
  float fwd = max( dot( viewDir, uSunDir ), 0.0 );
  float silver = pow( fwd, 10.0 ) * ( 1.0 - t.a ) * 2.2 + pow( fwd, 3.0 ) * 0.25;
  vec3 amb = mix( uBaseColor, uAmbient, top * 0.6 + 0.4 * t.r );
  vec3 col = amb + uSunColor * ( lit + silver );
  col *= uDarken;
  col += vec3( 0.85, 0.87, 1.0 ) * uFlash * ( 0.4 + 0.6 * ( 1.0 - top ) );
  gl_FragColor = vec4( col, alpha );
  #include <fog_fragment>
}
`;

const deckVert = /* glsl */ `
varying vec3 vWorld;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const deckFrag = /* glsl */ `
uniform sampler2D uNoise;
uniform vec2 uOffset;
uniform float uOvercast;
uniform vec3 uUnder;
uniform vec3 uTopColor;
uniform float uFlash;
uniform float uRadius;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vWorld.xz + uOffset;
  float n1 = texture2D( uNoise, p / 9000.0 ).r;
  float n2 = texture2D( uNoise, p / 2300.0 + 0.3 ).g;
  float n3 = texture2D( uNoise, p / 600.0 + 0.7 ).r;
  float dens = n1 * 0.5 + n2 * 0.35 + n3 * 0.15;
  float cov = smoothstep( 0.62, 0.95, uOvercast );
  float alpha = clamp( ( dens - ( 1.0 - cov ) * 0.8 ) * 3.0, 0.0, 1.0 ) * cov;
  float edge = 1.0 - smoothstep( uRadius * 0.7, uRadius, length( vWorld.xz - cameraPosition.xz ) );
  alpha *= edge;
  if ( alpha < 0.003 ) discard;
  bool below = cameraPosition.y < vWorld.y;
  vec3 col = below ? uUnder * ( 0.65 + 0.55 * dens ) : uTopColor * ( 0.8 + 0.3 * dens );
  col += vec3( 0.8, 0.82, 1.0 ) * uFlash * ( 0.5 + dens );
  gl_FragColor = vec4( col, alpha * 0.97 );
  #include <fog_fragment>
}
`;

interface Puff {
  cloud: number;
  lx: number;
  ly: number;
  lz: number;
  size: number;
  rot: number;
  atlas: number;
  dir: THREE.Vector3;
  top: number;
}

interface Cloud {
  x: number;
  z: number;
  threshold: number;
  storm: boolean;
}

export class CloudSystem {
  readonly group = new THREE.Group();
  readonly puffMaterial: THREE.ShaderMaterial;
  readonly deckMaterial: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly deck: THREE.Mesh;
  private readonly puffs: Puff[] = [];
  private readonly clouds: Cloud[] = [];
  private readonly radius: number;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aData: THREE.InstancedBufferAttribute;
  private readonly aLight: THREE.InstancedBufferAttribute;
  private readonly order: Int32Array;
  private readonly depth: Float32Array;
  private readonly driftX: number[] = [];
  private sortTimer = 0;
  private drift = new THREE.Vector2();
  private lastCam = new THREE.Vector3(1e9, 0, 0);

  constructor(atlas: THREE.Texture, noise: THREE.Texture, maxPuffs: number, seed: number, radius = 34000) {
    this.group.name = 'Clouds';
    this.radius = radius;
    const rnd = mulberry32(seed);
    // generate clouds until the puff budget is used
    let puffCount = 0;
    while (puffCount < maxPuffs) {
      const ci = this.clouds.length;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * radius;
      const storm = rnd() < 0.12;
      this.clouds.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, threshold: rnd() * 0.95 + 0.03, storm });
      const width = storm ? 1800 + rnd() * 1800 : 500 + Math.pow(rnd(), 1.5) * 1900;
      const height = storm ? width * (0.9 + rnd() * 0.6) : width * (0.35 + rnd() * 0.35);
      const n = Math.max(8, Math.floor((width / 95) * (0.8 + rnd() * 0.5)));
      for (let k = 0; k < n && puffCount < maxPuffs; k++) {
        // dome distribution with a flat base
        const u = rnd() * 2 - 1;
        const v = rnd() * 2 - 1;
        const rad = Math.sqrt(u * u + v * v);
        if (rad > 1) {
          k--;
          continue;
        }
        const lx = u * width * 0.5;
        const lz = v * width * 0.5 * (0.6 + rnd() * 0.5);
        const hmax = height * Math.sqrt(Math.max(0, 1 - rad * rad));
        const ly = Math.pow(rnd(), 0.8) * hmax;
        const size = (0.2 + rnd() * 0.22) * width * (1 - rad * 0.35);
        const dir = new THREE.Vector3(lx / (width * 0.5), (ly / Math.max(height, 1)) * 1.2 - 0.3, lz / (width * 0.5)).normalize();
        this.puffs.push({ cloud: ci, lx, ly: ly + size * 0.2, lz, size, rot: rnd() * Math.PI * 2, atlas: Math.floor(rnd() * 4), dir, top: Math.min(1, ly / Math.max(height, 1)) });
        puffCount++;
      }
    }
    for (let i = 0; i < this.clouds.length; i++) this.driftX.push(0);

    const count = this.puffs.length;
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.aLight = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aData.setUsage(THREE.DynamicDrawUsage);
    this.aLight.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iPos', this.aPos);
    this.geometry.setAttribute('iData', this.aData);
    this.geometry.setAttribute('iLight', this.aLight);
    this.geometry.instanceCount = count;
    this.order = new Int32Array(count);
    this.depth = new Float32Array(count);
    for (let i = 0; i < count; i++) this.order[i] = i;

    this.puffMaterial = new THREE.ShaderMaterial({
      name: 'CloudPuffs',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uAtlas: { value: null },
          uBaseY: { value: 1200 },
          uCoverage: { value: 0.3 },
          uRadius: { value: radius },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(1, 1, 1) },
          uAmbient: { value: new THREE.Color(0.5, 0.55, 0.65) },
          uBaseColor: { value: new THREE.Color(0.3, 0.32, 0.36) },
          uDarken: { value: 1 },
          uFlash: { value: 0 },
          uDensity: { value: 1 },
        },
      ]),
      vertexShader: puffVert,
      fragmentShader: puffFrag,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.puffMaterial.uniforms.uAtlas.value = atlas;
    this.mesh = new THREE.Mesh(this.geometry, this.puffMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.name = 'CloudPuffs';
    this.group.add(this.mesh);

    this.deckMaterial = new THREE.ShaderMaterial({
      name: 'CloudDeck',
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uNoise: { value: null },
          uOffset: { value: new THREE.Vector2() },
          uOvercast: { value: 0 },
          uUnder: { value: new THREE.Color(0.3, 0.3, 0.32) },
          uTopColor: { value: new THREE.Color(1, 1, 1) },
          uFlash: { value: 0 },
          uRadius: { value: radius * 1.1 },
        },
      ]),
      vertexShader: deckVert,
      fragmentShader: deckFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.deckMaterial.uniforms.uNoise.value = noise;
    const deckGeo = new THREE.CircleGeometry(radius * 1.1, 64);
    deckGeo.rotateX(-Math.PI / 2);
    this.deck = new THREE.Mesh(deckGeo, this.deckMaterial);
    this.deck.frustumCulled = false;
    this.deck.renderOrder = 21;
    this.deck.name = 'CloudDeck';
    this.group.add(this.deck);
    this.writeAttributes(new THREE.Vector3());
  }

  /** Cloud centre after wind drift, wrapped into the disc around the origin. */
  private cloudCenter(i: number, out: THREE.Vector2): THREE.Vector2 {
    const c = this.clouds[i];
    const size = this.radius * 2;
    let x = c.x + this.drift.x;
    let z = c.z + this.drift.y;
    x = ((((x + this.radius) % size) + size) % size) - this.radius;
    z = ((((z + this.radius) % size) + size) % size) - this.radius;
    return out.set(x, z);
  }

  private writeAttributes(cam: THREE.Vector3): void {
    const n = this.puffs.length;
    const centers: THREE.Vector2[] = [];
    const tmp = new THREE.Vector2();
    for (let i = 0; i < this.clouds.length; i++) centers.push(this.cloudCenter(i, tmp).clone());
    const baseY = this.puffMaterial.uniforms.uBaseY.value as number;
    for (let i = 0; i < n; i++) {
      const p = this.puffs[i];
      const cc = centers[p.cloud];
      const dx = cc.x + p.lx - cam.x;
      const dy = baseY + p.ly - cam.y;
      const dz = cc.y + p.lz - cam.z;
      this.depth[i] = dx * dx + dy * dy + dz * dz;
    }
    const order = this.order;
    const depth = this.depth;
    const sorted = Array.from(order).sort((a, b) => depth[b] - depth[a]);
    const pos = this.aPos.array as Float32Array;
    const data = this.aData.array as Float32Array;
    const light = this.aLight.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = sorted[k];
      const p = this.puffs[i];
      const cc = centers[p.cloud];
      const c = this.clouds[p.cloud];
      pos[k * 3] = cc.x + p.lx;
      pos[k * 3 + 1] = p.ly;
      pos[k * 3 + 2] = cc.y + p.lz;
      data[k * 4] = p.size;
      data[k * 4 + 1] = p.rot;
      data[k * 4 + 2] = p.atlas;
      // storm cells only appear in thunderstorms (threshold pushed above 1 otherwise)
      data[k * 4 + 3] = c.storm ? c.threshold + (this.stormMode ? -0.2 : 2) : c.threshold;
      light[k * 4] = p.dir.x;
      light[k * 4 + 1] = p.dir.y;
      light[k * 4 + 2] = p.dir.z;
      light[k * 4 + 3] = p.top;
    }
    this.aPos.needsUpdate = true;
    this.aData.needsUpdate = true;
    this.aLight.needsUpdate = true;
  }

  private stormMode = false;

  update(p: {
    dt: number;
    camera: THREE.Camera;
    windX: number;
    windZ: number;
    coverage: number;
    baseY: number;
    storm: boolean;
    sunDir: THREE.Vector3;
    sunColor: THREE.Color;
    ambient: THREE.Color;
    baseColor: THREE.Color;
    darken: number;
    flash: number;
    deckUnder: THREE.Color;
    deckTop: THREE.Color;
  }): void {
    const u = this.puffMaterial.uniforms;
    // puffs represent cumulus: visible fraction follows coverage, capped so overcast uses the deck
    const cov = Math.min(0.92, p.coverage * 1.05);
    u.uCoverage.value = cov;
    u.uBaseY.value = p.baseY;
    (u.uSunDir.value as THREE.Vector3).copy(p.sunDir);
    (u.uSunColor.value as THREE.Color).copy(p.sunColor);
    (u.uAmbient.value as THREE.Color).copy(p.ambient);
    (u.uBaseColor.value as THREE.Color).copy(p.baseColor);
    u.uDarken.value = p.darken;
    u.uFlash.value = p.flash;
    this.drift.x += p.windX * p.dt;
    this.drift.y += p.windZ * p.dt;
    if (this.stormMode !== p.storm) {
      this.stormMode = p.storm;
      this.sortTimer = 0;
    }
    this.mesh.visible = cov > 0.02;
    // resort when the camera moved or every ~0.5 s (drift)
    this.sortTimer -= p.dt;
    const cam = p.camera.position;
    if (this.sortTimer <= 0 || cam.distanceToSquared(this.lastCam) > 400 * 400) {
      this.sortTimer = 0.5;
      this.lastCam.copy(cam);
      this.writeAttributes(cam);
    }
    const d = this.deckMaterial.uniforms;
    d.uOvercast.value = p.coverage;
    (d.uOffset.value as THREE.Vector2).set(-this.drift.x, -this.drift.y);
    (d.uUnder.value as THREE.Color).copy(p.deckUnder);
    (d.uTopColor.value as THREE.Color).copy(p.deckTop);
    d.uFlash.value = p.flash;
    this.deck.visible = p.coverage > 0.62;
    this.deck.position.set(cam.x, p.baseY + 260, cam.z);
  }

  dispose(): void {
    this.geometry.dispose();
    this.deck.geometry.dispose();
    this.puffMaterial.dispose();
    this.deckMaterial.dispose();
  }
}
