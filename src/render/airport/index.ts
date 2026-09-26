// Airport renderer: pavements, ICAO markings, signs, buildings, control tower, jet bridges and
// the complete airfield lighting system, built procedurally from the AirportModel.

import * as THREE from 'three';
import type { AirportModel } from '../../sim/airportModel';
import type { QualityLevel } from '../../sim/types';
import type { AirportRenderUpdate, CreateAirportRenderer, IAirportRenderer } from '../contracts';
import { JetBridges } from './bridges';
import { buildStructures } from './buildings';
import type { GeoBuf } from './geo';
import { buildLayout } from './layout';
import { G_ALWAYS, G_APP, G_BUILD, G_FLOOD, G_OBST, G_PAPI, G_RWY, G_STOP, G_TAXI_CL, G_TAXI_EDGE, LightField } from './lights';
import { makeAsphalt, makeAtlas, makeConcrete, makeFacade, makeFence, makeMacro, makeMetal, makePool, makeRoof, makeRubber } from './textures';

interface WetMat {
  mat: THREE.MeshStandardMaterial;
  rough: number;
  color: THREE.Color;
  wetDark: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Large-scale tonal variation so tiled surfaces don't repeat visibly. */
function addMacro(mat: THREE.MeshStandardMaterial, macro: THREE.Texture, scale: number, strength: number): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMacro = { value: macro };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uMacro;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float m = texture2D(uMacro, vMapUv * ${scale.toFixed(4)}).r;
          float m2 = texture2D(uMacro, vMapUv * ${(scale * 0.21).toFixed(4)} + 0.37).g;
          diffuseColor.rgb *= mix(1.0, 0.78 + 0.44 * m * m2 * 1.6, ${strength.toFixed(3)});
        }`,
      );
  };
  mat.customProgramCacheKey = () => `macro${scale}${strength}`;
}

/** Emissive tinted by the surface colour (lit signs: one emissive map for all colours). */
function emissiveByColor(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= diffuseColor.rgb;');
  };
  mat.customProgramCacheKey = () => 'emisByColor';
}

export class AirportRenderer implements IAirportRenderer {
  readonly root = new THREE.Group();
  private readonly lights: LightField;
  private readonly bridges: JetBridges;
  private readonly wet: WetMat[] = [];
  private readonly windowMats: THREE.MeshStandardMaterial[] = [];
  private readonly signMat: THREE.MeshStandardMaterial;
  private readonly screenMat: THREE.MeshStandardMaterial;
  private readonly poolMat: THREE.MeshBasicMaterial;
  private readonly radars: THREE.Object3D[] = [];
  private readonly radarSpeed: number[] = [];
  private readonly socks: THREE.Object3D[] = [];
  private readonly sockCone: THREE.Mesh[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly shadowMeshes: THREE.Mesh[] = [];
  private readonly endIndex: Record<string, number>;
  private readonly runwayIndex: Record<string, number>;
  private windDir = 270;
  private windKt = 8;
  private first = true;
  private lastWet = -1;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly model: AirportModel,
    quality: QualityLevel,
  ) {
    this.root.name = `Airport_${model.def.icao}`;
    const seed = 1234;
    const aniso = 8;
    const rwyTex = makeAsphalt(1024, seed, true);
    const taxiTex = makeAsphalt(1024, seed + 1, false);
    const concTex = makeConcrete(1024, seed + 2);
    const macro = makeMacro(256, seed + 3);
    const atlas = makeAtlas(seed + 4);
    const rubber = makeRubber(seed + 5);
    const glassF = makeFacade('glass', seed + 6);
    const punchF = makeFacade('punched', seed + 7);
    const garageF = makeFacade('garage', seed + 8);
    const metal = makeMetal(seed + 9);
    const roofT = makeRoof(seed + 10);
    const poolT = makePool();
    const fenceT = makeFence();
    for (const t of [rwyTex.map, rwyTex.normal, rwyTex.rough, taxiTex.map, taxiTex.normal, taxiTex.rough, concTex.map, concTex.normal, concTex.rough, macro, atlas.texture, rubber, glassF.map, glassF.emissive, punchF.map, punchF.emissive, garageF.map, garageF.emissive, metal.map, metal.normal, roofT, poolT, fenceT]) {
      t.anisotropy = aniso;
      this.disposables.push(t);
    }

    const layout = buildLayout(model, atlas);
    const st = buildStructures(model);
    this.endIndex = layout.endIndex;
    this.runwayIndex = layout.runwayIndex;

    const add = (buf: GeoBuf, mat: THREE.Material, name: string, shadows: 'none' | 'receive' | 'both', order = 0): THREE.Mesh | null => {
      if (buf.count === 0) return null;
      const g = buf.toGeometry();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      m.receiveShadow = shadows !== 'none';
      m.castShadow = shadows === 'both';
      if (shadows === 'both') this.shadowMeshes.push(m);
      m.renderOrder = order;
      this.root.add(m);
      this.disposables.push(g, mat);
      return m;
    };
    const pave = (set: { map: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture }, color: string, rough: number, wetDark: number, macroScale: number): THREE.MeshStandardMaterial => {
      const mat = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normal,
        roughnessMap: set.rough,
        color,
        roughness: rough,
        metalness: 0,
        normalScale: new THREE.Vector2(0.6, 0.6),
      });
      addMacro(mat, macro, macroScale, 0.9);
      this.wet.push({ mat, rough, color: new THREE.Color(color), wetDark });
      return mat;
    };

    // ---- pavement
    add(layout.apron, pave(concTex, '#e2ded6', 0.95, 0.35, 0.043), 'Apron', 'receive');
    add(layout.taxi, pave(taxiTex, '#d8d4ce', 1.0, 0.45, 0.043), 'Taxiways', 'receive');
    add(layout.shoulder, pave(taxiTex, '#e6e2da', 1.0, 0.45, 0.043), 'Shoulders', 'receive');
    add(layout.runway, pave(rwyTex, '#cfcbc5', 1.0, 0.5, 0.043), 'Runways', 'receive');
    const rubberMat = new THREE.MeshStandardMaterial({ map: rubber, color: 0xffffff, roughness: 0.75, transparent: true, depthWrite: false, opacity: 1 });
    add(layout.rubber, rubberMat, 'TyreRubber', 'receive', 1);
    this.wet.push({ mat: rubberMat, rough: 0.75, color: new THREE.Color(0xffffff), wetDark: 0 });
    const markMat = new THREE.MeshStandardMaterial({ map: atlas.texture, vertexColors: true, roughness: 0.7, transparent: true, depthWrite: false, alphaTest: 0.02 });
    add(layout.marks, markMat, 'Markings', 'receive', 2);
    this.wet.push({ mat: markMat, rough: 0.7, color: new THREE.Color(0xffffff), wetDark: 0.15 });

    // ---- signs
    this.signMat = new THREE.MeshStandardMaterial({ map: atlas.texture, emissiveMap: atlas.texture, emissive: 0xffffff, emissiveIntensity: 0.2, vertexColors: true, roughness: 0.6, alphaTest: 0.5 });
    emissiveByColor(this.signMat);
    add(layout.signFaces, this.signMat, 'SignFaces', 'receive');
    add(layout.signBody, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }), 'SignBodies', 'both');

    // ---- buildings
    const facadeMat = (f: { map: THREE.Texture; emissive: THREE.Texture }, rough: number, metalness: number): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: rough, metalness });
      this.windowMats.push(m);
      return m;
    };
    add(st.glass, facadeMat(glassF, 0.15, 0.6), 'GlassFacades', 'both');
    add(st.punched, facadeMat(punchF, 0.75, 0), 'Offices', 'both');
    add(st.garage, facadeMat(garageF, 0.85, 0), 'Garages', 'both');
    add(st.metal, new THREE.MeshStandardMaterial({ map: metal.map, normalMap: metal.normal, vertexColors: true, roughness: 0.5, metalness: 0.45 }), 'MetalClad', 'both');
    add(st.roof, new THREE.MeshStandardMaterial({ map: roofT, vertexColors: true, roughness: 0.9 }), 'Roofs', 'both');
    add(st.plain, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 }), 'Structures', 'both');
    this.screenMat = new THREE.MeshStandardMaterial({ color: 0x05080c, emissive: 0x1c3450, emissiveIntensity: 0.1, roughness: 0.3 });
    add(st.screens, this.screenMat, 'TowerScreens', 'none');
    const towerGlass = new THREE.MeshPhysicalMaterial({ color: 0x6f8f9a, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.2 });
    add(st.towerGlass, towerGlass, 'TowerGlass', 'none', 5);
    const fenceMat = new THREE.MeshStandardMaterial({ map: fenceT, alphaTest: 0.35, color: 0xb8bcc0, roughness: 0.6, metalness: 0.6, side: THREE.DoubleSide });
    add(st.fence, fenceMat, 'Fence', 'none');
    this.poolMat = new THREE.MeshBasicMaterial({ map: poolT, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0, toneMapped: true });
    add(st.pools, this.poolMat, 'FloodPools', 'none', 3);

    // ---- radar antennas
    const antGeo = new THREE.BoxGeometry(9, 2.2, 0.6);
    antGeo.translate(0, 1.4, 0.4);
    const antMat = new THREE.MeshStandardMaterial({ color: 0xdadada, roughness: 0.5, metalness: 0.4 });
    this.disposables.push(antGeo, antMat);
    for (const r of st.radars) {
      const o = new THREE.Mesh(antGeo, antMat);
      o.position.copy(r.pos);
      o.castShadow = true;
      this.root.add(o);
      this.radars.push(o);
      this.radarSpeed.push(r.speed);
    }
    // ---- windsocks: cone pointing downwind, sagging in light wind
    const coneGeo = new THREE.CylinderGeometry(0.2, 0.45, 3.6, 12, 5, true);
    coneGeo.rotateX(Math.PI / 2);
    coneGeo.translate(0, 0, 1.8);
    const cCol: number[] = [];
    const pa = coneGeo.getAttribute('position');
    for (let i = 0; i < pa.count; i++) {
      const band = Math.floor((pa.getZ(i) / 3.6) * 5 - 1e-3);
      const c = band % 2 === 0 ? [0.9, 0.25, 0.05] : [0.95, 0.95, 0.95];
      cCol.push(c[0], c[1], c[2]);
    }
    coneGeo.setAttribute('color', new THREE.Float32BufferAttribute(cCol, 3));
    const coneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
    this.disposables.push(coneGeo, coneMat);
    for (const p of st.windsocks) {
      const pivot = new THREE.Object3D();
      pivot.position.copy(p);
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.castShadow = true;
      pivot.add(cone);
      this.root.add(pivot);
      this.socks.push(pivot);
      this.sockCone.push(cone);
    }

    // ---- jet bridges
    this.bridges = new JetBridges(model.gates, metal.map);
    this.root.add(this.bridges.group);
    this.disposables.push(this.bridges);

    // ---- lights
    this.lights = new LightField([...layout.lights, ...st.lights]);
    this.root.add(this.lights.mesh);
    this.disposables.push(this.lights);

    this.root.updateMatrixWorld(true);
    for (const c of this.root.children) if (c instanceof THREE.Mesh && !c.matrixAutoUpdate) c.updateMatrix();
    this.setQuality(quality);
    scene.add(this.root);
  }

  /** Wind for the windsocks (not part of the contract; direction wind blows FROM, degrees). */
  setWind(dirDeg: number, kt: number): void {
    this.windDir = dirDeg;
    this.windKt = kt;
  }

  /** Number of individual airfield lights (diagnostics). */
  get lightCount(): number {
    return this.lights.count;
  }

  update(u: AirportRenderUpdate): void {
    const n = Math.min(1, Math.max(0, u.nightFactor));
    const G = this.lights.groups;
    G.fill(0);
    const rwOn = 0.14 + 0.86 * n;
    for (const rw of this.model.runways) {
      const ri = this.runwayIndex[rw.id];
      const active = u.activeRunways.has(rw.id);
      G[G_RWY + ri] = active ? rwOn : rwOn * 0.22 * n;
      G[G_STOP + ri] = active ? 0.45 + 0.55 * n : 0;
      for (const e of rw.ends) {
        const ei = this.endIndex[e.name];
        const arr = u.arrivalEnds.has(e.name);
        G[G_APP + ei] = arr ? 0.35 + 0.65 * n : 0;
        G[G_PAPI + ei] = active ? 0.65 + 0.35 * n : 0;
      }
    }
    G[G_TAXI_EDGE] = 0.06 + 0.94 * n;
    G[G_TAXI_CL] = 0.06 + 0.94 * n;
    G[G_FLOOD] = smoothstep(0.25, 0.7, n);
    G[G_OBST] = 0.35 + 0.65 * n;
    G[G_BUILD] = smoothstep(0.2, 0.8, n);
    G[G_ALWAYS] = 1;
    const cam = u.camera as THREE.PerspectiveCamera;
    const fog = this.scene.fog instanceof THREE.FogExp2 ? this.scene.fog.density : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
    this.lights.update(u.simTime, cam, vh, fog);

    // Window glow ramps in at dusk; offices partly dark late at night is baked in the maps.
    const glow = smoothstep(0.1, 0.75, n);
    for (const m of this.windowMats) m.emissiveIntensity = glow * 1.8 + 0.02;
    this.signMat.emissiveIntensity = 0.15 + glow * 1.3;
    this.screenMat.emissiveIntensity = 0.12 - glow * 0.07;
    this.poolMat.opacity = smoothstep(0.25, 0.7, n) * 0.33;

    // Wet pavement: darker, much smoother (more specular reflection of sky and lights).
    const w = Math.min(1, Math.max(0, u.wetness));
    if (Math.abs(w - this.lastWet) > 0.005) {
      this.lastWet = w;
      for (const it of this.wet) {
        it.mat.roughness = it.rough * (1 - 0.72 * w);
        it.mat.color.copy(it.color).multiplyScalar(1 - it.wetDark * w);
        it.mat.envMapIntensity = 1 + w * 1.5;
      }
    }

    // Moving parts.
    for (let i = 0; i < this.radars.length; i++) this.radars[i].rotation.y = u.simTime * this.radarSpeed[i];
    const downwind = ((this.windDir + 180) * Math.PI) / 180;
    const lift = Math.min(1, this.windKt / 15);
    for (let i = 0; i < this.socks.length; i++) {
      const s = this.socks[i];
      const flutter = Math.sin(u.simTime * (2.3 + i) + i) * 0.06 * lift;
      // Pivot faces downwind: sim compass heading -> world rotation about y.
      s.rotation.set(0, 0, 0);
      s.rotation.y = Math.PI - downwind + flutter;
      this.sockCone[i].rotation.x = (1 - lift) * 1.15 + Math.sin(u.simTime * 3.1 + i) * 0.03;
      this.sockCone[i].scale.set(1, 1, 0.55 + 0.45 * lift);
    }

    if (this.first) {
      this.first = false;
      this.bridges.snap(u.occupiedGates);
    }
    this.bridges.update(u.dt, u.occupiedGates, glow);
  }

  setQuality(q: QualityLevel): void {
    const shadows = q !== 'low';
    for (const m of this.shadowMeshes) m.castShadow = shadows;
    this.lights.material.uniforms.uMinPx.value = q === 'low' ? 1.3 : 1.6;
  }

  dispose(): void {
    this.scene.remove(this.root);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

export const createAirportRenderer: CreateAirportRenderer = (scene, model, quality) => new AirportRenderer(scene, model, quality);
export default createAirportRenderer;
