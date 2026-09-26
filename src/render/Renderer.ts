// Main 3D renderer: owns the WebGL context, post-processing, cameras and the environment / airport / aircraft sub-renderers.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createEnvironment } from './environment';
import { createAirportRenderer } from './airport';
import { createAircraftRenderer } from './aircraft';
import type { IAircraftRenderer, IAirportRenderer, IEnvironment } from './contracts';
import type { QualityLevel } from '../sim/types';
import type { World } from '../sim/world';
import { DEG, FT, clamp, damp, simToWorld } from '../core/units';

export type CameraMode = 'tower' | 'orbit' | 'follow' | 'cockpit';

const PIXEL_RATIO: Record<QualityLevel, number> = { low: 0.75, medium: 1, high: 1.5, ultra: 2 };

interface Look {
  yaw: number;
  pitch: number;
  fov: number;
  dist: number;
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 1, 400000);
  mode: CameraMode = 'tower';
  quality: QualityLevel;

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private env: IEnvironment | null = null;
  private airport: IAirportRenderer | null = null;
  private aircraft: IAircraftRenderer | null = null;
  private world: World | null = null;
  private elev = 0;

  private readonly towerEye = new THREE.Vector3();
  private readonly orbitTarget = new THREE.Vector3();
  private readonly orbitHomePos = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly looks: Record<CameraMode, Look> = {
    tower: { yaw: 0, pitch: -9, fov: 55, dist: 0 },
    orbit: { yaw: 30, pitch: -24, fov: 50, dist: 3200 },
    follow: { yaw: 160, pitch: -10, fov: 55, dist: 90 },
    cockpit: { yaw: 0, pitch: -6, fov: 65, dist: 0 },
  };
  private followId: string | null = null;
  private readonly smoothPos = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly xyz = { x: 0, y: 0, z: 0 };
  private width = 1;
  private height = 1;
  private drag: { x: number; y: number; button: number; moved: number } | null = null;
  onPick: ((id: string | null) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, quality: QualityLevel) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO[quality]));

    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality === 'low' ? 0 : 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 1.0);
    this.bloom.enabled = quality !== 'low';
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.bindInput();
  }

  /** Build the 3D scene for the world's airport (replacing any previous one). */
  load(world: World): void {
    this.unload();
    this.world = world;
    const def = world.airport.def;
    this.elev = def.elevationFt;
    this.env = createEnvironment({ scene: this.scene, renderer: this.renderer, airport: def, quality: this.quality });
    this.airport = createAirportRenderer(this.scene, world.airport, this.quality);
    this.aircraft = createAircraftRenderer(this.scene, this.quality);
    const [tx, ty] = def.tower.pos;
    this.towerEye.set(tx, def.tower.eyeHeight, -ty);
    const [lx, ly] = def.tower.lookAt;
    const yaw = Math.atan2(-(lx - tx), ly - ty) / DEG;
    this.looks.tower.yaw = yaw;
    // Look down enough that the apron right below the cab clears the consoles, not just the runway.
    this.looks.tower.pitch = Math.min(-9, -Math.atan2(def.tower.eyeHeight, Math.hypot(lx - tx, ly - ty)) / DEG);
    this.looks.orbit.yaw = yaw + 20;
    this.orbitHomePos.set(lx, 0, -ly);
    this.orbitTarget.copy(this.orbitHomePos);
    this.followId = null;
    this.mode = 'tower';
  }

  unload(): void {
    this.aircraft?.dispose();
    this.airport?.dispose();
    this.env?.dispose();
    this.aircraft = null;
    this.airport = null;
    this.env = null;
    this.world = null;
    this.scene.clear();
  }

  setQuality(q: QualityLevel): void {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO[q]));
    this.bloom.enabled = q !== 'low';
    this.env?.setQuality(q);
    this.airport?.setQuality(q);
    this.aircraft?.setQuality(q);
    this.resize(this.width, this.height);
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: CameraMode, followId?: string | null): void {
    if (followId !== undefined) this.followId = followId;
    if ((mode === 'follow' || mode === 'cockpit') && !this.followId) mode = 'tower';
    this.mode = mode;
  }

  get following(): string | null {
    return this.followId;
  }

  /** Camera is in the glazed tower cab (muffled outside audio). */
  get indoor(): boolean {
    return this.mode === 'tower';
  }

  get nightFactor(): number {
    return this.env?.nightFactor ?? 0;
  }

  /** Project a sim position to CSS pixel coordinates, or null when behind the camera / off-screen. */
  project(x: number, y: number, altFt: number): { x: number; y: number; d: number } | null {
    simToWorld(x, y, altFt, this.elev, this.xyz);
    this.tmp.set(this.xyz.x, this.xyz.y, this.xyz.z);
    const d = this.tmp.distanceTo(this.camera.position);
    this.tmp.project(this.camera);
    if (this.tmp.z > 1 || this.tmp.z < -1) return null;
    const sx = (this.tmp.x * 0.5 + 0.5) * this.width;
    const sy = (-this.tmp.y * 0.5 + 0.5) * this.height;
    if (sx < -50 || sy < -50 || sx > this.width + 50 || sy > this.height + 50) return null;
    return { x: sx, y: sy, d };
  }

  /** Listener pose for the audio engine. */
  listener(): { position: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number }; up: { x: number; y: number; z: number } } {
    const f = this.camera.getWorldDirection(this.tmp2);
    const p = this.camera.position;
    return { position: { x: p.x, y: p.y, z: p.z }, forward: { x: f.x, y: f.y, z: f.z }, up: { x: 0, y: 1, z: 0 } };
  }

  frame(dt: number, selectedId: string | null): void {
    const w = this.world;
    if (!w || !this.env || !this.airport || !this.aircraft) return;
    this.updateCamera(dt);
    const occupied = new Set<string>();
    for (const a of w.aircraft) if (a.gate && (a.phase === 'parked' || a.phase === 'ready' || a.phase === 'parking')) occupied.add(a.gate);
    const active = new Set<string>();
    for (const e of [...w.arrivalEnds, ...w.departureEnds]) {
      const end = w.airport.ends[e];
      if (end) active.add(end.runwayId);
    }
    this.env.update({
      dt,
      simTime: w.t,
      timeOfDay: w.timeOfDay,
      dayOfYear: w.cfg.dayOfYear,
      weather: w.weather,
      camera: this.camera,
      focus: this.focus,
      shadowRadius: this.mode === 'orbit' ? clamp(this.looks.orbit.dist * 0.5, 800, 3000) : this.mode === 'tower' ? 1500 : 400,
    });
    // Bloom must only catch true emissives: the scene is lit in HDR and exposure varies with daylight.
    this.bloom.threshold = 2.4 / Math.max(0.2, this.renderer.toneMappingExposure);
    this.airport.update({
      dt,
      simTime: w.t,
      camera: this.camera,
      nightFactor: this.env.nightFactor,
      wetness: this.env.wetness,
      activeRunways: active,
      arrivalEnds: new Set(w.arrivalEnds),
      occupiedGates: occupied,
    });
    this.aircraft.setSelected(selectedId);
    this.aircraft.update(w.aircraft, { dt, simTime: w.t, camera: this.camera, nightFactor: this.env.nightFactor, fieldElevationFt: this.elev, quality: this.quality });
    this.composer.render(dt);
  }

  private aircraftWorld(id: string): THREE.Vector3 | null {
    const a = this.world?.byId(id);
    if (!a) return null;
    simToWorld(a.x, a.y, a.altFt, this.elev, this.xyz);
    return this.tmp.set(this.xyz.x, this.xyz.y, this.xyz.z);
  }

  private updateCamera(dt: number): void {
    const cam = this.camera;
    let mode = this.mode;
    const target = (mode === 'follow' || mode === 'cockpit') && this.followId ? this.aircraftWorld(this.followId) : null;
    if ((mode === 'follow' || mode === 'cockpit') && !target) {
      this.mode = mode = 'tower';
      this.followId = null;
    }
    const L = this.looks[mode];
    if (cam.fov !== L.fov) {
      cam.fov = L.fov;
      cam.updateProjectionMatrix();
    }
    if (mode === 'tower') {
      cam.position.copy(this.towerEye);
      this.euler.set(L.pitch * DEG, L.yaw * DEG, 0);
      cam.quaternion.setFromEuler(this.euler);
      cam.getWorldDirection(this.tmp2);
      this.focus.copy(cam.position).addScaledVector(this.tmp2, 1200).setY(0);
    } else if (mode === 'orbit') {
      this.euler.set(L.pitch * DEG, L.yaw * DEG, 0);
      this.quat.setFromEuler(this.euler);
      this.tmp2.set(0, 0, 1).applyQuaternion(this.quat);
      cam.position.copy(this.orbitTarget).addScaledVector(this.tmp2, L.dist);
      const minY = (this.env?.heightAt(cam.position.x, cam.position.z) ?? 0) + 15;
      if (cam.position.y < minY) cam.position.y = minY;
      cam.lookAt(this.orbitTarget);
      this.focus.copy(this.orbitTarget);
    } else if (mode === 'follow' && target) {
      if (this.smoothPos.distanceToSquared(target) > 250000) this.smoothPos.copy(target);
      else this.smoothPos.lerp(target, damp(12, dt));
      const a = this.world!.byId(this.followId!)!;
      const yaw = (-a.hdg + L.yaw) * DEG;
      this.euler.set(L.pitch * DEG, yaw, 0);
      this.quat.setFromEuler(this.euler);
      const r = L.dist * Math.max(0.5, a.type.length / 40);
      this.tmp2.set(0, 0, 1).applyQuaternion(this.quat);
      cam.position.copy(this.smoothPos).addScaledVector(this.tmp2, r);
      const ground = (this.env?.heightAt(cam.position.x, cam.position.z) ?? 0) + 3;
      if (cam.position.y < ground) cam.position.y = ground;
      this.tmp2.copy(this.smoothPos).setY(this.smoothPos.y + 4);
      cam.lookAt(this.tmp2);
      this.focus.copy(this.smoothPos);
    } else if (mode === 'cockpit' && target) {
      const a = this.world!.byId(this.followId!)!;
      const obj = this.aircraft?.getObject(a.id);
      const off = this.aircraft?.getCockpitOffset(a.typeId) ?? new THREE.Vector3(0, 4, -18);
      if (obj) {
        obj.updateMatrixWorld();
        cam.position.copy(off).applyMatrix4(obj.matrixWorld);
        obj.getWorldQuaternion(this.quat);
      } else {
        cam.position.copy(target).add(off);
        this.euler.set(a.pitch * DEG, -a.hdg * DEG, -a.bank * DEG);
        this.quat.setFromEuler(this.euler);
      }
      this.euler.set(L.pitch * DEG, L.yaw * DEG, 0);
      cam.quaternion.copy(this.quat).multiply(new THREE.Quaternion().setFromEuler(this.euler));
      this.focus.copy(cam.position).setY(0);
    }
    cam.near = mode === 'cockpit' ? 0.2 : mode === 'follow' ? 0.5 : 1;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /** Pan the orbit camera to a sim point (used when an aircraft is selected in orbit view). */
  /** Re-centre the orbit camera on the airport. */
  orbitHome(): void {
    this.orbitTarget.copy(this.orbitHomePos);
  }

  lookAtSim(x: number, y: number): void {
    this.orbitTarget.set(x, 0, -y);
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      this.drag = { x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const L = this.looks[this.mode];
      if (this.mode === 'orbit' && (d.button === 2 || e.shiftKey)) {
        // pan
        const s = L.dist * 0.0015;
        const yaw = L.yaw * DEG;
        this.orbitTarget.x += (-dx * Math.cos(yaw) - dy * Math.sin(yaw)) * s;
        this.orbitTarget.z += (dx * Math.sin(yaw) - dy * Math.cos(yaw)) * s;
        return;
      }
      const k = this.mode === 'tower' || this.mode === 'cockpit' ? L.fov / 400 : 0.3;
      const sign = this.mode === 'tower' || this.mode === 'cockpit' ? 1 : -1;
      L.yaw += dx * k * sign;
      L.pitch = clamp(L.pitch + dy * k * sign, this.mode === 'orbit' ? -89 : -80, this.mode === 'orbit' ? -3 : 60);
    });
    const end = (e: PointerEvent): void => {
      const d = this.drag;
      this.drag = null;
      if (d && d.moved < 6 && d.button === 0) this.pick(e.offsetX, e.offsetY);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => (this.drag = null));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const L = this.looks[this.mode];
        const f = Math.exp(e.deltaY * 0.001);
        if (this.mode === 'tower' || this.mode === 'cockpit') L.fov = clamp(L.fov * f, 4, 75);
        else L.dist = clamp(L.dist * f, this.mode === 'orbit' ? 150 : 25, this.mode === 'orbit' ? 60000 : 3000);
      },
      { passive: false },
    );
  }

  private pick(px: number, py: number): void {
    const w = this.world;
    if (!w) return;
    let best: string | null = null;
    let bestD = 40;
    for (const a of w.aircraft) {
      const s = this.project(a.x, a.y, a.altFt + (a.onGround ? 10 / FT : 0));
      if (!s) continue;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bestD) {
        bestD = d;
        best = a.id;
      }
    }
    this.onPick?.(best);
  }

  dispose(): void {
    this.unload();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
