// Toast notifications with a history centre, the floating score feed, the score breakdown, and a popover helper.

import type { ScoreEvent } from '../sim/simTypes';
import { h } from './dom';
import { icon } from './icons';
import { clock } from './prefs';

export type NoticeLevel = 'info' | 'warn' | 'good' | 'bad';

const LEVEL_ICON: Record<NoticeLevel, string> = { info: 'info', warn: 'alert', good: 'check', bad: 'emergency' };

interface NoticeEntry {
  t: number;
  text: string;
  level: NoticeLevel;
}

/** Opens `el` as a popover inside `host`, closing it on outside click or Escape. Returns false if it was already open (and is now closed). */
export function togglePopover(host: HTMLElement, el: HTMLElement, anchor?: HTMLElement): boolean {
  if (el.isConnected) {
    el.remove();
    return false;
  }
  host.append(el);
  const close = (e: Event): void => {
    if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node) && !anchor?.contains(e.target as Node)) {
      el.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', close, true);
      if (e instanceof KeyboardEvent) e.stopPropagation();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
  }, 0);
  return true;
}

export class Notifier {
  readonly toasts: HTMLElement;
  private readonly history: NoticeEntry[] = [];
  unread = 0;
  onChange: (() => void) | null = null;
  private center: HTMLElement | null = null;

  constructor() {
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  }

  push(text: string, level: NoticeLevel, simTime: number): void {
    this.history.unshift({ t: simTime, text, level });
    if (this.history.length > 60) this.history.pop();
    if (!this.center?.isConnected) this.unread++;
    else this.renderCenter();
    const life = level === 'bad' ? 7000 : 5000;
    const bar = h('div', { class: 'ntf-p' });
    const el = h('div', { class: `ntf ${level}` }, icon(LEVEL_ICON[level]), h('span', { class: 'ntf-x' }, text), bar);
    el.addEventListener('click', () => el.remove());
    this.toasts.append(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: life, easing: 'linear', fill: 'forwards' });
    setTimeout(() => el.classList.add('fade'), life);
    setTimeout(() => el.remove(), life + 700);
    this.onChange?.();
  }

  /** Toggle the notification centre popover inside `host`. */
  toggleCenter(host: HTMLElement, anchor: HTMLElement): void {
    this.center ??= h('div', { class: 'popover notif-center', role: 'dialog', 'aria-label': 'Notifications' });
    if (togglePopover(host, this.center, anchor)) {
      this.unread = 0;
      this.renderCenter();
      this.onChange?.();
    }
  }

  private renderCenter(): void {
    const c = this.center;
    if (!c) return;
    c.replaceChildren(
      h('h4', null, `Notifications · ${this.history.length}`,
        h('button', { class: 'btn sm ghost', onclick: () => { this.history.length = 0; this.renderCenter(); } }, 'Clear')),
      h('div', { class: 'nc-list' },
        ...(this.history.length
          ? this.history.map((n) => h('div', { class: `nc-item ${n.level}` }, icon(LEVEL_ICON[n.level]), h('span', null, n.text), h('time', null, clock(n.t, true))))
          : [h('div', { class: 'nc-empty' }, 'No notifications yet.')]),
      ),
    );
  }
}

/** Floating "+40 landed and vacated" feed in the corner of the main view. */
export class ScoreFeed {
  readonly el = h('div', { class: 'score-feed', 'aria-hidden': 'true' });

  add(ev: ScoreEvent): void {
    const el = h('div', { class: `sf ${ev.points >= 0 ? 'pos' : 'neg'}` }, h('b', null, `${ev.points > 0 ? '+' : ''}${ev.points}`), ` ${ev.reason}`);
    this.el.prepend(el);
    while (this.el.children.length > 5) this.el.lastElementChild?.remove();
    setTimeout(() => el.classList.add('fade'), 6000);
    setTimeout(() => el.remove(), 7000);
  }
}

const KIND_LABEL: Record<string, string> = {
  separation: 'Loss of separation', wake: 'Wake turbulence', runwayIncursion: 'Runway incursions', tcas: 'TCAS advisories',
  goAround: 'Go-arounds', unstable: 'Unstable approaches', wrongExit: 'Wrong exit', exitAltitude: 'Poor departure exits',
  leftAirspace: 'Left the airspace', lowAltitude: 'Below MVA', delay: 'Pilots kept waiting', emergencyDelay: 'Emergency delays', fuel: 'Fuel diversions',
};

export function scoreCategory(ev: ScoreEvent): string {
  if (ev.kind !== 'bonus') return KIND_LABEL[ev.kind] ?? ev.kind;
  const r = ev.reason;
  if (r.includes('landed')) return 'Landings';
  if (r.includes('on stand')) return 'Arrivals parked';
  if (r.includes('departed')) return 'Departures handed off';
  if (r.includes('emergency')) return 'Emergencies handled';
  return 'Bonuses';
}

export interface ScoreLine {
  label: string;
  points: number;
  count: number;
}

export function scoreBreakdown(log: readonly ScoreEvent[]): { lines: ScoreLine[]; gained: number; lost: number } {
  const map = new Map<string, ScoreLine>();
  let gained = 0;
  let lost = 0;
  for (const ev of log) {
    const label = scoreCategory(ev);
    const l = map.get(label) ?? { label, points: 0, count: 0 };
    l.points += ev.points;
    l.count++;
    map.set(label, l);
    if (ev.points >= 0) gained += ev.points;
    else lost += ev.points;
  }
  const lines = [...map.values()].sort((a, b) => b.points - a.points);
  return { lines, gained, lost };
}

/** Renders a breakdown as bar rows (used by the score popover and the shift results). */
export function breakdownView(log: readonly ScoreEvent[]): HTMLElement {
  const { lines } = scoreBreakdown(log);
  const max = Math.max(1, ...lines.map((l) => Math.abs(l.points)));
  return h('div', { class: 'breakdown' },
    ...(lines.length
      ? lines.map((l) => h('div', { class: `bd-row ${l.points >= 0 ? 'pos' : 'neg'}` },
        h('span', null, l.label, ' ', h('small', null, `×${l.count}`)),
        h('div', { class: 'bd-bar' }, h('i', { style: `width:${Math.round((Math.abs(l.points) / max) * 100)}%` })),
        h('b', null, `${l.points > 0 ? '+' : ''}${l.points}`)))
      : [h('div', { class: 'nc-empty' }, 'No points scored yet.')]),
  );
}
