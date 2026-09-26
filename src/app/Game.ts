// One play session: steps the World, drives the 3D renderer, radar, audio and HUD, and autosaves checkpoints.

import { World, type WorldSnapshot } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import type { Command, SimEvent } from '../sim/simTypes';
import type { GameRenderer, CameraMode } from '../render/Renderer';
import type { AircraftAudioState, IAudioEngine } from '../audio/contracts';
import { AIRLINE_BY_CODE } from '../sim/airlines';
import { SHIFT_BY_ID } from '../sim/career';
import { simToWorld } from '../core/units';
import { RadarScope } from '../ui/radar';
import { CommandPanel, REQUEST_LABEL } from '../ui/commandPanel';
import { h, fmtClock, fmtDuration } from '../ui/dom';
import type { CheckpointSummary, Settings } from '../ui/api';
import { fmtAltitude, fmtWind } from '../sim/phraseology';

export interface GameHost {
  renderer: GameRenderer;
  audio: IAudioEngine;
  settings: Settings;
  /** Persist the checkpoint; resolves true on success. */
  saveCheckpoint(state: WorldSnapshot, summary: CheckpointSummary, beacon?: boolean): Promise<boolean>;
  openHelp(section?: string): void;
  openPauseMenu(): void;
  shiftEnded(world: World): void;
  isModalOpen(): boolean;
}

const SPEEDS = [1, 2, 4];

export class Game {
  readonly world: World;
  readonly el: HTMLElement;
  paused = false;
  timeScale = 1;
  selected: string | null = null;
  private raf = 0;
  private last = 0;
  private radar: RadarScope;
  private panel: CommandPanel;
  private strips: HTMLElement;
  private radioLog: HTMLElement;
  private notices: HTMLElement;
  private scoreFeed: HTMLElement;
  private labels: HTMLElement;
  private labelPool: HTMLElement[] = [];
  private top: Record<string, HTMLElement> = {};
  private mainView: HTMLElement;
  private miniView: HTMLElement;
  private view3d: HTMLElement;
  private viewRadar: HTMLElement;
  private radarBig = false;
  private attention = new Set<string>();
  private stripKey = '';
  private stripT = 0;
  private saveT = 0;
  private dirty = false;
  private saving = false;
  private lastSavedAt = 0;
  private fixResolve: ((f: string | null) => void) | null = null;
  private ended = false;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private readonly keyHandler = (e: KeyboardEvent): void => this.onKey(e);
  private readonly visHandler = (): void => {
    if (document.visibilityState === 'hidden') void this.save(true);
  };
  private readonly unloadHandler = (): void => void this.save(true, true);
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 0;

  constructor(private readonly host: GameHost, root: HTMLElement, world: World) {
    this.world = world;
    const r = host.renderer;
    this.el = h('div', { class: 'game' });
    // ---- top bar
    const tb = h('div', { class: 'topbar' });
    const item = (key: string, label: string): HTMLElement => {
      const v = h('span', { class: 'tb-v' });
      this.top[key] = v;
      tb.append(h('div', { class: `tb-item tb-${key}` }, h('span', { class: 'tb-l' }, label), v));
      return v;
    };
    const def = world.airport.def;
    tb.append(h('div', { class: 'tb-airport' }, h('b', null, def.icao), h('span', null, def.name)));
    item('clock', 'LOCAL');
    item('remain', 'SHIFT');
    item('atis', 'ATIS');
    item('wind', 'WIND');
    item('rwy', 'RWY');
    item('score', 'SCORE');
    item('traffic', 'TRAFFIC');
    const camBtns = (['tower', 'orbit', 'follow', 'cockpit'] as CameraMode[]).map((m, i) =>
      h('button', { class: 'tb-btn cam', 'data-cam': m, title: `${m[0].toUpperCase() + m.slice(1)} view (${i + 1})`, onclick: () => this.setCamera(m) }, ['Tower', 'Orbit', 'Follow', 'Cockpit'][i]),
    );
    const speedBtn = h('button', { class: 'tb-btn', title: 'Simulation speed (+/-)', onclick: () => this.cycleSpeed() }, '×1');
    this.top.speed = speedBtn;
    const pauseBtn = h('button', { class: 'tb-btn', title: 'Pause (Space)', onclick: () => this.togglePause() }, '❚❚');
    this.top.pause = pauseBtn;
    tb.append(
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group' }, ...camBtns),
      h('button', { class: 'tb-btn', title: 'Swap radar and 3D view (Tab)', onclick: () => this.swapViews() }, '⇄ Radar'),
      h('div', { class: 'tb-group' }, pauseBtn, speedBtn),
      h('button', { class: 'tb-btn', title: 'Help (F1)', onclick: () => host.openHelp() }, '? Help'),
      h('button', { class: 'tb-btn', title: 'Menu (Esc)', onclick: () => host.openPauseMenu() }, '☰ Menu'),
    );
    this.top.saved = h('span', { class: 'tb-saved', title: 'Checkpoint status' }, '');
    tb.append(this.top.saved);

    // ---- views
    this.view3d = h('div', { class: 'view view-3d' }, r.renderer.domElement);
    this.labels = h('div', { class: 'labels3d' });
    this.view3d.append(this.labels);
    this.viewRadar = h('div', { class: 'view view-radar' });
    this.mainView = h('div', { class: 'main-view' }, this.view3d);
    this.miniView = h('div', { class: 'mini-view' }, this.viewRadar);
    this.radar = new RadarScope(this.viewRadar, {
      select: (id) => this.select(id),
      vector: (id, hdg) => this.command(id, { kind: 'heading', hdg }),
      fix: (f) => {
        this.radar.pickingFix = false;
        this.fixResolve?.(f);
        this.fixResolve = null;
      },
    });
    this.radar.reset(world);

    // ---- panels
    this.strips = h('div', { class: 'strips' });
    const right = h('div', { class: 'right-col' }, this.miniView);
    this.panel = new CommandPanel(right, {
      send: (id, c) => this.command(id, c),
      pickFix: () => {
        this.radar.pickingFix = true;
        if (!this.radarBig && this.miniView.clientWidth < 200) this.swapViews();
        return new Promise((res) => (this.fixResolve = res));
      },
      follow: (id) => {
        this.select(id);
        this.setCamera('follow');
      },
    });
    this.radioLog = h('div', { class: 'radio-log', 'aria-live': 'polite' });
    this.notices = h('div', { class: 'notices' });
    this.scoreFeed = h('div', { class: 'score-feed' });
    const center = h('div', { class: 'center-col' }, this.mainView, this.radioLog, this.notices, this.scoreFeed);
    this.el.append(tb, h('div', { class: 'game-body' }, h('div', { class: 'left-col' }, h('div', { class: 'col-title' }, 'Flight strips'), this.strips), center, right));
    root.appendChild(this.el);

    // Radio calls still queued as events are logged when drained; only replay older history.
    const pending = world.events.filter((e) => e.type === 'radio').length;
    for (const e of world.radioLog.slice(0, world.radioLog.length - pending).slice(-25)) this.logRadio(e.from, e.id, e.text, !!e.urgent);

    r.load(world);
    r.onPick = (id) => this.select(id);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.mainView);
    this.ro.observe(this.miniView);
    this.resize();
    window.addEventListener('keydown', this.keyHandler);
    document.addEventListener('visibilitychange', this.visHandler);
    window.addEventListener('pagehide', this.unloadHandler);
    host.audio.setMusic('none');
    this.applySettings(host.settings);
    this.updateCamButtons();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    if (world.ended) this.finish();
  }

  applySettings(s: Settings): void {
    const a = this.host.audio;
    a.setVolumes({ master: s.master, engines: s.engines, radio: s.radio, ambience: s.ambience, music: s.music, ui: s.ui });
    a.setVoiceEnabled(s.pilotVoices, s.controllerVoice);
    if (this.host.renderer.quality !== s.quality) this.host.renderer.setQuality(s.quality);
    this.labels.style.display = s.labels3d ? '' : 'none';
  }

  private resize(): void {
    const v = this.view3d;
    this.host.renderer.resize(v.clientWidth, v.clientHeight);
  }

  // ------------------------------------------------------------ actions
  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    if (id) {
      this.host.audio.playUI('select');
      const a = this.world.byId(id);
      if (a && this.host.renderer.mode === 'orbit') this.orbitOn(a);
      if (this.host.renderer.mode === 'follow' || this.host.renderer.mode === 'cockpit') this.host.renderer.setMode(this.host.renderer.mode, id);
    }
    this.stripKey = '';
  }

  command(id: string, c: Command): void {
    const res = this.world.command(id, c);
    if (!res.ok) {
      this.host.audio.playUI('error');
      this.notice(res.error ?? 'Unable', 'warn');
    } else {
      this.host.audio.playUI('confirm');
      this.dirty = true;
    }
    this.drainEvents();
  }

  /** Orbit around aircraft on the airport surface; airborne traffic is better watched in Follow view. */
  private orbitOn(a: { x: number; y: number; onGround: boolean } | undefined | null): void {
    if (a?.onGround) this.host.renderer.lookAtSim(a.x, a.y);
    else this.host.renderer.orbitHome();
  }

  setCamera(m: CameraMode): void {
    const r = this.host.renderer;
    if ((m === 'follow' || m === 'cockpit') && !this.selected) {
      this.notice('Select an aircraft first to use this view.', 'info');
      return;
    }
    r.setMode(m, this.selected);
    if (m === 'orbit') this.orbitOn(this.selected ? this.world.byId(this.selected) : undefined);
    this.updateCamButtons();
    this.host.audio.playUI('click');
  }

  private updateCamButtons(): void {
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-cam]')) b.classList.toggle('active', b.dataset.cam === this.host.renderer.mode);
  }

  togglePause(force?: boolean): void {
    this.paused = force ?? !this.paused;
    this.top.pause.textContent = this.paused ? '▶' : '❚❚';
    this.top.pause.classList.toggle('active', this.paused);
    this.el.classList.toggle('paused', this.paused);
    if (this.paused) void this.save();
  }

  cycleSpeed(dir = 1): void {
    const i = SPEEDS.indexOf(this.timeScale);
    this.timeScale = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, dir > 0 ? (i + 1) % SPEEDS.length : i - 1))];
    this.top.speed.textContent = `×${this.timeScale}`;
    this.top.speed.classList.toggle('active', this.timeScale > 1);
  }

  swapViews(): void {
    this.radarBig = !this.radarBig;
    if (this.radarBig) {
      this.mainView.replaceChildren(this.viewRadar);
      this.miniView.replaceChildren(this.view3d);
    } else {
      this.mainView.replaceChildren(this.view3d);
      this.miniView.replaceChildren(this.viewRadar);
    }
    this.resize();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.host.isModalOpen()) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePause();
        break;
      case 'Tab':
        e.preventDefault();
        this.swapViews();
        break;
      case '1': this.setCamera('tower'); break;
      case '2': this.setCamera('orbit'); break;
      case '3': this.setCamera('follow'); break;
      case '4': this.setCamera('cockpit'); break;
      case '+':
      case '=':
        this.cycleSpeed(1);
        break;
      case '-':
        this.cycleSpeed(-1);
        break;
      case 'F1':
      case '?':
        e.preventDefault();
        this.host.openHelp();
        break;
      case 'Escape':
        if (this.radar.pickingFix) {
          this.radar.pickingFix = false;
          this.fixResolve?.(null);
          this.fixResolve = null;
        } else if (this.selected) this.select(null);
        else this.host.openPauseMenu();
        break;
    }
  }

  // ------------------------------------------------------------ persistence
  summary(): CheckpointSummary {
    const w = this.world;
    const shift = w.cfg.shiftId ? SHIFT_BY_ID[w.cfg.shiftId] : null;
    return {
      airport: w.cfg.airport,
      mode: w.cfg.mode,
      shiftId: w.cfg.shiftId,
      title: shift ? `Shift ${shift.index}: ${shift.title}` : `Free play — ${w.airport.def.name}`,
      score: w.score,
      simTime: Math.round(w.t),
      remaining: w.remaining,
      savedAt: Date.now(),
    };
  }

  async save(urgent = false, beacon = false): Promise<void> {
    if (this.ended || this.disposed) return;
    if (this.saving && !beacon) return;
    this.saving = true;
    try {
      const ok = await this.host.saveCheckpoint(this.world.snapshot(), this.summary(), beacon);
      if (ok) {
        this.dirty = false;
        this.lastSavedAt = Date.now();
        this.top.saved.textContent = '✓ Saved';
        this.top.saved.className = 'tb-saved ok';
      } else if (!urgent) {
        this.top.saved.textContent = '⚠ Save failed';
        this.top.saved.className = 'tb-saved bad';
      }
    } finally {
      this.saving = false;
    }
  }

  // ------------------------------------------------------------ loop
  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dtReal = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.fpsAcc += dtReal;
    this.fpsN++;
    if (this.fpsAcc > 1) {
      this.fps = Math.round(this.fpsN / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsN = 0;
    }
    const w = this.world;
    const running = !this.paused && !this.ended && !this.host.isModalOpen();
    if (running) {
      w.step(dtReal * this.timeScale);
      this.dirty = true;
    }
    this.drainEvents();
    if (this.selected && !w.byId(this.selected)) this.select(null);

    this.host.renderer.frame(dtReal, this.selected);
    this.updateAudio(dtReal, !running);
    this.attention.clear();
    for (const a of w.aircraft) if (a.request || a.emergency) this.attention.add(a.id);
    if (this.radarBig || this.miniView.clientWidth > 0) this.radar.draw(w, this.selected, this.attention);
    this.panel.update(w, this.selected);
    this.updateLabels();
    this.stripT -= dtReal;
    if (this.stripT <= 0) {
      this.stripT = 0.25;
      this.updateTopBar();
      this.updateStrips();
    }
    this.saveT += dtReal;
    if (this.saveT >= this.host.settings.autosaveSec && this.dirty) {
      this.saveT = 0;
      void this.save();
    }
  };

  private updateAudio(dt: number, paused: boolean): void {
    const w = this.world;
    const elev = w.airport.def.elevationFt;
    const list: AircraftAudioState[] = [];
    for (const a of w.aircraft) {
      if (a.phase === 'exited') continue;
      const p = simToWorld(a.x, a.y, a.altFt, elev);
      const t = a.type;
      list.push({
        id: a.id,
        position: p,
        velocity: { x: a.vel.x, y: a.vel.z, z: -a.vel.y },
        engine: t.engine,
        engines: t.engines,
        size: t.size,
        thrust: a.thrust,
        reverse: a.reverse,
        running: a.enginesRunning,
        onGround: a.onGround,
      });
    }
    const r = this.host.renderer;
    this.host.audio.update({
      dt,
      listener: r.listener(),
      aircraft: list,
      weather: w.weather,
      simTime: w.t,
      nightFactor: r.nightFactor,
      indoor: r.indoor,
      paused,
      timeScale: this.timeScale,
    });
  }

  private drainEvents(): void {
    const w = this.world;
    if (!w.events.length) return;
    const evs = w.events.splice(0, w.events.length);
    for (const e of evs) this.handleEvent(e);
  }

  private handleEvent(e: SimEvent): void {
    const audio = this.host.audio;
    const w = this.world;
    switch (e.type) {
      case 'radio': {
        this.logRadio(e.from, e.id, e.text, !!e.urgent);
        const a = w.byId(e.id);
        const accent = e.from === 'atc' ? 'gb' : AIRLINE_BY_CODE[a?.airlineCode ?? '']?.voice ?? 'us';
        audio.transmit({ from: e.from, text: e.speech, voiceKey: e.from === 'atc' ? 'controller' : e.id, accent });
        break;
      }
      case 'score': {
        const ev = e.ev;
        const el = h('div', { class: `sf ${ev.points >= 0 ? 'pos' : 'neg'}` }, h('b', null, `${ev.points > 0 ? '+' : ''}${ev.points}`), ` ${ev.reason}`);
        this.scoreFeed.prepend(el);
        while (this.scoreFeed.children.length > 5) this.scoreFeed.lastElementChild?.remove();
        setTimeout(() => el.classList.add('fade'), 6000);
        setTimeout(() => el.remove(), 7000);
        if (ev.points <= -50) audio.playUI('violation');
        else if (ev.points > 0) audio.playUI('success');
        break;
      }
      case 'touchdown': {
        const p = simToWorld(e.x, e.y, w.airport.def.elevationFt, w.airport.def.elevationFt);
        audio.touchdown(p, e.intensity);
        break;
      }
      case 'conflict':
        if (e.level === 'predicted') audio.playUI('conflict');
        break;
      case 'request':
        audio.playUI('notify');
        break;
      case 'emergency':
        audio.playUI('emergency');
        this.notice(`${w.byId(e.id)?.callsign ?? e.id} declared an emergency (${e.kind})`, 'bad');
        break;
      case 'notice':
        this.notice(e.text, e.level);
        break;
      case 'shiftEnd':
        this.finish();
        break;
      default:
        break;
    }
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.host.audio.playUI('shiftComplete');
    this.host.shiftEnded(this.world);
  }

  notice(text: string, level: 'info' | 'warn' | 'good' | 'bad'): void {
    const el = h('div', { class: `notice ${level}` }, text);
    this.notices.append(el);
    while (this.notices.children.length > 4) this.notices.firstElementChild?.remove();
    setTimeout(() => el.classList.add('fade'), 5000);
    setTimeout(() => el.remove(), 6000);
  }

  private logRadio(from: 'atc' | 'pilot', id: string, text: string, urgent: boolean): void {
    const w = this.world;
    const el = h('div', { class: `rl ${from}${urgent ? ' urgent' : ''}`, onclick: () => w.byId(id) && this.select(id) },
      h('span', { class: 'rl-t' }, fmtClock(w.timeOfDay)),
      h('span', { class: 'rl-f' }, from === 'atc' ? 'ATC' : 'PLT'),
      h('span', { class: 'rl-x' }, text),
    );
    this.radioLog.append(el);
    while (this.radioLog.children.length > 60) this.radioLog.firstElementChild?.remove();
    this.radioLog.scrollTop = this.radioLog.scrollHeight;
  }

  private updateTopBar(): void {
    const w = this.world;
    const t = this.top;
    t.clock.textContent = fmtClock(w.timeOfDay);
    const rem = w.remaining;
    t.remain.textContent = rem == null ? '∞' : fmtDuration(rem);
    t.remain.parentElement!.classList.toggle('warn', rem != null && rem < 120);
    t.atis.textContent = w.atisLetter;
    t.atis.parentElement!.title = w.atisText();
    t.wind.textContent = fmtWind(w.weather.windDir, w.weather.windSpeed, w.weather.gust);
    t.rwy.textContent = `${w.arrivalEnds.join('/')} ↓ ${w.departureEnds.join('/')} ↑`;
    t.score.textContent = String(w.score);
    t.score.parentElement!.classList.toggle('neg', w.score < 0);
    const mine = w.aircraft.filter((a) => a.phase !== 'parked' && a.phase !== 'exited' && !a.handedOff).length;
    t.traffic.textContent = String(mine);
    if (this.lastSavedAt && Date.now() - this.lastSavedAt > 4000 && t.saved.classList.contains('ok')) {
      t.saved.textContent = `Saved ${fmtClock((new Date(this.lastSavedAt).getHours() * 3600) + new Date(this.lastSavedAt).getMinutes() * 60)}`;
      t.saved.className = 'tb-saved dim';
    }
  }

  private stripOrder(a: Aircraft): number {
    if (a.emergency) return 0;
    if (a.request) return 1;
    return 2;
  }

  private updateStrips(): void {
    const w = this.world;
    const list = w.aircraft.filter((a) => a.phase !== 'exited' && a.phase !== 'parked' && !a.handedOff);
    list.sort((a, b) => this.stripOrder(a) - this.stripOrder(b) || (a.kind === b.kind ? 0 : a.kind === 'arr' ? -1 : 1) || a.spawnT - b.spawnT);
    const rows = list.map((a) => {
      const alt = a.onGround ? 'GND' : fmtAltitude(a.altFt);
      const status = a.request ? REQUEST_LABEL[a.request] : a.phase;
      return { a, key: `${a.id}${alt}${status}${a.asgAlt}${a.id === this.selected}${w.conflictLevel(a.id)}${a.emergency}`, alt, status };
    });
    const key = rows.map((r) => r.key).join('|');
    if (key === this.stripKey) return;
    this.stripKey = key;
    this.strips.replaceChildren(
      ...rows.map(({ a, alt, status }) => {
        const lvl = w.conflictLevel(a.id);
        const cls = ['strip', a.kind, a.id === this.selected ? 'sel' : '', a.request ? 'req' : '', a.emergency ? 'emerg' : '', lvl ? `c-${lvl}` : ''].join(' ');
        return h('div', { class: cls, onclick: () => this.select(a.id) },
          h('div', { class: 's1' }, h('b', null, a.callsign), h('span', null, `${a.type.icao}/${a.type.wake}`)),
          h('div', { class: 's2' }, h('span', null, alt), h('span', null, a.onGround ? (a.gate ?? a.rwyEnd ?? '') : `→${fmtAltitude(a.asgAlt)}`)),
          h('div', { class: 's3' }, status),
        );
      }),
    );
    if (!rows.length) this.strips.append(h('div', { class: 'strip-empty' }, 'No active traffic.'));
  }

  private updateLabels(): void {
    if (!this.host.settings.labels3d || this.radarBig) {
      this.labels.style.display = 'none';
      return;
    }
    this.labels.style.display = '';
    const r = this.host.renderer;
    const w = this.world;
    let n = 0;
    for (const a of w.aircraft) {
      if (a.phase === 'exited' || a.id === r.following && (r.mode === 'cockpit' || r.mode === 'follow')) continue;
      const p = r.project(a.x, a.y, a.altFt + (a.type.height + 8) / 0.3048);
      if (!p || p.d > 25000) continue;
      let el = this.labelPool[n];
      if (!el) {
        el = h('div', { class: 'lbl' });
        el.addEventListener('click', () => this.select(el!.dataset.id ?? null));
        this.labelPool.push(el);
        this.labels.append(el);
      }
      n++;
      el.dataset.id = a.id;
      const txt = a.onGround ? a.callsign : `${a.callsign} ${Math.round(a.altFt / 100).toString().padStart(3, '0')}`;
      if (el.textContent !== txt) el.textContent = txt;
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      el.style.display = '';
      el.className = `lbl${a.id === this.selected ? ' sel' : ''}${this.attention.has(a.id) ? ' req' : ''}${w.conflictLevel(a.id) === 'loss' ? ' loss' : ''}`;
      el.style.opacity = String(Math.max(0.35, 1 - p.d / 25000));
    }
    for (let i = n; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none';
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    window.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('visibilitychange', this.visHandler);
    window.removeEventListener('pagehide', this.unloadHandler);
    this.host.audio.clearRadio();
    this.host.renderer.onPick = null;
    this.host.renderer.unload();
    // Keep the canvas alive for the next session.
    this.host.renderer.renderer.domElement.remove();
    this.el.remove();
  }
}
