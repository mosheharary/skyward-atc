import type { SizeClass } from '../types';

/** [x east (m), y north (m)] relative to the airport reference point. */
export type Vec2 = [number, number];

export type ApproachLights = 'full' | 'simple' | 'none';

export interface RunwayEndDef {
  /** Designator, e.g. '27L'. */
  name: string;
  /** ILS available when landing on this end. */
  ils: boolean;
  approachLights: ApproachLights;
  papi: boolean;
}

export interface RunwayDef {
  /** Threshold of ends[0]. Aircraft landing on ends[0] touch down near `a` and roll towards `b`. */
  a: Vec2;
  /** Threshold of ends[1]. */
  b: Vec2;
  width: number;
  ends: [RunwayEndDef, RunwayEndDef];
}

export type TaxiKind = 'taxiway' | 'taxilane' | 'rapid';

export interface TaxiwayDef {
  name: string;
  points: Vec2[];
  width?: number;
  kind?: TaxiKind;
}

export interface ApronDef {
  name: string;
  polygon: Vec2[];
}

export interface GateDef {
  id: string;
  /** Nose stop position of a parked aircraft (the aircraft reference point is behind it). */
  pos: Vec2;
  /** Nose heading of a parked aircraft (degrees true). */
  hdg: number;
  size: SizeClass;
  jetBridge: boolean;
}

export type BuildingKind =
  | 'terminal'
  | 'pier'
  | 'hangar'
  | 'cargo'
  | 'office'
  | 'garage'
  | 'firestation'
  | 'fuel'
  | 'radar'
  | 'hotel'
  | 'maintenance'
  | 'tower';

export interface BuildingDef {
  kind: BuildingKind;
  pos: Vec2;
  /** Size along the building's long axis (m). */
  w: number;
  /** Depth (m). */
  d: number;
  /** Height (m). */
  h: number;
  /** Compass direction of the long (w) axis, degrees. */
  axis: number;
  name?: string;
}

export type FixRole = 'entry' | 'iaf' | 'if' | 'exit' | 'wpt';

export interface FixDef {
  id: string;
  pos: Vec2;
  role: FixRole;
}

/** Where arrivals enter the airspace. */
export interface ArrivalGateDef {
  fix: string;
  /** Typical entry altitude (ft MSL). */
  altitude: number;
  /** Default route after the entry fix (fix ids); the aircraft holds at the last fix if not vectored. */
  route: string[];
}

/** Where departures leave the airspace. */
export interface DepartureExitDef {
  fix: string;
  /** Minimum altitude when crossing the boundary (ft MSL). */
  minAltitude: number;
}

export interface RunwayConfigDef {
  id: string;
  label: string;
  /** Runway end names used for arrivals / departures. */
  arrivals: string[];
  departures: string[];
  /** Preferred when wind blows from within +/-90 deg of this direction. */
  windFrom: number;
}

export interface CityDef {
  pos: Vec2;
  radius: number;
  /** 0..1 */
  density: number;
  maxHeight: number;
  /** Number of tall towers in the core. */
  skyscrapers: number;
}

export interface HillDef {
  pos: Vec2;
  radius: number;
  height: number;
}

export interface ForestDef {
  pos: Vec2;
  radius: number;
  /** 0..1 */
  density: number;
}

export type GroundPalette = 'temperate' | 'mediterranean' | 'coastal' | 'arid';

export interface SceneryDef {
  /** Water polygons (sea / bay), sim coords (m). Everything else is land. */
  water: Vec2[][];
  /** Terrain is exactly flat (world Y = 0) inside this polygon. */
  flatZone: Vec2[];
  /** Distance (m) over which terrain blends from flat to natural outside flatZone. */
  flatBlend: number;
  hills: HillDef[];
  /** 0..1 amplitude of small-scale undulation. */
  roughness: number;
  ground: GroundPalette;
  cities: CityDef[];
  forests: ForestDef[];
  /** Major highways (polylines, sim coords). Optional visual detail. */
  roads: Vec2[][];
}

export interface AirportDef {
  id: string;
  icao: string;
  name: string;
  city: string;
  description: string;
  elevationFt: number;
  /** Degrees; used for the sun position. */
  latitude: number;
  longitude: number;
  /** Local time = UTC + offset (hours). */
  utcOffset: number;
  /** Tower cab eye position. */
  tower: { pos: Vec2; eyeHeight: number; lookAt: Vec2 };
  runways: RunwayDef[];
  taxiways: TaxiwayDef[];
  aprons: ApronDef[];
  gates: GateDef[];
  buildings: BuildingDef[];
  fixes: FixDef[];
  arrivalGates: ArrivalGateDef[];
  departureExits: DepartureExitDef[];
  /** Controlled airspace radius (NM) and ceiling (ft). */
  airspace: { radiusNm: number; ceilingFt: number };
  /** Missed approach / go-around altitude (ft MSL). */
  missedApproachAlt: number;
  /** Default initial climb altitude for departures (ft MSL). */
  initialClimb: number;
  /** Minimum vectoring altitude (ft MSL) outside the final approach. */
  mva: number;
  runwayConfigs: RunwayConfigDef[];
  scenery: SceneryDef;
}
