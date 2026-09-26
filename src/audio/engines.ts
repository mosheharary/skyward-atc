// Positional aircraft engine synthesis: turbofan and turboprop voices, a nearest-N voice pool with
// click-free allocation, manual distance attenuation, air absorption, directivity and doppler.

import { clamp, damp, smoothstep } from '../core/units';
import type { EngineKind, SizeClass } from '../sim/types';
import type { AircraftAudioState } from './contracts';
import type { SampleBank } from './samples';
import {
  Param,
  autoCleanup,
  biquad,
  createPanner,
  gainNode,
  jumpPannerPosition,
  loopSource,
  oscillator,
  safeDisconnect,
  safeStop,
  setPannerPosition,
  startLoop,
  type V3,
} from './util';

export const MAX_VOICES = 10;
const IDLE = 0.22;
const REF_DIST = 60;
const ENGINE_GAIN = 9;
const SPEED_OF_SOUND = 343;
const SIZE_LOUD: Record<SizeClass, number> = { S: 0.55, M: 0.8, L: 1.0, H: 1.15 };
/** Fan blade-pass frequency at 100% N1 (bigger fans turn slower). */
const FAN_BPF: Record<SizeClass, number> = { S: 3500, M: 2950, L: 2400, H: 2150 };

export const distanceAtt = (d: number): number => REF_DIST / (REF_DIST + d);
/** Air absorption: approximate low-pass corner frequency for a propagation distance (m). */
export const absorptionHz = (d: number): number => clamp(2100 * Math.pow(1000 / Math.max(d, 25), 0.62), 380, 20000);

const engineFactor = (engines: number): number => (engines >= 4 ? 1.25 : 1);

function powerOf(spool: number, reverse: number): { alive: number; p: number; e: number } {
  const alive = smoothstep(0, IDLE, spool);
  const p = clamp((spool - IDLE) / (1 - IDLE), 0, 1);
  return { alive, p, e: Math.max(p, reverse * 0.85) };
}

function turbofanParams(spool: number, reverse: number, size: SizeClass) {
  const n1 = clamp(spool, 0, 1);
  const { alive, p, e } = powerOf(n1, reverse);
  const n2 = n1 < IDLE ? (n1 / IDLE) * 0.6 : 0.6 + p * 0.4;
  return {
    roarCut: 650 + 6800 * Math.pow(e, 1.25),
    roarGain: 0.06 * alive + 1.0 * Math.pow(e, 1.5),
    crackGain: smoothstep(0.72, 1.0, e) * 0.4,
    rumbleGain: 0.04 * alive + 0.83 * e * e,
    fanFreq: Math.max(20, FAN_BPF[size] * n1),
    fanGain: 0.03 * alive * (0.7 + 0.8 * n1) * (1 - 0.35 * e),
    whineFreq: 400 + 7400 * n2,
    whineGain: 0.022 * smoothstep(0.05, 0.6, n2) * (1 - 0.55 * e),
    sawFreq: Math.max(10, (FAN_BPF[size] / 34) * n1),
    sawGain: smoothstep(0.78, 0.98, n1) * 0.12,
  };
}

function turbopropParams(spool: number, reverse: number) {
  const { alive, p, e } = powerOf(spool, reverse);
  const rpm = spool < IDLE ? 820 * (spool / IDLE) : 820 + 380 * smoothstep(0, 0.6, p);
  const bpf = (rpm / 60) * 6;
  const nh = spool < IDLE ? (spool / IDLE) * 0.65 : 0.65 + 0.35 * p;
  return {
    propFreq: Math.max(1, bpf),
    propCut: 700 + 2600 * e + 300 * alive,
    propGain: 0.05 * alive + 0.25 * e,
    whineFreq: 400 + 6800 * nh,
    whineGain: 0.024 * alive * (1 - 0.5 * e),
    washCut: 700 + 1400 * e,
    washGain: 0.02 * alive + 0.36 * e,
    rumbleGain: 0.03 * alive + 0.47 * e * e,
  };
}

/** Relative loudness estimate used to rank voices (before distance). */
function loudness(ac: AircraftAudioState, spool: number): number {
  const { alive, e } = powerOf(spool, ac.reverse);
  return SIZE_LOUD[ac.size] * engineFactor(ac.engines) * (0.18 * alive + e);
}

interface FanLayers {
  kind: 'turbofan';
  rates: Param[];
  roarCut: Param;
  roarG: Param;
  crackG: Param;
  rumG: Param;
  fan1: Param;
  fan2: Param;
  fanG: Param;
  whine: Param;
  whineG: Param;
  saw: Param;
  sawG: Param;
}

interface PropLayers {
  kind: 'turboprop';
  rates: Param[];
  prop1: Param;
  prop2: Param;
  propCut: Param;
  propG: Param;
  whine: Param;
  whineG: Param;
  washCut: Param;
  washG: Param;
  rumG: Param;
}

interface VoiceInputs {
  spool: number;
  reverse: number;
  size: SizeClass;
  engines: number;
  doppler: number;
  distance: number;
  /** -1 = listener behind the aircraft, +1 = in front, 0 = unknown. */
  front: number;
}

class EngineVoice {
  private readonly mix: GainNode;
  private readonly flutter: OscillatorNode;
  private readonly flutterDepth: GainNode;
  private readonly absorb: BiquadFilterNode;
  private readonly level: GainNode;
  private readonly panner: PannerNode;
  private readonly pLevel: Param;
  private readonly pAbsorb: Param;
  private readonly pFlutter: Param;
  private sources: AudioScheduledSourceNode[] = [];
  private nodes: AudioNode[] = [];
  private layers: FanLayers | PropLayers | null = null;
  kind: EngineKind | null = null;
  acId: string | null = null;
  state: 'free' | 'active' | 'releasing' = 'free';
  freeAt = 0;
  idleSince = 0;
  doppler = 1;

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: SampleBank,
    out: AudioNode,
    hrtf: boolean,
  ) {
    this.mix = gainNode(ctx, 1);
    this.flutter = oscillator(ctx, 'sine', 0.22 + Math.random() * 0.5);
    this.flutterDepth = gainNode(ctx, 0.04);
    this.flutter.connect(this.flutterDepth).connect(this.mix.gain);
    this.flutter.start();
    this.absorb = biquad(ctx, 'lowpass', 18000, 0.5);
    this.level = gainNode(ctx, 0);
    this.panner = createPanner(ctx, hrtf);
    this.mix.connect(this.absorb).connect(this.level).connect(this.panner).connect(out);
    this.pLevel = new Param(ctx, this.level.gain, 0.08);
    this.pAbsorb = new Param(ctx, this.absorb.frequency, 0.08);
    this.pFlutter = new Param(ctx, this.flutterDepth.gain, 0.5);
  }

  get sleeping(): boolean {
    return this.sources.length === 0;
  }

  assign(ac: AircraftAudioState, inp: VoiceInputs, level: number, pos: V3): void {
    if (this.kind !== ac.engine || this.sleeping) this.rebuild(ac.engine);
    this.acId = ac.id;
    this.state = 'active';
    this.doppler = inp.doppler;
    jumpPannerPosition(this.panner, this.ctx, pos);
    this.pAbsorb.jump(absorptionHz(inp.distance));
    this.apply(inp, true);
    this.pLevel.jump(0);
    this.pLevel.set(level, 0.15);
  }

  release(now: number): void {
    if (this.state !== 'active') return;
    this.state = 'releasing';
    this.pLevel.set(0, 0.08);
    this.freeAt = now + 0.45;
  }

  /** Housekeeping: finish releases, put long-idle voices to sleep. */
  tick(now: number): void {
    if (this.state === 'releasing' && now >= this.freeAt) {
      this.state = 'free';
      this.acId = null;
      this.idleSince = now;
    }
    if (this.state === 'free' && !this.sleeping && now - this.idleSince > 4) this.stopSources();
  }

  update(inp: VoiceInputs, level: number, pos: V3): void {
    setPannerPosition(this.panner, this.ctx, pos);
    this.pAbsorb.set(absorptionHz(inp.distance));
    this.pFlutter.set(0.03 + 0.14 * clamp(inp.distance / 3000, 0, 1));
    this.apply(inp, false);
    if (this.state === 'active') this.pLevel.set(level);
  }

  private apply(inp: VoiceInputs, jump: boolean): void {
    const L = this.layers;
    if (!L) return;
    const dop = inp.doppler;
    const roarDir = 1 - 0.3 * inp.front;
    const toneDir = 1 + 0.5 * inp.front;
    const set = (p: Param, v: number) => (jump ? p.jump(v) : p.set(v));
    for (const r of L.rates) set(r, dop);
    if (L.kind === 'turbofan') {
      const p = turbofanParams(inp.spool, inp.reverse, inp.size);
      set(L.roarCut, Math.min(18000, p.roarCut * dop));
      set(L.roarG, p.roarGain * roarDir);
      set(L.crackG, p.crackGain * roarDir);
      set(L.rumG, p.rumbleGain);
      set(L.fan1, p.fanFreq * dop);
      set(L.fan2, p.fanFreq * dop * 1.004);
      set(L.fanG, p.fanGain * toneDir);
      set(L.whine, p.whineFreq * dop);
      set(L.whineG, p.whineGain * toneDir);
      set(L.saw, p.sawFreq * dop);
      set(L.sawG, p.sawGain * (0.6 + 0.4 * toneDir));
    } else {
      const p = turbopropParams(inp.spool, inp.reverse);
      set(L.prop1, p.propFreq * dop);
      set(L.prop2, (p.propFreq + 0.7) * dop);
      set(L.propCut, Math.min(18000, p.propCut * dop));
      set(L.propG, p.propGain * (0.8 + 0.2 * toneDir));
      set(L.whine, p.whineFreq * dop);
      set(L.whineG, p.whineGain * toneDir);
      set(L.washCut, p.washCut * dop);
      set(L.washG, p.washGain * roarDir);
      set(L.rumG, p.rumbleGain);
    }
  }

  private rebuild(kind: EngineKind): void {
    this.stopSources();
    const c = this.ctx;
    const b = this.bank;
    const t = c.currentTime;
    const P = (param: AudioParam, tc = 0.06) => new Param(c, param, tc);
    if (kind === 'turbofan') {
      const roarSrc = loopSource(c, b.pink);
      const roarHp = biquad(c, 'highpass', 35, 0.7);
      const roarLp = biquad(c, 'lowpass', 900, 0.55);
      const roarG = gainNode(c, 0);
      roarSrc.connect(roarHp).connect(roarLp).connect(roarG).connect(this.mix);
      const crackSrc = loopSource(c, b.crackle);
      const crackBp = biquad(c, 'bandpass', 2600, 0.7);
      const crackG = gainNode(c, 0);
      crackSrc.connect(crackBp).connect(crackG).connect(this.mix);
      const rumSrc = loopSource(c, b.brown);
      const rumLp = biquad(c, 'lowpass', 150, 0.7);
      const rumG = gainNode(c, 0);
      rumSrc.connect(rumLp).connect(rumG).connect(this.mix);
      const fan1 = oscillator(c, b.fanWave, 500);
      const fan2 = oscillator(c, b.fanWave, 500, 5 + Math.random() * 6);
      const fanG = gainNode(c, 0);
      fan1.connect(fanG);
      fan2.connect(fanG);
      fanG.connect(this.mix);
      const whine = oscillator(c, 'sine', 4000);
      const whineG = gainNode(c, 0);
      whine.connect(whineG).connect(this.mix);
      const saw = oscillator(c, 'sawtooth', 60);
      const sawLp = biquad(c, 'lowpass', 1700, 0.7);
      const sawG = gainNode(c, 0);
      saw.connect(sawLp).connect(sawG).connect(this.mix);
      for (const s of [roarSrc, crackSrc, rumSrc]) startLoop(s, t);
      for (const o of [fan1, fan2, whine, saw]) o.start(t);
      this.sources = [roarSrc, crackSrc, rumSrc, fan1, fan2, whine, saw];
      this.nodes = [roarHp, roarLp, roarG, crackBp, crackG, rumLp, rumG, fanG, whineG, sawLp, sawG];
      this.layers = {
        kind,
        rates: [P(roarSrc.playbackRate), P(crackSrc.playbackRate), P(rumSrc.playbackRate)],
        roarCut: P(roarLp.frequency),
        roarG: P(roarG.gain, 0.08),
        crackG: P(crackG.gain, 0.08),
        rumG: P(rumG.gain, 0.1),
        fan1: P(fan1.frequency),
        fan2: P(fan2.frequency),
        fanG: P(fanG.gain),
        whine: P(whine.frequency),
        whineG: P(whineG.gain),
        saw: P(saw.frequency),
        sawG: P(sawG.gain, 0.1),
      };
    } else {
      const prop1 = oscillator(c, b.propWave, 100);
      const prop2 = oscillator(c, b.propWave, 100);
      const propLp = biquad(c, 'lowpass', 1500, 0.8);
      const propG = gainNode(c, 0);
      prop1.connect(propLp);
      prop2.connect(propLp);
      propLp.connect(propG).connect(this.mix);
      const whine = oscillator(c, 'sine', 5000);
      const whineG = gainNode(c, 0);
      whine.connect(whineG).connect(this.mix);
      const washSrc = loopSource(c, b.pink);
      const washBp = biquad(c, 'bandpass', 900, 0.6);
      const washG = gainNode(c, 0);
      washSrc.connect(washBp).connect(washG).connect(this.mix);
      const rumSrc = loopSource(c, b.brown);
      const rumLp = biquad(c, 'lowpass', 120, 0.7);
      const rumG = gainNode(c, 0);
      rumSrc.connect(rumLp).connect(rumG).connect(this.mix);
      for (const s of [washSrc, rumSrc]) startLoop(s, t);
      for (const o of [prop1, prop2, whine]) o.start(t);
      this.sources = [prop1, prop2, whine, washSrc, rumSrc];
      this.nodes = [propLp, propG, whineG, washBp, washG, rumLp, rumG];
      this.layers = {
        kind,
        rates: [P(washSrc.playbackRate), P(rumSrc.playbackRate)],
        prop1: P(prop1.frequency),
        prop2: P(prop2.frequency),
        propCut: P(propLp.frequency),
        propG: P(propG.gain, 0.08),
        whine: P(whine.frequency),
        whineG: P(whineG.gain),
        washCut: P(washBp.frequency),
        washG: P(washG.gain, 0.08),
        rumG: P(rumG.gain, 0.1),
      };
    }
    this.kind = kind;
  }

  private stopSources(): void {
    for (const s of this.sources) {
      safeStop(s);
      safeDisconnect(s);
    }
    for (const n of this.nodes) safeDisconnect(n);
    this.sources = [];
    this.nodes = [];
    this.layers = null;
    this.kind = null;
  }

  dispose(): void {
    this.stopSources();
    safeStop(this.flutter);
    for (const n of [this.flutter, this.flutterDepth, this.mix, this.absorb, this.level, this.panner]) safeDisconnect(n);
  }
}

interface SpoolState {
  s: number;
  frame: number;
}

interface Candidate {
  ac: AircraftAudioState;
  score: number;
}

export class EnginePool {
  private readonly voices: EngineVoice[] = [];
  private readonly spools = new Map<string, SpoolState>();
  private readonly byAc = new Map<string, EngineVoice>();
  private readonly scores = new Map<string, number>();
  private frame = 0;
  private selAccum = 1;
  private paramAccum = 1;
  private readonly tmp: V3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: SampleBank,
    private readonly out: AudioNode,
    private readonly hrtf = true,
  ) {}

  get activeVoices(): number {
    return this.byAc.size;
  }

  update(list: readonly AircraftAudioState[], lis: V3, lisVel: V3, dt: number, simDt: number): void {
    this.frame++;
    const now = this.ctx.currentTime;

    for (const ac of list) {
      let st = this.spools.get(ac.id);
      const target = ac.running ? clamp(ac.thrust, IDLE, 1) : 0;
      if (!st) {
        st = { s: ac.running ? target : 0, frame: this.frame };
        this.spools.set(ac.id, st);
      }
      st.frame = this.frame;
      if (simDt > 0) {
        const up = target > st.s;
        const k = up ? (st.s < IDLE ? 0.18 : 0.55) : target === 0 ? 0.12 : 0.35;
        st.s += (target - st.s) * damp(k, simDt);
      }
    }
    if (this.frame % 120 === 0) {
      for (const [id, st] of this.spools) if (this.frame - st.frame > 240) this.spools.delete(id);
    }

    this.selAccum += dt;
    if (this.selAccum >= 0.1) {
      this.selAccum = 0;
      this.select(list, lis, lisVel, now);
    }

    this.paramAccum += dt;
    if (this.paramAccum >= 1 / 30) {
      const step = this.paramAccum;
      this.paramAccum = 0;
      for (const ac of list) {
        const v = this.byAc.get(ac.id);
        if (!v || v.state !== 'active') continue;
        const inp = this.inputs(ac, lis, lisVel);
        const target = inp.doppler;
        v.doppler += (target - v.doppler) * damp(6, step);
        inp.doppler = v.doppler;
        this.tmp.x = ac.position.x;
        this.tmp.y = ac.position.y;
        this.tmp.z = ac.position.z;
        v.update(inp, this.levelFor(ac, inp.distance), this.tmp);
      }
    }
    for (const v of this.voices) v.tick(now);
  }

  private spoolOf(id: string): number {
    return this.spools.get(id)?.s ?? 0;
  }

  private levelFor(ac: AircraftAudioState, d: number): number {
    return ENGINE_GAIN * SIZE_LOUD[ac.size] * engineFactor(ac.engines) * distanceAtt(d);
  }

  private inputs(ac: AircraftAudioState, lis: V3, lisVel: V3): VoiceInputs {
    const dx = lis.x - ac.position.x;
    const dy = lis.y - ac.position.y;
    const dz = lis.z - ac.position.z;
    const d = Math.max(1, Math.hypot(dx, dy, dz));
    const ux = dx / d, uy = dy / d, uz = dz / d;
    const vs = ac.velocity.x * ux + ac.velocity.y * uy + ac.velocity.z * uz;
    const vl = lisVel.x * ux + lisVel.y * uy + lisVel.z * uz;
    const approach = clamp(vs - vl, -250, 250);
    const doppler = SPEED_OF_SOUND / (SPEED_OF_SOUND - approach);
    const sp = Math.hypot(ac.velocity.x, ac.velocity.y, ac.velocity.z);
    const front = sp > 8 ? clamp(vs / sp, -1, 1) : 0;
    return {
      spool: this.spoolOf(ac.id),
      reverse: ac.reverse,
      size: ac.size,
      engines: ac.engines,
      doppler,
      distance: d,
      front,
    };
  }

  private select(list: readonly AircraftAudioState[], lis: V3, lisVel: V3, now: number): void {
    const cands: Candidate[] = [];
    this.scores.clear();
    for (const ac of list) {
      const s = this.spoolOf(ac.id);
      if (s < 0.01) continue;
      const d = Math.hypot(lis.x - ac.position.x, lis.y - ac.position.y, lis.z - ac.position.z);
      const score = loudness(ac, s) * distanceAtt(d);
      if (score < 2e-4) continue;
      cands.push({ ac, score });
      this.scores.set(ac.id, score);
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands.slice(0, MAX_VOICES);
    const topIds = new Set(top.map((c) => c.ac.id));
    const keepIds = new Set(cands.slice(0, MAX_VOICES + 4).map((c) => c.ac.id));

    for (const [id, v] of this.byAc) {
      if (!keepIds.has(id) || v.state !== 'active' || v.acId !== id) {
        v.release(now);
        this.byAc.delete(id);
      }
    }

    for (const c of top) {
      if (this.byAc.has(c.ac.id)) continue;
      const v = this.freeVoice(now);
      if (!v) {
        let weakestId: string | null = null;
        let weakest = Infinity;
        for (const id of this.byAc.keys()) {
          if (topIds.has(id)) continue;
          const sc = this.scores.get(id) ?? 0;
          if (sc < weakest) {
            weakest = sc;
            weakestId = id;
          }
        }
        if (weakestId !== null && weakest < c.score * 0.6) {
          this.byAc.get(weakestId)?.release(now);
          this.byAc.delete(weakestId);
        }
        continue;
      }
      const inp = this.inputs(c.ac, lis, lisVel);
      v.assign(c.ac, inp, this.levelFor(c.ac, inp.distance), c.ac.position);
      this.byAc.set(c.ac.id, v);
    }
  }

  private freeVoice(now: number): EngineVoice | null {
    for (const v of this.voices) {
      v.tick(now);
      if (v.state === 'free') return v;
    }
    if (this.voices.length < MAX_VOICES) {
      const v = new EngineVoice(this.ctx, this.bank, this.out, this.hrtf);
      this.voices.push(v);
      return v;
    }
    return null;
  }

  dispose(): void {
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
    this.byAc.clear();
  }
}

/** Main-gear touchdown: two short tyre chirps (left/right mains) plus a low thump, positional. */
export function playTouchdown(
  ctx: AudioContext,
  bank: SampleBank,
  out: AudioNode,
  pos: V3,
  lis: V3,
  intensity: number,
  hrtf: boolean,
): void {
  const d = Math.hypot(pos.x - lis.x, pos.y - lis.y, pos.z - lis.z);
  const level = 6 * clamp(intensity, 0, 1) * distanceAtt(d);
  if (level < 1e-3) return;
  const t = ctx.currentTime + 0.01;
  const panner = createPanner(ctx, hrtf);
  jumpPannerPosition(panner, ctx, pos);
  const absorb = biquad(ctx, 'lowpass', absorptionHz(d), 0.5);
  const bus = gainNode(ctx, level);
  bus.connect(absorb).connect(panner).connect(out);

  const offsets = [0, 0.045 + Math.random() * 0.05];
  let end = t;
  offsets.forEach((off, i) => {
    const src = ctx.createBufferSource();
    src.buffer = bank.white;
    const bp = biquad(ctx, 'bandpass', 1900 + Math.random() * 500, 2.2);
    const g = gainNode(ctx, 0.0001);
    src.connect(bp).connect(g).connect(bus);
    const t0 = t + off;
    const dur = 0.13 + Math.random() * 0.08;
    bp.frequency.setValueAtTime(bp.frequency.value, t0);
    bp.frequency.exponentialRampToValueAtTime(1150, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(i === 0 ? 0.9 : 0.7, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.start(t0, Math.random() * (bank.white.duration - 0.5));
    src.stop(t0 + dur + 0.05);
    autoCleanup(src, [bp, g]);
    end = Math.max(end, t0 + dur + 0.05);
  });
  const squeal = oscillator(ctx, 'triangle', 1180 + Math.random() * 200);
  const sg = gainNode(ctx, 0.0001);
  squeal.connect(sg).connect(bus);
  squeal.frequency.setValueAtTime(squeal.frequency.value, t);
  squeal.frequency.exponentialRampToValueAtTime(820, t + 0.16);
  sg.gain.setValueAtTime(0.0001, t);
  sg.gain.exponentialRampToValueAtTime(0.12, t + 0.006);
  sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  squeal.start(t);
  squeal.stop(t + 0.2);
  autoCleanup(squeal, [sg]);

  const thump = oscillator(ctx, 'sine', 62);
  const tg = gainNode(ctx, 0.0001);
  thump.connect(tg).connect(bus);
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.8, t + 0.008);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  thump.start(t);
  thump.stop(t + 0.18);
  thump.onended = () => {
    safeDisconnect(thump);
    safeDisconnect(tg);
  };
  // Tear down the shared chain once every part has finished.
  const cleanupAt = Math.max(end, t + 0.25) - ctx.currentTime + 0.2;
  setTimeout(() => {
    safeDisconnect(bus);
    safeDisconnect(absorb);
    safeDisconnect(panner);
  }, cleanupAt * 1000);
}
