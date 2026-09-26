// Contract between the game shell and the audio engine (src/audio/index.ts).
// All sound is synthesised with the Web Audio API (no audio files); radio voices use speechSynthesis.

import type { XYZ } from '../core/units';
import type { VoiceAccent } from '../sim/airlines';
import type { EngineKind, SizeClass, WeatherState } from '../sim/types';

export type UISound =
  | 'click'
  | 'select'
  | 'confirm'
  | 'error'
  | 'notify'
  | 'conflict'
  | 'violation'
  | 'success'
  | 'shiftComplete'
  | 'emergency';

export interface AudioVolumes {
  master: number;
  engines: number;
  radio: number;
  ambience: number;
  music: number;
  ui: number;
}

export interface AircraftAudioState {
  id: string;
  /** World coordinates (m): X east, Y up, Z south. */
  position: XYZ;
  /** World velocity (m/s). */
  velocity: XYZ;
  engine: EngineKind;
  engines: 2 | 4;
  size: SizeClass;
  /** 0..1 (idle ~0.22). */
  thrust: number;
  /** 0..1 reverse thrust. */
  reverse: number;
  running: boolean;
  onGround: boolean;
}

export interface AudioFrame {
  /** Real seconds since previous frame. */
  dt: number;
  listener: { position: XYZ; forward: XYZ; up: XYZ };
  aircraft: readonly AircraftAudioState[];
  weather: WeatherState;
  /** Monotonic sim seconds. New entries in weather.lightning trigger thunder (delay = distance / 343 m/s). */
  simTime: number;
  /** 0 day .. 1 night (birds by day, crickets by night). */
  nightFactor: number;
  /** Camera inside the glazed tower cab: outside sounds muffled, cab ambience audible. */
  indoor: boolean;
  /** Game paused: engines fade out, ambience continues quietly. */
  paused: boolean;
  /** Simulation speed multiplier (1, 2, 4...). */
  timeScale: number;
}

export interface RadioMessage {
  from: 'atc' | 'pilot';
  /** Already phonetic text, e.g. "Azure one two three, turn left heading two seven zero". */
  text: string;
  /** Stable key selecting a voice and its pitch/rate (e.g. the callsign). */
  voiceKey: string;
  accent: VoiceAccent;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface IAudioEngine {
  /** Create/resume the AudioContext. Must be called from a user gesture. Idempotent. */
  start(): Promise<void>;
  readonly started: boolean;
  setVolumes(v: Partial<AudioVolumes>): void;
  /** Speak pilot transmissions / the player's own (controller) transmissions. */
  setVoiceEnabled(pilots: boolean, controller: boolean): void;
  update(frame: AudioFrame): void;
  playUI(s: UISound): void;
  /** Main gear touchdown at a world position; intensity 0..1 (tyre chirp). */
  touchdown(position: XYZ, intensity: number): void;
  /** Queue a radio transmission (never overlaps another). */
  transmit(msg: RadioMessage): void;
  /** Drop queued (not yet started) transmissions and stop the current one. */
  clearRadio(): void;
  setMusic(track: 'menu' | 'none'): void;
  /** Output RMS 0..1 of the master bus (debug / automated verification). */
  getLevel(): number;
  suspend(): void;
  resume(): void;
}

/** Implemented in src/audio/index.ts */
export type CreateAudioEngine = () => IAudioEngine;
