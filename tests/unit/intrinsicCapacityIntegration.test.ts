import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'
import {
  computeIrregularNesting,
  intrinsicAnytimeSchedulerTraceValid,
  type ComputeIrregularNestingOptions
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { IrregularLayoutScorer } from '../../src/workers/algorithm/irregular/irregularLayoutScorer.js'
import { IrregularPlacementScorer } from '../../src/workers/algorithm/irregular/irregularPlacementScorer.js'
import { makeIrregularWorkerOutput } from '../../src/workers/algorithm/irregular/irregularWorkerOutput.js'
import { CollisionGeometryBuilder } from '../../src/workers/irregular/collisionGeometryBuilder.js'
import { FreeMaterialServiceLive } from '../../src/workers/irregular/freeMaterialService.js'
import { GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { TransformGeneratorLive } from '../../src/workers/irregular/transformGenerator.js'

const settings = new IrregularNestingSettings({
  geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  optimizer: makeCompactQualityIrregularOptimizerSettings()
})

function makeRectangleRequest(input: {
  readonly jobKey: string
  readonly count: number
  readonly widthMm: number
  readonly heightMm: number
  readonly sheet: SheetSpec
  readonly paddingMm: number
}): NestingRequest {
  const preset = makePresetShapeDocument({
    kind: 'rectangle',
    width: input.widthMm,
    height: input.heightMm,
    label: 'rectangle'
  })
  const rectangle = preset.pieces[0]
  if (rectangle === undefined) throw new Error('rectangle preset must contain one piece')

  const sources = Array.from(
    { length: input.count },
    (_, index) =>
      new ImportedPiece({
        ...rectangle,
        id: PieceId.make(`rectangle-copy-${index + 1}`),
        sourceFileId: SourceFileId.make(`rectangle-source-copy-${index + 1}`),
        label: `rectangle copy ${index + 1}`
      })
  )
  const jobId = JobId.make(input.jobKey)
  const prepared = preparePieces(
    sources,
    input.sheet,
    input.paddingMm,
    jobId,
    undefined,
    undefined,
    () => `rectangle-${input.widthMm}x${input.heightMm}`
  )
  expect(prepared.warnings).toEqual([])

  return new NestingRequest({
    version: 1,
    jobId,
    sheet: input.sheet,
    padding: input.paddingMm,
    pieces: prepared.pieces,
    sourcePieces: sources,
    options: new NestingOptions({
      allowGlobalRotation: true,
      allowGlobalMirror: true,
      timeoutMs: 120_000,
      workerMode: 'irregular-convex-v2',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [],
      layoutSelectionStrategyId: 'compact-first',
      finalSelectionMode: 'best',
      irregularSettings: settings
    })
  })
}

function compute(request: NestingRequest, options?: ComputeIrregularNestingOptions) {
  return Effect.runPromise(
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
}

describe('intrinsic capacity integration', () => {
  it(
    'captures pressure and a bounded no-skip probe without changing routing or output',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-shadow-telemetry',
        count: 3,
        widthMm: 60,
        heightMm: 60,
        sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
        paddingMm: 0
      })
      const baseline = await compute(request)
      const observed = await compute(request, { captureCapacityShadowTelemetry: true })

      expect(observed.capacityShadowTelemetry).toBeDefined()
      expect(observed.capacityShadowTelemetry?.routingInfluence).toBe('none')
      expect(observed.capacityShadowTelemetry?.pressure.minimumCollisionAreaPressurePpm).toBe(
        1_098_221n
      )
      expect(observed.capacityShadowTelemetry?.pressure.maximumSingletonSpanPressurePpm).toBe(
        605_040n
      )
      expect(observed.capacityShadowTelemetry?.noSkipProbe.status).toBe('observed')
      expect(observed.capacityShadowTelemetry?.noSkipProbe.maximumDepth).toBe(2)
      expect(observed.capacityShadowTelemetry?.noSkipProbe.completedDepths).toBe(2)
      expect(observed.capacityShadowTelemetry?.noSkipProbe.noSkipFrontierPresent).toBe(false)
      expect(observed.capacityShadowTelemetry?.noSkipProbe.firstLossDepth).toBe(2)
      expect(observed.capacityTrace?.routing).toBe(baseline.capacityTrace?.routing)
      expect(observed.portfolio.terminationReason).toBe(baseline.portfolio.terminationReason)
      expect(observed.unplacedPieceIds).toEqual(baseline.unplacedPieceIds)
      expect(observed.placedCollisionGeometries).toEqual(baseline.placedCollisionGeometries)
    },
    120_000
  )

  it(
    'bypasses complete construction for an area-proven impossible sheet and reports the honest partial result',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-area-proven',
        count: 2,
        widthMm: 80,
        heightMm: 60,
        sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
        paddingMm: 10
      })
      const computed = await compute(request)

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('preflight-proven-impossible')
      expect(computed.capacityTrace?.preflight.kind).toBe('proven_impossible')
      expect(computed.capacityTrace?.prefixes.capturedCount).toBe(0)
      expect(computed.capacityTrace?.coldSearch.auxiliaryPlacementEvaluations).toBe(0)

      expect(computed.portfolio.status).toBe('completed')
      expect(computed.portfolio.terminationReason).toBe('capacity_subset_settled')
      expect(computed.portfolio.source).toBe('shared-archive')
      expect(computed.placedCollisionGeometries).toHaveLength(1)
      expect(computed.unplacedPieceIds).toHaveLength(1)
      const allIds = request.pieces.map(({ id }) => id)
      const accounted = [
        ...computed.placedCollisionGeometries.map(
          ({ placement }) => placement.pieceId ?? placement.sourcePieceId
        ),
        ...computed.unplacedPieceIds
      ]
      expect([...accounted].toSorted()).toEqual([...allIds].toSorted())

      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_proven_impossible')
      expect(diagnosticCodes).toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('bounded_complete_archive_miss')

      const output = makeIrregularWorkerOutput({
        request,
        computed,
        algorithmBenchmark: {
          startedAt: '2026-07-23T00:00:00.000Z',
          endedAt: '2026-07-23T00:00:01.000Z',
          elapsedMs: 1000
        }
      })
      const layout = output.result.layout
      if (layout === undefined || layout.kind !== 'irregular') {
        throw new Error('capacity integration must produce an irregular layout')
      }
      expect(layout.placements).toHaveLength(1)
      expect(layout.unplacedPieceIds).toHaveLength(1)
      expect(output.historyFrames).toHaveLength(2)
      expect(output.historyFrames[0]?.placements).toEqual([])
      expect(output.historyFrames[0]?.title).toBe('shared-archive-selected-layout-reveal')
      expect(output.historyFrames[0]?.unplacedPieceIds).toEqual(computed.unplacedPieceIds)
      expect(output.historyFrames.at(-1)?.placements).toHaveLength(1)
      expect(output.historyFrames.at(-1)?.title).toBe('shared-archive-final-selected')
      expect(output.historyFrames.at(-1)?.unplacedPieceIds).toEqual(computed.unplacedPieceIds)
    },
    120_000
  )

  it(
    'enters capacity mode honestly after an inconclusive preflight and bounded complete archive miss',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-archive-miss',
        count: 5,
        widthMm: 40,
        heightMm: 40,
        sheet: new SheetSpec({ width: 100, height: 100, label: 'constrained 100x100' }),
        paddingMm: 0
      })
      const computed = await compute(request)
      const observed = await compute(request, {
        captureCapacityWarmPrefixTelemetry: true
      })
      const scheduled = await compute(request, {
        intrinsicAnytimeSchedulerMode: 'deterministic-v1',
        captureExperimentalPlaceDeferCompleteShadow: true
      })

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('bounded-complete-archive-miss')
      expect(computed.capacityTrace?.preflight.kind).toBe('inconclusive')

      expect(computed.portfolio.terminationReason).toBe('capacity_subset_settled')
      expect(computed.placedCollisionGeometries.length).toBeGreaterThan(0)
      expect(
        computed.placedCollisionGeometries.length + computed.unplacedPieceIds.length
      ).toBe(request.pieces.length)

      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_inconclusive')
      expect(diagnosticCodes).toContain('bounded_complete_archive_miss')
      expect(diagnosticCodes).toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('capacity_preflight_proven_impossible')

      const prefixes = computed.capacityTrace?.prefixes
      expect(prefixes).toBeDefined()
      expect(prefixes !== undefined && prefixes.capturedCount).toBeGreaterThanOrEqual(1)
      expect(computed.capacityTrace?.prefixIncumbent).toBeDefined()
      expect(computed.capacityTrace?.prefixIncumbent?.placedCount).toBeGreaterThan(0)
      expect(observed.capacityTrace?.warmPrefixLanes).toBeDefined()
      expect(observed.capacityTrace?.warmPrefixLanes?.length).toBeGreaterThanOrEqual(1)
      expect(
        observed.capacityTrace?.warmPrefixLanes?.every(
          ({ status, reusedPlacedCount, completedDepths }) =>
            status === 'settled' &&
            reusedPlacedCount > 0 &&
            completedDepths === request.pieces.length
        )
      ).toBe(true)
      expect(observed.capacityTrace?.coldSearch).toEqual(computed.capacityTrace?.coldSearch)
      expect(observed.placedCollisionGeometries).toEqual(computed.placedCollisionGeometries)
      expect(observed.unplacedPieceIds).toEqual(computed.unplacedPieceIds)
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.coldCheckpointReused).toBe(true)
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.cancellationReason).toBe(
        'complete-cohort-miss'
      )
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.warmPrefixEndpointsAdmitted).toBe(
        true
      )
      expect(scheduled.capacityTrace?.warmPrefixEndpointsAdmitted).toBe(true)
      expect(
        scheduled.intrinsicAnytimeSchedulerTrace === undefined
          ? false
          : intrinsicAnytimeSchedulerTraceValid(scheduled.intrinsicAnytimeSchedulerTrace)
      ).toBe(true)
      const warmLaneCount = scheduled.capacityTrace?.warmPrefixLanes?.length ?? 0
      const schedulerQuanta =
        scheduled.intrinsicAnytimeSchedulerTrace?.quanta ?? []
      expect(schedulerQuanta[0]).toMatchObject({
        producerRole: 'capacity-cold',
        outcome: 'checkpointed'
      })
      expect(schedulerQuanta).toContainEqual(
        expect.objectContaining({
          producerRole: 'capacity-cold',
          outcome: 'settled'
        })
      )
      expect(
        scheduled.capacityTrace?.laneCoordinator?.continuedProducers
      ).toContainEqual({
        role: 'capacity-cold'
      })
      expect(
        scheduled.capacityTrace?.laneCoordinator?.continuedProducers.some(
          ({ role }) => role === 'capacity-warm-prefix'
        )
      ).toBe(warmLaneCount > 0)
      expect(
        scheduled.capacityTrace?.laneCoordinator?.aggregateConsumedPlacementEvaluations
      ).toBeLessThanOrEqual(
        scheduled.capacityTrace?.laneCoordinator?.aggregatePlacementEvaluationCap ?? 0
      )
      expect(
        scheduled.capacityTrace?.laneCoordinator?.retainedCheckpointCount
      ).toBeLessThanOrEqual(warmLaneCount)
      expect(scheduled.placedCollisionGeometries.length).toBeGreaterThanOrEqual(
        computed.placedCollisionGeometries.length
      )
      expect(
        scheduled.placedCollisionGeometries.length + scheduled.unplacedPieceIds.length
      ).toBe(request.pieces.length)
    },
    120_000
  )

  it(
    'keeps the complete path unchanged when the archive fits, with capacity trace vocabulary only in diagnostics',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'capacity-complete-fitted',
        count: 5,
        widthMm: 40,
        heightMm: 30,
        sheet: new SheetSpec({ width: 2000, height: 2700, label: 'roomy 2000x2700' }),
        paddingMm: 10
      })
      const computed = await compute(request)
      const scheduled = await compute(request, {
        intrinsicAnytimeSchedulerMode: 'deterministic-v1',
        captureExperimentalPlaceDeferCompleteShadow: true
      })

      expect(computed.capacityTrace).toBeUndefined()
      expect(computed.portfolio.terminationReason).toBe('shared_archive_completed')
      expect(computed.unplacedPieceIds).toEqual([])
      expect(scheduled.placedCollisionGeometries).toEqual(computed.placedCollisionGeometries)
      expect(scheduled.unplacedPieceIds).toEqual([])
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.cancellationReason).toBe(
        'complete-endpoint-fitted'
      )
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.quanta.at(-1)?.outcome).toBe(
        'cancelled'
      )
      expect(
        scheduled.intrinsicAnytimeSchedulerTrace === undefined
          ? false
          : intrinsicAnytimeSchedulerTraceValid(scheduled.intrinsicAnytimeSchedulerTrace)
      ).toBe(true)
      expect(scheduled.placedCollisionGeometries).toEqual(
        computed.placedCollisionGeometries
      )
      expect(scheduled.unplacedPieceIds).toEqual([])
      expect(scheduled.experimentalPlaceDeferTrace?.outputInfluence).toBe('none')
      expect(
        scheduled.intrinsicAnytimeSchedulerTrace?.quanta.map(
          ({ producerRole, outcome }) => `${producerRole}:${outcome}`
        )
      ).toEqual([
        'capacity-cold:checkpointed',
        'legacy-complete:settled',
        'experimental-place-defer-complete:settled',
        'capacity-cold:cancelled'
      ])
      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_inconclusive')
      expect(diagnosticCodes).toContain('complete_archive_fitted')
      expect(diagnosticCodes).not.toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('bounded_complete_archive_miss')
    },
    120_000
  )
})
