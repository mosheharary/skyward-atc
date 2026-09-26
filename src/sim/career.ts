// Career shifts and session configuration (career or free play).

export type WeatherPreset = 'clear' | 'cloudy' | 'windy' | 'rain' | 'storm' | 'fog';

export interface SessionConfig {
  mode: 'career' | 'free';
  shiftId: string | null;
  airport: string;
  /** Runway configuration id, or 'auto' = chosen from the wind. */
  runwayConfig: string;
  arrivalsPerHour: number;
  departuresPerHour: number;
  weather: WeatherPreset;
  /** Local hour of day at the start (0..24). */
  startHour: number;
  dayOfYear: number;
  /** Shift length in minutes of sim time, null = endless. */
  durationMin: number | null;
  /** Probability that an arrival declares an emergency. */
  emergencyRate: number;
  /** Fraction of gates occupied by parked aircraft at the start. */
  initialParked: number;
  seed: number;
}

export interface ShiftDef {
  id: string;
  index: number;
  title: string;
  airport: string;
  briefing: string;
  tip: string;
  config: Omit<SessionConfig, 'mode' | 'shiftId' | 'seed'>;
  /** Minimum score to pass (1 star); 2 stars at 1.6x, 3 stars at 2.4x. */
  passScore: number;
  /** The shift fails immediately when the score drops to this value. */
  failScore: number;
}

const base = { dayOfYear: 172, initialParked: 0.55 };

export const SHIFTS: ShiftDef[] = [
  {
    id: 's1', index: 1, title: 'First day at Harbor Point', airport: 'HPX',
    briefing: 'A quiet morning with light westerly winds. Vector a handful of arrivals onto the runway 27 ILS, land them and taxi them to their stands. Push back and launch the departures.',
    tip: 'Select an aircraft on the radar or in the strips, then use the command panel. Aircraft that need you glow amber.',
    config: { ...base, airport: 'HPX', runwayConfig: 'west', arrivalsPerHour: 6, departuresPerHour: 5, weather: 'clear', startHour: 9, durationMin: 15, emergencyRate: 0 },
    passScore: 250, failScore: -400,
  },
  {
    id: 's2', index: 2, title: 'Easterly afternoon', airport: 'HPX',
    briefing: 'The wind has swung to the east: traffic now lands and departs runway 09. Traffic is picking up.',
    tip: 'Interleave departures between arrivals: clear a departure for take-off as soon as the previous arrival has vacated.',
    config: { ...base, airport: 'HPX', runwayConfig: 'east', arrivalsPerHour: 10, departuresPerHour: 8, weather: 'windy', startHour: 15, durationMin: 20, emergencyRate: 0 },
    passScore: 450, failScore: -400,
  },
  {
    id: 's3', index: 3, title: 'Golden hour rush', airport: 'HPX',
    briefing: 'The evening bank arrives under a broken cloud deck as the sun sets over the ocean.',
    tip: 'Keep 3 NM or 1,000 ft between airborne aircraft. Use speed control to space arrivals on final.',
    config: { ...base, airport: 'HPX', runwayConfig: 'west', arrivalsPerHour: 14, departuresPerHour: 10, weather: 'cloudy', startHour: 19.3, durationMin: 20, emergencyRate: 0.04 },
    passScore: 650, failScore: -450,
  },
  {
    id: 's4', index: 4, title: 'Rainy night', airport: 'HPX',
    briefing: 'Rain and low cloud after dark. Expect the occasional emergency — give it priority.',
    tip: 'Emergency aircraft show a red tag. Get them on the ground quickly; everyone else can wait.',
    config: { ...base, airport: 'HPX', runwayConfig: 'west', arrivalsPerHour: 14, departuresPerHour: 12, weather: 'rain', startHour: 22.5, durationMin: 25, emergencyRate: 0.1 },
    passScore: 750, failScore: -450,
  },
  {
    id: 's5', index: 5, title: 'Welcome to Ben Gurion', airport: 'LLBG',
    briefing: 'A busier airport with three runways. Arrivals land 26, departures use 30. Watch the crossings.',
    tip: 'Taxiing aircraft stop at every active runway and ask to cross. Only clear them when the runway is free.',
    config: { ...base, airport: 'LLBG', runwayConfig: 'west', arrivalsPerHour: 16, departuresPerHour: 14, weather: 'clear', startHour: 11, durationMin: 25, emergencyRate: 0.04 },
    passScore: 850, failScore: -500,
  },
  {
    id: 's6', index: 6, title: 'Sharav winds', airport: 'LLBG',
    briefing: 'A hot, gusty north-westerly. North flow: land 21, depart 26.',
    tip: 'Gusty wind makes approaches less stable. Give arrivals a good intercept (30° or less) at least 8 NM out.',
    config: { ...base, airport: 'LLBG', runwayConfig: 'north', arrivalsPerHour: 18, departuresPerHour: 16, weather: 'windy', startHour: 14, durationMin: 25, emergencyRate: 0.05 },
    passScore: 950, failScore: -500,
  },
  {
    id: 's7', index: 7, title: 'Thunder over the coast', airport: 'LLBG',
    briefing: 'A winter storm line crosses the coast at night. Lightning, heavy rain, missed approaches likely.',
    tip: 'After a go-around the aircraft climbs runway heading to the missed-approach altitude. Re-sequence it quickly.',
    config: { ...base, airport: 'LLBG', runwayConfig: 'west', arrivalsPerHour: 18, departuresPerHour: 14, weather: 'storm', startHour: 21, durationMin: 25, emergencyRate: 0.08, dayOfYear: 20 },
    passScore: 950, failScore: -550,
  },
  {
    id: 's8', index: 8, title: 'Bay Area bank', airport: 'KSFO',
    briefing: 'Parallel arrivals on 28L/28R, departures off runway 1. Lots of crossings.',
    tip: 'Departures from runway 1 cross the arrival runways in their path — time the crossings between arrivals.',
    config: { ...base, airport: 'KSFO', runwayConfig: 'west', arrivalsPerHour: 20, departuresPerHour: 18, weather: 'clear', startHour: 16.5, durationMin: 25, emergencyRate: 0.05 },
    passScore: 1100, failScore: -600,
  },
  {
    id: 's9', index: 9, title: 'Marine layer', airport: 'KSFO',
    briefing: 'Dense fog rolls in from the Pacific. Single runway operations: land 28R, depart 28L.',
    tip: 'In fog you rely on the radar and the ground picture. Use the tower camera and the radar together.',
    config: { ...base, airport: 'KSFO', runwayConfig: 'fog', arrivalsPerHour: 20, departuresPerHour: 16, weather: 'fog', startHour: 7, durationMin: 25, emergencyRate: 0.06 },
    passScore: 1100, failScore: -600,
  },
  {
    id: 's10', index: 10, title: 'The perfect storm', airport: 'KSFO',
    briefing: 'Peak evening traffic, a thunderstorm and emergencies. This is what you trained for.',
    tip: 'Stay ahead: plan the sequence early, use speed control, and never let a request wait too long.',
    config: { ...base, airport: 'KSFO', runwayConfig: 'west', arrivalsPerHour: 26, departuresPerHour: 22, weather: 'storm', startHour: 19.6, durationMin: 30, emergencyRate: 0.1 },
    passScore: 1400, failScore: -700,
  },
];

export const SHIFT_BY_ID: Record<string, ShiftDef> = Object.fromEntries(SHIFTS.map((s) => [s.id, s]));

export function shiftSession(s: ShiftDef, seed: number): SessionConfig {
  return { ...s.config, mode: 'career', shiftId: s.id, seed };
}

export function starsFor(s: ShiftDef, score: number): number {
  if (score >= s.passScore * 2.4) return 3;
  if (score >= s.passScore * 1.6) return 2;
  if (score >= s.passScore) return 1;
  return 0;
}

export interface CareerState {
  unlocked: number;
  best: Record<string, { stars: number; score: number }>;
}

export const NEW_CAREER: CareerState = { unlocked: 1, best: {} };
