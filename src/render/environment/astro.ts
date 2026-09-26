// Simplified solar / lunar ephemeris (NOAA-style), good to ~0.5 deg - plenty for rendering.
import * as THREE from 'three';

const DEG = Math.PI / 180;

export interface CelestialState {
  /** World-space unit vector to the sun (X east, Y up, Z south). */
  sunDir: THREE.Vector3;
  /** World-space unit vector to the moon. */
  moonDir: THREE.Vector3;
  /** Sun elevation in degrees. */
  sunElevation: number;
  moonElevation: number;
  /** 0 = new, 0.5 = full, 1 = new. */
  moonPhase: number;
  /** Illuminated fraction of the lunar disc 0..1. */
  moonIllumination: number;
  /** Rotation from equatorial star coordinates to world (for the star field). */
  celestial: THREE.Matrix4;
}

/** East/North/Up -> world (X east, Y up, Z south). */
function enuToWorld(e: number, n: number, u: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(e, u, -n).normalize();
}

/** Direction for a body with hour angle `ha` and declination `decl` (radians) at latitude `lat`. */
function hourAngleToWorld(ha: number, decl: number, lat: number, out: THREE.Vector3): THREE.Vector3 {
  const up = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const east = -Math.cos(decl) * Math.sin(ha);
  const north = Math.sin(decl) * Math.cos(lat) - Math.cos(decl) * Math.cos(ha) * Math.sin(lat);
  return enuToWorld(east, north, up, out);
}

export function computeCelestial(
  latDeg: number,
  lonDeg: number,
  utcOffset: number,
  dayOfYear: number,
  timeOfDaySec: number,
  out?: CelestialState,
): CelestialState {
  const st: CelestialState = out ?? {
    sunDir: new THREE.Vector3(),
    moonDir: new THREE.Vector3(),
    sunElevation: 0,
    moonElevation: 0,
    moonPhase: 0,
    moonIllumination: 0,
    celestial: new THREE.Matrix4(),
  };
  const lat = latDeg * DEG;
  const localHours = timeOfDaySec / 3600;
  let utcHours = localHours - utcOffset;
  let doy = dayOfYear;
  if (utcHours < 0) {
    utcHours += 24;
    doy -= 1;
  } else if (utcHours >= 24) {
    utcHours -= 24;
    doy += 1;
  }
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (utcHours - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const tst = utcHours * 60 + eqtime + 4 * lonDeg; // true solar time, minutes
  const ha = (tst / 4 - 180) * DEG;
  hourAngleToWorld(ha, decl, lat, st.sunDir);
  st.sunElevation = Math.asin(THREE.MathUtils.clamp(st.sunDir.y, -1, 1)) / DEG;

  // Moon: synodic month from a reference new moon (Jan 6 2000 18:14 UTC ~ day 6.76).
  const days = doy + utcHours / 24;
  const synodic = 29.530588853;
  const phase = ((((days - 6.76 + 365.25 * 26) / synodic) % 1) + 1) % 1;
  st.moonPhase = phase;
  st.moonIllumination = 0.5 * (1 - Math.cos(phase * 2 * Math.PI));
  // The moon trails the sun by `phase` of a day in hour angle; declination swings opposite at full moon.
  const moonHa = ha - phase * 2 * Math.PI;
  const moonDecl = decl * Math.cos(phase * 2 * Math.PI) + 5.1 * DEG * Math.sin(days * 0.2299);
  hourAngleToWorld(moonHa, moonDecl, lat, st.moonDir);
  st.moonElevation = Math.asin(THREE.MathUtils.clamp(st.moonDir.y, -1, 1)) / DEG;

  // Star field: rotate equatorial frame by local sidereal angle around the pole, tilt by latitude.
  // Equatorial basis: Y = north celestial pole, X/Z in the equatorial plane.
  const siderealAngle = ((tst / 1440) * 2 * Math.PI + (doy / 365.2422) * 2 * Math.PI) % (2 * Math.PI);
  const rotSpin = new THREE.Matrix4().makeRotationY(-siderealAngle);
  // Tilt: the pole sits at elevation = latitude towards north (world -Z).
  const rotTilt = new THREE.Matrix4().makeRotationX(-(Math.PI / 2 - lat));
  st.celestial.multiplyMatrices(rotTilt, rotSpin);
  return st;
}
