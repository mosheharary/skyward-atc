// Generative ambient menu music: slowly cross-fading extended chords on detuned, filtered saw pads,
// a soft sub bass and sparse bell "shimmer" notes through the shared reverb.

import { gainNode, midiHz, oscillator, safeDisconnect, biquad, Param } from './util';

interface Chord {
  bass: number;
  pad: number[];
}

// D major / B minor colours; voicings kept close for smooth voice leading.
const CHORDS: Chord[] = [
  { bass: 38, pad: [57, 62, 64, 66, 73] }, // Dmaj9
  { bass: 35, pad: [54, 57, 61, 62, 66] }, // Bm(add9)
  { bass: 43, pad: [59, 62, 66, 69, 73] }, // Gmaj9(#11-ish)
  { bass: 40, pad: [55, 59, 62, 66, 71] }, // Em9
  { bass: 45, pad: [57, 61, 64, 66, 71] }, // A6/9
  { bass: 42, pad: [54, 57, 61, 64, 69] }, // F#m7(11)
];

export class Music {
  private readonly out: GainNode;
  private readonly level: Param;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private nextChordAt = 0;
  private chordIdx = 0;
  private nextShimmerAt = 0;
  private current: Chord = CHORDS[0];
  private readonly live = new Set<AudioScheduledSourceNode>();

  constructor(
    private readonly ctx: AudioContext,
    musicBus: AudioNode,
    reverbIn: AudioNode,
  ) {
    this.out = gainNode(ctx, 0);
    const trim = gainNode(ctx, 2.5);
    this.out.connect(trim).connect(musicBus);
    const send = gainNode(ctx, 0.55);
    trim.connect(send).connect(reverbIn);
    this.level = new Param(ctx, this.out.gain, 1.2);
  }

  setTrack(track: 'menu' | 'none'): void {
    if (track === 'menu') {
      if (this.stopTimer !== null) {
        clearTimeout(this.stopTimer);
        this.stopTimer = null;
      }
      this.level.set(1, 1.6);
      if (this.playing) return;
      this.playing = true;
      const t = this.ctx.currentTime;
      this.nextChordAt = t + 0.05;
      this.nextShimmerAt = t + 3;
      if (this.timer === null) this.timer = setInterval(() => this.tick(), 200);
      this.tick();
    } else {
      if (!this.playing) return;
      this.playing = false;
      this.level.set(0, 1.2);
      if (this.stopTimer === null) {
        this.stopTimer = setTimeout(() => {
          this.stopTimer = null;
          if (this.playing) return;
          if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
          }
          const t = this.ctx.currentTime;
          for (const s of this.live) {
            try {
              s.stop(t + 0.1);
            } catch {
              /* already stopped */
            }
          }
        }, 7000);
      }
    }
  }

  private tick(): void {
    if (!this.playing) return;
    const t = this.ctx.currentTime;
    while (this.nextChordAt < t + 1.5) {
      const dur = 9 + Math.random() * 3;
      this.scheduleChord(this.nextChordAt, dur);
      this.nextChordAt += dur - 2;
    }
    if (t >= this.nextShimmerAt) {
      this.shimmer(t + 0.05);
      this.nextShimmerAt = t + 1.5 + Math.random() * 2.8;
    }
  }

  private pickChord(): Chord {
    let i = this.chordIdx;
    while (i === this.chordIdx) i = Math.floor(Math.random() * CHORDS.length);
    this.chordIdx = i;
    return CHORDS[i];
  }

  private track(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      safeDisconnect(src);
      for (const n of nodes) safeDisconnect(n);
    };
  }

  private scheduleChord(T: number, D: number): void {
    const c = this.ctx;
    const chord = this.pickChord();
    this.current = chord;
    const attack = 3.5;
    const release = 5;
    const end = T + D + release + 0.5;

    const chordGain = gainNode(c, 0);
    chordGain.connect(this.out);
    const cg = chordGain.gain;
    cg.setValueAtTime(0, T);
    cg.linearRampToValueAtTime(1, T + attack);
    cg.setValueAtTime(1, T + D);
    cg.linearRampToValueAtTime(0, T + D + release);

    const filt = biquad(c, 'lowpass', 600, 0.9);
    filt.connect(chordGain);
    const ff = filt.frequency;
    ff.setValueAtTime(520, T);
    ff.linearRampToValueAtTime(1150 + Math.random() * 500, T + D * 0.5);
    ff.linearRampToValueAtTime(650, T + D + release);

    const nodes: AudioNode[] = [chordGain, filt];
    for (const m of chord.pad) {
      const f = midiHz(m);
      const ng = gainNode(c, 0.03);
      ng.connect(filt);
      nodes.push(ng);
      for (const cents of [-7, 6]) {
        const o = oscillator(c, 'sawtooth', f, cents + (Math.random() - 0.5) * 3);
        o.connect(ng);
        o.start(T);
        o.stop(end);
        this.track(o, []);
      }
    }
    const bassG = gainNode(c, 0.09);
    bassG.connect(chordGain);
    nodes.push(bassG);
    const bass = oscillator(c, 'sine', midiHz(chord.bass));
    bass.connect(bassG);
    bass.start(T);
    bass.stop(end);
    const bass2 = oscillator(c, 'triangle', midiHz(chord.bass + 12));
    const b2g = gainNode(c, 0.25);
    bass2.connect(b2g).connect(bassG);
    bass2.start(T);
    bass2.stop(end);
    this.track(bass2, [b2g]);
    // Tear down the chord's shared nodes when its sources end (all stop at `end`).
    this.track(bass, nodes);
  }

  private shimmer(t0: number): void {
    const c = this.ctx;
    const pool = this.current.pad;
    const m = pool[Math.floor(Math.random() * pool.length)] + (Math.random() < 0.5 ? 12 : 24);
    const f = midiHz(m);
    const pan = c.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    const bus = gainNode(c, 1);
    bus.connect(pan).connect(this.out);
    const peak = 0.018 + Math.random() * 0.016;
    const partials: [number, number, number][] = [
      [1, 1, 3.2],
      [2.0, 0.3, 1.6],
      [3.0, 0.12, 0.9],
    ];
    let longest: OscillatorNode | null = null;
    let longestEnd = 0;
    for (const [r, a, d] of partials) {
      const o = oscillator(c, 'sine', f * r);
      const g = gainNode(c, 0.0001);
      o.connect(g).connect(bus);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak * a, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.start(t0);
      o.stop(t0 + d + 0.05);
      this.track(o, [g]);
      if (t0 + d > longestEnd) {
        longestEnd = t0 + d;
        longest = o;
      }
    }
    if (longest) {
      const prev = longest.onended;
      longest.onended = (ev) => {
        if (prev) prev.call(longest as OscillatorNode, ev);
        safeDisconnect(bus);
        safeDisconnect(pan);
      };
    }
  }
}
