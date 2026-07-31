#!/usr/bin/env node
/**
 * Explicit production-acceptance gate for the native irregular backend.
 *
 * This command is a promotion check, not a production job path. It loads a
 * fixed complete fixture/profile matrix, preflights every row, runs
 * TypeScript first and Rust second for each row, and accepts exact parity or a
 * backend result that passes the independent quality policy.
 */
import { Effect } from 'effect'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ComputeIrregularNestingOptions,
  IrregularComputeResult
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import {
  executeIrregularQualityAcceptance,
  type IrregularQualityAcceptanceDependencies
} from '../../src/workers/irregular/differential/irregularQualityRunner.js'
import {
  makeCompactIrregularQualityPolicy,
  makeShortSideIrregularQualityPolicy,
  type IrregularQualityDifferentialResult,
  type IrregularQualityPolicy,
  type IrregularQualityThresholds
} from '../../src/workers/irregular/differential/irregularQualityAcceptance.js'
import {
  probeNativeIrregularAddon,
  type NativeCapabilityProbe
} from '../../src/workers/irregular/native/loadNativeBackend.js'
import type { NestingRequest } from '@shared/domain/nesting.js'
import type { IrregularNestingSettings, IrregularPreparedPiece } from '@shared/irregular/domain.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import {
  loadDifferentialRequest,
  runRustBackend,
  runTypeScriptBackend,
  type DifferentialArgs
} from './run-differential.js'

export type QualityAcceptanceProfile = 'compact' | 'short-side'
export type RequiredNativeProfile = 'compact' | 'compact-short-side'

export interface QualityAcceptanceFixtureRow {
  readonly id: string
  readonly fixture: 'triangle-20' | 'mixed61' | 'shapes-17'
  readonly sheet: '2000x2700'
  readonly profile: QualityAcceptanceProfile
  readonly minimumPlacedCount: number
  readonly maximumAreaMm2: number
  readonly maximumCanonicalCavities: number
  readonly maximumPositiveContactComponentCount: number
  readonly maximumIsolatedPieceCount: number
  readonly minimumLargestPositiveContactComponentSize: number
  readonly maximumOccupiedHullGapRatio: number
  readonly maximumOccupiedEnvelopeAspectRatio: number
}

/**
 * Maintained complete production fixture matrix. Every complete fixture runs
 * under both advertised native profiles. Truncated subsets and exploratory
 * rows belong to the diagnostic differential matrix, not this gate.
 */
export const QUALITY_ACCEPTANCE_ROWS: ReadonlyArray<QualityAcceptanceFixtureRow> = [
  {
    id: 'triangle-20-2000x2700-compact',
    fixture: 'triangle-20',
    sheet: '2000x2700',
    profile: 'compact',
    minimumPlacedCount: 20,
    maximumAreaMm2: 74_428.143126,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 11,
    maximumIsolatedPieceCount: 10,
    minimumLargestPositiveContactComponentSize: 10,
    maximumOccupiedHullGapRatio: 0.029711,
    maximumOccupiedEnvelopeAspectRatio: 3.199427
  },
  {
    id: 'triangle-20-2000x2700-short-side',
    fixture: 'triangle-20',
    sheet: '2000x2700',
    profile: 'short-side',
    minimumPlacedCount: 20,
    maximumAreaMm2: 133_623.888,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 20,
    maximumIsolatedPieceCount: 20,
    minimumLargestPositiveContactComponentSize: 1,
    maximumOccupiedHullGapRatio: 0.48718,
    maximumOccupiedEnvelopeAspectRatio: 23.333466
  },
  {
    id: 'mixed61-2000x2700-compact',
    fixture: 'mixed61',
    sheet: '2000x2700',
    profile: 'compact',
    minimumPlacedCount: 61,
    maximumAreaMm2: 391_605.850174,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 18,
    maximumIsolatedPieceCount: 7,
    minimumLargestPositiveContactComponentSize: 14,
    maximumOccupiedHullGapRatio: 0.137245,
    maximumOccupiedEnvelopeAspectRatio: 1.011548
  },
  {
    id: 'mixed61-2000x2700-short-side',
    fixture: 'mixed61',
    sheet: '2000x2700',
    profile: 'short-side',
    minimumPlacedCount: 61,
    maximumAreaMm2: 431_858,
    maximumCanonicalCavities: 1,
    maximumPositiveContactComponentCount: 36,
    maximumIsolatedPieceCount: 26,
    minimumLargestPositiveContactComponentSize: 9,
    maximumOccupiedHullGapRatio: 0.245072,
    maximumOccupiedEnvelopeAspectRatio: 9.262304
  },
  {
    id: 'shapes-17-2000x2700-compact',
    fixture: 'shapes-17',
    sheet: '2000x2700',
    profile: 'compact',
    minimumPlacedCount: 17,
    maximumAreaMm2: 281_233.148068,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 7,
    maximumIsolatedPieceCount: 4,
    minimumLargestPositiveContactComponentSize: 8,
    maximumOccupiedHullGapRatio: 0.100165,
    maximumOccupiedEnvelopeAspectRatio: 1.008984
  },
  {
    id: 'shapes-17-2000x2700-short-side',
    fixture: 'shapes-17',
    sheet: '2000x2700',
    profile: 'short-side',
    minimumPlacedCount: 17,
    maximumAreaMm2: 401_477.254496,
    maximumCanonicalCavities: 0,
    maximumPositiveContactComponentCount: 11,
    maximumIsolatedPieceCount: 8,
    minimumLargestPositiveContactComponentSize: 4,
    maximumOccupiedHullGapRatio: 0.400996,
    maximumOccupiedEnvelopeAspectRatio: 9.919733
  }
]

export interface QualityAcceptanceLoadedRow {
  readonly spec: QualityAcceptanceFixtureRow
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
}

export interface QualityAcceptanceRowResult {
  readonly row: QualityAcceptanceLoadedRow
  readonly result: IrregularQualityDifferentialResult
}

export interface QualityAcceptanceMatrixResult {
  readonly accepted: boolean
  readonly rows: ReadonlyArray<QualityAcceptanceRowResult>
}

export interface QualityAcceptanceLogger {
  readonly log: (...arguments_: ReadonlyArray<unknown>) => void
  readonly error: (...arguments_: ReadonlyArray<unknown>) => void
}

const DEFAULT_LOGGER: QualityAcceptanceLogger = {
  log: (...arguments_) => console.log(...arguments_),
  error: (...arguments_) => console.error(...arguments_)
}

export function requiredNativeProfileForQualityProfile(
  profile: QualityAcceptanceProfile
): RequiredNativeProfile {
  return profile === 'compact' ? 'compact' : 'compact-short-side'
}

export function qualityAcceptanceArgsForRow(row: QualityAcceptanceFixtureRow): DifferentialArgs {
  return {
    fixture: row.fixture,
    pieces: 'all',
    requestFile: undefined,
    sheet: row.sheet,
    profile: row.profile
  }
}

export async function loadQualityAcceptanceRows(
  rows: ReadonlyArray<QualityAcceptanceFixtureRow> = QUALITY_ACCEPTANCE_ROWS
): Promise<ReadonlyArray<QualityAcceptanceLoadedRow>> {
  return Promise.all(
    rows.map(async (spec) => {
      const request = await loadDifferentialRequest(qualityAcceptanceArgsForRow(spec))
      const settings = request.options.irregularSettings ?? GeometrySettings.Make
      return { spec, request, settings }
    })
  )
}

export function assertQualityAcceptancePreflight(input: {
  readonly rows: ReadonlyArray<QualityAcceptanceLoadedRow>
  readonly probe: NativeCapabilityProbe
}): void {
  const archiveFailures: string[] = []
  for (const row of input.rows) {
    const eligibility = intrinsicSharedArchiveEligibility(row.settings.optimizer)
    if (!eligibility.eligible) archiveFailures.push(`${row.spec.id}:${eligibility.reason}`)
  }
  if (archiveFailures.length > 0) {
    throw new Error(
      `quality acceptance archive preflight failed for ${archiveFailures.join(', ')}; no backend ran`
    )
  }
  if (!input.probe.available) {
    throw new Error(
      `native capability preflight failed (${input.probe.reason}): ${input.probe.detail}; no backend ran`
    )
  }
  const probe = input.probe
  const requiredProfiles = new Set(
    input.rows.map((row) => requiredNativeProfileForQualityProfile(row.spec.profile))
  )
  const missingProfiles = [...requiredProfiles].filter(
    (profile) => !probe.profiles.includes(profile)
  )
  if (missingProfiles.length > 0) {
    throw new Error(
      `native capability preflight missing profile(s) ${missingProfiles.join(', ')}; advertised=${input.probe.profiles.join(', ')}; no backend ran`
    )
  }
}

function policyForRow(
  row: QualityAcceptanceFixtureRow,
  request: NestingRequest
): IrregularQualityPolicy {
  const thresholds: IrregularQualityThresholds = {
    minimumPlacedCount: row.minimumPlacedCount,
    maximumAreaMm2: row.maximumAreaMm2,
    maximumCanonicalCavities: row.maximumCanonicalCavities,
    maximumPositiveContactComponentCount: row.maximumPositiveContactComponentCount,
    maximumIsolatedPieceCount: row.maximumIsolatedPieceCount,
    minimumLargestPositiveContactComponentSize: row.minimumLargestPositiveContactComponentSize,
    maximumOccupiedHullGapRatio: row.maximumOccupiedHullGapRatio,
    maximumOccupiedEnvelopeAspectRatio: row.maximumOccupiedEnvelopeAspectRatio
  }
  if (row.profile === 'compact') {
    return makeCompactIrregularQualityPolicy({
      thresholds,
      capacity: { kind: 'not-required' },
      cohesion: { kind: 'not-required' }
    })
  }
  return makeShortSideIrregularQualityPolicy({
    thresholds,
    capacity: { kind: 'not-required' },
    cohesion: { kind: 'not-required' },
    selectedPieceIds: request.pieces.map(({ id }) => String(id))
  })
}

export interface QualityAcceptanceExecutionDependencies extends IrregularQualityAcceptanceDependencies {
  readonly probe: NativeCapabilityProbe
}

function defaultExecutionDependencies(): QualityAcceptanceExecutionDependencies {
  return {
    probe: probeNativeIrregularAddon(),
    runTypeScript: (request, settings, options) => runTypeScriptBackend(request, settings, options),
    runRust: (request, settings, _options) => runRustBackend(request, settings)
  }
}

export function qualityAcceptanceExitCode(input: { readonly accepted: boolean }): 0 | 1 {
  return input.accepted ? 0 : 1
}

export async function executeQualityAcceptanceRow(input: {
  readonly row: QualityAcceptanceLoadedRow
  readonly dependencies?: QualityAcceptanceExecutionDependencies
}): Promise<QualityAcceptanceRowResult> {
  const dependencies = input.dependencies ?? defaultExecutionDependencies()
  const geometryAuthority: { value: ReadonlyArray<IrregularPreparedPiece> | undefined } = {
    value: undefined
  }
  const shortSideProductionGeometry: {
    value: IrregularComputeResult['placedCollisionGeometries'] | undefined
  } = { value: undefined }
  const shortSideDirectionalConstructionGeometry: {
    value: IrregularComputeResult['placedCollisionGeometries'] | undefined
  } = { value: undefined }
  const options: ComputeIrregularNestingOptions = {
    onPreparedPieces: (preparedPieces) => {
      geometryAuthority.value = preparedPieces
    },
    onIntrinsicShortSideProductionGeometry: (placedCollisionGeometries) => {
      shortSideProductionGeometry.value = placedCollisionGeometries
    },
    onIntrinsicShortSidePairFoldObserverWinner: (placedCollisionGeometries) => {
      shortSideDirectionalConstructionGeometry.value = placedCollisionGeometries
    }
  }
  const policy = policyForRow(input.row.spec, input.row.request)
  const result = await Effect.runPromise(
    executeIrregularQualityAcceptance({
      request: input.row.request,
      settings: input.row.settings,
      options,
      objectiveProfile: input.row.spec.profile,
      policy,
      geometryAuthority: [],
      geometryAuthorityProvider: () => geometryAuthority.value ?? [],
      shortSideAuthorityProvider: () =>
        shortSideProductionGeometry.value === undefined
          ? undefined
          : {
              productionPlacedCollisionGeometries: shortSideProductionGeometry.value,
              directionalConstructionPlacedCollisionGeometries:
                shortSideDirectionalConstructionGeometry.value
            },
      dependencies
    })
  )
  return { row: input.row, result }
}

export async function runQualityAcceptanceMatrix(input?: {
  readonly rows?: ReadonlyArray<QualityAcceptanceLoadedRow>
  readonly dependencies?: QualityAcceptanceExecutionDependencies
  readonly logger?: QualityAcceptanceLogger
}): Promise<QualityAcceptanceMatrixResult> {
  const logger = input?.logger ?? DEFAULT_LOGGER
  const rows = input?.rows ?? (await loadQualityAcceptanceRows())
  const dependencies = input?.dependencies ?? defaultExecutionDependencies()
  assertQualityAcceptancePreflight({ rows, probe: dependencies.probe })

  const results: QualityAcceptanceRowResult[] = []
  for (const row of rows) {
    logger.log(`[quality-acceptance] row=${row.spec.id}`)
    const loggedDependencies: QualityAcceptanceExecutionDependencies = {
      probe: dependencies.probe,
      runTypeScript: (request, settings, options) => {
        logger.log('[quality-acceptance] running TypeScript backend...')
        return dependencies.runTypeScript(request, settings, options)
      },
      runRust: (request, settings, options) => {
        logger.log('[quality-acceptance] running Rust backend (sequentially after TypeScript)...')
        return dependencies.runRust(request, settings, options)
      }
    }
    const executed = await executeQualityAcceptanceRow({ row, dependencies: loggedDependencies })
    const { result } = executed
    logger.log(
      `[quality-acceptance] backend execution: typescript=${result.backendFailures.includes('typescript') ? 'failed' : 'ran(identity=typescript)'} rust=${result.backendFailures.includes('rust') ? 'failed' : 'ran(identity=rust)'} category=${result.category}`
    )
    if (result.semanticDivergence !== undefined) {
      logger.error(
        `[quality-acceptance] FIRST DIVERGENCE at path: ${result.semanticDivergence.path}`
      )
      logger.error(`  typescript: ${JSON.stringify(result.semanticDivergence.typescript)}`)
      logger.error(`  rust: ${JSON.stringify(result.semanticDivergence.rust)}`)
    }
    if (!result.accepted) {
      logger.error(
        `[quality-acceptance] rejected row=${row.spec.id}: ${JSON.stringify({
          hardInvariantFailures: result.hardInvariantFailures,
          qualityRegressions: result.qualityRegressions,
          backendFailures: result.backendFailures
        })}`
      )
    } else {
      logger.log(`[quality-acceptance] accepted row=${row.spec.id}: ${result.category}`)
    }
    results.push(executed)
  }
  return {
    accepted: results.every(({ result }) => result.accepted),
    rows: results
  }
}

function fail(message: string): never {
  console.error(`[quality-acceptance] FAILED: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes('--help')) {
    console.log(
      'Usage: pnpm gate:quality-acceptance\n\nRuns the fixed complete triangle-20, mixed61, and shapes-17 matrix under compact and short-side profiles.'
    )
    return
  }
  if (process.argv.length > 2) {
    throw new Error(
      'This promotion gate has a fixed fixture/profile matrix and accepts no row overrides.'
    )
  }
  const matrix = await runQualityAcceptanceMatrix()
  if (qualityAcceptanceExitCode(matrix) !== 0) {
    fail('one or more mandatory fixture/profile rows failed quality acceptance')
  }
  console.log(`[quality-acceptance] OK: ${matrix.rows.length} mandatory rows accepted`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
  })
}
