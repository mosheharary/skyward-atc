// Flight strip board: strips grouped into bays (priority / arrivals / departures / ground) with filters, sorting and waiting timers.

import type { World } from '../sim/world';
import type { Aircraft } from '../sim/aircraft';
import type { RequestKind } from '../sim/simTypes';
import { fmtHeading } from '../sim/phraseology';
import { h } from './dom';
import { icon } from './icons';
import { alt, mmss } from './prefs';
import { PHASE_LABEL } from './commandPanel';

type Bay = 'priority' | 'arr' | 'dep' | 'gnd';
type Filter = 'all' | 'arr' | 'dep' | 'gnd';
type Sort = 'prio' | 'time' | 'cs';

const BAY_LABEL: Record<Bay, string> = { priority: 'Needs attention', arr: 'Arrivals', dep: 'Departures', gnd: 'Ground' };
const BAYS: Bay[] = ['priority', 'arr', 'dep', 'gnd'];

export const REQUEST_SHORT: Record<RequestKind, string> = {
  pushback: 'PUSH', taxi: 'TAXI', crossing: 'CROSS', takeoff: 'READY T/O', landing: 'LANDING', taxiGate: 'TAXI GATE',
};

export interface StripCallbacks {
  select(id: string): void;
  collapse(): void;
}

export class StripBoard {
  readonly el: HTMLElement;
  private readonly bays = new Map<Bay, { el: HTMLElement; body: HTMLElement; n: HTMLElement }>();
  private readonly strips = new Map<string, { el: HTMLElement; key: string }>();
  private readonly count: HTMLElement;
  private readonly rail: HTMLElement;
  private readonly empty: HTMLElement;
  private filter: Filter = 'all';
  private sort: Sort = 'prio';
  private closed = new Set<Bay>();
  private orderIds: string[] = [];
  private force = true;

  constructor(private readonly cb: StripCallbacks) {
    this.count = h('b', null, '0');
    const filterSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Filter strips' });
    const filters: [Filter, string][] = [['all', 'All'], ['arr', 'Arr'], ['dep', 'Dep'], ['gnd', 'Gnd']];
    for (const [f, label] of filters) {
      filterSeg.append(h('button', {
        class: f === this.filter ? 'active' : '', role: 'tab', 'data-f': f, onclick: () => {
          this.filter = f;
          for (const b of filterSeg.children) b.classList.toggle('active', (b as HTMLElement).dataset.f === f);
          this.force = true;
        },
      }, label));
    }
    const sortSel = h('select', {
      'aria-label': 'Sort strips', title: 'Sort order', onchange: (e: Event) => {
        this.sort = (e.target as HTMLSelectElement).value as Sort;
        this.force = true;
      },
    }, h('option', { value: 'prio' }, 'Priority'), h('option', { value: 'time' }, 'Time'), h('option', { value: 'cs' }, 'Callsign')) as HTMLSelectElement;
    const baysEl = h('div', { class: 'sb-bays', role: 'listbox', 'aria-label': 'Flight strips' });
    for (const b of BAYS) {
      const n = h('span', { class: 'n' }, '0');
      const body = h('div', { class: 'bay-body' });
      const el = h('section', { class: `bay ${b}` },
        h('button', {
          class: 'bay-head', 'aria-expanded': 'true', onclick: (e: Event) => {
            const open = this.closed.has(b);
            if (open) this.closed.delete(b);
            else this.closed.add(b);
            el.classList.toggle('closed', !open);
            (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
          },
        }, icon('chevron'), h('span', { class: 'dot' }), BAY_LABEL[b], n),
        body,
      );
      this.bays.set(b, { el, body, n });
      baysEl.append(el);
    }
    this.empty = h('div', { class: 'strip-empty hidden' }, icon('radar'), 'No active traffic.');
    baysEl.append(this.empty);
    this.rail = h('div', { class: 'rail-count' });
    this.el = h('div', { class: 'sb' },
      h('div', { class: 'sb-head' },
        h('div', { class: 'sb-title' }, h('span', null, 'Flight strips'), this.count),
        h('div', { class: 'spacer' }),
        h('button', { class: 'mini', title: 'Collapse / expand the strip board', 'aria-label': 'Collapse strip board', onclick: () => cb.collapse() }, icon('chevronLeft')),
      ),
      this.rail,
      h('div', { class: 'sb-tools' }, filterSeg, sortSel),
      baysEl,
    );
  }

  /** Aircraft ids in display order (for keyboard navigation). */
  get order(): readonly string[] {
    return this.orderIds;
  }

  setCollapsed(c: boolean): void {
    const btn = this.el.querySelector('.sb-head .mini');
    if (btn) btn.replaceChildren(icon(c ? 'chevronRight' : 'chevronLeft'));
  }

  private bayOf(a: Aircraft): Bay {
    if (a.emergency || a.request) return 'priority';
    if (a.onGround) return 'gnd';
    return a.kind;
  }

  private passes(a: Aircraft): boolean {
    switch (this.filter) {
      case 'arr': return a.kind === 'arr';
      case 'dep': return a.kind === 'dep';
      case 'gnd': return a.onGround;
      default: return true;
    }
  }

  update(w: World, selected: string | null): void {
    const list = w.aircraft.filter((a) => a.phase !== 'exited' && a.phase !== 'parked' && !a.handedOff);
    this.count.textContent = String(list.length);
    const arr = list.filter((a) => a.kind === 'arr').length;
    const req = list.filter((a) => a.request || a.emergency).length;
    this.rail.replaceChildren(h('span', { class: 'arr', title: 'Arrivals' }, `↓${arr}`), h('span', { class: 'dep', title: 'Departures' }, `↑${list.length - arr}`), req ? h('span', { class: 'req', title: 'Needs attention' }, `●${req}`) : '');

    const cmp = (a: Aircraft, b: Aircraft): number => {
      if (this.sort === 'cs') return a.callsign.localeCompare(b.callsign);
      if (this.sort === 'time') return a.spawnT - b.spawnT;
      // Priority: emergencies, then longest waiting request, then altitude for arrivals (lowest first).
      const pa = a.emergency ? 0 : a.request ? 1 : 2;
      const pb = b.emergency ? 0 : b.request ? 1 : 2;
      if (pa !== pb) return pa - pb;
      if (pa === 1) return a.requestT - b.requestT;
      if (!a.onGround && !b.onGround) return a.altFt - b.altFt;
      return a.spawnT - b.spawnT;
    };
    const grouped = new Map<Bay, Aircraft[]>(BAYS.map((b) => [b, []]));
    for (const a of list) if (this.passes(a)) grouped.get(this.bayOf(a))!.push(a);
    const live = new Set<string>();
    const order: string[] = [];
    let shown = 0;
    for (const b of BAYS) {
      const items = grouped.get(b)!.sort(cmp);
      const bay = this.bays.get(b)!;
      bay.el.classList.toggle('hidden', !items.length);
      bay.n.textContent = String(items.length);
      shown += items.length;
      const nodes: HTMLElement[] = [];
      for (const a of items) {
        live.add(a.id);
        if (!this.closed.has(b)) order.push(a.id);
        nodes.push(this.strip(w, a, a.id === selected));
      }
      // Re-append only when the order changed, to keep hover / focus stable.
      const cur = [...bay.body.children];
      if (this.force || cur.length !== nodes.length || cur.some((c, i) => c !== nodes[i])) bay.body.replaceChildren(...nodes);
    }
    for (const id of [...this.strips.keys()]) if (!live.has(id)) this.strips.delete(id);
    this.empty.classList.toggle('hidden', shown > 0);
    this.empty.lastChild!.textContent = list.length ? 'No strips match this filter.' : 'No active traffic.';
    this.orderIds = order;
    this.force = false;
  }

  private strip(w: World, a: Aircraft, sel: boolean): HTMLElement {
    const lvl = w.conflictLevel(a.id);
    const wait = a.request ? w.t - a.requestT : 0;
    const altNow = a.onGround ? 'GND' : alt(a.altFt);
    const trend = a.onGround ? '' : a.vs > 300 ? '↑' : a.vs < -300 ? '↓' : '';
    const asg = !a.onGround && Math.abs(a.asgAlt - a.altFt) > 60 ? `→${alt(a.asgAlt)}` : '';
    const route = a.kind === 'arr'
      ? a.onGround ? (a.gate ? `STAND ${a.gate}` : a.rwyEnd ? `RWY ${a.rwyEnd}` : '') : a.appr ? `ILS ${a.appr}${a.landClr ? ' ✓' : ''}` : a.hold ? `HOLD ${a.hold.fix}` : a.direct ? `DCT ${a.direct}` : a.route[0] ?? ''
      : a.onGround ? `${a.rwyEnd ? `RWY ${a.rwyEnd}` : ''}${a.gate ? ` ${a.gate}` : ''}` : a.exitFix ? `→ ${a.exitFix}` : '';
    const sub = a.onGround ? `${Math.round(Math.abs(a.gsKt))} kt` : `${Math.round(a.ias)}kt·${fmtHeading(a.hdg)}`;
    const status = a.request ? REQUEST_SHORT[a.request] : a.holdPos ? 'HOLD POS' : PHASE_LABEL[a.phase] ?? a.phase;
    const cls = ['strip', a.kind, sel ? 'sel' : '', a.request ? 'req' : '', a.emergency ? 'emerg' : '', lvl ? `c-${lvl}` : ''].join(' ');
    const key = `${cls}|${altNow}${trend}|${asg}|${route}|${sub}|${status}|${Math.floor(wait)}|${a.emergency}`;
    const cached = this.strips.get(a.id);
    if (cached && cached.key === key) return cached.el;
    const el = cached?.el ?? h('div', { role: 'option', tabindex: '-1', onclick: () => this.cb.select(a.id) });
    el.className = cls;
    el.setAttribute('aria-selected', String(sel));
    el.setAttribute('aria-label', `${a.displayCallsign}, ${a.kind === 'arr' ? 'arrival' : 'departure'}, ${altNow}, ${status}`);
    const wake = a.type.wake;
    el.replaceChildren(
      h('div', { class: 'c c1' },
        h('span', { class: 'cs' }, a.callsign),
        h('span', { class: 'ty' }, a.type.icao, wake === 'H' || wake === 'J' ? h('span', { class: 'wk' }, `/${wake}`) : `/${wake}`),
        h('span', { class: 'rg' }, a.registration),
      ),
      h('div', { class: 'c c2' },
        h('span', { class: 'alt' }, altNow, trend ? h('span', { class: 'tr' }, trend) : ''),
        h('span', { class: 'asg' }, asg || ' '),
        h('span', { class: 'sub' }, sub),
      ),
      h('div', { class: 'c c3' },
        a.emergency ? h('span', { class: 'em' }, `EMRG ${a.emergency}`) : h('span', { class: a.request ? 'rq' : 'ph' }, status),
        h('span', { class: 'sub' }, route || ' '),
        a.request ? h('span', { class: `wait${wait > 60 ? ' long' : ''}` }, `⏱ ${mmss(wait)}`) : h('span', { class: 'sub' }, a.kind === 'arr' ? 'ARR' : 'DEP'),
      ),
    );
    this.strips.set(a.id, { el, key });
    return el;
  }
}
