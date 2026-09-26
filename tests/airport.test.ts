import { describe, expect, it } from 'vitest';
import { AIRPORTS } from '../src/sim/airports';
import { AirportModel } from '../src/sim/airportModel';

describe.each(AIRPORTS.map((a) => [a.id, a] as const))('airport %s', (_id, def) => {
  const m = new AirportModel(def);

  it('builds a connected taxi graph with holds', () => {
    expect(m.nodes.length).toBeGreaterThan(20);
    expect(m.nodes.some((n) => n.holdFor.length > 0)).toBe(true);
    // Every node reachable from the first gate spot (ignoring runway restrictions).
    const start = m.gates[0].spotNode;
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const eid of m.nodes[n].edges) {
        const o = m.otherNode(m.edges[eid], n);
        if (!seen.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      }
    }
    const unreachable = m.nodes.filter((n) => !seen.has(n.id));
    expect(unreachable.map((n) => `${n.id}@${n.x.toFixed(0)},${n.y.toFixed(0)}`)).toEqual([]);
  });

  it('has departure entries and exits for every configured runway end', () => {
    for (const cfg of def.runwayConfigs) {
      for (const e of cfg.departures) expect(m.departureEntries[e]?.length, `entry ${e}`).toBeGreaterThan(0);
      for (const e of cfg.arrivals) {
        expect(m.exits[e]?.length, `exits ${e}`).toBeGreaterThan(0);
        expect(m.ends[e].ils, `ILS ${e}`).toBe(true);
      }
    }
  });

  it('routes every gate to every departure runway and back from every exit', () => {
    for (const cfg of def.runwayConfigs) {
      for (const dep of cfg.departures) {
        const hold = m.departureEntries[dep][0].holdNode;
        for (const g of m.gates) {
          const r = m.route(g.spotNode, hold);
          expect(r, `gate ${g.id} -> ${dep}`).not.toBeNull();
        }
      }
      for (const arr of cfg.arrivals) {
        for (const ex of m.exits[arr]) {
          const walk = m.walkToHold(ex.junctionNode, ex.edge, m.ends[arr].runwayId);
          expect(walk, `exit walk ${arr}@${ex.along.toFixed(0)}`).not.toBeNull();
          const last = walk!.nodes[walk!.nodes.length - 1];
          const r = m.route(last, m.gates[3].spotNode, { avoidFirstNode: walk!.nodes[walk!.nodes.length - 2] });
          expect(r, `exit ${arr}@${ex.along.toFixed(0)} -> gate`).not.toBeNull();
        }
      }
    }
  });

  it('gives each gate a push-back spot close behind it', () => {
    for (const g of m.gates) {
      const n = m.nodes[g.spotNode];
      const d = Math.hypot(n.x - g.pos[0], n.y - g.pos[1]);
      expect(d, `gate ${g.id}`).toBeLessThan(270);
      expect(d, `gate ${g.id}`).toBeGreaterThan(15);
    }
  });

  it('prints a summary', () => {
    const holds = m.nodes.filter((n) => n.holdFor.length).length;
    const summary = Object.fromEntries(
      Object.keys(m.ends).map((e) => [e, { entries: m.departureEntries[e].length, exits: m.exits[e].map((x) => `${x.along.toFixed(0)}m/${x.angle.toFixed(0)}deg`) }]),
    );
    console.log(def.id, { nodes: m.nodes.length, edges: m.edges.length, holds, gates: m.gates.length }, JSON.stringify(summary));
  });
});
