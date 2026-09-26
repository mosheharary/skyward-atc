// Engines: turbofan nacelles (lip, inlet, fan, spinner, reverser sleeve, core, plug) and turboprops.
import * as THREE from 'three';
import type { EngineDef, ShapeDef } from './shapes';
import type { FuselageModel } from './fuselage';
import { smooth } from './fuselage';
import type { WingModel } from './wing';
import { buildRearPylon, buildWingPylon } from './wing';
import { annulus, lathe, merge, orient, surface } from './geom';

export interface EnginePos {
  x: number;
  y: number;
  zFront: number;
  side: 1 | -1;
}

export interface SpinPart {
  /** Geometry relative to `center`; rotates about local +Z. */
  blades: THREE.BufferGeometry;
  spinner: THREE.BufferGeometry;
  center: THREE.Vector3;
}

export interface PropPart extends SpinPart {
  blur: THREE.BufferGeometry;
  radius: number;
}

export interface EngineBuild {
  paint: THREE.BufferGeometry;
  sleeve: THREE.BufferGeometry | null;
  sleeveTravel: number;
  lip: THREE.BufferGeometry | null;
  inlet: THREE.BufferGeometry | null;
  dark: THREE.BufferGeometry;
  pylons: THREE.BufferGeometry;
  fans: SpinPart[];
  props: PropPart[];
  positions: EnginePos[];
}

function enginePositions(shape: ShapeDef, fm: FuselageModel, wm: WingModel): EnginePos[] {
  const e = shape.engine;
  const out: EnginePos[] = [];
  if (e.mount === 'wing') {
    for (const f of e.spanFracs) {
      const xe = f * wm.b;
      const zLE = wm.leZ(xe);
      const yls = wm.lowerY(xe, 0.25);
      const ye = yls - e.drop - e.radius;
      const zFront = zLE - e.forward * e.length;
      for (const side of [1, -1] as const) out.push({ x: side * xe, y: ye, zFront, side });
    }
  } else {
    const zFront = fm.zNose + (e.rearFront ?? fm.L * 0.7);
    const zc = zFront + e.length * 0.45;
    const yc = fm.f.centerY + (e.rearYOff ?? 0.4);
    const hw = fm.halfWidthAtY(fm.dAtZ(zc), yc);
    const gap = 0.3 * e.radius + 0.18;
    for (const side of [1, -1] as const) out.push({ x: side * (hw + gap + e.radius), y: yc, zFront, side });
  }
  return out;
}

/** Outer radius of a turbofan cowl at global t (0 = lip, t_noz = fan nozzle). */
function cowlR(t: number, R: number, tc: number, tNoz: number): number {
  if (t <= 0.32) {
    const q = Math.min(1, Math.max(0, (t - tc) / (0.32 - tc)));
    return R * (0.94 + 0.06 * Math.sin((q * Math.PI) / 2));
  }
  const q = Math.min(1, (t - 0.32) / (tNoz - 0.32));
  return R - (R - 0.8 * R) * Math.pow(q, 1.7);
}

function buildTurbofan(e: EngineDef, pos: EnginePos, spinnerStyle: 'silver' | 'dark') {
  const R = e.radius;
  const len = e.length;
  const cx = pos.x;
  const cy = pos.y;
  const z0 = pos.zFront;
  const tNoz = 0.64;
  const tSplit = 0.42;
  const rho = 0.04 * R;
  const tc = rho / len;
  const rc = 0.9 * R;
  const rIn = rc - rho;
  const tFan = 0.16;
  const fanR = e.fanRadius;
  const Z = (t: number) => z0 + t * len;
  const flat = (phi: number, tg: number): [number, number] => {
    if (!e.flatBottom || Math.sin(phi) >= 0) return [1, 1];
    return [1, 1 - 0.16 * (1 - smooth(0.2, 0.75, tg)) * Math.pow(Math.abs(Math.sin(phi)), 1.5)];
  };
  const seg = (ta: number, tb: number, rf: (t: number) => number, nT: number, inward = false) =>
    lathe((u) => [Z(ta + (tb - ta) * u), rf(ta + (tb - ta) * u)], {
      cx,
      cy,
      nT,
      nPhi: 40,
      inward,
      scale: (phi, u) => flat(phi, ta + (tb - ta) * u),
      uv: (u, v, out) => out.set(v, ta + (tb - ta) * u),
    });

  // lip (half torus), oriented away from the tube centre
  const lipG = surface(
    (u, v, out) => {
      const psi = u * Math.PI;
      const t = tc - (rho / len) * Math.sin(psi);
      const r = rc - rho * Math.cos(psi);
      const phi = v * Math.PI * 2;
      const [sx, sy] = flat(phi, t);
      out.set(cx + Math.cos(phi) * r * sx, cy + Math.sin(phi) * r * sy, Z(t));
    },
    10,
    40,
  );
  orient(lipG, (p, out) => {
    const phi = Math.atan2(p.y - cy, p.x - cx);
    out.set(p.x - (cx + Math.cos(phi) * rc), p.y - (cy + Math.sin(phi) * rc), p.z - Z(tc));
  });

  const inlet = seg(tc, tFan + 0.02, (t) => rIn + (fanR * 1.01 - rIn) * smooth(tc, tFan, t), 6, true);
  const outerFront = seg(tc, tSplit, (t) => cowlR(t, R, tc, tNoz), 14);

  // translating sleeve with optional chevrons
  const nChev = 16;
  const tEnd = (phi: number) => {
    if (!e.chevrons) return tNoz;
    const f = (phi / (Math.PI * 2)) * nChev;
    const tri = Math.abs((f % 1) - 0.5) * 2;
    return tNoz - 0.045 * tri;
  };
  const sleeve = orient(
    surface(
      (u, v, out) => {
        const phi = v * Math.PI * 2;
        const t = tSplit + (tEnd(phi) - tSplit) * u;
        const r = cowlR(t, R, tc, tNoz);
        const [sx, sy] = flat(phi, t);
        out.set(cx + Math.cos(phi) * r * sx, cy + Math.sin(phi) * r * sy, Z(t));
      },
      10,
      e.chevrons ? nChev * 6 : 40,
      { uv: (u, v, out) => out.set(v, tSplit + (tNoz - tSplit) * u) },
    ),
    (p, out) => out.set(p.x - cx, p.y - cy, 0),
  );
  // inner lining of the sleeve (visible at the nozzle)
  const sleeveInner = orient(
    surface(
      (u, v, out) => {
        const phi = v * Math.PI * 2;
        const t = tNoz - 0.12 + (tEnd(phi) - (tNoz - 0.12)) * u;
        const r = cowlR(t, R, tc, tNoz) - 0.03 * R;
        out.set(cx + Math.cos(phi) * r, cy + Math.sin(phi) * r, Z(t));
      },
      3,
      e.chevrons ? nChev * 6 : 40,
    ),
    (p, out) => out.set(-(p.x - cx), -(p.y - cy), 0),
  );

  const dark: THREE.BufferGeometry[] = [];
  // cascade ring under the sleeve (revealed by reverse thrust)
  dark.push(seg(tSplit - 0.02, tSplit + 0.13, (t) => cowlR(t, R, tc, tNoz) * 0.965, 3));
  // bypass nozzle face
  dark.push(annulus(cx, cy, Z(tNoz - 0.1), 0.56 * R, 0.8 * R, 40, 1));
  // core cowl
  const tCore = 0.9;
  const core = seg(tNoz - 0.1, tCore, (t) => 0.57 * R - 0.17 * R * ((t - (tNoz - 0.1)) / (tCore - tNoz + 0.1)), 8);
  // core nozzle face and plug
  dark.push(annulus(cx, cy, Z(tCore), 0.26 * R, 0.4 * R, 32, 1));
  const plug = seg(tCore - 0.02, 1.0, (t) => 0.27 * R * Math.pow(Math.max(0, (1 - t) / (1 - tCore + 0.02)), 0.8) + 0.004, 8);

  // fan: blades + hub, rotates about the nacelle axis
  const center = new THREE.Vector3(cx, cy, Z(tFan));
  const hubR = 0.3 * fanR;
  const bladeParts: THREE.BufferGeometry[] = [];
  const N = e.blades;
  for (let k = 0; k < N; k++) {
    const phiK = (k / N) * Math.PI * 2;
    const g = surface(
      (u, v, out) => {
        const r = hubR * 0.95 + (fanR * 0.985 - hubR * 0.95) * u;
        const ang = phiK + (v - 0.5) * ((Math.PI * 2) / N) * (0.78 + 0.1 * u);
        const depth = 0.16 * fanR * (1.25 - 0.7 * u);
        out.set(Math.cos(ang) * r, Math.sin(ang) * r, (v - 0.5) * depth - 0.02 * fanR * u);
      },
      5,
      3,
    );
    bladeParts.push(g);
  }
  bladeParts.push(annulus(0, 0, 0.06 * fanR, 0, fanR * 0.99, 32, -1));
  const spinLen = 1.25 * hubR;
  const spinner = lathe(
    (t) => [-spinLen * (1 - t) - 0.02, hubR * Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t))) + 0.002],
    { cx: 0, cy: 0, nT: 12, nPhi: 28 },
  );
  void spinnerStyle;

  return {
    paint: outerFront,
    sleeve: merge([sleeve]),
    sleeveInnerDark: sleeveInner,
    lip: lipG,
    inlet,
    dark: merge([...dark, core, plug]),
    fan: { blades: merge(bladeParts), spinner, center } as SpinPart,
  };
}

function buildTurboprop(e: EngineDef, pos: EnginePos) {
  const R = e.radius;
  const len = e.length;
  const cx = pos.x;
  const cy = pos.y;
  const z0 = pos.zFront;
  const Z = (t: number) => z0 + t * len;
  const tSb = 0.07;
  const rBody = (t: number) => {
    if (t < 0.22) return R * (0.44 + 0.56 * Math.sin(((t - tSb) / (0.22 - tSb)) * (Math.PI / 2)));
    if (t < 0.62) return R;
    return R * (1 - 0.68 * Math.pow((t - 0.62) / 0.38, 1.4));
  };
  const body = lathe((u) => {
    const t = tSb + (1 - tSb) * u;
    return [Z(t), Math.max(0.02, rBody(t))];
  }, { cx, cy, nT: 30, nPhi: 32, scale: (phi) => [1, Math.sin(phi) < 0 ? 1.12 : 1], uv: (u, v, out) => out.set(v, u) });
  // exhaust stub (dark) on the outboard side
  const ex = lathe((u) => [Z(0.46 + 0.1 * u), 0.14 * R], { cx: cx + pos.side * R * 0.82, cy: cy + R * 0.1, nT: 2, nPhi: 12 });
  const center = new THREE.Vector3(cx, cy, Z(tSb) + 0.02);
  const spinLen = 0.07 * len + 0.25;
  const spinner = lathe(
    (t) => [-spinLen * (1 - t), 0.44 * R * Math.pow(Math.max(0, 1 - (1 - t) * (1 - t)), 0.55) + 0.002],
    { cx: 0, cy: 0, nT: 14, nPhi: 24 },
  );
  const Rp = e.propRadius ?? 1.9;
  const blades: THREE.BufferGeometry[] = [];
  for (let k = 0; k < e.blades; k++) {
    const phiK = (k / e.blades) * Math.PI * 2 + 0.3;
    const er = new THREE.Vector3(Math.cos(phiK), Math.sin(phiK), 0);
    const et = new THREE.Vector3(-Math.sin(phiK), Math.cos(phiK), 0);
    const g = surface(
      (u, v, out) => {
        const r = 0.2 + (Rp - 0.2) * u;
        const tipQ = Math.max(0, (u - 0.82) / 0.18);
        const c = (0.3 - 0.12 * u) * Math.sqrt(Math.max(0.02, 1 - tipQ * tipQ)) * Math.min(1, 0.55 + u * 3);
        const beta = ((42 - 30 * u) * Math.PI) / 180;
        const o = (v - 0.5) * c;
        out.set(er.x * r + (et.x * Math.cos(beta)) * o, er.y * r + (et.y * Math.cos(beta)) * o, -0.08 + Math.sin(beta) * o);
      },
      10,
      2,
    );
    blades.push(g);
  }
  const blur = annulus(0, 0, -0.08, 0.3, Rp, 48, -1);
  // blur disc UVs: radial coordinate in u
  const uv = blur.getAttribute('uv') as THREE.BufferAttribute;
  const p = blur.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i));
    uv.setXY(i, r / Rp, 0.5);
  }
  return {
    paint: body,
    dark: ex,
    prop: { blades: merge(blades), spinner, center, blur, radius: Rp } as PropPart,
  };
}

export function buildEngines(shape: ShapeDef, fm: FuselageModel, wm: WingModel): EngineBuild {
  const e = shape.engine;
  const positions = enginePositions(shape, fm, wm);
  const paint: THREE.BufferGeometry[] = [];
  const sleeves: THREE.BufferGeometry[] = [];
  const lips: THREE.BufferGeometry[] = [];
  const inlets: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const pylons: THREE.BufferGeometry[] = [];
  const fans: SpinPart[] = [];
  const props: PropPart[] = [];
  for (const pos of positions) {
    if (e.kind === 'fan') {
      const b = buildTurbofan(e, pos, shape.spinner);
      paint.push(b.paint);
      if (b.sleeve) sleeves.push(b.sleeve);
      dark.push(b.sleeveInnerDark);
      lips.push(b.lip);
      inlets.push(b.inlet);
      dark.push(b.dark);
      fans.push(b.fan);
    } else {
      const b = buildTurboprop(e, pos);
      paint.push(b.paint);
      dark.push(b.dark);
      props.push(b.prop);
    }
    if (e.mount === 'wing') {
      const xe = Math.abs(pos.x);
      const pyl = buildWingPylon(wm, e, xe, pos.y + e.radius, pos.zFront);
      if (pos.side < 0) {
        const pa = pyl.getAttribute('position') as THREE.BufferAttribute;
        const na = pyl.getAttribute('normal') as THREE.BufferAttribute;
        for (let i = 0; i < pa.count; i++) {
          pa.setX(i, -pa.getX(i));
          na.setX(i, -na.getX(i));
        }
        const idx = pyl.getIndex()!;
        for (let i = 0; i < idx.count; i += 3) {
          const t = idx.getX(i + 1);
          idx.setX(i + 1, idx.getX(i + 2));
          idx.setX(i + 2, t);
        }
      }
      if (e.kind === 'fan') pylons.push(pyl);
    } else {
      pylons.push(buildRearPylon(fm, pos.x, pos.y, pos.zFront, e.length, e.radius));
    }
  }
  return {
    paint: merge(paint),
    sleeve: sleeves.length ? merge(sleeves) : null,
    sleeveTravel: e.length * 0.12,
    lip: lips.length ? merge(lips) : null,
    inlet: inlets.length ? merge(inlets) : null,
    dark: merge(dark),
    pylons: merge(pylons),
    fans,
    props,
    positions,
  };
}
