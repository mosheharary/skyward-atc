// Types shared between the simulation core modules and the UI.

import type { Vec2 } from './airports/types';

export type Phase =
  | 'inbound'
  | 'approach'
  | 'final'
  | 'landing'
  | 'goaround'
  | 'vacating'
  | 'clear'
  | 'taxiIn'
  | 'parking'
  | 'parked'
  | 'ready'
  | 'pushback'
  | 'pushed'
  | 'taxiOut'
  | 'holding'
  | 'lineup'
  | 'takeoff'
  | 'climbout'
  | 'exited';

export type RequestKind = 'pushback' | 'taxi' | 'crossing' | 'takeoff' | 'landing' | 'taxiGate';

export type Emergency = null | 'engine' | 'medical' | 'fuel' | 'hydraulic';

export type Command =
  | { kind: 'heading'; hdg: number; turn?: 'L' | 'R' }
  | { kind: 'altitude'; alt: number; expedite?: boolean }
  | { kind: 'speed'; spd: number | null }
  | { kind: 'direct'; fix: string }
  | { kind: 'hold'; fix: string }
  | { kind: 'approach'; runway: string }
  | { kind: 'land'; runway: string }
  | { kind: 'goAround' }
  | { kind: 'pushback' }
  | { kind: 'taxi'; runway: string }
  | { kind: 'taxiGate' }
  | { kind: 'holdPosition' }
  | { kind: 'continueTaxi' }
  | { kind: 'cross'; runway?: string }
  | { kind: 'lineUp'; runway?: string }
  | { kind: 'takeoff'; runway?: string; hdg?: number; alt?: number }
  | { kind: 'cancelTakeoff' }
  | { kind: 'handoff' };

export interface CommandResult {
  ok: boolean;
  /** Controller transmission (display / speech). */
  atc?: { text: string; speech: string };
  /** Pilot readback or 'unable'. */
  reply?: { text: string; speech: string };
  error?: string;
}

export type ViolationKind =
  | 'separation'
  | 'wake'
  | 'runwayIncursion'
  | 'tcas'
  | 'goAround'
  | 'unstable'
  | 'wrongExit'
  | 'exitAltitude'
  | 'leftAirspace'
  | 'lowAltitude'
  | 'delay'
  | 'emergencyDelay'
  | 'fuel';

export interface ScoreEvent {
  t: number;
  points: number;
  reason: string;
  kind: 'bonus' | ViolationKind;
  ids: string[];
}

export type SimEvent =
  | { type: 'radio'; from: 'atc' | 'pilot'; id: string; text: string; speech: string; urgent?: boolean }
  | { type: 'score'; ev: ScoreEvent }
  | { type: 'touchdown'; id: string; x: number; y: number; intensity: number }
  | { type: 'conflict'; ids: [string, string]; level: 'predicted' | 'loss' | 'clear' }
  | { type: 'spawn'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'request'; id: string; request: RequestKind }
  | { type: 'emergency'; id: string; kind: Emergency }
  | { type: 'notice'; text: string; level: 'info' | 'warn' | 'good' | 'bad' }
  | { type: 'shiftEnd'; reason: 'time' | 'failed' | 'complete' };

export interface PathState {
  points: Vec2[];
  /** Index of the next point to reach. */
  idx: number;
  /** idx = stop before this point unless cleared; exitIdx = point where the protected area ends. */
  holds: { idx: number; runwayId: string; exitIdx: number }[];
  names: string[];
  /** Node ids aligned with points (or -1 for synthetic points). */
  nodes: number[];
}

export interface HoldPattern {
  fix: string;
  inbound: number;
  leg: 'toFix' | 'outTurn' | 'outbound' | 'inTurn';
  legT: number;
}
