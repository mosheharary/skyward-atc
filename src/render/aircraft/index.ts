// Aircraft renderer: procedural per-type models, canvas liveries, articulated surfaces, lights and LOD.
import * as THREE from 'three';
import { DEG, FT, KT, clamp, lerp } from '../../core/units';
import { AIRLINE_BY_CODE, type Airline } from '../../sim/airlines';
import type { AircraftRenderState, AircraftTypeId, QualityLevel } from '../../sim/types';
import type { AircraftRenderContext, CreateAircraftRenderer, IAircraftRenderer } from '../contracts';
import { box, merge, strut } from './geom';
import { DEFAULT_LIVERY, makeFinTexture, makeFuselageTexture, makeGlowTexture, makeGradientTexture, makeRegistrationTexture, makeWindowTile } from './livery';
import { WINDOW_TILE_FRAC, buildTypeAsset, cockpitOffset, type LightDef, type Slot, type TypeAsset } from './model';

// ------------------------------------------------------------------ quality

interface AcQuality {
  /** Projected length (px) above which the fully articulated model is used. */
  lod0Px: number;
  /** Above this: merged LOD1, below: LOD2. */
  lod1Px: number;
  /** Below this only the lights are drawn. */
  hidePx: number;
  shadowLod: number;
  aniso: number;
  cones: boolean;
}

const QUALITY: Record<QualityLevel, AcQuality> = {
  low: { lod0Px: 420, lod1Px: 70, hidePx: 3, shadowLod: 0, aniso: 2, cones: false },
  medium: { lod0Px: 280, lod1Px: 50, hidePx: 2.5, shadowLod: 1, aniso: 4, cones: true },
  high: { lod0Px: 190, lod1Px: 38, hidePx: 2, shadowLod: 1, aniso: 8, cones: true },
  ultra: { lod0Px: 120, lod1Px: 28, hidePx: 1.5, shadowLod: 1, aniso: 16, cones: true },
};

// ------------------------------------------------------------------ light sprites

const lightVert = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uProj;
uniform float uMinPx;
uniform float uMaxPx;
varying vec3 vColor;
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  float px = aSize * uProj / max( -mvPosition.z, 0.5 );
  // distant lights keep a minimum footprint and dim instead of vanishing
  float dim = 0.3 + 0.7 * sqrt( clamp( px / uMinPx, 0.0, 1.0 ) );
  vColor = aColor * dim;
  gl_PointSize = clamp( px, uMinPx, uMaxPx );
}
`;

const lightFrag = /* glsl */ `
varying vec3 vColor;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float a = exp( -r2 * 10.0 ) + exp( -r2 * 2.8 ) * 0.28;
  if ( a < 0.01 ) discard;
  vec3 col = vColor * a;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col *= 1.0 - fogFactor * 0.96;
  #endif
  gl_FragColor = vec4( col, 1.0 );
}
`;

class LightSprites {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private geometry = new THREE.BufferGeometry();
  private cap = 0;
  private pos = new Float32Array(0);
  private col = new Float32Array(0);
  private size = new Float32Array(0);
  n = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'AircraftLights',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uProj: { value: 800 }, uMinPx: { value: 2 }, uMaxPx: { value: 90 } }]),
      vertexShader: lightVert,
      fragmentShader: lightFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.points.name = 'AircraftLights';
    this.ensure(256);
  }

  private ensure(n: number): void {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const pos = new Float32Array(cap * 3);
    const col = new Float32Array(cap * 3);
    const size = new Float32Array(cap);
    pos.set(this.pos);
    col.set(this.col);
    size.set(this.size);
    this.pos = pos;
    this.col = col;
    this.size = size;
    this.cap = cap;
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
    this.points.geometry = this.geometry;
  }

  begin(): void {
    this.n = 0;
  }

  push(p: THREE.Vector3, r: number, g: number, b: number, s: number): void {
    if (r + g + b < 0.003) return;
    this.ensure(this.n + 1);
    const i = this.n++;
    this.pos[i * 3] = p.x;
    this.pos[i * 3 + 1] = p.y;
    this.pos[i * 3 + 2] = p.z;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.size[i] = s;
  }

  end(camera: THREE.PerspectiveCamera, viewportH: number, pixelRatio: number): void {
    for (const name of ['position', 'aColor', 'aSize']) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * a.itemSize);
    }
    this.geometry.setDrawRange(0, this.n);
    const u = this.material.uniforms;
    u.uProj.value = (viewportH * pixelRatio) / (2 * Math.tan((camera.fov * DEG) / 2)) * camera.zoom;
    u.uMinPx.value = 3 * pixelRatio;
    u.uMaxPx.value = 110 * pixelRatio;
    this.points.visible = this.n > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// Landing-light beam: fades along its length and towards the silhouette so the cone has no hard edges.
const beamVert = /* glsl */ `
attribute vec3 color;
varying float vFade;
varying vec3 vN;
varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vFade = color.r;
  vN = normalize( normalMatrix * normal );
  vV = normalize( -mv.xyz );
}
`;

const beamFrag = /* glsl */ `
uniform float uIntensity;
varying float vFade;
varying vec3 vN;
varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float edge = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 2.5 );
  float a = vFade * edge * uIntensity;
  gl_FragColor = vec4( vec3( 1.0, 0.95, 0.86 ) * a, 1.0 );
}
`;

// ------------------------------------------------------------------ materials

interface AirlineMats {
  refs: number;
  textures: THREE.Texture[];
  body: THREE.MeshPhysicalMaterial;
  belly: THREE.MeshStandardMaterial;
  fin: THREE.MeshStandardMaterial;
  finLit: THREE.MeshStandardMaterial;
  engine: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  regDark: boolean;
}

interface WindowMats {
  tile: THREE.Texture;
  dark: THREE.MeshStandardMaterial;
  lit: THREE.MeshStandardMaterial;
}

const std = (color: THREE.ColorRepresentation, roughness: number, metalness: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

function luminance(hex: string): number {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ tug

function buildTugGeometry(): { paint: THREE.BufferGeometry; dark: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const M = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const paint = merge([box(2.5, 0.9, 5.2, M(0, 0.85, 0)), box(2.3, 0.35, 4.6, M(0, 1.45, 0.2)), box(1.2, 0.9, 1.1, M(-0.55, 2.05, -1.6))]);
  const wheels: THREE.BufferGeometry[] = [];
  for (const x of [-1.1, 1.1]) {
    for (const z of [-1.7, 1.7]) {
      const w = new THREE.CylinderGeometry(0.5, 0.5, 0.45, 16);
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.5, z);
      wheels.push(w);
    }
  }
  wheels.push(box(2.6, 0.25, 0.3, M(0, 0.55, 2.65)));
  const glass = box(1.25, 0.6, 1.15, M(-0.55, 2.15, -1.6));
  return { paint, dark: merge(wheels), glass };
}

// ------------------------------------------------------------------ per-aircraft visual

interface HingeObj {
  obj: THREE.Object3D;
  part: TypeAsset['flaps'][number];
}

interface LegObj {
  group: THREE.Group;
  kind: 'nose' | 'wing' | 'body';
  side: number;
  steer: THREE.Group | null;
  wheels: THREE.Object3D[];
}

interface PropObj {
  spin: THREE.Group;
  blades: THREE.Mesh;
  blur: THREE.Mesh;
}

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _cam = new THREE.Vector3();

class Visual {
  readonly root = new THREE.Group();
  readonly asset: TypeAsset;
  readonly mats: AirlineMats;
  readonly airlineKey: string;
  readonly phase: number;
  readonly regTex: THREE.CanvasTexture;
  readonly regMat: THREE.MeshStandardMaterial;
  lod0: THREE.Group | null = null;
  readonly lod1 = new THREE.Group();
  readonly lod1Gear = new THREE.Group();
  readonly lod2 = new THREE.Group();
  lod = -1;
  flaps: HingeObj[] = [];
  spoilers: HingeObj[] = [];
  slats: THREE.Mesh | null = null;
  sleeve: THREE.Mesh | null = null;
  fans: THREE.Group[] = [];
  props: PropObj[] = [];
  legs: LegObj[] = [];
  windows: THREE.Mesh[] = [];
  cones: THREE.Mesh[] = [];
  pool: THREE.Mesh | null = null;
  tug: THREE.Group | null = null;
  wheelRot = 0;
  fanRot = 0;
  fanSpeed = 0;
  shadowsOn = true;
  seen = 0;

  constructor(
    private readonly r: AircraftRendererImpl,
    public s: AircraftRenderState,
  ) {
    this.asset = r.asset(s.typeId);
    this.airlineKey = `${s.airlineCode}|${s.typeId}`;
    this.mats = r.acquireAirline(this.airlineKey, AIRLINE_BY_CODE[s.airlineCode], this.asset);
    this.phase = hash(s.id);
    this.regTex = makeRegistrationTexture(s.registration, this.asset.reg.aspect, this.mats.regDark);
    this.regMat = std(0xffffff, 0.5, 0, { map: this.regTex, transparent: true, depthWrite: false, alphaTest: 0.05 });
    this.root.name = `aircraft:${s.id}`;
    this.root.rotation.order = 'YXZ';
    this.root.userData.aircraftId = s.id;
    this.buildLod1();
    this.buildLod2();
    this.root.add(this.lod1, this.lod2);
    this.lod1.add(this.lod1Gear);
    this.lod1.visible = false;
    this.lod2.visible = false;
    // landing light beams + ground pool
    for (const ll of this.asset.landingLight) {
      const cone = new THREE.Mesh(r.coneGeo, r.coneMat);
      const len = clamp(this.asset.length * 1.6, 35, 90);
      const rad = len * 0.12;
      cone.position.copy(ll.pos);
      cone.scale.set(rad, rad, len);
      cone.lookAt(_v.copy(ll.pos).add(ll.dir));
      cone.visible = false;
      cone.renderOrder = 4;
      this.root.add(cone);
      this.cones.push(cone);
    }
    // lookAt makes +Z face the target; the cone geometry extends along +Z.
    this.pool = new THREE.Mesh(r.poolGeo, r.poolMat);
    const pr = clamp(this.asset.length * 0.45, 9, 26);
    this.pool.scale.set(pr * 0.8, 1, pr * 1.4);
    this.pool.position.set(0, 0.06, this.asset.noseGear.z - pr * 1.35);
    this.pool.visible = false;
    this.pool.renderOrder = 3;
    this.root.add(this.pool);
  }

  private mesh(geo: THREE.BufferGeometry | null | undefined, mat: THREE.Material, parent: THREE.Object3D, shadow = true): THREE.Mesh | null {
    if (!geo || !geo.getAttribute('position') || geo.getAttribute('position').count === 0) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.userData.castsShadow = shadow;
    parent.add(m);
    return m;
  }

  slotMat(slot: Slot): THREE.Material {
    const r = this.r;
    const m = this.mats;
    switch (slot) {
      case 'body':
        return m.body;
      case 'belly':
        return m.belly;
      case 'fin':
        return this.s.lights.logo ? m.finLit : m.fin;
      case 'engine':
        return m.engine;
      case 'accent':
        return m.accent;
      case 'spinner':
        return this.asset.shape.spinner === 'dark' ? r.shared.spinnerDark : r.shared.spinner;
      default:
        return r.shared[slot];
    }
  }

  private buildLod1(): void {
    const a = this.asset;
    for (const slot of Object.keys(a.lod1) as Slot[]) this.mesh(a.lod1[slot], this.slotMat(slot), this.lod1);
    for (const slot of Object.keys(a.lod1Gear) as Slot[]) this.mesh(a.lod1Gear[slot], this.slotMat(slot), this.lod1Gear);
    this.addWindowsAndReg(this.lod1);
  }

  private addWindowsAndReg(parent: THREE.Object3D): void {
    const a = this.asset;
    if (a.windowBand && !AIRLINE_BY_CODE[this.s.airlineCode]?.cargo) {
      const w = this.mesh(a.windowBand, this.r.windowMats(a).dark, parent, false);
      if (w) {
        w.renderOrder = 1;
        this.windows.push(w);
      }
    }
    const reg = this.mesh(a.reg.geometry, this.regMat, parent, false);
    if (reg) reg.renderOrder = 1;
  }

  private buildLod2(): void {
    const a = this.asset;
    for (const slot of Object.keys(a.lod2) as Slot[]) this.mesh(a.lod2[slot], this.slotMat(slot), this.lod2, false);
  }

  buildLod0(): THREE.Group {
    const a = this.asset;
    const sh = this.r.shared;
    const g = new THREE.Group();
    g.name = 'lod0';
    this.mesh(a.skin, this.mats.body, g);
    this.mesh(a.apu, sh.dark, g);
    this.mesh(a.fairing, this.mats.belly, g);
    this.mesh(a.wing, sh.wing, g);
    this.mesh(a.winglets, this.mats.accent, g);
    this.mesh(a.fin, this.slotMat('fin'), g);
    this.mesh(a.stab, sh.wing, g);
    this.addWindowsAndReg(g);
    this.slats = this.mesh(a.slats, sh.metal, g);
    const hinge = (list: TypeAsset['flaps'], out: HingeObj[]) => {
      for (const part of list) {
        const obj = new THREE.Object3D();
        obj.position.copy(part.pivot);
        this.mesh(part.geometry, sh.wing, obj);
        g.add(obj);
        out.push({ obj, part });
      }
    };
    hinge(a.flaps, this.flaps);
    hinge(a.spoilers, this.spoilers);
    const e = a.engines;
    this.mesh(e.paint, this.mats.engine, g);
    this.sleeve = this.mesh(e.sleeve, this.mats.engine, g);
    this.mesh(e.lip, sh.metal, g);
    this.mesh(e.inlet, sh.dark, g, false);
    this.mesh(e.dark, sh.dark, g);
    this.mesh(e.pylons, sh.wing, g);
    const spinMat = this.slotMat('spinner');
    for (const f of e.fans) {
      const spin = new THREE.Group();
      spin.position.copy(f.center);
      this.mesh(f.blades, sh.fan, spin, false);
      this.mesh(f.spinner, spinMat, spin, false);
      g.add(spin);
      this.fans.push(spin);
    }
    for (const p of e.props) {
      const spin = new THREE.Group();
      spin.position.copy(p.center);
      const blades = this.mesh(p.blades, sh.fan, spin) as THREE.Mesh;
      this.mesh(p.spinner, spinMat, spin);
      const blur = this.mesh(p.blur, this.r.propBlurMat, spin, false) as THREE.Mesh;
      blur.visible = false;
      blur.renderOrder = 2;
      g.add(spin);
      this.props.push({ spin, blades, blur });
    }
    for (const leg of a.legs) {
      const group = new THREE.Group();
      group.position.copy(leg.pivot);
      this.mesh(leg.paint, sh.gearPaint, group);
      this.mesh(leg.chrome, sh.chrome, group);
      let steer: THREE.Group | null = null;
      if (leg.kind === 'nose') {
        steer = new THREE.Group();
        group.add(steer);
        this.mesh(leg.steerPaint, sh.gearPaint, steer);
        this.mesh(leg.steerChrome, sh.chrome, steer);
      }
      const wheels: THREE.Object3D[] = [];
      for (const ax of leg.axles) {
        const w = new THREE.Group();
        w.position.copy(ax.center);
        w.userData.r = ax.r;
        this.mesh(ax.tires, sh.tire, w);
        this.mesh(ax.hubs, sh.hub, w);
        (steer ?? group).add(w);
        wheels.push(w);
      }
      g.add(group);
      this.legs.push({ group, kind: leg.kind, side: leg.side, steer, wheels });
    }
    this.lod0 = g;
    this.root.add(g);
    return g;
  }

  setShadows(lod0: boolean, lod1: boolean): void {
    const set = (o: THREE.Object3D | null, on: boolean) =>
      o?.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) c.castShadow = on && c.userData.castsShadow === true;
      });
    set(this.lod0, lod0);
    set(this.lod1, lod1);
  }

  setTug(on: boolean): void {
    if (on && !this.tug) {
      const r = this.r;
      const t = new THREE.Group();
      const s = clamp(this.asset.length / 40, 0.75, 1.3);
      const body = new THREE.Group();
      body.scale.setScalar(s);
      body.position.z = -3.4 - 2.6 * s;
      const m1 = new THREE.Mesh(r.tugGeo.paint, r.shared.tugPaint);
      const m2 = new THREE.Mesh(r.tugGeo.dark, r.shared.tire);
      const m3 = new THREE.Mesh(r.tugGeo.glass, r.shared.glass);
      for (const m of [m1, m2, m3]) {
        m.castShadow = true;
        body.add(m);
      }
      t.add(body);
      const bar = new THREE.Mesh(r.towbarGeo, r.shared.gearPaint);
      bar.castShadow = true;
      t.add(bar);
      t.position.set(0, 0, this.asset.noseGear.z);
      t.userData.beacon = new THREE.Vector3(-0.55 * s, 2.65 * s, body.position.z - 1.6 * s);
      this.tug = t;
      this.root.add(t);
    }
    if (this.tug) this.tug.visible = on;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.regTex.dispose();
    this.regMat.dispose();
    this.r.releaseAirline(this.airlineKey);
  }
}

// ------------------------------------------------------------------ renderer

type SharedSlot = Exclude<Slot, 'body' | 'belly' | 'fin' | 'engine' | 'accent'>;

class AircraftRendererImpl implements IAircraftRenderer {
  private readonly group = new THREE.Group();
  private readonly assets = new Map<AircraftTypeId, TypeAsset>();
  private readonly airlineMats = new Map<string, AirlineMats>();
  private readonly winMats = new Map<AircraftTypeId, WindowMats>();
  private readonly visuals = new Map<string, Visual>();
  private readonly lights = new LightSprites();
  private readonly ring: THREE.Mesh;
  private selected: string | null = null;
  private q: AcQuality;
  private frame = 0;
  private time = 0;
  readonly shared: Record<SharedSlot, THREE.MeshStandardMaterial> & { spinnerDark: THREE.MeshStandardMaterial; tugPaint: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial };
  readonly propBlurMat: THREE.MeshBasicMaterial;
  readonly coneGeo: THREE.BufferGeometry;
  readonly coneMat: THREE.ShaderMaterial;
  readonly poolGeo: THREE.BufferGeometry;
  readonly poolMat: THREE.MeshBasicMaterial;
  readonly tugGeo: ReturnType<typeof buildTugGeometry>;
  readonly towbarGeo: THREE.BufferGeometry;
  private readonly misc: THREE.Texture[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    quality: QualityLevel,
  ) {
    this.q = QUALITY[quality];
    this.group.name = 'aircraft';
    scene.add(this.group);
    scene.add(this.lights.points);
    this.shared = {
      wing: std(0xc3c8cf, 0.55, 0.2),
      metal: std(0xc9ced4, 0.26, 0.9),
      dark: std(0x17191d, 0.6, 0.3),
      gearPaint: std(0xd8dadd, 0.45, 0.1),
      chrome: std(0xe6e9ec, 0.12, 1.0),
      tire: std(0x151516, 0.88, 0.0),
      hub: std(0x9ea3aa, 0.35, 0.8),
      fan: std(0x4a4e55, 0.3, 0.85),
      spinner: std(0xc8ccd2, 0.2, 0.95),
      spinnerDark: std(0x1c1e22, 0.35, 0.6),
      tugPaint: std(0xe8e4d8, 0.55, 0.1),
      glass: std(0x1a2230, 0.08, 0.6),
    };
    const blurTex = makeGradientTexture([
      [0, 0],
      [0.25, 0.25],
      [0.8, 0.35],
      [0.95, 0.5],
      [1, 0],
    ]);
    this.misc.push(blurTex);
    this.propBlurMat = new THREE.MeshBasicMaterial({ color: 0x2a2c30, alphaMap: blurTex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.8 });
    // Landing-light beam: cone along +Z (apex at the origin), brightness fading with distance via vertex colours.
    const cone = new THREE.CylinderGeometry(0.05, 1, 1, 24, 6, true);
    cone.translate(0, -0.5, 0);
    cone.rotateX(-Math.PI / 2);
    const cp = cone.getAttribute('position') as THREE.BufferAttribute;
    const cc = new Float32Array(cp.count * 3);
    for (let i = 0; i < cp.count; i++) {
      const f = Math.pow(1 - clamp(cp.getZ(i), 0, 1), 1.6);
      cc[i * 3] = f;
      cc[i * 3 + 1] = f;
      cc[i * 3 + 2] = f;
    }
    cone.setAttribute('color', new THREE.BufferAttribute(cc, 3));
    this.coneGeo = cone;
    this.coneMat = new THREE.ShaderMaterial({
      name: 'LandingBeam',
      uniforms: { uIntensity: { value: 0 } },
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const glow = makeGlowTexture();
    this.misc.push(glow);
    const pool = new THREE.PlaneGeometry(2, 2);
    pool.rotateX(-Math.PI / 2);
    this.poolGeo = pool;
    this.poolMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.85), map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6 });
    this.tugGeo = buildTugGeometry();
    this.towbarGeo = merge([strut(new THREE.Vector3(0, 0.45, 0), new THREE.Vector3(0, 0.6, -3.5), 0.07, 0.07, 8)]);
    const ringGeo = new THREE.RingGeometry(0.93, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.4, 2.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.ring.name = 'selectionRing';
    scene.add(this.ring);
  }

  // ---------------------------------------------------------------- caches

  asset(id: AircraftTypeId): TypeAsset {
    let a = this.assets.get(id);
    if (!a) {
      a = buildTypeAsset(id);
      this.assets.set(id, a);
    }
    return a;
  }

  acquireAirline(key: string, airline: Airline | undefined, asset: TypeAsset): AirlineMats {
    let m = this.airlineMats.get(key);
    if (!m) {
      const liv = airline?.livery ?? DEFAULT_LIVERY;
      const tex = makeFuselageTexture(airline, asset.shape, asset.fm, this.q.aniso);
      const finTex = makeFinTexture(airline, asset.finInfo, this.q.aniso);
      const fin = std(0xffffff, 0.38, 0.1, { map: finTex });
      const finLit = fin.clone();
      finLit.emissive.set(0xffffff);
      finLit.emissiveMap = finTex;
      finLit.emissiveIntensity = 0;
      m = {
        refs: 0,
        textures: [tex, finTex],
        body: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: tex, roughness: 0.4, metalness: 0.05, clearcoat: 0.3, clearcoatRoughness: 0.3 }),
        belly: std(liv.belly, 0.4, 0.1),
        fin,
        finLit,
        engine: std(liv.engine, 0.33, 0.35),
        accent: std(liv.tail, 0.38, 0.1),
        regDark: luminance(liv.body) > 0.45,
      };
      this.airlineMats.set(key, m);
    }
    m.refs++;
    return m;
  }

  releaseAirline(key: string): void {
    const m = this.airlineMats.get(key);
    if (!m) return;
    if (--m.refs > 0) return;
    this.airlineMats.delete(key);
    m.textures.forEach((t) => t.dispose());
    [m.body, m.belly, m.fin, m.finLit, m.engine, m.accent].forEach((x) => x.dispose());
  }

  windowMats(a: TypeAsset): WindowMats {
    let w = this.winMats.get(a.id);
    if (!w) {
      const row = a.windowRow;
      const tile = makeWindowTile(clamp(row.w / row.pitch, 0.2, 0.9), WINDOW_TILE_FRAC);
      const dark = std(0x0b0e13, 0.08, 0.6, { alphaMap: tile, transparent: true, depthWrite: false });
      const lit = dark.clone();
      lit.emissive.set(0xffd49a);
      lit.emissiveIntensity = 0;
      w = { tile, dark, lit };
      this.winMats.set(a.id, w);
    }
    return w;
  }

  // ---------------------------------------------------------------- API

  getObject(id: string): THREE.Object3D | undefined {
    return this.visuals.get(id)?.root;
  }

  getCockpitOffset(typeId: AircraftTypeId): THREE.Vector3 {
    return this.assets.get(typeId)?.cockpit.clone() ?? cockpitOffset(typeId);
  }

  setSelected(id: string | null): void {
    this.selected = id;
  }

  setQuality(q: QualityLevel): void {
    this.q = QUALITY[q];
    for (const v of this.visuals.values()) v.lod = -1;
  }

  update(list: readonly AircraftRenderState[], ctx: AircraftRenderContext): void {
    this.frame++;
    this.time += ctx.dt;
    const frame = this.frame;
    const night = clamp(ctx.nightFactor, 0, 1);
    const cam = ctx.camera;
    cam.getWorldPosition(_cam);
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const proj = vh / (2 * Math.tan((cam.fov * DEG) / 2)) * cam.zoom;

    // global night-driven material state
    for (const w of this.winMats.values()) w.lit.emissiveIntensity = night * 2.6;
    for (const m of this.airlineMats.values()) m.finLit.emissiveIntensity = night * 0.55;
    this.coneMat.uniforms.uIntensity.value = this.q.cones ? 0.12 * night : 0;
    this.poolMat.opacity = 0.32 * night;

    this.lights.begin();
    for (const s of list) {
      let v = this.visuals.get(s.id);
      if (v && (v.s.typeId !== s.typeId || v.s.airlineCode !== s.airlineCode)) {
        this.visuals.delete(s.id);
        v.dispose();
        v = undefined;
      }
      if (!v) {
        v = new Visual(this, s);
        this.visuals.set(s.id, v);
        this.group.add(v.root);
      }
      v.s = s;
      v.seen = frame;
      this.updateVisual(v, s, ctx, night, proj);
    }
    for (const [id, v] of this.visuals) {
      if (v.seen !== frame) {
        v.dispose();
        this.visuals.delete(id);
      }
    }
    this.lights.end(cam, vh, dpr);

    // selection ring
    const sel = this.selected ? this.visuals.get(this.selected) : undefined;
    if (sel) {
      const p = 0.5 + 0.5 * Math.sin(this.time * 4);
      this.ring.visible = true;
      this.ring.position.set(sel.root.position.x, sel.root.position.y + 0.15, sel.root.position.z);
      const sc = sel.asset.radius * (1.02 + 0.04 * p);
      this.ring.scale.set(sc, 1, sc);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * p;
    } else {
      this.ring.visible = false;
    }
  }

  private updateVisual(v: Visual, s: AircraftRenderState, ctx: AircraftRenderContext, night: number, proj: number): void {
    const a = v.asset;
    const root = v.root;
    root.position.set(s.x, (s.altFt - ctx.fieldElevationFt) * FT, -s.y);
    root.rotation.set(s.pitch * DEG, -s.hdg * DEG, -s.bank * DEG, 'YXZ');
    root.updateMatrix();
    root.updateMatrixWorld(true);

    // ---- LOD
    const dist = Math.max(1, _cam.distanceTo(root.position));
    const px = (a.length * proj) / dist;
    const q = this.q;
    const h = v.lod < 0 ? 1 : 1.12; // hysteresis
    let lod: number;
    if (px > q.lod0Px * (v.lod === 0 ? 1 / h : h)) lod = 0;
    else if (px > q.lod1Px * (v.lod <= 1 && v.lod >= 0 ? 1 / h : h)) lod = 1;
    else if (px > q.hidePx) lod = 2;
    else lod = 3;
    if (lod !== v.lod) {
      if (lod === 0 && !v.lod0) v.buildLod0();
      if (v.lod0) v.lod0.visible = lod === 0;
      v.lod1.visible = lod === 1;
      v.lod2.visible = lod === 2;
      v.setShadows(true, q.shadowLod >= 1);
      v.lod = lod;
    }
    v.lod1Gear.visible = s.gear > 0.5;

    // ---- materials that depend on per-aircraft light switches
    const cargo = AIRLINE_BY_CODE[s.airlineCode]?.cargo;
    if (!cargo) {
      const wm = this.windowMats(a);
      const wmat = s.lights.cabin ? wm.lit : wm.dark;
      for (const w of v.windows) w.material = wmat;
    }
    const finMat = v.slotMat('fin');
    for (const g of [v.lod0, v.lod1, v.lod2]) {
      g?.children.forEach((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh && (m.material === v.mats.fin || m.material === v.mats.finLit)) m.material = finMat;
      });
    }

    // ---- animation (always advanced so switching LOD does not pop)
    const dt = ctx.dt;
    if (s.onGround) v.wheelRot -= (s.gsKt * KT * dt) / 1;
    const targetFan = s.enginesRunning ? 8 + s.thrust * 70 : 0;
    v.fanSpeed += (targetFan - v.fanSpeed) * clamp(dt * (s.enginesRunning ? 0.8 : 0.25), 0, 1);
    v.fanRot = (v.fanRot + v.fanSpeed * dt) % (Math.PI * 2000);

    if (v.lod === 0) {
      const flaps = clamp(s.flaps, 0, 1);
      for (const f of v.flaps) {
        f.obj.position.copy(f.part.pivot).addScaledVector(f.part.travel, flaps);
        f.obj.quaternion.setFromAxisAngle(f.part.axis, flaps * f.part.maxAngle);
      }
      const sp = clamp(s.spoilers, 0, 1);
      for (const f of v.spoilers) {
        f.obj.position.copy(f.part.pivot).addScaledVector(f.part.travel, sp);
        f.obj.quaternion.setFromAxisAngle(f.part.axis, -sp * f.part.maxAngle);
      }
      if (v.slats) v.slats.position.copy(a.slatTravel).multiplyScalar(Math.min(1, flaps * 2));
      if (v.sleeve) v.sleeve.position.set(0, 0, a.engines.sleeveTravel * clamp(s.reverse, 0, 1));
      for (const f of v.fans) f.rotation.z = v.fanRot;
      for (const p of v.props) {
        const spd = v.fanSpeed * 0.6;
        p.spin.rotation.z = v.fanRot * 0.6;
        const blurOn = spd > 7;
        p.blur.visible = blurOn;
        p.blades.visible = !blurOn || spd < 12;
      }
      const g = clamp(s.gear, 0, 1);
      const ang = (1 - g) * Math.PI * 0.5 * 0.95;
      for (const leg of v.legs) {
        leg.group.visible = g > 0.03;
        if (leg.kind === 'nose') leg.group.rotation.set(ang, 0, 0);
        else if (leg.kind === 'wing') leg.group.rotation.set(0, 0, -leg.side * ang);
        else leg.group.rotation.set(-ang, 0, 0);
        if (leg.steer) leg.steer.rotation.y = -clamp(s.steer, -80, 80) * DEG * g;
        for (const w of leg.wheels) w.rotation.x = v.wheelRot / (w.userData.r as number);
      }
    }

    // ---- tug
    if (s.tug || v.tug) v.setTug(s.tug && v.lod <= 2);
    if (v.tug && v.tug.visible) v.tug.rotation.y = -clamp(s.steer, -60, 60) * DEG * 0.5;

    // ---- beams and ground pool
    const beams = s.lights.landing && !s.onGround && night > 0.15 && v.lod <= 1;
    for (const c of v.cones) c.visible = beams && q.cones;
    if (v.pool) v.pool.visible = night > 0.15 && s.onGround && (s.lights.landing || s.lights.taxi) && v.lod <= 2;

    // ---- light sprites
    this.pushLights(v, s, night);
  }

  private pushLights(v: Visual, s: AircraftRenderState, night: number): void {
    const L = s.lights;
    const m = v.root.matrixWorld;
    const k = lerp(0.3, 1, night);
    const t = this.time;
    const beacon = (ph: number) => {
      const x = (t * 1.05 + v.phase + ph) % 1;
      return THREE.MathUtils.smoothstep(x, 0, 0.03) * (1 - THREE.MathUtils.smoothstep(x, 0.1, 0.2));
    };
    const strobeT = (t / 1.2 + v.phase * 3.7) % 1;
    const strobe = strobeT < 0.035 || (strobeT > 0.11 && strobeT < 0.145) ? 1 : 0;
    for (const d of v.asset.lights as LightDef[]) {
      let r = 0;
      let g = 0;
      let b = 0;
      let size = d.size;
      switch (d.kind) {
        case 'navR':
          if (L.nav) [r, g, b] = [6 * k, 0.25 * k, 0.15 * k];
          break;
        case 'navG':
          if (L.nav) [r, g, b] = [0.2 * k, 5 * k, 1.4 * k];
          break;
        case 'navW':
          if (L.nav) [r, g, b] = [3.5 * k, 3.5 * k, 3.3 * k];
          break;
        case 'beacon':
          if (L.beacon) {
            const f = beacon(d.phase ?? 0) * lerp(0.6, 1, night);
            [r, g, b] = [14 * f, 0.6 * f, 0.3 * f];
            size *= 1.2;
          }
          break;
        case 'strobe':
          if (L.strobe && strobe) {
            [r, g, b] = [30, 30, 32];
            size *= 1.6;
          }
          break;
        case 'landing':
        case 'taxi': {
          const on = d.kind === 'landing' ? L.landing : L.taxi && s.gear > 0.9;
          if (!on) break;
          _v.copy(d.pos).applyMatrix4(m);
          _d.copy(d.dir as THREE.Vector3).transformDirection(m);
          const toCam = _cam.clone().sub(_v).normalize();
          const facing = Math.max(0, _d.dot(toCam));
          const f = 0.08 + 0.92 * Math.pow(facing, 6);
          const base = d.kind === 'landing' ? 22 : 12;
          const kk = lerp(0.5, 1, night) * base * f;
          [r, g, b] = [kk, kk * 0.96, kk * 0.88];
          size *= 0.6 + 1.8 * Math.pow(facing, 3);
          this.lights.push(_v, r, g, b, size);
          continue;
        }
      }
      if (r + g + b <= 0) continue;
      _v.copy(d.pos).applyMatrix4(m);
      this.lights.push(_v, r, g, b, size);
    }
    // tug amber beacon
    if (v.tug?.visible) {
      const f = 0.5 + 0.5 * Math.sin(t * 7 + v.phase * 6);
      v.tug.updateMatrixWorld();
      _v.copy(v.tug.userData.beacon as THREE.Vector3).applyMatrix4(v.tug.matrixWorld);
      this.lights.push(_v, 8 * f * k, 4 * f * k, 0.3 * f * k, 0.5);
    }
  }

  dispose(): void {
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    for (const a of this.assets.values()) a.dispose();
    this.assets.clear();
    for (const w of this.winMats.values()) {
      w.tile.dispose();
      w.dark.dispose();
      w.lit.dispose();
    }
    this.winMats.clear();
    for (const m of Object.values(this.shared)) m.dispose();
    this.misc.forEach((t) => t.dispose());
    this.propBlurMat.dispose();
    this.coneGeo.dispose();
    this.coneMat.dispose();
    this.poolGeo.dispose();
    this.poolMat.dispose();
    this.tugGeo.paint.dispose();
    this.tugGeo.dark.dispose();
    this.tugGeo.glass.dispose();
    this.towbarGeo.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.ring.removeFromParent();
    this.lights.points.removeFromParent();
    this.lights.dispose();
    this.group.removeFromParent();
    void this.scene;
  }
}

export const createAircraftRenderer: CreateAircraftRenderer = (scene, quality) => new AircraftRendererImpl(scene, quality);
