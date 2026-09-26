import type { QualityLevel } from '../../sim/types';
import type { TerrainQuality } from './Terrain';
import type { WaterMode } from './WaterSystem';

export interface EnvQualitySettings {
  shadowMapSize: number;
  terrain: TerrainQuality;
  water: WaterMode;
  mirrorSize: number;
  maxBuildings: number;
  streetLightSpacing: number;
  maxTrees: number;
  cloudPuffs: number;
  rainDrops: number;
  stars: number;
  envSize: number;
  detailSize: number;
  carDensity: number;
}

// Terrain rings: halfCells[l] must be a multiple of 3 for every ring that has a successor.
export const ENV_QUALITY: Record<QualityLevel, EnvQualitySettings> = {
  low: {
    shadowMapSize: 1024,
    terrain: { c0: 60, halfCells: [105, 78, 75, 63], tiles: 4 },
    water: 'pbr',
    mirrorSize: 256,
    maxBuildings: 3000,
    streetLightSpacing: 70,
    maxTrees: 3000,
    cloudPuffs: 1100,
    rainDrops: 3000,
    stars: 1500,
    envSize: 64,
    detailSize: 256,
    carDensity: 0.4,
  },
  medium: {
    shadowMapSize: 2048,
    terrain: { c0: 40, halfCells: [156, 114, 111, 90], tiles: 5 },
    water: 'pbr',
    mirrorSize: 512,
    maxBuildings: 7000,
    streetLightSpacing: 50,
    maxTrees: 8000,
    cloudPuffs: 2200,
    rainDrops: 6000,
    stars: 2500,
    envSize: 128,
    detailSize: 512,
    carDensity: 0.8,
  },
  high: {
    shadowMapSize: 4096,
    terrain: { c0: 30, halfCells: [210, 150, 150, 120], tiles: 6 },
    water: 'mirror',
    mirrorSize: 512,
    maxBuildings: 14000,
    streetLightSpacing: 40,
    maxTrees: 16000,
    cloudPuffs: 3800,
    rainDrops: 10000,
    stars: 3500,
    envSize: 128,
    detailSize: 512,
    carDensity: 1,
  },
  ultra: {
    shadowMapSize: 4096,
    terrain: { c0: 25, halfCells: [252, 150, 150, 150], tiles: 7 },
    water: 'mirror',
    mirrorSize: 1024,
    maxBuildings: 22000,
    streetLightSpacing: 34,
    maxTrees: 26000,
    cloudPuffs: 5600,
    rainDrops: 16000,
    stars: 4500,
    envSize: 256,
    detailSize: 1024,
    carDensity: 1.3,
  },
};
