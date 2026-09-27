// Command panel for the selected aircraft: identity card, telemetry tiles, clearance timeline, grouped commands
// (generated from World.available()), pickers, keyboard shortcuts and the aircraft's recent transmissions.

import type { World } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import type { Command, RequestKind } from '../sim/simTypes';
import { fmtAltitude, fmtHeading } from '../sim/phraseology';
import { WAKE_LABEL } from '../sim/aircraftTypes';
import { AIRLINE_BY_CODE } from '../sim/airlines';
import { NM } from '../core/units';
import { h } from './dom';
import { icon } from './icons';
import { alt, altUnit, clock, mmss } from './prefs';
import type { CommsEntry } from './comms';

export interface CommandPanelCallbacks {
  send(id: string, c: Command): void;
  /** Ask the radar to let the player click a fix; resolves with the fix id or null. */
  pickFix(): Promise<string | null>;
  follow(id: string): void;
  /** Recent radio transmissions for an aircraft. */
  history(id: string): CommsEntry[];
}

export const PHASE_LABEL: Record<string, string> = {
  inbound: 'Inbound', approach: 'Approach', final: 'Final', landing: 'Landing', goaround: 'Go-around', vacating: 'Vacating',
  clear: 'Clear of runway', taxiIn: 'Taxiing in', parking: 'Parking', parked: 'Parked', ready: 'Ready at gate', pushback: 'Pushing back',
  pushed: 'Pushed back', taxiOut: 'Taxiing out', holding: 'Holding short', lineup: 'Lining up', takeoff: 'Take-off roll',
  climbout: 'Climbing out', exited: 'Left airspace',
};

export const REQUEST_LABEL: Record<RequestKind, string> = {
  pushback: 'Requests push-back',
  taxi: 'Requests taxi',
  crossing: 'Requests runway crossing',
  takeoff: 'Ready for departure',
  landing: 'Requests landing clearance',
  taxiGate: 'Requests taxi to the gate',
};

const REQUEST_CMD: Record<RequestKind, Command['kind']> = {
  pushback: 'pushback', taxi: 'taxi', crossing: 'cross', takeoff: 'takeoff', landing: 'land', taxiGate: 'taxiGate',
};

type Picker = 'heading' | 'altitude' | 'speed' | 'direct' | 'hold' | 'approach' | 'land' | 'taxi' | 'takeoff' | null;

interface Action {
  kind: Command['kind'];
  label: string;
  icon: string;
  key: string;
  group: 'vector' | 'approach' | 'transfer' | 'ground';
  cls?: string;
  title?: string;
  picker?: Picker;
  run(): void;
}

const DEP_ORDER = ['parked', 'ready', 'pushback', 'pushed', 'taxiOut', 'holding', 'lineup', 'takeoff', 'climbout', 'exited'];
const ON_FIELD = new Set(['landing', 'vacating', 'clear', 'taxiIn', 'parking', 'parked']);

export class CommandPanel {
  readonly el: HTMLElement;
  private readonly info: HTMLElement;
  private readonly body: HTMLElement;
  private readonly hist: HTMLElement;
  private key = '';
  private infoKey = '';
  private histKey = '';
  private lastId: string | null = null;
  private picker: Picker = null;
  private hdg = 360;
  private turn: 'L' | 'R' | undefined;
  private expedite = false;
  private world: World | null = null;
  private ac: Aircraft | null = null;
  private actions: Action[] = [];
  private respond: Action | null = null;

  constructor(parent: HTMLElement, private readonly cb: CommandPanelCallbacks) {
    this.el = h('div', { class: 'cmd-panel', role: 'region', 'aria-label': 'Command panel' });
    this.info = h('div', { class: 'cmd-info' });
    this.body = h('div', { class: 'cmd-body' });
    this.hist = h('div', { class: 'cmd-group' });
    this.el.append(this.info, this.body, this.hist);
    parent.appendChild(this.el);
  }

  get pickerOpen(): boolean {
    return this.picker != null;
  }

  closePicker(): void {
    this.picker = null;
    this.key = '';
  }

  update(world: World, id: string | null): void {
    this.world = world;
    const a = id ? world.byId(id) ?? null : null;
    this.ac = a;
    if (!a) {
      if (this.key !== 'none') {
        this.key = 'none';
        this.infoKey = '';
        this.histKey = '';
        this.lastId = null;
        this.picker = null;
        this.actions = [];
        this.respond = null;
        this.info.replaceChildren(h('div', { class: 'cmd-empty' },
          icon('target'),
          h('b', null, 'No aircraft selected'),
          h('span', null, 'Select an aircraft on the radar, in the 3D view or in the flight strips.'),
          h('div', { class: 'cmd-tips' },
            h('div', null, h('kbd', null, '↑'), h('kbd', null, '↓'), h('span', null, 'Step through the flight strips')),
            h('div', null, h('kbd', null, 'R'), h('span', null, 'Answer the pilot’s request')),
            h('div', null, h('kbd', null, 'H'), h('kbd', null, 'A'), h('kbd', null, 'S'), h('span', null, 'Heading, altitude, speed')),
            h('div', null, h('kbd', null, 'R-click'), h('span', null, 'on the radar vectors the selected aircraft')),
            h('div', null, h('span', { class: 'k amber' }, 'Amber'), h('span', null, 'aircraft are waiting for you')),
          ),
        ));
        this.body.replaceChildren();
        this.hist.replaceChildren();
      }
      return;
    }
    if (this.lastId !== a.id) {
      this.lastId = a.id;
      this.picker = null;
      this.hdg = Math.round((a.asgHdg ?? a.hdg) / 5) * 5 || 360;
      this.turn = undefined;
      this.infoKey = '';
    }
    this.renderInfo(world, a);
    this.renderHistory(a);
    const avail = [...world.available(a)].sort().join(',');
    const key = `${a.id}|${a.phase}|${avail}|${a.request}|${this.picker}|${a.holdPos}|${a.appr}|${world.arrivalEnds.join()}`;
    if (key === this.key) return;
    this.key = key;
    this.renderBody(world, a, world.available(a));
  }

  /** Keyboard shortcuts while an aircraft is selected. Returns true when the key was used. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.ac || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toUpperCase();
    if (k === 'ENTER' && this.picker === 'heading') {
      this.send({ kind: 'heading', hdg: this.hdg, turn: this.turn });
      return true;
    }
    if (this.picker === 'heading' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      this.hdg = (((this.hdg + (e.key === 'ArrowLeft' ? -5 : 5)) % 360) + 360) % 360 || 360;
      this.key = '';
      return true;
    }
    if (k === 'R' && this.respond) {
      this.respond.run();
      return true;
    }
    const act = this.actions.find((x) => x.key === k);
    if (act) {
      act.run();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ info card
  private renderInfo(world: World, a: Aircraft): void {
    const t = a.type;
    const al = AIRLINE_BY_CODE[a.airlineCode];
    const conflict = world.conflictLevel(a.id);
    const wait = a.request ? world.t - a.requestT : 0;
    const air = !a.onGround;
    // Distance / ETA to the landing threshold (arrivals) or exit fix (departures).
    let dist: number | null = null;
    let distTo = '';
    if (air) {
      if (a.kind === 'arr') {
        const end = world.airport.ends[a.appr ?? world.arrivalEnds[0]];
        if (end) {
          dist = Math.hypot(a.x - end.threshold[0], a.y - end.threshold[1]) / NM;
          distTo = `RWY ${end.name}`;
        }
      } else if (a.exitFix) {
        const f = world.airport.fixes[a.exitFix];
        if (f) {
          dist = Math.hypot(a.x - f.pos[0], a.y - f.pos[1]) / NM;
          distTo = a.exitFix;
        }
      }
    }
    const eta = dist != null && a.gsKt > 30 ? (dist / a.gsKt) * 3600 : null;
    const vs = Math.round(a.vs / 100) * 100;
    const key = [a.id, a.phase, Math.round(a.altFt / 10), a.asgAlt, Math.round(a.hdg), a.asgHdg, a.turnDir, Math.round(a.ias), a.asgSpd, vs, Math.round(a.gsKt),
      dist?.toFixed(1), eta && Math.round(eta / 5), a.request, Math.floor(wait), a.emergency, conflict, a.holdPos, a.appr, a.apprState, a.landClr, a.gate, a.rwyEnd,
      a.direct, a.hold?.fix, a.handedOff, a.exitFix, a.route.join()].join('|');
    if (key === this.infoKey) return;
    this.infoKey = key;

    const tile = (label: string, value: (string | HTMLElement)[], sub: string, extra: string | HTMLElement = '', cls = ''): HTMLElement =>
      h('div', { class: `tile ${cls}` }, h('div', { class: 'l' }, label, extra), h('div', { class: 'v' }, ...value), h('div', { class: `a${sub ? '' : ' none'}` }, sub || '—'));
    const trend = vs > 200 ? h('span', { class: 'tr-up' }, '▲') : vs < -200 ? h('span', { class: 'tr-dn' }, '▼') : '';
    const tiles = air
      ? [
        tile('Alt', [alt(a.altFt), h('small', null, altUnit())], Math.abs(a.asgAlt - a.altFt) > 60 ? `→ ${alt(a.asgAlt)}` : 'level', trend),
        tile('Hdg', [`${fmtHeading(a.hdg)}°`], a.asgHdg != null ? `→ ${fmtHeading(a.asgHdg)}°${a.turnDir ? ` ${a.turnDir}` : ''}` : a.direct ? `DCT ${a.direct}` : a.hold ? `HOLD ${a.hold.fix}` : a.apprState ? (a.apprState === 'gs' ? 'on ILS' : 'on LOC') : a.route[0] ? `RTE ${a.route[0]}` : ''),
        tile('Ias', [String(Math.round(a.ias)), h('small', null, 'kt')], a.asgSpd ? `→ ${a.asgSpd} kt` : 'own speed'),
        tile('V/S', [`${vs > 0 ? '+' : ''}${vs}`, h('small', null, 'fpm')], `GS ${Math.round(a.gsKt)} kt`),
        tile('Dist', dist != null ? [dist.toFixed(1), h('small', null, 'NM')] : ['—'], distTo),
        tile('ETA', eta != null ? [mmss(eta)] : ['—'], eta != null ? clock(world.timeOfDay + eta) : ''),
      ]
      : [
        tile('Gs', [String(Math.round(Math.abs(a.gsKt))), h('small', null, 'kt')], a.holdPos ? 'holding position' : PHASE_LABEL[a.phase] ?? ''),
        tile('Stand', [a.gate ?? '—'], a.kind === 'arr' ? 'assigned stand' : 'departure gate'),
        tile('Rwy', [a.rwyEnd ?? '—'], a.kind === 'dep' && a.exitFix ? `exit ${a.exitFix}` : '', '', a.request === 'crossing' ? 'warn' : ''),
      ];

    const lines: HTMLElement[] = [
      h('div', { class: 'ac-card' },
        h('div', { class: 'ac-head' },
          h('span', { class: 'cs' }, a.callsign),
          h('span', { class: 'tel', title: a.displayCallsign }, a.displayCallsign),
          h('button', { class: 'mini', title: 'Follow with the camera (3)', 'aria-label': 'Follow with the camera', onclick: () => this.cb.follow(a.id) }, icon('eye')),
        ),
        h('div', { class: 'ac-chips' },
          h('span', { class: `chip ${a.kind}` }, a.kind === 'arr' ? '↓ ARR' : '↑ DEP'),
          h('span', { class: 'chip solid' }, t.icao),
          h('span', { class: `wake ${t.wake}`, title: `Wake category: ${WAKE_LABEL[t.wake]}` }, t.wake),
          h('span', { class: 'sub' }, `${al?.name ?? a.airlineCode} · ${a.registration}`),
        ),
      ),
    ];
    if (a.emergency) lines.push(h('div', { class: 'alert emerg', role: 'alert' }, icon('emergency'), `EMERGENCY — ${a.emergency}`));
    if (conflict) lines.push(h('div', { class: `alert ${conflict === 'loss' ? 'loss' : 'warn'}`, role: 'alert' }, icon('alert'), conflict === 'loss' ? 'SEPARATION LOST' : 'Conflict predicted'));
    if (a.request) lines.push(h('div', { class: 'alert req' }, icon('bell'), `${REQUEST_LABEL[a.request]}${a.requestRwy ? ` ${a.requestRwy}` : ''}`, h('span', { class: 'wait' }, mmss(wait))));
    if (a.holdPos) lines.push(h('div', { class: 'alert hold' }, icon('stop'), 'Holding position'));
    if (a.handedOff) lines.push(h('div', { class: 'alert warn' }, icon('handoff'), 'Handed off — no longer your traffic'));
    lines.push(
      h('div', null, h('div', { class: 'sec-title' }, PHASE_LABEL[a.phase] ?? a.phase), h('div', { class: 'tele' }, ...tiles)),
      h('div', null, h('div', { class: 'sec-title' }, 'Clearances'), this.timeline(a)),
    );
    this.info.replaceChildren(...lines);
  }

  private timeline(a: Aircraft): HTMLElement {
    type Step = [string, 'done' | 'now' | 'next'];
    const steps: Step[] = [];
    const st = (done: boolean, now: boolean): Step[1] => (done ? 'done' : now ? 'now' : 'next');
    if (a.kind === 'arr') {
      const landed = ON_FIELD.has(a.phase);
      const airborne = !landed;
      steps.push([a.hold ? `Holding at <b>${a.hold.fix}</b>` : a.direct ? `Direct <b>${a.direct}</b>` : a.route.length ? `Route <b>${a.route.join(' ')}</b>` : 'Vectors', st(!!a.appr || landed, airborne && !a.appr)]);
      steps.push([a.appr ? `Cleared ILS <b>${a.appr}</b>${a.apprState === 'gs' ? ' · established' : a.apprState === 'loc' ? ' · on localizer' : ''}` : 'ILS approach', st(!!a.appr || landed, false)]);
      steps.push([a.landClr ? `Cleared to land <b>${a.landClr}</b>` : 'Landing clearance', st(!!a.landClr || landed, !!a.appr && !a.landClr && airborne)]);
      steps.push([`Taxi to stand${a.gate ? ` <b>${a.gate}</b>` : ''}`, st(['taxiIn', 'parking', 'parked'].includes(a.phase), ['landing', 'vacating', 'clear'].includes(a.phase))]);
      steps.push(['On stand', st(a.phase === 'parked', a.phase === 'parking')]);
    } else {
      const i = DEP_ORDER.indexOf(a.phase);
      steps.push([`Push-back${a.gate ? ` from <b>${a.gate}</b>` : ''}`, st(i >= 3, i >= 1 && i < 3)]);
      steps.push([`Taxi to runway${a.rwyEnd ? ` <b>${a.rwyEnd}</b>` : ''}`, st(i >= 5, i >= 3 && i < 5)]);
      steps.push(['Line up', st(i >= 7, i >= 5 && i < 7)]);
      steps.push(['Take-off', st(i >= 8, i === 7)]);
      steps.push([`Climb${a.exitFix ? ` & exit via <b>${a.exitFix}</b>` : ''}`, st(a.handedOff || i >= 9, i === 8 && !a.handedOff)]);
      steps.push(['Hand-off to departure', st(a.handedOff, false)]);
    }
    return h('div', { class: 'clr' }, ...steps.map(([html, s]) => h('div', { class: `clr-item ${s}`, html })));
  }

  private renderHistory(a: Aircraft): void {
    const list = this.cb.history(a.id);
    const key = `${a.id}|${list.length}|${list[list.length - 1]?.t ?? ''}|${list[list.length - 1]?.text ?? ''}`;
    if (key === this.histKey) return;
    this.histKey = key;
    this.hist.replaceChildren(
      h('div', { class: 'sec-title' }, 'Recent transmissions'),
      h('div', { class: 'cmd-history' },
        ...(list.length ? list.map((e) => h('div', { class: e.from }, h('span', null, e.from === 'atc' ? 'ATC' : 'PLT'), h('span', null, e.text)))
          : [h('div', { class: 'none' }, 'No transmissions yet.')]),
      ),
    );
  }

  // ------------------------------------------------------------ commands
  private btn(label: string | HTMLElement, onClick: () => void, cls = '', title = '', ic?: string, key?: string): HTMLButtonElement {
    return h('button', { class: `cmd-btn ${cls}`, title: title || (key ? `${typeof label === 'string' ? label : ''} (${key})` : ''), onclick: onClick },
      ic ? icon(ic) : '', label, key ? h('kbd', null, key) : '') as HTMLButtonElement;
  }

  private send(c: Command): void {
    if (!this.ac) return;
    this.cb.send(this.ac.id, c);
    this.picker = null;
    this.key = '';
  }

  private togglePicker(p: Picker): void {
    this.picker = this.picker === p ? null : p;
    this.key = '';
  }

  private buildActions(world: World, a: Aircraft, av: Set<Command['kind']>): Action[] {
    const out: Action[] = [];
    const pk = (p: Picker) => (): void => this.togglePicker(p);
    const add = (x: Action): void => {
      if (av.has(x.kind)) out.push(x);
    };
    add({ kind: 'heading', label: 'Heading', icon: 'heading', key: 'H', group: 'vector', picker: 'heading', run: pk('heading') });
    add({ kind: 'altitude', label: 'Altitude', icon: 'altitude', key: 'A', group: 'vector', picker: 'altitude', run: pk('altitude') });
    add({ kind: 'speed', label: 'Speed', icon: 'gauge', key: 'S', group: 'vector', picker: 'speed', run: pk('speed') });
    add({ kind: 'direct', label: 'Direct to', icon: 'direct', key: 'D', group: 'vector', picker: 'direct', run: pk('direct') });
    add({ kind: 'hold', label: 'Hold at', icon: 'hold', key: 'O', group: 'vector', picker: 'hold', run: pk('hold') });
    add({ kind: 'approach', label: 'Cleared ILS', icon: 'ils', key: 'I', group: 'approach', picker: 'approach', title: 'Clear the aircraft for the ILS approach (I)', run: pk('approach') });
    add({ kind: 'land', label: 'Cleared to land', icon: 'land', key: 'L', group: 'approach', cls: 'good', picker: a.appr ? undefined : 'land', run: () => (a.appr ? this.send({ kind: 'land', runway: a.appr }) : this.togglePicker('land')) });
    add({ kind: 'goAround', label: 'Go around', icon: 'goaround', key: 'G', group: 'approach', cls: 'danger', run: () => this.send({ kind: 'goAround' }) });
    add({ kind: 'handoff', label: 'Contact departure', icon: 'handoff', key: 'C', group: 'transfer', cls: 'good', title: 'Hand off to the departure controller (C)', run: () => this.send({ kind: 'handoff' }) });
    add({ kind: 'pushback', label: 'Push back', icon: 'push', key: 'P', group: 'ground', run: () => this.send({ kind: 'pushback' }) });
    if (av.has('taxi')) {
      const ends = world.departureEnds;
      if (ends.length === 1) out.push({ kind: 'taxi', label: `Taxi to ${ends[0]}`, icon: 'taxi', key: 'T', group: 'ground', run: () => this.send({ kind: 'taxi', runway: ends[0] }) });
      else out.push({ kind: 'taxi', label: 'Taxi to runway', icon: 'taxi', key: 'T', group: 'ground', picker: 'taxi', run: pk('taxi') });
    }
    add({ kind: 'taxiGate', label: 'Taxi to gate', icon: 'taxi', key: 'T', group: 'ground', run: () => this.send({ kind: 'taxiGate' }) });
    add({ kind: 'cross', label: 'Cross runway', icon: 'cross', key: 'X', group: 'ground', run: () => this.send({ kind: 'cross' }) });
    add({ kind: 'holdPosition', label: 'Hold position', icon: 'stop', key: 'Z', group: 'ground', cls: 'warn', run: () => this.send({ kind: 'holdPosition' }) });
    add({ kind: 'continueTaxi', label: 'Continue taxi', icon: 'taxi', key: 'V', group: 'ground', cls: 'good', run: () => this.send({ kind: 'continueTaxi' }) });
    add({ kind: 'lineUp', label: 'Line up & wait', icon: 'runway', key: 'U', group: 'ground', run: () => this.send({ kind: 'lineUp' }) });
    add({ kind: 'takeoff', label: 'Cleared for take-off', icon: 'takeoff', key: 'K', group: 'ground', cls: 'good', run: () => this.send({ kind: 'takeoff' }) });
    add({ kind: 'cancelTakeoff', label: 'Cancel take-off', icon: 'stop', key: 'Q', group: 'ground', cls: 'danger', run: () => this.send({ kind: 'cancelTakeoff' }) });
    return out;
  }

  private renderBody(world: World, a: Aircraft, av: Set<Command['kind']>): void {
    const suggested = a.request ? REQUEST_CMD[a.request] : null;
    this.actions = this.buildActions(world, a, av);
    this.respond = this.actions.find((x) => x.kind === suggested) ?? null;
    const rows: HTMLElement[] = [];
    const mk = (x: Action, cls = ''): HTMLButtonElement =>
      this.btn(x.label, () => x.run(), `${x.cls ?? ''} ${cls} ${x.picker && this.picker === x.picker ? 'active' : ''}`, x.title ?? `${x.label} (${x.key})`, x.icon, x.key);

    if (this.respond) {
      const r = this.respond;
      const b = this.btn(`Respond: ${r.label}`, () => r.run(), 'suggest', `Answer the request (R)`, r.icon);
      b.append(h('kbd', null, 'R'));
      rows.push(h('div', { class: 'cmd-respond' }, b));
    }
    const GROUPS: [Action['group'], string][] = [['vector', 'Vectors'], ['approach', 'Approach'], ['transfer', 'Transfer'], ['ground', 'Ground']];
    for (const [g, title] of GROUPS) {
      const items = this.actions.filter((x) => x.group === g && x !== this.respond);
      if (!items.length) continue;
      rows.push(h('div', { class: 'cmd-group' }, h('div', { class: 'sec-title' }, title), h('div', { class: 'cmd-grid' }, ...items.map((x) => mk(x)))));
    }
    if (!this.actions.length) {
      rows.push(h('div', { class: 'cmd-hint' }, a.phase === 'parked' ? 'Parked at the gate. It will call you when ready for departure.' : a.handedOff ? 'Handed off — no longer your traffic.' : 'No instructions possible right now.'));
    }

    const grid = (...items: HTMLElement[]): HTMLElement => h('div', { class: 'cmd-grid' }, ...items);
    const p = this.picker;
    let pickerEl: HTMLElement | null = null;
    if (p === 'heading') pickerEl = this.headingPicker();
    if (p === 'altitude') pickerEl = this.altitudePicker(world, a);
    if (p === 'speed') pickerEl = this.speedPicker(a);
    if (p === 'direct' || p === 'hold') pickerEl = this.fixPicker(world, a, p);
    if (p === 'approach' || p === 'land') {
      const ends = Object.values(world.airport.ends).filter((e) => e.ils || p === 'land').map((e) => e.name);
      const pref = world.arrivalEnds;
      ends.sort((x, y) => Number(pref.includes(y)) - Number(pref.includes(x)));
      pickerEl = h('div', { class: 'picker' }, this.pickerTitle(p === 'approach' ? 'ILS approach runway' : 'Landing runway'),
        grid(...ends.map((n) => this.btn(n, () => this.send(p === 'approach' ? { kind: 'approach', runway: n } : { kind: 'land', runway: n }), pref.includes(n) ? 'suggest' : ''))));
    }
    if (p === 'taxi') {
      const pref = world.departureEnds;
      const ends = Object.keys(world.airport.ends).sort((x, y) => Number(pref.includes(y)) - Number(pref.includes(x)));
      pickerEl = h('div', { class: 'picker' }, this.pickerTitle('Departure runway'),
        grid(...ends.map((n) => this.btn(n, () => this.send({ kind: 'taxi', runway: n }), pref.includes(n) ? 'suggest' : ''))));
    }
    // Show the picker right under the group of the button that opened it.
    if (pickerEl) {
      const owner = this.actions.find((x) => x.picker === p);
      const idx = owner ? rows.findIndex((r) => r.querySelector('.cmd-btn.active')) : -1;
      if (idx >= 0) rows.splice(idx + 1, 0, pickerEl);
      else rows.push(pickerEl);
    }
    this.body.replaceChildren(...rows);
    if (pickerEl) requestAnimationFrame(() => pickerEl!.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  private pickerTitle(text: string): HTMLElement {
    return h('div', { class: 'picker-title' }, text, h('button', { class: 'close', 'aria-label': 'Close picker', title: 'Close (Esc)', onclick: () => this.togglePicker(null) }, icon('close')));
  }

  private headingPicker(): HTMLElement {
    const disp = h('div', { class: 'hdg-value' }, fmtHeading(this.hdg));
    const dial = h('canvas', { class: 'hdg-dial', width: '300', height: '300', 'aria-label': 'Heading dial' }) as HTMLCanvasElement;
    const draw = (): void => {
      disp.textContent = fmtHeading(this.hdg);
      const g = dial.getContext('2d')!;
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, 150, 150);
      const a0 = this.ac;
      g.fillStyle = 'rgba(57,208,196,0.06)';
      g.beginPath();
      g.arc(75, 75, 66, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#3b6a70';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(75, 75, 66, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#9fc4c8';
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 1.5;
      for (let d = 0; d < 360; d += 10) {
        const r = d * Math.PI / 180;
        const inner = d % 30 === 0 ? 56 : 61;
        g.beginPath();
        g.moveTo(75 + Math.sin(r) * inner, 75 - Math.cos(r) * inner);
        g.lineTo(75 + Math.sin(r) * 66, 75 - Math.cos(r) * 66);
        g.stroke();
        if (d % 30 === 0) g.fillText(String(d / 10).padStart(2, '0'), 75 + Math.sin(r) * 46, 75 - Math.cos(r) * 46);
      }
      // Current heading marker.
      if (a0) {
        const rc = a0.hdg * Math.PI / 180;
        g.strokeStyle = 'rgba(127,232,255,0.8)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(75 + Math.sin(rc) * 30, 75 - Math.cos(rc) * 30);
        g.lineTo(75 + Math.sin(rc) * 52, 75 - Math.cos(rc) * 52);
        g.stroke();
      }
      const r = this.hdg * Math.PI / 180;
      g.strokeStyle = '#ffd36a';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(75, 75);
      g.lineTo(75 + Math.sin(r) * 60, 75 - Math.cos(r) * 60);
      g.stroke();
      g.fillStyle = '#ffd36a';
      g.beginPath();
      g.arc(75, 75, 3.5, 0, Math.PI * 2);
      g.fill();
    };
    const setFromEvent = (e: PointerEvent): void => {
      const rc = dial.getBoundingClientRect();
      const x = e.clientX - rc.left - rc.width / 2;
      const y = e.clientY - rc.top - rc.height / 2;
      this.hdg = (Math.round(((Math.atan2(x, -y) * 180 / Math.PI + 360) % 360) / 5) * 5) % 360 || 360;
      draw();
    };
    dial.addEventListener('pointerdown', (e) => {
      dial.setPointerCapture(e.pointerId);
      setFromEvent(e);
    });
    dial.addEventListener('pointermove', (e) => {
      if (e.buttons) setFromEvent(e);
    });
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.hdg = (((this.hdg + (e.deltaY > 0 ? 5 : -5)) % 360) + 360) % 360 || 360;
      draw();
    }, { passive: false });
    const adj = (d: number) => (): void => {
      this.hdg = (((this.hdg + d) % 360) + 360) % 360 || 360;
      draw();
    };
    const turnBtns = (['L', undefined, 'R'] as const).map((t) =>
      this.btn(t === 'L' ? 'Left' : t === 'R' ? 'Right' : 'Shortest', () => {
        this.turn = t;
        turnBtns.forEach((b, i) => b.classList.toggle('active', (['L', undefined, 'R'] as const)[i] === t));
      }, this.turn === t ? 'active' : ''),
    );
    draw();
    return h('div', { class: 'picker' },
      this.pickerTitle('Assign heading · ←/→ ±5 · Enter sends'),
      h('div', { class: 'hdg-row' }, dial,
        h('div', { class: 'hdg-side' }, disp,
          h('div', { class: 'cmd-grid tight' }, this.btn('−30', adj(-30)), this.btn('−10', adj(-10)), this.btn('−5', adj(-5)), this.btn('+5', adj(5)), this.btn('+10', adj(10)), this.btn('+30', adj(30))),
          h('div', { class: 'cmd-grid tight' }, ...turnBtns),
        ),
      ),
      this.btn('Send heading', () => this.send({ kind: 'heading', hdg: this.hdg, turn: this.turn }), 'good wide', 'Send heading (Enter)'),
    );
  }

  private altitudePicker(world: World, a: Aircraft): HTMLElement {
    const def = world.airport.def;
    const minAlt = Math.min(def.mva, def.missedApproachAlt);
    const alts: number[] = [];
    const lo = Math.ceil(minAlt / 1000) * 1000;
    for (let al = lo; al <= Math.min(def.airspace.ceilingFt + 4000, a.type.ceilingFt); al += al < 10000 ? 1000 : 2000) alts.push(al);
    if (!alts.includes(minAlt)) alts.unshift(minAlt);
    const exp = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.expedite ? '' : null, onchange: (e: Event) => (this.expedite = (e.target as HTMLInputElement).checked) }), ' Expedite');
    return h('div', { class: 'picker' },
      this.pickerTitle(`Assign altitude (now ${fmtAltitude(a.altFt)} ft)`),
      h('div', { class: 'cmd-grid alt' }, ...alts.map((al) => this.btn(fmtAltitude(al), () => this.send({ kind: 'altitude', alt: al, expedite: this.expedite }), al === a.asgAlt ? 'active' : al < def.mva ? 'warn' : '', al < def.mva ? 'Below the minimum vectoring altitude' : ''))),
      exp,
    );
  }

  private speedPicker(a: Aircraft): HTMLElement {
    const t = a.type;
    const spds = [140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 250].filter((s) => s >= t.vapp - 5 && s <= t.vmax);
    return h('div', { class: 'picker' },
      this.pickerTitle(`Assign speed (now ${Math.round(a.ias)} kt)`),
      h('div', { class: 'cmd-grid alt' },
        ...spds.map((spd) => this.btn(String(spd), () => this.send({ kind: 'speed', spd }), spd === a.asgSpd ? 'active' : '')),
        this.btn('Normal', () => this.send({ kind: 'speed', spd: null }), a.asgSpd == null ? 'active' : ''),
      ),
    );
  }

  private fixPicker(world: World, a: Aircraft, kind: 'direct' | 'hold'): HTMLElement {
    const fixes = world.airport.def.fixes.filter((f) => (a.kind === 'dep' ? true : f.role !== 'exit'));
    const roleOrder: Record<string, number> = { if: 0, iaf: 1, wpt: 2, entry: 3, exit: 4 };
    fixes.sort((x, y) => roleOrder[x.role] - roleOrder[y.role] || x.id.localeCompare(y.id));
    return h('div', { class: 'picker' },
      this.pickerTitle(kind === 'direct' ? 'Proceed direct to' : 'Hold at fix'),
      h('div', { class: 'cmd-grid alt' },
        ...fixes.map((f) => this.btn(f.id, () => this.send(kind === 'direct' ? { kind: 'direct', fix: f.id } : { kind: 'hold', fix: f.id }), `fix-${f.role}`, f.role.toUpperCase())),
      ),
      this.btn('Pick on radar…', async () => {
        const f = await this.cb.pickFix();
        if (f && this.ac) this.send(kind === 'direct' ? { kind: 'direct', fix: f } : { kind: 'hold', fix: f });
      }, 'wide', '', 'target'),
    );
  }
}
