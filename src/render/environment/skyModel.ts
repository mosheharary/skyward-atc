// CPU port of the Preetham sky used by the sky dome shader, for fog / hemisphere / sunlight colours.
import * as THREE from 'three';

const totalRayleigh = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MieConst = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const cutoffAngle = 1.6110731556870734;
const steepness = 1.5;
const EE = 1000;
const THREE_OVER_SIXTEENPI = 0.05968310365946075;
const ONE_OVER_FOURPI = 0.07957747154594767;

export interface SkyParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
}

function sunIntensity(zenithAngleCos: number): number {
  const c = Math.min(1, Math.max(-1, zenithAngleCos));
  return EE * Math.max(0, 1 - Math.exp(-((cutoffAngle - Math.acos(c)) / steepness)));
}

const _betaR = [0, 0, 0];
const _betaM = [0, 0, 0];

function coefficients(p: SkyParams): void {
  const c = 0.2 * p.turbidity * 10e-18;
  for (let i = 0; i < 3; i++) {
    _betaR[i] = totalRayleigh[i] * p.rayleigh;
    _betaM[i] = 0.434 * c * MieConst[i] * p.mieCoefficient;
  }
}

/** Extinction factor along a view direction (elevation from dir.y). */
export function extinction(dir: THREE.Vector3, p: SkyParams, out = new THREE.Color()): THREE.Color {
  coefficients(p);
  const zenithAngle = Math.acos(Math.max(0, dir.y));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = 8.4e3 * inv;
  const sM = 1.25e3 * inv;
  out.setRGB(
    Math.exp(-(_betaR[0] * sR + _betaM[0] * sM)),
    Math.exp(-(_betaR[1] * sR + _betaM[1] * sM)),
    Math.exp(-(_betaR[2] * sR + _betaM[2] * sM)),
  );
  return out;
}

/** Sky radiance (linear, same scale as the dome shader output before clouds) for a view direction. */
/** Preetham output scale so sky radiance is balanced against the sun / hemisphere light intensities. */
export const SKY_SCALE = 0.06;

export function skyRadiance(dir: THREE.Vector3, sunDir: THREE.Vector3, p: SkyParams, out = new THREE.Color()): THREE.Color {
  coefficients(p);
  const sunE = sunIntensity(sunDir.y);
  const zenithAngle = Math.acos(Math.max(0, dir.y));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = 8.4e3 * inv;
  const sM = 1.25e3 * inv;
  const cosTheta = dir.dot(sunDir);
  const rc = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + rc * rc);
  const g = p.mieDirectionalG;
  const g2 = g * g;
  const mPhase = ONE_OVER_FOURPI * ((1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5));
  const mixF = Math.min(1, Math.max(0, Math.pow(1 - sunDir.y, 5)));
  const res = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const fex = Math.exp(-(_betaR[i] * sR + _betaM[i] * sM));
    const ratio = (_betaR[i] * rPhase + _betaM[i] * mPhase) / (_betaR[i] + _betaM[i]);
    let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * fex, 0.5) - 1) * mixF;
    const l0 = 0.1 * fex;
    res[i] = (lin + l0) * 0.04 * SKY_SCALE;
  }
  out.setRGB(res[0], res[1] + 0.0003, res[2] + 0.00075);
  return out;
}

/** Relative intensity of the sun disc (0..1) given elevation (the Preetham earth-shadow cutoff). */
export function sunStrength(sunDirY: number): number {
  return sunIntensity(sunDirY) / EE;
}
