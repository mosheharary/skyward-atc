// Harbor Point International (fictional). Single runway 09/27 on a green coastal plain,
// the sea to the south, a harbour city to the north-east. The career starts here.

import type { AirportDef, GateDef, Vec2 } from './types';
import { at, connector, end, frame, gateRow, nm, parallel, path, polar, rapidExit, runway } from './builder';

const R = frame([1600, 0], 270, 3200); // '27' threshold at x=+1600, '09' at x=-1600; +lat = north

const GATE_Y = 548;
const xs = (list: number[]): Vec2[] => list.map((x) => [x, GATE_Y] as Vec2);

const gates: GateDef[] = [
  ...gateRow('A', 1, xs([-410, -335]), 0, ['L', 'L'], true),
  ...gateRow('A', 3, xs([-270, -218, -166, -114, -62, -10, 42, 94]), 0, ['M'], true),
  ...gateRow('A', 11, xs([162, 237]), 0, ['L', 'L'], true),
  ...gateRow('A', 13, xs([302, 354, 406, 458, 510, 562]), 0, ['M'], true),
  ...gateRow('R', 1, xs([-480, -525, -570, -615, -660, -705]), 0, ['S'], false),
  ...gateRow('C', 1, xs([740, 830, 920]), 0, ['H'], false),
];

export const HPX: AirportDef = {
  id: 'HPX',
  icao: 'KHPX',
  name: 'Harbor Point International',
  city: 'Harbor Point',
  description: 'A friendly coastal airport with a single 3.2 km runway. Perfect for learning the job.',
  elevationFt: 18,
  latitude: 36.95,
  longitude: -122.02,
  utcOffset: -7,
  tower: { pos: [250, 700], eyeHeight: 66, lookAt: [300, 0] },
  runways: [runway(R, 45, end('27', true, 'full'), end('09', true, 'simple'))],
  taxiways: [
    parallel('A', R, 180, 0, 3200),
    connector('A1', R, 0, 0, 180),
    connector('A3', R, 1050, 0, 180),
    connector('A5', R, 2450, 0, 180),
    connector('A7', R, 3200, 0, 180),
    rapidExit('B1', R, 700, 180, true),
    rapidExit('B2', R, 1250, 180, true),
    rapidExit('B3', R, 1500, 180),
    rapidExit('B4', R, 1950, 180),
    path('T', [[-760, 440], [1380, 440]], 'taxilane'),
    path('J1', [[-760, 440], [-760, 180]]),
    path('J2', [[150, 440], [150, 180]]),
    path('J3', [[1050, 440], [1050, 180]]),
    path('J4', [[1380, 440], [1380, 180]]),
  ],
  aprons: [
    { name: 'Main apron', polygon: [[-820, 395], [1110, 395], [1110, 575], [-820, 575]] },
    { name: 'Maintenance apron', polygon: [[1200, 395], [1560, 395], [1560, 515], [1200, 515]] },
  ],
  gates,
  buildings: [
    { kind: 'terminal', pos: [100, 590], w: 1100, d: 60, h: 24, axis: 90, name: 'Terminal' },
    { kind: 'tower', pos: [250, 700], w: 16, d: 16, h: 72, axis: 90, name: 'Control tower' },
    { kind: 'cargo', pos: [880, 612], w: 380, d: 70, h: 16, axis: 90, name: 'Cargo centre' },
    { kind: 'hangar', pos: [1300, 575], w: 150, d: 110, h: 32, axis: 90, name: 'Hangar 1' },
    { kind: 'hangar', pos: [1470, 570], w: 120, d: 90, h: 28, axis: 90, name: 'Hangar 2' },
    { kind: 'firestation', pos: [-1000, 330], w: 50, d: 28, h: 10, axis: 90, name: 'Fire station' },
    { kind: 'fuel', pos: [-1150, 600], w: 160, d: 90, h: 14, axis: 90, name: 'Fuel farm' },
    { kind: 'radar', pos: [-1350, 470], w: 12, d: 12, h: 30, axis: 90, name: 'Radar' },
    { kind: 'garage', pos: [-150, 720], w: 320, d: 90, h: 18, axis: 90, name: 'Car park' },
    { kind: 'hotel', pos: [560, 740], w: 70, d: 45, h: 48, axis: 90, name: 'Airport hotel' },
    { kind: 'office', pos: [-600, 700], w: 120, d: 50, h: 20, axis: 90, name: 'Operations' },
    { kind: 'maintenance', pos: [1250, 700], w: 100, d: 60, h: 14, axis: 90, name: 'Workshops' },
  ],
  fixes: [
    { id: 'KEELS', pos: at(R, -nm(5, 0)[0]), role: 'if' },
    { id: 'HAVEN', pos: at(R, -nm(10, 0)[0]), role: 'if' },
    { id: 'WHARF', pos: at(R, 3200 + nm(5, 0)[0]), role: 'if' },
    { id: 'SHOAL', pos: at(R, 3200 + nm(10, 0)[0]), role: 'if' },
    { id: 'TIDAL', pos: polar(45, 12), role: 'iaf' },
    { id: 'SANDY', pos: polar(135, 12), role: 'iaf' },
    { id: 'CLIFF', pos: polar(315, 12), role: 'iaf' },
    { id: 'REEFS', pos: polar(225, 12), role: 'iaf' },
    { id: 'KILNS', pos: polar(20, 30), role: 'entry' },
    { id: 'MARLO', pos: polar(80, 30), role: 'entry' },
    { id: 'SEAGL', pos: polar(150, 30), role: 'entry' },
    { id: 'PINEY', pos: polar(290, 30), role: 'entry' },
    { id: 'BREAK', pos: polar(220, 30), role: 'entry' },
    { id: 'OAKEN', pos: polar(345, 30), role: 'exit' },
    { id: 'RIDGE', pos: polar(50, 30), role: 'exit' },
    { id: 'GULLS', pos: polar(185, 30), role: 'exit' },
    { id: 'CANYN', pos: polar(255, 30), role: 'exit' },
  ],
  arrivalGates: [
    { fix: 'KILNS', altitude: 10000, route: ['TIDAL'] },
    { fix: 'MARLO', altitude: 11000, route: ['TIDAL'] },
    { fix: 'SEAGL', altitude: 10000, route: ['SANDY'] },
    { fix: 'PINEY', altitude: 10000, route: ['CLIFF'] },
    { fix: 'BREAK', altitude: 11000, route: ['REEFS'] },
  ],
  departureExits: [
    { fix: 'OAKEN', minAltitude: 10000 },
    { fix: 'RIDGE', minAltitude: 10000 },
    { fix: 'GULLS', minAltitude: 10000 },
    { fix: 'CANYN', minAltitude: 10000 },
  ],
  airspace: { radiusNm: 32, ceilingFt: 15000 },
  missedApproachAlt: 3000,
  initialClimb: 5000,
  mva: 2000,
  runwayConfigs: [
    { id: 'west', label: 'West flow — land & depart 27', arrivals: ['27'], departures: ['27'], windFrom: 270 },
    { id: 'east', label: 'East flow — land & depart 09', arrivals: ['09'], departures: ['09'], windFrom: 90 },
  ],
  scenery: {
    water: [
      [
        [-60000, -4000], [-30000, -3500], [-15000, -2600], [-8000, -2300], [-4000, -1900], [0, -1750],
        [3000, -1850], [6000, -2400], [7000, -1500], [7600, 800], [8600, 2600], [10200, 2900],
        [11200, 1500], [11500, -1000], [12500, -2600], [14000, -3000], [20000, -2800], [30000, -4500],
        [45000, -5200], [60000, -5000], [60000, -60000], [-60000, -60000],
      ],
    ],
    flatZone: [[-2900, -650], [2900, -650], [2900, 900], [-2900, 900]],
    flatBlend: 600,
    hills: [
      { pos: [-9000, 6000], radius: 5000, height: 450 },
      { pos: [-14000, 1000], radius: 6000, height: 600 },
      { pos: [-6000, 12000], radius: 7000, height: 700 },
      { pos: [2000, 14000], radius: 6000, height: 400 },
      { pos: [25000, 12000], radius: 9000, height: 800 },
    ],
    roughness: 0.5,
    ground: 'temperate',
    cities: [
      { pos: [6500, 6500], radius: 3200, density: 0.85, maxHeight: 180, skyscrapers: 14 },
      { pos: [-5000, 2500], radius: 1500, density: 0.5, maxHeight: 30, skyscrapers: 0 },
      { pos: [1000, 4500], radius: 2000, density: 0.4, maxHeight: 25, skyscrapers: 0 },
    ],
    forests: [
      { pos: [-8000, 8000], radius: 4000, density: 0.7 },
      { pos: [-12000, -500], radius: 3000, density: 0.5 },
      { pos: [4000, 12000], radius: 3000, density: 0.6 },
    ],
    roads: [
      [[-20000, 1500], [-3000, 1300], [0, 1200], [4000, 2500], [6500, 6000], [12000, 9000]],
      [[100, 650], [100, 1200]],
    ],
  },
};
