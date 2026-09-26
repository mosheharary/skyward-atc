// Contracts between the game shell and the rendering sub-systems.
// Renderer setup (owned by src/render/Renderer.ts):
//   new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' })
//   renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = SRGBColorSpace;
//   renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFShadowMap;
//   Post: EffectComposer(HalfFloat, MSAA 4) -> RenderPass -> UnrealBloomPass (threshold ~1.0 linear HDR) -> OutputPass.
//   => Anything that should glow must output linear HDR colour > 1.0 (emissive * intensity).
//   => Any custom ShaderMaterial MUST include the logdepthbuf chunks (and fog chunks if it should be fogged).
// World axes: X east, Y up (m above field elevation), Z south. Sim (x, y, altFt) -> (x, (altFt - elev) * FT, -y).

import type * as THREE from 'three';
import type { AirportDef } from '../sim/airports/types';
import type { AircraftRenderState, AircraftTypeId, QualityLevel, WeatherState } from '../sim/types';

export interface EnvironmentOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  airport: AirportDef;
  quality: QualityLevel;
}

export interface EnvironmentUpdate {
  /** Real seconds since the previous frame (animation). */
  dt: number;
  /** Monotonic simulation seconds (lightning timing, cloud drift). */
  simTime: number;
  /** Local time of day, seconds since local midnight (0..86400). */
  timeOfDay: number;
  /** 1..365 */
  dayOfYear: number;
  weather: WeatherState;
  camera: THREE.PerspectiveCamera;
  /** World point the player is looking at; the sun shadow frustum is fitted around it. */
  focus: THREE.Vector3;
  /** Radius (m) around `focus` that needs crisp shadows. */
  shadowRadius: number;
}

export interface IEnvironment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Normalised world direction pointing towards the sun (may be below the horizon). */
  readonly sunDirection: THREE.Vector3;
  /** 0 = full daylight .. 1 = full night. Drives artificial lights (runway lights, windows...). */
  readonly nightFactor: number;
  /** 0 = dry .. 1 = soaked. Ground / runway materials use it for a wet look. */
  readonly wetness: number;
  update(u: EnvironmentUpdate): void;
  /** Terrain height (world Y) at world (x, z). Exactly 0 inside the airport flat zone. */
  heightAt(x: number, z: number): number;
  setQuality(q: QualityLevel): void;
  dispose(): void;
}

/** Implemented in src/render/environment/index.ts */
export type CreateEnvironment = (opts: EnvironmentOptions) => IEnvironment;

export interface AircraftRenderContext {
  dt: number;
  simTime: number;
  camera: THREE.PerspectiveCamera;
  nightFactor: number;
  fieldElevationFt: number;
  quality: QualityLevel;
}

export interface IAircraftRenderer {
  /** Create / update / remove visuals so they match the given list (keyed by id). */
  update(aircraft: readonly AircraftRenderState[], ctx: AircraftRenderContext): void;
  /** Root object of an aircraft's visual (for camera follow), or undefined. */
  getObject(id: string): THREE.Object3D | undefined;
  /** Pilot eye point in model-local coordinates (nose towards -Z, origin at ground under main gear). */
  getCockpitOffset(typeId: AircraftTypeId): THREE.Vector3;
  setSelected(id: string | null): void;
  setQuality(q: QualityLevel): void;
  dispose(): void;
}

/** Implemented in src/render/aircraft/index.ts */
export type CreateAircraftRenderer = (scene: THREE.Scene, quality: QualityLevel) => IAircraftRenderer;

export interface AirportRenderUpdate {
  dt: number;
  simTime: number;
  camera: THREE.PerspectiveCamera;
  /** 0 day .. 1 night: runway / taxiway / apron / building lights ramp up with it. */
  nightFactor: number;
  /** 0 dry .. 1 wet (reflective pavement). */
  wetness: number;
  /** Runway ids in use (their edge/centreline/approach lights are on; unused runways dim). */
  activeRunways: ReadonlySet<string>;
  /** Runway end names with an arrival flow (approach lights + PAPI lit). */
  arrivalEnds: ReadonlySet<string>;
  /** Gate ids currently occupied (jet bridge extended, docking guidance lit). */
  occupiedGates: ReadonlySet<string>;
}

export interface IAirportRenderer {
  readonly root: THREE.Object3D;
  update(u: AirportRenderUpdate): void;
  setQuality(q: QualityLevel): void;
  dispose(): void;
}

/** Implemented in src/render/airport/index.ts. `model` is a src/sim/airportModel.ts AirportModel. */
export type CreateAirportRenderer = (scene: THREE.Scene, model: import('../sim/airportModel').AirportModel, quality: QualityLevel) => IAirportRenderer;
