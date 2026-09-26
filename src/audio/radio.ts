// VHF radio: a FIFO transmission queue voiced with speechSynthesis, with squelch clicks, a static bed
// and reliable onStart/onEnd callbacks (simulated timing when speech is off or unavailable).

import { clamp, hashString } from '../core/units';
import type { VoiceAccent } from '../sim/airlines';
import type { RadioMessage } from './contracts';
import type { SampleBank } from './samples';
import { Param, autoCleanup, biquad, gainNode, loopSource, startLoop } from './util';

const ACCENT_LANG: Record<VoiceAccent, string> = {
  us: 'en-us',
  gb: 'en-gb',
  au: 'en-au',
  ie: 'en-ie',
  za: 'en-za',
  in: 'en-in',
};
const ACCENT_TAG: Record<VoiceAccent, string> = {
  us: 'en-US',
  gb: 'en-GB',
  au: 'en-AU',
  ie: 'en-IE',
  za: 'en-ZA',
  in: 'en-IN',
};
const ACCENTS = Object.keys(ACCENT_LANG) as VoiceAccent[];

/** macOS novelty voices that must never be used for radio traffic. */
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|junior|ralph|kathy|fred|princess)\b/i;
/** Low-fidelity formant voices: only used if nothing better exists. */
const ELOQUENCE = /\b(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
const GOOD =
  /\b(samantha|daniel|karen|moira|tessa|rishi|serena|alex|allison|ava|susan|tom|evan|nathan|zoe|oliver|kate|lee|veena|fiona|aaron|arthur|catherine|gordon|martha|nicky|joelle|noelle|matilda|isha|sangeeta)\b/i;

const normLang = (l: string): string => l.replace(/_/g, '-').toLowerCase();

function voiceQuality(v: SpeechSynthesisVoice): number {
  const n = v.name;
  if (NOVELTY.test(n)) return -10;
  let q = 0;
  if (/premium|enhanced|neural|natural/i.test(n)) q += 3;
  if (/google/i.test(n)) q += 2;
  if (GOOD.test(n)) q += 2;
  if (ELOQUENCE.test(n)) q -= 3;
  if (v.localService) q += 0.5;
  return q;
}

export function estimateSeconds(text: string, rate: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return clamp(0.45 + (words * 0.34) / Math.max(0.5, rate), 0.9, 16);
}

function pilotProsody(key: string): { pitch: number; rate: number } {
  const h = hashString(key);
  return {
    pitch: 0.82 + (((h >>> 4) % 100) / 100) * 0.4,
    rate: 1.02 + (((h >>> 12) % 100) / 100) * 0.28,
  };
}

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.error('[audio] radio callback failed', e);
  }
}

interface Current {
  msg: RadioMessage;
  utter: SpeechSynthesisUtterance | null;
  timers: ReturnType<typeof setTimeout>[];
  ended: boolean;
  started: boolean;
}

export class Radio {
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private bank: SampleBank | null = null;
  private staticG: Param | null = null;
  private staticBp: Param | null = null;
  private readonly queue: RadioMessage[] = [];
  private cur: Current | null = null;
  private held = false;
  private suspended = false;
  private pilotsOn = true;
  private atcOn = true;
  private volume = 0.72;
  private nextAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly synth: SpeechSynthesis | null;
  private readonly pools = new Map<VoiceAccent, SpeechSynthesisVoice[]>();
  private allEnglish: SpeechSynthesisVoice[] = [];
  private atcVoice: SpeechSynthesisVoice | null = null;
  private readonly bad = new Set<string>();

  constructor() {
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
    if (this.synth) {
      this.refreshVoices();
      try {
        this.synth.addEventListener('voiceschanged', () => this.refreshVoices());
      } catch {
        /* very old implementations */
      }
    }
  }

  /** Connect squelch/static sounds once the AudioContext exists. */
  attach(ctx: AudioContext, out: AudioNode, bank: SampleBank): void {
    this.ctx = ctx;
    this.out = out;
    this.bank = bank;
    const src = loopSource(ctx, bank.white);
    const hp = biquad(ctx, 'highpass', 320, 0.7);
    const bp = biquad(ctx, 'bandpass', 1700, 0.9);
    const g = gainNode(ctx, 0);
    src.connect(hp).connect(bp).connect(g).connect(out);
    const crk = loopSource(ctx, bank.crackle, 1.3);
    const crkBp = biquad(ctx, 'bandpass', 2200, 0.8);
    const crkG = gainNode(ctx, 0.35);
    crk.connect(crkBp).connect(crkG).connect(g);
    startLoop(src, ctx.currentTime);
    startLoop(crk, ctx.currentTime);
    this.staticG = new Param(ctx, g.gain, 0.03);
    this.staticBp = new Param(ctx, bp.frequency, 0.05);
  }

  get queueLength(): number {
    return this.queue.length + (this.cur ? 1 : 0);
  }

  get voiceCount(): number {
    return this.allEnglish.length;
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
  }

  setVoiceEnabled(pilots: boolean, controller: boolean): void {
    this.pilotsOn = pilots;
    this.atcOn = controller;
  }

  /** Hold the queue (current transmission finishes, no new one starts). */
  setHeld(h: boolean): void {
    if (this.held === h) return;
    this.held = h;
    if (!h) this.pump();
  }

  setSuspended(s: boolean): void {
    if (this.suspended === s) return;
    this.suspended = s;
    if (!s) this.pump();
  }

  transmit(msg: RadioMessage): void {
    this.queue.push(msg);
    this.pump();
  }

  clear(): void {
    this.queue.length = 0;
    const c = this.cur;
    if (c) {
      this.cancelSpeech();
      this.finish(c);
    }
  }

  private refreshVoices(): void {
    const synth = this.synth;
    if (!synth) return;
    let list: SpeechSynthesisVoice[] = [];
    try {
      list = synth.getVoices();
    } catch {
      list = [];
    }
    const english = list
      .filter((v) => normLang(v.lang).startsWith('en') && voiceQuality(v) > -5 && !this.bad.has(v.voiceURI))
      .sort((a, b) => voiceQuality(b) - voiceQuality(a) || a.name.localeCompare(b.name));
    this.allEnglish = english;
    this.pools.clear();
    for (const acc of ACCENTS) {
      const exact = english.filter((v) => normLang(v.lang) === ACCENT_LANG[acc]);
      const good = exact.filter((v) => voiceQuality(v) >= 0);
      this.pools.set(acc, good.length ? good : exact);
    }
    const us = this.pools.get('us') ?? [];
    const gb = this.pools.get('gb') ?? [];
    this.atcVoice = us[0] ?? gb[0] ?? english[0] ?? null;
  }

  private poolFor(accent: VoiceAccent): SpeechSynthesisVoice[] {
    const own = this.pools.get(accent);
    if (own && own.length) return own;
    const order: VoiceAccent[] = accent === 'us' ? ['gb'] : ['gb', 'us'];
    for (const f of order) {
      const p = this.pools.get(f);
      if (p && p.length) return p;
    }
    return this.allEnglish;
  }

  private pickPilotVoice(msg: RadioMessage): SpeechSynthesisVoice | null {
    const pool = this.poolFor(msg.accent);
    if (!pool.length) return null;
    let cands = pool;
    if (pool.length > 1 && this.atcVoice) {
      const f = pool.filter((v) => v !== this.atcVoice);
      if (f.length) cands = f;
    }
    return cands[hashString(msg.voiceKey) % cands.length];
  }

  private schedulePump(ms: number): void {
    if (this.pumpTimer !== null) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, ms));
  }

  private pump(): void {
    if (this.cur || this.held || this.suspended || this.queue.length === 0) return;
    const nowMs = performance.now();
    if (nowMs < this.nextAt) {
      this.schedulePump(this.nextAt - nowMs + 1);
      return;
    }
    const msg = this.queue.shift();
    if (msg) this.begin(msg);
  }

  private begin(msg: RadioMessage): void {
    const cur: Current = { msg, utter: null, timers: [], ended: false, started: false };
    this.cur = cur;
    const wantVoice = msg.from === 'atc' ? this.atcOn : this.pilotsOn;
    const canSpeak =
      wantVoice && !!this.synth && !!this.ctx && this.volume > 0.01 && typeof SpeechSynthesisUtterance !== 'undefined';
    this.squelchOpen(msg.from, canSpeak);
    safeCall(msg.onStart);
    if (!canSpeak) {
      const ms = estimateSeconds(msg.text, 1.15) * 1000 * (wantVoice ? 1 : 0.8);
      cur.timers.push(setTimeout(() => this.finish(cur), ms));
      return;
    }
    cur.timers.push(setTimeout(() => this.speak(cur), 110));
  }

  private speak(cur: Current): void {
    const synth = this.synth;
    if (cur.ended || !synth) return;
    const msg = cur.msg;
    const voice = msg.from === 'atc' ? this.atcVoice : this.pickPilotVoice(msg);
    const pr = msg.from === 'atc' ? { pitch: 1.0, rate: 1.08 } : pilotProsody(msg.voiceKey);
    let u: SpeechSynthesisUtterance;
    try {
      u = new SpeechSynthesisUtterance(msg.text);
    } catch {
      this.finish(cur);
      return;
    }
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = ACCENT_TAG[msg.accent];
    }
    u.pitch = pr.pitch;
    u.rate = pr.rate;
    u.volume = this.volume;
    u.onstart = () => {
      cur.started = true;
    };
    u.onend = () => this.finish(cur);
    u.onerror = (ev: SpeechSynthesisErrorEvent) => {
      const e = ev.error;
      if (voice && e !== 'interrupted' && e !== 'canceled') {
        this.bad.add(voice.voiceURI);
        this.refreshVoices();
      }
      this.finish(cur);
    };
    // Keep a strong reference: Chrome may garbage-collect utterances and never fire onend.
    cur.utter = u;
    const go = () => {
      if (cur.ended) return;
      try {
        if (synth.paused) synth.resume();
        synth.speak(u);
      } catch {
        this.finish(cur);
        return;
      }
      // Start watchdog: nothing audible after 4 s -> give up on this one.
      cur.timers.push(
        setTimeout(() => {
          if (!cur.started && !cur.ended && !synth.speaking) {
            this.cancelSpeech();
            this.finish(cur);
          }
        }, 4000),
      );
      // Stall watchdog (Chrome occasionally never fires onend).
      const est = estimateSeconds(msg.text, pr.rate);
      cur.timers.push(
        setTimeout(() => {
          if (!cur.ended) {
            this.cancelSpeech();
            this.finish(cur);
          }
        }, (est * 2 + 5) * 1000),
      );
    };
    if (synth.speaking || synth.pending) {
      this.cancelSpeech();
      cur.timers.push(setTimeout(go, 80));
    } else {
      go();
    }
  }

  private cancelSpeech(): void {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }

  private finish(cur: Current): void {
    if (cur.ended) return;
    cur.ended = true;
    for (const t of cur.timers) clearTimeout(t);
    cur.timers.length = 0;
    cur.utter = null;
    if (this.cur === cur) this.cur = null;
    this.squelchClose(cur.msg.from);
    safeCall(cur.msg.onEnd);
    const gap = cur.msg.from === 'atc' ? 450 + Math.random() * 450 : 300 + Math.random() * 350;
    this.nextAt = performance.now() + gap;
    this.schedulePump(gap);
  }

  private burst(t: number, dur: number, freq: number, q: number, peak: number): void {
    const ctx = this.ctx;
    const bank = this.bank;
    const out = this.out;
    if (!ctx || !bank || !out) return;
    const src = ctx.createBufferSource();
    src.buffer = bank.white;
    const bp = biquad(ctx, 'bandpass', freq, q);
    const g = gainNode(ctx, 0.0001);
    src.connect(bp).connect(g).connect(out);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    g.gain.setValueAtTime(peak, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.start(t, Math.random() * (bank.white.duration - dur - 0.1));
    src.stop(t + dur + 0.02);
    autoCleanup(src, [bp, g]);
  }

  private squelchOpen(from: 'atc' | 'pilot', speaking: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    this.burst(t, 0.028, 2600, 1.4, from === 'pilot' ? 0.9 : 0.45);
    if (speaking) {
      this.staticBp?.set(from === 'pilot' ? 1400 + Math.random() * 700 : 1900);
      this.staticG?.set(from === 'pilot' ? 0.25 : 0.06, 0.02);
    }
  }

  private squelchClose(from: 'atc' | 'pilot'): void {
    const ctx = this.ctx;
    this.staticG?.set(0, 0.03);
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02;
    this.burst(t, from === 'pilot' ? 0.13 : 0.06, 2200, 0.9, from === 'pilot' ? 1.0 : 0.4);
  }
}
