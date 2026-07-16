import { Effect, Layer } from 'effect'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importDxfFile } from '../src/main/services/DxfImportService.js'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import { makeDefaultIrregularNestingSettings } from '../src/shared/irregular/defaults.js'
import {
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  IrregularPlacementCandidate,
  IrregularPoint
} from '../src/shared/irregular/domain.js'
import type { IrregularLayoutScore } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import { DEFAULT_STRATEGY_ID } from '../src/shared/domain/strategies.js'
import {
  CollisionGeometryBuilder
} from '../src/workers/irregular/collisionGeometryBuilder.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import {
  createFreeMaterialService,
  type FreeMaterialOperation
} from '../src/workers/irregular/freeMaterialService.js'
import {
  DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  makeNfpIfpServiceLive,
  type NfpConstructionAlgorithm
} from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { PlacementValidation } from '../src/workers/irregular/placementValidation.js'
import type { IrregularPlacedPiece } from '../src/shared/irregular/domain.js'
import { FreeMaterialService } from '../src/workers/irregular/services.js'
import {
  computeIrregularNesting,
  type IrregularComputeResult
} from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import {
  IRREGULAR_DXF_FIXTURES,
  IRREGULAR_BENCHMARK_CORPUS,
  IRREGULAR_BENCHMARK_PROFILES,
  repeatImportedPieces
} from '../tests/fixtures/irregularBenchmarkFixtures.js'

const DEFAULT_FIXTURE_NAMES = ['triangle.dxf', 'trapezoid.dxf']
const DEFAULT_SHEET_WIDTH = 260
const DEFAULT_SHEET_HEIGHT = 100
const DEFAULT_PADDING = 0
const DEFAULT_REPEAT_COUNT = 1
const DEFAULT_WARMUP_COUNT = 1
const DEFAULT_RUN_COUNT = 5
const DEFAULT_FREE_MATERIAL_OPERATION: FreeMaterialOperation = 'union-then-difference'
const DEFAULT_NFP_CONSTRUCTION: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM

const flagAliases = new Map<string, string>([
  ['fixture', 'fixture'],
  ['fixtures', 'fixture'],
  ['sheet', 'sheet'],
  ['sheet-width', 'sheet-width'],
  ['sheet-height', 'sheet-height'],
  ['padding', 'padding'],
  ['piece-count', 'piece-count'],
  ['repeat-count', 'repeat-count'],
  ['order-window', 'order-window'],
  ['beam-width', 'beam-width'],
  ['local-candidate-fanout', 'local-candidate-fanout'],
  ['transform-cap', 'transform-cap'],
  ['free-material-operation', 'free-material-operation'],
  ['nfp-construction', 'nfp-construction'],
  ['profile', 'profile'],
  ['ga', 'ga-enabled'],
  ['ga-enabled', 'ga-enabled'],
  ['baseline-only', 'baseline-only'],
  ['ga-population', 'ga-population'],
  ['ga-generation-budget', 'ga-generation-budget'],
  ['ga-generations', 'ga-generation-budget'],
  ['ga-evaluation-budget', 'ga-evaluation-budget'],
  ['ga-evaluations', 'ga-evaluation-budget'],
  ['ga-time-budget-ms', 'ga-time-budget-ms'],
  ['ga-time-ms', 'ga-time-budget-ms'],
  ['ga-seed', 'ga-seed'],
  ['priority-order-mutation', 'priority-order-mutation'],
  ['transform-preference-mutation', 'transform-preference-mutation'],
  ['placement-policy-mutation', 'placement-policy-mutation'],
  ['warmup', 'warmup'],
  ['runs', 'runs'],
  ['help', 'help']
])

const booleanFlags = new Set([
  'ga-enabled',
  'baseline-only',
  'priority-order-mutation',
  'transform-preference-mutation',
  'placement-policy-mutation',
  'help'
])

interface RawArguments {
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>
}

export interface CliOptions {
  readonly profileId: string | undefined
  readonly fixtureNames: ReadonlyArray<string>
  readonly pieceCount: number | undefined
  readonly repeatCount: number
  readonly sheetWidth: number
  readonly sheetHeight: number
  readonly padding: number
  readonly orderWindow: number
  readonly beamWidth: number
  readonly localCandidateFanout: number
  readonly transformCap: number
  readonly freeMaterialOperation: FreeMaterialOperation
  readonly nfpConstruction: NfpConstructionAlgorithm
  readonly gaEnabled: boolean
  readonly baselineOnly: boolean
  readonly gaPopulation: number
  readonly gaGenerationBudget: number
  readonly gaEvaluationBudget: number
  readonly gaTimeBudgetMs: number
  readonly gaSeed: string
  readonly priorityOrderMutationEnabled: boolean
  readonly transformPreferenceMutationEnabled: boolean
  readonly placementPolicyMutationEnabled: boolean
  readonly warmupCount: number
  readonly runCount: number
}

export interface IrregularBenchmarkTimedRun {
  readonly elapsedMs: number
  readonly placedCount: number
  readonly unplacedCount: number
  readonly auditStatus: 'passed'
  readonly score: IrregularLayoutScore
  readonly portfolioSource: IrregularComputeResult['portfolio']['source']
  readonly portfolioStatus: IrregularComputeResult['portfolio']['status']
  readonly portfolioTerminationReason: IrregularComputeResult['portfolio']['terminationReason']
}

interface PreparedBenchmark {
  readonly options: CliOptions
  readonly sources: ReadonlyArray<ImportedPiece>
  readonly settings: IrregularNestingSettings
  readonly request: NestingRequest
}

export interface IrregularBenchmarkExecution {
  readonly profileId: string | undefined
  readonly fixtureNames: ReadonlyArray<string>
  readonly repeatCount: number
  readonly pieceCount: number
  readonly sourceCount: number
  readonly sheetWidth: number
  readonly sheetHeight: number
  readonly warmupRuns: ReadonlyArray<IrregularBenchmarkTimedRun>
  readonly measuredRuns: ReadonlyArray<IrregularBenchmarkTimedRun>
}

export interface IrregularBenchmarkScoreSummary {
  readonly unplacedCount: number
  readonly largestNetFreeMaterialRegionAreaMm2: number
  readonly freeMaterialRegionCount: number
  readonly freeMaterialHoleCount: number
  readonly freeMaterialSliverMetric: number
  readonly collisionBoundsWorstNormalizedSheetConsumption: number
  readonly collisionBoundsNormalizedSpanSum: number
  readonly collisionBoundsAreaMm2: number
  readonly collisionBoundsSpanMm: number
  readonly placementOrder: ReadonlyArray<string>
  readonly unplacedSourcePieceIds: ReadonlyArray<string>
}

export function summarizeBenchmarkScore(
  score: IrregularLayoutScore
): IrregularBenchmarkScoreSummary {
  return {
    unplacedCount: score.unplacedCount,
    largestNetFreeMaterialRegionAreaMm2: score.largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: score.freeMaterialRegionCount,
    freeMaterialHoleCount: score.freeMaterialHoleCount,
    freeMaterialSliverMetric: score.freeMaterialSliverMetric,
    collisionBoundsWorstNormalizedSheetConsumption:
      score.collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum: score.collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2: score.collisionBoundsAreaMm2,
    collisionBoundsSpanMm: score.collisionBoundsSpanMm,
    placementOrder: [...score.placementOrder],
    unplacedSourcePieceIds: [...score.unplacedSourcePieceIds]
  }
}

function usage(): string {
  return `Usage: pnpm benchmark:irregular [options]

Run the real DXF importer and irregular-convex-v2 worker algorithm.

Input:
  --profile <name>                  Named repeatable corpus/search profile
  --fixtures <name,...>             DXF fixture names (default: triangle.dxf,trapezoid.dxf)
  --fixture <name>                  Additional fixture; may be repeated
  --piece-count <n>                 Total pieces after repetition (default: all selected)
  --repeat-count <n>                Copies per fixture before limiting piece count (default: 1)
  --sheet <width>x<height>          Sheet dimensions in integer millimeters (default: 260x100)
  --sheet-width <n>                 Sheet width in integer millimeters
  --sheet-height <n>                Sheet height in integer millimeters
  --padding <n>                     Total integer clearance in millimeters (default: 0)

Search:
  --order-window <n>                Reordering window (default: 1)
  --beam-width <n>                  Retained beam states (default: 1)
  --local-candidate-fanout <n>      Legal local candidates per piece (default: 1)
  --transform-cap <n>               Transform candidates per piece (default: 1)
  --free-material-operation <value> Clipper operation (default: union-then-difference)
  --nfp-construction <value>        NFP construction (default: ${DEFAULT_NFP_CONSTRUCTION})

GA:
  --ga-enabled                      Enable the seeded GA portfolio
  --baseline-only                   Force deterministic beam-only mode
  --ga-population <n>               Chromosomes per generation (default: 12)
  --ga-generation-budget <n>        Maximum GA generations (default: 2)
  --ga-evaluation-budget <n>        Maximum chromosome evaluations (default: 24)
  --ga-time-budget-ms <n>           GA wall-clock budget (default: 15000)
  --ga-seed <text>                  Deterministic GA seed (default: default)
  --priority-order-mutation <bool>  Enable priority-order mutation (default: true)
  --transform-preference-mutation <bool>
                                    Enable transform-preference mutation (default: true)
  --placement-policy-mutation <bool>
                                    Enable placement-policy mutation (default: true)

Measurement:
  --warmup <n>                      Unmeasured warmup runs (default: 1)
  --runs <n>                        Measured runs (default: 5)
  --help                            Show this usage

Available fixtures:
  ${IRREGULAR_DXF_FIXTURES.join(', ')}

Available profiles:
  ${IRREGULAR_BENCHMARK_PROFILES.map(({ id, description }) => `${id}: ${description}`).join('\n  ')}
`
}

function addValue(values: Map<string, string[]>, name: string, value: string): void {
  const current = values.get(name)
  if (current === undefined) {
    values.set(name, [value])
    return
  }
  current.push(value)
}

function parseArguments(argumentsList: ReadonlyArray<string>): RawArguments {
  const values = new Map<string, string[]>()
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === undefined) continue
    if (!argument.startsWith('--') || argument === '--') {
      throw new Error(`Unexpected positional argument ${argument}. Use --help for usage.`)
    }

    const equalsIndex = argument.indexOf('=')
    const rawName = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex)
    const isNegated = rawName.startsWith('no-')
    const baseName = isNegated ? rawName.slice(3) : rawName
    const canonicalName = flagAliases.get(baseName)
    if (canonicalName === undefined) {
      throw new Error(`Unknown option --${rawName}. Use --help for usage.`)
    }
    if (isNegated && !booleanFlags.has(canonicalName)) {
      throw new Error(`Option --no-${baseName} is only valid for boolean flags.`)
    }

    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1)
    if (booleanFlags.has(canonicalName)) {
      if (isNegated && inlineValue !== undefined) {
        throw new Error(`Option --no-${baseName} does not accept a value.`)
      }
      const value = isNegated ? 'false' : (inlineValue ?? 'true')
      addValue(values, canonicalName, value)
      continue
    }

    const value = inlineValue ?? argumentsList[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${rawName} requires a value.`)
    }
    if (inlineValue === undefined) index += 1
    addValue(values, canonicalName, value)
  }
  return { values }
}

function valuesFor(argumentsData: RawArguments, name: string): ReadonlyArray<string> {
  return argumentsData.values.get(name) ?? []
}

function singleValue(argumentsData: RawArguments, name: string): string | undefined {
  const values = valuesFor(argumentsData, name)
  if (values.length > 1) {
    throw new Error(`Option --${name} may only be provided once.`)
  }
  return values[0]
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`Option --${name} expects true or false, received ${value}.`)
}

function optionalBoolean(
  argumentsData: RawArguments,
  name: string,
  defaultValue: boolean
): boolean {
  const value = singleValue(argumentsData, name)
  return value === undefined ? defaultValue : parseBoolean(value, name)
}

function parseInteger(value: string, name: string, minimum: number): number {
  if (!/^[+]?[0-9]+$/.test(value)) {
    throw new Error(`Option --${name} expects an integer >= ${minimum}, received ${value}.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Option --${name} expects an integer >= ${minimum}, received ${value}.`)
  }
  return parsed
}

function optionalInteger(
  argumentsData: RawArguments,
  name: string,
  defaultValue: number,
  minimum: number
): number {
  const value = singleValue(argumentsData, name)
  return value === undefined ? defaultValue : parseInteger(value, name, minimum)
}

function selectedProfile(argumentsData: RawArguments) {
  const profileId = singleValue(argumentsData, 'profile')
  if (profileId === undefined) return undefined
  const profile = IRREGULAR_BENCHMARK_PROFILES.find(({ id }) => id === profileId)
  if (profile === undefined) {
    throw new Error(
      `Unknown benchmark profile ${profileId}. Use --help to see the available profiles.`
    )
  }
  return profile
}

function corpusCaseForProfile(profileId: string | undefined) {
  if (profileId === undefined) return undefined
  const profile = IRREGULAR_BENCHMARK_PROFILES.find(({ id }) => id === profileId)
  if (profile === undefined) return undefined
  const corpusCase = IRREGULAR_BENCHMARK_CORPUS.find(({ id }) => id === profile.corpusCaseId)
  if (corpusCase === undefined) {
    throw new Error(`Benchmark profile ${profileId} references missing corpus case.`)
  }
  return corpusCase
}

function parseFixtureNames(
  argumentsData: RawArguments,
  defaultFixtureNames: ReadonlyArray<string>
): ReadonlyArray<string> {
  const values = valuesFor(argumentsData, 'fixture')
  const fixtureNames = values
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => (value.endsWith('.dxf') ? value : `${value}.dxf`))
  if (fixtureNames.length === 0) return defaultFixtureNames

  const knownFixtures = new Set<string>(IRREGULAR_DXF_FIXTURES)
  for (const fixtureName of fixtureNames) {
    if (!knownFixtures.has(fixtureName)) {
      throw new Error(
        `Unknown fixture ${fixtureName}. Use --help to see the available fixture names.`
      )
    }
  }
  return fixtureNames
}

function parseSheet(
  argumentsData: RawArguments,
  defaultWidth: number = DEFAULT_SHEET_WIDTH,
  defaultHeight: number = DEFAULT_SHEET_HEIGHT
): {
  readonly width: number
  readonly height: number
} {
  const sheetValue = singleValue(argumentsData, 'sheet')
  const widthValue = singleValue(argumentsData, 'sheet-width')
  const heightValue = singleValue(argumentsData, 'sheet-height')
  if (sheetValue !== undefined && (widthValue !== undefined || heightValue !== undefined)) {
    throw new Error('Use either --sheet or --sheet-width/--sheet-height, not both.')
  }
  if (sheetValue !== undefined) {
    const dimensions = sheetValue.toLowerCase().split('x')
    if (dimensions.length !== 2 || dimensions[0] === undefined || dimensions[1] === undefined) {
      throw new Error(`Option --sheet expects <width>x<height>, received ${sheetValue}.`)
    }
    return {
      width: parseInteger(dimensions[0], 'sheet width', 1),
      height: parseInteger(dimensions[1], 'sheet height', 1)
    }
  }
  return {
    width:
      widthValue === undefined
        ? defaultWidth
        : parseInteger(widthValue, 'sheet-width', 1),
    height:
      heightValue === undefined
        ? defaultHeight
        : parseInteger(heightValue, 'sheet-height', 1)
  }
}

function parseFreeMaterialOperation(
  argumentsData: RawArguments,
  defaultOperation: FreeMaterialOperation = DEFAULT_FREE_MATERIAL_OPERATION
): FreeMaterialOperation {
  const value = singleValue(argumentsData, 'free-material-operation')
  const operation = value ?? defaultOperation
  if (operation !== 'union-then-difference' && operation !== 'direct-difference') {
    throw new Error(
      'Option --free-material-operation expects union-then-difference or direct-difference.'
    )
  }
  return operation
}

function parseNfpConstruction(
  argumentsData: RawArguments,
  defaultConstruction: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION
): NfpConstructionAlgorithm {
  const value = singleValue(argumentsData, 'nfp-construction')
  const construction = value ?? defaultConstruction
  if (construction !== 'linear-edge-merge' && construction !== 'vertex-pair-hull') {
    throw new Error(
      'Option --nfp-construction expects linear-edge-merge or vertex-pair-hull.'
    )
  }
  return construction
}

function resolveOptions(argumentsData: RawArguments): CliOptions {
  const profile = selectedProfile(argumentsData)
  const corpusCase = corpusCaseForProfile(profile?.id)
  const defaults = makeDefaultIrregularNestingSettings().optimizer
  const sheet = parseSheet(
    argumentsData,
    corpusCase?.sheetWidth,
    corpusCase?.sheetHeight
  )
  const gaEnabledValue = singleValue(argumentsData, 'ga-enabled')
  const gaEnabled =
    gaEnabledValue === undefined
      ? profile?.gaEnabled ?? defaults.gaEnabled ?? false
      : parseBoolean(gaEnabledValue, 'ga-enabled')
  const baselineOnlyValue = singleValue(argumentsData, 'baseline-only')
  const baselineOnly =
    baselineOnlyValue !== undefined
      ? parseBoolean(baselineOnlyValue, 'baseline-only')
      : gaEnabledValue !== undefined
        ? !gaEnabled
        : profile?.baselineOnly ?? (gaEnabled ? false : (defaults.baselineOnly ?? true))
  if (gaEnabled && baselineOnly) {
    throw new Error('GA is enabled but --baseline-only is true; omit --baseline-only or set it false.')
  }
  const gaSeed = singleValue(argumentsData, 'ga-seed') ?? profile?.gaSeed ?? defaults.gaSeed
  if (gaSeed.trim().length === 0) {
    throw new Error('Option --ga-seed expects a non-empty value.')
  }

  return {
    profileId: profile?.id,
    fixtureNames: parseFixtureNames(
      argumentsData,
      corpusCase?.fixtureNames ?? DEFAULT_FIXTURE_NAMES
    ),
    pieceCount: (() => {
      const value = singleValue(argumentsData, 'piece-count')
      return value === undefined
        ? corpusCase?.pieceCount
        : parseInteger(value, 'piece-count', 1)
    })(),
    repeatCount: optionalInteger(
      argumentsData,
      'repeat-count',
      corpusCase?.repeatCount ?? DEFAULT_REPEAT_COUNT,
      1
    ),
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
    padding: optionalInteger(
      argumentsData,
      'padding',
      corpusCase?.padding ?? DEFAULT_PADDING,
      0
    ),
    orderWindow: optionalInteger(
      argumentsData,
      'order-window',
      profile?.orderWindow ?? defaults.orderWindow,
      1
    ),
    beamWidth: optionalInteger(
      argumentsData,
      'beam-width',
      profile?.beamWidth ?? defaults.beamWidth,
      1
    ),
    localCandidateFanout: optionalInteger(
      argumentsData,
      'local-candidate-fanout',
      profile?.localCandidateFanout ?? defaults.localCandidateFanout ?? 1,
      1
    ),
    transformCap: optionalInteger(
      argumentsData,
      'transform-cap',
      profile?.transformCap ?? defaults.transformCap,
      1
    ),
    freeMaterialOperation: parseFreeMaterialOperation(
      argumentsData,
      profile?.freeMaterialOperation
    ),
    nfpConstruction: parseNfpConstruction(argumentsData, profile?.nfpConstruction),
    gaEnabled,
    baselineOnly,
    gaPopulation: optionalInteger(
      argumentsData,
      'ga-population',
      profile?.gaPopulation ?? defaults.gaPopulation,
      1
    ),
    gaGenerationBudget: optionalInteger(
      argumentsData,
      'ga-generation-budget',
      profile?.gaGenerationBudget ?? defaults.gaGenerationBudget ?? 2,
      0
    ),
    gaEvaluationBudget: optionalInteger(
      argumentsData,
      'ga-evaluation-budget',
      profile?.gaEvaluationBudget ?? defaults.gaEvaluationBudget ?? 24,
      0
    ),
    gaTimeBudgetMs: optionalInteger(
      argumentsData,
      'ga-time-budget-ms',
      profile?.gaTimeBudgetMs ?? defaults.gaTimeBudgetMs,
      0
    ),
    gaSeed,
    priorityOrderMutationEnabled: optionalBoolean(
      argumentsData,
      'priority-order-mutation',
      profile?.priorityOrderMutationEnabled ?? defaults.priorityOrderMutationEnabled ?? true
    ),
    transformPreferenceMutationEnabled: optionalBoolean(
      argumentsData,
      'transform-preference-mutation',
      profile?.transformPreferenceMutationEnabled ??
        defaults.transformPreferenceMutationEnabled ??
        true
    ),
    placementPolicyMutationEnabled: optionalBoolean(
      argumentsData,
      'placement-policy-mutation',
      profile?.placementPolicyMutationEnabled ?? defaults.placementPolicyMutationEnabled ?? true
    ),
    warmupCount: optionalInteger(argumentsData, 'warmup', DEFAULT_WARMUP_COUNT, 0),
    runCount: optionalInteger(argumentsData, 'runs', DEFAULT_RUN_COUNT, 1)
  }
}

export function resolveBenchmarkOptions(argumentsList: ReadonlyArray<string>): CliOptions {
  return resolveOptions(parseArguments(argumentsList))
}

function makeSettings(options: CliOptions): IrregularNestingSettings {
  const defaults = makeDefaultIrregularNestingSettings()
  const optimizer = new IrregularOptimizerSettings({
    ...defaults.optimizer,
    orderWindow: options.orderWindow,
    beamWidth: options.beamWidth,
    localCandidateFanout: options.localCandidateFanout,
    transformCap: options.transformCap,
    gaEnabled: options.gaEnabled,
    baselineOnly: options.baselineOnly,
    gaPopulation: options.gaPopulation,
    gaGenerationBudget: options.gaGenerationBudget,
    gaEvaluationBudget: options.gaEvaluationBudget,
    gaTimeBudgetMs: options.gaTimeBudgetMs,
    gaSeed: options.gaSeed,
    priorityOrderMutationEnabled: options.priorityOrderMutationEnabled,
    transformPreferenceMutationEnabled: options.transformPreferenceMutationEnabled,
    placementPolicyMutationEnabled: options.placementPolicyMutationEnabled
  })
  return new IrregularNestingSettings({
    geometry: defaults.geometry,
    optimizer
  })
}

function makeRequest(
  sources: ReadonlyArray<import('../src/shared/domain/dxf.js').ImportedPiece>,
  options: CliOptions,
  settings: IrregularNestingSettings
): NestingRequest {
  const sheet = new SheetSpec({
    width: options.sheetWidth,
    height: options.sheetHeight,
    label: 'irregular-benchmark'
  })
  const jobId = JobId.make('irregular-benchmark')
  const prepared = preparePieces(sources, sheet, options.padding, jobId).pieces
  return new NestingRequest({
    version: 1,
    jobId,
    sheet,
    padding: options.padding,
    pieces: prepared,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 0,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [DEFAULT_STRATEGY_ID],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

function runIrregular(
  request: NestingRequest,
  settings: IrregularNestingSettings,
  freeMaterialOperation: FreeMaterialOperation,
  nfpConstruction: NfpConstructionAlgorithm
): Effect.Effect<IrregularComputeResult, unknown> {
  return computeIrregularNesting(request).pipe(
    Effect.provide(CollisionGeometryBuilder.Live),
    Effect.provide(TransformGeneratorLive),
    Effect.provide(makeNfpIfpServiceLive(nfpConstruction)),
    Effect.provide(IrregularPlacementScorer.Layer),
    Effect.provide(IrregularLayoutScorer.Layer),
    Effect.provide(
      Layer.succeed(FreeMaterialService, createFreeMaterialService(freeMaterialOperation))
    ),
    Effect.provide(GeometryKernel.Live),
    Effect.provide(Layer.succeed(GeometrySettings, settings))
  )
}

async function auditResult(
  result: IrregularComputeResult,
  request: NestingRequest
): Promise<'passed'> {
  const placedSoFar: IrregularPlacedPiece[] = []
  try {
    for (const placed of result.placedCollisionGeometries) {
      const candidate = new IrregularPlacementCandidate({
        pieceId: placed.placement.pieceId ?? placed.placement.sourcePieceId,
        transform: placed.collisionGeometry.transform,
        point: new IrregularPoint({
          x: placed.placement.transform.translateX,
          y: placed.placement.transform.translateY
        }),
        diagnostics: []
      })
      await Effect.runPromise(
        PlacementValidation.validate({
          sheet: request.sheet,
          placed: placedSoFar,
          moving: placed.collisionGeometry,
          candidate
        })
      )
      placedSoFar.push(placed)
    }
  } catch (error) {
    throw new Error(`Terminal placement audit failed: ${errorMessage(error)}`)
  }
  return 'passed'
}

async function measureRun(
  request: NestingRequest,
  settings: IrregularNestingSettings,
  freeMaterialOperation: FreeMaterialOperation,
  nfpConstruction: NfpConstructionAlgorithm
): Promise<IrregularBenchmarkTimedRun> {
  const startedAt = performance.now()
  const result = await Effect.runPromise(
    runIrregular(request, settings, freeMaterialOperation, nfpConstruction)
  )
  const elapsedMs = performance.now() - startedAt
  const auditStatus = await auditResult(result, request)
  return {
    elapsedMs,
    placedCount: result.placedCollisionGeometries.length,
    unplacedCount: result.unplacedPieceIds.length,
    auditStatus,
    score: result.score,
    portfolioSource: result.portfolio.source,
    portfolioStatus: result.portfolio.status,
    portfolioTerminationReason: result.portfolio.terminationReason
  }
}

async function importSources(
  fixtureNames: ReadonlyArray<string>,
  repoRoot: string
): Promise<ReadonlyArray<import('../src/shared/domain/dxf.js').ImportedPiece>> {
  const fixturesDirectory = join(repoRoot, 'tests', 'fixtures', 'dxf')
  const imported = await Promise.all(
    fixtureNames.map(async (fixtureName) => {
      const document = await importDxfFile(join(fixturesDirectory, fixtureName))
      const piece = document.pieces[0]
      if (piece === undefined) {
        throw new Error(`Fixture ${fixtureName} imported without a piece.`)
      }
      return piece
    })
  )
  return imported
}

export function normalizeImportedPieceIdentities(
  fixtureNames: ReadonlyArray<string>,
  sources: ReadonlyArray<ImportedPiece>
): ReadonlyArray<ImportedPiece> {
  if (fixtureNames.length !== sources.length) {
    throw new Error(
      `Cannot normalize ${sources.length} imported pieces for ${fixtureNames.length} fixtures.`
    )
  }

  return sources.map((source, index) => {
    const fixtureName = fixtureNames[index]
    if (fixtureName === undefined) {
      throw new Error(`Missing fixture name at imported piece index ${index}.`)
    }
    const identity = `${index + 1}-${fixtureName}`
    return new ImportedPiece({
      ...source,
      id: PieceId.make(`irregular-benchmark-piece-${identity}`),
      sourceFileId: SourceFileId.make(`irregular-benchmark-source-${identity}`)
    })
  })
}

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((first, second) => first - second)
  if (sorted.length === 0) {
    throw new Error('Cannot compute a median for an empty run list.')
  }
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) {
    const middleValue = sorted[middle]
    if (middleValue === undefined) {
      throw new Error('Cannot compute a median for an empty run list.')
    }
    return middleValue
  }
  const lower = sorted[middle - 1]
  const upper = sorted[middle]
  if (lower === undefined || upper === undefined) {
    throw new Error('Cannot compute a median for an empty run list.')
  }
  return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper
}

function countSummary(values: ReadonlyArray<number>): string {
  return `median=${median(values)} min=${Math.min(...values)} max=${Math.max(...values)}`
}

function formatElapsed(elapsedMs: number): string {
  return `${elapsedMs.toFixed(2)} ms`
}

function printRun(label: string, run: IrregularBenchmarkTimedRun): void {
  console.log(
    `${label}: ${formatElapsed(run.elapsedMs)} placed=${run.placedCount} ` +
      `unplaced=${run.unplacedCount} audit=${run.auditStatus} ` +
      `portfolio=${run.portfolioSource}/${run.portfolioStatus}/${run.portfolioTerminationReason ?? 'unknown'} ` +
      `score=${JSON.stringify(summarizeBenchmarkScore(run.score))}`
  )
}

async function prepareBenchmark(options: CliOptions, repoRoot: string): Promise<PreparedBenchmark> {
  const importedSources = await importSources(options.fixtureNames, repoRoot)
  const baseSources = normalizeImportedPieceIdentities(options.fixtureNames, importedSources)
  const repeatedSources = repeatImportedPieces(baseSources, options.repeatCount)
  const pieceCount = options.pieceCount ?? repeatedSources.length
  if (pieceCount > repeatedSources.length) {
    throw new Error(
      `Requested ${pieceCount} pieces, but --repeat-count ${options.repeatCount} produced only ` +
        `${repeatedSources.length} pieces from ${options.fixtureNames.length} fixtures.`
    )
  }
  const sources = repeatedSources.slice(0, pieceCount)
  const settings = makeSettings(options)
  return {
    options,
    sources,
    settings,
    request: makeRequest(sources, options, settings)
  }
}

async function executeBenchmark(
  options: CliOptions,
  repoRoot: string
): Promise<IrregularBenchmarkExecution> {
  const prepared = await prepareBenchmark(options, repoRoot)
  const warmupRuns: IrregularBenchmarkTimedRun[] = []
  for (let warmupIndex = 0; warmupIndex < options.warmupCount; warmupIndex += 1) {
    warmupRuns.push(
      await measureRun(
        prepared.request,
        prepared.settings,
        options.freeMaterialOperation,
        options.nfpConstruction
      )
    )
  }

  const measuredRuns: IrregularBenchmarkTimedRun[] = []
  for (let runIndex = 0; runIndex < options.runCount; runIndex += 1) {
    measuredRuns.push(
      await measureRun(
        prepared.request,
        prepared.settings,
        options.freeMaterialOperation,
        options.nfpConstruction
      )
    )
  }

  return {
    profileId: options.profileId,
    fixtureNames: options.fixtureNames,
    repeatCount: options.repeatCount,
    pieceCount: prepared.sources.length,
    sourceCount: prepared.sources.length,
    sheetWidth: options.sheetWidth,
    sheetHeight: options.sheetHeight,
    warmupRuns,
    measuredRuns
  }
}

export async function runNamedBenchmarkProfile(
  profileId: string
): Promise<IrregularBenchmarkExecution> {
  const options = resolveBenchmarkOptions([
    '--profile',
    profileId,
    '--warmup',
    '0',
    '--runs',
    '1'
  ])
  return executeBenchmark(options, dirname(dirname(fileURLToPath(import.meta.url))))
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function main(): Promise<void> {
  const rawArguments = parseArguments(process.argv.slice(2))
  if (valuesFor(rawArguments, 'help').length > 0) {
    console.log(usage())
    return
  }

  const options = resolveOptions(rawArguments)
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const execution = await executeBenchmark(options, repoRoot)
  const settings = makeSettings(options)

  console.log('Irregular benchmark')
  console.log(`profile=${options.profileId ?? 'custom'}`)
  console.log(`fixtures=${options.fixtureNames.join(',')} pieces=${execution.pieceCount}`)
  console.log(
    `sheet=${options.sheetWidth}x${options.sheetHeight} padding=${options.padding} ` +
      `orderWindow=${settings.optimizer.orderWindow} beamWidth=${settings.optimizer.beamWidth} ` +
      `localCandidateFanout=${settings.optimizer.localCandidateFanout} ` +
      `transformCap=${settings.optimizer.transformCap} ` +
      `freeMaterialOperation=${options.freeMaterialOperation} ` +
      `nfpConstruction=${options.nfpConstruction} ` +
      `gaTimeBudgetMs=${settings.optimizer.gaTimeBudgetMs}`
  )
  console.log(
    `gaEnabled=${settings.optimizer.gaEnabled} baselineOnly=${settings.optimizer.baselineOnly} ` +
      `warmup=${options.warmupCount} runs=${options.runCount}`
  )

  for (const [warmupIndex, warmup] of execution.warmupRuns.entries()) {
    printRun(`warmup ${warmupIndex + 1}/${options.warmupCount}`, warmup)
  }

  for (const [runIndex, measured] of execution.measuredRuns.entries()) {
    printRun(`run ${runIndex + 1}/${options.runCount}`, measured)
  }

  const elapsedValues = execution.measuredRuns.map((run) => run.elapsedMs)
  const placedValues = execution.measuredRuns.map((run) => run.placedCount)
  const unplacedValues = execution.measuredRuns.map((run) => run.unplacedCount)
  console.log(
    `summary elapsedMs median=${formatElapsed(median(elapsedValues))} ` +
      `min=${formatElapsed(Math.min(...elapsedValues))} ` +
      `max=${formatElapsed(Math.max(...elapsedValues))}`
  )
  console.log(`summary placed ${countSummary(placedValues)}`)
  console.log(`summary unplaced ${countSummary(unplacedValues)}`)
  const auditStatus = execution.measuredRuns.every((run) => run.auditStatus === 'passed')
    ? 'passed'
    : 'failed'
  console.log(`summary audit=${auditStatus}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(`Error: ${errorMessage(error)}`)
    console.error('Use --help for usage.')
    process.exitCode = 1
  })
}
