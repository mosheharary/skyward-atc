// Short synthesised interface sounds.

import type { UISound } from './contracts';
import type { SampleBank } from './samples';
import { autoCleanup, biquad, gainNode, midiHz, oscillator } from './util';

interface ToneOpts {
  type?: OscillatorType;
  peak?: number;
  attack?: number;
  freqTo?: number;
  lowpass?: number;
  dest?: AudioNode;
}

export class UiSounds {
  private readonly bus: GainNode;
  private lastPlayed = new Map<UISound, number>();

  constructor(
    private readonly ctx: AudioContext,
    private readonly bank: SampleBank,
    out: AudioNode,
    reverbIn: AudioNode,
  ) {
    this.bus = gainNode(ctx, 3.2);
    this.bus.connect(out);
    const send = gainNode(ctx, 0.12);
    this.bus.connect(send).connect(reverbIn);
  }

  play(s: UISound): void {
    const now = this.ctx.currentTime;
    // Debounce identical sounds fired in the same instant (e.g. several UI events per frame).
    const last = this.lastPlayed.get(s) ?? -1;
    if (now - last < 0.04) return;
    this.lastPlayed.set(s, now);
    const t = now + 0.005;
    switch (s) {
      case 'click':
        this.noiseTick(t, 0.22);
        this.tone(t, 1800, 0.012, { peak: 0.05 });
        break;
      case 'select':
        this.tone(t, 880, 0.05, { type: 'triangle', peak: 0.1 });
        this.tone(t + 0.045, 1318.5, 0.07, { type: 'triangle', peak: 0.1 });
        break;
      case 'confirm':
        this.bell(t, 1046.5, 0.35, 0.1);
        this.bell(t + 0.06, 1568, 0.3, 0.08);
        break;
      case 'error':
        this.tone(t, 196, 0.08, { type: 'square', peak: 0.1, lowpass: 900 });
        this.tone(t + 0.13, 185, 0.1, { type: 'square', peak: 0.1, lowpass: 900 });
        break;
      case 'notify':
        this.bell(t, midiHz(76), 0.3, 0.08);
        this.bell(t + 0.08, midiHz(81), 0.3, 0.08);
        this.bell(t + 0.16, midiHz(85), 0.45, 0.07);
        break;
      case 'conflict':
        for (let i = 0; i < 6; i++) {
          const f = i % 2 === 0 ? 950 : 760;
          this.tone(t + i * 0.12, f, 0.1, { type: 'square', peak: 0.1, lowpass: 2200, attack: 0.004 });
        }
        break;
      case 'violation':
        this.tone(t, 520, 0.45, { type: 'sawtooth', peak: 0.13, lowpass: 1400, freqTo: 260, attack: 0.01 });
        this.tone(t, 90, 0.22, { type: 'sine', peak: 0.25 });
        break;
      case 'success':
        [72, 76, 79, 84].forEach((m, i) => this.bell(t + i * 0.09, midiHz(m), i === 3 ? 0.7 : 0.3, 0.1));
        break;
      case 'shiftComplete':
        this.shiftComplete(t);
        break;
      case 'emergency':
        for (let i = 0; i < 10; i++) {
          const hi = i % 2 === 0;
          this.tone(t + i * 0.16, hi ? 1400 : 1000, 0.14, { type: 'square', peak: 0.085, lowpass: 3000, attack: 0.005 });
          if (hi) this.tone(t + i * 0.16, 110, 0.12, { type: 'sine', peak: 0.18 });
        }
        break;
    }
  }

  private tone(t0: number, freq: number, dur: number, o: ToneOpts = {}): void {
    const c = this.ctx;
    const osc = oscillator(c, o.type ?? 'sine', freq);
    const g = gainNode(c, 0.0001);
    const nodes: AudioNode[] = [g];
    let head: AudioNode = osc;
    if (o.lowpass) {
      const lp = biquad(c, 'lowpass', o.lowpass, 0.7);
      head.connect(lp);
      head = lp;
      nodes.push(lp);
    }
    head.connect(g).connect(o.dest ?? this.bus);
    const attack = o.attack ?? 0.005;
    const peak = o.peak ?? 0.1;
    if (o.freqTo) {
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(o.freqTo, t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.setValueAtTime(peak, t0 + Math.max(attack, dur * 0.6));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + 0.03);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
    autoCleanup(osc, nodes);
  }

  /** Bell / mallet: fundamental plus inharmonic partials with faster decays. */
  private bell(t0: number, freq: number, decay: number, peak: number, dest?: AudioNode): void {
    const c = this.ctx;
    const partials: [number, number, number][] = [
      [1, 1, 1],
      [2.0, 0.35, 0.6],
      [3.01, 0.18, 0.4],
      [4.2, 0.08, 0.25],
    ];
    for (const [ratio, amp, dk] of partials) {
      const osc = oscillator(c, 'sine', freq * ratio);
      const g = gainNode(c, 0.0001);
      osc.connect(g).connect(dest ?? this.bus);
      const d = decay * dk;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak * amp, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.004 + d);
      osc.start(t0);
      osc.stop(t0 + d + 0.05);
      autoCleanup(osc, [g]);
    }
  }

  private noiseTick(t0: number, peak: number): void {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.bank.white;
    const bp = biquad(c, 'bandpass', 3500, 1.2);
    const g = gainNode(c, 0.0001);
    src.connect(bp).connect(g).connect(this.bus);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + 0.03);
    autoCleanup(src, [bp, g]);
  }

  private shiftComplete(t0: number): void {
    const chords = [
      [60, 64, 67],
      [65, 69, 72],
      [67, 71, 74],
      [72, 76, 79, 84],
    ];
    chords.forEach((ch, i) => {
      const t = t0 + i * 0.42;
      const hold = i === chords.length - 1 ? 1.4 : 0.38;
      for (const m of ch) {
        this.tone(t, midiHz(m), hold, { type: 'triangle', peak: 0.045, attack: 0.02, lowpass: 3200 });
        this.tone(t, midiHz(m) * 1.003, hold, { type: 'sine', peak: 0.03, attack: 0.02 });
      }
    });
    const tEnd = t0 + 3 * 0.42 + 0.25;
    [84, 88, 91, 96].forEach((m, i) => this.bell(tEnd + i * 0.07, midiHz(m), 0.9, 0.035));
  }
}
