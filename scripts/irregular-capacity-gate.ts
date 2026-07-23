import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Effect, Layer, Schema } from 'effect'
import { ImportedPiece } from '../src/shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '../src/shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '../src/shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '../src/shared/irregular/defaults.js'
import { IrregularNestingSettings } from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument, type PresetShapeKind } from '../src/shared/presetShapes.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import {
  computeIrregularNesting,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult
} from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import {
  compareIntrinsicCapacityObjectives,
  type IntrinsicCapacityObjective
} from '../src/workers/algorithm/irregular/intrinsicCapacityEndpoint.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from './lib/irregularLayoutCanonicalization.js'

interface CapacityShapeSpec {
  readonly kind: PresetShapeKind
  readonly width: number
  readonly height: number
  readonly topWidth?: number
  readonly count: number
}

interface CapacityFixture {
  readonly id: string
  readonly source: 'preset' | 'mixed-61'
  readonly shapes: ReadonlyArray<CapacityShapeSpec>
  readonly paddingMm: number
  readonly sheet: SheetSpec
  readonly expectedRouting:
    | 'preflight-proven-impossible'
    | 'bounded-complete-archive-miss'
    | undefined
  readonly expectedPlacedCount: number | undefined
  readonly pairedEligible: boolean
  /** Allows expected shell-side preparation warnings such as piece_does_not_fit. */
  readonly allowPrepareWarnings?: boolean
}

const MIXED_61_FIXTURE = fileURLToPath(
  new URL('../tests/fixtures/irregularSheetInvariance/mixed61-request.json', import.meta.url)
)

const fixtures: ReadonlyArray<CapacityFixture> = [
  {
    id: 'capacity-area-proven-rect2',
    source: 'preset',
    shapes: [{ kind: 'rectangle', width: 80, height: 60, count: 2 }],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
    expectedRouting: 'preflight-proven-impossible',
    expectedPlacedCount: 1,
    pairedEligible: false
  },
  {
    id: 'capacity-singleton-proven',
    source: 'preset',
    shapes: [
      { kind: 'rectangle', width: 150, height: 20, count: 1 },
      { kind: 'rectangle', width: 90, height: 20, count: 1 }
    ],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
    expectedRouting: 'preflight-proven-impossible',
    expectedPlacedCount: 1,
    pairedEligible: false,
    allowPrepareWarnings: true
  },
  {
    id: 'capacity-archive-miss-squares2',
    source: 'preset',
    shapes: [{ kind: 'rectangle', width: 55, height: 55, count: 2 }],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
    expectedRouting: 'bounded-complete-archive-miss',
    expectedPlacedCount: 1,
    pairedEligible: true
  },
  {
    id: 'capacity-count-vs-material',
    source: 'preset',
    shapes: [
      { kind: 'rectangle', width: 90, height: 90, count: 1 },
      { kind: 'rectangle', width: 50, height: 45, count: 2 }
    ],
    paddingMm: 0,
    sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
    expectedRouting: undefined,
    expectedPlacedCount: 2,
    pairedEligible: true
  },
  {
    id: 'capacity-triangles20-300x300',
    source: 'preset',
    shapes: [{ kind: 'triangle', width: 70, height: 60, count: 20 }],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 300, height: 300, label: 'constrained 300x300' }),
    expectedRouting: undefined,
    expectedPlacedCount: undefined,
    pairedEligible: true
  },
  {
    id: 'capacity-mixed61-500x400',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 500, height: 400, label: 'constrained 500x400' }),
    expectedRouting: undefined,
    expectedPlacedCount: undefined,
    pairedEligible: true
  },
  {
    id: 'capacity-mixed61-700x560',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 700, height: 560, label: 'constrained 700x560' }),
    expectedRouting: undefined,
    expectedPlacedCount: undefined,
    pairedEligible: true
  }
]

function makePresetRequest(fixture: CapacityFixture): NestingRequest {
  const sources: ImportedPiece[] = []
  for (const shape of fixture.shapes) {
    const preset = makePresetShapeDocument({
      kind: shape.kind,
      width: shape.width,
      height: shape.height,
      ...(shape.topWidth === undefined ? {} : { topWidth: shape.topWidth }),
      label: shape.kind
    })
    const piece = preset.pieces[0]
    if (piece === undefined) throw new Error(`${fixture.id}: preset must contain one piece`)
    for (let index = 0; index < shape.count; index += 1) {
      const key = `${shape.kind}-${shape.width}x${shape.height}-copy-${index + 1}`
      sources.push(
        new ImportedPiece({
          ...piece,
          id: PieceId.make(`${key}`),
          sourceFileId: SourceFileId.make(`source-${key}`),
          label: key
        })
      )
    }
  }
  const jobId = JobId.make(fixture.id)
  const prepared = preparePieces(
    sources,
    fixture.sheet,
    fixture.paddingMm,
    jobId,
    undefined,
    undefined,
    (piece) => piece.label ?? piece.id
  )
  if (prepared.warnings.length > 0 && fixture.allowPrepareWarnings !== true) {
    throw new Error(`${fixture.id}: preparePieces warnings ${JSON.stringify(prepared.warnings)}`)
  }
  const settings = new IrregularNestingSettings({
    geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
    optimizer: makeCompactQualityIrregularOptimizerSettings()
  })
  return new NestingRequest({
    version: 1,
    jobId,
    sheet: fixture.sheet,
    padding: fixture.paddingMm,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 0,
      workerMode: 'irregular-convex-v2',
      historyMode: 'off',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

async function makeFixtureRequest(fixture: CapacityFixture): Promise<NestingRequest> {
  if (fixture.source === 'preset') return makePresetRequest(fixture)
  const document: unknown = JSON.parse(await readFile(MIXED_61_FIXTURE, 'utf8'))
  const request = Schema.decodeUnknownSync(NestingRequest)(document)
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${fixture.id}: fixture has no irregular settings`)
  return new NestingRequest({
    ...request,
    jobId: JobId.make(fixture.id),
    sheet: fixture.sheet,
    options: new NestingOptions({
      ...request.options,
      timeoutMs: 0,
      historyMode: 'off',
      irregularSettings: settings
    })
  })
}

function absoluteCollisionPolygons(
  result: IrregularComputeResult
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return result.placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function renderSvg(
  sheet: SheetSpec,
  polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>
): string {
  const margin = Math.max(20, Math.max(sheet.width, sheet.height) * 0.04)
  const viewMinX = -margin
  const viewMinY = -sheet.height - margin
  const viewWidth = sheet.width + margin * 2
  const viewHeight = sheet.height + margin * 2
  const paths = polygons
    .map((polygon) => `<polygon points="${polygon.map(({ x, y }) => `${x},${-y}`).join(' ')}"/>`)
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewMinX} ${viewMinY} ${viewWidth} ${viewHeight}" width="1000" height="${Math.round((1000 * viewHeight) / viewWidth)}">`,
    `<rect x="${viewMinX}" y="${viewMinY}" width="${viewWidth}" height="${viewHeight}" fill="#1b2328"/>`,
    `<rect x="0" y="${-sheet.height}" width="${sheet.width}" height="${sheet.height}" fill="#141b20" stroke="#9aa7b0" stroke-width="1.5" stroke-dasharray="6 4"/>`,
    `<g fill="#22313b" stroke="#39a9ff" stroke-width="1">${paths}</g>`,
    `</svg>`
  ].join('')
}

interface CapacityRunReport {
  readonly arm: 'production' | 'cold-only'
  readonly elapsedMs: number
  readonly routing: string | undefined
  readonly preflight:
    | { readonly kind: string; readonly reason?: string }
    | undefined
  readonly placedCount: number
  readonly unplacedCount: number
  readonly unplacedPieceIds: ReadonlyArray<string>
  readonly partitionExact: boolean
  readonly canonicalSha256: string | undefined
  readonly terminationReason: string | undefined
  readonly capacity:
    | {
        readonly prefixes: unknown
        readonly prefixIncumbent: unknown
        readonly coldSearch: unknown
        readonly selected: IntrinsicCapacityObjective
        readonly preflightRuntimeMs: number | undefined
        readonly completeArchiveRuntimeMs: number | undefined
        readonly prefixTerminalizationMs: number
        readonly coldSearchMs: number
        readonly runtimeMs: number
      }
    | undefined
  readonly artifactPath: string
}

interface CapacityColdSearchTrace {
  readonly auxiliaryPlacementEvaluations: number
  readonly completedDepths: number
  readonly pieceCount: number
}

function capacityColdSearchTrace(
  report: CapacityRunReport
): CapacityColdSearchTrace | undefined {
  return report.capacity?.coldSearch as CapacityColdSearchTrace | undefined
}

async function runArm(
  request: NestingRequest,
  arm: 'production' | 'cold-only',
  artifactPath: string
): Promise<CapacityRunReport> {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  const options: ComputeIrregularNestingOptions = {
    ...(arm === 'cold-only' ? { capacityControlArm: 'disable-prefix-reuse' } : {}),
    captureCapacityPhaseTimings: true
  }
  const startedAt = performance.now()
  const result = await Effect.runPromise(
    computeIrregularNesting(request, options).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, settings))
    )
  )
  const elapsedMs = performance.now() - startedAt
  const polygons = absoluteCollisionPolygons(result)
  const canonical = polygons.length === 0 ? undefined : canonicalizeIrregularLayout(polygons)
  await writeFile(artifactPath, renderSvg(request.sheet, polygons))
  const requestIds = request.pieces.map(({ id }) => id)
  const accountedIds = [
    ...result.placedCollisionGeometries.map(
      ({ placement }) => placement.pieceId ?? placement.sourcePieceId
    ),
    ...result.unplacedPieceIds
  ]
  const partitionExact =
    accountedIds.length === requestIds.length &&
    new Set(accountedIds).size === accountedIds.length &&
    [...accountedIds].sort().every((id, index) => id === [...requestIds].sort()[index])
  const trace = result.capacityTrace
  return {
    arm,
    elapsedMs,
    routing: trace?.routing,
    preflight:
      trace === undefined
        ? undefined
        : {
            kind: trace.preflight.kind,
            ...(trace.preflight.kind === 'proven_impossible'
              ? { reason: trace.preflight.reason }
              : {})
          },
    placedCount: result.placedCollisionGeometries.length,
    unplacedCount: result.unplacedPieceIds.length,
    unplacedPieceIds: result.unplacedPieceIds,
    partitionExact,
    canonicalSha256: canonical?.sha256,
    terminationReason: result.portfolio.terminationReason,
    capacity:
      trace === undefined
        ? undefined
        : {
            prefixes: trace.prefixes,
            prefixIncumbent: trace.prefixIncumbent,
            coldSearch: trace.coldSearch,
            selected: trace.selected,
            preflightRuntimeMs: trace.preflightRuntimeMs,
            completeArchiveRuntimeMs: trace.completeArchiveRuntimeMs,
            prefixTerminalizationMs: trace.prefixTerminalizationMs,
            coldSearchMs: trace.coldSearchMs,
            runtimeMs: trace.runtimeMs
          },
    artifactPath
  }
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === 'bigint' ? entry.toString() : entry
    )
  )
}

interface CliArguments {
  readonly selectedCaseIds: ReadonlySet<string>
  readonly outputDirectory: string
  readonly paired: boolean
  readonly strict: boolean
}

function parseArguments(argv: ReadonlyArray<string>): CliArguments {
  let outputDirectory = '/private/tmp/irregular-capacity-gate'
  let selected: ReadonlySet<string> = new Set(fixtures.map(({ id }) => id))
  let paired = false
  let strict = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--output') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--output requires a directory')
      outputDirectory = value
      index += 1
    } else if (argument === '--case') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error('--case requires fixture ids')
      selected = new Set(value.split(','))
      index += 1
    } else if (argument === '--paired') {
      paired = true
    } else if (argument === '--strict') {
      strict = true
    } else {
      throw new Error(`unknown argument ${argument}`)
    }
  }
  return { selectedCaseIds: selected, outputDirectory, paired, strict }
}

const cli = parseArguments(process.argv.slice(2))
await mkdir(cli.outputDirectory, { recursive: true })
const caseReports = []
let passed = true
for (const fixture of fixtures) {
  if (!cli.selectedCaseIds.has(fixture.id)) continue
  const request = await makeFixtureRequest(fixture)
  const production = await runArm(
    request,
    'production',
    `${cli.outputDirectory}/${fixture.id}-production.svg`
  )
  const coldOnly =
    cli.paired && fixture.pairedEligible
      ? await runArm(request, 'cold-only', `${cli.outputDirectory}/${fixture.id}-cold-only.svg`)
      : undefined
  const productionColdSearch = capacityColdSearchTrace(production)
  const coldOnlyColdSearch =
    coldOnly === undefined ? undefined : capacityColdSearchTrace(coldOnly)

  const checks = {
    partitionExact: production.partitionExact && (coldOnly?.partitionExact ?? true),
    routing:
      fixture.expectedRouting === undefined || production.routing === fixture.expectedRouting,
    placedCount:
      fixture.expectedPlacedCount === undefined ||
      production.placedCount === fixture.expectedPlacedCount,
    capacitySettled:
      production.capacity === undefined ||
      production.terminationReason === 'capacity_subset_settled',
    auxiliaryEvaluationsZero:
      productionColdSearch === undefined ||
      productionColdSearch.auxiliaryPlacementEvaluations === 0,
    coldSearchReachedEveryDepth:
      (productionColdSearch === undefined ||
        productionColdSearch.completedDepths === productionColdSearch.pieceCount) &&
      (coldOnlyColdSearch === undefined ||
        coldOnlyColdSearch.completedDepths === coldOnlyColdSearch.pieceCount),
    prefixNotBelowColdOnly:
      coldOnly === undefined ||
      (production.capacity !== undefined &&
        coldOnly.capacity !== undefined &&
        compareIntrinsicCapacityObjectives(
          production.capacity.selected,
          coldOnly.capacity.selected
        ) <= 0)
  }
  const fixturePassed = Object.values(checks).every((value) => value)
  passed &&= fixturePassed
  const report = jsonSafe({
    caseId: fixture.id,
    sheet: { width: fixture.sheet.width, height: fixture.sheet.height },
    pieceCount: request.pieces.length,
    checks,
    passed: fixturePassed,
    production,
    ...(coldOnly === undefined ? {} : { coldOnly })
  })
  caseReports.push(report)
  console.log(JSON.stringify(report))
}
const reportPath = `${cli.outputDirectory}/report.json`
await writeFile(
  reportPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), cases: caseReports }, null, 2)}\n`
)
console.log(JSON.stringify({ reportPath, passed }))
if (cli.strict && !passed) {
  process.exitCode = 1
}
