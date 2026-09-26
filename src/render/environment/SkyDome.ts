// Sky dome: Preetham scattering (from three/addons Sky.js r186) extended with a textured cloud deck,
// overcast blending, twilight glow, night sky + Milky Way, moon halo, horizon haze and lightning flash.
// Plus a twinkling star field and a phased moon sprite.
import * as THREE from 'three';
import { mulberry32 } from './noise';
import { SKY_SCALE } from './skyModel';

const skyVertex = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

#include <common>
#include <logdepthbuf_pars_vertex>

const float e = 2.71828182845904523536028747135266249775724709369995957;
const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
const float v = 4.0;
const vec3 K = vec3( 0.686, 0.678, 0.666 );
const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity( float zenithAngleCos ) {
  zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
  return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
}

vec3 totalMie( float T ) {
  float c = ( 0.2 * T ) * 10E-18;
  return 0.434 * c * MieConst;
}

void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;
  #include <logdepthbuf_vertex>
  vSunDirection = normalize( sunPosition );
  vSunE = sunIntensity( vSunDirection.y );
  vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );
  float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );
  vBetaR = totalRayleigh * rayleighCoefficient;
  vBetaM = totalMie( turbidity ) * mieCoefficient;
}
`;

const skyFragment = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float mieDirectionalG;
uniform float cloudScale;
uniform float cloudCoverage;
uniform float cloudDensity;
uniform float cloudElevation;
uniform vec2 cloudOffset;
uniform float cloudEvolve;
uniform float showSunDisc;
uniform float sunDiscMax;

uniform float uOvercast;
uniform vec3 uOvercastColor;
uniform vec3 uFogColor;
uniform float uHorizonHaze;
uniform float uNight;
uniform vec3 uNightZenith;
uniform vec3 uNightHorizon;
uniform vec3 uLightPollution;
uniform vec3 uTwilightColor;
uniform float uTwilight;
uniform mat3 uCelestial;
uniform float uMilkyWay;
uniform vec3 uMoonDir;
uniform float uMoonGlow;
uniform float uFlash;
uniform float uStorm;

#include <common>
#include <logdepthbuf_pars_fragment>

vec2 gradient2( vec2 i ) {
  vec3 p = fract( i.xyx * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.xx + p.yz ) * p.zy ) * 2.0 - 1.0;
}

float gnoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  float a = dot( gradient2( i ), f );
  float b = dot( gradient2( i + vec2( 1.0, 0.0 ) ), f - vec2( 1.0, 0.0 ) );
  float c = dot( gradient2( i + vec2( 0.0, 1.0 ) ), f - vec2( 0.0, 1.0 ) );
  float d = dot( gradient2( i + vec2( 1.0, 1.0 ) ), f - vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 1.6;
}

float fbm4( vec2 p, float drift ) {
  float result = 0.0;
  float amplitude = 1.0;
  for ( int i = 0; i < 4; i ++ ) {
    result += amplitude * gnoise( p );
    amplitude *= 0.5;
    p = p * 2.0 + drift;
  }
  return result;
}

const float n = 1.0003;
const float N = 2.545E25;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.99996;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase( float cosTheta ) {
  return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
}

float hgPhase( float cosTheta, float g ) {
  float g2 = pow( g, 2.0 );
  float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
  return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 direction = normalize( vWorldPosition - cameraPosition );
  float dirY = direction.y;
  vec3 dirUp = normalize( vec3( direction.x, max( dirY, 0.0 ), direction.z ) );

  float zenithAngle = acos( max( 0.0, dirY ) );
  float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / PI ), -1.253 ) );
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;
  vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

  float cosTheta = dot( dirUp, vSunDirection );
  float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase( cosTheta, mieDirectionalG );
  vec3 betaMTheta = vBetaM * mPhase;

  vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
  Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );

  vec3 L0 = vec3( 0.1 ) * Fex;
  float sundisc = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, dot( direction, vSunDirection ) ) * showSunDisc;
  vec3 sundiscColor = sundisc * min( vSunE * Fex * 0.25, vec3( sunDiscMax ) );

  vec3 texColor = ( Lin + L0 ) * ${(0.04 * SKY_SCALE).toFixed(6)} + vec3( 0.0, 0.0003, 0.00075 );

  // --- twilight glow (sun slightly below the horizon, beyond the Preetham cut-off)
  vec2 sunH = normalize( vSunDirection.xz + vec2( 1e-5 ) );
  vec2 dirH = normalize( direction.xz + vec2( 1e-5 ) );
  float azim = dot( sunH, dirH ) * 0.5 + 0.5;
  float twBand = exp( -max( dirY, 0.0 ) * 7.0 );
  texColor += uTwilightColor * uTwilight * twBand * ( 0.25 + 0.75 * azim * azim );

  // --- night sky
  if ( uNight > 0.0 ) {
    float h = clamp( dirY, 0.0, 1.0 );
    vec3 night = mix( uNightHorizon, uNightZenith, pow( h, 0.45 ) );
    night += uLightPollution * exp( -h * 9.0 );
    // Milky Way: band around the galactic plane in celestial coordinates
    vec3 cd = uCelestial * direction;
    vec3 galN = normalize( vec3( 0.46, 0.88, -0.12 ) );
    float g = abs( dot( cd, galN ) );
    float band = exp( -g * g * 38.0 );
    float mwn = fbm4( vec2( atan( cd.z, cd.x ) * 6.0, cd.y * 9.0 ), 0.0 ) * 0.5 + 0.5;
    night += vec3( 0.0022, 0.0024, 0.0030 ) * band * ( 0.35 + mwn ) * uMilkyWay * smoothstep( 0.0, 0.25, dirY );
    // moon halo
    float md = max( dot( direction, uMoonDir ), 0.0 );
    night += vec3( 0.010, 0.012, 0.016 ) * uMoonGlow * ( pow( md, 60.0 ) * 3.0 + pow( md, 8.0 ) * 0.35 );
    texColor = mix( texColor, texColor + night, uNight );
  }

  // --- cloud deck (textured, drifting with the wind)
  if ( dirY > 0.0 && cloudCoverage > 0.0 ) {
    float elevation = mix( 1.0, 0.1, cloudElevation );
    vec2 cloudUV = direction.xz / ( dirY * elevation );
    cloudUV *= cloudScale;
    cloudUV += cloudOffset;
    float cloudNoise = clamp( fbm4( cloudUV * 1000.0, cloudEvolve ) * 0.7 + 0.5, 0.0, 1.0 );
    float region = gnoise( cloudUV * 300.0 ) * 0.37 + 0.5;
    float cov = clamp( cloudCoverage + ( region - 0.5 ) * 0.6, 0.0, 1.0 );
    float threshold = 1.0 - cov;
    float cloudMask = smoothstep( threshold, threshold + 0.3, cloudNoise );
    float horizonFade = smoothstep( 0.0, 0.03 + 0.06 * cloudElevation, dirY );
    cloudMask *= horizonFade;
    float dayFactor = smoothstep( -0.08, 0.3, vSunDirection.y );
    vec3 sunColor = vSunE * Fex * 0.22 * ${(0.04 * SKY_SCALE).toFixed(6)};
    vec3 skyAmbient = Lin * ${(0.04 * SKY_SCALE).toFixed(6)} + vec3( 0.0, 0.0003, 0.00075 );
    float depth = max( 0.0, cloudNoise - threshold );
    float beer = exp( depth * -4.0 );
    float powder = 1.0 - beer * beer;
    float shade = mix( 0.45, 1.0, clamp( beer * powder * 2.6, 0.0, 1.0 ) );
    float silver = clamp( 0.51 / pow( 1.49 - cosTheta * 1.4, 1.5 ), 0.0, 3.0 );
    float edge = cloudMask * ( 1.0 - cloudMask ) * 4.0;
    vec3 cloudColor = skyAmbient + sunColor * shade;
    cloudColor += sunColor * silver * edge * 0.6;
    cloudColor *= max( dayFactor, 0.03 );
    cloudColor = mix( cloudColor, cloudColor * 0.4, uStorm );
    // night: clouds faintly lit by the ground (light pollution)
    cloudColor += uLightPollution * 0.6 * uNight;
    cloudColor += vec3( 0.55, 0.58, 0.75 ) * uFlash * 0.35;
    float alpha = ( 1.0 - exp( depth * cloudDensity * -12.0 ) ) * horizonFade;
    sundiscColor *= 1.0 - alpha;
    vec3 cloudAerial = mix( texColor, cloudColor, Fex );
    texColor = mix( texColor, cloudAerial, alpha );
  }

  // --- overcast: a uniform textured grey deck hides the sky and the sun
  if ( uOvercast > 0.0 ) {
    float ocMask = uOvercast * smoothstep( -0.02, 0.06, dirY );
    vec2 ocUV = direction.xz / max( dirY, 0.03 ) * 0.35 + cloudOffset * 4.0;
    float tex = fbm4( ocUV * 3.0, cloudEvolve * 0.5 ) * 0.5 + 0.5;
    float bright = 0.8 + 0.35 * tex + 0.25 * pow( max( cosTheta, 0.0 ), 3.0 ) * ( 1.0 - uStorm );
    vec3 oc = uOvercastColor * bright;
    oc += vec3( 0.6, 0.62, 0.8 ) * uFlash * 0.3 * ( 0.5 + tex );
    texColor = mix( texColor, oc, ocMask );
    sundiscColor *= 1.0 - ocMask;
  }

  texColor += sundiscColor;

  // --- horizon haze blends the sky into the fog colour (seamless with fogged terrain)
  float hz = uHorizonHaze * ( 1.0 - smoothstep( -0.02, 0.05 + 0.25 * uHorizonHaze, dirY ) );
  texColor = mix( texColor, uFogColor, clamp( hz, 0.0, 1.0 ) );
  if ( dirY < 0.0 ) texColor = mix( texColor, uFogColor, smoothstep( 0.0, -0.08, dirY ) );

  texColor += vec3( 0.25, 0.27, 0.34 ) * uFlash * 0.05;

  gl_FragColor = vec4( texColor, 1.0 );
}
`;

export interface SkyUniforms {
  [k: string]: THREE.IUniform;
}

function makeSkyUniforms(): SkyUniforms {
  return {
    sunPosition: { value: new THREE.Vector3(0, 1, 0) },
    rayleigh: { value: 2 },
    turbidity: { value: 4 },
    mieCoefficient: { value: 0.005 },
    mieDirectionalG: { value: 0.8 },
    cloudScale: { value: 0.0002 },
    cloudCoverage: { value: 0.3 },
    cloudDensity: { value: 0.5 },
    cloudElevation: { value: 0.5 },
    cloudOffset: { value: new THREE.Vector2() },
    cloudEvolve: { value: 0 },
    showSunDisc: { value: 1 },
    sunDiscMax: { value: 40 },
    uOvercast: { value: 0 },
    uOvercastColor: { value: new THREE.Color(0.2, 0.2, 0.22) },
    uFogColor: { value: new THREE.Color(0.5, 0.6, 0.7) },
    uHorizonHaze: { value: 0.3 },
    uNight: { value: 0 },
    uNightZenith: { value: new THREE.Color(0.0006, 0.0009, 0.0022) },
    uNightHorizon: { value: new THREE.Color(0.004, 0.006, 0.012) },
    uLightPollution: { value: new THREE.Color(0.006, 0.004, 0.002) },
    uTwilightColor: { value: new THREE.Color(0.08, 0.03, 0.01) },
    uTwilight: { value: 0 },
    uCelestial: { value: new THREE.Matrix3() },
    uMilkyWay: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonGlow: { value: 0 },
    uFlash: { value: 0 },
    uStorm: { value: 0 },
  };
}

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly envMesh: THREE.Mesh;
  readonly uniforms: SkyUniforms;
  readonly material: THREE.ShaderMaterial;
  readonly envMaterial: THREE.ShaderMaterial;

  constructor() {
    this.uniforms = makeSkyUniforms();
    this.material = new THREE.ShaderMaterial({
      name: 'SkyDome',
      uniforms: this.uniforms,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    // Environment capture variant: same uniforms except the sun disc is hidden (no hot spot in the PMREM).
    const envUniforms: SkyUniforms = { ...this.uniforms, showSunDisc: { value: 0 } };
    this.envMaterial = new THREE.ShaderMaterial({
      name: 'SkyDomeEnv',
      uniforms: envUniforms,
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.scale.setScalar(1000);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'SkyDome';
    this.envMesh = new THREE.Mesh(geo, this.envMaterial);
    this.envMesh.scale.setScalar(100);
    this.envMesh.frustumCulled = false;
  }

  /** Keep the dome around the camera (the shader forces it to the far plane). */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.envMaterial.dispose();
  }
}

// --- Stars -----------------------------------------------------------------------------------

const starVertex = /* glsl */ `
attribute float aMag;
attribute vec3 aColor;
attribute float aPhase;
uniform mat3 uCelestial;
uniform float uTime;
uniform float uVisibility;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vec3 dir = normalize( transpose( uCelestial ) * position );
  vec4 mv = viewMatrix * vec4( cameraPosition + dir * 5000.0, 1.0 );
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
  #include <logdepthbuf_vertex>
  float elev = dir.y;
  // twinkle: stronger near the horizon
  float tw = 0.75 + 0.25 * sin( uTime * ( 3.0 + aPhase * 5.0 ) + aPhase * 40.0 ) * ( 0.4 + 0.6 * ( 1.0 - clamp( elev * 3.0, 0.0, 1.0 ) ) );
  float ext = smoothstep( -0.02, 0.18, elev );
  vAlpha = uVisibility * aMag * tw * ext;
  vColor = aColor;
  gl_PointSize = ( 1.2 + aMag * 2.2 ) * uPixelRatio;
}
`;

const starFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  float a = exp( -r2 * 3.5 ) * vAlpha;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vColor * a * 0.9, 1.0 );
}
`;

export class StarField {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;

  constructor(count: number, seed = 1234) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const mag = new Float32Array(count);
    const col = new Float32Array(count * 3);
    const ph = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // uniform on sphere, denser along the galactic band
      let x = 0, y = 0, z = 0;
      for (;;) {
        const u = rnd() * 2 - 1;
        const t = rnd() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        x = s * Math.cos(t);
        y = u;
        z = s * Math.sin(t);
        const g = Math.abs(x * 0.46 + y * 0.88 - z * 0.12);
        if (rnd() < 0.55 + 0.45 * Math.exp(-g * g * 20)) break;
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      // magnitude distribution: many faint, few bright
      const m = Math.pow(rnd(), 3.2);
      mag[i] = 0.18 + m * 0.95;
      const temp = rnd();
      const c =
        temp < 0.15 ? [1.0, 0.78, 0.6] : temp < 0.35 ? [1.0, 0.92, 0.8] : temp < 0.8 ? [0.95, 0.97, 1.0] : [0.75, 0.85, 1.0];
      col[i * 3] = c[0];
      col[i * 3 + 1] = c[1];
      col[i * 3 + 2] = c[2];
      ph[i] = rnd();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    this.material = new THREE.ShaderMaterial({
      name: 'Stars',
      uniforms: {
        uCelestial: { value: new THREE.Matrix3() },
        uTime: { value: 0 },
        uVisibility: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: starVertex,
      fragmentShader: starFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -900;
    this.points.name = 'Stars';
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

// --- Moon ------------------------------------------------------------------------------------

const moonVertex = /* glsl */ `
uniform vec3 uMoonDir;
uniform float uSize;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vec3 center = cameraPosition + uMoonDir * 5000.0;
  vec3 camRight = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 camUp = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 p = center + ( camRight * position.x + camUp * position.y ) * uSize;
  gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
  gl_Position.z = gl_Position.w;
  #include <logdepthbuf_vertex>
}
`;

const moonFragment = /* glsl */ `
uniform vec3 uSunLocal;
uniform float uBrightness;
uniform float uHaze;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_fragment>
float h21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float vn( vec2 p ) {
  vec2 i = floor( p ); vec2 f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), f.x ), mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), f.x ), f.y );
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot( p, p );
  float glow = exp( -r2 * 2.5 ) * 0.08 * uHaze;
  vec3 col = vec3( 0.0 );
  float a = 0.0;
  if ( r2 < 0.36 ) {
    vec2 q = p / 0.6;
    float z = sqrt( max( 0.0, 1.0 - dot( q, q ) ) );
    vec3 nrm = vec3( q, z );
    float lit = smoothstep( -0.05, 0.12, dot( nrm, uSunLocal ) );
    float maria = vn( q * 3.2 + 4.0 ) * 0.6 + vn( q * 7.0 ) * 0.4;
    float alb = mix( 0.72, 1.0, smoothstep( 0.35, 0.65, maria ) );
    float limb = 0.75 + 0.25 * z;
    col = vec3( 1.0, 0.97, 0.9 ) * alb * limb * ( 0.03 + lit ) * uBrightness;
    a = smoothstep( 0.36, 0.33, r2 );
  }
  col += vec3( 0.7, 0.75, 0.85 ) * glow * uBrightness;
  gl_FragColor = vec4( col, 1.0 );
  gl_FragColor.rgb *= max( a, 0.0 ) + glow * 4.0;
}
`;

export class MoonSprite {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'Moon',
      uniforms: {
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uSize: { value: 95 },
        uSunLocal: { value: new THREE.Vector3(0, 0, 1) },
        uBrightness: { value: 1 },
        uHaze: { value: 1 },
      },
      vertexShader: moonVertex,
      fragmentShader: moonFragment,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -890;
    this.mesh.name = 'Moon';
  }

  /** Update phase shading: sun direction expressed in the moon sprite's (camera-facing) frame. */
  update(moonDir: THREE.Vector3, sunDir: THREE.Vector3, camera: THREE.Camera, brightness: number, haze: number): void {
    const u = this.material.uniforms;
    (u.uMoonDir.value as THREE.Vector3).copy(moonDir);
    // camera basis
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    const toCam = moonDir.clone().negate();
    const local = new THREE.Vector3(sunDir.dot(right), sunDir.dot(up), sunDir.dot(toCam));
    // The lit hemisphere faces the sun as seen from the moon; approximate with the sun vector
    // relative to the moon direction (phase angle).
    local.z = -moonDir.dot(sunDir);
    (u.uSunLocal.value as THREE.Vector3).copy(local.normalize());
    u.uBrightness.value = brightness;
    u.uHaze.value = haze;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
