import type { AirportDef } from './types';
import { HPX } from './hpx';
import { LLBG } from './llbg';
import { KSFO } from './ksfo';

export const AIRPORTS: AirportDef[] = [HPX, LLBG, KSFO];
export const AIRPORT_BY_ID: Record<string, AirportDef> = Object.fromEntries(AIRPORTS.map((a) => [a.id, a]));
export { HPX, LLBG, KSFO };
