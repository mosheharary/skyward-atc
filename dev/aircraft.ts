// Aircraft lab: renders every type in a lineup (or one close up) with the real aircraft renderer.
// URL params: night=1, view=lineup|close|air|top|fleet, type=<AircraftTypeId>, cam=az,el,dist, gear=0..1, flaps=0..1,
// spoilers, reverse, tug=1, steer=deg, sel=1, q=low|medium|high|ultra, orbit=1 (auto-rotate).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createAircraftRenderer } from '../src/render/aircraft/index';
import { AIRLINES } from '../src/sim/airlines';
import { AIRCRAFT_TYPES } from '../src/sim/aircraftTypes';
import type { AircraftLights, AircraftRenderState, AircraftTypeId, QualityLevel } from '../src/sim/types';

const P = new URLSearchParams(location.search);
const num = (k: string, d: number) => (P.has(k) ? Number(P.get(k)) : d);
const night = num('night', 0);
const view = P.get('view') ?? 'lineup';
const quality = (P.get('q') ?? 'high') as QualityLevel;

const renderer = new THREE.WebGLRenderer({ antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color().lerpColors(new THREE.Color(0x9cc3e6), new THREE.Color(0x03060d), night);
scene.background = sky;
scene.fog = new THREE.FogExp2(sky.getHex(), 0.00012);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
// Mirrors the game environment: sun 4.6 by day with exposure 0.52, exposure 1.25 at night.
scene.environmentIntensity = THREE.MathUtils.lerp(0.6, 0.12, night);
renderer.toneMappingExposure = THREE.MathUtils.lerp(0.52, 1.25, night);
renderer.info.autoReset = false;

const sun = new THREE.DirectionalLight(0xfff3e0, THREE.MathUtils.lerp(4.6, 0.05, night));
sun.position.set(-120, 160, 90);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -140;
sc.right = 140;
sc.top = 140;
sc.bottom = -140;
sc.near = 10;
sc.far = 600;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbfd6ff, 0x4a4a40, THREE.MathUtils.lerp(0.9, 0.05, night)));

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: night ? 0x202224 : 0x6b6e70, roughness: 0.9 }),
);
ground.receiveShadow = true;
scene.add(ground);
// taxi line markings for scale
for (let i = -6; i <= 6; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 400).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd8b830 }));
  m.position.set(i * 70, 0.02, 0);
  scene.add(m);
}

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 60000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.5, P.has('bt') ? num('bt', 1) : 2.4 / renderer.toneMappingExposure));
composer.addPass(new OutputPass());

const acr = createAircraftRenderer(scene, quality);
const TYPES = Object.keys(AIRCRAFT_TYPES) as AircraftTypeId[];
const lightsOn = (air: boolean): AircraftLights => ({
  nav: true,
  beacon: true,
  strobe: air,
  landing: air || P.get('landing') === '1',
  taxi: !air || P.get('taxi') === '1',
  logo: true,
  cabin: true,
});

function mk(i: number, typeId: AircraftTypeId, x: number, y: number, over: Partial<AircraftRenderState> = {}): AircraftRenderState {
  const airline = AIRLINES[(i + num('al', 0)) % AIRLINES.length];
  return {
    id: `ac${i}`,
    typeId,
    airlineCode: airline.code,
    registration: `${airline.regPrefix.replace(/-$/, "")}-${(100 + i * 37).toString(36).toUpperCase()}${String.fromCharCode(65 + (i % 26))}`,
    callsign: `${airline.code}${100 + i}`,
    x,
    y,
    altFt: 0,
    hdg: num('hdg', 300),
    pitch: 0,
    bank: 0,
    onGround: true,
    gsKt: num('gs', 0),
    vel: { x: 0, y: 0, z: 0 },
    gear: num('gear', 1),
    flaps: num('flaps', 0),
    spoilers: num('spoilers', 0),
    reverse: num('reverse', 0),
    thrust: num('thrust', 0.22),
    enginesRunning: true,
    lights: lightsOn(false),
    tug: P.get('tug') === '1',
    touchdownAt: -1,
    steer: num('steer', 0),
    ...over,
  };
}

let list: AircraftRenderState[] = [];
const focus = new THREE.Vector3();
let cam = [35, 18, 1];
if (view === 'lineup') {
  TYPES.forEach((t, i) => list.push(mk(i, t, (i % 6) * 85 - 212, i < 6 ? 60 : -40)));
  focus.set(0, 0, -10);
  cam = [20, 22, 420];
} else if (view === 'fleet') {
  // performance test: 40 aircraft
  for (let i = 0; i < 40; i++) list.push(mk(i, TYPES[i % TYPES.length], (i % 8) * 90 - 315, Math.floor(i / 8) * 90 - 180, { hdg: (i * 47) % 360 }));
  focus.set(0, 0, 0);
  cam = [30, 30, 700];
} else {
  const t = (P.get('type') ?? 'A320') as AircraftTypeId;
  const air = view === 'air';
  list.push(
    mk(0, t, 0, 0, air ? { altFt: num('alt', 60), onGround: false, pitch: 3, bank: num('bank', 0), gsKt: 140, thrust: 0.6, lights: lightsOn(true) } : {}),
  );
  const L = AIRCRAFT_TYPES[t].length;
  focus.set(0, air ? num('alt', 60) * 0.3048 : AIRCRAFT_TYPES[t].height * 0.35, 0);
  cam = view === 'top' ? [30, 70, L * 1.9] : [35, 12, L * 1.45];
}
if (P.has('cam')) {
  const c = P.get('cam')!.split(',').map(Number);
  cam = [c[0], c[1], c[2] ?? cam[2]];
}
const setCam = () => {
  const az = cam[0] * (Math.PI / 180);
  const el = cam[1] * (Math.PI / 180);
  // az measured from the aircraft nose direction (hdg) clockwise
  const h = (num('hdg', 300) * Math.PI) / 180 + az;
  camera.position.set(focus.x + Math.sin(h) * Math.cos(el) * cam[2], focus.y + Math.sin(el) * cam[2], focus.z - Math.cos(h) * Math.cos(el) * cam[2]);
  controls.target.copy(focus);
  controls.update();
};
setCam();
if (P.get('sel') === '1') acr.setSelected('ac0');

const hud = document.getElementById('hud')!;
let last = performance.now();
let t0 = 0;
let frames = 0;
let fps = 0;
let simTime = 0;
function tick(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  simTime += dt;
  frames++;
  t0 += dt;
  if (t0 > 1) {
    fps = frames / t0;
    frames = 0;
    t0 = 0;
  }
  if (P.get('anim') === '1') {
    const k = 0.5 + 0.5 * Math.sin(simTime * 0.6);
    list = list.map((s) => ({ ...s, gear: k, flaps: k, spoilers: k, reverse: k, steer: 40 * Math.sin(simTime) }));
  }
  if (P.get('orbit') === '1') {
    cam[0] += dt * 12;
    setCam();
  }
  controls.update();
  renderer.info.reset();
  acr.update(list, { dt, simTime, camera, nightFactor: night, fieldElevationFt: 0, quality });
  composer.render();
  const info = renderer.info;
  hud.textContent = `${view} night=${night} q=${quality} fps=${fps.toFixed(0)} calls=${info.render.calls} tris=${(info.render.triangles / 1000).toFixed(0)}k`;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});
Object.assign(window, { __acr: acr, __scene: scene, __camera: camera, __list: () => list });
