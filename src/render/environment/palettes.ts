import * as THREE from 'three';
import type { GroundPalette } from '../../sim/airports/types';

export interface PaletteDef {
  grass: string;
  grassDry: string;
  soil: string;
  rock: string;
  sand: string;
  forestFloor: string;
  urban: string;
  airportGrass: string;
  airportGrassAlt: string;
  /** Crop / field colours for farmland patchwork. */
  crops: string[];
  /** Fraction of land that is farmland (0..1). */
  farmland: number;
  /** Fraction of dry grass patches. */
  dryness: number;
  tree: string[];
  /** 0 = broadleaf dominated, 1 = conifer dominated. */
  conifer: number;
  water: string;
  facade: string[];
  roof: string[];
}

export const PALETTES: Record<GroundPalette, PaletteDef> = {
  temperate: {
    grass: '#4f7a34',
    grassDry: '#7f8a45',
    soil: '#6b5438',
    rock: '#77736b',
    sand: '#cdbb8c',
    forestFloor: '#2e4a22',
    urban: '#8a8780',
    airportGrass: '#5c8a3a',
    airportGrassAlt: '#6a9843',
    crops: ['#6f9a3c', '#9fae4d', '#c6b25a', '#7b5e3c', '#58803a', '#a89a50', '#8c6e45'],
    farmland: 0.55,
    dryness: 0.2,
    tree: ['#2f5a27', '#3b6b2c', '#2a4f24', '#46702f'],
    conifer: 0.35,
    water: '#1d3b4f',
    facade: ['#b9b2a6', '#a69f94', '#c9c1b3', '#8e8a84', '#b8a48c'],
    roof: ['#5a5652', '#6b635a', '#7a4a3a', '#4b4d52'],
  },
  mediterranean: {
    grass: '#7d8646',
    grassDry: '#b3a262',
    soil: '#9a6e46',
    rock: '#a39580',
    sand: '#dcc9a0',
    forestFloor: '#4f5a33',
    urban: '#a79f90',
    airportGrass: '#8a9150',
    airportGrassAlt: '#99a05a',
    crops: ['#7f9447', '#b7a764', '#c9b27a', '#8b6440', '#5f7d3c', '#a58e5c', '#6d8a4a'],
    farmland: 0.45,
    dryness: 0.55,
    tree: ['#4d6a33', '#5b7a3c', '#3f5a2c', '#6f7f4a'],
    conifer: 0.45,
    water: '#16436b',
    facade: ['#e8e2d4', '#ddd4c2', '#f1ede4', '#cfc5b2', '#e6dccb'],
    roof: ['#b56a4a', '#8c867d', '#c7b9a3', '#9a5a42'],
  },
  coastal: {
    grass: '#66803f',
    grassDry: '#b39d5c',
    soil: '#80674a',
    rock: '#8a8479',
    sand: '#d6c7a2',
    forestFloor: '#3b4f2b',
    urban: '#95918a',
    airportGrass: '#7d8e46',
    airportGrassAlt: '#8b9a50',
    crops: ['#7a8f45', '#aa9a5a', '#8f7a4c', '#6a8a42', '#b8a86c'],
    farmland: 0.2,
    dryness: 0.5,
    tree: ['#3c5a2e', '#4b6634', '#2f4a28', '#5a6e3b'],
    conifer: 0.5,
    water: '#26475a',
    facade: ['#d8d4cc', '#c4bdb2', '#e6e1d8', '#b0aaa0', '#cfc6b8'],
    roof: ['#6b6760', '#7c746a', '#8e5e48', '#58595c'],
  },
  arid: {
    grass: '#9a8f5c',
    grassDry: '#c2ab74',
    soil: '#b48a5c',
    rock: '#a8876a',
    sand: '#e0c898',
    forestFloor: '#7a7148',
    urban: '#b8a88e',
    airportGrass: '#a89a64',
    airportGrassAlt: '#b3a46c',
    crops: ['#8a9a4c', '#c4ae76', '#b08a5a', '#9aa35a'],
    farmland: 0.12,
    dryness: 0.85,
    tree: ['#6b7440', '#7a7a48', '#5e6a3a'],
    conifer: 0.2,
    water: '#1f4d6e',
    facade: ['#e2d3b8', '#d4c3a4', '#eadcc4', '#c9b494'],
    roof: ['#b89a74', '#a08462', '#c8b490'],
  },
};

/** sRGB hex -> linear THREE.Color */
export function lin(hex: string): THREE.Color {
  return new THREE.Color(hex);
}
