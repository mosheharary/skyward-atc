// Environmental ambience: wind, rain (outdoor + on the tower glass), thunder, birds, crickets,
// tower-cab HVAC hum and console beeps, and a distant airport bed.

import { clamp, damp, smoothstep } from '../core/units';
import type { AudioFrame } from './contracts';
import type { SampleBank } from './samples';
import { Param, autoCleanup, biquad, envelope, gainNode, loopSource, oscillator, startLoop, type V3 } from './util';

interface RainNodes {
  light: Param;
  heavy: Param;
  glass: Param;
  glassRate: Param;
}

interface CricketNodes {
  g: Param;
  rate: Param;
}

export class Ambience {
  private readonly windG: Param;
  private readonly windBp: Param;
  private readonly whistleG: Param;
  private readonly whistleBp: Param;
  private readonly cabWhistleG: Param;
  private readonly cabG: Param;
  private readonly bedG: Param;
  private rain: RainNodes | null = null;
  private crickets: CricketNodes | null = null;
  private time = 0;
  private gust = 0;
  private gustTarget = 0;
  private gustNext = 0;
  private accum = 1;
  private nextBird = 0;
  private nextBeep = 0;
  private nextBeeper = 0;
  private readonly seen = new Set<number>();
  private readonly seenOrder: number[] = [];

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: SampleBank,
    private readonly outdoorIn: AudioNode,
    private readonly indoorIn: AudioNode,
    private readonly reverbIn: AudioNode,
  ) {
    const c = ctx;
    const t = c.currentTime;

    // Wind: decorrelated stereo pink noise through a moving band-pass, plus a narrow whistle.
    const wA = loopSource(c, bank.pink, 1);
    const wB = loopSource(c, bank.pink, 0.97);
    const merge = c.createChannelMerger(2);
    wA.connect(merge, 0, 0);
    wB.connect(merge, 0, 1);
    const windBp = biquad(c, 'bandpass', 400, 0.55);
    const windLp = biquad(c, 'lowpass', 1800, 0.7);
    const windG = gainNode(c, 0);
    merge.connect(windBp).connect(windLp).connect(windG).connect(outdoorIn);
    const whSrc = loopSource(c, bank.white);
    const whBp = biquad(c, 'bandpass', 1000, 14);
    const whG = gainNode(c, 0);
    whSrc.connect(whBp).connect(whG).connect(outdoorIn);
    const cabWhG = gainNode(c, 0);
    whBp.connect(cabWhG).connect(indoorIn);
    startLoop(wA, t);
    startLoop(wB, t);
    startLoop(whSrc, t);
    this.windG = new Param(c, windG.gain, 0.25);
    this.windBp = new Param(c, windBp.frequency, 0.3);
    this.whistleG = new Param(c, whG.gain, 0.3);
    this.whistleBp = new Param(c, whBp.frequency, 0.4);
    this.cabWhistleG = new Param(c, cabWhG.gain, 0.3);

    // Tower cab: HVAC rumble, mains hum, fan hiss.
    const cab = gainNode(c, 0);
    const humSrc = loopSource(c, bank.brown, 0.9);
    const humLp = biquad(c, 'lowpass', 110, 0.7);
    const humG = gainNode(c, 0.3);
    humSrc.connect(humLp).connect(humG).connect(cab);
    const mains = oscillator(c, 'sine', 60);
    const mainsG = gainNode(c, 0.012);
    mains.connect(mainsG).connect(cab);
    const mains2 = oscillator(c, 'sine', 120);
    const mains2G = gainNode(c, 0.006);
    mains2.connect(mains2G).connect(cab);
    const fanSrc = loopSource(c, bank.pink, 0.9);
    const fanBp = biquad(c, 'bandpass', 380, 0.8);
    const fanG = gainNode(c, 0.35);
    fanSrc.connect(fanBp).connect(fanG).connect(cab);
    cab.connect(indoorIn);
    startLoop(humSrc, t);
    startLoop(fanSrc, t);
    mains.start(t);
    mains2.start(t);
    this.cabG = new Param(c, cab.gain, 0.4);

    // Distant airport bed: low rumble of APUs, vehicles, far-away engines.
    const bed = gainNode(c, 0);
    const bedSrc = loopSource(c, bank.brown, 0.8);
    const bedLp = biquad(c, 'lowpass', 280, 0.7);
    bedSrc.connect(bedLp).connect(bed);
    const bed2 = loopSource(c, bank.pink, 0.6);
    const bed2Bp = biquad(c, 'bandpass', 170, 0.5);
    const bed2G = gainNode(c, 0.5);
    bed2.connect(bed2Bp).connect(bed2G).connect(bed);
    bed.connect(outdoorIn);
    startLoop(bedSrc, t);
    startLoop(bed2, t);
    this.bedG = new Param(c, bed.gain, 0.5);
  }

  update(frame: AudioFrame, lis: V3, right: V3, dt: number): void {
    const now = this.ctx.currentTime;
    this.time += dt;
    if (this.time >= this.gustNext) {
      this.gustTarget = Math.pow(Math.random(), 1.5);
      this.gustNext = this.time + 0.8 + Math.random() * 3.2;
    }
    this.gust += (this.gustTarget - this.gust) * damp(0.9, dt);
    this.accum += dt;
    if (this.accum >= 0.1) {
      this.accum = 0;
      this.updateTargets(frame);
    }
    this.scheduleEvents(frame, now);
    this.checkLightning(frame, lis, right, now);
  }

  private updateTargets(frame: AudioFrame): void {
    const w = frame.weather;
    const speed = Math.max(0, w.windSpeed);
    const base = smoothstep(1, 32, speed);
    const gustAmt = w.gust > speed ? clamp((w.gust - speed) / 20, 0, 1) : 0;
    const g = this.gust;
    const level = clamp(base * (0.7 + 0.3 * g) + gustAmt * g * 0.6 + (w.thunderstorm ? 0.15 : 0), 0, 1.2);
    this.windG.set(1.0 * level);
    this.windBp.set(240 + 520 * level + 160 * g);
    this.whistleG.set(0.9 * smoothstep(0.35, 1, level));
    this.whistleBp.set(780 + 650 * g);
    this.cabWhistleG.set(frame.indoor ? 0.45 * smoothstep(0.3, 1, level) : 0);
    this.cabG.set(frame.indoor ? 0.25 : 0);
    const night = clamp(frame.nightFactor, 0, 1);
    this.bedG.set(0.07 * (1 - 0.35 * night));

    const p = clamp(w.precipitation + (w.thunderstorm ? 0.15 : 0), 0, 1);
    if (p > 0.005 && !this.rain) this.rain = this.buildRain();
    if (this.rain) {
      this.rain.light.set(0.9 * smoothstep(0, 0.35, p) * (1 - 0.6 * smoothstep(0.4, 1, p)), 0.6);
      this.rain.heavy.set(0.85 * smoothstep(0.25, 1, p), 0.6);
      this.rain.glass.set(frame.indoor ? (0.2 + 0.35 * p) * smoothstep(0, 0.15, p) : 0, 0.5);
      this.rain.glassRate.set(0.85 + 0.4 * p, 1);
    }

    const cr =
      0.28 *
      smoothstep(0.55, 0.9, night) *
      smoothstep(8, 16, w.temperature) *
      (1 - smoothstep(0.03, 0.25, p)) *
      (1 - smoothstep(12, 25, speed));
    if (cr > 0.002 && !this.crickets) this.crickets = this.buildCrickets();
    if (this.crickets) {
      this.crickets.g.set(cr, 0.8);
      // Dolbear's law: chirp rate follows temperature.
      const tf = (w.temperature * 9) / 5 + 32;
      const cpm = clamp(4 * (tf - 50) + 40, 50, 190);
      this.crickets.rate.set(clamp(cpm / 120, 0.6, 1.5), 1);
    }
  }

  private buildRain(): RainNodes {
    const c = this.ctx;
    const t = c.currentTime;
    const shelf = biquad(c, 'highshelf', 3500, 0.7, -3);
    shelf.connect(this.outdoorIn);
    const light = loopSource(c, this.bank.rainLight);
    const lightG = gainNode(c, 0);
    light.connect(lightG).connect(shelf);
    const heavy = loopSource(c, this.bank.rainHeavy);
    const heavyG = gainNode(c, 0);
    heavy.connect(heavyG).connect(shelf);
    const glass = loopSource(c, this.bank.rainGlass);
    const glassG = gainNode(c, 0);
    glass.connect(glassG).connect(this.indoorIn);
    startLoop(light, t);
    startLoop(heavy, t);
    startLoop(glass, t);
    return {
      light: new Param(c, lightG.gain),
      heavy: new Param(c, heavyG.gain),
      glass: new Param(c, glassG.gain),
      glassRate: new Param(c, glass.playbackRate),
    };
  }

  private buildCrickets(): CricketNodes {
    const c = this.ctx;
    const src = loopSource(c, this.bank.crickets);
    const hp = biquad(c, 'highpass', 2500, 0.7);
    const g = gainNode(c, 0);
    src.connect(hp).connect(g).connect(this.outdoorIn);
    startLoop(src, c.currentTime);
    return { g: new Param(c, g.gain), rate: new Param(c, src.playbackRate) };
  }

  private scheduleEvents(frame: AudioFrame, now: number): void {
    const w = frame.weather;
    const day = 1 - smoothstep(0.15, 0.4, frame.nightFactor);
    const birdsOk = day > 0.05 && w.precipitation < 0.15 && w.windSpeed < 22 && !w.thunderstorm;
    if (this.nextBird === 0) this.nextBird = now + 2 + Math.random() * 4;
    if (now >= this.nextBird) {
      if (birdsOk) {
        this.bird(now + 0.05, 0.035 * day);
        if (Math.random() < 0.35) this.bird(now + 0.7 + Math.random(), 0.026 * day);
      }
      this.nextBird = now + 3 + Math.random() * 9;
    }
    if (this.nextBeep === 0) this.nextBeep = now + 10 + Math.random() * 20;
    if (now >= this.nextBeep) {
      if (frame.indoor && !frame.paused) this.consoleBeep(now + 0.02);
      this.nextBeep = now + 25 + Math.random() * 50;
    }
    if (this.nextBeeper === 0) this.nextBeeper = now + 30 + Math.random() * 60;
    if (now >= this.nextBeeper) {
      if (!frame.paused) this.beeper(now + 0.05, 0.006 * (1 - 0.5 * frame.nightFactor));
      this.nextBeeper = now + (60 + Math.random() * 90) * (1 + frame.nightFactor);
    }
  }

  private checkLightning(frame: AudioFrame, lis: V3, right: V3, now: number): void {
    for (const s of frame.weather.lightning) {
      if (this.seen.has(s.id)) continue;
      this.seen.add(s.id);
      this.seenOrder.push(s.id);
      if (this.seenOrder.length > 64) this.seen.delete(this.seenOrder.shift() as number);
      const dx = s.x - lis.x;
      const dz = -s.y - lis.z;
      const d = Math.hypot(dx, 0 - lis.y, dz);
      const remain = d / 343 - Math.max(0, frame.simTime - s.t);
      if (remain < -4) continue;
      const scale = frame.timeScale > 0 ? frame.timeScale : 1;
      const horiz = Math.max(1, Math.hypot(dx, dz));
      const pan = clamp((dx * right.x + dz * right.z) / horiz, -1, 1) * 0.8;
      this.thunder(d, pan, now + Math.max(0, remain / scale));
    }
  }

  /** Thunder at a distance (m) with stereo pan (-1..1), scheduled at AudioContext time `when`. */
  thunder(distance: number, pan: number, when: number): void {
    const c = this.ctx;
    const d = Math.max(50, distance);
    const loud = clamp(2.5 * Math.pow(600 / Math.max(600, d), 0.85), 0.08, 2.5);
    const near = d < 1800;
    const out = gainNode(c, 1);
    const panner = c.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    out.connect(panner).connect(this.outdoorIn);
    const send = gainNode(c, 0.35 + 0.3 * clamp(d / 8000, 0, 1));
    panner.connect(send).connect(this.reverbIn);

    const dur = 5 + 7 * Math.random() + Math.min(4, d / 3000);
    const src = loopSource(c, this.bank.brown, 0.8 + Math.random() * 0.3);
    const cut = clamp(2400 * Math.pow(800 / Math.max(d, 200), 0.7), 160, 2400);
    const lp = biquad(c, 'lowpass', cut, 0.6);
    const lp2 = biquad(c, 'lowpass', cut * 1.3, 0.6);
    const g = gainNode(c, 0);
    src.connect(lp).connect(lp2).connect(g).connect(out);
    const gp = g.gain;
    gp.setValueAtTime(0, when);
    const rolls = 3 + Math.floor(Math.random() * 4);
    let t = when + (near ? 0.04 : 0.2 + Math.random() * 0.5);
    let amp = loud * (near ? 1.4 : 1.1);
    for (let i = 0; i < rolls; i++) {
      gp.setTargetAtTime(amp, t, 0.04 + Math.random() * 0.25);
      const hold = 0.25 + Math.random() * 0.9;
      gp.setTargetAtTime(amp * (0.25 + 0.2 * Math.random()), t + hold, 0.35 + Math.random() * 0.4);
      t += hold + 0.3 + Math.random();
      amp *= 0.55 + Math.random() * 0.35;
    }
    gp.setTargetAtTime(0, Math.max(t, when + dur * 0.6), dur * 0.18);
    src.start(when, Math.random() * (this.bank.brown.duration - 0.1));
    src.stop(when + dur + 3);
    autoCleanup(src, [lp, lp2, g, out, panner, send]);

    if (near) {
      const cs = c.createBufferSource();
      cs.buffer = this.bank.white;
      const hp = biquad(c, 'highpass', 700, 0.7);
      const pk = biquad(c, 'peaking', 3200, 1, 6);
      const cg = gainNode(c, 0.0001);
      cs.connect(hp).connect(pk).connect(cg).connect(out);
      const ca = Math.max(0.002, loud * 0.9 * (1 - d / 2500));
      const cp = cg.gain;
      cp.setValueAtTime(0.0001, when);
      cp.exponentialRampToValueAtTime(ca, when + 0.003);
      cp.exponentialRampToValueAtTime(ca * 0.3, when + 0.07);
      cp.exponentialRampToValueAtTime(ca * 0.75, when + 0.11);
      cp.exponentialRampToValueAtTime(ca * 0.2, when + 0.2);
      cp.exponentialRampToValueAtTime(0.0001, when + 0.65);
      cs.start(when, Math.random() * 1.5);
      cs.stop(when + 0.7);
      autoCleanup(cs, [hp, pk, cg]);
    }
  }

  private bird(t0: number, level: number): void {
    const c = this.ctx;
    const o = oscillator(c, 'sine', 3000);
    const am = gainNode(c, 1);
    const g = gainNode(c, 0.0001);
    const pan = c.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    o.connect(am).connect(g).connect(pan).connect(this.outdoorIn);
    const nodes: AudioNode[] = [am, g, pan];
    const kind = Math.random();
    const f = o.frequency;
    let t = t0;
    let lfo: OscillatorNode | null = null;
    if (kind < 0.45) {
      const n = 3 + Math.floor(Math.random() * 4);
      const f0 = 3800 + Math.random() * 1800;
      for (let i = 0; i < n; i++) {
        const fi = f0 * (1 + (Math.random() - 0.5) * 0.08);
        f.setValueAtTime(fi, t);
        f.exponentialRampToValueAtTime(fi * 0.62, t + 0.055);
        envelope(g.gain, t, level, 0.006, 0.06);
        t += 0.08 + Math.random() * 0.05;
      }
    } else if (kind < 0.8) {
      const f0 = 2300 + Math.random() * 900;
      f.setValueAtTime(f0, t);
      f.linearRampToValueAtTime(f0 * 1.25, t + 0.22);
      envelope(g.gain, t, level * 0.8, 0.03, 0.25);
      t += 0.32;
      f.setValueAtTime(f0 * 0.9, t);
      f.linearRampToValueAtTime(f0 * 0.84, t + 0.2);
      envelope(g.gain, t, level * 0.7, 0.02, 0.22);
      t += 0.3;
    } else {
      const f0 = 4500 + Math.random() * 1500;
      const dur = 0.5 + Math.random() * 0.5;
      f.setValueAtTime(f0, t);
      f.linearRampToValueAtTime(f0 * 0.85, t + dur);
      am.gain.value = 0.5;
      lfo = oscillator(c, 'sine', 22 + Math.random() * 16);
      const lg = gainNode(c, 0.5);
      lfo.connect(lg).connect(am.gain);
      nodes.push(lg);
      envelope(g.gain, t, level * 0.8, 0.04, dur);
      lfo.start(t);
      lfo.stop(t + dur + 0.1);
      t += dur + 0.05;
    }
    o.start(t0);
    o.stop(t + 0.1);
    if (lfo) nodes.push(lfo);
    autoCleanup(o, nodes);
  }

  private consoleBeep(t0: number): void {
    const c = this.ctx;
    const o = oscillator(c, 'sine', 1320);
    const g = gainNode(c, 0.0001);
    o.connect(g).connect(this.indoorIn);
    let end: number;
    if (Math.random() < 0.55) {
      envelope(g.gain, t0, 0.02, 0.004, 0.07);
      o.frequency.setValueAtTime(1760, t0 + 0.1);
      end = envelope(g.gain, t0 + 0.1, 0.02, 0.004, 0.07);
    } else {
      o.frequency.setValueAtTime(880, t0);
      end = envelope(g.gain, t0, 0.014, 0.004, 0.12);
    }
    o.start(t0);
    o.stop(end + 0.05);
    autoCleanup(o, [g]);
  }

  private beeper(t0: number, level: number): void {
    const c = this.ctx;
    const o = oscillator(c, 'square', 1040 + Math.random() * 80);
    const lp = biquad(c, 'lowpass', 1500, 0.7);
    const g = gainNode(c, 0);
    const pan = c.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    o.connect(lp).connect(g).connect(pan).connect(this.outdoorIn);
    const send = gainNode(c, 0.6);
    pan.connect(send).connect(this.reverbIn);
    const n = 5 + Math.floor(Math.random() * 6);
    let t = t0;
    for (let i = 0; i < n; i++) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.01);
      g.gain.setValueAtTime(level, t + 0.4);
      g.gain.linearRampToValueAtTime(0, t + 0.42);
      t += 0.9;
    }
    o.start(t0);
    o.stop(t + 0.1);
    autoCleanup(o, [lp, g, pan, send]);
  }
}
