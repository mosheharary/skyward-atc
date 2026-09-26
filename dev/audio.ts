// Audio lab: exercises every part of the audio engine in isolation.
// Open http://localhost:5173/dev/audio.html (vite dev server) and press "Start audio".

import type { AircraftAudioState, RadioMessage, UISound } from '../src/audio/contracts';
import { createAudioEngine, type AudioEngine } from '../src/audio/index';
import type { VoiceAccent } from '../src/sim/airlines';
import { CLEAR_WEATHER, type EngineKind, type SizeClass, type WeatherState } from '../src/sim/types';

const engine = createAudioEngine() as AudioEngine;
(window as unknown as { __audio: AudioEngine }).__audio = engine;

const state = {
  kind: 'turbofan' as EngineKind,
  size: 'M' as SizeClass,
  engines: 2 as 2 | 4,
  thrust: 0.22,
  reverse: 0,
  running: true,
  flyby: false,
  lateral: 300,
  speed: 75,
  alt: 0,
  gateTraffic: false,
  wind: 8,
  gust: 0,
  rain: 0,
  storm: false,
  temp: 22,
  night: 0,
  indoor: false,
  paused: false,
  timeScale: 1,
};

const vols = { master: 0.85, engines: 0.85, radio: 0.9, ambience: 0.7, music: 0.55, ui: 0.7 };
const weather: WeatherState = { ...CLEAR_WEATHER, lightning: [] };
let simTime = 0;
let flyX = -3000;
let strikeId = 1;
let nextAutoStrike = 0;
let music: 'menu' | 'none' = 'none';

// Automation hook: lets scripts drive the lab (state is read every frame).
(window as unknown as { __lab: unknown }).__lab = { state, weather, addStrike: (d: number) => addStrike(d) };

const app = document.getElementById('app') as HTMLElement;
const logEl = document.createElement('div');
logEl.id = 'log';

function log(s: string): void {
  const t = (performance.now() / 1000).toFixed(2).padStart(8, ' ');
  logEl.textContent = `${t}  ${s}\n${logEl.textContent ?? ''}`.slice(0, 6000);
}

function section(title: string): HTMLElement {
  const s = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  app.appendChild(s);
  return s;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
): void {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement('output');
  out.textContent = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = String(v);
    onInput(v);
  });
  row.append(l, input, out);
  parent.appendChild(row);
}

function check(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
  const l = document.createElement('label');
  l.className = 'check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  l.append(input, document.createTextNode(label));
  parent.appendChild(l);
}

function select<T extends string>(parent: HTMLElement, label: string, options: T[], value: T, onChange: (v: T) => void): void {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const sel = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o;
    opt.selected = o === value;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value as T));
  row.append(l, sel, document.createElement('span'));
  parent.appendChild(row);
}

function buttons(parent: HTMLElement, defs: [string, () => void][]): void {
  const wrap = document.createElement('div');
  wrap.className = 'buttons';
  for (const [text, fn] of defs) {
    const b = document.createElement('button');
    b.textContent = text;
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  }
  parent.appendChild(wrap);
}

function addStrike(distance: number): void {
  const ang = Math.random() * Math.PI * 2;
  // Listener sits at world (0, 1.7, 0) => sim (0, 0).
  weather.lightning = [
    ...weather.lightning,
    { id: strikeId++, t: simTime, x: Math.cos(ang) * distance, y: Math.sin(ang) * distance },
  ];
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 90);
  log(`lightning at ${Math.round(distance)} m (thunder in ${(distance / 343).toFixed(1)} s)`);
}

function radio(from: 'atc' | 'pilot', text: string, voiceKey: string, accent: VoiceAccent): RadioMessage {
  return {
    from,
    text,
    voiceKey,
    accent,
    onStart: () => log(`[${from}/${accent}] start: ${text}`),
    onEnd: () => log(`[${from}/${accent}] end`),
  };
}

// --- Aircraft ----------------------------------------------------------------------------------
const acSec = section('Test aircraft');
select(acSec, 'Engine', ['turbofan', 'turboprop'] as EngineKind[], state.kind, (v) => (state.kind = v));
select(acSec, 'Size', ['S', 'M', 'L', 'H'] as SizeClass[], state.size, (v) => (state.size = v));
select(acSec, 'Engines', ['2', '4'], '2', (v) => (state.engines = v === '4' ? 4 : 2));
slider(acSec, 'Thrust', 0, 1, 0.01, state.thrust, (v) => (state.thrust = v));
slider(acSec, 'Reverse', 0, 1, 0.01, state.reverse, (v) => (state.reverse = v));
slider(acSec, 'Distance m', 20, 8000, 10, state.lateral, (v) => (state.lateral = v));
slider(acSec, 'Altitude m', 0, 1500, 10, state.alt, (v) => (state.alt = v));
slider(acSec, 'Fly-by m/s', 5, 160, 1, state.speed, (v) => (state.speed = v));
check(acSec, 'Running', state.running, (v) => (state.running = v));
check(acSec, 'Fly-by (doppler)', state.flyby, (v) => {
  state.flyby = v;
  flyX = -3000;
});
check(acSec, 'Gate traffic x3', state.gateTraffic, (v) => (state.gateTraffic = v));
buttons(acSec, [
  ['Takeoff power', () => (state.thrust = 1)],
  ['Idle', () => (state.thrust = 0.22)],
  ['Shutdown/start', () => (state.running = !state.running)],
]);

// --- Environment -------------------------------------------------------------------------------
const envSec = section('Environment');
slider(envSec, 'Wind kt', 0, 45, 1, state.wind, (v) => (state.wind = v));
slider(envSec, 'Gust kt', 0, 60, 1, state.gust, (v) => (state.gust = v));
slider(envSec, 'Rain', 0, 1, 0.01, state.rain, (v) => (state.rain = v));
slider(envSec, 'Temp C', -10, 40, 1, state.temp, (v) => (state.temp = v));
slider(envSec, 'Night', 0, 1, 0.01, state.night, (v) => (state.night = v));
slider(envSec, 'Time scale', 0, 8, 1, state.timeScale, (v) => (state.timeScale = v));
check(envSec, 'Thunderstorm', state.storm, (v) => (state.storm = v));
check(envSec, 'Indoor (tower cab)', state.indoor, (v) => (state.indoor = v));
check(envSec, 'Paused', state.paused, (v) => (state.paused = v));
buttons(envSec, [
  ['Thunder near', () => addStrike(700)],
  ['Thunder far', () => addStrike(9000)],
  ['Touchdown near', () => engine.touchdown({ x: 0, y: 0, z: -150 }, 1)],
  ['Touchdown far', () => engine.touchdown({ x: 0, y: 0, z: -2500 }, 1)],
]);

// --- UI sounds ---------------------------------------------------------------------------------
const uiSec = section('UI sounds');
const sounds: UISound[] = ['click', 'select', 'confirm', 'error', 'notify', 'conflict', 'violation', 'success', 'shiftComplete', 'emergency'];
buttons(uiSec, sounds.map((s) => [s, () => engine.playUI(s)] as [string, () => void]));

// --- Radio -------------------------------------------------------------------------------------
const radioSec = section('Radio');
let pilotsVoice = true;
let atcVoice = true;
check(radioSec, 'Pilot voices', pilotsVoice, (v) => {
  pilotsVoice = v;
  engine.setVoiceEnabled(pilotsVoice, atcVoice);
});
check(radioSec, 'Controller voice', atcVoice, (v) => {
  atcVoice = v;
  engine.setVoiceEnabled(pilotsVoice, atcVoice);
});
buttons(radioSec, [
  [
    'ATC + readback',
    () => {
      engine.transmit(radio('atc', 'Azure one two three, turn left heading two seven zero, descend and maintain four thousand.', 'ATC', 'us'));
      engine.transmit(radio('pilot', 'Left heading two seven zero, descend and maintain four thousand, Azure one two three.', 'AZR123', 'us'));
    },
  ],
  [
    'Accent round',
    () => {
      engine.transmit(radio('pilot', 'Approach, Meridian four five six, with you at one zero thousand, information Bravo.', 'MRD456', 'gb'));
      engine.transmit(radio('pilot', 'Zephyr eight one, descending flight level one one zero.', 'ZPH81', 'au'));
      engine.transmit(radio('pilot', 'Cedar two two seven, holding short runway two seven, ready for departure.', 'CDR227', 'ie'));
      engine.transmit(radio('pilot', 'Ground, Levant three one niner, gate Alpha five, request pushback.', 'LVT319', 'in'));
      engine.transmit(radio('pilot', 'Boreal one four, established localizer runway three zero.', 'BRL14', 'za'));
    },
  ],
  ['Clear radio', () => engine.clearRadio()],
]);
radioSec.appendChild(logEl);

// --- Mixer -------------------------------------------------------------------------------------
const mixSec = section('Mixer & music');
for (const k of Object.keys(vols) as (keyof typeof vols)[]) {
  slider(mixSec, k, 0, 1, 0.01, vols[k], (v) => {
    vols[k] = v;
    engine.setVolumes({ [k]: v });
  });
}
buttons(mixSec, [
  [
    'Toggle menu music',
    () => {
      music = music === 'menu' ? 'none' : 'menu';
      engine.setMusic(music);
      log(`music: ${music}`);
    },
  ],
  ['Suspend', () => engine.suspend()],
  ['Resume', () => engine.resume()],
]);

// --- Start + loop ------------------------------------------------------------------------------
const statusEl = document.getElementById('status') as HTMLElement;
const debugEl = document.getElementById('debug') as HTMLElement;
const meterBar = document.getElementById('meterBar') as HTMLElement;
(document.getElementById('start') as HTMLButtonElement).addEventListener('click', async () => {
  await engine.start();
  engine.setVolumes(vols);
  statusEl.textContent = engine.started ? 'running' : 'unavailable';
  log('audio started');
});

const gate: [number, number, EngineKind, SizeClass][] = [
  [-400, -600, 'turbofan', 'M'],
  [250, -500, 'turboprop', 'S'],
  [600, -900, 'turbofan', 'L'],
];

let last = performance.now();
let lastFrameAt = performance.now();
function frame(now: number, fromTimer = false): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  lastFrameAt = performance.now();
  const step = state.paused ? 0 : dt * state.timeScale;
  simTime += step;

  const list: AircraftAudioState[] = [];
  if (state.flyby) {
    flyX += state.speed * step;
    if (flyX > 4000) flyX = -4000;
  }
  list.push({
    id: 'TEST1',
    position: { x: state.flyby ? flyX : 0, y: state.alt, z: -state.lateral },
    velocity: { x: state.flyby ? state.speed : 0, y: 0, z: 0 },
    engine: state.kind,
    engines: state.engines,
    size: state.size,
    thrust: state.thrust,
    reverse: state.reverse,
    running: state.running,
    onGround: state.alt < 1,
  });
  if (state.gateTraffic) {
    gate.forEach(([x, z, kind, size], i) =>
      list.push({
        id: `GATE${i}`,
        position: { x, y: 0, z },
        velocity: { x: 0, y: 0, z: 0 },
        engine: kind,
        engines: 2,
        size,
        thrust: 0.22,
        reverse: 0,
        running: true,
        onGround: true,
      }),
    );
  }

  weather.windSpeed = state.wind;
  weather.gust = state.gust;
  weather.precipitation = state.rain;
  weather.thunderstorm = state.storm;
  weather.temperature = state.temp;
  if (state.storm && simTime > nextAutoStrike) {
    if (nextAutoStrike > 0) addStrike(1000 + Math.random() * 11000);
    nextAutoStrike = simTime + 8 + Math.random() * 14;
  }
  weather.lightning = weather.lightning.filter((s) => simTime - s.t < 10);

  engine.update({
    dt,
    listener: { position: { x: 0, y: 1.7, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
    aircraft: list,
    weather,
    simTime,
    nightFactor: state.night,
    indoor: state.indoor,
    paused: state.paused,
    timeScale: state.timeScale,
  });

  const d = engine.debugState();
  const lvl = d.level;
  meterBar.style.width = `${Math.min(100, Math.sqrt(lvl) * 160)}%`;
  debugEl.textContent = `ctx ${d.context} · level ${lvl.toFixed(3)} · voices ${d.engineVoices} · radio queue ${d.radioQueue} · TTS voices ${d.ttsVoices}`;
  if (!fromTimer) requestAnimationFrame((t) => frame(t));
}
requestAnimationFrame((t) => frame(t));
// rAF stops in hidden tabs; keep the lab ticking from a timer so audio can still be tested.
setInterval(() => {
  if (performance.now() - lastFrameAt > 120) frame(performance.now(), true);
}, 33);
