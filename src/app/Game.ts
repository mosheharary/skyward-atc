// One play session: steps the World, drives the 3D renderer, radar, audio and HUD, and autosaves checkpoints.

import { World, type WorldSnapshot } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import type { Command, SimEvent } from '../sim/simTypes';
import type { GameRenderer, CameraMode } from '../render/Renderer';
import type { AircraftAudioState, IAudioEngine } from '../audio/contracts';
import { AIRLINE_BY_CODE } from '../sim/airlines';
import { SHIFT_BY_ID } from '../sim/career';
import { simToWorld } from '../core/units';
import { RadarScope, type RadarOptions } from '../ui/radar';
import { CommandPanel } from '../ui/commandPanel';
import { StripBoard } from '../ui/strips';
import { CommsPanel, type CommsEntry } from '../ui/comms';
import { TopBar } from '../ui/topbar';
import { Notifier, ScoreFeed, breakdownView, scoreBreakdown, togglePopover, type NoticeLevel } from '../ui/notifications';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import type { CheckpointSummary, Settings } from '../ui/api';
import { prefs } from '../ui/prefs';

export interface GameHost {
  renderer: GameRenderer;
  audio: IAudioEngine;
  settings: Settings;
  /** Persist the checkpoint; resolves true on success. */
  saveCheckpoint(state: WorldSnapshot, summary: CheckpointSummary, beacon?: boolean): Promise<boolean>;
  openHelp(section?: string): void;
  openPauseMenu(): void;
  showSettings(): void;
  /** Merge, apply and (debounced) persist a settings change made from inside the HUD. */
  updateSettings(patch: Partial<Settings>): void;
  shiftEnded(world: World): void;
  isModalOpen(): boolean;
}

const SPEEDS = [1, 2, 4];
const TOWER_PHASES = new Set(['final', 'landing', 'goaround', 'lineup', 'takeoff', 'holding']);

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
  private strips: StripBoard;
  private comms: CommsPanel;
  private topbar: TopBar;
  private notifier: Notifier;
  private scoreFeed: ScoreFeed;
  private scorePop: HTMLElement | null = null;
  private labels: HTMLElement;
  private labelPool: HTMLElement[] = [];
  private body: HTMLElement;
  private mainView: HTMLElement;
  private miniView: HTMLElement;
  private miniTag: HTMLElement;
  private view3d: HTMLElement;
  private viewRadar: HTMLElement;
  private radarBig = false;
  private attention = new Set<string>();
  private stripT = 0;
  private saveT = 0;
  private dirty = false;
  private saving = false;
  private saveState: { state: 'ok' | 'bad' | 'none'; at: number } = { state: 'none', at: 0 };
  private fixResolve: ((f: string | null) => void) | null = null;
  private ended = false;
  private disposed = false;
  private readonly ro: ResizeObserver;
  private readonly keyHandler = (e: KeyboardEvent): void => this.onKey(e);
  private readonly visHandler = (): void => {
    if (document.visibilityState === 'hidden') {
      if (this.host.settings.pauseOnBlur && !this.paused) this.togglePause(true);
      void this.save(true);
    }
  };
  private readonly unloadHandler = (): void => void this.save(true, true);
  private fpsAcc = 0;
  private fpsN = 0;
  fps = 0;

  constructor(private readonly host: GameHost, root: HTMLElement, world: World) {
    this.world = world;
    const r = host.renderer;
    const s = host.settings;
    this.el = h('div', { class: 'game' });
    this.notifier = new Notifier();
    this.scoreFeed = new ScoreFeed();

    // ---- top bar
    this.topbar = new TopBar(world, {
      camera: (m) => this.setCamera(m),
      swap: () => this.swapViews(),
      pause: () => this.togglePause(),
      speed: (d) => this.cycleSpeed(d),
      help: () => host.openHelp(),
      menu: () => host.openPauseMenu(),
      settings: () => host.showSettings(),
      notifications: (anchor) => this.notifier.toggleCenter(this.el, anchor),
      score: (anchor) => this.toggleScore(anchor),
      drawer: () => this.el.classList.toggle('drawer-open'),
    });

    // ---- views
    this.view3d = h('div', { class: 'view view-3d' }, r.renderer.domElement);
    this.labels = h('div', { class: 'labels3d' });
    this.view3d.append(this.labels);
    this.viewRadar = h('div', { class: 'view view-radar' });
    this.mainView = h('div', { class: 'main-view' }, this.view3d);
    this.miniTag = h('span', { class: 'view-tag' }, 'RADAR');
    this.miniView = h('div', { class: 'mini-view' }, this.viewRadar, this.miniTag,
      h('button', { class: 'mini view-swap', title: 'Swap views (Tab)', 'aria-label': 'Swap radar and 3D view', onclick: () => this.swapViews() }, icon('expand')));
    this.radar = new RadarScope(this.viewRadar, {
      select: (id) => this.select(id),
      vector: (id, hdg) => this.command(id, { kind: 'heading', hdg }),
      fix: (f) => {
        this.radar.pickingFix = false;
        this.fixResolve?.(f);
        this.fixResolve = null;
      },
      options: (o) => this.saveRadarOptions(o),
    }, this.radarOptions(s));
    this.radar.reset(world, s.radarRange);

    // ---- panels
    this.strips = new StripBoard({ select: (id) => this.select(id), collapse: () => this.toggleStrips() });
    this.comms = new CommsPanel(world.airport.def.icao, {
      select: (id) => world.byId(id) && this.select(id),
      resized: (px) => host.updateSettings({ commsH: px }),
      collapsed: (c) => host.updateSettings({ commsCollapsed: c }),
    }, { height: s.commsH, collapsed: s.commsCollapsed });
    const right = h('aside', { class: 'right-col', 'aria-label': 'Radar and command panel' }, this.miniView);
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
      history: (id) => this.comms.history(id),
    });
    const center = h('main', { class: 'center-col' }, this.mainView, this.comms.el, this.notifier.toasts);
    this.mainView.append(this.scoreFeed.el);
    const left = h('aside', { class: 'left-col', 'aria-label': 'Flight strips' }, this.strips.el);
    left.append(this.resizer('left'));
    right.prepend(this.resizer('right'));
    this.body = h('div', { class: 'game-body' }, left, center, right,
      h('div', { class: 'drawer-scrim', onclick: () => this.el.classList.remove('drawer-open') }));
    this.el.append(this.topbar.el, this.body);
    this.applyLayout(s);
    root.appendChild(this.el);
    this.notifier.onChange = () => this.updateTopBar();

    // Radio calls still queued as events are logged when drained; only replay older history.
    const pending = world.events.filter((e) => e.type === 'radio').length;
    for (const e of world.radioLog.slice(0, world.radioLog.length - pending).slice(-40)) this.logRadio(e.from, e.id, e.text, !!e.urgent, e.t, true);

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
    this.applySettings(s);
    this.updateTopBar();
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
    this.radar.setOptions(this.radarOptions(s));
    this.applyLayout(s);
  }

  private radarOptions(s: Settings): RadarOptions {
    return { rings: s.radarRings, fixes: s.radarFixes, water: s.radarWater, ils: s.radarIls, blocks: s.radarBlocks, trail: s.radarTrail, vector: s.radarVector, font: s.radarFont };
  }

  private saveRadarOptions(o: RadarOptions): void {
    this.host.updateSettings({ radarRings: o.rings, radarFixes: o.fixes, radarWater: o.water, radarIls: o.ils, radarBlocks: o.blocks, radarTrail: o.trail, radarVector: o.vector, radarFont: o.font });
  }

  private applyLayout(s: Settings): void {
    this.el.style.setProperty('--strips-w', `${s.stripsW}px`);
    this.el.style.setProperty('--right-w', `${s.rightW}px`);
    this.body?.classList.toggle('strips-collapsed', s.stripsCollapsed);
    this.strips?.setCollapsed(s.stripsCollapsed);
  }

  private toggleStrips(): void {
    // In the narrow (drawer) layout the collapse button closes the drawer instead.
    if (this.el.classList.contains('drawer-open')) {
      this.el.classList.remove('drawer-open');
      return;
    }
    this.host.updateSettings({ stripsCollapsed: !this.host.settings.stripsCollapsed });
  }

  /** Drag handle on a column edge; persists the new width. */
  private resizer(side: 'left' | 'right'): HTMLElement {
    const el = h('div', { class: 'col-resize', title: 'Drag to resize', role: 'separator', 'aria-orientation': 'vertical' });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const x0 = e.clientX;
      const w0 = side === 'left' ? this.host.settings.stripsW : this.host.settings.rightW;
      let w = w0;
      const move = (ev: PointerEvent): void => {
        const dx = (ev.clientX - x0) / prefs.scale;
        w = Math.round(side === 'left' ? Math.min(460, Math.max(210, w0 + dx)) : Math.min(560, Math.max(300, w0 - dx)));
        this.el.style.setProperty(side === 'left' ? '--strips-w' : '--right-w', `${w}px`);
      };
      const up = (): void => {
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        this.host.updateSettings(side === 'left' ? { stripsW: w } : { rightW: w });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }

  private resize(): void {
    const v = this.view3d;
    this.host.renderer.resize(v.clientWidth, v.clientHeight);
  }

  // ------------------------------------------------------------ actions
  select(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    this.comms.setSelected(id);
    if (id) {
      this.host.audio.playUI('select');
      const a = this.world.byId(id);
      if (a && this.host.renderer.mode === 'orbit') this.orbitOn(a);
      if (this.host.renderer.mode === 'follow' || this.host.renderer.mode === 'cockpit') this.host.renderer.setMode(this.host.renderer.mode, id);
      if (this.el.classList.contains('drawer-open')) this.el.classList.remove('drawer-open');
    }
    this.strips.update(this.world, this.selected);
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
    if (this.radarBig) this.swapViews();
    this.updateTopBar();
    this.host.audio.playUI('click');
  }

  togglePause(force?: boolean): void {
    this.paused = force ?? !this.paused;
    this.el.classList.toggle('paused', this.paused);
    this.updateTopBar();
    if (this.paused) void this.save();
  }

  cycleSpeed(dir = 1): void {
    const i = SPEEDS.indexOf(this.timeScale);
    this.timeScale = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, dir > 0 ? (i + 1) % SPEEDS.length : i - 1))];
    this.updateTopBar();
  }

  swapViews(): void {
    this.radarBig = !this.radarBig;
    if (this.radarBig) {
      this.mainView.replaceChildren(this.viewRadar, this.scoreFeed.el);
      this.miniView.prepend(this.view3d);
    } else {
      this.mainView.replaceChildren(this.view3d, this.scoreFeed.el);
      this.miniView.prepend(this.viewRadar);
    }
    this.miniTag.textContent = this.radarBig ? this.host.renderer.mode.toUpperCase() : 'RADAR';
    this.resize();
    this.updateTopBar();
  }

  private toggleScore(anchor: HTMLElement): void {
    this.scorePop = h('div', { class: 'popover score-pop', role: 'dialog', 'aria-label': 'Score breakdown' });
    const { gained, lost } = scoreBreakdown(this.world.scoreLog);
    const shift = this.world.cfg.shiftId ? SHIFT_BY_ID[this.world.cfg.shiftId] : null;
    this.scorePop.append(
      h('h4', null, 'Session score'),
      h('div', { class: 'sp-total' }, h('b', { class: this.world.score < 0 ? 'err' : 'good' }, String(this.world.score)),
        shift ? h('span', { class: 'dim' }, `pass ${shift.passScore} · ★★ ${Math.round(shift.passScore * 1.6)} · ★★★ ${Math.round(shift.passScore * 2.4)}`) : h('span', { class: 'dim' }, 'Free play')),
      h('div', { class: 'sp-sum' },
        h('div', { class: 'pos' }, h('span', null, 'Earned'), h('b', null, `+${gained}`)),
        h('div', { class: 'neg' }, h('span', null, 'Penalties'), h('b', null, String(lost)))),
      breakdownView(this.world.scoreLog),
    );
    const old = this.el.querySelector('.score-pop');
    if (old) {
      old.remove();
      return;
    }
    const cluster = anchor.closest('.tb-cluster') as HTMLElement | null;
    if (cluster) this.scorePop.style.left = `${cluster.offsetLeft}px`;
    togglePopover(this.el, this.scorePop, anchor);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.host.isModalOpen()) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (this.el.querySelector('.popover') && e.key === 'Escape') return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePause();
        return;
      case 'Tab':
        e.preventDefault();
        this.swapViews();
        return;
      case '1': this.setCamera('tower'); return;
      case '2': this.setCamera('orbit'); return;
      case '3': this.setCamera('follow'); return;
      case '4': this.setCamera('cockpit'); return;
      case '+':
      case '=':
        this.cycleSpeed(1);
        return;
      case '-':
        this.cycleSpeed(-1);
        return;
      case 'F1':
      case '?':
        e.preventDefault();
        this.host.openHelp();
        return;
      case 'ArrowUp':
      case 'ArrowDown': {
        if (this.panel.pickerOpen) break;
        e.preventDefault();
        const order = this.strips.order;
        if (!order.length) return;
        const i = this.selected ? order.indexOf(this.selected) : -1;
        const next = e.key === 'ArrowDown' ? (i + 1) % order.length : (i <= 0 ? order.length : i) - 1;
        this.select(order[next]);
        this.el.querySelector('.strip.sel')?.scrollIntoView({ block: 'nearest' });
        return;
      }
      case 'Escape':
        if (this.radar.pickingFix) {
          this.radar.pickingFix = false;
          this.fixResolve?.(null);
          this.fixResolve = null;
        } else if (this.panel.pickerOpen) this.panel.closePicker();
        else if (this.selected) this.select(null);
        else this.host.openPauseMenu();
        return;
    }
    if (this.selected && this.panel.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'n' || e.key === 'N') {
      const bell = this.el.querySelector<HTMLElement>('.topbar [aria-label^="Notifications"]');
      if (bell) this.notifier.toggleCenter(this.el, bell);
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
        this.saveState = { state: 'ok', at: Date.now() };
      } else if (!urgent) {
        this.saveState = { state: 'bad', at: Date.now() };
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
      this.strips.update(w, this.selected);
    }
    this.saveT += dtReal;
    if (this.saveT >= this.host.settings.autosaveSec && this.dirty) {
      this.saveT = 0;
      void this.save();
    }
  };

  private updateTopBar(): void {
    this.topbar.update(this.world, {
      paused: this.paused,
      timeScale: this.timeScale,
      mode: this.host.renderer.mode,
      radarBig: this.radarBig,
      unread: this.notifier.unread,
      save: this.saveState,
    });
  }

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
        this.logRadio(e.from, e.id, e.text, !!e.urgent, w.t);
        const a = w.byId(e.id);
        const accent = e.from === 'atc' ? 'gb' : AIRLINE_BY_CODE[a?.airlineCode ?? '']?.voice ?? 'us';
        audio.transmit({ from: e.from, text: e.speech, voiceKey: e.from === 'atc' ? 'controller' : e.id, accent });
        break;
      }
      case 'score': {
        const ev = e.ev;
        this.scoreFeed.add(ev);
        if (ev.points <= -50) {
          audio.playUI('violation');
          this.notifier.push(`${ev.points} · ${ev.reason}`, 'bad', w.timeOfDay);
        } else if (ev.points > 0) audio.playUI('success');
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

  notice(text: string, level: NoticeLevel): void {
    this.notifier.push(text, level, this.world.timeOfDay);
  }

  private logRadio(from: 'atc' | 'pilot', id: string, text: string, urgent: boolean, simT: number, replay = false): void {
    const w = this.world;
    const a: Aircraft | undefined = w.byId(id);
    const pos: CommsEntry['pos'] = !a ? 'APP' : a.onGround && !TOWER_PHASES.has(a.phase) ? 'GND' : TOWER_PHASES.has(a.phase) ? 'TWR' : 'APP';
    this.comms.add({ t: w.cfg.startHour * 3600 + simT, from, id, callsign: a?.callsign ?? id, text, urgent, pos }, replay);
  }

  private updateLabels(): void {
    if (!this.host.settings.labels3d || this.radarBig) {
      this.labels.style.display = 'none';
      return;
    }
    this.labels.style.display = '';
    const r = this.host.renderer;
    const w = this.world;
    const maxD = this.host.settings.labelDistance || 25000;
    let n = 0;
    for (const a of w.aircraft) {
      if (a.phase === 'exited' || a.id === r.following && (r.mode === 'cockpit' || r.mode === 'follow')) continue;
      const p = r.project(a.x, a.y, a.altFt + (a.type.height + 8) / 0.3048);
      if (!p || p.d > maxD) continue;
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
      el.className = `lbl ${a.kind}${a.id === this.selected ? ' sel' : ''}${this.attention.has(a.id) ? ' req' : ''}${a.emergency ? ' emerg' : ''}${w.conflictLevel(a.id) === 'loss' ? ' loss' : ''}`;
      el.style.opacity = String(Math.max(0.35, 1 - p.d / maxD));
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
