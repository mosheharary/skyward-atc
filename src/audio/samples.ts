// Procedurally generated sample buffers (noise beds, textures, reverb impulse) and periodic waves.
// Everything is generated once per AudioContext; texture buffers are built lazily on first use.

import { TAU, rng } from './util';

type Color = 'white' | 'pink' | 'brown';

function removeDc(d: Float32Array): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) m += d[i];
  m /= d.length || 1;
  for (let i = 0; i < d.length; i++) d[i] -= m;
}

function normalizeRms(d: Float32Array, target: number): void {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  const rms = Math.sqrt(s / (d.length || 1));
  if (rms <= 0) return;
  const k = target / rms;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

function clampPeak(d: Float32Array, peak: number): void {
  let m = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > m) m = a;
  }
  if (m <= peak) return;
  const k = peak / m;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

/** Coloured noise that loops seamlessly (the tail continuation is cross-faded into the head). */
function colouredNoise(n: number, color: Color, r: () => number): Float32Array {
  const fade = Math.min(4096, n >> 3);
  const total = n + fade;
  const d = new Float32Array(total);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < total; i++) {
    const w = r() * 2 - 1;
    let v: number;
    if (color === 'white') v = w;
    else if (color === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      v = last * 3.5;
    }
    d[i] = v;
  }
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] = d[i] * Math.sqrt(t) + d[n + i] * Math.sqrt(1 - t);
  }
  const out = d.slice(0, n);
  removeDc(out);
  normalizeRms(out, 0.3);
  return out;
}

function monoBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.getChannelData(0).set(data);
  return b;
}

/** Sparse random impulses: the "crackle" of jet mixing noise at full power. */
function crackle(n: number, sr: number, r: () => number): Float32Array {
  const d = new Float32Array(n);
  const rate = 380;
  let i = 0;
  for (;;) {
    i += Math.max(1, Math.floor((-Math.log(1 - r()) * sr) / rate));
    if (i >= n) break;
    const amp = (r() < 0.5 ? -1 : 1) * (0.15 + 0.85 * r() * r() * r());
    const len = 6 + Math.floor(r() * 36);
    let lp = 0;
    for (let k = 0; k < len * 4; k++) {
      const exc = k === 0 ? 1 : k === 1 ? -0.6 : (r() * 2 - 1) * 0.5;
      lp += (exc - lp) * 0.6;
      d[(i + k) % n] += amp * lp * Math.exp(-k / len);
    }
  }
  removeDc(d);
  normalizeRms(d, 0.22);
  return d;
}

/** Outdoor rain: high-passed hiss plus many short drop transients (stereo, wraps seamlessly). */
function rainTexture(ctx: BaseAudioContext, seconds: number, dropsPerSec: number, hiss: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed + ch * 7919);
    const d = buf.getChannelData(ch);
    const aHp = Math.exp((-TAU * 450) / sr);
    const aLp = 1 - Math.exp((-TAU * 9000) / sr);
    let prev = 0, hp = 0, lp = 0;
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1;
      hp = aHp * (hp + w - prev);
      prev = w;
      lp += (hp - lp) * aLp;
      d[i] = lp * hiss;
    }
    let i = 0;
    for (;;) {
      i += Math.max(1, Math.floor((-Math.log(1 - r()) * sr) / dropsPerSec));
      if (i >= n) break;
      const size = r();
      const amp = 0.03 + 0.45 * size * size * size;
      const len = Math.max(8, Math.floor(sr * (0.0006 + 0.0045 * size)));
      const f = 1400 + 5200 * (1 - size) + 1200 * r();
      const decay = len * 0.33;
      let ph = r() * TAU;
      const dph = (TAU * f) / sr;
      for (let k = 0; k < len; k++) {
        const e = Math.exp(-k / decay);
        d[(i + k) % n] += (Math.sin(ph) * 0.6 + (r() * 2 - 1) * 0.4) * e * amp;
        ph += dph;
      }
    }
    removeDc(d);
    normalizeRms(d, 0.2);
    clampPeak(d, 0.98);
  }
  return buf;
}

/** Rain on the tower glass: sharp resonant ticks, occasional heavier drops, faint wash. */
function glassRainTexture(ctx: BaseAudioContext, seconds: number, ticksPerSec: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed + ch * 104729);
    const d = buf.getChannelData(ch);
    const aLp = 1 - Math.exp((-TAU * 1100) / sr);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += (r() * 2 - 1 - lp) * aLp;
      d[i] = lp * 0.12;
    }
    let i = 0;
    for (;;) {
      i += Math.max(1, Math.floor((-Math.log(1 - r()) * sr) / ticksPerSec));
      if (i >= n) break;
      const heavy = r() < 0.07;
      const f = heavy ? 650 + 950 * r() : 2600 + 4200 * r();
      const decay = sr * (heavy ? 0.006 + 0.012 * r() : 0.0008 + 0.0028 * r());
      const amp = heavy ? 0.35 + 0.4 * r() : 0.06 + 0.3 * r() * r();
      const len = Math.floor(decay * 5);
      let ph = r() * TAU;
      const dph = (TAU * f) / sr;
      for (let k = 0; k < len; k++) {
        const click = k < 3 ? (r() * 2 - 1) * 0.8 : 0;
        d[(i + k) % n] += (Math.sin(ph) + click) * Math.exp(-k / decay) * amp;
        ph += dph * (heavy ? 1 - k / (len * 4) : 1);
      }
    }
    removeDc(d);
    normalizeRms(d, 0.16);
    clampPeak(d, 0.98);
  }
  return buf;
}

/** A small chorus of field crickets; 4 s loop whose chirp periods divide the loop exactly. */
function cricketTexture(ctx: BaseAudioContext, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = 4;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  const periods = [0.5, 0.4, 0.8, 0.5, 4 / 7];
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed + ch * 31337);
    const d = buf.getChannelData(ch);
    const count = 3;
    for (let c = 0; c < count; c++) {
      const f = 4100 + r() * 800;
      const amp = 0.25 + 0.75 * r();
      const period = periods[Math.floor(r() * periods.length)];
      const pulses = 3 + (r() < 0.4 ? 1 : 0);
      const pulseLen = Math.floor(sr * (0.011 + r() * 0.006));
      const spacing = Math.floor(sr * (0.028 + r() * 0.01));
      const offset = r() * period;
      const chirps = Math.round(seconds / period);
      for (let k = 0; k < chirps; k++) {
        const jitter = (r() - 0.5) * 0.02;
        const start = Math.floor((offset + k * period + jitter) * sr);
        const chirpAmp = amp * (0.8 + 0.2 * r());
        for (let p = 0; p < pulses; p++) {
          const ps = start + p * spacing;
          for (let s = 0; s < pulseLen; s++) {
            const w = Math.sin((Math.PI * s) / pulseLen);
            const t = (ps + s) / sr;
            const v = Math.sin(TAU * f * t + 0.3 * Math.sin(TAU * 60 * t)) * w * w * chirpAmp;
            d[(((ps + s) % n) + n) % n] += v;
          }
        }
      }
    }
    normalizeRms(d, 0.1);
    clampPeak(d, 0.95);
  }
  return buf;
}

/** Stereo reverb impulse: pre-delay, early reflections, darkening exponential tail. */
function impulseResponse(ctx: BaseAudioContext, seconds: number, rt60: number, seed: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor(0.012 * sr);
  const taps = [0.019, 0.027, 0.036, 0.047, 0.061, 0.078];
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(seed + ch * 17);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp((-6.9078 * t) / rt60);
      const fc = 900 + 8500 * Math.exp(-t * 1.6);
      const a = 1 - Math.exp((-TAU * fc) / sr);
      lp += (r() * 2 - 1 - lp) * a;
      const fadeIn = Math.min(1, (i - pre) / 96);
      d[i] = lp * env * fadeIn;
    }
    taps.forEach((tap, j) => {
      const idx = pre + Math.floor((tap + ch * 0.0013 * (j + 1)) * sr);
      if (idx < n) d[idx] += (0.7 - j * 0.09) * (r() < 0.5 ? -1 : 1);
    });
  }
  return buf;
}

export class SampleBank {
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  readonly crackle: AudioBuffer;
  readonly impulse: AudioBuffer;
  readonly fanWave: PeriodicWave;
  readonly propWave: PeriodicWave;
  private _rainLight: AudioBuffer | null = null;
  private _rainHeavy: AudioBuffer | null = null;
  private _rainGlass: AudioBuffer | null = null;
  private _crickets: AudioBuffer | null = null;

  constructor(private readonly ctx: BaseAudioContext) {
    const sr = ctx.sampleRate;
    const r = rng(0x5eed);
    this.white = monoBuffer(ctx, colouredNoise(Math.floor(sr * 3), 'white', r));
    this.pink = monoBuffer(ctx, colouredNoise(Math.floor(sr * 6), 'pink', r));
    this.brown = monoBuffer(ctx, colouredNoise(Math.floor(sr * 6), 'brown', r));
    this.crackle = monoBuffer(ctx, crackle(Math.floor(sr * 3), sr, r));
    this.impulse = impulseResponse(ctx, 3.2, 2.6, 0xacce55);

    const fanReal = new Float32Array(6);
    const fanImag = new Float32Array([0, 1, 0.32, 0.14, 0.06, 0.03]);
    this.fanWave = ctx.createPeriodicWave(fanReal, fanImag);

    const harmonics = 22;
    const propReal = new Float32Array(harmonics + 1);
    const propImag = new Float32Array(harmonics + 1);
    for (let h = 1; h <= harmonics; h++) propImag[h] = (h === 2 ? 1.25 : 1) / Math.pow(h, 1.05);
    this.propWave = ctx.createPeriodicWave(propReal, propImag);
  }

  get rainLight(): AudioBuffer {
    return (this._rainLight ??= rainTexture(this.ctx, 5, 160, 0.35, 101));
  }

  get rainHeavy(): AudioBuffer {
    return (this._rainHeavy ??= rainTexture(this.ctx, 5, 2600, 1, 202));
  }

  get rainGlass(): AudioBuffer {
    return (this._rainGlass ??= glassRainTexture(this.ctx, 6, 320, 303));
  }

  get crickets(): AudioBuffer {
    return (this._crickets ??= cricketTexture(this.ctx, 404));
  }
}
