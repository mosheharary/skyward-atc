// Comms panel: frequency header, filterable radio transcript, resizable and collapsible.

import { h } from './dom';
import { icon } from './icons';
import { clock } from './prefs';

export interface CommsEntry {
  t: number;
  from: 'atc' | 'pilot';
  id: string;
  callsign: string;
  text: string;
  urgent: boolean;
  /** Which position transmitted / was addressed: approach, tower or ground. */
  pos: 'APP' | 'TWR' | 'GND';
}

type Filter = 'all' | 'atc' | 'pilot' | 'sel' | 'urgent';

export interface CommsCallbacks {
  select(id: string): void;
  resized(px: number): void;
  collapsed(c: boolean): void;
}

/** Deterministic plausible frequencies for an airport. */
function freqs(icao: string): Record<CommsEntry['pos'], string> {
  let s = 0;
  for (const c of icao) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const f = (base: number, span: number, k: number): string => (base + (((s >> k) % span) * 0.025)).toFixed(3).replace(/0$/, '');
  return { APP: f(119.0, 40, 1), TWR: f(118.1, 36, 5), GND: f(121.6, 16, 9) };
}

export class CommsPanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly newPill: HTMLElement;
  private readonly colBtn: HTMLElement;
  private readonly chips: Record<CommsEntry['pos'], HTMLElement>;
  private readonly entries: CommsEntry[] = [];
  private filter: Filter = 'all';
  private selected: string | null = null;
  private stick = true;
  private collapsed: boolean;
  private txT: Record<string, number> = {};

  constructor(icao: string, private readonly cb: CommsCallbacks, opts: { height: number; collapsed: boolean }) {
    const fq = freqs(icao);
    const chip = (p: CommsEntry['pos']): HTMLElement => h('span', { class: 'freq', title: `${p === 'APP' ? 'Approach' : p === 'TWR' ? 'Tower' : 'Ground'} ${fq[p]}` }, h('b', null, p), fq[p]);
    this.chips = { APP: chip('APP'), TWR: chip('TWR'), GND: chip('GND') };
    const seg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Filter transmissions' });
    const FILTERS: [Filter, string][] = [['all', 'All'], ['atc', 'ATC'], ['pilot', 'Pilots'], ['sel', 'Selected'], ['urgent', 'Urgent']];
    for (const [f, label] of FILTERS) {
      seg.append(h('button', {
        class: f === 'all' ? 'active' : '', 'data-f': f, role: 'tab', onclick: () => {
          this.filter = f;
          for (const b of seg.children) b.classList.toggle('active', (b as HTMLElement).dataset.f === f);
          this.render();
        },
      }, label));
    }
    this.collapsed = opts.collapsed;
    const colBtn = h('button', { class: 'mini', title: 'Collapse / expand comms', 'aria-label': 'Toggle comms panel', onclick: () => this.setCollapsed(!this.collapsed) }, icon(this.collapsed ? 'chevron' : 'minus'));
    this.body = h('div', { class: 'comms-body', role: 'log', 'aria-live': 'polite', 'aria-label': 'Radio transcript' });
    this.newPill = h('button', { class: 'comms-new hidden', onclick: () => this.scrollEnd() }, '↓ New transmissions');
    const handle = h('div', { class: 'comms-resize', title: 'Drag to resize' });
    this.el = h('section', { class: `comms${this.collapsed ? ' collapsed' : ''}`, 'aria-label': 'Comms' },
      handle,
      h('div', { class: 'comms-head' },
        h('span', { class: 'comms-title' }, icon('radio'), 'Comms'),
        h('div', { class: 'freqs' }, this.chips.APP, this.chips.TWR, this.chips.GND),
        h('div', { class: 'spacer' }),
        seg,
        colBtn,
      ),
      this.body,
      this.newPill,
    );
    this.el.style.setProperty('--comms-h', `${opts.height}px`);
    this.body.addEventListener('scroll', () => {
      this.stick = this.body.scrollTop + this.body.clientHeight >= this.body.scrollHeight - 12;
      if (this.stick) this.newPill.classList.add('hidden');
    });
    // Drag to resize (upwards grows).
    handle.addEventListener('pointerdown', (e) => {
      if (this.collapsed) return;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('active');
      const y0 = e.clientY;
      const h0 = this.el.getBoundingClientRect().height;
      const move = (ev: PointerEvent): void => {
        const px = Math.round(Math.min(window.innerHeight * 0.6, Math.max(70, h0 + (y0 - ev.clientY))));
        this.el.style.setProperty('--comms-h', `${px}px`);
      };
      const up = (): void => {
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.cb.resized(Math.round(this.el.getBoundingClientRect().height));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    this.colBtn = colBtn;
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.colBtn.replaceChildren(icon(c ? 'chevron' : 'minus'));
    this.cb.collapsed(c);
    if (!c) this.scrollEnd();
  }

  setSelected(id: string | null): void {
    if (id === this.selected) return;
    this.selected = id;
    if (this.filter === 'sel') this.render();
    else for (const el of this.body.children) (el as HTMLElement).classList.toggle('sel-ac', !!id && (el as HTMLElement).dataset.id === id);
  }

  /** Recent entries for one aircraft, newest last. */
  history(id: string, n = 4): CommsEntry[] {
    const out: CommsEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < n; i--) if (this.entries[i].id === id) out.push(this.entries[i]);
    return out.reverse();
  }

  add(e: CommsEntry, replay = false): void {
    this.entries.push(e);
    if (this.entries.length > 250) this.entries.shift();
    if (!replay) this.transmit(e.pos, e.from);
    if (!this.passes(e)) return;
    this.body.querySelector('.comms-empty')?.remove();
    this.body.append(this.line(e));
    while (this.body.children.length > 200) this.body.firstElementChild?.remove();
    if (this.stick) this.scrollEnd();
    else this.newPill.classList.remove('hidden');
  }

  private transmit(pos: CommsEntry['pos'], from: CommsEntry['from']): void {
    const c = this.chips[pos];
    c.classList.add('tx');
    c.title = `${from === 'atc' ? 'Transmitting' : 'Receiving'} on ${c.textContent}`;
    clearTimeout(this.txT[pos]);
    this.txT[pos] = window.setTimeout(() => c.classList.remove('tx'), 2200);
  }

  private passes(e: CommsEntry): boolean {
    switch (this.filter) {
      case 'atc': return e.from === 'atc';
      case 'pilot': return e.from === 'pilot';
      case 'sel': return !!this.selected && e.id === this.selected;
      case 'urgent': return e.urgent;
      default: return true;
    }
  }

  private line(e: CommsEntry): HTMLElement {
    return h('div', {
      class: `rl ${e.from}${e.urgent ? ' urgent' : ''}${this.selected && e.id === this.selected ? ' sel-ac' : ''}`, 'data-id': e.id,
      title: `${e.pos} · click to select ${e.callsign}`, onclick: () => this.cb.select(e.id),
    },
    h('span', { class: 'rl-t' }, clock(e.t, true)),
    h('span', { class: 'rl-f' }, e.from === 'atc' ? e.pos : 'PLT'),
    h('span', { class: 'rl-cs' }, e.callsign),
    h('span', { class: 'rl-x' }, e.text),
    );
  }

  private render(): void {
    const list = this.entries.filter((e) => this.passes(e)).slice(-200);
    this.body.replaceChildren(...(list.length ? list.map((e) => this.line(e)) : [h('div', { class: 'comms-empty' }, this.filter === 'sel' && !this.selected ? 'Select an aircraft to see its transmissions.' : 'No transmissions.')]));
    this.scrollEnd();
  }

  private scrollEnd(): void {
    this.body.scrollTop = this.body.scrollHeight;
    this.stick = true;
    this.newPill.classList.add('hidden');
  }
}
