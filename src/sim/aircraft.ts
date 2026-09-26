// Aircraft simulation: airborne flight model (bank-limited turns, wind drift, ILS capture and
// glideslope tracking, holds, go-arounds), landing roll and exit selection, taxi path following
// with hold-short logic and ground spacing, push-back, line-up and take-off.

import { DEG, FT, G, KT, NM, RAD, angleDiff, bearing, clamp, dist, lerp, wrap360 } from '../core/units';
import type { Rng } from '../core/rng';
import { AIRCRAFT_TYPES, type AircraftTypeDef } from './aircraftTypes';
import { AIRLINE_BY_CODE } from './airlines';
import type { AirportModel, Runway, RunwayEnd, RunwayExit } from './airportModel';
import { AirportModel as AM } from './airportModel';
import type { Vec2 } from './airports/types';
import type { AircraftLights, AircraftRenderState, AircraftTypeId } from './types';
import type { Emergency, HoldPattern, PathState, Phase, RequestKind, SimEvent } from './simTypes';
import { callsignSpeech, callsignText, digits, sayAltitude, sayRunway, sayTaxiway, type Phrase } from './phraseology';

export interface SimContext {
  t: number;
  airport: AirportModel;
  elevFt: number;
  windAt(altFt: number): { x: number; y: number };
  aircraft: readonly Aircraft[];
  isActive(runwayId: string): boolean;
  /** Another aircraft on (or about to be on) the runway surface, else null. */
  runwayBlocked(rw: Runway, self: Aircraft, horizonS: number): Aircraft | null;
  say(ac: Aircraft, p: Phrase, urgent?: boolean): void;
  emit(e: SimEvent): void;
  score(points: number, kind: import('./simTypes').ScoreEvent['kind'], reason: string, ids: string[]): void;
  rng: Rng;
}

const TAXI_ACCEL = 0.7;
const TAXI_DECEL = 1.4;

export function bezier(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
}

const vecOf = (h: number): Vec2 => [Math.sin(h * DEG), Math.cos(h * DEG)];

export class Aircraft implements AircraftRenderState {
  id: string;
  callsign: string;
  airlineCode: string;
  flightNumber: string;
  typeId: AircraftTypeId;
  registration: string;
  kind: 'arr' | 'dep';

  x = 0;
  y = 0;
  altFt = 0;
  hdg = 0;
  pitch = 0;
  bank = 0;
  onGround = false;
  gsKt = 0;
  vel = { x: 0, y: 0, z: 0 };
  ias = 0;
  vs = 0;
  trk = 0;
  gear = 1;
  flaps = 0;
  spoilers = 0;
  reverse = 0;
  thrust = 0;
  enginesRunning = false;
  lights: AircraftLights = { nav: true, beacon: false, strobe: false, landing: false, taxi: false, logo: true, cabin: true };
  tug = false;
  touchdownAt = -1;
  steer = 0;

  phase: Phase = 'inbound';
  phaseT = 0;
  asgHdg: number | null = null;
  turnDir: 'L' | 'R' | null = null;
  asgAlt = 0;
  asgSpd: number | null = null;
  expedite = false;
  direct: string | null = null;
  route: string[] = [];
  hold: HoldPattern | null = null;
  appr: string | null = null;
  apprState: 'armed' | 'loc' | 'gs' | null = null;
  landClr: string | null = null;
  rwyEnd: string | null = null;
  exitFix: string | null = null;
  gate: string | null = null;

  path: PathState | null = null;
  cleared: string[] = [];
  holdPos = false;
  toClr = false;
  toHdg: number | null = null;
  toAlt: number | null = null;
  pushPath: Vec2[] | null = null;
  pushS = 0;
  exitChoice: RunwayExit | null = null;
  lineupPath: Vec2[] | null = null;

  request: RequestKind | null = null;
  requestRwy: string | null = null;
  requestT = 0;
  spawnT = 0;
  readyAt = 0;
  parkedAt = -1;
  fuelMin = 40;
  emergency: Emergency = null;
  emergencyAt = -1;
  emergencyPlannedAt = -1;
  tcasUntil = 0;
  tcasVs = 0;
  goArounds = 0;
  handedOff = false;
  blockedT = 0;
  lastCallT = -999;
  reportedFinal = false;
  minFuelCalled = false;
  holdingSince = -1;
  airborneAt = -1;
  completed = false;
  /** Time the current waiting-for-controller period started (delay scoring). */
  waitSince = -1;
  delayPenalized = 0;
  countedLanded = false;
  countedGA = 0;
  /** Line up and wait once the holding point is reached. */
  luawPending = false;

  constructor(id: string, airline: string, flightNumber: string, typeId: AircraftTypeId, registration: string, kind: 'arr' | 'dep') {
    this.id = id;
    this.airlineCode = airline;
    this.flightNumber = flightNumber;
    this.callsign = `${airline}${flightNumber}`;
    this.typeId = typeId;
    this.registration = registration;
    this.kind = kind;
  }

  /** Plain-data snapshot for checkpoints (derived kinematics are rebuilt on load). */
  toJSON(): Record<string, unknown> {
    const o = { ...this } as unknown as Record<string, unknown>;
    delete o.prevX;
    delete o.prevY;
    delete o.prevAlt;
    return o;
  }

  static fromJSON(d: Record<string, unknown>): Aircraft {
    const a = new Aircraft(d.id as string, d.airlineCode as string, d.flightNumber as string, d.typeId as AircraftTypeId, d.registration as string, d.kind as 'arr' | 'dep');
    Object.assign(a, d);
    return a;
  }

  get type(): AircraftTypeDef {
    return AIRCRAFT_TYPES[this.typeId];
  }

  get telephony(): string {
    return AIRLINE_BY_CODE[this.airlineCode]?.telephony ?? this.airlineCode;
  }

  get spokenCallsign(): string {
    return callsignSpeech({ telephony: this.telephony, flightNumber: this.flightNumber, wake: this.type.wake });
  }

  get displayCallsign(): string {
    return callsignText({ telephony: this.telephony, flightNumber: this.flightNumber, wake: this.type.wake });
  }

  get airborne(): boolean {
    return !this.onGround;
  }

  agl(ctx: SimContext): number {
    return this.altFt - ctx.elevFt;
  }

  tasKt(): number {
    return this.ias * (1 + 0.02 * Math.max(0, this.altFt) / 1000);
  }

  setPhase(p: Phase, ctx: SimContext): void {
    this.phase = p;
    this.phaseT = ctx.t;
  }

  setRequest(r: RequestKind | null, ctx: SimContext, rwy: string | null = null): void {
    this.request = r;
    this.requestRwy = rwy;
    this.requestT = ctx.t;
    this.waitSince = r ? ctx.t : -1;
    this.delayPenalized = 0;
    if (r) ctx.emit({ type: 'request', id: this.id, request: r });
  }

  sayPilot(ctx: SimContext, text: string, speech: string, urgent = false): void {
    this.lastCallT = ctx.t;
    ctx.say(this, { text: `${text}, ${this.displayCallsign}`, speech: `${speech}, ${this.spokenCallsign}` }, urgent);
  }

  sayPilotLead(ctx: SimContext, text: string, speech: string, urgent = false): void {
    this.lastCallT = ctx.t;
    ctx.say(this, { text: `${this.displayCallsign}, ${text}`, speech: `${this.spokenCallsign}, ${speech}` }, urgent);
  }

  // ======================================================================= step
  step(dt: number, ctx: SimContext): void {
    switch (this.phase) {
      case 'inbound':
      case 'approach':
      case 'final':
      case 'goaround':
      case 'climbout':
        this.stepAirborne(dt, ctx);
        break;
      case 'landing':
        this.stepLanding(dt, ctx);
        break;
      case 'vacating':
      case 'taxiIn':
      case 'taxiOut':
      case 'parking':
        this.stepTaxi(dt, ctx);
        break;
      case 'lineup':
        this.stepLineup(dt, ctx);
        break;
      case 'takeoff':
        this.stepTakeoff(dt, ctx);
        break;
      case 'pushback':
        this.stepPushback(dt, ctx);
        break;
      case 'clear':
      case 'pushed':
      case 'holding':
        this.stopOnGround(dt);
        break;
      case 'ready':
        this.stopOnGround(dt);
        if (this.request === null && ctx.t >= this.readyAt) {
          this.lights.nav = true;
          const g = this.gate ?? '';
          this.sayPilotLead(ctx, `Ground, at stand ${g}, request pushback`, `ground, at stand ${sayTaxiway(g)}, request pushback`);
          this.setRequest('pushback', ctx);
        }
        break;
      case 'parked':
        this.stopOnGround(dt);
        if (this.enginesRunning && ctx.t - this.parkedAt > 35) {
          this.enginesRunning = false;
          this.lights.beacon = false;
        }
        this.thrust = this.enginesRunning ? 0.22 : Math.max(0, this.thrust - 0.05 * dt);
        break;
      case 'exited':
        break;
    }
    if (!this.onGround) {
      this.fuelMin -= dt / 60;
    }
    this.updateVelocity(dt);
  }

  private prevX = NaN;
  private prevY = NaN;
  private prevAlt = NaN;
  private updateVelocity(dt: number): void {
    if (!Number.isNaN(this.prevX) && dt > 0) {
      const vx = (this.x - this.prevX) / dt;
      const vy = (this.y - this.prevY) / dt;
      const vz = ((this.altFt - this.prevAlt) * FT) / dt;
      this.vel.x = vx;
      this.vel.y = vy;
      this.vel.z = vz;
      const gs = Math.hypot(vx, vy);
      this.gsKt = (gs / KT) * (this.phase === 'pushback' ? -1 : 1);
      if (gs > 0.3) this.trk = wrap360(Math.atan2(vx, vy) * RAD);
      else this.trk = this.hdg;
    }
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevAlt = this.altFt;
  }

  private stopOnGround(dt: number): void {
    this.ias = Math.max(0, this.ias - TAXI_DECEL / KT * dt);
    this.bank = 0;
    this.pitch += (0 - this.pitch) * Math.min(1, dt * 2);
    this.vs = 0;
    if (this.enginesRunning) this.thrust += (0.22 - this.thrust) * Math.min(1, dt);
    this.reverse = Math.max(0, this.reverse - dt);
    this.spoilers = Math.max(0, this.spoilers - dt * 0.3);
    if (this.ias > 0.2) {
      const v = this.ias * KT;
      this.x += Math.sin(this.hdg * DEG) * v * dt;
      this.y += Math.cos(this.hdg * DEG) * v * dt;
    }
  }

  // ================================================================== airborne
  private turnTowards(desHdg: number, dt: number, maxBank = 25, forced: 'L' | 'R' | null = null): number {
    const V = Math.max(this.tasKt() * KT, 35);
    let err = angleDiff(this.hdg, desHdg);
    if (forced === 'L' && err > 2) err -= 360;
    else if (forced === 'R' && err < -2) err += 360;
    const maxRate = Math.min(3, ((G * Math.tan(maxBank * DEG)) / V) * RAD);
    const desRate = clamp(err * 0.32, -maxRate, maxRate);
    const desBank = Math.atan((desRate * DEG * V) / G) * RAD;
    this.bank += clamp(desBank - this.bank, -6 * dt, 6 * dt);
    const rate = ((G * Math.tan(this.bank * DEG)) / V) * RAD;
    this.hdg = wrap360(this.hdg + rate * dt);
    return err;
  }

  private headingForTrack(trk: number, ctx: SimContext): number {
    const w = ctx.windAt(this.altFt);
    const tas = Math.max(this.tasKt() * KT, 40);
    const n: Vec2 = [Math.cos(trk * DEG), -Math.sin(trk * DEG)];
    const wPerp = w.x * n[0] + w.y * n[1];
    return wrap360(trk - Math.asin(clamp(wPerp / tas, -0.6, 0.6)) * RAD);
  }

  private climbRate(): number {
    const T = this.type;
    return T.climbFpm * clamp(1 - this.altFt / (T.ceilingFt * 1.25), 0.35, 1);
  }

  private verticalTowards(tgt: number, dt: number, ff = 0, maxDesc?: number): void {
    const err = tgt - this.altFt;
    const desc = maxDesc ?? this.type.descentFpm * (this.expedite ? 1.5 : 1);
    const climb = this.climbRate() * (this.expedite ? 1.3 : 1);
    let vsT = clamp(ff + err * 1.8, -desc, climb);
    if (this.tcasUntil > 0) vsT = this.tcasVs;
    this.vs += clamp(vsT - this.vs, -900 * dt, 900 * dt);
    this.altFt += (this.vs / 60) * dt;
  }

  private speedTowards(tgt: number, dt: number): void {
    const T = this.type;
    const d = tgt - this.ias;
    const rate = d > 0 ? T.accelKt : T.decelKt * (this.vs < -900 ? 0.6 : 1);
    this.ias += clamp(d, -rate * dt, rate * dt);
  }

  /** Default speed when the controller hasn't assigned one. */
  private scheduleSpeed(ctx: SimContext, distToThr: number): number {
    const T = this.type;
    const agl = this.agl(ctx);
    if (this.phase === 'climbout') {
      if (agl < 1500) return Math.min(T.vr + 25, 250);
      return this.altFt < 10000 ? 250 : Math.min(290, T.vmax);
    }
    if (this.phase === 'goaround') return Math.min(210, T.vmax);
    if (this.apprState === 'loc' || this.apprState === 'gs') {
      if (distToThr < 5 * NM) return T.vapp;
      if (distToThr < 12 * NM) return Math.max(T.vapp, 180);
      return Math.max(T.vapp, 210);
    }
    return Math.min(250, T.vmax);
  }

  private stepAirborne(dt: number, ctx: SimContext): void {
    const T = this.type;
    const ap = ctx.airport;
    if (this.tcasUntil > 0 && ctx.t > this.tcasUntil) {
      this.tcasUntil = 0;
      this.sayPilot(ctx, 'Clear of conflict, returning to assigned altitude', 'clear of conflict, returning to assigned altitude');
    }
    let desHdg = this.hdg;
    let forced: 'L' | 'R' | null = null;
    let tgtAlt = this.asgAlt;
    let ff = 0;
    let distToThr = Infinity;
    let maxBank = 25;
    const end: RunwayEnd | undefined = this.appr ? ap.ends[this.appr] : undefined;

    // ---- approach logic
    if (end && this.apprState) {
      const l = ap.endLocal(end, this.x, this.y);
      distToThr = -l.along;
      if (this.apprState === 'armed') {
        if (this.tryCaptureLoc(end, l, ctx)) {
          this.apprState = 'loc';
          this.setPhase('final', ctx);
          this.direct = null;
          this.asgHdg = null;
          this.hold = null;
          this.route = [];
        }
      }
      if (this.apprState === 'loc' || this.apprState === 'gs') {
        const L = clamp(Math.abs(distToThr) * 0.12, 450, 2500);
        const corr = clamp(Math.atan2(l.lat, L) * RAD, -30, 30);
        desHdg = this.headingForTrack(wrap360(end.hdg - corr), ctx);
        maxBank = 30;
        const gsAlt = ap.glideslopeAlt(distToThr);
        if (this.apprState === 'loc' && distToThr < 14 * NM && this.altFt <= gsAlt + 40) this.apprState = 'gs';
        if (this.apprState === 'gs') {
          tgtAlt = gsAlt;
          ff = -((this.gsKt * KT * Math.tan(3 * DEG)) / FT) * 60;
        } else if (this.altFt > gsAlt + 40 && distToThr < 11 * NM) {
          tgtAlt = gsAlt; // descend to intercept from above
          ff = -((this.gsKt * KT * Math.tan(3 * DEG)) / FT) * 60;
        }
        if (this.apprState === 'loc' && distToThr < 4 * NM && this.altFt > gsAlt + 500) {
          this.goAround(ctx, 'unstable', 'Unstable approach — too high');
          return;
        }
        if (Math.abs(l.lat) > 2500 && distToThr < 8 * NM) {
          this.goAround(ctx, 'unstable', 'Unstable approach — not aligned');
          return;
        }
        // Landing clearance request / missing clearance.
        if (!this.reportedFinal && distToThr < 6 * NM && this.landClr !== end.name) {
          this.reportedFinal = true;
          const miles = Math.max(2, Math.round(distToThr / NM));
          this.sayPilotLead(ctx, `Tower, ${miles} mile final runway ${end.name}`, `tower, ${digits(miles)} mile final runway ${sayRunway(end.name)}`);
          this.setRequest('landing', ctx, end.name);
        }
        if (distToThr < 0.9 * NM && this.landClr !== end.name) {
          this.goAround(ctx, 'goAround', 'Go-around — no landing clearance');
          return;
        }
        if (distToThr < 0.45 * NM && distToThr > 0) {
          const blocker = ctx.runwayBlocked(ap.runwayById(end.runwayId), this, 22);
          if (blocker) {
            this.goAround(ctx, 'goAround', `Go-around — runway occupied by ${blocker.callsign}`);
            return;
          }
        }
        if (distToThr < 700 && this.agl(ctx) < 45) {
          this.setPhase('landing', ctx);
          this.rwyEnd = end.name;
          return;
        }
      }
    }

    // ---- lateral navigation when not on the localiser
    if (!(this.apprState === 'loc' || this.apprState === 'gs')) {
      if (this.hold) {
        const r = this.holdGuidance(ctx);
        desHdg = r.hdg;
        forced = r.forced;
      } else if (this.direct) {
        const f = ap.fixes[this.direct];
        if (f) {
          const d = dist(this.x, this.y, f.pos[0], f.pos[1]);
          desHdg = this.headingForTrack(bearing(this.x, this.y, f.pos[0], f.pos[1]), ctx);
          if (d < 0.8 * NM) this.reachedFix(this.direct, ctx);
        }
      } else if (this.asgHdg !== null) {
        desHdg = this.asgHdg;
        forced = this.turnDir;
      } else if (this.route.length) {
        const f = ap.fixes[this.route[0]];
        if (f) {
          desHdg = this.headingForTrack(bearing(this.x, this.y, f.pos[0], f.pos[1]), ctx);
          if (dist(this.x, this.y, f.pos[0], f.pos[1]) < 0.8 * NM) this.reachedFix(this.route[0], ctx);
        } else this.route.shift();
      }
    }

    const err = this.turnTowards(desHdg, dt, maxBank, forced);
    if (forced && Math.abs(err) < 3 && this.asgHdg !== null) this.turnDir = null;

    // ---- vertical
    if (this.phase === 'goaround' && this.agl(ctx) > 1400) this.setPhase('inbound', ctx);
    this.verticalTowards(tgtAlt, dt, ff);
    const T0 = this.type;
    // ---- speed
    let spd = this.asgSpd ?? this.scheduleSpeed(ctx, distToThr);
    if (this.asgSpd !== null && (this.apprState === 'loc' || this.apprState === 'gs') && distToThr < 5 * NM) spd = T0.vapp;
    if (this.altFt < 10200) spd = Math.min(spd, 250);
    spd = clamp(spd, T.vapp, T.vmax);
    if (this.emergency === 'engine') spd = Math.min(spd, 220);
    this.speedTowards(spd, dt);

    // ---- configuration
    const onFinal = this.apprState === 'loc' || this.apprState === 'gs';
    let flapT = this.kind === 'arr' ? clamp((T.vminClean - this.ias) / (T.vminClean - T.vapp), 0, 1) : clamp((T.vminClean - 10 - this.ias) / (T.vminClean - T.vr), 0, 0.6);
    if (onFinal && distToThr < 5 * NM) flapT = 1;
    this.flaps += clamp(flapT - this.flaps, -0.07 * dt, 0.07 * dt);
    let gearT = this.gear;
    if (this.kind === 'arr') gearT = onFinal && (distToThr < 7 * NM || this.agl(ctx) < 2300) ? 1 : 0;
    if (this.phase === 'climbout' || this.phase === 'goaround') gearT = this.agl(ctx) > 120 && this.vs > 200 ? 0 : this.gear > 0.5 ? 1 : 0;
    this.gear += clamp(gearT - this.gear, -dt / 9, dt / 9);
    this.spoilers += clamp((this.expedite && this.vs < -500 ? 0.4 : 0) - this.spoilers, -0.5 * dt, 0.5 * dt);
    const accel = spd - this.ias;
    let thrT = 0.5 + (this.vs > 300 ? 0.35 : this.vs < -300 ? -0.25 : 0) + (accel > 3 ? 0.2 : accel < -3 ? -0.15 : 0) + this.flaps * 0.12;
    if (this.phase === 'goaround' && this.agl(ctx) < 1500) thrT = 0.95;
    this.thrust += clamp(clamp(thrT, 0.25, 1) - this.thrust, -0.25 * dt, 0.25 * dt);
    // ---- lights
    const low = this.altFt < 10000;
    this.lights.landing = low;
    this.lights.strobe = true;
    this.lights.beacon = true;
    this.lights.taxi = onFinal && distToThr < 3 * NM;

    // ---- attitude (visual)
    this.integratePosition(dt, ctx);
    const gsMs = Math.max(this.gsKt * KT, 30);
    const fpa = Math.atan2((this.vs * FT) / 60, gsMs) * RAD;
    const aoa = lerp(1.5, 7, clamp((T.vminClean + 30 - this.ias) / (T.vminClean + 30 - T.vapp), 0, 1)) - this.flaps * 2.2;
    this.pitch += clamp(fpa + aoa - this.pitch, -3 * dt, 3 * dt);
  }

  private integratePosition(dt: number, ctx: SimContext): void {
    const w = ctx.windAt(this.altFt);
    const tas = this.tasKt() * KT;
    this.x += (Math.sin(this.hdg * DEG) * tas + w.x) * dt;
    this.y += (Math.cos(this.hdg * DEG) * tas + w.y) * dt;
  }

  private tryCaptureLoc(end: RunwayEnd, l: { along: number; lat: number }, ctx: SimContext): boolean {
    const d = -l.along;
    if (d < 1.2 * NM || d > 28 * NM) return false;
    if (d < 10 * NM && this.altFt > ctx.airport.glideslopeAlt(d) + 900) return false;
    const rel = angleDiff(end.hdg, this.trk);
    const intercept = Math.abs(rel);
    if (intercept > 120) return false;
    if (Math.abs(l.lat) > d * Math.tan(35 * DEG) + 600) return false;
    const V = Math.max(this.gsKt * KT, 60);
    const latRate = V * Math.sin(rel * DEG);
    const R = (V * V) / (G * Math.tan(27 * DEG));
    const lead = R * (1 - Math.cos(Math.min(intercept, 90) * DEG)) + 120;
    const closing = Math.sign(latRate) !== Math.sign(l.lat);
    if (Math.abs(l.lat) < 180 && intercept < 40) return true;
    return Math.abs(l.lat) < lead && closing;
  }

  private reachedFix(fix: string, ctx: SimContext): void {
    if (this.direct === fix) this.direct = null;
    if (this.route[0] === fix) this.route.shift();
    const f = ctx.airport.fixes[fix];
    if (this.kind === 'arr' && !this.route.length && !this.direct && this.asgHdg === null && !(this.apprState === 'loc' || this.apprState === 'gs')) {
      // Nothing more to do: hold (or keep flying the heading into the approach if armed).
      if (this.apprState === 'armed' && this.appr) {
        const e = ctx.airport.ends[this.appr];
        this.hold = { fix, inbound: e.hdg, leg: 'outTurn', legT: ctx.t };
        return;
      }
      this.hold = { fix, inbound: this.trk, leg: 'outTurn', legT: ctx.t };
      this.holdingSince = ctx.t;
      this.sayPilotLead(ctx, `entering the hold at ${fix}, maintaining ${Math.round(this.asgAlt)}`, `entering the hold at ${f ? fix.toLowerCase() : fix}, maintaining ${sayAltitude(this.asgAlt)}`);
    } else if (this.kind === 'dep' && !this.direct && this.asgHdg === null) {
      this.asgHdg = Math.round(this.trk);
    }
  }

  private holdGuidance(ctx: SimContext): { hdg: number; forced: 'L' | 'R' | null } {
    const h = this.hold!;
    const f = ctx.airport.fixes[h.fix];
    const outbound = wrap360(h.inbound + 180);
    switch (h.leg) {
      case 'toFix': {
        const d = dist(this.x, this.y, f.pos[0], f.pos[1]);
        if (d < 0.6 * NM) {
          h.leg = 'outTurn';
          h.legT = ctx.t;
        }
        return { hdg: this.headingForTrack(bearing(this.x, this.y, f.pos[0], f.pos[1]), ctx), forced: null };
      }
      case 'outTurn':
        if (Math.abs(angleDiff(this.hdg, outbound)) < 5) {
          h.leg = 'outbound';
          h.legT = ctx.t;
        }
        return { hdg: outbound, forced: 'R' };
      case 'outbound':
        if (ctx.t - h.legT > 60) {
          h.leg = 'inTurn';
          h.legT = ctx.t;
        }
        return { hdg: outbound, forced: null };
      case 'inTurn': {
        const brg = bearing(this.x, this.y, f.pos[0], f.pos[1]);
        if (Math.abs(angleDiff(this.hdg, brg)) < 12) {
          h.leg = 'toFix';
          h.legT = ctx.t;
        }
        return { hdg: brg, forced: 'R' };
      }
    }
  }

  goAround(ctx: SimContext, kind: 'goAround' | 'unstable' | 'atc', reason: string): void {
    const ap = ctx.airport;
    const end = this.appr ? ap.ends[this.appr] : this.rwyEnd ? ap.ends[this.rwyEnd] : undefined;
    this.goArounds++;
    this.setPhase('goaround', ctx);
    this.apprState = null;
    this.appr = null;
    this.landClr = null;
    this.reportedFinal = false;
    this.asgHdg = end ? Math.round(end.hdg) : Math.round(this.hdg);
    this.turnDir = null;
    this.asgAlt = Math.max(ap.def.missedApproachAlt, Math.min(this.asgAlt, ap.def.missedApproachAlt));
    this.asgSpd = null;
    this.direct = null;
    this.hold = null;
    this.route = [];
    this.request = null;
    this.waitSince = -1;
    this.sayPilotLead(ctx, `going around`, `going around`, true);
    if (kind === 'atc') ctx.score(-20, 'goAround', reason, [this.id]);
    else ctx.score(kind === 'unstable' ? -60 : -80, kind, reason, [this.id]);
  }

  // ===================================================================== landing
  private stepLanding(dt: number, ctx: SimContext): void {
    const ap = ctx.airport;
    const T = this.type;
    const end = ap.ends[this.rwyEnd!];
    const l = ap.endLocal(end, this.x, this.y);
    if (!this.onGround) {
      // Flare: arrest the sink progressively, align with the runway (de-crab), idle thrust.
      const agl = Math.max(0, this.agl(ctx));
      const vsT = -170 - clamp(agl / 40, 0, 1) * 560;
      this.vs += clamp(vsT - this.vs, -500 * dt, 500 * dt);
      this.altFt += (this.vs / 60) * dt;
      this.hdg = wrap360(this.hdg + clamp(angleDiff(this.hdg, end.hdg), -3 * dt, 3 * dt));
      this.bank += (0 - this.bank) * Math.min(1, dt * 2);
      this.thrust += (0.22 - this.thrust) * Math.min(1, dt * 1.5);
      this.speedTowards(T.vapp - 12, dt);
      this.pitch += clamp(4.5 - this.pitch, -2 * dt, 2 * dt);
      this.integratePosition(dt, ctx);
      // Keep on the centreline laterally during the flare.
      const lat = ap.endLocal(end, this.x, this.y).lat;
      this.x -= end.right[0] * lat * Math.min(1, dt * 0.6);
      this.y -= end.right[1] * lat * Math.min(1, dt * 0.6);
      if (this.altFt <= ctx.elevFt) {
        this.altFt = ctx.elevFt;
        this.onGround = true;
        this.touchdownAt = ctx.t;
        const sink = Math.abs(this.vs);
        this.vs = 0;
        this.bank = 0;
        ctx.emit({ type: 'touchdown', id: this.id, x: this.x, y: this.y, intensity: clamp(sink / 400, 0.3, 1) });
        this.chooseExit(ctx);
      }
      if (l.along > end.length * 0.55) {
        // Floated too far: go around (rare, safety net).
        this.goAround(ctx, 'goAround', 'Go-around — long landing');
      }
      return;
    }
    // ---- rollout
    this.pitch += (0 - this.pitch) * Math.min(1, dt * 1.2);
    this.spoilers += (1 - this.spoilers) * Math.min(1, dt * 3);
    const v = this.ias * KT;
    if (!this.exitChoice || l.along > this.exitChoice.along + 5) this.chooseExit(ctx);
    const ex = this.exitChoice;
    let vT = 0;
    if (ex) {
      const vexit = ex.maxSpeedKt * KT;
      const remaining = Math.max(0, ex.along - l.along);
      vT = Math.sqrt(vexit * vexit + 2 * T.landingDecel * 0.8 * remaining);
    }
    const decel = v > vT ? Math.min(T.landingDecel * 1.15, v > 35 ? T.landingDecel : 1.6) : -0.4;
    const nv = Math.max(ex ? 3 : 0, v - decel * dt);
    this.ias = nv / KT;
    this.reverse += ((this.ias > 70 ? 1 : 0) - this.reverse) * Math.min(1, dt * 2);
    this.thrust += ((this.reverse > 0.5 ? 0.75 : 0.22) - this.thrust) * Math.min(1, dt * 1.5);
    // Track the centreline.
    const desHdg = wrap360(end.hdg - clamp(l.lat * 0.4, -8, 8));
    this.hdg = wrap360(this.hdg + clamp(angleDiff(this.hdg, desHdg), -4 * dt, 4 * dt));
    this.x += Math.sin(this.hdg * DEG) * nv * dt;
    this.y += Math.cos(this.hdg * DEG) * nv * dt;
    this.lights.landing = this.ias > 60;
    this.lights.taxi = true;
    if (ex && l.along >= ex.along - Math.max(4, nv * 1.2)) this.startVacate(ex, ctx);
    else if (!ex && this.ias < 1) {
      // Stopped with no exit left (should not happen): back-track guidance via nearest node.
      this.startVacate(null, ctx);
    }
  }

  private chooseExit(ctx: SimContext): void {
    const ap = ctx.airport;
    const end = ap.ends[this.rwyEnd!];
    const T = this.type;
    const l = ap.endLocal(end, this.x, this.y);
    const v = this.ias * KT;
    const exits = (ap.exits[end.name] ?? []).filter((e) => e.along > l.along + 20);
    const feasible = exits.filter((e) => {
      const vexit = e.maxSpeedKt * KT;
      const need = v > vexit ? (v * v - vexit * vexit) / (2 * T.landingDecel * 0.85) : 0;
      return e.along - l.along >= need;
    });
    let pick = feasible[0] ?? exits[exits.length - 1] ?? null;
    const gate = this.gate ? ap.gateById[this.gate] : undefined;
    if (gate && feasible.length) {
      const gl = ap.endLocal(end, gate.pos[0], gate.pos[1]);
      const side = Math.sign(gl.lat) || 1;
      const same = feasible.find((e) => e.side === side);
      if (same && same.along - feasible[0].along < 900) pick = same;
    }
    this.exitChoice = pick;
  }

  private startVacate(ex: RunwayExit | null, ctx: SimContext): void {
    const ap = ctx.airport;
    const end = ap.ends[this.rwyEnd!];
    let pts: Vec2[];
    let nodes: number[];
    if (ex) {
      const walk = ap.walkToHold(ex.junctionNode, ex.edge, end.runwayId);
      if (!walk) {
        this.exitChoice = null;
        return;
      }
      pts = walk.points;
      nodes = walk.nodes;
    } else {
      const n = ap.nearestNode(this.x, this.y, (nn) => nn.holdFor.includes(end.runwayId));
      pts = [[this.x, this.y], [ap.nodes[n].x, ap.nodes[n].y]];
      nodes = [-1, n];
    }
    // Extend beyond the hold point so the tail is clear.
    const hold = nodes[nodes.length - 1];
    const prev = nodes[nodes.length - 2];
    const hn = ap.nodes[hold];
    let nextNode = -1;
    let bestDot = -2;
    const pn = prev >= 0 ? ap.nodes[prev] : { x: this.x, y: this.y };
    const dIn: Vec2 = [hn.x - pn.x, hn.y - pn.y];
    const dl = Math.hypot(dIn[0], dIn[1]) || 1;
    for (const eid of hn.edges) {
      const e = ap.edges[eid];
      if (e.kind === 'runway') continue;
      const o = ap.otherNode(e, hold);
      if (o === prev) continue;
      const on = ap.nodes[o];
      const v: Vec2 = [on.x - hn.x, on.y - hn.y];
      const dot = (v[0] * dIn[0] + v[1] * dIn[1]) / (Math.hypot(v[0], v[1]) * dl);
      if (dot > bestDot) {
        bestDot = dot;
        nextNode = o;
      }
    }
    if (nextNode >= 0) {
      const nn = ap.nodes[nextNode];
      const L = Math.hypot(nn.x - hn.x, nn.y - hn.y);
      const ext = Math.min(AM.noseOffset(this.type.length) + this.type.length * 0.55 + 12, L - 10);
      if (ext > 5) {
        pts = [...pts, [hn.x + ((nn.x - hn.x) * ext) / L, hn.y + ((nn.y - hn.y) * ext) / L]];
        nodes = [...nodes, -1];
      }
    }
    this.path = { points: pts.slice(1), idx: 0, holds: [], names: [], nodes: nodes.slice(1) };
    this.vacateNext = nextNode;
    this.vacateHold = hold;
    this.exitHold = hold;
    this.setPhase('vacating', ctx);
    this.lights.landing = false;
    this.lights.strobe = false;
    this.spoilers = 0.6;
  }

  vacateNext = -1;
  vacateHold = -1;
  /** Hold node the aircraft passed when leaving the runway (to avoid routing back through it). */
  exitHold = -1;
  /** Speed limit for the current taxi path, knots. */
  taxiLimit = 18;

  // ======================================================================== taxi
  /** Distance along the current path from our position to point k. */
  private pathDist(k: number): number {
    const p = this.path!;
    if (k < p.idx) return 0;
    let d = Math.hypot(p.points[p.idx][0] - this.x, p.points[p.idx][1] - this.y);
    for (let i = p.idx; i < k; i++) d += Math.hypot(p.points[i + 1][0] - p.points[i][0], p.points[i + 1][1] - p.points[i][1]);
    return d;
  }

  private pathPointAhead(distance: number): Vec2 {
    const p = this.path!;
    let px = this.x;
    let py = this.y;
    let rem = distance;
    for (let i = p.idx; i < p.points.length; i++) {
      const [qx, qy] = p.points[i];
      const seg = Math.hypot(qx - px, qy - py);
      if (seg >= rem) return [px + ((qx - px) * rem) / seg, py + ((qy - py) * rem) / seg];
      rem -= seg;
      px = qx;
      py = qy;
    }
    return [px, py];
  }

  /** Heading change over the path ahead within `horizon` metres (deg). */
  private upcomingTurn(horizon: number): number {
    const p = this.path!;
    let maxTurn = 0;
    let travelled = 0;
    let prevHdg = this.hdg;
    let px = this.x;
    let py = this.y;
    for (let i = p.idx; i < p.points.length && travelled < horizon; i++) {
      const [qx, qy] = p.points[i];
      const seg = Math.hypot(qx - px, qy - py);
      if (seg > 3) {
        const h = bearing(px, py, qx, qy);
        maxTurn = Math.max(maxTurn, Math.abs(angleDiff(prevHdg, h)));
        prevHdg = h;
      }
      travelled += seg;
      px = qx;
      py = qy;
    }
    return maxTurn;
  }

  private groundBlocked(ctx: SimContext): Aircraft | null {
    const T = this.type;
    const f: Vec2 = vecOf(this.hdg);
    for (const o of ctx.aircraft) {
      if (o === this || !o.onGround || o.phase === 'exited') continue;
      const dx = o.x - this.x;
      const dy = o.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 220) continue;
      const fwd = dx * f[0] + dy * f[1];
      const lat = dx * f[1] - dy * f[0];
      const OT = o.type;
      const need = T.length * 0.5 + OT.length * 0.5 + 18 + this.ias * KT * 3;
      if (fwd > 0 && fwd < need && Math.abs(lat) < (T.span + OT.span) * 0.35 + 6) {
        // Ignore aircraft parked at gates that we are not driving into.
        if ((o.phase === 'parked' || o.phase === 'ready') && Math.abs(lat) > 8) continue;
        return o;
      }
    }
    return null;
  }

  private stepTaxi(dt: number, ctx: SimContext): void {
    const T = this.type;
    const p = this.path;
    if (!p) {
      this.stopOnGround(dt);
      return;
    }
    this.pitch += (0 - this.pitch) * Math.min(1, dt * 2);
    this.bank = 0;
    this.reverse = Math.max(0, this.reverse - dt);
    this.spoilers = Math.max(0, this.spoilers - dt * 0.4);
    // Advance past reached points.
    while (p.idx < p.points.length) {
      const [px, py] = p.points[p.idx];
      const d = Math.hypot(px - this.x, py - this.y);
      const f = (px - this.x) * Math.sin(this.hdg * DEG) + (py - this.y) * Math.cos(this.hdg * DEG);
      if (d < 4 || (f < 0 && d < 30)) {
        this.onPassPoint(p.idx, ctx);
        p.idx++;
      } else break;
    }
    if (p.idx >= p.points.length) {
      this.ias = 0;
      this.onPathEnd(ctx);
      return;
    }
    const v = this.ias * KT;
    // Target speed.
    let vT = Math.min(this.taxiLimit, T.taxiKt) * KT;
    if (this.phase === 'vacating') vT = Math.max(vT, (this.exitChoice?.maxSpeedKt ?? 20) * KT * 0.8);
    if (this.phase === 'parking') vT = 3.5 * KT;
    const turn = this.upcomingTurn(45 + v * 2);
    if (turn > 60) vT = Math.min(vT, 7 * KT);
    else if (turn > 25) vT = Math.min(vT, 11 * KT);
    // Stop points: pending hold not cleared, or path end.
    let stopDist = this.pathDist(p.points.length - 1);
    if (this.phase === 'taxiOut') {
      // Stop with the nose just short of the holding position line.
      stopDist -= AM.noseOffset(T.length) + 4;
      if (stopDist < 1.5 && v < 0.4 && !this.holdPos) {
        this.ias = 0;
        p.idx = p.points.length;
        this.onPathEnd(ctx);
        return;
      }
    }
    for (const h of p.holds) {
      if (h.idx < p.idx) continue;
      if (this.mustStopAt(h.runwayId, ctx)) {
        stopDist = Math.min(stopDist, this.pathDist(h.idx) - AM.noseOffset(T.length) - 4);
        if (stopDist < 3 && v < 0.5) this.onReachHold(h.runwayId, ctx);
        break;
      }
    }
    if (this.holdPos) stopDist = 0;
    vT = Math.min(vT, Math.sqrt(2 * 0.8 * Math.max(0, stopDist)));
    const blocker = this.groundBlocked(ctx);
    if (blocker) {
      this.blockedT += dt;
      // Deadlock breaker: after a long mutual wait the lower-priority one creeps through.
      if (!(this.blockedT > 25 && blocker.blockedT > 25 && this.id > blocker.id)) vT = 0;
    } else this.blockedT = 0;
    const nv = v < vT ? Math.min(vT, v + TAXI_ACCEL * dt) : Math.max(vT, v - TAXI_DECEL * dt);
    this.ias = nv / KT;
    // Steering (pure pursuit).
    const la = clamp(nv * 2.2 + 10, 10, 45);
    const [tx, ty] = this.pathPointAhead(la);
    const desHdg = bearing(this.x, this.y, tx, ty);
    const Rmin = T.size === 'H' ? 42 : T.size === 'L' ? 34 : 24;
    const maxRate = nv > 0.3 ? (nv / Rmin) * RAD : 0;
    const dh = clamp(angleDiff(this.hdg, desHdg), -maxRate * dt, maxRate * dt);
    this.hdg = wrap360(this.hdg + dh);
    this.steer = clamp(angleDiff(this.hdg, desHdg) * 1.5, -60, 60);
    this.x += Math.sin(this.hdg * DEG) * nv * dt;
    this.y += Math.cos(this.hdg * DEG) * nv * dt;
    this.thrust += ((nv < vT - 0.5 ? 0.34 : 0.24) - this.thrust) * Math.min(1, dt);
    this.lights.taxi = this.phase !== 'parking';
    if (this.phase === 'vacating' && this.vacateHold >= 0) {
      const hn = ctx.airport.nodes[this.vacateHold];
      const f = vecOf(this.hdg);
      if ((this.x - hn.x) * f[0] + (this.y - hn.y) * f[1] > AM.noseOffset(T.length) * 0 + T.length * 0.55) this.onVacated(ctx);
    }
  }

  private mustStopAt(runwayId: string, ctx: SimContext): boolean {
    if (this.cleared.includes(runwayId)) return false;
    return ctx.isActive(runwayId);
  }

  private onReachHold(runwayId: string, ctx: SimContext): void {
    if (this.request === 'crossing' && this.requestRwy === runwayId) return;
    const rw = ctx.airport.runwayById(runwayId);
    const nm = rw.ends[0].name;
    const here = this.nearestRunwayEndName(rw);
    void nm;
    this.sayPilotLead(ctx, `holding short runway ${here}, request crossing`, `holding short runway ${sayRunway(here)}, request crossing`);
    this.setRequest('crossing', ctx, runwayId);
  }

  nearestRunwayEndName(rw: Runway): string {
    const d0 = dist(this.x, this.y, rw.ends[0].threshold[0], rw.ends[0].threshold[1]);
    const d1 = dist(this.x, this.y, rw.ends[1].threshold[0], rw.ends[1].threshold[1]);
    return d0 <= d1 ? rw.ends[0].name : rw.ends[1].name;
  }

  private onPassPoint(idx: number, ctx: SimContext): void {
    const p = this.path!;
    // A crossing clearance is consumed once the aircraft leaves that runway's protected area.
    for (const h of p.holds) {
      if (h.exitIdx === idx && this.cleared.includes(h.runwayId)) {
        this.cleared = this.cleared.filter((r) => r !== h.runwayId);
        if (this.request === 'crossing' && this.requestRwy === h.runwayId) this.setRequest(null, ctx);
      }
    }
  }

  private onVacated(ctx: SimContext): void {
    if (this.phase !== 'vacating') return;
    const end = ctx.airport.ends[this.rwyEnd!];
    this.vacateHold = -1;
    this.setPhase('clear', ctx);
    this.path = this.path ? { ...this.path } : null;
    const via = this.exitChoice ? ctx.airport.edges[this.exitChoice.edge].name : '';
    this.sayPilotLead(ctx, `clear of runway ${end.name}${via ? ` via ${via}` : ''}`, `clear of runway ${sayRunway(end.name)}${via ? ` via ${sayTaxiway(via)}` : ''}`);
    this.setRequest('taxiGate', ctx);
    ctx.score(40, 'bonus', `${this.callsign} landed and vacated`, [this.id]);
  }

  private onPathEnd(ctx: SimContext): void {
    switch (this.phase) {
      case 'vacating':
        this.onVacated(ctx);
        break;
      case 'taxiIn':
        this.beginParking(ctx);
        break;
      case 'parking':
        this.setPhase('parked', ctx);
        this.parkedAt = ctx.t;
        this.path = null;
        this.lights.taxi = false;
        this.lights.strobe = false;
        if (!this.completed) {
          this.completed = true;
          ctx.score(60, 'bonus', `${this.callsign} on stand ${this.gate}`, [this.id]);
          ctx.emit({ type: 'notice', text: `${this.callsign} is on stand ${this.gate}`, level: 'good' });
        }
        break;
      case 'taxiOut': {
        this.setPhase('holding', ctx);
        this.path = null;
        const end = this.rwyEnd!;
        if (this.toClr || this.luawPending) {
          this.luawPending = false;
          this.beginLineup(ctx);
          return;
        }
        this.sayPilotLead(ctx, `holding short runway ${end}, ready for departure`, `holding short runway ${sayRunway(end)}, ready for departure`);
        this.setRequest('takeoff', ctx, end);
        break;
      }
      default:
        break;
    }
  }

  beginParking(ctx: SimContext): void {
    const ap = ctx.airport;
    const gate = ap.gateById[this.gate!];
    const park = ap.parkedPosition(gate, this.type.length);
    const S: Vec2 = [this.x, this.y];
    const dIn = vecOf(this.hdg);
    const gv = vecOf(gate.hdg);
    const L = Math.hypot(park[0] - S[0], park[1] - S[1]);
    const k = L * 0.45;
    const pts = bezier(S, [S[0] + dIn[0] * k, S[1] + dIn[1] * k], [park[0] - gv[0] * k, park[1] - gv[1] * k], park, 18);
    this.path = { points: pts.slice(1), idx: 0, holds: [], names: [], nodes: pts.slice(1).map(() => -1) };
    this.setPhase('parking', ctx);
  }

  // ================================================================== push-back
  planPushback(ctx: SimContext, runwayEnd: string): boolean {
    const ap = ctx.airport;
    const gate = ap.gateById[this.gate!];
    const spot = ap.nodes[gate.spotNode];
    const entry = this.bestEntry(ctx, gate.spotNode, runwayEnd);
    let dOut: Vec2 = [1, 0];
    if (entry && entry.route.nodes.length > 1) {
      const n1 = ap.nodes[entry.route.nodes[1]];
      const l = Math.hypot(n1.x - spot.x, n1.y - spot.y) || 1;
      dOut = [(n1.x - spot.x) / l, (n1.y - spot.y) / l];
    } else {
      const e = ap.edges[spot.edges[0]];
      const o = ap.nodes[ap.otherNode(e, spot.id)];
      const l = Math.hypot(o.x - spot.x, o.y - spot.y) || 1;
      dOut = [(o.x - spot.x) / l, (o.y - spot.y) / l];
    }
    const P0: Vec2 = [this.x, this.y];
    const nose = vecOf(this.hdg);
    // Final reference point: a little beyond the spot so the nose is not over the lead-in line.
    const S: Vec2 = [spot.x + dOut[0] * 6, spot.y + dOut[1] * 6];
    const L = Math.hypot(S[0] - P0[0], S[1] - P0[1]);
    this.pushPath = bezier(P0, [P0[0] - nose[0] * L * 0.55, P0[1] - nose[1] * L * 0.55], [S[0] + dOut[0] * L * 0.45, S[1] + dOut[1] * L * 0.45], S, 30);
    this.pushS = 0;
    this.rwyEnd = runwayEnd;
    return true;
  }

  bestEntry(ctx: SimContext, fromNode: number, runwayEnd: string, avoidFirstNode?: number): { hold: number; route: import('./airportModel').TaxiRoute } | null {
    const ap = ctx.airport;
    let best: { hold: number; route: import('./airportModel').TaxiRoute } | null = null;
    for (const e of ap.departureEntries[runwayEnd] ?? []) {
      const r = ap.route(fromNode, e.holdNode, { avoidFirstNode });
      if (r && (!best || r.length < best.route.length)) best = { hold: e.holdNode, route: r };
    }
    return best;
  }

  private stepPushback(dt: number, ctx: SimContext): void {
    const pts = this.pushPath;
    if (!pts) return;
    this.tug = true;
    this.lights.beacon = true;
    let total = 0;
    const segs: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      segs.push(s);
      total += s;
    }
    const pushing = this.pushS < total;
    if (pushing) {
      const v = Math.min(1.6, 0.4 + (ctx.t - this.phaseT) * 0.15, Math.max(0.35, (total - this.pushS) * 0.3));
      this.pushS = Math.min(total, this.pushS + v * dt);
      let s = this.pushS;
      let i = 0;
      while (i < segs.length - 1 && s > segs[i]) {
        s -= segs[i];
        i++;
      }
      const t = segs[i] > 0 ? s / segs[i] : 0;
      const nx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
      const ny = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      const mv = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (mv > 0.01) this.hdg = wrap360(bearing(pts[i + 1][0], pts[i + 1][1], pts[i][0], pts[i][1]));
      this.x = nx;
      this.y = ny;
      this.ias = v / KT;
      this.steer = 0;
      // Engines start during the push.
      if (ctx.t - this.phaseT > 20 && !this.enginesRunning) this.enginesRunning = true;
    } else {
      this.ias = 0;
      if (!this.enginesRunning) this.enginesRunning = true;
      if (!this.pushDoneAt) this.pushDoneAt = ctx.t;
      if (ctx.t - this.pushDoneAt > 14) {
        this.tug = false;
        this.pushPath = null;
        this.pushDoneAt = 0;
        this.setPhase('pushed', ctx);
        this.sayPilotLead(ctx, 'ready to taxi', 'ready to taxi');
        this.setRequest('taxi', ctx);
      }
    }
    this.thrust += ((this.enginesRunning ? 0.22 : 0) - this.thrust) * Math.min(1, dt * 0.3);
  }

  pushDoneAt = 0;

  // ============================================================= line-up / T-O
  beginLineup(ctx: SimContext): void {
    const ap = ctx.airport;
    const end = ap.ends[this.rwyEnd!];
    const entries = ap.departureEntries[end.name] ?? [];
    let entry = entries[0];
    let bd = Infinity;
    for (const e of entries) {
      const n = ap.nodes[e.holdNode];
      const d = dist(this.x, this.y, n.x, n.y);
      if (d < bd) {
        bd = d;
        entry = e;
      }
    }
    if (!entry) return;
    const j = ap.nodes[entry.junctionNode];
    const pts: Vec2[] = entry.path.slice(1).map((p) => [p[0], p[1]] as Vec2);
    // Swing onto the centreline and roll forward to align.
    pts.push([j.x + end.dir[0] * 35, j.y + end.dir[1] * 35]);
    pts.push([j.x + end.dir[0] * 75, j.y + end.dir[1] * 75]);
    this.lineupPath = pts;
    this.path = { points: pts, idx: 0, holds: [], names: [], nodes: pts.map(() => -1) };
    this.setPhase('lineup', ctx);
    this.lights.strobe = true;
    this.lights.landing = true;
  }

  private stepLineup(dt: number, ctx: SimContext): void {
    const p = this.path;
    if (p && p.idx < p.points.length) {
      this.taxiLimit = 10;
      this.stepTaxiCore(dt, ctx);
      return;
    }
    this.path = null;
    this.stopOnGround(dt);
    const end = ctx.airport.ends[this.rwyEnd!];
    // Align exactly.
    this.hdg = wrap360(this.hdg + clamp(angleDiff(this.hdg, end.hdg), -10 * dt, 10 * dt));
    if (this.toClr && Math.abs(angleDiff(this.hdg, end.hdg)) < 2) {
      const blocker = ctx.runwayBlocked(ctx.airport.runwayById(end.runwayId), this, 0);
      if (blocker) {
        if (ctx.t - this.lastCallT > 30) this.sayPilotLead(ctx, `holding in position, traffic on the runway`, `holding in position, traffic on the runway`);
        return;
      }
      this.setPhase('takeoff', ctx);
      this.airborneAt = -1;
    }
  }

  private stepTaxiCore(dt: number, ctx: SimContext): void {
    const saved = this.phase;
    this.stepTaxi(dt, ctx);
    if (this.phase !== saved && saved === 'lineup') this.phase = saved;
  }

  private stepTakeoff(dt: number, ctx: SimContext): void {
    const T = this.type;
    const ap = ctx.airport;
    const end = ap.ends[this.rwyEnd!];
    this.lights.landing = true;
    this.lights.strobe = true;
    this.lights.taxi = false;
    if (this.onGround) {
      this.thrust += (0.97 - this.thrust) * Math.min(1, dt * 0.8);
      const v = this.ias * KT;
      const a = T.takeoffAccel * clamp(1.15 - v / (T.vr * KT * 2.4), 0.45, 1) * clamp(this.thrust / 0.9, 0.2, 1);
      const nv = v + a * dt;
      this.ias = nv / KT;
      const l = ap.endLocal(end, this.x, this.y);
      const desHdg = wrap360(end.hdg - clamp(l.lat * 0.5, -6, 6));
      this.hdg = wrap360(this.hdg + clamp(angleDiff(this.hdg, desHdg), -3 * dt, 3 * dt));
      this.x += Math.sin(this.hdg * DEG) * nv * dt;
      this.y += Math.cos(this.hdg * DEG) * nv * dt;
      if (this.ias >= T.vr) this.pitch += clamp(9 - this.pitch, -3 * dt, 2.6 * dt);
      if (this.ias >= T.vr + 7 && this.pitch > 6) {
        this.onGround = false;
        this.airborneAt = ctx.t;
        this.vs = 600;
      }
      if (l.along > end.length - 50 && this.onGround) {
        // Rejected take-off safety net: lift off anyway (never overrun visibly).
        this.onGround = false;
        this.vs = 500;
      }
      return;
    }
    // Initial climb straight ahead.
    const tgtAlt = this.toAlt ?? ap.def.initialClimb;
    this.asgAlt = tgtAlt;
    this.verticalTowards(tgtAlt, dt, 0);
    this.vs = Math.min(this.vs, this.climbRate() * 1.1);
    this.speedTowards(T.vr + 20, dt);
    this.turnTowards(end.hdg, dt, 10);
    this.pitch += clamp(Math.atan2((this.vs * FT) / 60, Math.max(this.gsKt * KT, 40)) * RAD + 5 - this.pitch, -2 * dt, 2 * dt);
    const gearT = this.agl(ctx) > 60 && this.vs > 200 ? 0 : 1;
    this.gear += clamp(gearT - this.gear, -dt / 9, dt / 9);
    this.flaps = Math.min(this.flaps, 0.45);
    this.integratePosition(dt, ctx);
    if (this.agl(ctx) > 400) {
      this.setPhase('climbout', ctx);
      if (this.asgHdg === null) this.asgHdg = this.toHdg ?? Math.round(end.hdg);
      this.asgAlt = tgtAlt;
      this.sayPilotLead(ctx, `airborne, passing ${Math.round(this.altFt / 100) * 100} for ${Math.round(tgtAlt)}`, `airborne, passing ${sayAltitude(Math.round(this.altFt / 100) * 100)} for ${sayAltitude(tgtAlt)}`);
    }
  }
}
