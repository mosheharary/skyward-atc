import { describe, expect, it } from 'vitest';
// @ts-expect-error node builtin without @types/node
import { appendFileSync } from 'node:fs';
import { World } from '../src/sim/world';
import type { SessionConfig } from '../src/sim/career';

function cfg(airport: string, runwayConfig: string, seed = 7): SessionConfig {
  return {
    mode: 'free', shiftId: null, airport, runwayConfig, arrivalsPerHour: 14, departuresPerHour: 12,
    weather: 'clear', startHour: 12, dayOfYear: 172, durationMin: null, emergencyRate: 0.05, initialParked: 0.5, seed,
  };
}

/** A simple robot controller that answers every request. */
function bot(w: World): void {
  for (const a of [...w.aircraft]) {
    const av = w.available(a);
    if (a.kind === 'arr' && !a.onGround && !a.appr && av.has('approach') && a.phase !== 'goaround') w.command(a.id, { kind: 'approach', runway: w.config.arrivals[0] });
    if (a.request === 'landing') w.command(a.id, { kind: 'land', runway: a.appr! });
    if (a.request === 'taxiGate') w.command(a.id, { kind: 'taxiGate' });
    if (a.request === 'pushback') w.command(a.id, { kind: 'pushback' });
    if (a.request === 'taxi') w.command(a.id, { kind: 'taxi', runway: w.config.departures[0] });
    if (a.request === 'crossing' && a.requestRwy && !w.runwayBlocked(w.airport.runwayById(a.requestRwy), a, 45)) w.command(a.id, { kind: 'cross' });
    if (a.request === 'takeoff' && !w.runwayBlocked(w.airport.runwayOfEnd(a.rwyEnd!), a, 70)) w.command(a.id, { kind: 'takeoff' });
    if (av.has('handoff') && a.altFt - w.elev > 2500) w.command(a.id, { kind: 'handoff' });
  }
}

function run(w: World, minutes: number): void {
  for (let s = 0; s < minutes * 60; s += 2) {
    w.step(2);
    bot(w);
    w.events.length = 0;
  }
}

describe('world', () => {
  for (const [ap, rc] of [['HPX', 'west'], ['HPX', 'east'], ['LLBG', 'west'], ['LLBG', 'north'], ['KSFO', 'west'], ['KSFO', 'fog']] as const) {
    it(`${ap} ${rc}: traffic flows end to end`, () => {
      const w = new World(cfg(ap, rc));
      run(w, 50);
      const bad = w.scoreLog.filter((e) => e.kind !== 'bonus').map((e) => e.reason);
      appendFileSync('/tmp/world-stats.txt', [ap, rc, JSON.stringify(w.stats), 'score', w.score, 'aircraft', w.aircraft.length, '\n  ', [...new Set(bad)].slice(0, 12).join('\n   ')].join(' ') + '\n');
      expect(w.stats.landed).toBeGreaterThan(3);
      expect(w.stats.departed).toBeGreaterThan(3);
      expect(w.stats.parked).toBeGreaterThan(2);
    });
  }

  it('snapshot round-trip continues identically', () => {
    const w = new World(cfg('HPX', 'west', 99));
    run(w, 12);
    const snap = JSON.parse(JSON.stringify(w.snapshot()));
    const w2 = new World(snap.cfg, snap);
    run(w, 6);
    run(w2, 6);
    expect(w2.t).toBeCloseTo(w.t, 6);
    expect(w2.aircraft.map((a) => a.callsign)).toEqual(w.aircraft.map((a) => a.callsign));
    expect(w2.score).toBe(w.score);
    const p1 = w.aircraft.map((a) => [a.x.toFixed(1), a.y.toFixed(1), a.phase]);
    const p2 = w2.aircraft.map((a) => [a.x.toFixed(1), a.y.toFixed(1), a.phase]);
    expect(p2).toEqual(p1);
  });
});
