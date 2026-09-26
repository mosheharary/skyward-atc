// Per-type aircraft asset: all geometry (articulated LOD0 parts, merged LOD1/LOD2), light positions, cockpit eye.
import * as THREE from 'three';
import { AIRCRAFT_TYPES } from '../../sim/aircraftTypes';
import type { AircraftTypeId } from '../../sim/types';
import { buildEngines, type EngineBuild } from './engines';
import { FuselageModel, buildApuCap, buildBellyFairing, buildFuselageSkin, buildRegistrationPatch, buildSponsons, buildWindowBand } from './fuselage';
import { buildGear, type LegT } from './gear';
import { merge } from './geom';
import { SHAPES, type ShapeDef, type WindowRow } from './shapes';
import { buildTail, buildWing, type FinInfo, type HingedPart, type WingModel } from './wing';

/** Window band: fraction of the band height covered by the window opening. */
export const WINDOW_TILE_FRAC = 0.62;

/** Material slots used by merged LOD meshes. */
export type Slot = 'body' | 'belly' | 'wing' | 'metal' | 'fin' | 'accent' | 'engine' | 'dark' | 'gearPaint' | 'chrome' | 'tire' | 'hub' | 'fan' | 'spinner';

export interface LightDef {
  kind: 'navR' | 'navG' | 'navW' | 'beacon' | 'strobe' | 'landing' | 'taxi';
  pos: THREE.Vector3;
  /** Beam direction (model space) for directional lights. */
  dir?: THREE.Vector3;
  size: number;
  /** Only when the gear is down (lights on the nose leg). */
  gear?: boolean;
  phase?: number;
}

export interface TypeAsset {
  id: AircraftTypeId;
  shape: ShapeDef;
  fm: FuselageModel;
  wm: WingModel;
  length: number;
  span: number;
  height: number;
  radius: number;
  // articulated parts
  skin: THREE.BufferGeometry;
  apu: THREE.BufferGeometry;
  fairing: THREE.BufferGeometry | null;
  windowBand: THREE.BufferGeometry | null;
  windowRow: WindowRow;
  reg: { geometry: THREE.BufferGeometry; aspect: number };
  wing: THREE.BufferGeometry;
  slats: THREE.BufferGeometry | null;
  slatTravel: THREE.Vector3;
  flaps: HingedPart[];
  spoilers: HingedPart[];
  winglets: THREE.BufferGeometry | null;
  fin: THREE.BufferGeometry;
  stab: THREE.BufferGeometry;
  finInfo: FinInfo;
  engines: EngineBuild;
  legs: LegT[];
  // merged LODs
  lod1: Partial<Record<Slot, THREE.BufferGeometry>>;
  /** LOD1 landing gear (extended), merged by slot. */
  lod1Gear: Partial<Record<Slot, THREE.BufferGeometry>>;
  lod2: Partial<Record<Slot, THREE.BufferGeometry>>;
  lights: LightDef[];
  cockpit: THREE.Vector3;
  /** Nose gear contact point (tug attachment). */
  noseGear: THREE.Vector3;
  landingLight: { pos: THREE.Vector3; dir: THREE.Vector3 }[];
  dispose(): void;
}

function mainGearSet(shape: ShapeDef) {
  return shape.gear.mains.find((m) => m.kind === 'wing') ?? shape.gear.mains[0];
}

export function cockpitOffset(typeId: AircraftTypeId): THREE.Vector3 {
  const shape = SHAPES[typeId];
  const fm = new FuselageModel(shape.fus);
  const d = fm.f.ntLen * 0.42;
  return new THREE.Vector3(-0.5 * Math.min(1, fm.R / 2), fm.topY(d) - 0.3 * fm.H, fm.zNose + d);
}

function place(g: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  return g.clone().applyMatrix4(m);
}

function add(map: Partial<Record<Slot, THREE.BufferGeometry[]>>, slot: Slot, g: THREE.BufferGeometry | null | undefined): void {
  if (!g || !g.getAttribute('position') || g.getAttribute('position').count === 0) return;
  (map[slot] ??= []).push(g);
}

function mergeSlots(map: Partial<Record<Slot, THREE.BufferGeometry[]>>): Partial<Record<Slot, THREE.BufferGeometry>> {
  const out: Partial<Record<Slot, THREE.BufferGeometry>> = {};
  for (const k of Object.keys(map) as Slot[]) {
    const list = map[k] ?? [];
    // merge() returns its input when given a single geometry; clone so LOD meshes never alias LOD0 geometry.
    out[k] = list.length === 1 ? list[0].clone() : merge(list);
    out[k]!.computeBoundingSphere();
  }
  return out;
}

const T = new THREE.Matrix4();
const Tr = (v: THREE.Vector3) => T.clone().makeTranslation(v.x, v.y, v.z);

export function buildTypeAsset(id: AircraftTypeId): TypeAsset {
  const shape = SHAPES[id];
  const def = AIRCRAFT_TYPES[id];
  const fm = new FuselageModel(shape.fus);
  const mg = mainGearSet(shape);
  const wb = buildWing(shape, fm, def.span, mg.x, mg.z);
  const wm = wb.model;
  const tail = buildTail(shape, fm, def.height);
  const engines = buildEngines(shape, fm, wm);
  const legs = buildGear(shape, fm, wm);
  const skin = buildFuselageSkin(fm, 40);
  const apu = buildApuCap(fm);
  let fairing: THREE.BufferGeometry | null = null;
  if (shape.wing.high) {
    fairing = buildSponsons(fm, mg.z - 2.3, mg.z + 2.1);
  } else {
    const c = shape.wing.rootChord;
    fairing = buildBellyFairing(fm, wm.zr - c * 0.25, wm.zr + c * 1.2);
  }
  const main = shape.windows.find((w) => w.deck === 'main') ?? shape.windows[0];
  const windowBand = buildWindowBand(fm, shape.windows, shape.doors, WINDOW_TILE_FRAC);
  const reg = buildRegistrationPatch(fm, main.theta);

  // ------------------------------------------------------------- LOD1
  const l1: Partial<Record<Slot, THREE.BufferGeometry[]>> = {};
  add(l1, 'body', skin.clone());
  add(l1, 'belly', fairing?.clone());
  add(l1, 'dark', apu.clone());
  add(l1, 'wing', wb.wing.clone());
  for (const p of [...wb.flaps, ...wb.spoilers]) add(l1, 'wing', place(p.geometry, Tr(p.pivot)));
  add(l1, 'metal', wb.slats?.clone());
  add(l1, 'accent', wb.winglets?.clone());
  add(l1, 'fin', tail.fin.clone());
  add(l1, 'wing', tail.stab.clone());
  add(l1, 'engine', engines.paint.clone());
  add(l1, 'engine', engines.sleeve?.clone());
  add(l1, 'metal', engines.lip?.clone());
  add(l1, 'dark', engines.inlet?.clone());
  add(l1, 'dark', engines.dark.clone());
  add(l1, 'wing', engines.pylons.clone());
  for (const f of engines.fans) {
    add(l1, 'fan', place(f.blades, Tr(f.center)));
    add(l1, 'spinner', place(f.spinner, Tr(f.center)));
  }
  for (const p of engines.props) {
    add(l1, 'fan', place(p.blades, Tr(p.center)));
    add(l1, 'spinner', place(p.spinner, Tr(p.center)));
  }
  const g1: Partial<Record<Slot, THREE.BufferGeometry[]>> = {};
  for (const leg of legs) {
    const m = Tr(leg.pivot);
    add(g1, 'gearPaint', place(leg.paint, m));
    add(g1, 'gearPaint', leg.steerPaint ? place(leg.steerPaint, m) : null);
    add(g1, 'chrome', place(leg.chrome, m));
    add(g1, 'chrome', leg.steerChrome ? place(leg.steerChrome, m) : null);
    for (const a of leg.axles) {
      const ma = Tr(leg.pivot.clone().add(a.center));
      add(g1, 'tire', place(a.tires, ma));
      add(g1, 'hub', place(a.hubs, ma));
    }
  }

  // ------------------------------------------------------------- LOD2 (far): few draw calls, low-res fuselage
  const l2: Partial<Record<Slot, THREE.BufferGeometry[]>> = {};
  const lowSkin = buildFuselageSkin(fm, 10);
  add(l2, 'body', lowSkin);
  add(l2, 'wing', wb.wing.clone());
  add(l2, 'wing', tail.stab.clone());
  add(l2, 'wing', engines.pylons.clone());
  add(l2, 'wing', wb.winglets?.clone());
  add(l2, 'fin', tail.fin.clone());
  add(l2, 'engine', engines.paint.clone());
  add(l2, 'engine', engines.sleeve?.clone());
  add(l2, 'engine', engines.dark.clone());

  // ------------------------------------------------------------- lights
  const lights: LightDef[] = [];
  const b = wm.b;
  const tipZ = wm.leZ(b) + wm.chord(b) * 0.35;
  const tipY = wm.y(b);
  const sz = Math.max(0.5, def.span / 60);
  for (const side of [1, -1]) {
    lights.push({ kind: side > 0 ? 'navG' : 'navR', pos: new THREE.Vector3(side * (b + 0.05), tipY, tipZ - 0.15), size: 1.5 * sz });
    lights.push({ kind: 'strobe', pos: new THREE.Vector3(side * (b + 0.1), tipY, tipZ + 0.35), size: 1.3 * sz, phase: 0 });
  }
  const tailY = fm.f.centerY + fm.f.tailTipY * fm.H;
  lights.push({ kind: 'navW', pos: new THREE.Vector3(0, tailY, fm.zTail + 0.1), size: 1.2 * sz });
  lights.push({ kind: 'strobe', pos: new THREE.Vector3(0, tailY + 0.1, fm.zTail + 0.15), size: 1.1 * sz, phase: 0.08 });
  const dBeacon = fm.dAtZ(wm.zr + shape.wing.rootChord * 0.5);
  lights.push({ kind: 'beacon', pos: new THREE.Vector3(0, fm.topY(dBeacon) + 0.12, fm.zNose + dBeacon), size: 1.1 * sz, phase: 0 });
  lights.push({ kind: 'beacon', pos: new THREE.Vector3(0, fm.bottomY(dBeacon) - 0.1, fm.zNose + dBeacon + 1.5), size: 1.1 * sz, phase: 0.5 });
  // landing lights: wing root leading edge
  const landingLight: { pos: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  const xl = Math.min(wm.xk, wm.x0 + fm.R * 0.9);
  const ldir = new THREE.Vector3(0, -0.06, -1).normalize();
  for (const side of [1, -1]) {
    const p = new THREE.Vector3(side * xl, wm.y(xl) - 0.05, wm.leZ(xl) - 0.05);
    lights.push({ kind: 'landing', pos: p, dir: ldir, size: 1.6 * sz });
    landingLight.push({ pos: p, dir: ldir });
  }
  const nose = legs[0];
  const noseGear = new THREE.Vector3(0, 0, nose.pivot.z);
  lights.push({ kind: 'taxi', pos: new THREE.Vector3(0, nose.pivot.y - nose.legLength * 0.35, nose.pivot.z - 0.25), dir: new THREE.Vector3(0, -0.1, -1).normalize(), size: 1.2 * sz, gear: true });

  const disposables: THREE.BufferGeometry[] = [];
  const asset: TypeAsset = {
    id,
    shape,
    fm,
    wm,
    length: def.length,
    span: def.span,
    height: def.height,
    radius: Math.max(def.length, def.span) * 0.55,
    skin,
    apu,
    fairing,
    windowBand,
    windowRow: main,
    reg,
    wing: wb.wing,
    slats: wb.slats,
    slatTravel: wb.slatTravel,
    flaps: wb.flaps,
    spoilers: wb.spoilers,
    winglets: wb.winglets,
    fin: tail.fin,
    stab: tail.stab,
    finInfo: tail.finInfo,
    engines,
    legs,
    lod1: mergeSlots(l1),
    lod1Gear: mergeSlots(g1),
    lod2: mergeSlots(l2),
    lights,
    cockpit: cockpitOffset(id),
    noseGear,
    landingLight,
    dispose() {
      for (const g of disposables) g.dispose();
    },
  };
  // Collect everything for disposal.
  const push = (g: THREE.BufferGeometry | null | undefined) => {
    if (g) disposables.push(g);
  };
  [skin, apu, fairing, windowBand, reg.geometry, wb.wing, wb.slats, wb.winglets, tail.fin, tail.stab].forEach(push);
  [...wb.flaps, ...wb.spoilers].forEach((p) => push(p.geometry));
  [engines.paint, engines.sleeve, engines.lip, engines.inlet, engines.dark, engines.pylons].forEach(push);
  engines.fans.forEach((f) => [f.blades, f.spinner].forEach(push));
  engines.props.forEach((p) => [p.blades, p.spinner, p.blur].forEach(push));
  for (const leg of legs) {
    [leg.paint, leg.chrome, leg.steerPaint, leg.steerChrome].forEach(push);
    leg.axles.forEach((a) => [a.tires, a.hubs].forEach(push));
  }
  for (const m of [asset.lod1, asset.lod1Gear, asset.lod2]) Object.values(m).forEach(push);
  // Bounding spheres for frustum culling of articulated parts.
  for (const g of disposables) if (!g.boundingSphere) g.computeBoundingSphere();
  return asset;
}
