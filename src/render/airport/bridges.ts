// Jet bridges (passenger boarding bridges) as instanced parts. A bridge docks with the L1 door
// when its gate is occupied and swings back to its parked position when the gate is empty.

import * as THREE from 'three';
import type { GateInfo } from '../../sim/airportModel';
import type { Vec2 } from '../../sim/airports/types';
import type { SizeClass } from '../../sim/types';

/** Fuselage half width, nose-to-L1-door distance and door sill height per size class. */
const DOOR: Record<SizeClass, { half: number; aft: number; sill: number }> = {
  S: { half: 1.5, aft: 3.5, sill: 1.9 },
  M: { half: 2.0, aft: 5.8, sill: 3.3 },
  L: { half: 2.9, aft: 8.5, sill: 4.8 },
  H: { half: 3.3, aft: 9.5, sill: 5.4 },
};

const ROT_H = 4.4;

interface Bridge {
  gate: GateInfo;
  rot: THREE.Vector3;
  linkEnd: THREE.Vector3;
  docked: THREE.Vector3;
  parked: THREE.Vector3;
  /** 0 = parked, 1 = docked. */
  t: number;
  /** Direction the cab faces when docked (towards the aircraft), world. */
  faceDock: THREE.Vector3;
  faceParked: THREE.Vector3;
}

const w = (p: Vec2, h: number): THREE.Vector3 => new THREE.Vector3(p[0], h, -p[1]);

export class JetBridges {
  readonly group = new THREE.Group();
  private readonly bridges: Bridge[] = [];
  private readonly tunnel: THREE.InstancedMesh;
  private readonly tunnelInner: THREE.InstancedMesh;
  private readonly cab: THREE.InstancedMesh;
  private readonly rotunda: THREE.InstancedMesh;
  private readonly legs: THREE.InstancedMesh;
  private readonly link: THREE.InstancedMesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private dirty = true;

  constructor(gates: GateInfo[], metalMap: THREE.Texture | null) {
    for (const g of gates) {
      if (!g.jetBridge) continue;
      const h = (g.hdg * Math.PI) / 180;
      const f: Vec2 = [Math.sin(h), Math.cos(h)];
      const left: Vec2 = [-Math.cos(h), Math.sin(h)];
      const D = DOOR[g.size];
      const at = (fw: number, lf: number): Vec2 => [g.pos[0] + f[0] * fw + left[0] * lf, g.pos[1] + f[1] * fw + left[1] * lf];
      const rot = w(at(4, D.half + 11), 0);
      const docked = w(at(-D.aft, D.half + 1.1), D.sill);
      const parked = w(at(-1.5, D.half + 8.5), ROT_H - 0.6);
      const faceDock = new THREE.Vector3(-left[0], 0, left[1]);
      const faceParked = new THREE.Vector3(-left[0] - f[0] * 0.8, 0, left[1] + f[1] * 0.8).normalize();
      this.bridges.push({ gate: g, rot, linkEnd: w(at(16, D.half + 11), 0), docked, parked, t: 0, faceDock, faceParked });
    }
    const n = Math.max(1, this.bridges.length);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh => {
      this.geometries.push(geo);
      this.materials.push(mat);
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = this.bridges.length === 0 ? 0 : count;
      this.group.add(m);
      return m;
    };
    const skin = new THREE.MeshStandardMaterial({ color: 0xd4d7da, roughness: 0.45, metalness: 0.55, map: metalMap ?? null });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3b3f44, roughness: 0.7, metalness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x28323c, roughness: 0.1, metalness: 0.8, emissive: 0xffe0b0, emissiveIntensity: 0 });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0, 0.5);
    // Tunnel: unit box along +z (length), scaled per instance.
    this.tunnel = mk(box, skin, n);
    // Window strip slightly proud of the tunnel skin.
    const strip = new THREE.BoxGeometry(1.04, 0.3, 1);
    strip.translate(0, 0.12, 0.5);
    this.tunnelInner = mk(strip, glass, n);
    const cabGeo = new THREE.BoxGeometry(3.4, 3.0, 3.2);
    cabGeo.translate(0, 0, -1.3);
    this.cab = mk(cabGeo, skin, n);
    const rotGeo = new THREE.CylinderGeometry(2.3, 2.3, 3.2, 14);
    rotGeo.translate(0, ROT_H - 1.6, 0);
    const rotCol = new THREE.CylinderGeometry(0.7, 0.7, ROT_H - 3.2, 8);
    rotCol.translate(0, (ROT_H - 3.2) / 2, 0);
    const rotMerged = mergeSimple([rotGeo, rotCol]);
    this.rotunda = mk(rotMerged, skin, n);
    const legGeo = mergeSimple([
      new THREE.BoxGeometry(0.35, 1, 0.35).translate(-1.0, 0.5, 0),
      new THREE.BoxGeometry(0.35, 1, 0.35).translate(1.0, 0.5, 0),
      new THREE.BoxGeometry(2.8, 0.12, 0.8).translate(0, 0.06, 0),
    ]);
    this.legs = mk(legGeo, dark, n);
    this.link = mk(box.clone(), skin, n);
    this.materials.push(glass);
  }

  get count(): number {
    return this.bridges.length;
  }

  update(dt: number, occupied: ReadonlySet<string>, night: number): void {
    const rate = Math.min(1, dt * 0.18);
    for (const b of this.bridges) {
      const target = occupied.has(b.gate.id) ? 1 : 0;
      if (Math.abs(b.t - target) > 1e-3) {
        b.t += Math.sign(target - b.t) * Math.min(Math.abs(target - b.t), rate);
        this.dirty = true;
      }
    }
    (this.materials[this.materials.length - 1] as THREE.MeshStandardMaterial).emissiveIntensity = night * 1.4;
    if (this.dirty) this.layout();
  }

  /** Force docked state (e.g. when a scene loads with aircraft already parked). */
  snap(occupied: ReadonlySet<string>): void {
    for (const b of this.bridges) b.t = occupied.has(b.gate.id) ? 1 : 0;
    this.layout();
  }

  private layout(): void {
    this.dirty = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const end = new THREE.Vector3();
    const face = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);
    const Y = new THREE.Vector3(0, 1, 0);
    const start = new THREE.Vector3();
    this.bridges.forEach((b, i) => {
      const e = smooth(b.t);
      end.lerpVectors(b.parked, b.docked, e);
      face.lerpVectors(b.faceParked, b.faceDock, e).normalize();
      // Cab: rotated to face the aircraft.
      q.setFromUnitVectors(Z, face);
      m.compose(end, q, s.set(1, 1, 1));
      this.cab.setMatrixAt(i, m);
      // Tunnel from the rotunda to the back of the cab.
      start.set(b.rot.x, ROT_H - 1.5, b.rot.z);
      const back = p.copy(end).addScaledVector(face, -2.6);
      const dir = back.clone().sub(start);
      const L = dir.length();
      dir.normalize();
      q.setFromUnitVectors(Z, dir);
      m.compose(start, q, s.set(2.7, 2.9, L));
      this.tunnel.setMatrixAt(i, m);
      m.compose(start, q, s.set(2.7, 2.9, L));
      this.tunnelInner.setMatrixAt(i, m);
      // Drive unit at 70 % of the tunnel.
      const legPos = start.clone().addScaledVector(dir, L * 0.72);
      const legH = legPos.y - 1.45;
      const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
      q.setFromUnitVectors(Z, flat);
      m.compose(new THREE.Vector3(legPos.x, 0, legPos.z), q, s.set(1, 1, 1));
      const legScale = new THREE.Matrix4().makeScale(1, Math.max(0.5, legH), 1);
      m.multiply(legScale);
      this.legs.setMatrixAt(i, m);
      // Rotunda + fixed link towards the terminal.
      m.compose(b.rot, q.identity(), s.set(1, 1, 1));
      this.rotunda.setMatrixAt(i, m);
      const ld = b.linkEnd.clone().sub(b.rot);
      const ll = ld.length();
      ld.normalize();
      q.setFromUnitVectors(Z, ld);
      m.compose(new THREE.Vector3(b.rot.x, ROT_H - 1.5, b.rot.z), q, s.set(2.6, 2.9, ll));
      this.link.setMatrixAt(i, m);
      void Y;
    });
    for (const im of [this.tunnel, this.tunnelInner, this.cab, this.rotunda, this.legs, this.link]) im.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let off = 0;
  for (const g0 of geos) {
    const g = g0.index ? g0 : g0;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    const U = g.getAttribute('uv');
    for (let i = 0; i < P.count; i++) {
      pos.push(P.getX(i), P.getY(i), P.getZ(i));
      nor.push(N.getX(i), N.getY(i), N.getZ(i));
      uv.push(U ? U.getX(i) : 0, U ? U.getY(i) : 0);
    }
    const I = g.index;
    if (I) for (let i = 0; i < I.count; i++) idx.push(I.getX(i) + off);
    else for (let i = 0; i < P.count; i++) idx.push(i + off);
    off += P.count;
    g0.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  return out;
}
