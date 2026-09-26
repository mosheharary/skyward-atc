// Environment renderer: sky, sun/moon lighting, fog, environment map, terrain, water, cities,
// vegetation, roads, clouds, rain and lightning. Implements IEnvironment (src/render/contracts.ts).
import * as THREE from 'three';
import type { AirportDef } from '../../sim/airports/types';
import type { QualityLevel, WeatherState } from '../../sim/types';
import type { CreateEnvironment, EnvironmentOptions, EnvironmentUpdate, IEnvironment } from '../contracts';
import { computeCelestial, type CelestialState } from './astro';
import { CitySystem } from './City';
import { CloudSystem } from './Clouds';
import { PALETTES, type PaletteDef } from './palettes';
import { ENV_QUALITY, type EnvQualitySettings } from './quality';
import { LightningSystem, RainSystem } from './Rain';
import { RoadSystem } from './Roads';
import { MoonSprite, SkyDome, StarField } from './SkyDome';
import { extinction, skyRadiance, sunStrength, type SkyParams } from './skyModel';
import { Terrain } from './Terrain';
import { makeCloudAtlas, makeDetailNormal, makeDetailTexture, makeMacroNoise, makeWaterNormals } from './textures';
import { TreeSystem } from './Trees';
import { WaterSystem } from './WaterSystem';

const DEG = Math.PI / 180;
const KT = 0.514444;
const FT = 0.3048;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Smoothed weather-derived parameters (so abrupt sim changes still animate). */
interface WeatherLook {
  cover: number;
  overcast: number;
  storm: number;
  precip: number;
  visibility: number;
  cloudBase: number;
}

export class Environment implements IEnvironment {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  nightFactor = 0;
  wetness = 0;

  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly airport: AirportDef;
  private readonly palette: PaletteDef;
  private readonly seed: number;
  private quality: QualityLevel;
  private q: EnvQualitySettings;

  private readonly root = new THREE.Group();
  private readonly sky: SkyDome;
  private stars: StarField;
  private readonly moon: MoonSprite;
  private terrain!: Terrain;
  private water: WaterSystem | null = null;
  private city: CitySystem | null = null;
  private trees: TreeSystem | null = null;
  private roads: RoadSystem | null = null;
  private clouds!: CloudSystem;
  private rain!: RainSystem;
  private readonly lightning = new LightningSystem();
  private readonly fog: THREE.FogExp2;

  // textures
  private detailTex!: THREE.DataTexture;
  private normalTex!: THREE.DataTexture;
  private readonly macroTex: THREE.DataTexture;
  private readonly waterNormals: THREE.DataTexture;
  private readonly cloudAtlas: THREE.DataTexture;

  // env map capture
  private readonly envScene = new THREE.Scene();
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  private pmremRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  private readonly envKey = { sun: new THREE.Vector3(9, 9, 9), cover: -1, overcast: -1, storm: -1, night: -1, haze: -1 };

  // state
  private celestial: CelestialState | null = null;
  private readonly look: WeatherLook = { cover: 0, overcast: 0, storm: 0, precip: 0, visibility: 40000, cloudBase: 4500 };
  private first = true;
  private lastSimTime = 0;
  private time = 0;
  private readonly lightPollution: number;

  // scratch
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector2();
  private readonly tmpC = new THREE.Color();
  private readonly tmpC2 = new THREE.Color();
  private readonly skyP: SkyParams = { turbidity: 3, rayleigh: 1.8, mieCoefficient: 0.005, mieDirectionalG: 0.8 };
  private readonly fogColor = new THREE.Color();
  private readonly sunColor = new THREE.Color();
  private sunIntensity = 0;
  private readonly skyAmbient = new THREE.Color();
  private readonly overcastColor = new THREE.Color();
  private readonly nightHorizon = new THREE.Color();
  private readonly cloudOffset = new THREE.Vector2();
  private cloudEvolve = 0;

  constructor(opts: EnvironmentOptions) {
    this.scene = opts.scene;
    this.renderer = opts.renderer;
    this.airport = opts.airport;
    this.palette = PALETTES[opts.airport.scenery.ground] ?? PALETTES.temperate;
    this.seed = hashStr(opts.airport.id);
    this.quality = opts.quality;
    this.q = ENV_QUALITY[opts.quality];
    this.root.name = 'Environment';

    // lights (fixed set, never added/removed later)
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.name = 'SunMoonLight';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 12000;
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5a5040, 0.5);
    this.hemi.name = 'SkyHemisphere';
    this.root.add(this.sun, this.sun.target, this.hemi);

    this.fog = new THREE.FogExp2(0xa0b0c0, 0.00004);
    this.scene.fog = this.fog;
    this.scene.background = null;

    // sky
    this.sky = new SkyDome();
    this.root.add(this.sky.mesh);
    this.envScene.add(this.sky.envMesh);
    this.stars = new StarField(this.q.stars, this.seed + 1);
    this.root.add(this.stars.points);
    this.moon = new MoonSprite();
    this.root.add(this.moon.mesh);

    // textures
    this.macroTex = makeMacroNoise(256, this.seed + 10);
    this.waterNormals = makeWaterNormals(512, this.seed + 11, this.renderer);
    this.cloudAtlas = makeCloudAtlas(512, this.seed + 12);

    // env capture
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.q.envSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(1, 1000, this.cubeRT);

    let lp = 0;
    for (const c of opts.airport.scenery.cities) lp += c.density * Math.min(1, c.radius / 4000) * (0.5 + c.maxHeight / 300);
    this.lightPollution = Math.min(1.2, lp);

    this.root.add(this.lightning.group);
    this.buildWorld();
    this.scene.add(this.root);
  }

  // ------------------------------------------------------------------ build / rebuild

  private buildWorld(): void {
    const q = this.q;
    this.detailTex = makeDetailTexture(q.detailSize, this.seed + 20, this.renderer);
    this.normalTex = makeDetailNormal(q.detailSize, this.seed + 21, q.detailSize / 110, this.renderer);
    this.terrain = new Terrain(this.airport, this.palette, q.terrain, { detail: this.detailTex, macro: this.macroTex, normal: this.normalTex });
    this.root.add(this.terrain.group);
    const heightAt = (x: number, z: number): number => this.terrain.heightAt(x, z);

    if (this.airport.scenery.water.length > 0) {
      this.water = new WaterSystem(this.terrain.field.seaY, new THREE.Color(this.palette.water), this.waterNormals, this.terrain.extent * 3);
      this.water.setMode(q.water, q.mirrorSize);
      this.root.add(this.water.group);
    }
    if (this.airport.scenery.cities.length > 0) {
      this.city = new CitySystem(this.terrain.field, heightAt, this.palette, { maxBuildings: q.maxBuildings, streetLightSpacing: q.streetLightSpacing }, this.seed + 30);
      this.root.add(this.city.group);
    }
    this.trees = new TreeSystem(this.terrain.field, heightAt, this.palette, { maxTrees: q.maxTrees }, this.city?.parks ?? [], this.seed + 40);
    this.root.add(this.trees.group);
    if (this.airport.scenery.roads.length > 0) {
      this.roads = new RoadSystem(this.airport.scenery.roads as [number, number][][], heightAt, this.terrain.field.seaY, q.carDensity, this.seed + 50);
      this.root.add(this.roads.group);
    }
    this.clouds = new CloudSystem(this.cloudAtlas, this.macroTex, q.cloudPuffs, this.seed + 60);
    this.root.add(this.clouds.group);
    this.rain = new RainSystem(q.rainDrops, this.seed + 70);
    this.root.add(this.rain.mesh);
    if (this.water) this.water.hideInReflection.push(this.trees.group, this.rain.mesh, this.lightning.group);
  }

  private disposeWorld(): void {
    const drop = (o: THREE.Object3D | undefined | null): void => {
      if (o) this.root.remove(o);
    };
    drop(this.terrain?.group);
    this.terrain?.dispose();
    drop(this.water?.group);
    this.water?.dispose();
    this.water = null;
    drop(this.city?.group);
    this.city?.dispose();
    this.city = null;
    drop(this.trees?.group);
    this.trees?.dispose();
    this.trees = null;
    drop(this.roads?.group);
    this.roads?.dispose();
    this.roads = null;
    drop(this.clouds?.group);
    this.clouds?.dispose();
    drop(this.rain?.mesh);
    this.rain?.dispose();
    this.detailTex?.dispose();
    this.normalTex?.dispose();
  }

  setQuality(q: QualityLevel): void {
    if (q === this.quality) return;
    this.quality = q;
    this.q = ENV_QUALITY[q];
    this.disposeWorld();
    this.buildWorld();
    this.sun.shadow.mapSize.set(this.q.shadowMapSize, this.q.shadowMapSize);
    this.sun.shadow.map?.dispose();
    (this.sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
    this.root.remove(this.stars.points);
    this.stars.dispose();
    this.stars = new StarField(this.q.stars, this.seed + 1);
    this.root.add(this.stars.points);
    this.cubeRT.dispose();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(this.q.envSize, { type: THREE.HalfFloatType, generateMipmaps: false });
    this.cubeCam = new THREE.CubeCamera(1, 1000, this.cubeRT);
    this.pmremRT?.dispose();
    this.pmremRT = null;
    this.envKey.cover = -1;
    this.first = true;
  }

  heightAt(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  // ------------------------------------------------------------------ per frame

  update(u: EnvironmentUpdate): void {
    const dt = Math.min(Math.max(u.dt, 0), 0.25);
    this.time += dt;
    const w = u.weather;
    const simDt = this.first ? 0 : Math.min(Math.max(u.simTime - this.lastSimTime, 0), 10);
    this.lastSimTime = u.simTime;

    this.updateWeatherLook(w, dt);
    const L = this.look;

    // --- celestial
    this.celestial = computeCelestial(this.airport.latitude, this.airport.longitude, this.airport.utcOffset, u.dayOfYear, u.timeOfDay, this.celestial ?? undefined);
    const cel = this.celestial;
    this.sunDirection.copy(cel.sunDir);
    const sunElev = cel.sunElevation;
    const astroNight = smoothstep(3, -10, sunElev);
    const darkness = clamp01(L.overcast * 0.22 + L.storm * 0.38 + smoothstep(5000, 800, L.visibility) * 0.35);
    this.nightFactor = Math.max(astroNight, Math.min(0.75, darkness));

    // --- wetness
    if (this.first) this.wetness = L.precip > 0.1 ? 0.85 : 0;
    else if (L.precip > 0.04) this.wetness = Math.min(1, this.wetness + (simDt * L.precip) / 80);
    else this.wetness = Math.max(0, this.wetness - (simDt / 900) * (1 + (1 - astroNight)));

    // --- wind (world m/s, direction the wind blows towards)
    const toDir = (w.windDir + 180) * DEG;
    const windMs = w.windSpeed * KT;
    const windX = Math.sin(toDir) * windMs;
    const windZ = -Math.cos(toDir) * windMs;

    // --- sky model parameters
    const haze = clamp01(1 - (L.visibility - 3000) / 35000);
    this.skyP.turbidity = lerp(2.4, 8.5, haze) + L.storm * 2;
    this.skyP.rayleigh = lerp(1.6, 2.4, smoothstep(20, 2, sunElev)) * (1 - L.overcast * 0.4);
    this.skyP.mieCoefficient = lerp(0.0035, 0.012, haze);
    this.skyP.mieDirectionalG = 0.8;

    // sun colour & strength
    const strength = sunStrength(cel.sunDir.y);
    extinction(cel.sunDir, this.skyP, this.tmpC);
    const mx = Math.max(this.tmpC.r, this.tmpC.g, this.tmpC.b, 1e-4);
    this.tmpC.multiplyScalar(1 / mx);
    const warm = 0.35 + 0.65 * (1 - smoothstep(8, 40, sunElev));
    this.sunColor.setRGB(1, 1, 1).lerp(this.tmpC, warm);
    const sunVis = smoothstep(-2.5, 4, sunElev) * Math.pow(strength, 0.35);
    const cloudDim = (1 - L.overcast * 0.88) * (1 - L.storm * 0.4) * (1 - L.cover * 0.25);
    this.sunIntensity = 4.6 * sunVis * cloudDim;

    // sky colours sampled from the model
    this.computeSkyColors(cel.sunDir, astroNight, L);

    // --- directional light: sun by day, moon by night
    const moonUp = smoothstep(-1, 8, cel.moonElevation);
    const moonI = (0.1 + 0.42 * cel.moonIllumination) * moonUp * astroNight * (1 - L.overcast * 0.85);
    if (this.sunIntensity >= moonI || cel.sunElevation > -3) {
      this.sun.position.copy(cel.sunDir);
      this.sun.color.copy(this.sunColor);
      this.sun.intensity = this.sunIntensity;
    } else {
      this.sun.position.copy(cel.moonDir);
      this.sun.color.setRGB(0.62, 0.72, 1.0);
      this.sun.intensity = moonI;
    }
    const lightDir = this.tmpV.copy(this.sun.position).normalize();
    this.fitShadow(lightDir, u.focus, u.shadowRadius);

    // hemisphere: sky ambient + ground bounce
    const hemiDay = 0.55 * smoothstep(-6, 12, sunElev) * (1 - L.storm * 0.35);
    const hemiNight = 0.11 + this.lightPollution * 0.05;
    this.hemi.color.copy(this.skyAmbient);
    this.hemi.groundColor.set(this.palette.grass).lerp(this.tmpC2.set(this.palette.soil), 0.4).multiplyScalar(0.6);
    this.hemi.intensity = Math.max(hemiDay, hemiNight * astroNight) * (1 + this.lightning.flash * 5);
    if (astroNight > 0.5) this.hemi.color.lerp(this.tmpC2.setRGB(0.55, 0.62, 0.85), astroNight);

    this.scene.environmentIntensity = lerp(1.0, 0.35, astroNight) * (1 - L.storm * 0.3);
    this.renderer.toneMappingExposure = lerp(0.62, 1.25, astroNight) * lerp(1, 1.15, L.overcast) + this.lightning.flash * 0.25;

    // --- fog
    // Haze lives in the boundary layer: looking down from altitude the effective visibility is much
    // longer than the surface value, so thin the (height-less) exp2 fog as the camera climbs.
    const camAlt = Math.max(0, u.camera.position.y);
    const aloft = 1 + camAlt / (L.visibility > 8000 ? 900 : 2500);
    const visEff = Math.min(L.visibility * aloft, 150000) * (1 - L.precip * 0.25);
    this.fog.density = 1.978 / Math.max(visEff, 150);
    this.fog.color.copy(this.fogColor);

    // --- sky dome uniforms
    this.updateSkyUniforms(cel, astroNight, haze, L, dt, windX, windZ);
    this.sky.follow(u.camera);

    // --- stars & moon
    const starVis = astroNight * (1 - L.overcast) * (1 - L.cover * 0.55) * smoothstep(2000, 15000, L.visibility) * (1 - cel.moonIllumination * moonUp * 0.35);
    const sm = this.stars.material.uniforms;
    (sm.uCelestial.value as THREE.Matrix3).setFromMatrix4(cel.celestial);
    sm.uTime.value = this.time;
    sm.uVisibility.value = starVis;
    sm.uPixelRatio.value = this.renderer.getPixelRatio();
    this.stars.points.visible = starVis > 0.01;
    const moonBright = (0.35 + 0.65 * astroNight) * (1 - L.overcast * 0.97) * smoothstep(-1.5, 1, cel.moonElevation);
    this.moon.update(cel.moonDir, cel.sunDir, u.camera, moonBright * 1.2, 1 - L.cover * 0.5);
    this.moon.mesh.visible = moonBright > 0.01 && cel.moonIllumination > 0.02;

    // --- lightning
    for (const s of w.lightning) {
      if (s.t < u.simTime - 1.5) {
        this.lightning.ignore(s.id);
        continue;
      }
      if (s.t <= u.simTime + 0.05) {
        const x = s.x;
        const z = -s.y;
        const gy = this.terrain.heightAt(x, z);
        this.lightning.strike(s.id, x, gy, z, L.cloudBase * FT + 1200, u.camera);
      }
    }
    this.lightning.update(dt);

    // --- sub systems
    const vp = this.renderer.getDrawingBufferSize(this.tmpV2);
    const pr = this.renderer.getPixelRatio();
    this.terrain.update(this.nightFactor, this.wetness);
    if (this.water) this.water.update(u.simTime, lightDir, this.sun.color, this.sun.intensity, u.camera, w.windSpeed);
    this.city?.update(this.time, this.nightFactor, u.camera, vp.y, pr);
    this.roads?.update(dt, this.time, this.nightFactor, u.camera, vp.y, pr);
    this.trees?.update(this.time, windX * 0.05, windZ * 0.05);
    this.updateClouds(u, dt, windX, windZ, astroNight, L);
    this.tmpC.copy(this.skyAmbient).multiplyScalar(1.6 * (1 - astroNight * 0.85)).addScalar(this.lightning.flash * 0.6 + 0.02);
    this.rain.update(dt, u.camera, L.precip, windX, windZ, this.tmpC);

    // --- environment map (throttled)
    this.envTimer -= dt;
    this.maybeUpdateEnvMap(cel, astroNight, haze, L);
    this.first = false;
  }

  private updateWeatherLook(w: WeatherState, dt: number): void {
    const L = this.look;
    const cover = clamp01(w.cloudCover);
    const target: WeatherLook = {
      cover,
      overcast: smoothstep(0.62, 0.92, cover),
      storm: w.thunderstorm ? 1 : 0,
      precip: clamp01(w.precipitation),
      visibility: Math.max(100, w.visibility),
      cloudBase: Math.max(300, w.cloudBase),
    };
    if (this.first) {
      Object.assign(L, target);
      return;
    }
    const k = 1 - Math.exp(-dt / 2.5);
    L.cover += (target.cover - L.cover) * k;
    L.overcast += (target.overcast - L.overcast) * k;
    L.storm += (target.storm - L.storm) * k;
    L.precip += (target.precip - L.precip) * k;
    // visibility in log space
    L.visibility = Math.exp(Math.log(L.visibility) + (Math.log(target.visibility) - Math.log(L.visibility)) * k);
    L.cloudBase += (target.cloudBase - L.cloudBase) * k;
  }

  private computeSkyColors(sunDir: THREE.Vector3, astroNight: number, L: WeatherLook): void {
    const p = this.skyP;
    // horizon average for fog (8 azimuths at +2 deg)
    const acc = this.tmpC2.setRGB(0, 0, 0);
    const d = this.tmpV;
    const c = new THREE.Color();
    const el = 2.5 * DEG;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      d.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
      skyRadiance(d, sunDir, p, c);
      acc.add(c);
    }
    acc.multiplyScalar(1 / 8);
    // overcast grey
    const sunUp = smoothstep(-6, 25, sunDir.y / DEG);
    const lum = 0.2126 * acc.r + 0.7152 * acc.g + 0.0722 * acc.b;
    this.overcastColor.setRGB(0.88, 0.9, 0.95).multiplyScalar(Math.max(lum * 0.95, 0.0005) * (1 - L.storm * 0.55));
    // tint towards the sun colour at low sun
    this.overcastColor.lerp(this.tmpC.copy(acc), 0.25 * (1 - sunUp));
    // night horizon + light pollution
    const lp = this.lightPollution;
    this.nightHorizon.setRGB(0.004 + 0.006 * lp, 0.005 + 0.004 * lp, 0.009 + 0.002 * lp);
    this.fogColor.copy(acc).lerp(this.overcastColor, L.overcast * 0.9);
    this.fogColor.multiplyScalar(1 - L.precip * 0.25);
    this.fogColor.lerp(this.nightHorizon, astroNight * 0.85);
    if (astroNight > 0) this.overcastColor.lerp(this.tmpC.setRGB(0.006 + 0.01 * lp, 0.005 + 0.007 * lp, 0.005 + 0.004 * lp), astroNight);
    // ambient sky colour (zenith-ish)
    const amb = this.skyAmbient.setRGB(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      d.set(Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6).normalize();
      skyRadiance(d, sunDir, p, c);
      amb.add(c);
    }
    amb.multiplyScalar(1 / 4);
    amb.lerp(this.overcastColor, L.overcast * 0.85);
    const m = Math.max(amb.r, amb.g, amb.b, 1e-5);
    amb.multiplyScalar(1 / m);
  }

  private updateSkyUniforms(cel: CelestialState, astroNight: number, haze: number, L: WeatherLook, dt: number, windX: number, windZ: number): void {
    const s = this.sky.uniforms;
    (s.sunPosition.value as THREE.Vector3).copy(cel.sunDir);
    s.turbidity.value = this.skyP.turbidity;
    s.rayleigh.value = this.skyP.rayleigh;
    s.mieCoefficient.value = this.skyP.mieCoefficient;
    s.mieDirectionalG.value = this.skyP.mieDirectionalG;
    s.cloudCoverage.value = clamp01(L.cover * 0.78 + 0.02) * (L.cover < 0.03 ? 0 : 1);
    s.cloudDensity.value = lerp(0.35, 0.85, L.cover) + L.storm * 0.2;
    s.cloudScale.value = 0.00018;
    s.cloudElevation.value = 0.55;
    this.cloudOffset.x += windX * dt * 1.2e-7;
    this.cloudOffset.y += windZ * dt * 1.2e-7;
    (s.cloudOffset.value as THREE.Vector2).copy(this.cloudOffset);
    this.cloudEvolve += dt * 0.004;
    s.cloudEvolve.value = this.cloudEvolve;
    s.uOvercast.value = L.overcast;
    (s.uOvercastColor.value as THREE.Color).copy(this.overcastColor);
    (s.uFogColor.value as THREE.Color).copy(this.fogColor);
    s.uHorizonHaze.value = clamp01(0.25 + haze * 0.75 + L.precip * 0.3);
    s.uNight.value = astroNight;
    (s.uNightHorizon.value as THREE.Color).copy(this.nightHorizon);
    const lp = this.lightPollution;
    (s.uLightPollution.value as THREE.Color).setRGB(0.006 * lp, 0.0038 * lp, 0.0018 * lp);
    // twilight glow: strongest just after sunset, fading by -12 deg
    const e = cel.sunElevation;
    const tw = e < 1 && e > -14 ? smoothstep(-14, -3, e) * smoothstep(1.5, -1.5, e) : 0;
    const warmth = smoothstep(-9, -1, e);
    (s.uTwilightColor.value as THREE.Color).setRGB(lerp(0.012, 0.09, warmth), lerp(0.008, 0.04, warmth), lerp(0.02, 0.018, warmth));
    s.uTwilight.value = tw * (1 - L.overcast * 0.8);
    (s.uCelestial.value as THREE.Matrix3).setFromMatrix4(cel.celestial);
    s.uMilkyWay.value = (1 - cel.moonIllumination * 0.75) * (1 - L.cover * 0.6) * (1 - lp * 0.4);
    (s.uMoonDir.value as THREE.Vector3).copy(cel.moonDir);
    s.uMoonGlow.value = cel.moonIllumination * smoothstep(-2, 5, cel.moonElevation) * (1 - L.overcast * 0.6);
    s.uFlash.value = this.lightning.flash;
    s.uStorm.value = L.storm;
    s.sunDiscMax.value = 40 * (1 - L.overcast);
  }

  private updateClouds(u: EnvironmentUpdate, dt: number, windX: number, windZ: number, astroNight: number, L: WeatherLook): void {
    const sunCol = this.tmpC.copy(this.sun.color).multiplyScalar(this.sun.intensity * 0.27);
    const amb = this.tmpC2.copy(this.skyAmbient).multiplyScalar(lerp(0.55, 0.012, astroNight) * (1 - L.storm * 0.5));
    // light pollution lights cloud bases at night
    amb.r += 0.012 * this.lightPollution * astroNight;
    amb.g += 0.008 * this.lightPollution * astroNight;
    amb.b += 0.005 * this.lightPollution * astroNight;
    const base = amb.clone().multiplyScalar(0.62);
    const deckUnder = this.overcastColor.clone().multiplyScalar(1.05);
    const deckTop = sunCol.clone().addScalar(0.02).multiplyScalar(1.1).add(amb);
    this.clouds.update({
      dt,
      camera: u.camera,
      windX: windX * 1.8,
      windZ: windZ * 1.8,
      coverage: L.cover,
      baseY: L.cloudBase * FT,
      storm: L.storm > 0.5,
      sunDir: this.sunDirection,
      sunColor: sunCol,
      ambient: amb,
      baseColor: base,
      darken: 1 - L.storm * 0.5,
      flash: this.lightning.flash,
      deckUnder,
      deckTop,
    });
  }

  private fitShadow(lightDir: THREE.Vector3, focus: THREE.Vector3, radius: number): void {
    const cam = this.sun.shadow.camera;
    const r = Math.max(50, radius);
    const mapSize = this.sun.shadow.mapSize.x;
    const texel = (2 * r) / mapSize;
    // light-space basis
    const fwd = lightDir.clone().negate();
    const upRef = Math.abs(fwd.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, upRef).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
    // snap focus to texel grid (stable shadows while the camera moves)
    const fx = Math.round(focus.dot(right) / texel) * texel;
    const fy = Math.round(focus.dot(up) / texel) * texel;
    const fz = focus.dot(fwd);
    const snapped = new THREE.Vector3().addScaledVector(right, fx).addScaledVector(up, fy).addScaledVector(fwd, fz);
    const dist = 6000;
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(lightDir, dist);
    this.sun.target.updateMatrixWorld();
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = dist - Math.max(2500, r * 1.5);
    cam.far = dist + Math.max(2500, r * 1.5);
    cam.updateProjectionMatrix();
    this.sun.shadow.normalBias = texel * 0.6;
  }

  private maybeUpdateEnvMap(cel: CelestialState, astroNight: number, haze: number, L: WeatherLook): void {
    const k = this.envKey;
    const changed =
      this.first ||
      k.sun.angleTo(cel.sunDir) > 0.8 * DEG ||
      Math.abs(k.cover - L.cover) > 0.04 ||
      Math.abs(k.overcast - L.overcast) > 0.04 ||
      Math.abs(k.storm - L.storm) > 0.05 ||
      Math.abs(k.night - astroNight) > 0.03 ||
      Math.abs(k.haze - haze) > 0.05;
    if (!changed || (this.envTimer > 0 && !this.first)) return;
    this.envTimer = 1.2;
    k.sun.copy(cel.sunDir);
    k.cover = L.cover;
    k.overcast = L.overcast;
    k.storm = L.storm;
    k.night = astroNight;
    k.haze = haze;
    const prevTM = this.renderer.toneMapping;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.cubeCam.update(this.renderer, this.envScene);
    this.renderer.toneMapping = prevTM;
    this.pmremRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.pmremRT);
    this.scene.environment = this.pmremRT.texture;
  }

  dispose(): void {
    this.disposeWorld();
    this.scene.remove(this.root);
    this.sky.dispose();
    this.stars.dispose();
    this.moon.dispose();
    this.lightning.dispose();
    this.macroTex.dispose();
    this.waterNormals.dispose();
    this.cloudAtlas.dispose();
    this.cubeRT.dispose();
    this.pmremRT?.dispose();
    this.pmrem.dispose();
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.environment === this.pmremRT?.texture) this.scene.environment = null;
    this.sun.shadow.map?.dispose();
  }
}

export const createEnvironment: CreateEnvironment = (opts: EnvironmentOptions) => new Environment(opts);
export default createEnvironment;
