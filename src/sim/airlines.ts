import type { AircraftTypeId } from './types';

export type LogoKind = 'wave' | 'compass' | 'leaf' | 'star' | 'sun' | 'chevron' | 'bird' | 'aurora' | 'diamond' | 'bolt' | 'ring' | 'arc';
export type LiveryStyle = 'classic' | 'modern' | 'bold' | 'minimal' | 'retro' | 'cargo';
/** Accent hint for the radio voice (maps to available TTS voices). */
export type VoiceAccent = 'us' | 'gb' | 'au' | 'ie' | 'za' | 'in';

export interface Livery {
  style: LiveryStyle;
  /** Upper fuselage colour. */
  body: string;
  /** Lower fuselage / belly colour. */
  belly: string;
  /** Tail fin main colour. */
  tail: string;
  /** Secondary tail colour (gradient / stripe). */
  tail2: string;
  /** Cheatline / stripe accent colour. */
  accent: string;
  /** Engine nacelle colour. */
  engine: string;
  /** Titles colour. */
  text: string;
  logo: LogoKind;
  logoColor: string;
}

export interface Airline {
  code: string;
  telephony: string;
  name: string;
  livery: Livery;
  /** Weighted fleet: repeated entries = more likely. */
  fleet: AircraftTypeId[];
  regPrefix: string;
  voice: VoiceAccent;
  cargo?: boolean;
  /** Airport ids where this is the home/base carrier (more traffic there). */
  hubs?: string[];
}

export const AIRLINES: Airline[] = [
  {
    code: 'AZR', telephony: 'AZURE', name: 'Azure Airways', regPrefix: 'N', voice: 'us',
    fleet: ['A320', 'A320', 'A321', 'A321', 'B789'],
    livery: { style: 'modern', body: '#f4f6f8', belly: '#f4f6f8', tail: '#0b3d91', tail2: '#1fb6ff', accent: '#1fb6ff', engine: '#0b3d91', text: '#0b3d91', logo: 'wave', logoColor: '#ffffff' },
  },
  {
    code: 'MRD', telephony: 'MERIDIAN', name: 'Meridian', regPrefix: 'G-', voice: 'gb',
    fleet: ['B738', 'B738', 'B77W', 'B789'],
    livery: { style: 'classic', body: '#f7f7f5', belly: '#c9ccd1', tail: '#b3122e', tail2: '#ffffff', accent: '#b3122e', engine: '#d9dde2', text: '#1b1f2a', logo: 'compass', logoColor: '#ffffff' },
  },
  {
    code: 'NVX', telephony: 'NOVEX', name: 'Novex Regional', regPrefix: 'N', voice: 'us',
    fleet: ['E175', 'E175', 'CRJ9'],
    livery: { style: 'bold', body: '#ffffff', belly: '#2d3436', tail: '#7ed321', tail2: '#2d3436', accent: '#7ed321', engine: '#2d3436', text: '#2d3436', logo: 'chevron', logoColor: '#ffffff' },
  },
  {
    code: 'CDR', telephony: 'CEDAR', name: 'Cedar Air', regPrefix: 'EI-', voice: 'ie',
    fleet: ['AT76', 'AT76', 'E175'],
    livery: { style: 'minimal', body: '#fbfbf6', belly: '#fbfbf6', tail: '#1e6b3a', tail2: '#8fd19e', accent: '#1e6b3a', engine: '#fbfbf6', text: '#1e6b3a', logo: 'leaf', logoColor: '#ffffff' },
  },
  {
    code: 'PLR', telephony: 'POLARIS', name: 'Polaris International', regPrefix: 'A6-', voice: 'gb',
    fleet: ['A388', 'B77W', 'A359', 'B77W'],
    livery: { style: 'retro', body: '#f3f1ea', belly: '#1c2541', tail: '#1c2541', tail2: '#d4af37', accent: '#d4af37', engine: '#1c2541', text: '#1c2541', logo: 'star', logoColor: '#d4af37' },
  },
  {
    code: 'SLS', telephony: 'SOLSTICE', name: 'Solstice', regPrefix: 'EC-', voice: 'us',
    fleet: ['A320', 'A321', 'B738', 'A320'],
    livery: { style: 'bold', body: '#ffffff', belly: '#ff7a00', tail: '#ff7a00', tail2: '#ffd000', accent: '#ff7a00', engine: '#ff7a00', text: '#ff7a00', logo: 'sun', logoColor: '#ffd000' },
  },
  {
    code: 'ZPH', telephony: 'ZEPHYR', name: 'Zephyr', regPrefix: 'VH-', voice: 'au',
    fleet: ['A320', 'B738', 'B789'],
    livery: { style: 'modern', body: '#e8f4fb', belly: '#e8f4fb', tail: '#63b8e8', tail2: '#ffffff', accent: '#2a7ab8', engine: '#ffffff', text: '#2a7ab8', logo: 'bird', logoColor: '#ffffff' },
  },
  {
    code: 'KST', telephony: 'KESTREL', name: 'Kestrel Cargo', regPrefix: 'N', voice: 'us', cargo: true,
    fleet: ['B748', 'B77W', 'B748'],
    livery: { style: 'cargo', body: '#ffffff', belly: '#6b7280', tail: '#4b1d8f', tail2: '#f5a623', accent: '#f5a623', engine: '#4b1d8f', text: '#4b1d8f', logo: 'bolt', logoColor: '#f5a623' },
  },
  {
    code: 'BRL', telephony: 'BOREAL', name: 'Boreal', regPrefix: 'SE-', voice: 'za',
    fleet: ['A359', 'A320', 'E175'],
    livery: { style: 'modern', body: '#fdfdfd', belly: '#fdfdfd', tail: '#3a1f5d', tail2: '#2ee6a6', accent: '#3a1f5d', engine: '#3a1f5d', text: '#3a1f5d', logo: 'aurora', logoColor: '#2ee6a6' },
  },
  {
    code: 'TLN', telephony: 'TALON', name: 'Talon Executive', regPrefix: 'N', voice: 'us',
    fleet: ['C56X'],
    livery: { style: 'minimal', body: '#f2f2f2', belly: '#3b3f46', tail: '#3b3f46', tail2: '#c0392b', accent: '#c0392b', engine: '#3b3f46', text: '#3b3f46', logo: 'diamond', logoColor: '#c0392b' },
  },
  {
    code: 'OCN', telephony: 'OCEANA', name: 'Oceana', regPrefix: 'ZK-', voice: 'au',
    fleet: ['B789', 'A359', 'A321'],
    livery: { style: 'modern', body: '#ffffff', belly: '#0f2a3d', tail: '#0f2a3d', tail2: '#00c2c7', accent: '#00c2c7', engine: '#0f2a3d', text: '#0f2a3d', logo: 'ring', logoColor: '#00c2c7' },
  },
  {
    code: 'HBR', telephony: 'HARBOR', name: 'Harbor Air', regPrefix: 'N', voice: 'us', hubs: ['HPX'],
    fleet: ['A320', 'E175', 'B738', 'AT76'],
    livery: { style: 'classic', body: '#ffffff', belly: '#ffffff', tail: '#004e64', tail2: '#25a18e', accent: '#004e64', engine: '#e8e8e8', text: '#004e64', logo: 'arc', logoColor: '#ffffff' },
  },
  {
    code: 'LVT', telephony: 'LEVANT', name: 'Levant Air', regPrefix: '4X-', voice: 'in', hubs: ['LLBG'],
    fleet: ['B738', 'B789', 'B77W', 'A320'],
    livery: { style: 'classic', body: '#ffffff', belly: '#ffffff', tail: '#0038b8', tail2: '#ffffff', accent: '#0038b8', engine: '#ffffff', text: '#0038b8', logo: 'star', logoColor: '#ffffff' },
  },
  {
    code: 'GGA', telephony: 'GOLDEN', name: 'Golden Bay Airlines', regPrefix: 'N', voice: 'us', hubs: ['KSFO'],
    fleet: ['A320', 'A321', 'B789', 'B77W', 'B738'],
    livery: { style: 'bold', body: '#ffffff', belly: '#c0392b', tail: '#c0392b', tail2: '#f39c12', accent: '#c0392b', engine: '#c0392b', text: '#c0392b', logo: 'sun', logoColor: '#f39c12' },
  },
];

export const AIRLINE_BY_CODE: Record<string, Airline> = Object.fromEntries(AIRLINES.map((a) => [a.code, a]));
