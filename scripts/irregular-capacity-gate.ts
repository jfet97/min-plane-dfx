import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import {
  IrregularNestingSettings,
  type IrregularPreparedPiece,
  type IrregularPlacedPiece
} from '../src/shared/irregular/domain.js'
import { makePresetShapeDocument, type PresetShapeKind } from '../src/shared/presetShapes.js'
import { preparePieces } from '../src/shared/preparePieces.js'
import {
  computeIrregularNesting,
  intrinsicAnytimeSchedulerTraceValid,
  type ComputeIrregularNestingOptions,
  type IrregularComputeResult
} from '../src/workers/algorithm/irregular/computeIrregularNesting.js'
import {
  compareIntrinsicCapacityObjectives,
  type IntrinsicCapacityEndpoint,
  type IntrinsicCapacityObjective
} from '../src/workers/algorithm/irregular/intrinsicCapacityEndpoint.js'
import { runIntrinsicComponentInterfaceClosure } from '../src/workers/algorithm/irregular/intrinsicComponentInterfaceClosure.js'
import { runIntrinsicDetachedPieceReinsertion } from '../src/workers/algorithm/irregular/intrinsicDetachedPieceReinsertion.js'
import { runIntrinsicTwoPieceInterfaceReconstruction } from '../src/workers/algorithm/irregular/intrinsicTwoPieceInterfaceReconstruction.js'
import {
  intrinsicCapacityLaneCoordinatorTraceValid,
  type IntrinsicCapacityTrace
} from '../src/workers/algorithm/irregular/intrinsicCapacityMode.js'
import { IrregularLayoutScorer } from '../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { measureRelaxationMetrics } from '../src/workers/algorithm/irregular/overlapRelaxation.js'
import {
  isAdmissibleTargetedImprovement,
  runTargetedExactLns
} from '../src/workers/algorithm/irregular/targetedExactLns.js'
import { CollisionGeometryBuilder } from '../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../src/workers/irregular/freeMaterialService.js'
import { GeometryKernel, GeometrySettings } from '../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../src/workers/irregular/transformGenerator.js'
import {
  assertCanonicalGridLegalLayout,
  measureCanonicalLayoutTopologyExact
} from '../src/workers/irregular/canonicalLayoutGeometry.js'
import {
  canonicalizeIrregularLayout,
  type LayoutPoint
} from './lib/irregularLayoutCanonicalization.js'
import { exactIrregularPiecePartition } from '../src/workers/irregular/differential/irregularQualityAcceptance.js'

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
  readonly minimumPlacedCount?: number
  readonly expectedCanonicalSha256?: string
  readonly expectedQualityWarmPrefix?: {
    readonly status: NonNullable<IntrinsicCapacityTrace['qualityWarmPrefix']>['status']
    readonly outputInfluence: NonNullable<
      IntrinsicCapacityTrace['qualityWarmPrefix']
    >['outputInfluence']
    readonly sourceRole: string
    readonly prefixDepth: number
    readonly endpointCanonicalGeometryHash: string | undefined
  }
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
    expectedPlacedCount: 17,
    minimumPlacedCount: 17,
    expectedCanonicalSha256: '2f236b79c7c49a999daf5363e257bbda6b8562239571c6fedab2485cffb38c35',
    expectedQualityWarmPrefix: {
      status: 'skipped-below-minimum-piece-count',
      outputInfluence: 'none',
      sourceRole: 'canonical-grid',
      prefixDepth: 10,
      endpointCanonicalGeometryHash: undefined
    },
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
    id: 'capacity-mixed61-700x500',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 700, height: 500, label: 'constrained 700x500' }),
    expectedRouting: undefined,
    expectedPlacedCount: 50,
    minimumPlacedCount: 50,
    expectedCanonicalSha256: '97dbc5029a050389b9b8f440dfd764e0b758e75c5cbfdbc8f27e1c0ddcdca04b',
    expectedQualityWarmPrefix: {
      status: 'evaluation-cap',
      outputInfluence: 'strict-count-improvement',
      sourceRole: 'canonical-grid',
      prefixDepth: 15,
      endpointCanonicalGeometryHash:
        '0c98259d05531d74d14d7e72eac64d0d1f02e9ffb5e99910aabad048f67bf77d'
    },
    pairedEligible: true
  },
  {
    id: 'capacity-mixed61-700x560',
    source: 'mixed-61',
    shapes: [],
    paddingMm: 10,
    sheet: new SheetSpec({ width: 700, height: 560, label: 'constrained 700x560' }),
    expectedRouting: undefined,
    expectedPlacedCount: 59,
    minimumPlacedCount: 59,
    expectedCanonicalSha256: '36cee3489abffe6f5961a7ae96cbe9ce34d33d8754c9822841abb7585117ba16',
    expectedQualityWarmPrefix: {
      status: 'evaluation-cap',
      outputInfluence: 'strict-count-improvement',
      sourceRole: 'canonical-grid',
      prefixDepth: 30,
      endpointCanonicalGeometryHash:
        '2d252e359cf482f55bc5de60cdde7b3482a8f6b0493e1c686ae9d94296741e69'
    },
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
  return absolutePlacedCollisionPolygons(result.placedCollisionGeometries)
}

function absolutePlacedCollisionPolygons(
  placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<ReadonlyArray<LayoutPoint>> {
  return placedCollisionGeometries.map(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
}

function renderSvg(sheet: SheetSpec, polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>): string {
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
  readonly preflight: { readonly kind: string; readonly reason?: string } | undefined
  readonly placedCount: number
  readonly unplacedCount: number
  readonly unplacedPieceIds: ReadonlyArray<string>
  readonly partitionExact: boolean
  readonly canonicalSha256: string | undefined
  readonly terminationReason: string | undefined
  readonly shadowTelemetry: IrregularComputeResult['capacityShadowTelemetry']
  readonly schedulerTrace: IrregularComputeResult['intrinsicAnytimeSchedulerTrace']
  readonly experimentalPlaceDeferTrace: IrregularComputeResult['experimentalPlaceDeferTrace']
  readonly retentionMode: 'cohesion-frontier' | 'area-first' | 'axis-buckets'
  readonly cohesionShadow:
    | {
        readonly artifactPath: string
        readonly canonicalGeometryHash: string
        readonly objective: IntrinsicCapacityObjective
        readonly topology: ReturnType<typeof measureCanonicalLayoutTopologyExact>
      }
    | undefined
  readonly cohesionLnsShadow:
    | {
        readonly artifactPath: string
        readonly accepted: boolean
        readonly runtimeMs: number
        readonly canonicalSha256: string
        readonly placedCount: number
        readonly topology: ReturnType<typeof measureCanonicalLayoutTopologyExact>
        readonly incumbentMetrics: unknown
        readonly selectedMetrics: unknown
        readonly rounds: unknown
      }
    | undefined
  readonly cohesionReinsertionShadow:
    | {
        readonly artifactPath: string
        readonly accepted: boolean
        readonly runtimeMs: number
        readonly canonicalSha256: string
        readonly placedCount: number
        readonly selectedPieceId: string | undefined
        readonly detachedPieceIds: ReadonlyArray<string>
        readonly topology: ReturnType<typeof measureCanonicalLayoutTopologyExact>
        readonly seedMetrics: unknown
        readonly selectedMetrics: unknown
        readonly pieceReports: unknown
      }
    | undefined
  readonly cohesionFeatureContactShadow:
    | {
        readonly artifactPath: string
        readonly accepted: boolean
        readonly runtimeMs: number
        readonly canonicalSha256: string
        readonly placedCount: number
        readonly topology: ReturnType<typeof measureCanonicalLayoutTopologyExact>
        readonly seedMetrics: unknown
        readonly selectedMetrics: unknown
        readonly compatibleEdgePairCount: number
        readonly materializationCount: number
        readonly exactEndpointCount: number
        readonly qualifyingEndpointCount: number
        readonly attemptOutcomeCounts: Readonly<Record<string, number>>
        readonly attempts: unknown
      }
    | undefined
  readonly cohesionTwoPieceInterfaceShadow:
    | {
        readonly artifactPath: string
        readonly admissionGuardPassed: boolean
        readonly promotionEligible: boolean
        readonly outputInfluence: 'none'
        readonly status: string
        readonly runtimeMs: number
        readonly canonicalSha256: string
        readonly placedCount: number
        readonly topology: ReturnType<typeof measureCanonicalLayoutTopologyExact>
        readonly candidateEvaluations: number
        readonly pairCount: number
        readonly orderCount: number
        readonly exactEndpointCount: number
        readonly admissibleEndpointCount: number
        readonly selectedPair: ReadonlyArray<string> | undefined
        readonly selectedOrder: ReadonlyArray<string> | undefined
        readonly bestExactPair: ReadonlyArray<string> | undefined
        readonly bestExactOrder: ReadonlyArray<string> | undefined
        readonly bestExactArtifactPath: string
        readonly seedMetrics: unknown
        readonly selectedMetrics: unknown
        readonly bestExactMetrics: unknown
      }
    | undefined
  readonly warmLaneArtifacts: ReadonlyArray<{
    readonly sourceRole: string
    readonly prefixDepth: number
    readonly canonicalGeometryHash: string
    readonly artifactPath: string
  }>
  readonly capacity:
    | {
        readonly prefixes: unknown
        readonly prefixIncumbent: unknown
        readonly coldSearch: unknown
        readonly warmPrefixLanes: IntrinsicCapacityTrace['warmPrefixLanes']
        readonly cohesionShadow: IntrinsicCapacityTrace['cohesionShadow']
        readonly qualityWarmPrefix: IntrinsicCapacityTrace['qualityWarmPrefix']
        readonly laneCoordinator: IntrinsicCapacityTrace['laneCoordinator']
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

function capacityColdSearchTrace(report: CapacityRunReport): CapacityColdSearchTrace | undefined {
  return report.capacity?.coldSearch as CapacityColdSearchTrace | undefined
}

async function runArm(
  request: NestingRequest,
  arm: 'production' | 'cold-only',
  artifactPath: string,
  retentionMode: 'objective' | 'area-first' | 'axis-buckets',
  captureCohesionShadow: boolean,
  captureCohesionLnsShadow: boolean,
  captureCohesionReinsertionShadow: boolean,
  captureCohesionFeatureContactShadow: boolean,
  captureCohesionTwoPieceInterfaceShadow: boolean
): Promise<CapacityRunReport> {
  const settings = request.options.irregularSettings
  if (settings === undefined) throw new Error(`${request.jobId} has no irregular settings`)
  const warmLaneEndpoints: Array<{
    readonly sourceRole: string
    readonly prefixDepth: number
    readonly endpoint: IntrinsicCapacityEndpoint | undefined
  }> = []
  let cohesionEndpoint: IntrinsicCapacityEndpoint | undefined
  let preparedPieces: ReadonlyArray<IrregularPreparedPiece> = []
  const options: ComputeIrregularNestingOptions = {
    ...(arm === 'cold-only' ? { capacityControlArm: 'disable-prefix-reuse' } : {}),
    captureCapacityPhaseTimings: true,
    captureCapacityShadowTelemetry: true,
    captureCapacityWarmPrefixTelemetry: true,
    intrinsicAnytimeSchedulerMode: 'deterministic-v1',
    ...(retentionMode === 'objective' ? {} : { intrinsicCapacityRetentionShadow: retentionMode }),
    ...(captureCohesionShadow
      ? {
          captureCapacityCohesionShadow: true,
          onCapacityCohesionShadowLane: (endpoint: IntrinsicCapacityEndpoint | undefined) => {
            cohesionEndpoint = endpoint
          }
        }
      : {}),
    ...(captureCohesionLnsShadow ||
    captureCohesionReinsertionShadow ||
    captureCohesionTwoPieceInterfaceShadow
      ? {
          onPreparedPieces: (observedPreparedPieces: ReadonlyArray<IrregularPreparedPiece>) => {
            preparedPieces = observedPreparedPieces
          }
        }
      : {}),
    captureExperimentalPlaceDeferCompleteShadow: true,
    onCapacityWarmPrefixLane: (lane) => {
      warmLaneEndpoints.push(lane)
    }
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
  const warmLaneArtifacts: CapacityRunReport['warmLaneArtifacts'][number][] = []
  for (const lane of warmLaneEndpoints) {
    if (lane.endpoint === undefined) continue
    const warmArtifactPath = `${artifactPath.slice(0, -4)}-warm-${lane.sourceRole}-${lane.prefixDepth}.svg`
    await writeFile(
      warmArtifactPath,
      renderSvg(
        request.sheet,
        absolutePlacedCollisionPolygons(lane.endpoint.placedCollisionGeometries)
      )
    )
    warmLaneArtifacts.push({
      sourceRole: lane.sourceRole,
      prefixDepth: lane.prefixDepth,
      canonicalGeometryHash: lane.endpoint.canonicalGeometryHash,
      artifactPath: warmArtifactPath
    })
  }
  const cohesionShadow =
    cohesionEndpoint === undefined
      ? undefined
      : {
          artifactPath: `${artifactPath.slice(0, -4)}-cohesion-shadow.svg`,
          canonicalGeometryHash: cohesionEndpoint.canonicalGeometryHash,
          objective: {
            placedCount: cohesionEndpoint.metrics.placedCount,
            placedDoubledMaterialAreaGrid2: cohesionEndpoint.metrics.placedDoubledMaterialAreaGrid2,
            enclosedCavityCount: cohesionEndpoint.metrics.enclosedCavityCount,
            totalEnclosedCavityAreaMm2: cohesionEndpoint.metrics.totalEnclosedCavityAreaMm2,
            totalEnclosedCavityDoubledAreaGrid2:
              cohesionEndpoint.metrics.totalEnclosedCavityDoubledAreaGrid2,
            envelopeMaximumSideMm: cohesionEndpoint.metrics.envelopeMaximumSideMm,
            envelopeAreaMm2: cohesionEndpoint.metrics.envelopeAreaMm2,
            envelopeSpanMm: cohesionEndpoint.metrics.envelopeSpanMm,
            envelopeMaximumSideGrid: cohesionEndpoint.metrics.envelopeMaximumSideGrid,
            envelopeAreaGrid2: cohesionEndpoint.metrics.envelopeAreaGrid2,
            envelopeSpanGrid: cohesionEndpoint.metrics.envelopeSpanGrid,
            canonicalGeometryHash: cohesionEndpoint.canonicalGeometryHash,
            origin: cohesionEndpoint.origin,
            prefixDepth: cohesionEndpoint.prefixDepth,
            sourceRole: cohesionEndpoint.sourceRole
          },
          topology: measureCanonicalLayoutTopologyExact(cohesionEndpoint.placedCollisionGeometries)
        }
  if (cohesionShadow !== undefined && cohesionEndpoint !== undefined) {
    await writeFile(
      cohesionShadow.artifactPath,
      renderSvg(
        request.sheet,
        absolutePlacedCollisionPolygons(cohesionEndpoint.placedCollisionGeometries)
      )
    )
  }
  const cohesionLnsShadow =
    !captureCohesionLnsShadow || cohesionEndpoint === undefined
      ? undefined
      : await runCohesionLnsShadow({
          request,
          settings,
          preparedPieces,
          endpoint: cohesionEndpoint,
          artifactPath: `${artifactPath.slice(0, -4)}-cohesion-lns-shadow.svg`
        })
  const cohesionReinsertionShadow =
    !captureCohesionReinsertionShadow || cohesionEndpoint === undefined
      ? undefined
      : await runCohesionReinsertionShadow({
          request,
          settings,
          preparedPieces,
          endpoint: cohesionEndpoint,
          artifactPath: `${artifactPath.slice(0, -4)}-cohesion-reinsertion-shadow.svg`
        })
  const cohesionFeatureContactShadow =
    !captureCohesionFeatureContactShadow || cohesionEndpoint === undefined
      ? undefined
      : await runCohesionFeatureContactShadow({
          request,
          endpoint: cohesionEndpoint,
          artifactPath: `${artifactPath.slice(0, -4)}-cohesion-feature-contact-shadow.svg`
        })
  const cohesionTwoPieceInterfaceShadow =
    !captureCohesionTwoPieceInterfaceShadow || cohesionEndpoint === undefined
      ? undefined
      : await runCohesionTwoPieceInterfaceShadow({
          request,
          settings,
          preparedPieces,
          endpoint: cohesionEndpoint,
          artifactPath: `${artifactPath.slice(0, -4)}-cohesion-two-piece-interface-shadow.svg`
        })
  const requestIds = request.pieces.map(({ id }) => String(id))
  const placedIds = result.placedCollisionGeometries.map(({ placement }) =>
    String(placement.pieceId ?? placement.sourcePieceId)
  )
  const partitionExact = exactIrregularPiecePartition(
    requestIds,
    placedIds,
    result.unplacedPieceIds.map(String)
  )
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
    shadowTelemetry: result.capacityShadowTelemetry,
    schedulerTrace: result.intrinsicAnytimeSchedulerTrace,
    experimentalPlaceDeferTrace: result.experimentalPlaceDeferTrace,
    retentionMode: retentionMode === 'objective' ? 'cohesion-frontier' : retentionMode,
    cohesionShadow,
    cohesionLnsShadow,
    cohesionReinsertionShadow,
    cohesionFeatureContactShadow,
    cohesionTwoPieceInterfaceShadow,
    warmLaneArtifacts,
    capacity:
      trace === undefined
        ? undefined
        : {
            prefixes: trace.prefixes,
            prefixIncumbent: trace.prefixIncumbent,
            coldSearch: trace.coldSearch,
            warmPrefixLanes: trace.warmPrefixLanes,
            cohesionShadow: trace.cohesionShadow,
            qualityWarmPrefix: trace.qualityWarmPrefix,
            laneCoordinator: trace.laneCoordinator,
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

async function runCohesionTwoPieceInterfaceShadow(input: {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly endpoint: IntrinsicCapacityEndpoint
  readonly artifactPath: string
}): Promise<NonNullable<CapacityRunReport['cohesionTwoPieceInterfaceShadow']>> {
  const result = await Effect.runPromise(
    runIntrinsicTwoPieceInterfaceReconstruction({
      sheet: input.request.sheet,
      allPreparedPieces: input.preparedPieces,
      seedPlaced: input.endpoint.placedCollisionGeometries,
      maximumRuntimeMs: 30_000,
      maximumCandidateEvaluations: 200_000
    }).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(Layer.succeed(GeometrySettings, input.settings))
    )
  )
  const polygons = absolutePlacedCollisionPolygons(result.placedCollisionGeometries)
  const canonical = canonicalizeIrregularLayout(polygons)
  await writeFile(input.artifactPath, renderSvg(input.request.sheet, polygons))
  const bestExactArtifactPath = `${input.artifactPath.slice(0, -4)}-best-topology.svg`
  await writeFile(
    bestExactArtifactPath,
    renderSvg(
      input.request.sheet,
      absolutePlacedCollisionPolygons(result.bestExactPlacedCollisionGeometries)
    )
  )
  return {
    artifactPath: input.artifactPath,
    admissionGuardPassed: result.admissionGuardPassed,
    promotionEligible: result.promotionEligible,
    outputInfluence: result.outputInfluence,
    status: result.status,
    runtimeMs: result.runtimeMs,
    canonicalSha256: canonical.sha256,
    placedCount: result.placedCollisionGeometries.length,
    topology: measureCanonicalLayoutTopologyExact(result.placedCollisionGeometries),
    candidateEvaluations: result.candidateEvaluations,
    pairCount: result.pairCount,
    orderCount: result.orderCount,
    exactEndpointCount: result.exactEndpointCount,
    admissibleEndpointCount: result.admissibleEndpointCount,
    selectedPair: result.selectedPair,
    selectedOrder: result.selectedOrder,
    bestExactPair: result.bestExactPair,
    bestExactOrder: result.bestExactOrder,
    bestExactArtifactPath,
    seedMetrics: result.seedMetrics,
    selectedMetrics: result.selectedMetrics,
    bestExactMetrics: result.bestExactMetrics
  }
}

async function runCohesionFeatureContactShadow(input: {
  readonly request: NestingRequest
  readonly endpoint: IntrinsicCapacityEndpoint
  readonly artifactPath: string
}): Promise<NonNullable<CapacityRunReport['cohesionFeatureContactShadow']>> {
  const result = runIntrinsicComponentInterfaceClosure({
    seedPlaced: input.endpoint.placedCollisionGeometries,
    maximumMaterializations: 5_000,
    maximumRuntimeMs: 15_000
  })
  if (result === undefined) {
    throw new Error(`${input.request.jobId}: component interface closure rejected its seed`)
  }
  const seedMetrics = measureRelaxationMetrics(input.endpoint.placedCollisionGeometries)
  if (seedMetrics === undefined) {
    throw new Error(`${input.request.jobId}: component interface seed metrics failed`)
  }
  const selected = result.exactEndpoints.find((endpoint) => {
    const metrics = measureRelaxationMetrics(endpoint.placedCollisionGeometries)
    return (
      metrics !== undefined &&
      assertCanonicalGridLegalLayout(input.request.sheet, endpoint.placedCollisionGeometries) &&
      isAdmissibleTargetedImprovement(seedMetrics, metrics)
    )
  })
  const selectedPlaced =
    selected?.placedCollisionGeometries ?? input.endpoint.placedCollisionGeometries
  const selectedMetrics = measureRelaxationMetrics(selectedPlaced)
  if (selectedMetrics === undefined) {
    throw new Error(`${input.request.jobId}: component interface result metrics failed`)
  }
  const polygons = absolutePlacedCollisionPolygons(selectedPlaced)
  const canonical = canonicalizeIrregularLayout(polygons)
  await writeFile(input.artifactPath, renderSvg(input.request.sheet, polygons))
  const attemptOutcomeCounts: Record<string, number> = {}
  for (const attempt of result.attempts) {
    attemptOutcomeCounts[attempt.outcome] = (attemptOutcomeCounts[attempt.outcome] ?? 0) + 1
  }
  return {
    artifactPath: input.artifactPath,
    accepted: selected !== undefined,
    runtimeMs: result.runtimeMs,
    canonicalSha256: canonical.sha256,
    placedCount: selectedPlaced.length,
    topology: measureCanonicalLayoutTopologyExact(selectedPlaced),
    seedMetrics,
    selectedMetrics,
    compatibleEdgePairCount: result.compatibleEdgePairCount,
    materializationCount: result.materializationCount,
    exactEndpointCount: result.exactEndpoints.length,
    qualifyingEndpointCount: result.qualifyingEndpoints.length,
    attemptOutcomeCounts,
    attempts: result.attempts
  }
}

async function runCohesionReinsertionShadow(input: {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly endpoint: IntrinsicCapacityEndpoint
  readonly artifactPath: string
}): Promise<NonNullable<CapacityRunReport['cohesionReinsertionShadow']>> {
  const result = await Effect.runPromise(
    runIntrinsicDetachedPieceReinsertion({
      sheet: input.request.sheet,
      allPreparedPieces: input.preparedPieces,
      seedPlaced: input.endpoint.placedCollisionGeometries
    }).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, input.settings))
    )
  )
  const polygons = absolutePlacedCollisionPolygons(result.placedCollisionGeometries)
  const canonical = canonicalizeIrregularLayout(polygons)
  await writeFile(input.artifactPath, renderSvg(input.request.sheet, polygons))
  return {
    artifactPath: input.artifactPath,
    accepted: result.accepted,
    runtimeMs: result.runtimeMs,
    canonicalSha256: canonical.sha256,
    placedCount: result.placedCollisionGeometries.length,
    selectedPieceId: result.selectedPieceId,
    detachedPieceIds: result.detachedPieceIds,
    topology: measureCanonicalLayoutTopologyExact(result.placedCollisionGeometries),
    seedMetrics: result.seedMetrics,
    selectedMetrics: result.selectedMetrics,
    pieceReports: result.pieceReports
  }
}

async function runCohesionLnsShadow(input: {
  readonly request: NestingRequest
  readonly settings: IrregularNestingSettings
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly endpoint: IntrinsicCapacityEndpoint
  readonly artifactPath: string
}): Promise<NonNullable<CapacityRunReport['cohesionLnsShadow']>> {
  const placedIds = new Set(
    input.endpoint.placedCollisionGeometries.map(
      ({ placement }) => placement.pieceId ?? placement.sourcePieceId
    )
  )
  const subsetPreparedPieces = input.preparedPieces.filter((piece) =>
    placedIds.has(piece.pieceId ?? piece.source.id)
  )
  if (subsetPreparedPieces.length !== input.endpoint.placedCollisionGeometries.length) {
    throw new Error(
      `${input.request.jobId}: cohesion LNS could not resolve every placed prepared piece`
    )
  }
  const result = await Effect.runPromise(
    runTargetedExactLns({
      sheet: input.request.sheet,
      allPreparedPieces: subsetPreparedPieces,
      incumbent: input.endpoint.placedCollisionGeometries,
      roundDeadlineMs: 1_000,
      globalDeadlineMs: 15_000
    }).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, input.settings))
    )
  )
  const polygons = absolutePlacedCollisionPolygons(result.placedCollisionGeometries)
  const canonical = canonicalizeIrregularLayout(polygons)
  await writeFile(input.artifactPath, renderSvg(input.request.sheet, polygons))
  return {
    artifactPath: input.artifactPath,
    accepted: result.accepted,
    runtimeMs: result.runtimeMs,
    canonicalSha256: canonical.sha256,
    placedCount: result.placedCollisionGeometries.length,
    topology: measureCanonicalLayoutTopologyExact(result.placedCollisionGeometries),
    incumbentMetrics: result.incumbentMetrics,
    selectedMetrics: result.selectedMetrics,
    rounds: result.rounds
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
  readonly quiet: boolean
  readonly strict: boolean
  readonly retentionMode: 'objective' | 'area-first' | 'axis-buckets'
  readonly cohesionShadow: boolean
  readonly cohesionLnsShadow: boolean
  readonly cohesionReinsertionShadow: boolean
  readonly cohesionFeatureContactShadow: boolean
  readonly cohesionTwoPieceInterfaceShadow: boolean
  readonly requireCohesionPromotion: boolean
}

function parseArguments(argv: ReadonlyArray<string>): CliArguments {
  let outputDirectory = `${tmpdir()}/irregular-capacity-gate`
  let selected: ReadonlySet<string> = new Set(fixtures.map(({ id }) => id))
  let paired = false
  let quiet = false
  let strict = false
  let retentionMode: 'objective' | 'area-first' | 'axis-buckets' = 'objective'
  let cohesionShadow = false
  let cohesionLnsShadow = false
  let cohesionReinsertionShadow = false
  let cohesionFeatureContactShadow = false
  let cohesionTwoPieceInterfaceShadow = false
  let requireCohesionPromotion = false
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
    } else if (argument === '--quiet') {
      quiet = true
    } else if (argument === '--strict') {
      strict = true
    } else if (argument === '--retention') {
      const value = argv[index + 1]
      if (value !== 'objective' && value !== 'area-first' && value !== 'axis-buckets') {
        throw new Error('--retention requires objective, area-first, or axis-buckets')
      }
      retentionMode = value
      index += 1
    } else if (argument === '--cohesion-shadow') {
      cohesionShadow = true
    } else if (argument === '--cohesion-lns-shadow') {
      cohesionShadow = true
      cohesionLnsShadow = true
    } else if (argument === '--cohesion-reinsertion-shadow') {
      cohesionShadow = true
      cohesionReinsertionShadow = true
    } else if (argument === '--cohesion-feature-contact-shadow') {
      cohesionShadow = true
      cohesionFeatureContactShadow = true
    } else if (argument === '--cohesion-two-piece-interface-shadow') {
      cohesionShadow = true
      cohesionTwoPieceInterfaceShadow = true
    } else if (argument === '--require-cohesion-promotion') {
      requireCohesionPromotion = true
    } else {
      throw new Error(`unknown argument ${argument}`)
    }
  }
  return {
    selectedCaseIds: selected,
    outputDirectory,
    paired,
    quiet,
    strict,
    retentionMode,
    cohesionShadow,
    cohesionLnsShadow,
    cohesionReinsertionShadow,
    cohesionFeatureContactShadow,
    cohesionTwoPieceInterfaceShadow,
    requireCohesionPromotion
  }
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
    `${cli.outputDirectory}/${fixture.id}-production.svg`,
    cli.retentionMode,
    cli.cohesionShadow,
    cli.cohesionLnsShadow,
    cli.cohesionReinsertionShadow,
    cli.cohesionFeatureContactShadow,
    cli.cohesionTwoPieceInterfaceShadow
  )
  const coldOnly =
    cli.paired && fixture.pairedEligible
      ? await runArm(
          request,
          'cold-only',
          `${cli.outputDirectory}/${fixture.id}-cold-only.svg`,
          cli.retentionMode,
          cli.cohesionShadow,
          cli.cohesionLnsShadow,
          cli.cohesionReinsertionShadow,
          cli.cohesionFeatureContactShadow,
          cli.cohesionTwoPieceInterfaceShadow
        )
      : undefined
  const productionColdSearch = capacityColdSearchTrace(production)
  const productionQualityWarmPrefix = production.capacity?.qualityWarmPrefix
  const coldOnlyColdSearch = coldOnly === undefined ? undefined : capacityColdSearchTrace(coldOnly)

  const checks = {
    partitionExact: production.partitionExact && (coldOnly?.partitionExact ?? true),
    routing:
      fixture.expectedRouting === undefined || production.routing === fixture.expectedRouting,
    placedCount:
      fixture.expectedPlacedCount === undefined ||
      production.placedCount === fixture.expectedPlacedCount,
    minimumPlacedCount:
      fixture.minimumPlacedCount === undefined ||
      production.placedCount >= fixture.minimumPlacedCount,
    canonicalIdentity:
      fixture.expectedCanonicalSha256 === undefined ||
      cli.retentionMode !== 'objective' ||
      production.canonicalSha256 === fixture.expectedCanonicalSha256,
    qualityWarmPrefixContract:
      fixture.expectedQualityWarmPrefix === undefined ||
      cli.retentionMode !== 'objective' ||
      (productionQualityWarmPrefix?.status === fixture.expectedQualityWarmPrefix.status &&
        productionQualityWarmPrefix.outputInfluence ===
          fixture.expectedQualityWarmPrefix.outputInfluence &&
        productionQualityWarmPrefix.sourceRole === fixture.expectedQualityWarmPrefix.sourceRole &&
        productionQualityWarmPrefix.prefixDepth === fixture.expectedQualityWarmPrefix.prefixDepth &&
        productionQualityWarmPrefix.endpoint?.canonicalGeometryHash ===
          fixture.expectedQualityWarmPrefix.endpointCanonicalGeometryHash),
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
    schedulerChronology:
      (production.schedulerTrace === undefined ||
        intrinsicAnytimeSchedulerTraceValid(production.schedulerTrace)) &&
      (coldOnly?.schedulerTrace === undefined ||
        intrinsicAnytimeSchedulerTraceValid(coldOnly.schedulerTrace)),
    laneCoordinatorChronology:
      production.capacity?.laneCoordinator === undefined ||
      intrinsicCapacityLaneCoordinatorTraceValid(
        production.capacity.laneCoordinator,
        production.capacity.warmPrefixLanes ?? [],
        production.capacity.qualityWarmPrefix
      ),
    oneWarmLaneBeyondPilot:
      production.capacity?.laneCoordinator === undefined ||
      (production.capacity.warmPrefixLanes ?? []).filter(
        ({ selectedForContinuation }) => selectedForContinuation
      ).length <= 1,
    prefixNotBelowColdOnly:
      coldOnly === undefined ||
      (production.capacity !== undefined &&
        coldOnly.capacity !== undefined &&
        compareIntrinsicCapacityObjectives(
          production.capacity.selected,
          coldOnly.capacity.selected
        ) <= 0)
  }
  const cohesion = production.cohesionShadow
  const cohesionPromotion =
    fixture.id === 'capacity-triangles20-300x300' && cohesion !== undefined
      ? {
          eligible:
            cohesion.objective.placedCount >= 16 &&
            cohesion.objective.enclosedCavityCount === 0 &&
            cohesion.objective.envelopeMaximumSideMm <= 283.783 &&
            cohesion.objective.envelopeAreaMm2 < 77_750.86634 &&
            cohesion.topology?.topology.positiveContactComponentCount === 1 &&
            cohesion.topology.topology.isolatedPieceCount === 0 &&
            cohesion.topology.topology.largestPositiveContactComponentSize ===
              cohesion.objective.placedCount,
          requirements: {
            minimumPlacedCount: 16,
            enclosedCavityCount: 0,
            maximumSideUpperBoundMm: 283.783,
            envelopeAreaStrictUpperBoundMm2: 77_750.86634,
            positiveContactComponentCount: 1,
            isolatedPieceCount: 0,
            largestComponentMustContainEveryPlacedPiece: true,
            inspectedPngRequired: true
          }
        }
      : undefined
  const fixturePassed =
    Object.values(checks).every((value) => value) &&
    (!cli.requireCohesionPromotion || cohesionPromotion?.eligible === true)
  passed &&= fixturePassed
  const report = jsonSafe({
    caseId: fixture.id,
    sheet: { width: fixture.sheet.width, height: fixture.sheet.height },
    pieceCount: request.pieces.length,
    checks,
    cohesionPromotion,
    passed: fixturePassed,
    production,
    ...(coldOnly === undefined ? {} : { coldOnly })
  })
  caseReports.push(report)
  if (!cli.quiet) {
    console.log(JSON.stringify(report))
  }
}
const reportPath = `${cli.outputDirectory}/report.json`
await writeFile(
  reportPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      experiment: {
        retentionMode: cli.retentionMode === 'objective' ? 'cohesion-frontier' : cli.retentionMode,
        cohesionShadow: cli.cohesionShadow,
        requireCohesionPromotion: cli.requireCohesionPromotion
      },
      cases: caseReports
    },
    null,
    2
  )}\n`
)
const sourceCommit =
  process.env.CAPACITY_SOURCE_COMMIT ??
  execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const artifactNames = (await readdir(cli.outputDirectory))
  .filter(
    (name) =>
      name !== 'manifest.json' &&
      name !== 'SHA256SUMS' &&
      (name.endsWith('.json') || name.endsWith('.svg') || name.endsWith('.png'))
  )
  .sort((first, second) => first.localeCompare(second))
const artifacts = await Promise.all(
  artifactNames.map(async (name) => ({
    name,
    sha256: createHash('sha256')
      .update(await readFile(join(cli.outputDirectory, name)))
      .digest('hex')
  }))
)
const manifestPath = join(cli.outputDirectory, 'manifest.json')
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      version: 'intrinsic-capacity-gate-provenance-v1',
      generatedAt: new Date().toISOString(),
      sourceCommit,
      command: [
        'pnpm',
        'gate:capacity',
        '--output',
        '<output-directory>',
        ...(cli.paired ? ['--paired'] : []),
        ...(cli.quiet ? ['--quiet'] : []),
        ...(cli.strict ? ['--strict'] : [])
      ],
      runtime: {
        node: process.version,
        v8: process.versions.v8
      },
      execution: {
        maximumConcurrentAlgorithmProcesses: 1,
        strictlySequential: true
      },
      artifacts
    },
    null,
    2
  )}\n`
)
const checksumEntries = [
  ...artifacts,
  {
    name: 'manifest.json',
    sha256: createHash('sha256')
      .update(await readFile(manifestPath))
      .digest('hex')
  }
]
await writeFile(
  join(cli.outputDirectory, 'SHA256SUMS'),
  `${checksumEntries.map(({ sha256, name }) => `${sha256}  ${name}`).join('\n')}\n`
)
console.log(JSON.stringify({ reportPath, passed }))
if (cli.strict && !passed) {
  process.exitCode = 1
}
