// Top status console: airport & ATIS, met (wind rose, QNH, visibility), runways, shift clock, score, traffic and view controls.

import type { World } from '../sim/world';
import type { CameraMode } from '../render/Renderer';
import { fmtWind } from '../sim/phraseology';
import { h } from './dom';
import { icon } from './icons';
import { clock, mmss } from './prefs';

export interface TopBarActions {
  camera(m: CameraMode): void;
  swap(): void;
  pause(): void;
  speed(dir: number): void;
  help(): void;
  menu(): void;
  settings(): void;
  notifications(anchor: HTMLElement): void;
  score(anchor: HTMLElement): void;
  drawer(): void;
}

export interface TopBarState {
  paused: boolean;
  timeScale: number;
  mode: CameraMode;
  radarBig: boolean;
  unread: number;
  save: { state: 'ok' | 'bad' | 'none'; at: number };
}

const SVGNS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export class TopBar {
  readonly el: HTMLElement;
  private readonly v: Record<string, HTMLElement> = {};
  private readonly arrow: SVGElement;
  private readonly rwyLine: SVGElement;
  private readonly camBtns: HTMLButtonElement[];
  private readonly pauseBtn: HTMLButtonElement;
  private readonly speedBtn: HTMLButtonElement;
  private readonly swapBtn: HTMLButtonElement;
  private readonly bellBadge: HTMLElement;
  private readonly shiftBar: HTMLElement;
  private readonly scoreBox: HTMLElement;
  private lastScore: number | null = null;
  private flashT = 0;
  private key = '';

  constructor(world: World, private readonly act: TopBarActions) {
    const def = world.airport.def;
    const item = (key: string, label: string, cls = ''): HTMLElement => {
      const v = h('span', { class: 'tb-v' });
      this.v[key] = v;
      return h('div', { class: `tb-item tb-${key} ${cls}` }, h('span', { class: 'tb-l' }, label), v);
    };
    const cluster = (cls: string, ...kids: HTMLElement[]): HTMLElement => h('div', { class: `tb-cluster ${cls}` }, ...kids);

    // Wind rose: ring, runway orientation and an arrow pointing where the wind comes from.
    const rose = svg('svg', { viewBox: '0 0 32 32', class: 'wind-rose', 'aria-hidden': 'true' });
    rose.append(svg('circle', { cx: 16, cy: 16, r: 13.5, class: 'ring' }));
    for (let d = 0; d < 360; d += 90) {
      const r = (d * Math.PI) / 180;
      rose.append(svg('line', { x1: 16 + Math.sin(r) * 11, y1: 16 - Math.cos(r) * 11, x2: 16 + Math.sin(r) * 13.5, y2: 16 - Math.cos(r) * 13.5, class: 'tick' }));
    }
    this.rwyLine = svg('line', { x1: 16, y1: 7, x2: 16, y2: 25, class: 'rwy' });
    this.arrow = svg('path', { d: 'M16 15.5 L12 9 L15 9.8 L15 2.5 L17 2.5 L17 9.8 L20 9 Z', class: 'arrow' });
    rose.append(this.rwyLine, this.arrow);

    this.v.atis = h('span', { class: 'tb-atis' });
    this.shiftBar = h('div', { class: 'bar' }, h('i'));
    const shift = item('remain', 'Shift');
    shift.append(this.shiftBar);
    this.scoreBox = item('score', 'Score', 'tb-score');
    this.scoreBox.setAttribute('role', 'button');
    this.scoreBox.setAttribute('tabindex', '0');
    this.scoreBox.title = 'Score breakdown';
    this.scoreBox.addEventListener('click', () => act.score(this.scoreBox));
    this.scoreBox.addEventListener('keydown', (e) => e.key === 'Enter' && act.score(this.scoreBox));

    const btn = (label: HTMLElement | string, title: string, onclick: () => void, cls = ''): HTMLButtonElement =>
      h('button', { class: `tb-btn ${cls}`, title, 'aria-label': title, onclick }, label) as HTMLButtonElement;
    const CAMS: [CameraMode, string, string][] = [['tower', 'Tower', 'tower'], ['orbit', 'Orbit', 'orbit'], ['follow', 'Follow', 'follow'], ['cockpit', 'Cockpit', 'cockpit']];
    this.camBtns = CAMS.map(([m, label, ic], i) => {
      const b = btn(h('span', null, icon(ic), h('span', { class: 'lbl-t' }, label)), `${label} view (${i + 1})`, () => act.camera(m), 'cam');
      b.dataset.cam = m;
      return b;
    });
    this.swapBtn = btn(h('span', null, icon('swap'), h('span', { class: 'lbl-t' }, 'Radar')), 'Swap radar and 3D view (Tab)', () => act.swap());
    this.pauseBtn = btn(icon('pause'), 'Pause (Space)', () => act.pause(), 'icon-only');
    this.speedBtn = btn('×1', 'Simulation speed (+ / −)', () => act.speed(1), 'tb-speed');
    this.speedBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      act.speed(-1);
    });
    this.bellBadge = h('span', { class: 'badge hidden' });
    const bell = btn(h('span', null, icon('bell'), this.bellBadge), 'Notifications (N)', () => act.notifications(bell), 'icon-only');
    this.v.saved = h('span', { class: 'tb-saved', title: 'Checkpoint status' });

    this.el = h('header', { class: 'topbar', role: 'banner' },
      h('button', { class: 'tb-btn icon-only tb-drawer', title: 'Flight strips', 'aria-label': 'Toggle flight strips', onclick: () => act.drawer() }, icon('menu')),
      cluster('tb-brand', h('span', { class: 'tb-icao' }, def.icao), h('span', { class: 'tb-name' }, def.name), this.v.atis),
      cluster('tb-met', h('div', { class: 'tb-wind', title: 'Surface wind' }, rose, item('wind', 'Wind')), item('qnh', 'QNH'), item('vis', 'Vis', 'tb-vis')),
      cluster('tb-runways', h('div', { class: 'tb-item' }, h('span', { class: 'tb-l' }, 'Runways'), this.v.rwys = h('div', { class: 'tb-rwys' }))),
      cluster('tb-time', item('clock', 'Local'), shift),
      cluster('tb-perf', this.scoreBox, item('traffic', 'Traffic')),
      h('div', { class: 'tb-spacer' }),
      cluster('tb-controls',
        h('div', { class: 'tb-group', role: 'group', 'aria-label': 'Camera' }, ...this.camBtns),
        this.swapBtn,
        h('div', { class: 'tb-group', role: 'group', 'aria-label': 'Simulation' }, this.pauseBtn, this.speedBtn),
        bell,
        btn(icon('gear'), 'Settings', () => act.settings(), 'icon-only'),
        btn(icon('help'), 'Help (F1)', () => act.help(), 'icon-only'),
        btn(h('span', null, icon('menu'), h('span', { class: 'lbl-t' }, 'Menu')), 'Menu (Esc)', () => act.menu()),
        this.v.saved,
      ),
    );
  }

  /** Called ~4 times a second. */
  update(w: World, s: TopBarState): void {
    const t = this.v;
    t.clock.textContent = clock(w.timeOfDay);
    const rem = w.remaining;
    t.remain.textContent = rem == null ? '∞' : mmss(rem);
    t.remain.parentElement!.classList.toggle('warn', rem != null && rem < 120);
    const total = (w.cfg.durationMin ?? 0) * 60;
    const bar = this.shiftBar.firstElementChild as HTMLElement;
    this.shiftBar.classList.toggle('hidden', rem == null || !total);
    this.shiftBar.classList.toggle('warn', rem != null && rem < 120);
    if (rem != null && total) bar.style.width = `${Math.round(Math.min(1, Math.max(0, 1 - rem / total)) * 100)}%`;

    t.atis.textContent = w.atisLetter;
    t.atis.title = `ATIS information ${w.atisLetter}\n${w.atisText()}`;
    const wx = w.weather;
    t.wind.textContent = wx.windSpeed < 1 ? 'CALM' : fmtWind(wx.windDir, wx.windSpeed, wx.gust);
    this.arrow.style.transform = `rotate(${wx.windDir}deg)`;
    this.arrow.style.display = wx.windSpeed < 1 ? 'none' : '';
    const end = w.airport.ends[w.arrivalEnds[0] ?? w.departureEnds[0]];
    if (end) this.rwyLine.setAttribute('transform', `rotate(${end.hdg} 16 16)`);
    t.qnh.textContent = String(Math.round(wx.qnh));
    t.vis.textContent = wx.visibility >= 10000 ? '10+ km' : wx.visibility >= 1000 ? `${(wx.visibility / 1000).toFixed(1)} km` : `${Math.round(wx.visibility / 50) * 50} m`;
    t.vis.parentElement!.classList.toggle('warn', wx.visibility < 1500);
    t.vis.parentElement!.title = `Visibility ${Math.round(wx.visibility)} m · cloud base ${Math.round(wx.cloudBase)} ft · ${Math.round(wx.temperature)} °C`;

    const rkey = `${w.arrivalEnds.join()}|${w.departureEnds.join()}`;
    if (rkey !== this.key) {
      this.key = rkey;
      t.rwys.replaceChildren(
        h('span', { class: 'chip arr', title: 'Arrival runways' }, `ARR ${w.arrivalEnds.join(' ') || '—'}`),
        h('span', { class: 'chip dep', title: 'Departure runways' }, `DEP ${w.departureEnds.join(' ') || '—'}`),
      );
    }

    // Score with a flash on change.
    t.score.textContent = String(w.score);
    this.scoreBox.classList.toggle('neg', w.score < 0);
    if (this.lastScore != null && w.score !== this.lastScore) {
      this.scoreBox.classList.remove('up', 'down');
      void this.scoreBox.offsetWidth;
      this.scoreBox.classList.add(w.score > this.lastScore ? 'up' : 'down');
      clearTimeout(this.flashT);
      this.flashT = window.setTimeout(() => this.scoreBox.classList.remove('up', 'down'), 900);
    }
    this.lastScore = w.score;

    let arr = 0;
    let dep = 0;
    let req = 0;
    for (const a of w.aircraft) {
      if (a.phase === 'parked' || a.phase === 'exited' || a.handedOff) continue;
      if (a.kind === 'arr') arr++;
      else dep++;
      if (a.request) req++;
    }
    t.traffic.replaceChildren(
      h('span', { class: 'arr', title: 'Arrivals' }, `↓${arr}`),
      h('span', { class: 'dep', title: 'Departures' }, `↑${dep}`),
      req ? h('span', { class: 'req', title: 'Waiting for you' }, `●${req}`) : '',
    );

    for (const b of this.camBtns) b.classList.toggle('active', b.dataset.cam === s.mode);
    this.swapBtn.classList.toggle('active', s.radarBig);
    this.swapBtn.querySelector('.lbl-t')!.textContent = s.radarBig ? '3D view' : 'Radar';
    if (this.pauseBtn.classList.contains('active') !== s.paused || !this.pauseBtn.dataset.init) {
      this.pauseBtn.dataset.init = '1';
      this.pauseBtn.replaceChildren(icon(s.paused ? 'play' : 'pause'));
    }
    this.pauseBtn.classList.toggle('active', s.paused);
    this.pauseBtn.title = s.paused ? 'Resume (Space)' : 'Pause (Space)';
    this.speedBtn.textContent = `×${s.timeScale}`;
    this.speedBtn.classList.toggle('active', s.timeScale > 1);
    this.bellBadge.textContent = s.unread > 9 ? '9+' : String(s.unread);
    this.bellBadge.classList.toggle('hidden', !s.unread);

    const sv = t.saved;
    if (s.save.state === 'bad') {
      sv.className = 'tb-saved bad';
      sv.replaceChildren(icon('alert'), 'Save failed');
    } else if (s.save.state === 'ok') {
      const ago = Math.round((Date.now() - s.save.at) / 1000);
      sv.className = `tb-saved ${ago < 4 ? 'ok' : 'dim'}`;
      sv.replaceChildren(icon('check'), ago < 4 ? 'Saved' : ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`);
      sv.title = `Checkpoint saved ${ago < 4 ? 'just now' : `${ago} s ago`}`;
    } else {
      sv.className = 'tb-saved dim';
      sv.replaceChildren(icon('save'));
    }
  }
}
