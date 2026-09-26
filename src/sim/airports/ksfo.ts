// San Francisco-inspired airport (approximate, not for navigation).
// Two pairs of parallel runways that cross near the 28 thresholds, a four-pier terminal,
// the bay all around the runway ends and the city skyline to the north.

import type { AirportDef, GateDef } from './types';
import type { SizeClass } from '../types';
import { at, connector, end, frame, gateRow, parallel, path, polar, rapidExit, runway } from './builder';

const R28R = frame([1300, 150], 284, 3618); // +lat = north-north-east
const R28L = frame(at(R28R, 0, -229), 284, 3469);
const R01L = frame([400, -1600], 14, 2332); // +lat = east-south-east
const R01R = frame(at(R01L, 0, 229), 14, 2637);

// Piers run perpendicular to the 28s, from the terminal face (lat -660) towards the runways.
const PIERS: { id: string; d: number; east: SizeClass[]; west: SizeClass[]; eastLat: number[]; westLat: number[] }[] = [
  { id: 'A', d: 1450, east: ['H', 'L', 'M', 'M'], west: ['L', 'L', 'M', 'M'], eastLat: [-600, -515, -455, -403], westLat: [-615, -543, -481, -429] },
  { id: 'B', d: 1800, east: ['L', 'L', 'M', 'M'], west: ['L', 'L', 'M', 'M'], eastLat: [-615, -543, -481, -429], westLat: [-615, -543, -481, -429] },
  { id: 'C', d: 2150, east: ['L', 'L', 'M', 'M'], west: ['L', 'L', 'M', 'M'], eastLat: [-615, -543, -481, -429], westLat: [-615, -543, -481, -429] },
  { id: 'D', d: 2500, east: ['L', 'L', 'M', 'M'], west: ['H', 'L', 'M', 'M'], eastLat: [-615, -543, -481, -429], westLat: [-600, -515, -455, -403] },
];

const gates: GateDef[] = PIERS.flatMap((p) => [
  ...gateRow(p.id, 1, p.eastLat.map((lat) => at(R28L, p.d - 32, lat)), 284, p.east, true),
  ...gateRow(p.id, 5, p.westLat.map((lat) => at(R28L, p.d + 32, lat)), 104, p.west, true),
]);

const LANES = [1275, 1625, 1975, 2325, 2675];

export const KSFO: AirportDef = {
  id: 'KSFO',
  icao: 'KSFO',
  name: 'San Francisco (inspired)',
  city: 'San Francisco',
  description: 'Two pairs of parallel runways that cross each other, on the edge of the bay. Arrivals and departures share the intersections — expert level.',
  elevationFt: 13,
  latitude: 37.62,
  longitude: -122.38,
  utcOffset: -7,
  tower: { pos: at(R28L, 1950, -810), eyeHeight: 68, lookAt: at(R28L, 1000, 100) },
  runways: [
    runway(R28R, 60, end('28R', true, 'full'), end('10L', false, 'none')),
    runway(R28L, 60, end('28L', true, 'full'), end('10R', false, 'none')),
    runway(R01L, 60, end('01L', false, 'none'), end('19R', false, 'none')),
    runway(R01R, 60, end('01R', false, 'none'), end('19L', true, 'simple')),
  ],
  taxiways: [
    parallel('A', R28L, -180, 0, 3618),
    connector('A1', R28L, 0, 0, -180),
    path('W', [at(R28L, 3618, -180), at(R28L, 3618, 229)]),
    connector('Y', R28L, 3469, 0, -180),
    rapidExit('T1', R28L, 1500, -180),
    rapidExit('T2', R28L, 2100, -180),
    path('F1', [at(R28R, 1650, 0), at(R28R, 1650, -409)]),
    path('F2', [at(R28R, 2350, 0), at(R28R, 2350, -409)]),
    parallel('B', R28L, -330, 630, 3469),
    ...LANES.map((d, i) => ({ ...connector(`L${i + 1}`, R28L, d, -655, -180), kind: 'taxilane' as const })),
    path('C', [at(R01L, 0, -180), at(R01L, 1506.7, -180)]),
    connector('C1', R01L, 0, 0, -180),
    path('E', [at(R01L, 0, -180), at(R01L, -120, -180), at(R01L, -120, 409), at(R01L, 0, 409)]),
    path('D', [at(R01L, 0, 409), at(R01L, 1506.7, 409)]),
    connector('D1', R01R, 0, 0, 180),
    path('G1', [at(R01R, 1100, 0), at(R01R, 1100, -409)]),
    path('G2', [at(R01R, 700, 0), at(R01R, 700, -409)]),
  ],
  aprons: [
    {
      name: 'Terminal apron',
      polygon: [at(R28L, 1250, -660), at(R28L, 2700, -660), at(R28L, 2700, -370), at(R28L, 1250, -370)],
    },
  ],
  gates,
  buildings: [
    { kind: 'terminal', pos: at(R28L, 1950, -700), w: 1400, d: 80, h: 26, axis: 284, name: 'Terminal' },
    ...PIERS.map((p) => ({ kind: 'pier' as const, pos: at(R28L, p.d, -540), w: 240, d: 40, h: 15, axis: 14, name: `Boarding area ${p.id}` })),
    { kind: 'tower', pos: at(R28L, 1950, -810), w: 16, d: 16, h: 74, axis: 284, name: 'Control tower' },
    { kind: 'hangar', pos: at(R28L, 3000, -600), w: 180, d: 110, h: 36, axis: 284, name: 'Maintenance hangar' },
    { kind: 'hangar', pos: at(R28L, 3250, -600), w: 150, d: 100, h: 32, axis: 284, name: 'Hangar 2' },
    { kind: 'cargo', pos: at(R28L, 900, -700), w: 250, d: 80, h: 16, axis: 284, name: 'Cargo' },
    { kind: 'garage', pos: at(R28L, 1950, -900), w: 500, d: 100, h: 20, axis: 284, name: 'Garage' },
    { kind: 'hotel', pos: at(R28L, 1500, -950), w: 90, d: 50, h: 50, axis: 284, name: 'Hotel' },
    { kind: 'firestation', pos: at(R28L, 2900, -255), w: 50, d: 30, h: 10, axis: 284, name: 'Fire station' },
    { kind: 'radar', pos: at(R28L, 3300, -420), w: 12, d: 12, h: 30, axis: 284, name: 'Radar' },
    { kind: 'fuel', pos: at(R28L, 1200, -1100), w: 160, d: 90, h: 14, axis: 284, name: 'Fuel farm' },
  ],
  fixes: [
    { id: 'DUMBA', pos: at(R28R, -9260), role: 'if' },
    { id: 'OKDUE', pos: at(R28R, -18520), role: 'if' },
    { id: 'AXMUL', pos: at(R28L, -9260), role: 'if' },
    { id: 'BRIJJ', pos: at(R28L, -18520), role: 'if' },
    { id: 'GOBLN', pos: at(R01R, 2637 + 9260), role: 'if' },
    { id: 'COMMO', pos: at(R01R, 2637 + 18520), role: 'if' },
    { id: 'MENLO', pos: polar(140, 15), role: 'iaf' },
    { id: 'PIRAT', pos: polar(250, 15), role: 'iaf' },
    { id: 'BRINY', pos: polar(300, 18), role: 'iaf' },
    { id: 'BERKS', pos: polar(40, 15), role: 'iaf' },
    { id: 'YOSEM', pos: polar(90, 32), role: 'entry' },
    { id: 'SERFR', pos: polar(150, 32), role: 'entry' },
    { id: 'BDEGA', pos: polar(320, 32), role: 'entry' },
    { id: 'OCEAN', pos: polar(245, 32), role: 'entry' },
    { id: 'DYAMD', pos: polar(30, 32), role: 'entry' },
    { id: 'GAPPP', pos: polar(330, 32), role: 'exit' },
    { id: 'SAHEY', pos: polar(270, 32), role: 'exit' },
    { id: 'LOSHN', pos: polar(160, 32), role: 'exit' },
    { id: 'MODSO', pos: polar(60, 32), role: 'exit' },
  ],
  arrivalGates: [
    { fix: 'YOSEM', altitude: 11000, route: ['MENLO'] },
    { fix: 'SERFR', altitude: 10000, route: ['MENLO'] },
    { fix: 'DYAMD', altitude: 11000, route: ['BERKS'] },
    { fix: 'BDEGA', altitude: 10000, route: ['BRINY'] },
    { fix: 'OCEAN', altitude: 10000, route: ['PIRAT'] },
  ],
  departureExits: [
    { fix: 'GAPPP', minAltitude: 10000 },
    { fix: 'SAHEY', minAltitude: 10000 },
    { fix: 'LOSHN', minAltitude: 11000 },
    { fix: 'MODSO', minAltitude: 11000 },
  ],
  airspace: { radiusNm: 34, ceilingFt: 16000 },
  missedApproachAlt: 3000,
  initialClimb: 5000,
  mva: 2000,
  runwayConfigs: [
    { id: 'west', label: 'West plan — land 28L/28R, depart 01L/01R', arrivals: ['28L', '28R'], departures: ['01L', '01R'], windFrom: 290 },
    { id: 'southeast', label: 'Southeast plan — land 19L, depart 10L', arrivals: ['19L'], departures: ['10L'], windFrom: 150 },
    { id: 'fog', label: 'Fog plan — land 28R, depart 28L', arrivals: ['28R'], departures: ['28L'], windFrom: 280 },
  ],
  scenery: {
    water: [
      [
        [-9000, -14000], [-4500, -6500], [-2000, -3600], [300, -2600], [1800, -1500], [2100, -300],
        [1900, 800], [1500, 1600], [0, 1850], [-1800, 1700], [-2700, 2300], [-2600, 3600],
        [-1500, 5500], [0, 8000], [1500, 11000], [2500, 14000], [3200, 18000], [4500, 22000],
        [9000, 26000], [14000, 24000], [16000, 16000], [15000, 5000], [12000, -5000], [8000, -14000],
        [4000, -24000], [-2000, -26000],
      ],
      [
        [-12000, -40000], [-11000, -10000], [-12500, 0], [-11500, 8000], [-9500, 15000], [-8500, 22000],
        [-8000, 40000], [-80000, 40000], [-80000, -40000],
      ],
    ],
    flatZone: [[-2900, -2150], [100, -2250], [1600, -1300], [1850, -300], [1650, 800], [1350, 1350], [0, 1550], [-1800, 1450], [-2900, 1200]],
    flatBlend: 500,
    hills: [
      { pos: [-2500, 7500], radius: 3000, height: 400 },
      { pos: [-7500, -500], radius: 4000, height: 380 },
      { pos: [-9000, -9000], radius: 5000, height: 550 },
      { pos: [-1000, 16000], radius: 2500, height: 280 },
      { pos: [21000, 10000], radius: 8000, height: 450 },
      { pos: [22000, -5000], radius: 9000, height: 500 },
      { pos: [40000, 25000], radius: 12000, height: 1100 },
    ],
    roughness: 0.45,
    ground: 'mediterranean',
    cities: [
      { pos: [2800, 17500], radius: 3200, density: 1, maxHeight: 320, skyscrapers: 30 },
      { pos: [-2500, 14000], radius: 4500, density: 0.8, maxHeight: 25, skyscrapers: 0 },
      { pos: [-2000, 4500], radius: 2200, density: 0.7, maxHeight: 30, skyscrapers: 2 },
      { pos: [-4000, -2000], radius: 2200, density: 0.7, maxHeight: 20, skyscrapers: 0 },
      { pos: [-5000, -9000], radius: 3000, density: 0.7, maxHeight: 40, skyscrapers: 3 },
      { pos: [19500, 17000], radius: 4000, density: 0.8, maxHeight: 160, skyscrapers: 12 },
      { pos: [18500, 2000], radius: 4500, density: 0.6, maxHeight: 25, skyscrapers: 0 },
    ],
    forests: [
      { pos: [-3500, 16500], radius: 1500, density: 0.8 },
      { pos: [-8000, -3000], radius: 4000, density: 0.5 },
      { pos: [-6000, 6000], radius: 3000, density: 0.4 },
    ],
    roads: [
      [[-6000, -12000], [-3000, -3000], [-3000, 0], [-3100, 3000], [-1800, 8000], [0, 13000], [2000, 16500]],
      [[-8000, -12000], [-5500, -2000], [-4500, 6000], [-2500, 13000]],
    ],
  },
};
