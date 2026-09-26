// Tel Aviv Ben Gurion-inspired airport (approximate, not for navigation).
// Three runways (08/26, 12/30, 03/21) around a two-pier terminal; the Mediterranean to the west,
// the Tel Aviv skyline on the coast and the Judean foothills to the east.

import type { AirportDef, GateDef, Vec2 } from './types';
import { at, connector, end, frame, gateRow, parallel, path, polar, rapidExit, runway } from './builder';

const R0826 = frame([-2200, -1200], 80, 4000); // +lat = south
const R1230 = frame([-2400, 1200], 120, 3100); // +lat = south-west
const R0321 = frame([1100, -250], 30, 2770); // +lat = east-south-east

const kJoin = at(R0826, 3150.6, -200); // where taxiway K meets taxiway M
const ys = (x: number, list: number[]): Vec2[] => list.map((y) => [x, y] as Vec2);

const gates: GateDef[] = [
  ...gateRow('C', 1, ys(-30, [870, 800, 737, 684, 631]), 90, ['L', 'L', 'M', 'M', 'M'], true),
  ...gateRow('C', 6, ys(30, [870, 800, 737, 684, 631]), 270, ['L', 'L', 'M', 'M', 'M'], true),
  ...gateRow('D', 1, ys(390, [870, 800, 737, 684, 631]), 90, ['L', 'L', 'M', 'M', 'M'], true),
  ...gateRow('D', 6, ys(450, [865, 780, 717, 664]), 270, ['H', 'L', 'M', 'M'], true),
  ...gateRow('R', 1, ys(-240, [880, 835, 790, 745, 700, 655]), 270, ['S'], false),
  ...gateRow('F', 1, ys(690, [860, 770, 680]), 90, ['H'], false),
];

export const LLBG: AirportDef = {
  id: 'LLBG',
  icao: 'LLBG',
  name: 'Ben Gurion (inspired)',
  city: 'Tel Aviv',
  description: 'Three runways around a two-pier terminal between the Mediterranean and the Judean foothills. Heavy long-haul traffic.',
  elevationFt: 135,
  latitude: 32.01,
  longitude: 34.89,
  utcOffset: 3,
  tower: { pos: [820, 1060], eyeHeight: 70, lookAt: [400, -200] },
  runways: [
    runway(R0826, 60, end('08', false, 'none'), end('26', true, 'full')),
    runway(R1230, 45, end('12', true, 'full'), end('30', false, 'none')),
    runway(R0321, 45, end('03', false, 'none'), end('21', true, 'simple')),
  ],
  taxiways: [
    parallel('M', R0826, -200, 0, 4000),
    connector('M1', R0826, 0, 0, -200),
    connector('M3', R0826, 1050, 0, -200),
    rapidExit('M2', R0826, 1700, -200, true),
    rapidExit('M4', R0826, 2400, -200, true),
    connector('M6', R0826, 3100, 0, -200),
    connector('M8', R0826, 4000, 0, -200),
    path('K', [at(R1230, 0, -200), at(R1230, 3100, -200), kJoin]),
    connector('K1', R1230, 0, 0, -200),
    connector('K4', R1230, 1300, 0, -200),
    rapidExit('K5', R1230, 1700, -200),
    rapidExit('K6', R1230, 2250, -200),
    connector('K7', R1230, 2800, 0, -200),
    connector('K9', R1230, 3100, 0, -200),
    parallel('D', R0321, -200, 0, 2770),
    connector('D1', R0321, 0, 0, -200),
    rapidExit('D3', R0321, 900, -200, true),
    rapidExit('D5', R0321, 1400, -200, true),
    connector('D6', R0321, 1900, 0, -200),
    connector('D8', R0321, 2770, 0, -200),
    path('N', [kJoin, at(R0321, 0, -200)]),
    path('S', [[-891.5, 560], [1336.7, 560]]),
    path('L', [[600, 560], at(R0826, (600 + 2234.73) / 0.98481, -200)]),
    path('P1', [[-150, 905], [-150, 560]], 'taxilane'),
    path('P2', [[210, 905], [210, 560]], 'taxilane'),
    path('P3', [[570, 905], [570, 560]], 'taxilane'),
  ],
  aprons: [{ name: 'Terminal apron', polygon: [[-300, 540], [760, 540], [760, 915], [-300, 915]] }],
  gates,
  buildings: [
    { kind: 'terminal', pos: [200, 950], w: 1000, d: 70, h: 28, axis: 90, name: 'Terminal 3' },
    { kind: 'pier', pos: [0, 765], w: 300, d: 36, h: 14, axis: 0, name: 'Pier C' },
    { kind: 'pier', pos: [420, 765], w: 300, d: 36, h: 14, axis: 0, name: 'Pier D' },
    { kind: 'tower', pos: [820, 1060], w: 16, d: 16, h: 76, axis: 90, name: 'Control tower' },
    { kind: 'cargo', pos: [790, 770], w: 260, d: 50, h: 16, axis: 0, name: 'Cargo terminal' },
    { kind: 'hangar', pos: [-1000, -560], w: 160, d: 100, h: 34, axis: 80, name: 'Hangar A' },
    { kind: 'hangar', pos: [-780, -525], w: 130, d: 90, h: 30, axis: 80, name: 'Hangar B' },
    { kind: 'garage', pos: [200, 1060], w: 400, d: 90, h: 20, axis: 90, name: 'Car park' },
    { kind: 'hotel', pos: [500, 1130], w: 80, d: 40, h: 55, axis: 90, name: 'Airport hotel' },
    { kind: 'firestation', pos: [1000, 300], w: 50, d: 30, h: 10, axis: 30, name: 'Fire station' },
    { kind: 'radar', pos: [-300, 1300], w: 12, d: 12, h: 34, axis: 90, name: 'Radar' },
    { kind: 'fuel', pos: [1100, 1400], w: 150, d: 100, h: 14, axis: 30, name: 'Fuel farm' },
    { kind: 'office', pos: [-800, 1150], w: 200, d: 80, h: 18, axis: 120, name: 'Operations' },
  ],
  fixes: [
    { id: 'ROSEM', pos: at(R0826, 4000 + 9260), role: 'if' },
    { id: 'TAMAR', pos: at(R0826, 4000 + 18520), role: 'if' },
    { id: 'YAFFO', pos: at(R1230, -9260), role: 'if' },
    { id: 'HOFIT', pos: at(R1230, -18520), role: 'if' },
    { id: 'GILAD', pos: at(R0321, 2770 + 9260), role: 'if' },
    { id: 'SHARN', pos: at(R0321, 2770 + 18520), role: 'if' },
    { id: 'NATAN', pos: polar(0, 14), role: 'iaf' },
    { id: 'KEREM', pos: polar(90, 14), role: 'iaf' },
    { id: 'ASHDO', pos: polar(220, 14), role: 'iaf' },
    { id: 'HADAR', pos: polar(320, 14), role: 'iaf' },
    { id: 'BALTI', pos: polar(290, 30), role: 'entry' },
    { id: 'LAMER', pos: polar(250, 30), role: 'entry' },
    { id: 'PURLA', pos: polar(20, 30), role: 'entry' },
    { id: 'NATOF', pos: polar(100, 30), role: 'entry' },
    { id: 'ZOHAR', pos: polar(170, 30), role: 'entry' },
    { id: 'SUSIT', pos: polar(310, 30), role: 'exit' },
    { id: 'DOREN', pos: polar(230, 30), role: 'exit' },
    { id: 'METSA', pos: polar(40, 30), role: 'exit' },
    { id: 'GIDON', pos: polar(130, 30), role: 'exit' },
  ],
  arrivalGates: [
    { fix: 'BALTI', altitude: 11000, route: ['HADAR'] },
    { fix: 'LAMER', altitude: 10000, route: ['ASHDO'] },
    { fix: 'PURLA', altitude: 11000, route: ['NATAN'] },
    { fix: 'NATOF', altitude: 12000, route: ['KEREM'] },
    { fix: 'ZOHAR', altitude: 10000, route: ['ASHDO'] },
  ],
  departureExits: [
    { fix: 'SUSIT', minAltitude: 10000 },
    { fix: 'DOREN', minAltitude: 10000 },
    { fix: 'METSA', minAltitude: 11000 },
    { fix: 'GIDON', minAltitude: 11000 },
  ],
  airspace: { radiusNm: 32, ceilingFt: 16000 },
  missedApproachAlt: 3000,
  initialClimb: 5000,
  mva: 2500,
  runwayConfigs: [
    { id: 'west', label: 'West flow — land 26, depart 30', arrivals: ['26'], departures: ['30'], windFrom: 270 },
    { id: 'east', label: 'East flow — land 12, depart 08', arrivals: ['12'], departures: ['08'], windFrom: 100 },
    { id: 'north', label: 'North flow — land 21, depart 26', arrivals: ['21'], departures: ['26'], windFrom: 20 },
  ],
  scenery: {
    water: [
      [
        [-16000, -60000], [-13500, -20000], [-14200, -5000], [-15500, 5000], [-17000, 20000],
        [-19000, 60000], [-80000, 60000], [-80000, -60000],
      ],
    ],
    flatZone: [[-3400, -1500], [2900, -900], [3000, 2800], [-3400, 2000]],
    flatBlend: 700,
    hills: [
      { pos: [14000, -2000], radius: 8000, height: 350 },
      { pos: [22000, 3000], radius: 10000, height: 650 },
      { pos: [18000, -12000], radius: 9000, height: 500 },
      { pos: [16000, 16000], radius: 9000, height: 450 },
    ],
    roughness: 0.35,
    ground: 'mediterranean',
    cities: [
      { pos: [-11500, 3500], radius: 4500, density: 0.9, maxHeight: 230, skyscrapers: 24 },
      { pos: [-3500, 7000], radius: 2500, density: 0.7, maxHeight: 120, skyscrapers: 8 },
      { pos: [-9000, -5000], radius: 3000, density: 0.7, maxHeight: 90, skyscrapers: 5 },
      { pos: [2500, -5500], radius: 1800, density: 0.6, maxHeight: 40, skyscrapers: 0 },
      { pos: [13000, -4000], radius: 2500, density: 0.6, maxHeight: 50, skyscrapers: 0 },
      { pos: [-4500, 2500], radius: 1200, density: 0.5, maxHeight: 35, skyscrapers: 0 },
    ],
    forests: [
      { pos: [7000, -3500], radius: 3000, density: 0.6 },
      { pos: [-2000, -6000], radius: 2500, density: 0.4 },
      { pos: [6000, 6000], radius: 2500, density: 0.4 },
    ],
    roads: [
      [[-14000, 3000], [-8000, 500], [-3500, -2200], [2500, -2700], [9000, -3500], [20000, -5000]],
      [[6000, 30000], [5500, 10000], [5000, 0], [4500, -20000]],
      [[-60, 990], [-60, 2500], [-2000, 4500]],
    ],
  },
};
