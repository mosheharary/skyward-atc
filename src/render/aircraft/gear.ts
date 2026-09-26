// Landing gear legs, bogies and wheels.
import * as THREE from 'three';
import type { ShapeDef, WheelSet } from './shapes';
import type { FuselageModel } from './fuselage';
import type { WingModel } from './wing';
import { box, merge, normalize, strut } from './geom';

export interface AxleT {
  /** Axle centre relative to the leg pivot (or the steer group for nose gear). */
  center: THREE.Vector3;
  tires: THREE.BufferGeometry;
  hubs: THREE.BufferGeometry;
  r: number;
}

export interface LegT {
  kind: 'nose' | 'wing' | 'body';
  side: 1 | -1 | 0;
  pivot: THREE.Vector3;
  /** Geometry relative to the pivot. */
  paint: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  /** Nose gear: parts that steer (relative to pivot). */
  steerPaint: THREE.BufferGeometry | null;
  steerChrome: THREE.BufferGeometry | null;
  axles: AxleT[];
  legLength: number;
}

function wheelGeoms(r: number, xs: number[]): { tires: THREE.BufferGeometry; hubs: THREE.BufferGeometry } {
  const tires: THREE.BufferGeometry[] = [];
  const hubs: THREE.BufferGeometry[] = [];
  const tube = 0.3 * r;
  const width = 0.72 * r;
  for (const x of xs) {
    const t = new THREE.TorusGeometry(r - tube, tube, 12, 30);
    t.rotateY(Math.PI / 2);
    t.scale(width / (2 * tube), 1, 1);
    t.translate(x, 0, 0);
    tires.push(normalize(t));
    const h = new THREE.CylinderGeometry(0.6 * r, 0.6 * r, width * 0.78, 20, 1, false);
    h.rotateZ(Math.PI / 2);
    h.translate(x, 0, 0);
    hubs.push(normalize(h));
    // hub centre cap
    const cap = new THREE.CylinderGeometry(0.22 * r, 0.28 * r, width * 0.9, 12, 1, false);
    cap.rotateZ(Math.PI / 2);
    cap.translate(x, 0, 0);
    hubs.push(normalize(cap));
  }
  return { tires: merge(tires), hubs: merge(hubs) };
}

function legFor(ws: WheelSet, side: 1 | -1 | 0, fm: FuselageModel, wm: WingModel, shape: ShapeDef): LegT {
  const x = side * ws.x;
  let yA: number;
  if (ws.kind === 'wing') yA = wm.lowerY(Math.abs(x), 0.68) + 0.05;
  else if (ws.kind === 'body' && shape.wing.high) yA = fm.f.centerY - fm.H * 0.45;
  else yA = fm.bottomY(fm.dAtZ(ws.z)) + 0.25;
  const pivot = new THREE.Vector3(x, yA, ws.z);
  const r = ws.r;
  const L = yA - r; // pivot to axle centre
  const rs = Math.max(0.05, (ws.kind === 'nose' ? 0.12 : 0.15) * r);
  const paint: THREE.BufferGeometry[] = [];
  const chrome: THREE.BufferGeometry[] = [];
  const axles: AxleT[] = [];
  const bogie = ws.axles > 1;
  const bottom = new THREE.Vector3(0, -L + (bogie ? 0 : r * 0.15), 0);
  const upperEnd = new THREE.Vector3(0, -L * 0.52, 0);
  const wheelXs = ws.wheels === 2 ? [-ws.wheelSpacing / 2, ws.wheelSpacing / 2] : [0];

  const steerPaint: THREE.BufferGeometry[] = [];
  const steerChrome: THREE.BufferGeometry[] = [];
  const P = ws.kind === 'nose' ? steerPaint : paint;
  const C = ws.kind === 'nose' ? steerChrome : chrome;

  // main strut (upper cylinder) and chrome oleo
  paint.push(strut(new THREE.Vector3(0, 0.1, 0), upperEnd, rs, rs * 1.05, 12));
  C.push(strut(upperEnd.clone().add(new THREE.Vector3(0, 0.05, 0)), bottom, rs * 0.72, rs * 0.72, 12));
  // collar
  P.push(strut(upperEnd.clone().add(new THREE.Vector3(0, -0.02, 0)), upperEnd.clone().add(new THREE.Vector3(0, -0.12 * r, 0)), rs * 1.18, rs * 1.18, 12));
  // torque links (scissor)
  const tl0 = upperEnd.clone().add(new THREE.Vector3(0, -0.1 * r, -rs * 1.4));
  const tlm = new THREE.Vector3(0, (upperEnd.y + bottom.y) / 2, -rs * 2.6);
  const tl1 = bottom.clone().add(new THREE.Vector3(0, 0.2 * r, -rs * 1.3));
  P.push(strut(tl0, tlm, rs * 0.28, rs * 0.28, 6));
  P.push(strut(tlm, tl1, rs * 0.28, rs * 0.28, 6));
  if (ws.kind !== 'nose') {
    // side / drag brace towards the airframe
    const braceTop = new THREE.Vector3(-(side || 1) * L * 0.55, -0.05, 0.05);
    paint.push(strut(new THREE.Vector3(0, -L * 0.42, 0), braceTop, rs * 0.45, rs * 0.45, 8));
    const drag = new THREE.Vector3(0, -0.05, -L * 0.45);
    paint.push(strut(new THREE.Vector3(0, -L * 0.36, 0), drag, rs * 0.4, rs * 0.4, 8));
  } else {
    // nose drag brace (forward)
    paint.push(strut(new THREE.Vector3(0, -L * 0.4, 0), new THREE.Vector3(0, -0.05, -L * 0.5), rs * 0.45, rs * 0.45, 8));
  }

  if (bogie) {
    const zs: number[] = [];
    for (let k = 0; k < ws.axles; k++) zs.push((k - (ws.axles - 1) / 2) * ws.axleSpacing);
    const beamLen = (ws.axles - 1) * ws.axleSpacing + r * 0.6;
    paint.push(box(rs * 1.6, rs * 1.6, beamLen, new THREE.Matrix4().makeTranslation(0, -L + 0.02, 0)));
    for (const z of zs) {
      const c = new THREE.Vector3(0, -L, z);
      chrome.push(strut(new THREE.Vector3(-ws.wheelSpacing / 2, 0, 0).add(c), new THREE.Vector3(ws.wheelSpacing / 2, 0, 0).add(c), rs * 0.4, rs * 0.4, 8));
      const w = wheelGeoms(r, wheelXs);
      axles.push({ center: c, tires: w.tires, hubs: w.hubs, r });
    }
  } else {
    const c = new THREE.Vector3(0, -L, 0);
    if (wheelXs.length === 2) {
      C.push(strut(new THREE.Vector3(-ws.wheelSpacing / 2, 0, 0).add(c), new THREE.Vector3(ws.wheelSpacing / 2, 0, 0).add(c), rs * 0.45, rs * 0.45, 8));
    } else {
      // single wheel: fork
      P.push(box(rs * 0.5, r * 1.1, rs * 1.2, new THREE.Matrix4().makeTranslation(r * 0.45, -L + r * 0.45, 0)));
      P.push(box(rs * 0.5, r * 1.1, rs * 1.2, new THREE.Matrix4().makeTranslation(-r * 0.45, -L + r * 0.45, 0)));
      P.push(box(r * 0.95, rs * 0.6, rs * 1.2, new THREE.Matrix4().makeTranslation(0, -L + r, 0)));
    }
    const w = wheelGeoms(r, wheelXs);
    axles.push({ center: c, tires: w.tires, hubs: w.hubs, r });
  }
  return {
    kind: ws.kind,
    side,
    pivot,
    paint: merge(paint),
    chrome: merge(chrome.length ? chrome : [new THREE.BufferGeometry()]),
    steerPaint: steerPaint.length ? merge(steerPaint) : null,
    steerChrome: steerChrome.length ? merge(steerChrome) : null,
    axles,
    legLength: L,
  };
}

export function buildGear(shape: ShapeDef, fm: FuselageModel, wm: WingModel): LegT[] {
  const legs: LegT[] = [legFor(shape.gear.nose, 0, fm, wm, shape)];
  for (const m of shape.gear.mains) {
    legs.push(legFor(m, 1, fm, wm, shape));
    legs.push(legFor(m, -1, fm, wm, shape));
  }
  return legs;
}
