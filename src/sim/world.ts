// The simulation world: traffic generation, controller commands with phraseology, separation /
// wake / runway-incursion monitoring, weather, scoring and checkpoint (de)serialisation.

import { DEG, KT, NM, angleDiff, bearing, clamp, dist, wrap360 } from '../core/units';
import { Rng } from '../core/rng';
import { Aircraft, type SimContext } from './aircraft';
import { AIRCRAFT_TYPES, WAKE_DEP_SEC, WAKE_SEP_NM, gateFits } from './aircraftTypes';
import { AIRLINES, AIRLINE_BY_CODE, type Airline } from './airlines';
import { AirportModel, type Runway, type TaxiRoute } from './airportModel';
import { AIRPORT_BY_ID } from './airports';
import type { RunwayConfigDef, Vec2 } from './airports/types';
import type { SessionConfig, WeatherPreset } from './career';
import type { Command, CommandResult, Emergency, ScoreEvent, SimEvent } from './simTypes';
import type { AircraftTypeId, LightningStrike, WeatherState } from './types';
import {
  ATIS_LETTERS,
  digits,
  fmtAltitude,
  fmtHeading,
  fmtWind,
  letter,
  sayAltitude,
  sayFix,
  sayHeading,
  sayRunway,
  saySpeed,
  sayTaxiway,
  sayWind,
  type Phrase,
} from './phraseology';

export const SNAPSHOT_VERSION = 1;

export interface WorldStats {
  landed: number;
  departed: number;
  parked: number;
  goArounds: number;
  violations: number;
  separationLosses: number;
  incursions: number;
  emergencies: number;
  commands: number;
}

export interface RadioLogEntry {
  t: number;
  from: 'atc' | 'pilot';
  id: string;
  text: string;
  urgent?: boolean;
}

interface PairState {
  loss: boolean;
  since: number;
  lastPen: number;
  predicted: boolean;
  wake: boolean;
  tcas: boolean;
}

export interface WorldSnapshot {
  v: number;
  cfg: SessionConfig;
  t: number;
  rng: number;
  nextArr: number;
  nextDep: number;
  idCounter: number;
  score: number;
  stats: WorldStats;
  weather: WeatherState;
  weatherBase: { dir: number; spd: number };
  strikeId: number;
  nextStrike: number;
  configId: string;
  atis: number;
  aircraft: Record<string, unknown>[];
  pairs: [string, PairState][];
  lastDep: [string, { t: number; wake: string }][];
  holdPen: [string, number][];
  radioLog: RadioLogEntry[];
  scoreLog: ScoreEvent[];
  ended: 'time' | 'failed' | 'complete' | null;
}

const WEATHER_PRESETS: Record<WeatherPreset, Omit<WeatherState, 'windDir' | 'lightning'>> = {
  clear: { windSpeed: 7, gust: 0, visibility: 45000, cloudCover: 0.15, cloudBase: 5000, precipitation: 0, thunderstorm: false, temperature: 23, qnh: 1018 },
  cloudy: { windSpeed: 10, gust: 0, visibility: 25000, cloudCover: 0.65, cloudBase: 2800, precipitation: 0, thunderstorm: false, temperature: 17, qnh: 1012 },
  windy: { windSpeed: 20, gust: 31, visibility: 30000, cloudCover: 0.4, cloudBase: 4000, precipitation: 0, thunderstorm: false, temperature: 28, qnh: 1009 },
  rain: { windSpeed: 14, gust: 22, visibility: 6000, cloudCover: 0.95, cloudBase: 1400, precipitation: 0.6, thunderstorm: false, temperature: 12, qnh: 1004 },
  storm: { windSpeed: 22, gust: 36, visibility: 4000, cloudCover: 1, cloudBase: 1100, precipitation: 0.95, thunderstorm: true, temperature: 14, qnh: 998 },
  fog: { windSpeed: 3, gust: 0, visibility: 450, cloudCover: 1, cloudBase: 200, precipitation: 0, thunderstorm: false, temperature: 11, qnh: 1021 },
};

const DEP_FREQ = '124.35';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export class World {
  readonly cfg: SessionConfig;
  readonly airport: AirportModel;
  t = 0;
  rng: Rng;
  aircraft: Aircraft[] = [];
  weather: WeatherState;
  score = 0;
  stats: WorldStats = { landed: 0, departed: 0, parked: 0, goArounds: 0, violations: 0, separationLosses: 0, incursions: 0, emergencies: 0, commands: 0 };
  radioLog: RadioLogEntry[] = [];
  scoreLog: ScoreEvent[] = [];
  config: RunwayConfigDef;
  atis = 0;
  ended: 'time' | 'failed' | 'complete' | null = null;
  /** Consumed by the game shell every frame. */
  events: SimEvent[] = [];
  failScore = -Infinity;

  private nextArr = 0;
  private nextDep = 0;
  private idCounter = 0;
  private weatherBase: { dir: number; spd: number };
  private strikeId = 0;
  private nextStrike = 0;
  private pairs = new Map<string, PairState>();
  private lastDep = new Map<string, { t: number; wake: string }>();
  private holdPen = new Map<string, number>();
  private activeSet = new Set<string>();
  private ctx: SimContext;

  constructor(cfg: SessionConfig, snap?: WorldSnapshot) {
    this.cfg = cfg;
    const def = AIRPORT_BY_ID[cfg.airport];
    if (!def) throw new Error(`Unknown airport ${cfg.airport}`);
    this.airport = new AirportModel(def);
    this.rng = new Rng(cfg.seed);
    const w = WEATHER_PRESETS[cfg.weather];
    const cfgPick = cfg.runwayConfig === 'auto' ? def.runwayConfigs[this.rng.int(0, def.runwayConfigs.length - 1)] : def.runwayConfigs.find((c) => c.id === cfg.runwayConfig) ?? def.runwayConfigs[0];
    this.config = cfgPick;
    const windDir = wrap360(cfgPick.windFrom + this.rng.range(-25, 25));
    this.weather = { ...w, windDir, lightning: [] };
    this.weatherBase = { dir: windDir, spd: w.windSpeed };
    this.atis = this.rng.int(0, 25);
    this.ctx = this.makeContext();
    if (snap) this.restore(snap);
    else this.populate();
    this.refreshActive();
  }

  // ================================================================ context
  private makeContext(): SimContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const world = this;
    return {
      get t() {
        return world.t;
      },
      airport: this.airport,
      elevFt: this.airport.def.elevationFt,
      windAt: (alt) => this.windAt(alt),
      get aircraft() {
        return world.aircraft;
      },
      isActive: (rid) => this.activeSet.has(rid),
      runwayBlocked: (rw, self, h) => this.runwayBlocked(rw, self, h),
      say: (ac, p, urgent) => this.radio('pilot', ac.id, p, urgent),
      emit: (e) => this.events.push(e),
      score: (points, kind, reason, ids) => this.addScore(points, kind, reason, ids),
      get rng() {
        return world.rng;
      },
    };
  }

  get elev(): number {
    return this.airport.def.elevationFt;
  }

  get atisLetter(): string {
    return ATIS_LETTERS[this.atis % 26];
  }

  /** Local time of day in seconds. */
  get timeOfDay(): number {
    return (((this.cfg.startHour * 3600 + this.t) % 86400) + 86400) % 86400;
  }

  get remaining(): number | null {
    return this.cfg.durationMin === null ? null : Math.max(0, this.cfg.durationMin * 60 - this.t);
  }

  windAt(altFt: number): { x: number; y: number } {
    const agl = Math.max(0, altFt - this.elev);
    const spd = this.weather.windSpeed * (1 + Math.min(agl, 12000) / 12000) * KT;
    const dir = (this.weather.windDir + Math.min(agl, 10000) / 1000 * 1.5) * DEG;
    // Wind blows FROM dir: velocity points the other way.
    return { x: -Math.sin(dir) * spd, y: -Math.cos(dir) * spd };
  }

  private refreshActive(): void {
    this.activeSet = this.airport.activeRunwayIds(this.config);
    for (const a of this.aircraft) {
      if (a.appr) this.activeSet.add(this.airport.ends[a.appr]?.runwayId ?? '');
      if ((a.phase === 'landing' || a.phase === 'takeoff' || a.phase === 'lineup') && a.rwyEnd) this.activeSet.add(this.airport.ends[a.rwyEnd].runwayId);
    }
  }

  get arrivalEnds(): string[] {
    return this.config.arrivals;
  }

  get departureEnds(): string[] {
    return this.config.departures;
  }

  // ============================================================== messages
  private radio(from: 'atc' | 'pilot', id: string, p: Phrase, urgent = false): void {
    this.events.push({ type: 'radio', from, id, text: p.text, speech: p.speech, urgent });
    this.radioLog.push({ t: this.t, from, id, text: p.text, urgent });
    if (this.radioLog.length > 120) this.radioLog.splice(0, this.radioLog.length - 120);
  }

  private notice(text: string, level: 'info' | 'warn' | 'good' | 'bad'): void {
    this.events.push({ type: 'notice', text, level });
  }

  addScore(points: number, kind: ScoreEvent['kind'], reason: string, ids: string[]): void {
    const ev: ScoreEvent = { t: this.t, points, reason, kind, ids };
    this.score += points;
    if (kind !== 'bonus') this.stats.violations++;
    this.scoreLog.push(ev);
    if (this.scoreLog.length > 150) this.scoreLog.splice(0, this.scoreLog.length - 150);
    this.events.push({ type: 'score', ev });
  }

  byId(id: string): Aircraft | undefined {
    return this.aircraft.find((a) => a.id === id);
  }

  // ============================================================== spawning
  private newId(): string {
    this.idCounter++;
    return `AC${this.idCounter}`;
  }

  private pickAirline(cargoOk = true): Airline {
    const ap = this.airport.def.id;
    const pool: Airline[] = [];
    for (const a of AIRLINES) {
      if (a.cargo && !cargoOk) continue;
      const w = a.hubs?.includes(ap) ? 4 : a.hubs?.length ? 0.4 : a.cargo ? 0.6 : 1;
      for (let i = 0; i < Math.round(w * 5); i++) pool.push(a);
    }
    return this.rng.pick(pool);
  }

  private flightNumber(airline: string): string {
    for (let i = 0; i < 50; i++) {
      const n = this.rng.chance(0.3) ? this.rng.int(10, 99) : this.rng.chance(0.7) ? this.rng.int(100, 999) : this.rng.int(1000, 2999);
      const fn = String(n);
      if (!this.aircraft.some((a) => a.airlineCode === airline && a.flightNumber === fn)) return fn;
    }
    return String(this.rng.int(3000, 9999));
  }

  private registration(al: Airline): string {
    const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
    if (al.regPrefix === 'N') return `N${this.rng.int(100, 999)}${L[this.rng.int(0, L.length - 1)]}${L[this.rng.int(0, L.length - 1)]}`;
    let s = '';
    for (let i = 0; i < 3; i++) s += L[this.rng.int(0, L.length - 1)];
    return `${al.regPrefix}${s}`;
  }

  gateOccupied(gateId: string, except?: Aircraft): boolean {
    return this.aircraft.some(
      (a) => a !== except && a.gate === gateId && ['parked', 'ready', 'pushback', 'parking', 'taxiIn', 'clear', 'vacating', 'landing', 'final', 'approach', 'inbound', 'goaround'].includes(a.phase),
    );
  }

  private freeGate(size: AircraftTypeId, prefer?: string): string | null {
    const T = AIRCRAFT_TYPES[size];
    const order = { S: 0, M: 1, L: 2, H: 3 } as const;
    const free = this.airport.gates.filter((g) => gateFits(g.size, T.size) && !this.gateOccupied(g.id));
    if (!free.length) return null;
    free.sort((a, b) => order[a.size] - order[b.size] + (prefer && a.id.startsWith(prefer) ? -0.5 : 0) - (prefer && b.id.startsWith(prefer) ? -0.5 : 0));
    const best = order[free[0].size];
    const same = free.filter((g) => order[g.size] === best);
    return this.rng.pick(same).id;
  }

  /** Make room at the stands: tow away the aircraft that has been parked longest (not a departure). */
  private evictParked(size: AircraftTypeId): string | null {
    const T = AIRCRAFT_TYPES[size];
    const cands = this.aircraft
      .filter((a) => a.phase === 'parked' && a.gate && gateFits(this.airport.gateById[a.gate].size, T.size))
      .sort((a, b) => a.parkedAt - b.parkedAt);
    const v = cands[0];
    if (!v) return null;
    const g = v.gate;
    this.removeAircraft(v);
    return g;
  }

  private removeAircraft(a: Aircraft): void {
    this.aircraft = this.aircraft.filter((x) => x !== a);
    for (const k of [...this.pairs.keys()]) if (k.split('|').includes(a.id)) this.pairs.delete(k);
    this.holdPen.delete(a.id);
    this.events.push({ type: 'remove', id: a.id });
  }

  private placeParked(a: Aircraft, gateId: string): void {
    const g = this.airport.gateById[gateId];
    const p = this.airport.parkedPosition(g, a.type.length);
    a.gate = gateId;
    a.x = p[0];
    a.y = p[1];
    a.hdg = g.hdg;
    a.altFt = this.elev;
    a.onGround = true;
    a.gear = 1;
    a.ias = 0;
    a.enginesRunning = false;
    a.thrust = 0;
    a.lights = { nav: true, beacon: false, strobe: false, landing: false, taxi: false, logo: true, cabin: true };
    a.phase = 'parked';
    a.phaseT = this.t;
    a.parkedAt = this.t - this.rng.range(0, 1800);
    a.completed = true;
  }

  private makeAircraft(kind: 'arr' | 'dep', gateFirst: boolean): { a: Aircraft; gate: string } | null {
    for (let tries = 0; tries < 12; tries++) {
      const al = this.pickAirline();
      const typeId = this.rng.pick(al.fleet);
      let gate = this.freeGate(typeId, al.cargo ? 'C' : undefined);
      if (!gate && gateFirst) gate = this.evictParked(typeId);
      if (!gate) continue;
      const a = new Aircraft(this.newId(), al.code, this.flightNumber(al.code), typeId, this.registration(al), kind);
      a.spawnT = this.t;
      return { a, gate };
    }
    return null;
  }

  private populate(): void {
    const n = Math.round(this.airport.gates.length * this.cfg.initialParked);
    for (let i = 0; i < n; i++) {
      const m = this.makeAircraft('arr', false);
      if (!m) break;
      this.placeParked(m.a, m.gate);
      this.aircraft.push(m.a);
    }
    // A couple of departures ready soon, and first arrivals already inbound.
    this.nextDep = 25;
    this.nextArr = 5;
    this.spawnDeparture(20);
    this.spawnArrival(0.45);
    if (this.cfg.arrivalsPerHour >= 12) this.spawnArrival(0.75);
  }

  private spawnDeparture(readyIn: number): boolean {
    // Prefer turning around an aircraft already parked.
    const parked = this.aircraft.filter((a) => a.phase === 'parked' && a.gate && this.t - a.parkedAt > 240);
    let a: Aircraft;
    if (parked.length) {
      const src = this.rng.pick(parked);
      const al = AIRLINE_BY_CODE[src.airlineCode];
      a = new Aircraft(this.newId(), src.airlineCode, this.flightNumber(src.airlineCode), src.typeId, src.registration, 'dep');
      const gate = src.gate!;
      this.removeAircraft(src);
      this.placeParked(a, gate);
      void al;
    } else {
      const m = this.makeAircraft('dep', false);
      if (!m) return false;
      a = m.a;
      this.placeParked(a, m.gate);
    }
    a.completed = false;
    a.phase = 'ready';
    a.parkedAt = -1;
    a.readyAt = this.t + readyIn;
    a.spawnT = this.t;
    const exits = this.airport.def.departureExits;
    a.exitFix = this.rng.pick(exits).fix;
    a.lights.beacon = false;
    this.aircraft.push(a);
    this.events.push({ type: 'spawn', id: a.id });
    return true;
  }

  private spawnArrival(progress = 0): boolean {
    const def = this.airport.def;
    const m = this.makeAircraft('arr', true);
    if (!m) return false;
    const a = m.a;
    const gates = [...def.arrivalGates];
    // Pick an entry that is not crowded.
    for (let i = 0; i < 6; i++) {
      const g = this.rng.pick(gates);
      const f = this.airport.fixes[g.fix];
      const nxt = this.airport.fixes[g.route[0]];
      let x = f.pos[0];
      let y = f.pos[1];
      let alt = g.altitude;
      if (progress > 0 && nxt) {
        x = f.pos[0] + (nxt.pos[0] - f.pos[0]) * progress;
        y = f.pos[1] + (nxt.pos[1] - f.pos[1]) * progress;
        alt = Math.round((g.altitude - progress * 3000) / 1000) * 1000;
      }
      const crowded = this.aircraft.some((o) => !o.onGround && dist(o.x, o.y, x, y) < 6 * NM && Math.abs(o.altFt - alt) < 1500);
      if (crowded && i < 5) continue;
      if (crowded) return false;
      a.x = x;
      a.y = y;
      a.altFt = alt;
      a.asgAlt = alt;
      a.route = [...g.route];
      a.hdg = nxt ? bearing(x, y, nxt.pos[0], nxt.pos[1]) : bearing(x, y, 0, 0);
      a.trk = a.hdg;
      break;
    }
    a.gate = m.gate;
    a.onGround = false;
    a.gear = 0;
    a.flaps = 0;
    a.ias = Math.min(280, a.type.vmax - 20);
    a.enginesRunning = true;
    a.thrust = 0.5;
    a.phase = 'inbound';
    a.phaseT = this.t;
    a.fuelMin = this.rng.range(28, 55);
    a.lights = { nav: true, beacon: true, strobe: true, landing: false, taxi: false, logo: true, cabin: true };
    if (this.cfg.emergencyRate > 0 && this.rng.chance(this.cfg.emergencyRate)) a.emergencyPlannedAt = this.t + this.rng.range(45, 200);
    this.aircraft.push(a);
    this.events.push({ type: 'spawn', id: a.id });
    const alt = a.altFt;
    a.sayPilotLead(
      this.ctx,
      `Approach, descending to ${fmtAltitude(alt)}, information ${this.atisLetter}`,
      `approach, descending ${sayAltitude(alt)}, information ${letter(this.atisLetter)}`,
    );
    a.lastCallT = this.t;
    return true;
  }

  // ================================================================== step
  step(dt: number): void {
    if (this.ended) return;
    let rem = dt;
    while (rem > 1e-6) {
      const h = Math.min(0.1, rem);
      this.subStep(h);
      rem -= h;
    }
  }

  private subStep(dt: number): void {
    this.t += dt;
    const ctx = this.ctx;
    this.refreshActive();
    for (const a of this.aircraft) a.step(dt, ctx);
    this.monitorAircraft(dt);
    this.checkSeparation();
    this.checkRunways();
    this.updateWeather(dt);
    this.spawnTraffic();
    if (this.remaining === 0 && this.cfg.durationMin !== null && !this.ended) {
      this.ended = 'time';
      this.events.push({ type: 'shiftEnd', reason: 'time' });
    }
    if (this.score <= this.failScore && !this.ended) {
      this.ended = 'failed';
      this.events.push({ type: 'shiftEnd', reason: 'failed' });
    }
  }

  private spawnTraffic(): void {
    if (this.cfg.durationMin !== null && this.remaining! < 240) return; // wind down near the end
    if (this.t >= this.nextArr && this.cfg.arrivalsPerHour > 0) {
      const ok = this.spawnArrival();
      const mean = 3600 / this.cfg.arrivalsPerHour;
      this.nextArr = this.t + (ok ? Math.max(mean * 0.45, this.rng.exp(mean * 0.55) + mean * 0.45) : 20);
    }
    if (this.t >= this.nextDep && this.cfg.departuresPerHour > 0) {
      const waiting = this.aircraft.filter((a) => a.kind === 'dep' && ['ready', 'pushback', 'pushed'].includes(a.phase)).length;
      const ok = waiting < 4 && this.spawnDeparture(this.rng.range(3, 20));
      const mean = 3600 / this.cfg.departuresPerHour;
      this.nextDep = this.t + (ok ? Math.max(mean * 0.4, this.rng.exp(mean * 0.6) + mean * 0.4) : 30);
    }
  }

  private monitorAircraft(dt: number): void {
    const ap = this.airport;
    const def = ap.def;
    for (const a of [...this.aircraft]) {
      // Delays waiting for the controller.
      if (a.request && a.waitSince >= 0) {
        const w = this.t - a.waitSince;
        const limit = (a.request === 'landing' ? 40 : 100) + a.delayPenalized * 60;
        if (w > limit) {
          a.delayPenalized++;
          this.addScore(-10, 'delay', `${a.callsign} kept waiting (${a.request})`, [a.id]);
          if (a.request !== 'landing' && this.t - a.lastCallT > 50) this.repeatRequest(a);
        }
      }
      // Excessive holding.
      if (a.hold && a.holdingSince >= 0) {
        const n = this.holdPen.get(a.id) ?? 0;
        if (this.t - a.holdingSince > 300 + n * 90) {
          this.holdPen.set(a.id, n + 1);
          this.addScore(-10, 'delay', `${a.callsign} holding too long`, [a.id]);
        }
      } else if (this.holdPen.has(a.id) && !a.hold) this.holdPen.delete(a.id);
      // Emergencies.
      if (a.emergencyPlannedAt > 0 && this.t >= a.emergencyPlannedAt && !a.onGround && a.kind === 'arr' && !a.emergency) {
        a.emergencyPlannedAt = -1;
        this.declareEmergency(a, this.rng.pick(['engine', 'medical', 'hydraulic'] as Emergency[]));
      }
      if (a.emergency && a.emergencyAt >= 0 && this.t - a.emergencyAt > 900 && !a.onGround) {
        a.emergencyAt = -2;
        this.addScore(-120, 'emergencyDelay', `${a.callsign} emergency not landed within 15 minutes`, [a.id]);
      }
      // Fuel.
      if (!a.onGround && a.kind === 'arr') {
        if (a.fuelMin < 12 && !a.minFuelCalled) {
          a.minFuelCalled = true;
          a.sayPilotLead(this.ctx, 'declaring minimum fuel', 'declaring minimum fuel');
        }
        if (a.fuelMin < 6 && a.emergency !== 'fuel' && !a.emergency) this.declareEmergency(a, 'fuel');
        if (a.fuelMin <= 0) {
          this.addScore(-200, 'fuel', `${a.callsign} diverted — out of fuel`, [a.id]);
          a.sayPilotLead(this.ctx, 'diverting to alternate, fuel critical', 'diverting to alternate, fuel critical', true);
          this.removeAircraft(a);
          continue;
        }
      }
      // Airspace boundary.
      if (!a.onGround) {
        const r = Math.hypot(a.x, a.y);
        if (a.kind === 'dep' && r > ap.airspaceRadiusM) {
          const exitDef = def.departureExits.find((e) => e.fix === a.exitFix);
          const minAlt = exitDef?.minAltitude ?? 10000;
          const fix = a.exitFix ? ap.fixes[a.exitFix] : undefined;
          const nearFix = fix ? dist(a.x, a.y, fix.pos[0], fix.pos[1]) < 6 * NM : true;
          if (a.handedOff && a.altFt >= minAlt - 500 && nearFix) {
            this.addScore(60, 'bonus', `${a.callsign} departed via ${a.exitFix}`, [a.id]);
          } else if (!a.handedOff) {
            this.addScore(-40, 'exitAltitude', `${a.callsign} left the airspace without a hand-off`, [a.id]);
          } else {
            this.addScore(-30, 'exitAltitude', `${a.callsign} left ${nearFix ? `below ${fmtAltitude(minAlt)} ft` : `away from ${a.exitFix}`}`, [a.id]);
          }
          this.stats.departed++;
          a.phase = 'exited';
          this.removeAircraft(a);
          continue;
        }
        if (a.kind === 'arr' && r > ap.airspaceRadiusM + 3 * NM) {
          this.addScore(-100, 'leftAirspace', `${a.callsign} left the airspace`, [a.id]);
          this.removeAircraft(a);
          continue;
        }
        // Low altitude outside the final approach.
        const agl = a.altFt - this.elev;
        const onApp = a.apprState === 'loc' || a.apprState === 'gs' || a.phase === 'landing' || a.phase === 'takeoff' || a.phase === 'goaround' || a.phase === 'climbout';
        if (!onApp && r > 8 * NM && a.altFt < def.mva - 150 && agl > 0) {
          const k = `low:${a.id}`;
          const last = this.lowWarn.get(k) ?? -999;
          if (this.t - last > 30) {
            this.lowWarn.set(k, this.t);
            this.addScore(-30, 'lowAltitude', `${a.callsign} below minimum vectoring altitude`, [a.id]);
          }
        }
      }
      // Arrival stats.
      if (a.kind === 'arr' && a.phase === 'clear' && !a.countedLanded) {
        a.countedLanded = true;
        this.stats.landed++;
        if (a.emergency) {
          this.addScore(80, 'bonus', `${a.callsign} emergency handled`, [a.id]);
          a.emergency = null;
        }
      }
      if (a.phase === 'parked' && a.kind === 'arr' && a.parkedAt === this.t) this.stats.parked++;
      if (a.goArounds > (a.countedGA ?? 0)) {
        a.countedGA = a.goArounds;
        this.stats.goArounds++;
      }
    }
    void dt;
  }

  private lowWarn = new Map<string, number>();

  private repeatRequest(a: Aircraft): void {
    const say: Record<string, [string, string]> = {
      pushback: ['request pushback', 'request pushback'],
      taxi: ['ready to taxi', 'ready to taxi'],
      taxiGate: ['request taxi to the stand', 'request taxi to the stand'],
      crossing: ['still holding short, request crossing', 'still holding short, request crossing'],
      takeoff: ['ready for departure', 'ready for departure'],
    };
    const s = a.request ? say[a.request] : undefined;
    if (s) a.sayPilotLead(this.ctx, s[0], s[1]);
  }

  private declareEmergency(a: Aircraft, kind: Emergency): void {
    a.emergency = kind;
    a.emergencyAt = this.t;
    this.stats.emergencies++;
    const what: Record<string, string> = { engine: 'engine failure', medical: 'medical emergency on board', hydraulic: 'hydraulic failure', fuel: 'fuel emergency' };
    const w = what[kind ?? 'engine'];
    const rw = this.config.arrivals[0];
    const pre = kind === 'medical' ? 'Pan-pan, pan-pan, pan-pan' : 'Mayday, mayday, mayday';
    a.sayPilotLead(this.ctx, `${pre}, ${w}, request priority landing runway ${rw}`, `${pre.toLowerCase()}, ${w}, request priority landing runway ${sayRunway(rw)}`, true);
    this.events.push({ type: 'emergency', id: a.id, kind });
    this.notice(`${a.callsign} declared an emergency: ${w}`, 'bad');
  }

  // ============================================================ separation
  private pairKey(a: Aircraft, b: Aircraft): string {
    return a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
  }

  /** Required lateral separation (NM) for two airborne aircraft. */
  private requiredSep(a: Aircraft, b: Aircraft): number {
    // Tower environment: close to the field and low, runway / visual separation applies instead.
    const tower = (x: Aircraft): boolean => Math.hypot(x.x, x.y) < 5 * NM && x.altFt - this.elev < 2500;
    if (tower(a) || tower(b)) return 0;
    const estA = a.apprState === 'loc' || a.apprState === 'gs';
    const estB = b.apprState === 'loc' || b.apprState === 'gs';
    if (estA && estB && a.appr === b.appr) return 2.5;
    // Established on parallel / different finals: treat as independent.
    if (estA && estB && a.appr !== b.appr) return 0;
    return 3;
  }

  private checkSeparation(): void {
    const air = this.aircraft.filter((a) => !a.onGround && a.phase !== 'exited' && a.altFt - this.elev > 300);
    const seen = new Set<string>();
    for (let i = 0; i < air.length; i++) {
      for (let j = i + 1; j < air.length; j++) {
        const a = air[i];
        const b = air[j];
        const key = this.pairKey(a, b);
        seen.add(key);
        const d = dist(a.x, a.y, b.x, b.y) / NM;
        const dv = Math.abs(a.altFt - b.altFt);
        let st = this.pairs.get(key);
        if (!st) {
          if (d > 12) continue;
          st = { loss: false, since: 0, lastPen: 0, predicted: false, wake: false, tcas: false };
          this.pairs.set(key, st);
        }
        const req = this.requiredSep(a, b);
        const loss = req > 0 && d < req && dv < 950;
        if (loss && !st.loss) {
          st.loss = true;
          st.since = this.t;
          st.lastPen = this.t;
          this.stats.separationLosses++;
          this.addScore(-100, 'separation', `Loss of separation: ${a.callsign} / ${b.callsign}`, [a.id, b.id]);
          this.events.push({ type: 'conflict', ids: [a.id, b.id], level: 'loss' });
        } else if (loss && this.t - st.lastPen > 20) {
          st.lastPen = this.t;
          this.addScore(-20, 'separation', `Separation still lost: ${a.callsign} / ${b.callsign}`, [a.id, b.id]);
        } else if (!loss && st.loss) {
          st.loss = false;
          this.events.push({ type: 'conflict', ids: [a.id, b.id], level: 'clear' });
        }
        // Short-term conflict prediction (60 s).
        if (!loss && req > 0) {
          const T = 60;
          const ax = a.x + a.vel.x * T;
          const ay = a.y + a.vel.y * T;
          const bx = b.x + b.vel.x * T;
          const by = b.y + b.vel.y * T;
          const dp = Math.min(d, dist(ax, ay, bx, by) / NM, dist((a.x + ax) / 2, (a.y + ay) / 2, (b.x + bx) / 2, (b.y + by) / 2) / NM);
          const dvp = Math.abs(a.altFt + a.vs - (b.altFt + b.vs));
          const pred = dp < req && Math.min(dv, dvp) < 950;
          if (pred !== st.predicted) {
            st.predicted = pred;
            this.events.push({ type: 'conflict', ids: [a.id, b.id], level: pred ? 'predicted' : 'clear' });
          }
        }
        // TCAS resolution advisory.
        if (d < 1.0 && dv < 600 && !st.tcas) {
          st.tcas = true;
          const up = a.altFt >= b.altFt ? a : b;
          const dn = up === a ? b : a;
          up.tcasUntil = this.t + 25;
          up.tcasVs = 2000;
          dn.tcasUntil = this.t + 25;
          dn.tcasVs = -1500;
          up.sayPilotLead(this.ctx, 'TCAS RA', 'T-CAS R-A', true);
          this.addScore(-50, 'tcas', `TCAS resolution advisory: ${a.callsign} / ${b.callsign}`, [a.id, b.id]);
        } else if (d > 2 && st.tcas) st.tcas = false;
        // Wake turbulence on the same final.
        if (a.appr && a.appr === b.appr && (a.apprState === 'gs' || a.apprState === 'loc') && (b.apprState === 'gs' || b.apprState === 'loc')) {
          const end = this.airport.ends[a.appr];
          const da = -this.airport.endLocal(end, a.x, a.y).along;
          const db = -this.airport.endLocal(end, b.x, b.y).along;
          const [lead, foll] = da < db ? [a, b] : [b, a];
          const need = WAKE_SEP_NM[lead.type.wake][foll.type.wake];
          if (need && d < need - 0.2 && !st.wake) {
            st.wake = true;
            this.addScore(-60, 'wake', `Wake separation ${need} NM: ${foll.callsign} behind ${lead.callsign}`, [lead.id, foll.id]);
          } else if (need && d > need + 0.5) st.wake = false;
        }
      }
    }
    for (const k of [...this.pairs.keys()]) {
      if (!seen.has(k)) {
        const st = this.pairs.get(k)!;
        if (st.loss || st.predicted) {
          const ids = k.split('|') as [string, string];
          this.events.push({ type: 'conflict', ids, level: 'clear' });
        }
        this.pairs.delete(k);
      }
    }
  }

  conflictLevel(id: string): 'loss' | 'predicted' | null {
    let lvl: 'loss' | 'predicted' | null = null;
    for (const [k, st] of this.pairs) {
      if (!k.split('|').includes(id)) continue;
      if (st.loss) return 'loss';
      if (st.predicted) lvl = 'predicted';
    }
    return lvl;
  }

  conflictPairs(): { ids: [string, string]; level: 'loss' | 'predicted' }[] {
    const out: { ids: [string, string]; level: 'loss' | 'predicted' }[] = [];
    for (const [k, st] of this.pairs) {
      if (st.loss || st.predicted) out.push({ ids: k.split('|') as [string, string], level: st.loss ? 'loss' : 'predicted' });
    }
    return out;
  }

  // ================================================================ runways
  private incursions = new Set<string>();

  /** Aircraft occupying the runway surface (or about to). */
  runwayBlocked(rw: Runway, self: Aircraft, horizonS: number): Aircraft | null {
    const ap = this.airport;
    for (const o of this.aircraft) {
      if (o === self || o.phase === 'exited') continue;
      if (o.onGround) {
        if (o.phase === 'parked' || o.phase === 'ready' || o.phase === 'holding') continue;
        if (ap.onRunway(rw, o.x, o.y, 4, 10)) return o;
      } else {
        const agl = o.altFt - this.elev;
        if ((o.phase === 'takeoff' || o.phase === 'landing') && agl < 250 && ap.onRunway(rw, o.x, o.y, 30, 150) && o !== self) {
          if (o.phase === 'landing' || self.phase !== 'final') return o;
        }
        if (horizonS > 0 && self.onGround && o.appr && ap.ends[o.appr].runwayId === rw.id && (o.apprState === 'gs' || o.apprState === 'loc')) {
          const d = -ap.endLocal(ap.ends[o.appr], o.x, o.y).along;
          if (d > -200 && d / Math.max(o.gsKt * KT, 50) < horizonS) return o;
        }
      }
    }
    return null;
  }

  private checkRunways(): void {
    const ap = this.airport;
    for (const rw of ap.runways) {
      // Fast movers on this runway: landing roll / take-off roll / short final.
      const fast = this.aircraft.filter(
        (a) =>
          ((a.phase === 'landing' || a.phase === 'takeoff') && ap.onRunway(rw, a.x, a.y, 20, 60) && a.altFt - this.elev < 200) ||
          (a.phase === 'final' && a.appr && ap.ends[a.appr].runwayId === rw.id && -ap.endLocal(ap.ends[a.appr], a.x, a.y).along < 0.4 * NM && a.landClr === a.appr),
      );
      if (!fast.length) continue;
      for (const f of fast) {
        for (const o of this.aircraft) {
          if (o === f || !o.onGround || o.phase === 'parked') continue;
          if (!ap.onRunway(rw, o.x, o.y, 2, 0)) continue;
          // Separation along the runway: landing traffic behind a departure that is already rolling is fine.
          if (f.phase === 'landing' && o.phase === 'takeoff' && o.ias > 80) continue;
          if (f.phase === 'takeoff' && o.phase === 'takeoff') continue;
          if (f.phase === 'final' && (o.phase === 'takeoff' || o.phase === 'vacating')) continue;
          if (f.phase === 'takeoff' && o.phase === 'vacating') {
            // Rolling towards an aircraft still on the runway ahead.
            const end = ap.ends[f.rwyEnd!];
            if (ap.endLocal(end, o.x, o.y).along < ap.endLocal(end, f.x, f.y).along) continue;
          }
          if (f.phase === 'landing' && o.phase === 'landing') continue;
          const key = [f.id, o.id].sort().join('|');
          if (this.incursions.has(key)) continue;
          this.incursions.add(key);
          this.stats.incursions++;
          this.addScore(-150, 'runwayIncursion', `Runway incursion: ${o.callsign} on runway ${rw.id} with ${f.callsign}`, [f.id, o.id]);
          this.notice(`Runway incursion on ${rw.id}!`, 'bad');
        }
      }
    }
  }

  // ================================================================ weather
  private updateWeather(dt: number): void {
    const w = this.weather;
    // Slow drift of wind direction and speed.
    const k = Math.min(1, dt * 0.01);
    w.windDir = wrap360(w.windDir + (this.rng.next() - 0.5) * dt * 0.8 + angleDiff(w.windDir, this.weatherBase.dir) * k);
    w.windSpeed = clamp(w.windSpeed + (this.rng.next() - 0.5) * dt * 0.3 + (this.weatherBase.spd - w.windSpeed) * k, 0, 45);
    if (w.thunderstorm) {
      if (this.t >= this.nextStrike) {
        const ang = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(2500, 22000);
        const s: LightningStrike = { id: ++this.strikeId, t: this.t, x: Math.sin(ang) * r, y: Math.cos(ang) * r };
        w.lightning.push(s);
        this.nextStrike = this.t + this.rng.range(3, 16);
      }
      w.lightning = w.lightning.filter((s) => this.t - s.t < 10);
    }
  }

  get windText(): string {
    return fmtWind(this.weather.windDir, this.weather.windSpeed, this.weather.gust);
  }

  // =============================================================== commands
  private atc(a: Aircraft, text: string, speech: string, urgent = false): Phrase {
    const p = { text: `${a.displayCallsign}, ${text}`, speech: `${a.spokenCallsign}, ${speech}` };
    this.radio('atc', a.id, p, urgent);
    return p;
  }

  private readback(a: Aircraft, text: string, speech: string): Phrase {
    const p = { text: `${cap(text)}, ${a.displayCallsign}`, speech: `${speech}, ${a.spokenCallsign}` };
    a.lastCallT = this.t;
    // Pilots answer after a short pause (the shell queues radio audio in order).
    this.radio('pilot', a.id, p);
    return p;
  }

  private unable(a: Aircraft, why: string): CommandResult {
    return { ok: false, error: `${a.callsign}: ${why}` };
  }

  private resolveEnd(name: string | undefined, fallback: string[]): string | null {
    if (name && this.airport.ends[name]) return name;
    if (name) {
      // Runway id like "09/27" -> first listed end in use.
      const rw = this.airport.runways.find((r) => r.id === name);
      if (rw) return rw.ends.find((e) => fallback.includes(e.name))?.name ?? rw.ends[0].name;
    }
    return fallback[0] ?? null;
  }

  private setPath(a: Aircraft, r: TaxiRoute, prefix?: Vec2): void {
    const pts = r.points.map((p) => [p[0], p[1]] as Vec2);
    const holds = r.holds.map((h) => ({ ...h }));
    const nodes = [...r.nodes];
    if (prefix) {
      pts.unshift(prefix);
      nodes.unshift(-1);
      for (const h of holds) {
        h.idx++;
        h.exitIdx++;
      }
    }
    a.path = { points: pts, idx: 0, holds, names: r.names, nodes };
    a.holdPos = false;
  }

  private holdsText(r: TaxiRoute): { text: string; speech: string } {
    const names: string[] = [];
    for (const h of r.holds) {
      const rw = this.airport.runwayById(h.runwayId);
      if (!this.activeSet.has(rw.id)) continue;
      if (!names.includes(rw.id)) names.push(rw.id);
    }
    if (!names.length) return { text: '', speech: '' };
    const disp = names.map((n) => n.replace('/', '/'));
    const sp = names.map((n) => n.split('/').map(sayRunway).join(' ')); // e.g. "two six zero eight"
    return { text: `, hold short runway ${disp.join(', ')}`, speech: `, hold short runway ${sp.join(', ')}` };
  }

  private viaText(r: TaxiRoute): { text: string; speech: string } {
    const names = r.names.filter((n) => n && !/^RWY/.test(n)).slice(0, 5);
    if (!names.length) return { text: '', speech: '' };
    return { text: ` via ${names.join(', ')}`, speech: ` via ${names.map(sayTaxiway).join(', ')}` };
  }

  command(id: string, c: Command): CommandResult {
    const a = this.byId(id);
    if (!a) return { ok: false, error: 'No such aircraft' };
    const r = this.execute(a, c);
    if (r.ok) this.stats.commands++;
    return r;
  }

  /** Commands available for an aircraft in its current state (drives the UI). */
  available(a: Aircraft): Set<Command['kind']> {
    const s = new Set<Command['kind']>();
    const airborne = !a.onGround && a.phase !== 'landing' && a.phase !== 'takeoff';
    if (airborne) {
      s.add('heading');
      s.add('speed');
      s.add('direct');
      if (!(a.apprState === 'gs')) s.add('altitude');
      if (a.kind === 'arr') {
        s.add('hold');
        s.add('approach');
        if (a.appr || a.phase === 'final') s.add('land');
        if (a.phase === 'final' || a.phase === 'approach') s.add('goAround');
      }
      if (a.kind === 'dep' && (a.phase === 'climbout' || a.phase === 'inbound') && !a.handedOff) s.add('handoff');
    }
    if (a.phase === 'landing' && !a.onGround) s.add('goAround');
    if (a.phase === 'ready') s.add('pushback');
    if (a.phase === 'pushed' || a.phase === 'holding' || a.phase === 'taxiOut') s.add('taxi');
    if (a.phase === 'clear' || a.phase === 'taxiIn') s.add('taxiGate');
    if (['taxiOut', 'taxiIn', 'vacating'].includes(a.phase)) {
      s.add(a.holdPos ? 'continueTaxi' : 'holdPosition');
    }
    if (a.request === 'crossing' || ((a.phase === 'taxiOut' || a.phase === 'taxiIn') && a.path?.holds.some((h) => h.idx >= a.path!.idx && !a.cleared.includes(h.runwayId)))) s.add('cross');
    if (a.phase === 'holding' || a.phase === 'taxiOut') s.add('lineUp');
    if (a.phase === 'holding' || a.phase === 'lineup' || a.phase === 'taxiOut') s.add('takeoff');
    if ((a.phase === 'lineup' || a.phase === 'taxiOut' || a.phase === 'holding') && a.toClr) s.add('cancelTakeoff');
    return s;
  }

  private execute(a: Aircraft, c: Command): CommandResult {
    const ap = this.airport;
    const def = ap.def;
    const ctx = this.ctx;
    const avail = this.available(a);
    if (!avail.has(c.kind)) return this.unable(a, `"${c.kind}" is not possible now (${a.phase})`);
    switch (c.kind) {
      case 'heading': {
        const h = wrap360(Math.round(c.hdg)) || 360;
        const dir = c.turn ?? (angleDiff(a.hdg, h) < 0 ? 'L' : 'R');
        const word = dir === 'L' ? 'left' : 'right';
        const wasApp = a.apprState;
        a.asgHdg = h % 360;
        a.turnDir = c.turn ?? null;
        a.direct = null;
        a.hold = null;
        a.holdingSince = -1;
        a.route = [];
        let extra = { t: '', s: '' };
        if (wasApp === 'loc' || wasApp === 'gs') {
          a.apprState = null;
          a.appr = null;
          a.landClr = null;
          a.reportedFinal = false;
          a.setPhase('inbound', ctx);
          if (a.request === 'landing') a.setRequest(null, ctx);
        } else if (wasApp === 'armed') {
          extra = { t: ', maintain until established', s: ', maintain until established' };
        }
        this.atc(a, `turn ${word} heading ${fmtHeading(h)}${extra.t}`, `turn ${word} heading ${sayHeading(h)}${extra.s}`);
        this.readback(a, `${word} heading ${fmtHeading(h)}`, `${word} heading ${sayHeading(h)}`);
        return { ok: true };
      }
      case 'altitude': {
        const alt = Math.round(c.alt / 100) * 100;
        const minAlt = Math.hypot(a.x, a.y) < 12 * NM ? Math.min(def.mva, def.missedApproachAlt) : def.mva;
        if (alt < minAlt) return this.unable(a, `minimum ${fmtAltitude(minAlt)} ft here`);
        if (alt > a.type.ceilingFt) return this.unable(a, 'above the aircraft ceiling');
        const verb = alt > a.altFt + 50 ? 'climb' : alt < a.altFt - 50 ? 'descend' : 'maintain';
        const exp = c.expedite && verb !== 'maintain';
        a.asgAlt = alt;
        a.expedite = !!exp;
        if (a.apprState === 'loc' && alt > a.altFt) {
          a.apprState = null;
          a.appr = null;
          a.landClr = null;
          a.setPhase('inbound', ctx);
        }
        const verbTxt = verb === 'maintain' ? 'maintain' : `${exp ? 'expedite ' : ''}${verb} and maintain`;
        this.atc(a, `${verbTxt} ${fmtAltitude(alt)}`, `${verbTxt} ${sayAltitude(alt)}`);
        this.readback(a, `${verb === 'maintain' ? 'maintain' : verb} ${fmtAltitude(alt)}`, `${verb} ${sayAltitude(alt)}`);
        return { ok: true };
      }
      case 'speed': {
        if (c.spd === null) {
          a.asgSpd = null;
          this.atc(a, 'resume normal speed', 'resume normal speed');
          this.readback(a, 'resume normal speed', 'resume normal speed');
          return { ok: true };
        }
        const T = a.type;
        const lo = Math.max(T.vapp + (a.apprState ? 20 : 45), 160);
        const spd = clamp(Math.round(c.spd / 10) * 10, 0, 400);
        if (spd < lo) return this.unable(a, `minimum speed ${lo} kt`);
        if (spd > Math.min(T.vmax, a.altFt < 10000 ? 250 : T.vmax)) return this.unable(a, `maximum ${a.altFt < 10000 ? 250 : T.vmax} kt`);
        a.asgSpd = spd;
        this.atc(a, `maintain ${spd} knots`, `maintain ${saySpeed(spd)} knots`);
        this.readback(a, `${spd} knots`, `${saySpeed(spd)} knots`);
        return { ok: true };
      }
      case 'direct': {
        const f = ap.fixes[c.fix];
        if (!f) return this.unable(a, 'unknown fix');
        a.direct = c.fix;
        a.asgHdg = null;
        a.turnDir = null;
        a.hold = null;
        a.holdingSince = -1;
        if (a.apprState === 'loc' || a.apprState === 'gs') {
          a.apprState = null;
          a.appr = null;
          a.landClr = null;
          a.setPhase('inbound', ctx);
        }
        this.atc(a, `proceed direct ${c.fix}`, `proceed direct ${sayFix(c.fix)}`);
        this.readback(a, `direct ${c.fix}`, `direct ${sayFix(c.fix)}`);
        return { ok: true };
      }
      case 'hold': {
        const f = ap.fixes[c.fix];
        if (!f) return this.unable(a, 'unknown fix');
        a.direct = null;
        a.asgHdg = null;
        a.route = [];
        a.hold = { fix: c.fix, inbound: bearing(a.x, a.y, f.pos[0], f.pos[1]), leg: 'toFix', legT: this.t };
        a.holdingSince = this.t;
        this.atc(a, `hold at ${c.fix} as published, maintain ${fmtAltitude(a.asgAlt)}`, `hold at ${sayFix(c.fix)} as published, maintain ${sayAltitude(a.asgAlt)}`);
        this.readback(a, `hold at ${c.fix}`, `hold at ${sayFix(c.fix)}`);
        return { ok: true };
      }
      case 'approach': {
        const endName = this.resolveEnd(c.runway, this.config.arrivals);
        const end = endName ? ap.ends[endName] : undefined;
        if (!end || !end.ils) return this.unable(a, 'no ILS for that runway');
        a.appr = end.name;
        a.apprState = 'armed';
        a.hold = null;
        a.holdingSince = -1;
        a.setPhase('approach', ctx);
        let via = '';
        let viaS = '';
        if (a.asgHdg === null) {
          // Not on vectors: join via the intermediate fix on the extended centreline.
          const ifs = Object.values(ap.fixes)
            .filter((f) => f.role === 'if')
            .map((f) => ({ f, l: ap.endLocal(end, f.pos[0], f.pos[1]) }))
            .filter((x) => x.l.along < -3 * NM && Math.abs(x.l.lat) < 800)
            .sort((p, q) => q.l.along - p.l.along);
          const pick = ifs.find((x) => dist(a.x, a.y, x.f.pos[0], x.f.pos[1]) > 4 * NM && x.l.along < -7 * NM) ?? ifs[ifs.length - 1];
          if (pick) {
            a.direct = pick.f.id;
            a.route = [];
            via = ` via ${pick.f.id}`;
            viaS = ` via ${sayFix(pick.f.id)}`;
            const tgt = Math.max(def.missedApproachAlt, Math.round(ap.glideslopeAlt(-pick.l.along) / 100) * 100 - 200);
            if (a.asgAlt > tgt) a.asgAlt = tgt;
          }
        }
        const altTxt = a.asgAlt > def.missedApproachAlt + 1500 ? '' : '';
        this.atc(a, `cleared ILS approach runway ${end.name}${via}${altTxt}`, `cleared I-L-S approach runway ${sayRunway(end.name)}${viaS}`);
        this.readback(a, `cleared ILS runway ${end.name}${via}`, `cleared I-L-S runway ${sayRunway(end.name)}${viaS}`);
        return { ok: true };
      }
      case 'land': {
        const endName = a.appr ?? this.resolveEnd(c.runway, this.config.arrivals);
        if (!endName) return this.unable(a, 'no runway');
        a.landClr = endName;
        if (a.request === 'landing') a.setRequest(null, ctx);
        const w = this.weather;
        const blocked = this.runwayBlocked(ap.runwayOfEnd(endName), a, 0);
        if (blocked) this.notice(`Caution: runway ${endName} is occupied by ${blocked.callsign}`, 'warn');
        this.atc(a, `wind ${fmtWind(w.windDir, w.windSpeed, w.gust)}, runway ${endName}, cleared to land`, `${sayWind(w.windDir, w.windSpeed, w.gust)}, runway ${sayRunway(endName)}, cleared to land`);
        this.readback(a, `cleared to land runway ${endName}`, `cleared to land runway ${sayRunway(endName)}`);
        return { ok: true };
      }
      case 'goAround': {
        this.atc(a, 'go around, I say again, go around', 'go around, I say again, go around', true);
        a.goAround(ctx, 'atc', `${a.callsign} sent around by ATC`);
        return { ok: true };
      }
      case 'pushback': {
        const ends = this.config.departures;
        let best: { end: string; len: number } | null = null;
        const gate = ap.gateById[a.gate!];
        for (const e of ends) {
          const r = a.bestEntry(ctx, gate.spotNode, e);
          if (r && (!best || r.route.length < best.len)) best = { end: e, len: r.route.length };
        }
        if (!best) return this.unable(a, 'no route to a departure runway');
        const blocker = this.aircraft.find((o) => o !== a && o.onGround && o.phase !== 'parked' && o.phase !== 'ready' && dist(o.x, o.y, ap.nodes[gate.spotNode].x, ap.nodes[gate.spotNode].y) < 70);
        if (blocker) return this.unable(a, `traffic behind (${blocker.callsign})`);
        a.planPushback(ctx, best.end);
        a.setPhase('pushback', ctx);
        a.setRequest(null, ctx);
        a.lights.beacon = true;
        this.atc(a, `push and start approved, facing ${this.faceDir(a)}`, `push and start approved, facing ${this.faceDir(a)}`);
        this.readback(a, 'push and start approved', 'push and start approved');
        return { ok: true };
      }
      case 'taxi': {
        const endName = this.resolveEnd(c.runway, this.config.departures);
        if (!endName) return this.unable(a, 'no runway');
        let from: number;
        let avoid: number | undefined;
        if (a.phase === 'pushed') from = ap.gateById[a.gate!].spotNode;
        else {
          from = this.nodeAhead(a);
          avoid = undefined;
        }
        const e = a.bestEntry(ctx, from, endName, avoid);
        if (!e) return this.unable(a, `no taxi route to runway ${endName}`);
        this.setPath(a, e.route, [a.x, a.y]);
        a.rwyEnd = endName;
        a.cleared = [];
        a.toClr = false;
        a.taxiLimit = 18;
        if (a.phase === 'pushed') a.gate = null;
        a.setPhase('taxiOut', ctx);
        a.setRequest(null, ctx);
        a.lights.taxi = true;
        const via = this.viaText(e.route);
        const hs = this.holdsText(e.route);
        this.atc(a, `taxi to holding point runway ${endName}${via.text}${hs.text}`, `taxi to holding point runway ${sayRunway(endName)}${via.speech}${hs.speech}`);
        this.readback(a, `taxi holding point runway ${endName}${via.text}${hs.text}`, `taxi holding point runway ${sayRunway(endName)}${via.speech}${hs.speech}`);
        return { ok: true };
      }
      case 'taxiGate': {
        if (!a.gate || this.gateOccupied(a.gate, a)) {
          const g = this.freeGate(a.typeId) ?? this.evictParked(a.typeId);
          if (!g) return this.unable(a, 'no free stand');
          a.gate = g;
        }
        const gate = ap.gateById[a.gate];
        let from: number;
        let avoid: number | undefined;
        if (a.phase === 'clear' && a.vacateNext >= 0) {
          from = a.vacateNext;
          avoid = a.exitHold;
        } else {
          from = this.nodeAhead(a);
        }
        let r = ap.route(from, gate.spotNode, { avoidFirstNode: avoid });
        if (!r) r = ap.route(from, gate.spotNode);
        if (!r) return this.unable(a, 'no taxi route to the stand');
        this.setPath(a, r, [a.x, a.y]);
        a.cleared = [];
        a.taxiLimit = 18;
        a.setPhase('taxiIn', ctx);
        a.setRequest(null, ctx);
        const via = this.viaText(r);
        const hs = this.holdsText(r);
        this.atc(a, `taxi to stand ${gate.id}${via.text}${hs.text}`, `taxi to stand ${sayTaxiway(gate.id)}${via.speech}${hs.speech}`);
        this.readback(a, `stand ${gate.id}${via.text}${hs.text}`, `stand ${sayTaxiway(gate.id)}${via.speech}${hs.speech}`);
        return { ok: true };
      }
      case 'holdPosition': {
        a.holdPos = true;
        this.atc(a, 'hold position', 'hold position');
        this.readback(a, 'holding position', 'holding position');
        return { ok: true };
      }
      case 'continueTaxi': {
        a.holdPos = false;
        this.atc(a, 'continue taxi', 'continue taxi');
        this.readback(a, 'continue taxi', 'continue taxi');
        return { ok: true };
      }
      case 'cross': {
        let rid = a.request === 'crossing' ? a.requestRwy : null;
        if (!rid && a.path) {
          const h = a.path.holds.find((hh) => hh.idx >= a.path!.idx && !a.cleared.includes(hh.runwayId));
          rid = h?.runwayId ?? null;
        }
        if (c.runway && ap.runways.some((r) => r.id === c.runway)) rid = c.runway;
        if (!rid) return this.unable(a, 'no runway to cross');
        const rw = ap.runwayById(rid);
        const blocked = this.runwayBlocked(rw, a, 25);
        if (blocked) this.notice(`Caution: ${blocked.callsign} is using runway ${rid}`, 'warn');
        if (!a.cleared.includes(rid)) a.cleared.push(rid);
        if (a.request === 'crossing') a.setRequest(null, ctx);
        const name = a.nearestRunwayEndName(rw);
        this.atc(a, `cross runway ${name}`, `cross runway ${sayRunway(name)}`);
        this.readback(a, `crossing runway ${name}`, `crossing runway ${sayRunway(name)}`);
        return { ok: true };
      }
      case 'lineUp': {
        const end = a.rwyEnd!;
        if (a.phase === 'taxiOut') {
          a.luawPending = true;
          this.atc(a, `at the holding point, line up and wait runway ${end}`, `at the holding point, line up and wait runway ${sayRunway(end)}`);
        } else {
          a.beginLineup(ctx);
          this.atc(a, `runway ${end}, line up and wait`, `runway ${sayRunway(end)}, line up and wait`);
        }
        a.setRequest(null, ctx);
        this.readback(a, `line up and wait runway ${end}`, `line up and wait runway ${sayRunway(end)}`);
        this.activeSet.add(ap.ends[end].runwayId);
        return { ok: true };
      }
      case 'takeoff': {
        const end = a.rwyEnd!;
        const e = ap.ends[end];
        const hdg = c.hdg !== undefined ? wrap360(Math.round(c.hdg)) : null;
        const alt = c.alt ?? def.initialClimb;
        // Departure wake interval on the same runway.
        const last = this.lastDep.get(e.runwayId);
        if (last) {
          const need = WAKE_DEP_SEC[last.wake as keyof typeof WAKE_DEP_SEC]?.[a.type.wake];
          if (need && this.t - last.t < need) {
            this.addScore(-50, 'wake', `${a.callsign} cleared for take-off ${Math.round(this.t - last.t)} s behind a ${last.wake === 'J' ? 'super' : 'heavy'} (${need} s required)`, [a.id]);
          }
        }
        this.lastDep.set(e.runwayId, { t: this.t, wake: a.type.wake });
        a.toClr = true;
        a.toHdg = hdg;
        a.toAlt = alt;
        a.asgHdg = hdg;
        a.asgAlt = alt;
        a.setRequest(null, ctx);
        if (a.phase === 'holding') a.beginLineup(ctx);
        this.activeSet.add(e.runwayId);
        const w = this.weather;
        const after = hdg !== null ? `, after departure turn ${angleDiff(e.hdg, hdg) < 0 ? 'left' : 'right'} heading ${fmtHeading(hdg)}` : '';
        const afterS = hdg !== null ? `, after departure turn ${angleDiff(e.hdg, hdg) < 0 ? 'left' : 'right'} heading ${sayHeading(hdg)}` : '';
        this.atc(
          a,
          `${after ? after.slice(2) + ', ' : ''}climb ${fmtAltitude(alt)}, wind ${fmtWind(w.windDir, w.windSpeed, w.gust)}, runway ${end}, cleared for take-off`,
          `${afterS ? afterS.slice(2) + ', ' : ''}climb ${sayAltitude(alt)}, ${sayWind(w.windDir, w.windSpeed, w.gust)}, runway ${sayRunway(end)}, cleared for take-off`,
        );
        this.readback(a, `cleared for take-off runway ${end}`, `cleared for take-off runway ${sayRunway(end)}`);
        return { ok: true };
      }
      case 'cancelTakeoff': {
        a.toClr = false;
        this.atc(a, 'hold position, cancel take-off clearance', 'hold position, cancel take-off clearance', true);
        this.readback(a, 'holding position', 'holding position');
        return { ok: true };
      }
      case 'handoff': {
        a.handedOff = true;
        a.direct = a.exitFix;
        a.asgHdg = null;
        a.turnDir = null;
        const exitDef = def.departureExits.find((e) => e.fix === a.exitFix);
        a.asgAlt = Math.max(a.asgAlt, Math.min(def.airspace.ceilingFt, (exitDef?.minAltitude ?? 10000) + 1000));
        a.asgSpd = null;
        const fx = a.exitFix ?? '';
        this.atc(
          a,
          `proceed direct ${fx}, climb ${fmtAltitude(a.asgAlt)}, contact departure ${DEP_FREQ}, good day`,
          `proceed direct ${sayFix(fx)}, climb ${sayAltitude(a.asgAlt)}, contact departure ${digits(DEP_FREQ.replace('.', ''))}, good day`,
        );
        this.readback(a, `direct ${fx}, ${DEP_FREQ}, good day`, `direct ${sayFix(fx)}, ${digits(DEP_FREQ.split('.')[0])} decimal ${digits(DEP_FREQ.split('.')[1])}, good day`);
        return { ok: true };
      }
    }
    return { ok: false, error: 'unknown command' };
  }

  private faceDir(a: Aircraft): string {
    const pts = a.pushPath;
    if (!pts || pts.length < 2) return 'north';
    const s = pts[pts.length - 1];
    const p = pts[pts.length - 2];
    const h = bearing(s[0], s[1], p[0], p[1]); // nose points opposite to the push direction
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return names[Math.round(h / 45) % 8];
  }

  /** Graph node in front of the aircraft (for re-routing while taxiing / holding). */
  private nodeAhead(a: Aircraft): number {
    const ap = this.airport;
    if (a.path && a.path.idx < a.path.nodes.length) {
      for (let i = a.path.idx; i < a.path.nodes.length; i++) if (a.path.nodes[i] >= 0) return a.path.nodes[i];
    }
    const f = [Math.sin(a.hdg * DEG), Math.cos(a.hdg * DEG)];
    let best = -1;
    let bd = Infinity;
    for (const n of ap.nodes) {
      const dx = n.x - a.x;
      const dy = n.y - a.y;
      const d = Math.hypot(dx, dy);
      const fwd = dx * f[0] + dy * f[1];
      if (d > 400) continue;
      const cost = d + (fwd < -5 ? 400 : 0);
      if (cost < bd) {
        bd = cost;
        best = n.id;
      }
    }
    return best >= 0 ? best : ap.nearestNode(a.x, a.y);
  }

  // ========================================================== serialisation
  snapshot(): WorldSnapshot {
    return {
      v: SNAPSHOT_VERSION,
      cfg: this.cfg,
      t: this.t,
      rng: this.rng.state,
      nextArr: this.nextArr,
      nextDep: this.nextDep,
      idCounter: this.idCounter,
      score: this.score,
      stats: { ...this.stats },
      weather: JSON.parse(JSON.stringify(this.weather)),
      weatherBase: { ...this.weatherBase },
      strikeId: this.strikeId,
      nextStrike: this.nextStrike,
      configId: this.config.id,
      atis: this.atis,
      aircraft: this.aircraft.map((a) => JSON.parse(JSON.stringify(a))),
      pairs: [...this.pairs.entries()],
      lastDep: [...this.lastDep.entries()],
      holdPen: [...this.holdPen.entries()],
      radioLog: this.radioLog.slice(-60),
      scoreLog: this.scoreLog.slice(-80),
      ended: this.ended,
    };
  }

  private restore(s: WorldSnapshot): void {
    this.t = s.t;
    this.rng.state = s.rng >>> 0;
    this.nextArr = s.nextArr;
    this.nextDep = s.nextDep;
    this.idCounter = s.idCounter;
    this.score = s.score;
    this.stats = { ...this.stats, ...s.stats };
    this.weather = s.weather;
    this.weatherBase = s.weatherBase;
    this.strikeId = s.strikeId;
    this.nextStrike = s.nextStrike;
    this.config = this.airport.def.runwayConfigs.find((c) => c.id === s.configId) ?? this.config;
    this.atis = s.atis;
    this.aircraft = s.aircraft.map((d) => Aircraft.fromJSON(d));
    this.pairs = new Map(s.pairs);
    this.lastDep = new Map(s.lastDep);
    this.holdPen = new Map(s.holdPen);
    this.radioLog = s.radioLog ?? [];
    this.scoreLog = s.scoreLog ?? [];
    this.ended = s.ended;
  }

  /** Change the runway configuration (free play). */
  setRunwayConfig(id: string): void {
    const c = this.airport.def.runwayConfigs.find((x) => x.id === id);
    if (!c || c.id === this.config.id) return;
    this.config = c;
    this.atis = (this.atis + 1) % 26;
    this.notice(`Runway configuration changed: ${c.label}. Information ${this.atisLetter} is current.`, 'info');
  }

  /** Text of the current ATIS broadcast. */
  atisText(): string {
    const w = this.weather;
    const vis = w.visibility >= 10000 ? '10 km or more' : `${Math.round(w.visibility / 100) * 100} m`;
    const cloud = w.cloudCover < 0.2 ? 'few' : w.cloudCover < 0.5 ? 'scattered' : w.cloudCover < 0.9 ? 'broken' : 'overcast';
    return `${this.airport.def.name} information ${this.atisLetter}. Landing ${this.config.arrivals.join(', ')}, departing ${this.config.departures.join(', ')}. Wind ${fmtWind(w.windDir, w.windSpeed, w.gust)}, visibility ${vis}${w.precipitation > 0.1 ? (w.thunderstorm ? ', thunderstorm with rain' : ', rain') : ''}, ${cloud} ${Math.round(w.cloudBase / 100) * 100} ft, temperature ${Math.round(w.temperature)}, QNH ${Math.round(w.qnh)}.`;
  }
}

