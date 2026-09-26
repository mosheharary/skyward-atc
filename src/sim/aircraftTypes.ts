import type { AircraftTypeId, EngineKind, SizeClass, WakeCat } from './types';

export interface AircraftTypeDef {
  id: AircraftTypeId;
  /** Designator shown on strips / data blocks. */
  icao: string;
  /** Generic class label (fictionalised, no manufacturer names in UI). */
  label: string;
  wake: WakeCat;
  engine: EngineKind;
  engines: 2 | 4;
  /** Rear fuselage-mounted engines (T-tail jets). */
  rearEngines: boolean;
  highWing: boolean;
  tTail: boolean;
  /** Dimensions in meters. */
  length: number;
  span: number;
  height: number;
  fuselageDiameter: number;
  size: SizeClass;
  /** Speeds in knots (IAS). */
  vr: number;
  vapp: number;
  vminClean: number;
  vmax: number;
  /** Feet per minute. */
  climbFpm: number;
  descentFpm: number;
  /** Airborne acceleration / deceleration, knots per second. */
  accelKt: number;
  decelKt: number;
  /** Ground roll, m/s². */
  takeoffAccel: number;
  landingDecel: number;
  taxiKt: number;
  ceilingFt: number;
  /** Passenger seats (display only). */
  seats: number;
}

export const AIRCRAFT_TYPES: Record<AircraftTypeId, AircraftTypeDef> = {
  A320: {
    id: 'A320', icao: 'A320', label: 'Narrow-body twinjet', wake: 'M', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 37.6, span: 35.8, height: 11.8, fuselageDiameter: 3.95, size: 'M',
    vr: 145, vapp: 136, vminClean: 210, vmax: 330, climbFpm: 2600, descentFpm: 2200,
    accelKt: 1.8, decelKt: 1.3, takeoffAccel: 2.1, landingDecel: 2.4, taxiKt: 18, ceilingFt: 39000, seats: 180,
  },
  A321: {
    id: 'A321', icao: 'A321', label: 'Stretched narrow-body twinjet', wake: 'M', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 44.5, span: 35.8, height: 11.8, fuselageDiameter: 3.95, size: 'M',
    vr: 150, vapp: 142, vminClean: 215, vmax: 330, climbFpm: 2300, descentFpm: 2200,
    accelKt: 1.6, decelKt: 1.2, takeoffAccel: 1.9, landingDecel: 2.3, taxiKt: 18, ceilingFt: 39000, seats: 220,
  },
  B738: {
    id: 'B738', icao: 'B738', label: 'Narrow-body twinjet', wake: 'M', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 39.5, span: 35.8, height: 12.5, fuselageDiameter: 3.76, size: 'M',
    vr: 150, vapp: 144, vminClean: 215, vmax: 330, climbFpm: 2500, descentFpm: 2300,
    accelKt: 1.7, decelKt: 1.3, takeoffAccel: 2.0, landingDecel: 2.4, taxiKt: 18, ceilingFt: 41000, seats: 189,
  },
  E175: {
    id: 'E175', icao: 'E75L', label: 'Regional twinjet', wake: 'M', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 31.7, span: 26.0, height: 9.9, fuselageDiameter: 3.01, size: 'S',
    vr: 135, vapp: 128, vminClean: 200, vmax: 310, climbFpm: 2800, descentFpm: 2200,
    accelKt: 1.9, decelKt: 1.4, takeoffAccel: 2.2, landingDecel: 2.5, taxiKt: 18, ceilingFt: 41000, seats: 76,
  },
  CRJ9: {
    id: 'CRJ9', icao: 'CRJ9', label: 'Regional rear-engine jet', wake: 'M', engine: 'turbofan', engines: 2,
    rearEngines: true, highWing: false, tTail: true,
    length: 36.2, span: 24.9, height: 7.5, fuselageDiameter: 2.69, size: 'S',
    vr: 140, vapp: 138, vminClean: 205, vmax: 320, climbFpm: 2900, descentFpm: 2300,
    accelKt: 1.9, decelKt: 1.4, takeoffAccel: 2.1, landingDecel: 2.3, taxiKt: 18, ceilingFt: 41000, seats: 90,
  },
  AT76: {
    id: 'AT76', icao: 'AT76', label: 'Regional turboprop', wake: 'M', engine: 'turboprop', engines: 2,
    rearEngines: false, highWing: true, tTail: true,
    length: 27.2, span: 27.1, height: 7.7, fuselageDiameter: 2.57, size: 'S',
    vr: 110, vapp: 110, vminClean: 170, vmax: 250, climbFpm: 1600, descentFpm: 1600,
    accelKt: 1.4, decelKt: 1.2, takeoffAccel: 1.8, landingDecel: 2.2, taxiKt: 15, ceilingFt: 25000, seats: 70,
  },
  B789: {
    id: 'B789', icao: 'B789', label: 'Wide-body twinjet', wake: 'H', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 62.8, span: 60.1, height: 17.0, fuselageDiameter: 5.77, size: 'L',
    vr: 155, vapp: 146, vminClean: 220, vmax: 340, climbFpm: 2300, descentFpm: 2100,
    accelKt: 1.5, decelKt: 1.1, takeoffAccel: 1.8, landingDecel: 2.2, taxiKt: 17, ceilingFt: 43000, seats: 290,
  },
  A359: {
    id: 'A359', icao: 'A359', label: 'Wide-body twinjet', wake: 'H', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 66.8, span: 64.75, height: 17.1, fuselageDiameter: 5.96, size: 'L',
    vr: 150, vapp: 141, vminClean: 215, vmax: 340, climbFpm: 2200, descentFpm: 2100,
    accelKt: 1.5, decelKt: 1.1, takeoffAccel: 1.8, landingDecel: 2.2, taxiKt: 17, ceilingFt: 43000, seats: 315,
  },
  B77W: {
    id: 'B77W', icao: 'B77W', label: 'Long-range wide-body twinjet', wake: 'H', engine: 'turbofan', engines: 2,
    rearEngines: false, highWing: false, tTail: false,
    length: 73.9, span: 64.8, height: 18.5, fuselageDiameter: 6.2, size: 'L',
    vr: 165, vapp: 152, vminClean: 225, vmax: 340, climbFpm: 2000, descentFpm: 2000,
    accelKt: 1.3, decelKt: 1.0, takeoffAccel: 1.7, landingDecel: 2.1, taxiKt: 16, ceilingFt: 43000, seats: 365,
  },
  B748: {
    id: 'B748', icao: 'B748', label: 'Four-engine jumbo', wake: 'H', engine: 'turbofan', engines: 4,
    rearEngines: false, highWing: false, tTail: false,
    length: 76.3, span: 68.4, height: 19.4, fuselageDiameter: 6.5, size: 'H',
    vr: 165, vapp: 156, vminClean: 230, vmax: 350, climbFpm: 1800, descentFpm: 2000,
    accelKt: 1.2, decelKt: 1.0, takeoffAccel: 1.6, landingDecel: 2.0, taxiKt: 16, ceilingFt: 43000, seats: 410,
  },
  A388: {
    id: 'A388', icao: 'A388', label: 'Double-deck super jumbo', wake: 'J', engine: 'turbofan', engines: 4,
    rearEngines: false, highWing: false, tTail: false,
    length: 72.7, span: 79.8, height: 24.1, fuselageDiameter: 7.14, size: 'H',
    vr: 150, vapp: 140, vminClean: 220, vmax: 340, climbFpm: 1700, descentFpm: 1900,
    accelKt: 1.1, decelKt: 0.9, takeoffAccel: 1.5, landingDecel: 2.0, taxiKt: 15, ceilingFt: 43000, seats: 525,
  },
  C56X: {
    id: 'C56X', icao: 'C56X', label: 'Business jet', wake: 'L', engine: 'turbofan', engines: 2,
    rearEngines: true, highWing: false, tTail: true,
    length: 16.0, span: 17.2, height: 5.2, fuselageDiameter: 1.7, size: 'S',
    vr: 112, vapp: 115, vminClean: 180, vmax: 300, climbFpm: 3500, descentFpm: 2500,
    accelKt: 2.2, decelKt: 1.6, takeoffAccel: 2.4, landingDecel: 2.6, taxiKt: 18, ceilingFt: 45000, seats: 9,
  },
};

export const WAKE_LABEL: Record<WakeCat, string> = { L: 'Light', M: 'Medium', H: 'Heavy', J: 'Super' };

/** ICAO-style wake separation minima on final (NM), leader -> follower. Missing pair = no wake minimum. */
export const WAKE_SEP_NM: Record<WakeCat, Partial<Record<WakeCat, number>>> = {
  J: { J: 4, H: 6, M: 7, L: 8 },
  H: { H: 4, M: 5, L: 6 },
  M: { L: 5 },
  L: {},
};

/** Departure wake interval (seconds) on the same runway, leader -> follower. */
export const WAKE_DEP_SEC: Record<WakeCat, Partial<Record<WakeCat, number>>> = {
  J: { H: 120, M: 180, L: 180 },
  H: { M: 120, L: 120 },
  M: { L: 120 },
  L: {},
};

const SIZE_ORDER: Record<SizeClass, number> = { S: 0, M: 1, L: 2, H: 3 };

export function gateFits(gate: SizeClass, ac: SizeClass): boolean {
  return SIZE_ORDER[ac] <= SIZE_ORDER[gate];
}
