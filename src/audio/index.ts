// Skyward ATC audio engine: procedural Web Audio synthesis + speechSynthesis radio.
//
// Graph:  engine voices -> pause -> engines bus -> cab muffle -> master
//         ambience (outdoor -> cab muffle) + (indoor) -> pause -> ambience bus -> master
//         radio / music / ui buses -> master;  shared convolution reverb -> master
//         master -> compressor -> limiter -> analyser -> destination

import { clamp, damp, type XYZ } from '../core/units';
import type { AudioFrame, AudioVolumes, CreateAudioEngine, IAudioEngine, RadioMessage, UISound } from './contracts';
import { Ambience } from './ambience';
import { EnginePool, playTouchdown } from './engines';
import { Music } from './music';
import { Radio } from './radio';
import { SampleBank } from './samples';
import { UiSounds } from './ui';
import { Param, biquad, gainNode, setListener, taper, type V3 } from './util';

const DEFAULT_VOLUMES: AudioVolumes = {
  master: 0.85,
  engines: 0.85,
  radio: 0.9,
  ambience: 0.7,
  music: 0.55,
  ui: 0.7,
};

const INDOOR_CUTOFF = 850;
const INDOOR_GAIN = 0.32;

interface Graph {
  master: Param;
  engines: Param;
  ambience: Param;
  radio: Param;
  music: Param;
  ui: Param;
  enginePause: Param;
  ambPause: Param;
  muffles: { lp: Param; g: Param }[];
  enginesIn: GainNode;
  analyser: AnalyserNode;
}

export interface AudioDebugState {
  context: AudioContextState | 'none';
  engineVoices: number;
  radioQueue: number;
  ttsVoices: number;
  music: 'menu' | 'none';
  level: number;
}

function norm(v: XYZ, fallback: V3): V3 {
  const l = Math.hypot(v.x, v.y, v.z);
  if (!(l > 1e-6)) return { ...fallback };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export class AudioEngine implements IAudioEngine {
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private bank: SampleBank | null = null;
  private engines: EnginePool | null = null;
  private ambience: Ambience | null = null;
  private ui: UiSounds | null = null;
  private music: Music | null = null;
  private readonly radio = new Radio();
  private readonly vol: AudioVolumes = { ...DEFAULT_VOLUMES };
  private musicTrack: 'menu' | 'none' = 'none';
  private startPromise: Promise<void> | null = null;
  private userSuspended = false;
  private readonly lis: V3 = { x: 0, y: 0, z: 0 };
  private lisPrev: V3 | null = null;
  private readonly lisVel: V3 = { x: 0, y: 0, z: 0 };
  private right: V3 = { x: 1, y: 0, z: 0 };
  private levelBuf: Float32Array<ArrayBuffer> | null = null;
  private indoor: boolean | null = null;
  private paused: boolean | null = null;
  private lastUpdateAt = 0;
  private stale = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  get started(): boolean {
    return this.graph !== null && this.ctx !== null && this.ctx.state !== 'closed';
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise.then(() => this.resumeIfNeeded());
  }

  private async doStart(): Promise<void> {
    if (typeof window === 'undefined') return;
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      console.warn('[audio] AudioContext unavailable', e);
      return;
    }
    this.ctx = ctx;
    try {
      this.build(ctx);
    } catch (e) {
      console.error('[audio] failed to build audio graph', e);
      this.graph = null;
    }
  }

  private async resumeIfNeeded(): Promise<void> {
    const c = this.ctx;
    if (!c || c.state !== 'suspended' || this.userSuspended) return;
    // resume() can stay pending without user activation; never block the caller on it.
    await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 800))]);
  }

  private build(ctx: AudioContext): void {
    const bank = new SampleBank(ctx);
    this.bank = bank;
    const v = this.vol;

    const master = gainNode(ctx, taper(v.master));
    // Safety limiter only. DynamicsCompressorNode applies automatic makeup gain
    // (0.6 * |threshold| * (1 - 1/ratio) dB); a fixed pre-gain cancels it so quiet material passes at unity.
    const LIM_T = -8;
    const LIM_R = 12;
    const makeupDb = 0.6 * -LIM_T * (1 - 1 / LIM_R);
    const preGain = gainNode(ctx, Math.pow(10, -makeupDb / 20));
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIM_T;
    limiter.knee.value = 4;
    limiter.ratio.value = LIM_R;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(preGain).connect(limiter).connect(analyser).connect(ctx.destination);

    const reverbIn = gainNode(ctx, 1);
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = bank.impulse;
    const reverbOut = gainNode(ctx, 0.9);
    reverbIn.connect(conv).connect(reverbOut).connect(master);

    const muffles: { lp: Param; g: Param }[] = [];
    const muffle = (): [BiquadFilterNode, GainNode] => {
      const lp = biquad(ctx, 'lowpass', 20000, 0.6);
      const g = gainNode(ctx, 1);
      lp.connect(g);
      muffles.push({ lp: new Param(ctx, lp.frequency, 0.12), g: new Param(ctx, g.gain, 0.12) });
      return [lp, g];
    };

    // Engines (aircraft sfx).
    const enginesIn = gainNode(ctx, 1);
    const enginePause = gainNode(ctx, 1);
    const enginesBus = gainNode(ctx, taper(v.engines));
    const [engLp, engG] = muffle();
    enginesIn.connect(enginePause).connect(enginesBus).connect(engLp);
    engG.connect(master);
    const engSend = gainNode(ctx, 0.12);
    engG.connect(engSend).connect(reverbIn);

    // Ambience.
    const ambOutdoor = gainNode(ctx, 1);
    const ambIndoor = gainNode(ctx, 1);
    const ambPause = gainNode(ctx, 1);
    const ambBus = gainNode(ctx, taper(v.ambience));
    const [ambLp, ambG] = muffle();
    ambOutdoor.connect(ambLp);
    ambG.connect(ambPause);
    ambIndoor.connect(ambPause);
    ambPause.connect(ambBus).connect(master);
    const ambReverbIn = gainNode(ctx, 1);
    const [ambRevLp, ambRevG] = muffle();
    ambReverbIn.connect(ambRevLp);
    ambRevG.connect(reverbIn);

    const radioBus = gainNode(ctx, taper(v.radio));
    radioBus.connect(master);
    const musicBus = gainNode(ctx, taper(v.music));
    musicBus.connect(master);
    const uiBus = gainNode(ctx, taper(v.ui));
    uiBus.connect(master);

    this.engines = new EnginePool(ctx, bank, enginesIn, true);
    this.ambience = new Ambience(ctx, bank, ambOutdoor, ambIndoor, ambReverbIn);
    this.ui = new UiSounds(ctx, bank, uiBus, reverbIn);
    this.music = new Music(ctx, musicBus, reverbIn);
    this.radio.attach(ctx, radioBus, bank);
    this.radio.setVolume(taper(v.radio) * taper(v.master));

    this.graph = {
      master: new Param(ctx, master.gain, 0.05),
      engines: new Param(ctx, enginesBus.gain, 0.05),
      ambience: new Param(ctx, ambBus.gain, 0.05),
      radio: new Param(ctx, radioBus.gain, 0.05),
      music: new Param(ctx, musicBus.gain, 0.05),
      ui: new Param(ctx, uiBus.gain, 0.05),
      enginePause: new Param(ctx, enginePause.gain, 0.25),
      ambPause: new Param(ctx, ambPause.gain, 0.4),
      muffles,
      enginesIn,
      analyser,
    };
    this.levelBuf = new Float32Array(analyser.fftSize);
    if (this.musicTrack === 'menu') this.music.setTrack('menu');
    // If the host stops calling update() (hidden tab, stalled render loop) fade engines/ambience
    // out instead of leaving a frozen drone; the next update() restores them.
    this.lastUpdateAt = performance.now();
    this.watchdog = setInterval(() => {
      const g = this.graph;
      if (!g || this.stale || performance.now() - this.lastUpdateAt < 600) return;
      this.stale = true;
      g.enginePause.set(0, 0.2);
      g.ambPause.set(0.25, 0.4);
    }, 250);
  }

  private running(): boolean {
    return this.ctx !== null && this.graph !== null && this.ctx.state === 'running';
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    for (const k of Object.keys(v) as (keyof AudioVolumes)[]) {
      const val = v[k];
      if (typeof val === 'number' && Number.isFinite(val)) this.vol[k] = clamp(val, 0, 1);
    }
    const g = this.graph;
    if (g) {
      g.master.set(taper(this.vol.master));
      g.engines.set(taper(this.vol.engines));
      g.ambience.set(taper(this.vol.ambience));
      g.radio.set(taper(this.vol.radio));
      g.music.set(taper(this.vol.music));
      g.ui.set(taper(this.vol.ui));
    }
    this.radio.setVolume(taper(this.vol.radio) * taper(this.vol.master));
  }

  setVoiceEnabled(pilots: boolean, controller: boolean): void {
    this.radio.setVoiceEnabled(pilots, controller);
  }

  update(frame: AudioFrame): void {
    this.radio.setHeld(frame.paused);
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || ctx.state === 'closed' || !this.engines || !this.ambience) return;
    const dt = clamp(Number.isFinite(frame.dt) ? frame.dt : 0, 0, 0.25);
    this.lastUpdateAt = performance.now();
    if (this.stale) {
      this.stale = false;
      this.paused = null; // force the pause gains to be re-applied below
    }

    const L = frame.listener;
    const fwd = norm(L.forward, { x: 0, y: 0, z: -1 });
    const up = norm(L.up, { x: 0, y: 1, z: 0 });
    setListener(ctx, L.position, fwd, up);
    this.right = norm(
      { x: fwd.y * up.z - fwd.z * up.y, y: fwd.z * up.x - fwd.x * up.z, z: fwd.x * up.y - fwd.y * up.x },
      { x: 1, y: 0, z: 0 },
    );
    this.lis.x = L.position.x;
    this.lis.y = L.position.y;
    this.lis.z = L.position.z;
    if (this.lisPrev && dt > 0) {
      let vx = (this.lis.x - this.lisPrev.x) / dt;
      let vy = (this.lis.y - this.lisPrev.y) / dt;
      let vz = (this.lis.z - this.lisPrev.z) / dt;
      if (Math.hypot(vx, vy, vz) > 400) vx = vy = vz = 0; // camera teleport
      const k = damp(5, dt);
      this.lisVel.x += (vx - this.lisVel.x) * k;
      this.lisVel.y += (vy - this.lisVel.y) * k;
      this.lisVel.z += (vz - this.lisVel.z) * k;
    }
    this.lisPrev = { x: this.lis.x, y: this.lis.y, z: this.lis.z };

    if (frame.indoor !== this.indoor) {
      this.indoor = frame.indoor;
      for (const m of g.muffles) {
        m.lp.set(frame.indoor ? INDOOR_CUTOFF : 20000);
        m.g.set(frame.indoor ? INDOOR_GAIN : 1);
      }
    }
    if (frame.paused !== this.paused) {
      this.paused = frame.paused;
      g.enginePause.set(frame.paused ? 0 : 1);
      g.ambPause.set(frame.paused ? 0.55 : 1);
    }

    const simDt = frame.paused ? 0 : dt * Math.max(0, frame.timeScale);
    this.engines.update(frame.aircraft, this.lis, this.lisVel, dt, simDt);
    this.ambience.update(frame, this.lis, this.right, dt);
  }

  playUI(s: UISound): void {
    if (!this.running() || !this.ui) return;
    this.ui.play(s);
  }

  touchdown(position: XYZ, intensity: number): void {
    if (!this.running() || !this.ctx || !this.bank || !this.graph) return;
    playTouchdown(this.ctx, this.bank, this.graph.enginesIn, position, this.lis, intensity, true);
  }

  transmit(msg: RadioMessage): void {
    this.radio.transmit(msg);
  }

  clearRadio(): void {
    this.radio.clear();
  }

  setMusic(track: 'menu' | 'none'): void {
    this.musicTrack = track;
    this.music?.setTrack(track);
  }

  getLevel(): number {
    const g = this.graph;
    const buf = this.levelBuf;
    if (!g || !buf || !this.running()) return 0;
    g.analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return clamp(Math.sqrt(s / buf.length), 0, 1);
  }

  suspend(): void {
    this.userSuspended = true;
    this.radio.setSuspended(true);
    this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    this.userSuspended = false;
    this.radio.setSuspended(false);
    this.ctx?.resume().catch(() => undefined);
  }

  /** Diagnostics (not part of IAudioEngine). */
  debugState(): AudioDebugState {
    return {
      context: this.ctx ? this.ctx.state : 'none',
      engineVoices: this.engines?.activeVoices ?? 0,
      radioQueue: this.radio.queueLength,
      ttsVoices: this.radio.voiceCount,
      music: this.musicTrack,
      level: this.getLevel(),
    };
  }

  dispose(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.radio.clear();
    this.music?.setTrack('none');
    this.engines?.dispose();
    const c = this.ctx;
    this.graph = null;
    this.ctx = null;
    c?.close().catch(() => undefined);
  }
}

export const createAudioEngine: CreateAudioEngine = () => new AudioEngine();
