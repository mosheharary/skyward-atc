// Airport lab: renders one airport with the environment and airport renderers only.
// URL params: ?ap=HPX|LLBG|KSFO  &night=1  &cam=tower|orbit  &rain=1  &t=<hour>  &q=low|medium|high|ultra
//             &x=&y=&z= (camera world position)  &lx=&ly=&lz= (look target)  &fov=

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createEnvironment } from '../src/render/environment';
import { createAirportRenderer, type AirportRenderer } from '../src/render/airport';
import { AirportModel } from '../src/sim/airportModel';
import { AIRPORT_BY_ID } from '../src/sim/airports';
import { CLEAR_WEATHER, type QualityLevel, type WeatherState } from '../src/sim/types';

const qs = new URLSearchParams(location.search);
const def = AIRPORT_BY_ID[qs.get('ap') ?? 'KSFO'] ?? AIRPORT_BY_ID.KSFO;
const quality = (qs.get('q') ?? 'high') as QualityLevel;
const night = qs.get('night') === '1';
const rain = qs.get('rain') === '1';
const hour = qs.has('t') ? Number(qs.get('t')) : night ? 22 : 14;
const camMode = qs.get('cam') ?? 'orbit';
const num = (k: string, d: number): number => (qs.has(k) ? Number(qs.get(k)) : d);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 50), 1, 1, 400000);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const model = new AirportModel(def);
const env = createEnvironment({ scene, renderer, airport: def, quality });
const airport = createAirportRenderer(scene, model, quality) as AirportRenderer;

const weather: WeatherState = rain
  ? { ...CLEAR_WEATHER, precipitation: 0.7, cloudCover: 0.95, cloudBase: 1500, visibility: 4000, windSpeed: 18, windDir: 250 }
  : { ...CLEAR_WEATHER, cloudCover: num('cover', CLEAR_WEATHER.cloudCover) };
airport.setWind(weather.windDir, weather.windSpeed);

const [tx, ty] = def.tower.pos;
const [lx, ly] = def.tower.lookAt;
const controls = new OrbitControls(camera, canvas);
if (camMode === 'tower') {
  camera.position.set(tx, def.tower.eyeHeight, -ty);
  controls.target.set(lx, 0, -ly);
  // Keep the camera fixed at the eye point: look around only.
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.rotateSpeed = -0.3;
  const dir = new THREE.Vector3(lx - tx, -def.tower.eyeHeight, -(ly - ty)).normalize();
  controls.target.copy(camera.position).addScaledVector(dir, 1);
} else {
  const r = model.runways[0];
  const cx = (r.a[0] + r.b[0]) / 2;
  const cy = (r.a[1] + r.b[1]) / 2;
  controls.target.set(num('lx', lx * 0.5 + cx * 0.5), num('ly', 0), num('lz', -(ly * 0.5 + cy * 0.5)));
  camera.position.set(num('x', controls.target.x + 900), num('y', 450), num('z', controls.target.z + 1300));
}
controls.update();

const activeRunways = new Set(model.runways.map((r) => r.id));
const arrivalEnds = new Set<string>();
for (const r of model.runways) {
  const e = r.ends.find((x) => x.approachLights === 'full') ?? r.ends[0];
  arrivalEnds.add(e.name);
}
const occupiedGates = new Set(model.gates.filter((_, i) => i % 3 !== 1).map((g) => g.id));

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const hud = document.getElementById('hud') as HTMLDivElement;
const clock = new THREE.Clock();
let simTime = 0;
let frames = 0;
let acc = 0;
const focus = new THREE.Vector3();
function frame(): void {
  const dt = Math.min(0.1, clock.getDelta());
  simTime += dt;
  controls.update();
  focus.copy(controls.target);
  env.update({ dt, simTime, timeOfDay: hour * 3600 + simTime, dayOfYear: 172, weather, camera, focus, shadowRadius: 1500 });
  airport.update({ dt, simTime, camera, nightFactor: env.nightFactor, wetness: env.wetness, activeRunways, arrivalEnds, occupiedGates });
  renderer.info.reset();
  composer.render(dt);
  frames++;
  acc += dt;
  if (acc > 0.5) {
    const info = renderer.info;
    hud.textContent = `${def.id} ${hour}h night=${env.nightFactor.toFixed(2)} wet=${env.wetness.toFixed(2)}  ${(frames / acc).toFixed(0)} fps  calls=${info.render.calls} tris=${(info.render.triangles / 1e6).toFixed(2)}M  lights=${airport.lightCount}`;
    frames = 0;
    acc = 0;
  }
  requestAnimationFrame(frame);
}
renderer.info.autoReset = false;
requestAnimationFrame(frame);

Object.assign(window as unknown as Record<string, unknown>, { __scene: scene, __camera: camera, __controls: controls, __airport: airport, __env: env, __renderer: renderer, THREE });
