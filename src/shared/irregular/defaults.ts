import {
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularOptimizerSettings
} from './domain.js'
import type { IrregularWorkerMode } from './domain.js'

export const IRREGULAR_WORKER_MODE: IrregularWorkerMode = 'irregular-convex-v2'

export const DEFAULT_FLATTENING_SAG_TOLERANCE_MM = 0.25
export const HIGH_PRECISION_FLATTENING_SAG_TOLERANCE_MM = 0.1
export const COARSE_FLATTENING_SAG_TOLERANCE_MM = 0.5

export const DEFAULT_IRREGULAR_GEOMETRY_SETTINGS = new IrregularGeometrySettings({
  flatteningSagToleranceMm: DEFAULT_FLATTENING_SAG_TOLERANCE_MM,
  clearanceSafetyMarginMm: Math.max(
    DEFAULT_FLATTENING_SAG_TOLERANCE_MM,
    DEFAULT_FLATTENING_SAG_TOLERANCE_MM
  ),
  geometryBackendId: 'irregular-convex-v2-default',
  geometryBackendVersion: '0'
})

export const DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS = new IrregularOptimizerSettings({
  orderWindow: 2,
  beamWidth: 24,
  transformCap: 16,
  transformMinimumEdgeLengthMm: 1,
  transformAngleDeduplicationToleranceDeg: 0.01,
  configuredRotationDeg: [],
  gaPopulation: 32,
  gaTimeBudgetMs: 60_000,
  gaSeed: 'default'
})

export const DEFAULT_IRREGULAR_NESTING_SETTINGS = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS
})
