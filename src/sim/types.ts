// Shared simulation types consumed by render/audio/ui modules.

export type WakeCat = 'L' | 'M' | 'H' | 'J';
export type EngineKind = 'turbofan' | 'turboprop';
export type SizeClass = 'S' | 'M' | 'L' | 'H';
export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export type AircraftTypeId =
  | 'A320'
  | 'A321'
  | 'B738'
  | 'E175'
  | 'CRJ9'
  | 'AT76'
  | 'B789'
  | 'A359'
  | 'B77W'
  | 'B748'
  | 'A388'
  | 'C56X';

export interface AircraftLights {
  nav: boolean;
  beacon: boolean;
  strobe: boolean;
  landing: boolean;
  taxi: boolean;
  logo: boolean;
  cabin: boolean;
}

/**
 * Everything a renderer or audio engine needs to draw / voice one aircraft.
 * Positions are sim coordinates (x east m, y north m, altFt MSL).
 * Convert to world with simToWorld(x, y, altFt, fieldElevationFt). On the ground altFt == field elevation.
 */
export interface AircraftRenderState {
  readonly id: string;
  readonly typeId: AircraftTypeId;
  readonly airlineCode: string;
  readonly registration: string;
  readonly callsign: string;
  readonly x: number;
  readonly y: number;
  readonly altFt: number;
  /** Nose heading, degrees true (0 = north, 90 = east). */
  readonly hdg: number;
  /** Degrees, positive = nose up. */
  readonly pitch: number;
  /** Degrees, positive = right wing down. */
  readonly bank: number;
  readonly onGround: boolean;
  /** Ground speed in knots (signed: negative while being pushed back). */
  readonly gsKt: number;
  /** Velocity in m/s, sim axes (east, north, up). Used for doppler / effects. */
  readonly vel: { readonly x: number; readonly y: number; readonly z: number };
  /** 0 = retracted, 1 = fully down. Animated by the sim. */
  readonly gear: number;
  /** 0 = clean, 1 = full landing flaps. */
  readonly flaps: number;
  /** 0..1 spoilers / speed brakes. */
  readonly spoilers: number;
  /** 0..1 thrust reversers deployed. */
  readonly reverse: number;
  /** 0..1 engine thrust (N1-like). ~0.22 at idle when running, 0 when shut down. */
  readonly thrust: number;
  readonly enginesRunning: boolean;
  readonly lights: AircraftLights;
  /** True while a pushback tug is attached at the nose gear. */
  readonly tug: boolean;
  /** Sim time (s) of the most recent main-gear touchdown, -1 if none. For tire smoke. */
  readonly touchdownAt: number;
  /** Nose-wheel steering angle in degrees (for visuals), positive = right. */
  readonly steer: number;
}

export interface LightningStrike {
  id: number;
  /** Sim time (s) of the strike. */
  t: number;
  /** Sim coordinates (m). */
  x: number;
  y: number;
}

export type Precip = 'none' | 'rain' | 'storm';

export interface WeatherState {
  /** Direction wind is blowing FROM, degrees true. */
  windDir: number;
  /** Knots. */
  windSpeed: number;
  /** Gust peak in knots (0 = no gusts). */
  gust: number;
  /** Meteorological visibility in meters. */
  visibility: number;
  /** 0 = clear sky, 1 = overcast. */
  cloudCover: number;
  /** Cloud base in feet above field. */
  cloudBase: number;
  /** 0..1 rain intensity. */
  precipitation: number;
  thunderstorm: boolean;
  /** Celsius. */
  temperature: number;
  /** hPa. */
  qnh: number;
  /** Strikes from the last ~10 s of sim time, newest last. */
  lightning: LightningStrike[];
}

export const CLEAR_WEATHER: WeatherState = {
  windDir: 270,
  windSpeed: 8,
  gust: 0,
  visibility: 40000,
  cloudCover: 0.25,
  cloudBase: 4500,
  precipitation: 0,
  thunderstorm: false,
  temperature: 22,
  qnh: 1015,
  lightning: [],
};
