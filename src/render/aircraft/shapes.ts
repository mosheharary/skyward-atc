// Visual shape parameters for every aircraft type. Dimensions in meters.
// Model space: nose towards -Z, right wing +X, up +Y, origin on the ground under the main gear.
import type { AircraftTypeId } from '../../sim/types';

export type CockpitStyle = 'airbus' | 'boeing' | 'b787' | 'a350' | 'regional' | 'atr' | 'bizjet' | 'b747' | 'a380';
export type TipStyle = 'sharklet' | 'blended' | 'raked' | 'curved' | 'fence' | 'small' | 'none';

export interface FuselageDef {
  length: number;
  /** Half width of the constant section. */
  radius: number;
  /** Half height / half width of the constant section. */
  hr: number;
  /** Height of the fuselage centre line above the ground (gear down). */
  centerY: number;
  /** Superellipse exponent of the cross-section (2 = ellipse). */
  nExp: number;
  /** Nose tip vertical offset, fraction of the half height (negative = below centre line). */
  noseTipY: number;
  /** Distances from the nose tip at which the top / bottom / width reach the full section. */
  ntLen: number;
  nbLen: number;
  nwLen: number;
  /** Nose curve exponents (0.5 = elliptic; larger = pointier). */
  pt: number;
  pb: number;
  pw: number;
  tailLen: number;
  /** Tail tip centre height (fraction of half height) and radius (fraction of radius). */
  tailTipY: number;
  tailTipR: number;
  /** Distance from the nose tip to the main gear (model origin). */
  mainGearFromNose: number;
  hump?: { start: number; full: number; end: number; tail: number; height: number };
}

export interface WingDef {
  rootChord: number;
  kinkChord: number;
  tipChord: number;
  /** Kink position as fraction of the semi-span. */
  kinkFrac: number;
  /** Leading-edge sweep (deg). */
  sweep: number;
  dihedral: number;
  tcRoot: number;
  tcTip: number;
  high: boolean;
  /** Main gear sits at this fraction of the local chord (from LE). */
  gearChordFrac: number;
  tip: TipStyle;
  wingletH: number;
  slats: boolean;
  flapTracks: number;
  /** Flaps end / ailerons start at this fraction of the semi-span. */
  aileronFrac: number;
  /** Raked tip: begins at this fraction of the semi-span with this LE sweep. */
  rakeFrac?: number;
  rakeSweep?: number;
}

export interface TailDef {
  finRootChord: number;
  finTipChord: number;
  finSweep: number;
  /** Distance of the fin root trailing edge ahead of the tail tip. */
  finTEOffset: number;
  dorsal: boolean;
  stabSpan: number;
  stabRootChord: number;
  stabTipChord: number;
  stabSweep: number;
  stabDihedral: number;
  /** Conventional tail: distance from the tail tip to the stabiliser root leading edge. */
  stabFromTail: number;
  tTail: boolean;
}

export interface EngineDef {
  kind: 'fan' | 'prop';
  mount: 'wing' | 'rear';
  /** Wing mount: spanwise positions as fraction of the semi-span (per side). */
  spanFracs: number[];
  length: number;
  radius: number;
  fanRadius: number;
  chevrons: boolean;
  flatBottom: boolean;
  /** Wing mount: fraction of the nacelle length ahead of the wing leading edge. */
  forward: number;
  /** Wing mount: gap between the wing lower surface and the nacelle top (negative = tucked into the wing). */
  drop: number;
  blades: number;
  propRadius?: number;
  /** Rear mount: distance from the nose tip to the nacelle front, vertical offset from the centre line. */
  rearFront?: number;
  rearYOff?: number;
}

export interface WheelSet {
  kind: 'nose' | 'wing' | 'body';
  /** Lateral position of the leg (0 for nose). Mirrored for left/right. */
  x: number;
  z: number;
  r: number;
  axles: number;
  wheels: 1 | 2;
  /** Distance between axles (bogie). */
  axleSpacing: number;
  /** Distance between the two wheels of an axle. */
  wheelSpacing: number;
}

export interface GearDef {
  nose: WheelSet;
  mains: WheelSet[];
}

export interface WindowRow {
  deck: 'main' | 'upper';
  /** Cross-section angle of the window centre line (deg, 0 = widest line, 90 = crown). */
  theta: number;
  from: number;
  to: number;
  pitch: number;
  w: number;
  h: number;
}

export interface DoorDef {
  s: number;
  deck: 'main' | 'upper';
  kind: 'door' | 'exit' | 'cargo';
  w: number;
  h: number;
}

export interface ShapeDef {
  id: AircraftTypeId;
  fus: FuselageDef;
  wing: WingDef;
  tail: TailDef;
  engine: EngineDef;
  gear: GearDef;
  windows: WindowRow[];
  doors: DoorDef[];
  cockpit: CockpitStyle;
  /** Painted fan spinner colour. */
  spinner: 'silver' | 'dark';
}

function fus(p: Omit<FuselageDef, 'hr' | 'nExp' | 'noseTipY' | 'pt' | 'pb' | 'pw' | 'tailTipY' | 'tailTipR'> & Partial<FuselageDef>): FuselageDef {
  return { hr: 1, nExp: 2, noseTipY: -0.22, pt: 0.52, pb: 0.5, pw: 0.5, tailTipY: 0.3, tailTipR: 0.09, ...p };
}

const door = (s: number, w = 0.82, h = 1.85, deck: 'main' | 'upper' = 'main'): DoorDef => ({ s, deck, kind: 'door', w, h });
const exit = (s: number, w = 0.52, h = 1.0, deck: 'main' | 'upper' = 'main'): DoorDef => ({ s, deck, kind: 'exit', w, h });
const cargo = (s: number, w = 1.8, h = 1.25): DoorDef => ({ s, deck: 'main', kind: 'cargo', w, h });

const A320_WING: WingDef = {
  rootChord: 6.4, kinkChord: 3.9, tipChord: 1.5, kinkFrac: 0.34, sweep: 27, dihedral: 5.1, tcRoot: 0.15, tcTip: 0.11,
  high: false, gearChordFrac: 0.72, tip: 'sharklet', wingletH: 2.4, slats: true, flapTracks: 3, aileronFrac: 0.77,
};
const A320_TAIL: TailDef = {
  finRootChord: 5.7, finTipChord: 1.9, finSweep: 34, finTEOffset: 0.7, dorsal: true,
  stabSpan: 12.45, stabRootChord: 3.6, stabTipChord: 1.3, stabSweep: 29, stabDihedral: 6, stabFromTail: 5.4, tTail: false,
};
const A320_ENGINE: EngineDef = {
  kind: 'fan', mount: 'wing', spanFracs: [0.32], length: 4.4, radius: 1.0, fanRadius: 0.82, chevrons: false, flatBottom: false,
  forward: 0.66, drop: -0.05, blades: 24,
};

export const SHAPES: Record<AircraftTypeId, ShapeDef> = {
  A320: {
    id: 'A320',
    fus: fus({ length: 37.6, radius: 1.975, hr: 1.05, centerY: 3.55, ntLen: 7.0, nbLen: 4.3, nwLen: 5.5, tailLen: 11.5, mainGearFromNose: 17.7 }),
    wing: A320_WING,
    tail: A320_TAIL,
    engine: A320_ENGINE,
    gear: {
      nose: { kind: 'nose', x: 0, z: -12.64, r: 0.37, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.52 },
      mains: [{ kind: 'wing', x: 3.8, z: 0, r: 0.58, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.93 }],
    },
    windows: [{ deck: 'main', theta: 7, from: 5.6, to: 31.6, pitch: 0.533, w: 0.23, h: 0.33 }],
    doors: [door(4.35), door(32.3), exit(15.85), exit(16.75), cargo(9.6), cargo(23.4)],
    cockpit: 'airbus',
    spinner: 'silver',
  },
  A321: {
    id: 'A321',
    fus: fus({ length: 44.5, radius: 1.975, hr: 1.05, centerY: 3.6, ntLen: 7.0, nbLen: 4.3, nwLen: 5.5, tailLen: 11.5, mainGearFromNose: 22.2 }),
    wing: { ...A320_WING, rootChord: 6.6 },
    tail: A320_TAIL,
    engine: { ...A320_ENGINE, radius: 1.03 },
    gear: {
      nose: { kind: 'nose', x: 0, z: -16.9, r: 0.37, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.52 },
      mains: [{ kind: 'wing', x: 3.8, z: 0, r: 0.6, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.93 }],
    },
    windows: [{ deck: 'main', theta: 7, from: 5.6, to: 38.9, pitch: 0.533, w: 0.23, h: 0.33 }],
    doors: [door(4.35), door(11.9), door(29.6), door(39.5), cargo(8.4), cargo(33.6)],
    cockpit: 'airbus',
    spinner: 'silver',
  },
  B738: {
    id: 'B738',
    fus: fus({
      length: 39.5, radius: 1.88, hr: 1.07, centerY: 3.05, noseTipY: -0.28, ntLen: 8.0, nbLen: 4.3, nwLen: 6.0, pt: 0.6, pw: 0.55,
      tailLen: 12.2, tailTipY: 0.25, tailTipR: 0.08, mainGearFromNose: 19.9,
    }),
    wing: {
      rootChord: 6.5, kinkChord: 4.0, tipChord: 1.3, kinkFrac: 0.3, sweep: 25, dihedral: 6, tcRoot: 0.14, tcTip: 0.11,
      high: false, gearChordFrac: 0.72, tip: 'blended', wingletH: 2.5, slats: true, flapTracks: 3, aileronFrac: 0.75,
    },
    tail: {
      finRootChord: 6.2, finTipChord: 2.0, finSweep: 35, finTEOffset: 0.8, dorsal: true,
      stabSpan: 14.35, stabRootChord: 3.9, stabTipChord: 1.3, stabSweep: 30, stabDihedral: 7, stabFromTail: 6.0, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.28], length: 4.3, radius: 1.0, fanRadius: 0.78, chevrons: false, flatBottom: true,
      forward: 0.76, drop: -0.45, blades: 24,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -15.6, r: 0.35, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.5 },
      mains: [{ kind: 'wing', x: 2.86, z: 0, r: 0.56, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.86 }],
    },
    windows: [{ deck: 'main', theta: 10, from: 5.5, to: 35.4, pitch: 0.508, w: 0.25, h: 0.36 }],
    doors: [door(4.3), door(36.1), exit(18.3), exit(19.25), cargo(9.1), cargo(26.8)],
    cockpit: 'boeing',
    spinner: 'silver',
  },
  E175: {
    id: 'E175',
    fus: fus({ length: 31.7, radius: 1.505, hr: 1.1, centerY: 2.85, noseTipY: -0.22, ntLen: 6.0, nbLen: 3.6, nwLen: 4.5, pt: 0.55, tailLen: 9.2, mainGearFromNose: 15.1 }),
    wing: {
      rootChord: 4.9, kinkChord: 3.0, tipChord: 1.15, kinkFrac: 0.34, sweep: 23, dihedral: 5, tcRoot: 0.14, tcTip: 0.1,
      high: false, gearChordFrac: 0.72, tip: 'blended', wingletH: 1.35, slats: true, flapTracks: 3, aileronFrac: 0.76,
    },
    tail: {
      finRootChord: 4.6, finTipChord: 1.9, finSweep: 38, finTEOffset: 0.6, dorsal: true,
      stabSpan: 10.0, stabRootChord: 2.8, stabTipChord: 1.0, stabSweep: 30, stabDihedral: 5, stabFromTail: 4.2, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.3], length: 3.3, radius: 0.78, fanRadius: 0.6, chevrons: false, flatBottom: false,
      forward: 0.62, drop: -0.05, blades: 24,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -11.4, r: 0.34, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.46 },
      mains: [{ kind: 'wing', x: 2.9, z: 0, r: 0.5, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.72 }],
    },
    windows: [{ deck: 'main', theta: 9, from: 4.9, to: 27.1, pitch: 0.51, w: 0.24, h: 0.34 }],
    doors: [door(3.7, 0.8, 1.8), door(28.0, 0.8, 1.8), exit(14.35), cargo(8.0, 1.2, 1.0), cargo(21.5, 1.2, 1.0)],
    cockpit: 'regional',
    spinner: 'silver',
  },
  CRJ9: {
    id: 'CRJ9',
    fus: fus({
      length: 36.2, radius: 1.345, hr: 1.0, centerY: 2.2, noseTipY: -0.22, ntLen: 5.4, nbLen: 3.2, nwLen: 4.1, pt: 0.62, pw: 0.56,
      tailLen: 8.2, tailTipY: 0.32, mainGearFromNose: 20.6,
    }),
    wing: {
      rootChord: 4.4, kinkChord: 2.8, tipChord: 1.0, kinkFrac: 0.32, sweep: 26, dihedral: 3, tcRoot: 0.13, tcTip: 0.1,
      high: false, gearChordFrac: 0.72, tip: 'blended', wingletH: 1.2, slats: true, flapTracks: 2, aileronFrac: 0.74,
    },
    tail: {
      finRootChord: 4.4, finTipChord: 2.8, finSweep: 45, finTEOffset: 0.3, dorsal: false,
      stabSpan: 8.5, stabRootChord: 2.4, stabTipChord: 1.3, stabSweep: 34, stabDihedral: -3, stabFromTail: 0, tTail: true,
    },
    engine: {
      kind: 'fan', mount: 'rear', spanFracs: [], length: 3.4, radius: 0.72, fanRadius: 0.56, chevrons: false, flatBottom: false,
      forward: 0, drop: 0, blades: 24, rearFront: 25.2, rearYOff: 0.5,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -17.3, r: 0.3, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.42 },
      mains: [{ kind: 'wing', x: 2.0, z: 0, r: 0.46, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.62 }],
    },
    windows: [{ deck: 'main', theta: 8, from: 4.3, to: 26.6, pitch: 0.51, w: 0.24, h: 0.3 }],
    doors: [door(3.1, 0.8, 1.7), door(27.2, 0.7, 1.4), exit(14.6), cargo(7.2, 1.0, 0.9), cargo(28.6, 1.0, 0.9)],
    cockpit: 'regional',
    spinner: 'silver',
  },
  AT76: {
    id: 'AT76',
    fus: fus({
      length: 27.2, radius: 1.285, hr: 1.05, centerY: 2.2, noseTipY: -0.12, ntLen: 4.4, nbLen: 3.0, nwLen: 3.5, pt: 0.55,
      tailLen: 8.8, tailTipY: 0.45, tailTipR: 0.07, mainGearFromNose: 14.0,
    }),
    wing: {
      rootChord: 2.6, kinkChord: 2.35, tipChord: 1.4, kinkFrac: 0.4, sweep: 3, dihedral: 0, tcRoot: 0.18, tcTip: 0.13,
      high: true, gearChordFrac: 0.62, tip: 'none', wingletH: 0, slats: false, flapTracks: 2, aileronFrac: 0.72,
    },
    tail: {
      finRootChord: 4.0, finTipChord: 2.5, finSweep: 32, finTEOffset: 0.3, dorsal: true,
      stabSpan: 7.3, stabRootChord: 1.9, stabTipChord: 1.2, stabSweep: 8, stabDihedral: 0, stabFromTail: 0, tTail: true,
    },
    engine: {
      kind: 'prop', mount: 'wing', spanFracs: [0.3], length: 5.6, radius: 0.55, fanRadius: 0.3, chevrons: false, flatBottom: false,
      forward: 0.46, drop: -0.35, blades: 6, propRadius: 1.965,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -10.8, r: 0.32, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.36 },
      mains: [{ kind: 'body', x: 2.05, z: 0, r: 0.45, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.56 }],
    },
    windows: [{ deck: 'main', theta: 5, from: 5.3, to: 22.8, pitch: 0.76, w: 0.28, h: 0.36 }],
    doors: [door(3.9, 1.25, 1.55), door(24.0, 0.72, 1.75), exit(13.3)],
    cockpit: 'atr',
    spinner: 'dark',
  },
  B789: {
    id: 'B789',
    fus: fus({
      length: 62.8, radius: 2.885, hr: 1.035, centerY: 4.95, noseTipY: -0.26, ntLen: 10.8, nbLen: 6.6, nwLen: 8.4, pt: 0.62, pb: 0.52, pw: 0.56,
      tailLen: 18.5, tailTipY: 0.26, tailTipR: 0.07, mainGearFromNose: 28.6,
    }),
    wing: {
      rootChord: 11.6, kinkChord: 6.8, tipChord: 2.0, kinkFrac: 0.32, sweep: 32, dihedral: 6, tcRoot: 0.15, tcTip: 0.1,
      high: false, gearChordFrac: 0.72, tip: 'raked', wingletH: 0, slats: true, flapTracks: 4, aileronFrac: 0.8, rakeFrac: 0.9, rakeSweep: 48,
    },
    tail: {
      finRootChord: 9.2, finTipChord: 3.3, finSweep: 38, finTEOffset: 1.0, dorsal: false,
      stabSpan: 19.8, stabRootChord: 6.2, stabTipChord: 2.0, stabSweep: 35, stabDihedral: 7, stabFromTail: 9.2, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.33], length: 6.0, radius: 1.78, fanRadius: 1.42, chevrons: true, flatBottom: false,
      forward: 0.62, drop: 0.25, blades: 18,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -22.8, r: 0.52, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.9 },
      mains: [{ kind: 'wing', x: 4.9, z: 0, r: 0.64, axles: 2, wheels: 2, axleSpacing: 1.45, wheelSpacing: 1.35 }],
    },
    windows: [{ deck: 'main', theta: 3, from: 7.4, to: 53.2, pitch: 0.61, w: 0.28, h: 0.47 }],
    doors: [door(5.6, 1.07, 1.9), door(18.2, 1.07, 1.9), door(36.4, 1.07, 1.9), door(53.8, 1.07, 1.9), cargo(12.0, 2.7, 1.7), cargo(44.0, 2.7, 1.7)],
    cockpit: 'b787',
    spinner: 'silver',
  },
  A359: {
    id: 'A359',
    fus: fus({
      length: 66.8, radius: 2.98, hr: 1.02, centerY: 5.0, noseTipY: -0.22, ntLen: 11.2, nbLen: 6.8, nwLen: 8.6, pt: 0.6,
      tailLen: 19.8, mainGearFromNose: 34.2,
    }),
    wing: {
      rootChord: 12.2, kinkChord: 7.0, tipChord: 2.2, kinkFrac: 0.3, sweep: 31.9, dihedral: 5.5, tcRoot: 0.15, tcTip: 0.1,
      high: false, gearChordFrac: 0.72, tip: 'curved', wingletH: 3.2, slats: true, flapTracks: 4, aileronFrac: 0.8,
    },
    tail: {
      finRootChord: 9.8, finTipChord: 3.4, finSweep: 40, finTEOffset: 1.1, dorsal: false,
      stabSpan: 18.9, stabRootChord: 6.4, stabTipChord: 2.1, stabSweep: 34, stabDihedral: 5, stabFromTail: 9.6, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.33], length: 6.3, radius: 1.72, fanRadius: 1.48, chevrons: false, flatBottom: false,
      forward: 0.62, drop: 0.3, blades: 22,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -28.7, r: 0.52, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.9 },
      mains: [{ kind: 'wing', x: 5.35, z: 0, r: 0.66, axles: 2, wheels: 2, axleSpacing: 1.6, wheelSpacing: 1.4 }],
    },
    windows: [{ deck: 'main', theta: 3, from: 7.9, to: 58.6, pitch: 0.58, w: 0.28, h: 0.43 }],
    doors: [door(5.8, 1.07, 1.93), door(19.4, 1.07, 1.93), door(40.2, 1.07, 1.93), door(57.9, 1.07, 1.93), cargo(13.0, 2.7, 1.7), cargo(48.0, 2.7, 1.7)],
    cockpit: 'a350',
    spinner: 'silver',
  },
  B77W: {
    id: 'B77W',
    fus: fus({
      length: 73.9, radius: 3.1, hr: 1.0, centerY: 5.45, noseTipY: -0.3, ntLen: 11.8, nbLen: 7.0, nwLen: 9.0, pt: 0.56,
      tailLen: 20.5, tailTipY: 0.3, tailTipR: 0.07, mainGearFromNose: 37.4,
    }),
    wing: {
      rootChord: 13.0, kinkChord: 7.4, tipChord: 2.3, kinkFrac: 0.3, sweep: 31.6, dihedral: 6, tcRoot: 0.15, tcTip: 0.1,
      high: false, gearChordFrac: 0.72, tip: 'raked', wingletH: 0, slats: true, flapTracks: 4, aileronFrac: 0.8, rakeFrac: 0.9, rakeSweep: 45,
    },
    tail: {
      finRootChord: 10.4, finTipChord: 3.5, finSweep: 38, finTEOffset: 1.1, dorsal: false,
      stabSpan: 21.5, stabRootChord: 7.0, stabTipChord: 2.3, stabSweep: 35, stabDihedral: 7, stabFromTail: 10.5, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.3], length: 7.3, radius: 2.05, fanRadius: 1.63, chevrons: false, flatBottom: false,
      forward: 0.62, drop: 0.3, blades: 22,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -31.2, r: 0.55, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.95 },
      mains: [{ kind: 'wing', x: 5.5, z: 0, r: 0.66, axles: 3, wheels: 2, axleSpacing: 1.45, wheelSpacing: 1.4 }],
    },
    windows: [{ deck: 'main', theta: 3, from: 7.6, to: 65.2, pitch: 0.51, w: 0.25, h: 0.38 }],
    doors: [door(6.1, 1.07, 1.9), door(16.9, 1.07, 1.9), door(34.6, 1.07, 1.9), door(50.4, 1.07, 1.9), door(65.4, 1.07, 1.9), cargo(12.0, 2.7, 1.7), cargo(56.0, 2.7, 1.7)],
    cockpit: 'boeing',
    spinner: 'dark',
  },
  B748: {
    id: 'B748',
    fus: fus({
      length: 76.3, radius: 3.25, hr: 1.0, centerY: 5.45, noseTipY: -0.4, ntLen: 9.5, nbLen: 6.2, nwLen: 7.6, pt: 0.5,
      tailLen: 21.0, tailTipY: 0.3, tailTipR: 0.07, mainGearFromNose: 36.0,
      hump: { start: 1.0, full: 11.5, end: 25.5, tail: 34.0, height: 2.55 },
    }),
    wing: {
      rootChord: 14.6, kinkChord: 7.8, tipChord: 3.0, kinkFrac: 0.33, sweep: 37.5, dihedral: 7, tcRoot: 0.14, tcTip: 0.1,
      high: false, gearChordFrac: 0.7, tip: 'raked', wingletH: 0, slats: true, flapTracks: 4, aileronFrac: 0.8, rakeFrac: 0.9, rakeSweep: 50,
    },
    tail: {
      finRootChord: 11.4, finTipChord: 4.2, finSweep: 45, finTEOffset: 1.1, dorsal: false,
      stabSpan: 22.2, stabRootChord: 7.4, stabTipChord: 2.5, stabSweep: 37, stabDihedral: 7, stabFromTail: 11.0, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.3, 0.56], length: 5.9, radius: 1.6, fanRadius: 1.35, chevrons: true, flatBottom: false,
      forward: 0.62, drop: 0.3, blades: 18,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -29.7, r: 0.55, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 0.95 },
      mains: [
        { kind: 'wing', x: 5.6, z: -0.8, r: 0.62, axles: 2, wheels: 2, axleSpacing: 1.45, wheelSpacing: 1.3 },
        { kind: 'body', x: 1.9, z: 2.1, r: 0.62, axles: 2, wheels: 2, axleSpacing: 1.45, wheelSpacing: 1.3 },
      ],
    },
    windows: [
      { deck: 'main', theta: 4, from: 8.6, to: 67.0, pitch: 0.51, w: 0.25, h: 0.38 },
      { deck: 'upper', theta: 50, from: 10.4, to: 27.4, pitch: 0.51, w: 0.25, h: 0.38 },
    ],
    doors: [door(7.4, 1.07, 1.9), door(19.4, 1.07, 1.9), door(33.0, 1.07, 1.9), door(47.8, 1.07, 1.9), door(63.8, 1.07, 1.9), door(22.5, 0.9, 1.5, 'upper'), cargo(14.0, 2.7, 1.7), cargo(56.0, 2.7, 1.7)],
    cockpit: 'b747',
    spinner: 'silver',
  },
  A388: {
    id: 'A388',
    fus: fus({
      length: 72.7, radius: 3.57, hr: 1.18, centerY: 6.3, nExp: 2.2, noseTipY: -0.16, ntLen: 11.0, nbLen: 7.8, nwLen: 9.0, pt: 0.5, pb: 0.52,
      tailLen: 20.5, tailTipY: 0.28, tailTipR: 0.06, mainGearFromNose: 38.6,
    }),
    wing: {
      rootChord: 17.7, kinkChord: 9.8, tipChord: 4.1, kinkFrac: 0.34, sweep: 33.5, dihedral: 5.6, tcRoot: 0.14, tcTip: 0.1,
      high: false, gearChordFrac: 0.7, tip: 'fence', wingletH: 1.3, slats: true, flapTracks: 5, aileronFrac: 0.78,
    },
    tail: {
      finRootChord: 14.0, finTipChord: 5.0, finSweep: 40, finTEOffset: 1.2, dorsal: false,
      stabSpan: 30.4, stabRootChord: 9.8, stabTipChord: 3.2, stabSweep: 35, stabDihedral: 5, stabFromTail: 13.5, tTail: false,
    },
    engine: {
      kind: 'fan', mount: 'wing', spanFracs: [0.3, 0.54], length: 6.4, radius: 1.62, fanRadius: 1.48, chevrons: false, flatBottom: false,
      forward: 0.62, drop: 0.3, blades: 24,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -31.4, r: 0.6, axles: 1, wheels: 2, axleSpacing: 0, wheelSpacing: 1.0 },
      mains: [
        { kind: 'wing', x: 6.2, z: -1.0, r: 0.7, axles: 2, wheels: 2, axleSpacing: 1.6, wheelSpacing: 1.45 },
        { kind: 'body', x: 2.1, z: 2.4, r: 0.7, axles: 3, wheels: 2, axleSpacing: 1.6, wheelSpacing: 1.45 },
      ],
    },
    windows: [
      { deck: 'main', theta: -14, from: 9.5, to: 64.0, pitch: 0.5, w: 0.25, h: 0.38 },
      { deck: 'upper', theta: 31, from: 11.0, to: 60.2, pitch: 0.5, w: 0.25, h: 0.38 },
    ],
    doors: [
      door(8.2, 1.07, 1.93), door(20.8, 1.07, 1.93), door(36.5, 1.07, 1.93), door(52.8, 1.07, 1.93), door(64.8, 1.07, 1.93),
      door(15.4, 1.07, 1.93, 'upper'), door(36.8, 1.07, 1.93, 'upper'), door(57.8, 1.07, 1.93, 'upper'),
      cargo(15.0, 2.7, 1.7), cargo(55.0, 2.7, 1.7),
    ],
    cockpit: 'a380',
    spinner: 'silver',
  },
  C56X: {
    id: 'C56X',
    fus: fus({
      length: 16.0, radius: 0.85, hr: 1.0, centerY: 1.45, noseTipY: -0.12, ntLen: 3.9, nbLen: 2.3, nwLen: 3.0, pt: 0.62, pw: 0.6,
      tailLen: 5.2, tailTipY: 0.35, tailTipR: 0.1, mainGearFromNose: 8.8,
    }),
    wing: {
      rootChord: 2.7, kinkChord: 2.05, tipChord: 1.05, kinkFrac: 0.35, sweep: 12, dihedral: 4, tcRoot: 0.14, tcTip: 0.12,
      high: false, gearChordFrac: 0.66, tip: 'small', wingletH: 0.55, slats: false, flapTracks: 0, aileronFrac: 0.7,
    },
    tail: {
      finRootChord: 2.7, finTipChord: 1.6, finSweep: 42, finTEOffset: 0.2, dorsal: false,
      stabSpan: 6.4, stabRootChord: 1.5, stabTipChord: 0.8, stabSweep: 25, stabDihedral: 2, stabFromTail: 0, tTail: true,
    },
    engine: {
      kind: 'fan', mount: 'rear', spanFracs: [], length: 2.5, radius: 0.5, fanRadius: 0.37, chevrons: false, flatBottom: false,
      forward: 0, drop: 0, blades: 20, rearFront: 10.3, rearYOff: 0.3,
    },
    gear: {
      nose: { kind: 'nose', x: 0, z: -6.4, r: 0.24, axles: 1, wheels: 1, axleSpacing: 0, wheelSpacing: 0 },
      mains: [{ kind: 'wing', x: 1.55, z: 0, r: 0.33, axles: 1, wheels: 1, axleSpacing: 0, wheelSpacing: 0 }],
    },
    windows: [{ deck: 'main', theta: 6, from: 3.8, to: 9.6, pitch: 0.9, w: 0.34, h: 0.4 }],
    doors: [door(2.2, 0.62, 1.4)],
    cockpit: 'bizjet',
    spinner: 'silver',
  },
};
