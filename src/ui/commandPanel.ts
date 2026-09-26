// Click-driven command panel for the selected aircraft. Buttons are generated from World.available().

import type { World } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import type { Command, RequestKind } from '../sim/simTypes';
import { fmtAltitude, fmtHeading } from '../sim/phraseology';
import { WAKE_LABEL } from '../sim/aircraftTypes';
import { AIRLINE_BY_CODE } from '../sim/airlines';
import { h } from './dom';

export interface CommandPanelCallbacks {
  send(id: string, c: Command): void;
  /** Ask the radar to let the player click a fix; resolves with the fix id or null. */
  pickFix(): Promise<string | null>;
  follow(id: string): void;
}

const PHASE_LABEL: Record<string, string> = {
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

export class CommandPanel {
  readonly el: HTMLElement;
  private readonly info: HTMLElement;
  private readonly body: HTMLElement;
  private key = '';
  private lastId: string | null = null;
  private picker: Picker = null;
  private hdg = 360;
  private turn: 'L' | 'R' | undefined;
  private expedite = false;
  private world: World | null = null;
  private ac: Aircraft | null = null;

  constructor(parent: HTMLElement, private readonly cb: CommandPanelCallbacks) {
    this.el = h('div', { class: 'cmd-panel' });
    this.info = h('div', { class: 'cmd-info' });
    this.body = h('div', { class: 'cmd-body' });
    this.el.append(this.info, this.body);
    parent.appendChild(this.el);
  }

  update(world: World, id: string | null): void {
    this.world = world;
    const a = id ? world.byId(id) ?? null : null;
    this.ac = a;
    if (!a) {
      if (this.key !== 'none') {
        this.key = 'none';
        this.lastId = null;
        this.picker = null;
        this.info.replaceChildren(h('div', { class: 'cmd-empty' }, 'Select an aircraft on the radar, in the 3D view or in the flight strips.'));
        this.body.replaceChildren(
          h('div', { class: 'cmd-hint' }, 'Aircraft glowing amber are waiting for you. Right-click on the radar to vector the selected aircraft towards that point.'),
        );
      }
      return;
    }
    const avail = [...world.available(a)].sort().join(',');
    const key = `${a.id}|${a.phase}|${avail}|${a.request}|${this.picker}|${a.holdPos}|${a.appr}|${world.arrivalEnds.join()}`;
    this.renderInfo(world, a);
    if (key === this.key) return;
    if (this.lastId !== a.id) {
      this.lastId = a.id;
      this.picker = null;
      this.hdg = Math.round((a.asgHdg ?? a.hdg) / 5) * 5 || 360;
      this.turn = undefined;
    }
    this.key = `${a.id}|${a.phase}|${avail}|${a.request}|${this.picker}|${a.holdPos}|${a.appr}|${world.arrivalEnds.join()}`;
    this.renderBody(world, a, world.available(a));
  }

  private renderInfo(world: World, a: Aircraft): void {
    const t = a.type;
    const al = AIRLINE_BY_CODE[a.airlineCode];
    const lines: (string | HTMLElement)[] = [];
    const req = a.request ? REQUEST_LABEL[a.request] + (a.requestRwy ? ` ${a.requestRwy}` : '') : null;
    const status: string[] = [];
    if (a.onGround) {
      status.push(`${Math.round(Math.abs(a.gsKt))} kt`);
      if (a.gate) status.push(`gate ${a.gate}`);
      if (a.rwyEnd) status.push(`rwy ${a.rwyEnd}`);
    } else {
      status.push(`${fmtAltitude(a.altFt)} ft → ${fmtAltitude(a.asgAlt)}`);
      status.push(`hdg ${fmtHeading(a.hdg)}${a.asgHdg != null ? ` → ${fmtHeading(a.asgHdg)}` : ''}`);
      status.push(`${Math.round(a.ias)} kt${a.asgSpd ? ` → ${a.asgSpd}` : ''}`);
    }
    const nav = a.appr ? `${a.apprState === 'gs' ? 'Established ILS' : a.apprState === 'loc' ? 'On localizer' : 'Cleared ILS'} ${a.appr}${a.landClr ? ' · cleared to land' : ''}`
      : a.hold ? `Holding at ${a.hold.fix}` : a.direct ? `Direct ${a.direct}` : a.route.length ? `Route ${a.route.join(' ')}` : a.exitFix && a.kind === 'dep' ? `Exit via ${a.exitFix}` : '';
    lines.push(
      h('div', { class: 'cmd-callsign' },
        h('span', { class: 'cs' }, a.callsign),
        h('span', { class: 'tel' }, a.displayCallsign),
        h('button', { class: 'mini', title: 'Follow with the camera', onclick: () => this.cb.follow(a.id) }, '👁'),
      ),
      h('div', { class: 'cmd-sub' }, `${t.icao} · ${WAKE_LABEL[t.wake]} · ${al?.name ?? a.airlineCode} · ${a.kind === 'arr' ? 'Arrival' : 'Departure'} · ${a.registration}`),
      h('div', { class: 'cmd-phase' }, `${PHASE_LABEL[a.phase] ?? a.phase}${a.holdPos ? ' · HOLDING POSITION' : ''}`),
      h('div', { class: 'cmd-status' }, status.join(' · ')),
    );
    if (nav) lines.push(h('div', { class: 'cmd-nav' }, nav));
    if (a.emergency) lines.push(h('div', { class: 'cmd-emerg' }, `EMERGENCY — ${a.emergency}`));
    if (req) lines.push(h('div', { class: 'cmd-req' }, req));
    const conflict = world.conflictLevel(a.id);
    if (conflict) lines.push(h('div', { class: conflict === 'loss' ? 'cmd-emerg' : 'cmd-warn' }, conflict === 'loss' ? 'SEPARATION LOST' : 'Conflict predicted'));
    this.info.replaceChildren(...lines);
  }

  private btn(label: string, onClick: () => void, cls = '', title = ''): HTMLButtonElement {
    return h('button', { class: `cmd-btn ${cls}`, title, onclick: onClick }, label) as HTMLButtonElement;
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

  private renderBody(world: World, a: Aircraft, av: Set<Command['kind']>): void {
    const suggested = a.request ? REQUEST_CMD[a.request] : null;
    const cls = (k: Command['kind']): string => (k === suggested ? 'suggest' : '');
    const rows: HTMLElement[] = [];
    const grid = (...items: (HTMLElement | null | false)[]): HTMLElement => h('div', { class: 'cmd-grid' }, ...(items.filter(Boolean) as HTMLElement[]));

    // Airborne vectoring
    const air: HTMLElement[] = [];
    if (av.has('heading')) air.push(this.btn('Heading', () => this.togglePicker('heading'), this.picker === 'heading' ? 'active' : ''));
    if (av.has('altitude')) air.push(this.btn('Altitude', () => this.togglePicker('altitude'), this.picker === 'altitude' ? 'active' : ''));
    if (av.has('speed')) air.push(this.btn('Speed', () => this.togglePicker('speed'), this.picker === 'speed' ? 'active' : ''));
    if (av.has('direct')) air.push(this.btn('Direct to', () => this.togglePicker('direct'), this.picker === 'direct' ? 'active' : ''));
    if (av.has('hold')) air.push(this.btn('Hold at', () => this.togglePicker('hold'), this.picker === 'hold' ? 'active' : ''));
    if (av.has('approach')) air.push(this.btn('Cleared ILS', () => this.togglePicker('approach'), `${this.picker === 'approach' ? 'active' : ''}`, 'Clear the aircraft for the ILS approach'));
    if (av.has('land')) air.push(this.btn('Cleared to land', () => (a.appr ? this.send({ kind: 'land', runway: a.appr }) : this.togglePicker('land')), `${cls('land')} good`));
    if (av.has('goAround')) air.push(this.btn('Go around', () => this.send({ kind: 'goAround' }), 'danger'));
    if (av.has('handoff')) air.push(this.btn('Contact departure', () => this.send({ kind: 'handoff' }), 'good', 'Hand off to the departure controller'));
    if (air.length) rows.push(grid(...air));

    // Ground
    const gnd: HTMLElement[] = [];
    if (av.has('pushback')) gnd.push(this.btn('Push back', () => this.send({ kind: 'pushback' }), cls('pushback')));
    if (av.has('taxi')) {
      const ends = world.departureEnds;
      if (ends.length === 1) gnd.push(this.btn(`Taxi to ${ends[0]}`, () => this.send({ kind: 'taxi', runway: ends[0] }), cls('taxi')));
      else gnd.push(this.btn('Taxi to runway', () => this.togglePicker('taxi'), `${cls('taxi')} ${this.picker === 'taxi' ? 'active' : ''}`));
    }
    if (av.has('taxiGate')) gnd.push(this.btn('Taxi to gate', () => this.send({ kind: 'taxiGate' }), cls('taxiGate')));
    if (av.has('cross')) gnd.push(this.btn('Cross runway', () => this.send({ kind: 'cross' }), cls('cross')));
    if (av.has('holdPosition')) gnd.push(this.btn('Hold position', () => this.send({ kind: 'holdPosition' }), 'warn'));
    if (av.has('continueTaxi')) gnd.push(this.btn('Continue taxi', () => this.send({ kind: 'continueTaxi' }), 'good'));
    if (av.has('lineUp')) gnd.push(this.btn('Line up & wait', () => this.send({ kind: 'lineUp' })));
    if (av.has('takeoff')) gnd.push(this.btn('Cleared for take-off', () => this.send({ kind: 'takeoff' }), `${cls('takeoff')} good`));
    if (av.has('cancelTakeoff')) gnd.push(this.btn('Cancel take-off', () => this.send({ kind: 'cancelTakeoff' }), 'danger'));
    if (gnd.length) rows.push(grid(...gnd));

    if (!air.length && !gnd.length) rows.push(h('div', { class: 'cmd-hint' }, a.phase === 'parked' ? 'Parked at the gate. It will call you when ready for departure.' : a.handedOff ? 'Handed off — no longer your traffic.' : 'No instructions possible right now.'));

    const p = this.picker;
    if (p === 'heading') rows.push(this.headingPicker());
    if (p === 'altitude') rows.push(this.altitudePicker(world, a));
    if (p === 'speed') rows.push(this.speedPicker(a));
    if (p === 'direct' || p === 'hold') rows.push(this.fixPicker(world, a, p));
    if (p === 'approach' || p === 'land') {
      const ends = Object.values(world.airport.ends).filter((e) => e.ils || p === 'land').map((e) => e.name);
      const pref = world.arrivalEnds;
      ends.sort((x, y) => Number(pref.includes(y)) - Number(pref.includes(x)));
      rows.push(h('div', { class: 'picker' }, h('div', { class: 'picker-title' }, p === 'approach' ? 'ILS approach runway' : 'Landing runway'),
        grid(...ends.map((n) => this.btn(n, () => this.send(p === 'approach' ? { kind: 'approach', runway: n } : { kind: 'land', runway: n }), pref.includes(n) ? 'suggest' : '')))));
    }
    if (p === 'taxi') {
      const pref = world.departureEnds;
      const ends = Object.keys(world.airport.ends).sort((x, y) => Number(pref.includes(y)) - Number(pref.includes(x)));
      rows.push(h('div', { class: 'picker' }, h('div', { class: 'picker-title' }, 'Departure runway'),
        grid(...ends.map((n) => this.btn(n, () => this.send({ kind: 'taxi', runway: n }), pref.includes(n) ? 'suggest' : '')))));
    }
    this.body.replaceChildren(...rows);
  }

  private headingPicker(): HTMLElement {
    const disp = h('div', { class: 'hdg-value' }, fmtHeading(this.hdg));
    const dial = h('canvas', { class: 'hdg-dial', width: '150', height: '150' }) as HTMLCanvasElement;
    const draw = (): void => {
      disp.textContent = fmtHeading(this.hdg);
      const g = dial.getContext('2d')!;
      g.clearRect(0, 0, 150, 150);
      g.strokeStyle = '#3b6a70';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(75, 75, 66, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#8fb8bc';
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (let d = 0; d < 360; d += 10) {
        const r = d * Math.PI / 180;
        const inner = d % 30 === 0 ? 56 : 61;
        g.beginPath();
        g.moveTo(75 + Math.sin(r) * inner, 75 - Math.cos(r) * inner);
        g.lineTo(75 + Math.sin(r) * 66, 75 - Math.cos(r) * 66);
        g.stroke();
        if (d % 30 === 0) g.fillText(String(d / 10).padStart(2, '0'), 75 + Math.sin(r) * 46, 75 - Math.cos(r) * 46);
      }
      const r = this.hdg * Math.PI / 180;
      g.strokeStyle = '#ffd36a';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(75, 75);
      g.lineTo(75 + Math.sin(r) * 60, 75 - Math.cos(r) * 60);
      g.stroke();
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
      h('div', { class: 'picker-title' }, 'Assign heading'),
      h('div', { class: 'hdg-row' }, dial,
        h('div', { class: 'hdg-side' }, disp,
          h('div', { class: 'cmd-grid tight' }, this.btn('−30', adj(-30)), this.btn('−10', adj(-10)), this.btn('−5', adj(-5)), this.btn('+5', adj(5)), this.btn('+10', adj(10)), this.btn('+30', adj(30))),
          h('div', { class: 'cmd-grid tight' }, ...turnBtns),
        ),
      ),
      this.btn('Send heading', () => this.send({ kind: 'heading', hdg: this.hdg, turn: this.turn }), 'good wide'),
    );
  }

  private altitudePicker(world: World, a: Aircraft): HTMLElement {
    const def = world.airport.def;
    const minAlt = Math.min(def.mva, def.missedApproachAlt);
    const alts: number[] = [];
    const lo = Math.ceil(minAlt / 1000) * 1000;
    for (let alt = lo; alt <= Math.min(def.airspace.ceilingFt + 4000, a.type.ceilingFt); alt += alt < 10000 ? 1000 : 2000) alts.push(alt);
    if (!alts.includes(minAlt)) alts.unshift(minAlt);
    const exp = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: this.expedite ? '' : null, onchange: (e: Event) => (this.expedite = (e.target as HTMLInputElement).checked) }), ' Expedite');
    return h('div', { class: 'picker' },
      h('div', { class: 'picker-title' }, `Assign altitude (now ${fmtAltitude(a.altFt)} ft)`),
      h('div', { class: 'cmd-grid alt' }, ...alts.map((alt) => this.btn(fmtAltitude(alt), () => this.send({ kind: 'altitude', alt, expedite: this.expedite }), alt === a.asgAlt ? 'active' : ''))),
      exp,
    );
  }

  private speedPicker(a: Aircraft): HTMLElement {
    const t = a.type;
    const spds = [140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 250].filter((s) => s >= t.vapp - 5 && s <= t.vmax);
    return h('div', { class: 'picker' },
      h('div', { class: 'picker-title' }, `Assign speed (now ${Math.round(a.ias)} kt)`),
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
      h('div', { class: 'picker-title' }, kind === 'direct' ? 'Proceed direct to' : 'Hold at fix'),
      h('div', { class: 'cmd-grid alt' },
        ...fixes.map((f) => this.btn(f.id, () => this.send(kind === 'direct' ? { kind: 'direct', fix: f.id } : { kind: 'hold', fix: f.id }), `fix-${f.role}`, f.role.toUpperCase())),
      ),
      this.btn('Pick on radar…', async () => {
        const f = await this.cb.pickFix();
        if (f && this.ac) this.send(kind === 'direct' ? { kind: 'direct', fix: f } : { kind: 'hold', fix: f });
      }, 'wide'),
    );
  }
}
