import {
  DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET,
  DEFAULT_IRREGULAR_GA_GENERATION_BUDGET,
  DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT,
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularOptimizerSettings
} from './domain.js'
import type { IrregularWorkerMode } from './domain.js'
import type { NestingOptions } from '../domain/nesting.js'

export const IRREGULAR_WORKER_MODE: IrregularWorkerMode = 'irregular-convex-v2'
/** Covers the measured cold shared-archive mixed-61 decode with supervisor headroom. */
export const DEFAULT_IRREGULAR_WORKER_TIMEOUT_MS = 390_000

/** Raises only irregular jobs to their measured-safe worker timeout floor. */
export function workerTimeoutForMode(
  workerMode: NestingOptions['workerMode'],
  currentTimeoutMs: number
): number {
  return workerMode === IRREGULAR_WORKER_MODE
    ? Math.max(currentTimeoutMs, DEFAULT_IRREGULAR_WORKER_TIMEOUT_MS)
    : currentTimeoutMs
}

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

const BASE_IRREGULAR_OPTIMIZER_SETTINGS = new IrregularOptimizerSettings({
  orderWindow: 1,
  beamWidth: 1,
  localCandidateFanout: DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT,
  localRepairBudget: 0,
  intrinsicSharedArchiveEnabled: false,
  transformCap: 16,
  transformMinimumEdgeLengthMm: 1,
  transformAngleDeduplicationToleranceDeg: 0.01,
  configuredRotationEnabled: true,
  edgeAlignmentEnabled: true,
  configuredRotationDeg: [],
  baselineOnly: true,
  gaPopulation: 12,
  gaGenerationBudget: DEFAULT_IRREGULAR_GA_GENERATION_BUDGET,
  gaEvaluationBudget: DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET,
  gaTimeBudgetMs: 15_000,
  gaSeed: 'default',
  gaEnabled: false,
  priorityOrderMutationEnabled: true,
  transformPreferenceMutationEnabled: true,
  placementPolicyMutationEnabled: true,
  placementPolicyId: DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
  placementPolicyIds: [...DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS]
})

/** Concrete transform-source controls shared by an irregular optimizer preset. */
export interface IrregularTransformProfileDefinition {
  readonly transformCap: IrregularOptimizerSettings['transformCap']
  readonly configuredRotationEnabled: boolean
  readonly configuredRotationDeg: ReadonlyArray<number>
  readonly edgeAlignmentEnabled: boolean
}

/** Caller-owned overrides applied after a transform preset's concrete values. */
export type IrregularOptimizerSettingsOverrides = Partial<IrregularOptimizerSettings>

const FAST_IDENTITY_TRANSFORM_PROFILE = {
  transformCap: 1,
  configuredRotationEnabled: false,
  configuredRotationDeg: [],
  edgeAlignmentEnabled: false
} satisfies IrregularTransformProfileDefinition

const ORTHOGONAL_TRANSFORM_PROFILE = {
  transformCap: 4,
  configuredRotationEnabled: false,
  configuredRotationDeg: [],
  edgeAlignmentEnabled: false
} satisfies IrregularTransformProfileDefinition

const DERIVED_ORIENTATION_TRANSFORM_PROFILE = {
  transformCap: 16,
  configuredRotationEnabled: true,
  configuredRotationDeg: [],
  edgeAlignmentEnabled: true
} satisfies IrregularTransformProfileDefinition

const COMPACT_QUALITY_TRANSFORM_PROFILE = {
  transformCap: 8,
  configuredRotationEnabled: true,
  configuredRotationDeg: [],
  edgeAlignmentEnabled: true
} satisfies IrregularTransformProfileDefinition

function makeIrregularOptimizerSettings(
  profile: IrregularTransformProfileDefinition,
  overrides: IrregularOptimizerSettingsOverrides
): IrregularOptimizerSettings {
  return new IrregularOptimizerSettings({
    ...BASE_IRREGULAR_OPTIMIZER_SETTINGS,
    ...profile,
    ...overrides,
    configuredRotationDeg: [
      ...(overrides.configuredRotationDeg ?? profile.configuredRotationDeg)
    ],
    placementPolicyIds: [
      ...(overrides.placementPolicyIds ??
        BASE_IRREGULAR_OPTIMIZER_SETTINGS.placementPolicyIds ??
        DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS)
    ]
  })
}

/** Creates the fastest profile: identity only, with no extra angle sources. */
export function makeFastIdentityIrregularOptimizerSettings(
  overrides: IrregularOptimizerSettingsOverrides = {}
): IrregularOptimizerSettings {
  return makeIrregularOptimizerSettings(FAST_IDENTITY_TRANSFORM_PROFILE, overrides)
}

/** Creates the orthogonal profile: the four unmirrored quarter-turns only. */
export function makeOrthogonalIrregularOptimizerSettings(
  overrides: IrregularOptimizerSettingsOverrides = {}
): IrregularOptimizerSettings {
  return makeIrregularOptimizerSettings(ORTHOGONAL_TRANSFORM_PROFILE, overrides)
}

/** Creates the broader profile with configured and geometry-derived orientations enabled. */
export function makeDerivedOrientationIrregularOptimizerSettings(
  overrides: IrregularOptimizerSettingsOverrides = {}
): IrregularOptimizerSettings {
  return makeIrregularOptimizerSettings(DERIVED_ORIENTATION_TRANSFORM_PROFILE, overrides)
}

/** Creates the measured compact-quality profile with bounded terminal repair. */
export function makeCompactQualityIrregularOptimizerSettings(
  overrides: IrregularOptimizerSettingsOverrides = {}
): IrregularOptimizerSettings {
  return makeIrregularOptimizerSettings(COMPACT_QUALITY_TRANSFORM_PROFILE, {
    orderWindow: 4,
    beamWidth: 8,
    localCandidateFanout: 4,
    localRepairBudget: 0,
    intrinsicSharedArchiveEnabled: true,
    transformMinimumEdgeLengthMm: 1.2,
    transformAngleDeduplicationToleranceDeg: 0.051,
    baselineOnly: true,
    gaEnabled: false,
    placementPolicyId: 'edge-contact-then-balanced-compactness',
    ...overrides
  })
}

export const DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS =
  makeCompactQualityIrregularOptimizerSettings()

export const DEFAULT_IRREGULAR_NESTING_SETTINGS = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: DEFAULT_IRREGULAR_OPTIMIZER_SETTINGS
})

/** Creates an independent default profile for one editable irregular run. */
export function makeDefaultIrregularNestingSettings(): IrregularNestingSettings {
  const optimizer = makeCompactQualityIrregularOptimizerSettings()
  return new IrregularNestingSettings({
    geometry: new IrregularGeometrySettings({
      ...DEFAULT_IRREGULAR_GEOMETRY_SETTINGS
    }),
    optimizer: new IrregularOptimizerSettings({
      ...optimizer,
      configuredRotationDeg: [
        ...optimizer.configuredRotationDeg
      ],
      placementPolicyIds: [
        ...(optimizer.placementPolicyIds ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS)
      ]
    })
  })
}
