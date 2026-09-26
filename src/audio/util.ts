// Small Web Audio helpers shared by the audio sub-modules.

export const TAU = Math.PI * 2;

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** AudioParam wrapper that smooths changes and skips redundant automation events. */
export class Param {
  private last = Number.NaN;

  constructor(
    private readonly ctx: BaseAudioContext,
    readonly param: AudioParam,
    private readonly tc = 0.05,
  ) {}

  set(v: number, tc: number = this.tc): void {
    if (!Number.isFinite(v)) return;
    const l = this.last;
    if (l === l && Math.abs(v - l) <= 1e-4 * Math.max(1, Math.abs(v))) return;
    this.last = v;
    this.param.setTargetAtTime(v, this.ctx.currentTime, Math.max(0.001, tc));
  }

  jump(v: number): void {
    if (!Number.isFinite(v)) return;
    this.last = v;
    const t = this.ctx.currentTime;
    this.param.cancelScheduledValues(t);
    this.param.setValueAtTime(v, t);
  }

  get target(): number {
    return this.last;
  }
}

export function gainNode(ctx: BaseAudioContext, value = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

export function biquad(ctx: BaseAudioContext, type: BiquadFilterType, frequency: number, Q = 0.707, gainDb = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gainDb;
  return f;
}

export function oscillator(ctx: BaseAudioContext, type: OscillatorType | PeriodicWave, frequency: number, detune = 0): OscillatorNode {
  const o = ctx.createOscillator();
  if (typeof type === 'string') o.type = type as OscillatorType;
  else o.setPeriodicWave(type);
  o.frequency.value = frequency;
  o.detune.value = detune;
  return o;
}

export function loopSource(ctx: BaseAudioContext, buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  return s;
}

/** Start a looping source at a random offset so voices sharing one buffer stay decorrelated. */
export function startLoop(s: AudioBufferSourceNode, when: number): void {
  const d = s.buffer ? s.buffer.duration : 0;
  s.start(when, d > 0 ? Math.random() * d * 0.999 : 0);
}

export function safeStop(n: AudioScheduledSourceNode, when?: number): void {
  try {
    n.stop(when);
  } catch {
    /* already stopped */
  }
}

export function safeDisconnect(n: AudioNode): void {
  try {
    n.disconnect();
  } catch {
    /* not connected */
  }
}

/** Disconnect a one-shot graph once its source has finished. */
export function autoCleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    safeDisconnect(src);
    for (const n of nodes) safeDisconnect(n);
  };
}

const FLOOR = 0.0001;

/**
 * Percussive attack/decay envelope with exponential ramps. Does not cancel earlier automation,
 * so consecutive notes on the same param must not overlap in time. Returns the end time.
 */
export function envelope(p: AudioParam, t0: number, peak: number, attack: number, decay: number): number {
  const a = Math.max(0.001, attack);
  const d = Math.max(0.005, decay);
  p.setValueAtTime(FLOOR, t0);
  p.exponentialRampToValueAtTime(Math.max(peak, FLOOR * 2), t0 + a);
  p.exponentialRampToValueAtTime(FLOOR, t0 + a + d);
  return t0 + a + d;
}

export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** mulberry32 PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Musical dB -> linear gain. */
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/** Perceptual volume taper for 0..1 sliders. */
export const taper = (v: number): number => {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  return c * c;
};

export function setListener(ctx: AudioContext, pos: V3, fwd: V3, up: V3): void {
  const l = ctx.listener;
  if (l.positionX) {
    const t = ctx.currentTime;
    const tc = 0.015;
    l.positionX.setTargetAtTime(pos.x, t, tc);
    l.positionY.setTargetAtTime(pos.y, t, tc);
    l.positionZ.setTargetAtTime(pos.z, t, tc);
    l.forwardX.setTargetAtTime(fwd.x, t, tc);
    l.forwardY.setTargetAtTime(fwd.y, t, tc);
    l.forwardZ.setTargetAtTime(fwd.z, t, tc);
    l.upX.setTargetAtTime(up.x, t, tc);
    l.upY.setTargetAtTime(up.y, t, tc);
    l.upZ.setTargetAtTime(up.z, t, tc);
  } else {
    // Older WebKit fallback.
    const legacy = l as unknown as {
      setPosition(x: number, y: number, z: number): void;
      setOrientation(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
    };
    legacy.setPosition(pos.x, pos.y, pos.z);
    legacy.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
  }
}

export function createPanner(ctx: BaseAudioContext, hrtf: boolean): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = hrtf ? 'HRTF' : 'equalpower';
  // Distance attenuation is computed manually; the panner only provides direction.
  p.distanceModel = 'linear';
  p.refDistance = 1;
  p.maxDistance = 100000;
  p.rolloffFactor = 0;
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  return p;
}

export function setPannerPosition(p: PannerNode, ctx: BaseAudioContext, pos: V3, tc = 0.03): void {
  if (p.positionX) {
    const t = ctx.currentTime;
    p.positionX.setTargetAtTime(pos.x, t, tc);
    p.positionY.setTargetAtTime(pos.y, t, tc);
    p.positionZ.setTargetAtTime(pos.z, t, tc);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
  }
}

export function jumpPannerPosition(p: PannerNode, ctx: BaseAudioContext, pos: V3): void {
  if (p.positionX) {
    const t = ctx.currentTime;
    p.positionX.cancelScheduledValues(t);
    p.positionY.cancelScheduledValues(t);
    p.positionZ.cancelScheduledValues(t);
    p.positionX.setValueAtTime(pos.x, t);
    p.positionY.setValueAtTime(pos.y, t);
    p.positionZ.setValueAtTime(pos.z, t);
  } else {
    (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos.x, pos.y, pos.z);
  }
}
