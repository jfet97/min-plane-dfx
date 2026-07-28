import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { ImportedPiece } from '@shared/domain/dxf.js'
import { JobId, PieceId, SourceFileId } from '@shared/domain/ids.js'
import { NestingOptions, NestingRequest, SheetSpec } from '@shared/domain/nesting.js'
import {
  DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
  makeCompactQualityIrregularOptimizerSettings,
  makeCompactShortSideIrregularOptimizerSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import { makePresetShapeDocument } from '@shared/presetShapes.js'
import { preparePieces } from '@shared/preparePieces.js'
import {
  computeIrregularNesting,
  intrinsicAnytimeSchedulerTraceValid,
  type ComputeIrregularNestingOptions
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'
import { intrinsicCapacityLaneCoordinatorTraceValid } from '../../src/workers/algorithm/irregular/intrinsicCapacityMode.js'
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
  const geometrySettings = request.options.irregularSettings ?? settings
  return Effect.runPromise(
    computeIrregularNesting(request, options).pipe(
      Effect.provide(CollisionGeometryBuilder.Live),
      Effect.provide(TransformGeneratorLive),
      Effect.provide(NfpIfpServiceLive),
      Effect.provide(FreeMaterialServiceLive),
      Effect.provide(IrregularPlacementScorer.Live),
      Effect.provide(IrregularLayoutScorer.Live),
      Effect.provide(Layer.succeed(GeometrySettings, geometrySettings))
    )
  )
}

describe('intrinsic capacity integration', () => {
  it('runs the Short Side profile through the existing worker result and history path', async () => {
    const compactRequest = makeRectangleRequest({
      jobKey: 'short-side-production-slice',
      count: 2,
      widthMm: 40,
      heightMm: 30,
      sheet: new SheetSpec({ width: 200, height: 300, label: 'short-side production' }),
      paddingMm: 0
    })
    const shortSideSettings = new IrregularNestingSettings({
      geometry: DEFAULT_IRREGULAR_GEOMETRY_SETTINGS,
      optimizer: makeCompactShortSideIrregularOptimizerSettings()
    })
    const request = new NestingRequest({
      ...compactRequest,
      options: new NestingOptions({
        ...compactRequest.options,
        irregularSettings: shortSideSettings
      })
    })

    const computed = await compute(request)
    const output = makeIrregularWorkerOutput({
      request,
      computed,
      algorithmBenchmark: {
        startedAt: '2026-07-25T00:00:00.000Z',
        endedAt: '2026-07-25T00:00:01.000Z',
        elapsedMs: 1_000
      }
    })
    const layout = output.result.layout
    if (layout === undefined || layout.kind !== 'irregular') {
      throw new Error('expected an irregular Short Side layout')
    }

    expect(layout.placements).toHaveLength(2)
    expect(layout.unplacedPieceIds).toEqual([])
    expect(computed.intrinsicShortSideObserverTrace).toBeDefined()
    expect(computed.intrinsicShortSidePairFoldTrace).toMatchObject({
      status: 'accepted',
      outputInfluence: 'selected'
    })
    expect(
      computed.diagnostics.some(({ code }) => code === 'intrinsic_short_side_selected')
    ).toBe(true)
    expect(output.result.strategyResults[0]?.strategyId).toBe(
      'irregular-convex-compact-short-side'
    )
    expect(output.historyFrames).toHaveLength(3)
    expect(output.historyFrames.at(-1)?.placements).toHaveLength(2)
  })

  it(
    'runs focused complete reconstruction by default and preserves the protected duplicate fallback',
    async () => {
      const request = makeRectangleRequest({
        jobKey: 'focused-complete-duplicate',
        count: 2,
        widthMm: 40,
        heightMm: 30,
        sheet: new SheetSpec({ width: 200, height: 200, label: 'roomy 200x200' }),
        paddingMm: 0
      })
      const computed = await compute(request)
      const disabled = await compute(request, {
        focusedCompleteReconstructionControlArm: 'disable'
      })
      let callbackTrace:
        | NonNullable<typeof computed.intrinsicShortSideObserverTrace>
        | undefined
      const observed = await compute(request, {
        captureIntrinsicShortSideObserver: true,
        captureIntrinsicShortSidePairFoldObserver: true,
        onIntrinsicShortSideObserver: (trace) => {
          callbackTrace = trace
        }
      })

      expect(computed.focusedCompleteReconstructionTrace).toMatchObject({
        version: 'intrinsic-focused-complete-reconstruction-v1',
        status: 'duplicate-order',
        candidateCanonicalGeometryHash: undefined,
        consumedCandidateEvaluations: 0,
        candidateEvaluationAccountingComplete: true,
        outputInfluence: 'protected-fallback',
        failureReason: undefined
      })
      expect(
        computed.focusedCompleteReconstructionTrace
          ?.sourceCanonicalGeometryHash
      ).toBeDefined()
      expect(
        computed.focusedCompleteReconstructionTrace
          ?.selectedCanonicalGeometryHash
      ).toBe(
        computed.focusedCompleteReconstructionTrace
          ?.sourceCanonicalGeometryHash
      )
      expect(disabled.focusedCompleteReconstructionTrace).toBeUndefined()
      expect(computed.placedCollisionGeometries).toEqual(
        disabled.placedCollisionGeometries
      )
      expect(computed.unplacedPieceIds).toEqual(disabled.unplacedPieceIds)
      expect(observed.placedCollisionGeometries).toEqual(
        computed.placedCollisionGeometries
      )
      expect(observed.unplacedPieceIds).toEqual(computed.unplacedPieceIds)
      expect(observed.portfolio).toEqual(computed.portfolio)
      expect(observed.intrinsicShortSideObserverTrace).toMatchObject({
        status: 'observed-no-directional-improvement',
        outputInfluence: 'none',
        placementEvaluations: 0,
        candidateEvaluations: 0
      })
      expect(callbackTrace).toEqual(observed.intrinsicShortSideObserverTrace)
      expect(observed.intrinsicShortSidePairFoldTrace).toMatchObject({
        status: 'accepted',
        outputInfluence: 'none'
      })
    },
    120_000
  )

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
      const baseline = await compute(request)
      let callbackTrace:
        | NonNullable<typeof baseline.intrinsicShortSideObserverTrace>
        | undefined
      const computed = await compute(request, {
        captureIntrinsicShortSideObserver: true,
        onIntrinsicShortSideObserver: (trace) => {
          callbackTrace = trace
        }
      })

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('preflight-proven-impossible')
      expect(computed.capacityTrace?.preflight.kind).toBe('proven_impossible')
      expect(computed.capacityTrace?.prefixes.capturedCount).toBe(0)
      expect(computed.capacityTrace?.qualityWarmPrefix).toBeUndefined()
      expect(computed.capacityTrace?.coldSearch.auxiliaryPlacementEvaluations).toBe(0)
      expect(computed.focusedCompleteReconstructionTrace).toMatchObject({
        status: 'skipped-preflight-proven-impossible',
        sourceCanonicalGeometryHash: undefined,
        candidateCanonicalGeometryHash: undefined,
        selectedCanonicalGeometryHash: undefined,
        consumedCandidateEvaluations: 0,
        outputInfluence: 'none'
      })
      expect(computed.intrinsicShortSideObserverTrace).toMatchObject({
        status: 'skipped-no-settled-complete-endpoints',
        outputInfluence: 'none',
        settledEndpointCount: 0,
        evaluatedOrientationCount: 0,
        placementEvaluations: 0,
        candidateEvaluations: 0
      })
      expect(callbackTrace).toEqual(computed.intrinsicShortSideObserverTrace)
      expect(computed.placedCollisionGeometries).toEqual(
        baseline.placedCollisionGeometries
      )
      expect(computed.unplacedPieceIds).toEqual(baseline.unplacedPieceIds)
      expect(computed.portfolio).toEqual(baseline.portfolio)

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
      let cohesionEndpointPlacedCount: number | undefined
      const cohesionObserved = await compute(request, {
        captureCapacityCohesionShadow: true,
        onCapacityCohesionShadowLane: (endpoint) => {
          cohesionEndpointPlacedCount = endpoint?.metrics.placedCount
        }
      })
      const scheduled = await compute(request, {
        intrinsicAnytimeSchedulerMode: 'deterministic-v1',
        captureExperimentalPlaceDeferCompleteShadow: true
      })

      expect(computed.capacityTrace).toBeDefined()
      expect(computed.capacityTrace?.routing).toBe('bounded-complete-archive-miss')
      expect(computed.capacityTrace?.preflight.kind).toBe('inconclusive')
      expect(computed.focusedCompleteReconstructionTrace).toMatchObject({
        status: 'skipped-no-fitting-protected-endpoint',
        candidateCanonicalGeometryHash: undefined,
        selectedCanonicalGeometryHash: undefined,
        consumedCandidateEvaluations: 0,
        outputInfluence: 'none'
      })
      expect(
        computed.focusedCompleteReconstructionTrace
          ?.sourceCanonicalGeometryHash
      ).toBeDefined()

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
            (status === 'settled' ||
              status === 'checkpointed-censored') &&
            reusedPlacedCount > 0 &&
            completedDepths <= request.pieces.length
        )
      ).toBe(true)
      const omitRetentionTimings = (
        trace: NonNullable<typeof computed.capacityTrace>['coldSearch']
      ) => ({
        ...trace,
        topologyRetentionDepths: trace.topologyRetentionDepths?.map(
          ({
            topologyMeasurementMs: _topologyMeasurementMs,
            contactMeasurementMs: _contactMeasurementMs,
            ...depth
          }) => depth
        )
      })
      expect(
        observed.capacityTrace?.coldSearch === undefined
          ? undefined
          : omitRetentionTimings(observed.capacityTrace.coldSearch)
      ).toEqual(
        computed.capacityTrace?.coldSearch === undefined
          ? undefined
          : omitRetentionTimings(computed.capacityTrace.coldSearch)
      )
      expect(observed.placedCollisionGeometries).toEqual(computed.placedCollisionGeometries)
      expect(observed.unplacedPieceIds).toEqual(computed.unplacedPieceIds)
      expect(cohesionObserved.placedCollisionGeometries).toEqual(
        computed.placedCollisionGeometries
      )
      expect(cohesionObserved.unplacedPieceIds).toEqual(
        computed.unplacedPieceIds
      )
      expect(cohesionObserved.capacityTrace?.cohesionShadow).toMatchObject({
        producerRole: 'capacity-cohesion-shadow',
        status: 'settled',
        outputInfluence: 'none',
        completedDepths: request.pieces.length
      })
      expect(cohesionEndpointPlacedCount).toBe(
        cohesionObserved.capacityTrace?.cohesionShadow?.endpoint?.placedCount
      )
      const retentionDepths =
        cohesionObserved.capacityTrace?.cohesionShadow?.retentionDepths
      expect(retentionDepths).toHaveLength(request.pieces.length)
      expect(
        retentionDepths?.every(
          (depth) =>
            depth.representatives.length === 5 &&
            depth.retainedCount <= 16 &&
            depth.topologyMeasurementCount > 0 &&
            depth.topologyMeasurementMs >= 0 &&
            depth.legalCandidateCount >=
              depth.contactMeasuredCandidateCount &&
            depth.contactMeasuredCandidateCount >=
              depth.positiveContactCandidateCount &&
            depth.contactMeasurementMs >= 0 &&
            depth.contactSelectedSuccessorCount <= 16 &&
            depth.contactRetainedSuccessorCount <=
              depth.contactSelectedSuccessorCount &&
            depth.representatives.every(
              (representative) =>
                representative.parentDecisionIdentity.length > 0 &&
                representative.decisionIdentity.length > 0 &&
                representative.pieceId === depth.pieceId &&
                (representative.decision === 'skip'
                  ? representative.proposalRole === 'skip'
                  : representative.proposalRole === 'compactness' ||
                    representative.proposalRole === 'contact')
            )
        )
      ).toBe(true)
      expect(
        computed.intrinsicAnytimeSchedulerTrace === undefined
          ? false
          : intrinsicAnytimeSchedulerTraceValid(
              computed.intrinsicAnytimeSchedulerTrace
            )
      ).toBe(true)
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.coldCheckpointReused).toBe(true)
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.cancellationReason).toBe(
        'complete-cohort-miss'
      )
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.warmPrefixEndpointsAdmitted).toBe(
        true
      )
      expect(scheduled.capacityTrace?.warmPrefixEndpointsAdmitted).toBe(true)
      expect(scheduled.capacityTrace?.qualityWarmPrefix).toMatchObject({
        version: 'intrinsic-capacity-quality-warm-prefix-v1',
        producerRole: 'capacity-quality-warm-prefix',
        policy: 'quality-frontier',
        sourceRole: 'canonical-grid'
      })
      expect(
        scheduled.intrinsicAnytimeSchedulerTrace === undefined
          ? false
          : intrinsicAnytimeSchedulerTraceValid(scheduled.intrinsicAnytimeSchedulerTrace)
      ).toBe(true)
      const warmLaneCount = scheduled.capacityTrace?.warmPrefixLanes?.length ?? 0
      const laneCoordinator = scheduled.capacityTrace?.laneCoordinator
      const warmPrefixLanes = scheduled.capacityTrace?.warmPrefixLanes ?? []
      expect(
        laneCoordinator === undefined
          ? false
          : intrinsicCapacityLaneCoordinatorTraceValid(
              laneCoordinator,
              warmPrefixLanes,
              scheduled.capacityTrace?.qualityWarmPrefix
            )
      ).toBe(true)
      expect(
        new Set(
          laneCoordinator?.quanta.flatMap((quantum) =>
            quantum.producerRole === 'capacity-warm-prefix' &&
            quantum.phase === 'resume' &&
            quantum.placementEvaluationDelta > 0
              ? [`${quantum.sourceRole}@${quantum.prefixDepth}`]
              : []
          )
        ).size
      ).toBe(warmLaneCount > 0 ? 1 : 0)
      if (laneCoordinator !== undefined) {
        const firstPositiveQuantumIndex = laneCoordinator.quanta.findIndex(
          ({ placementEvaluationDelta }) => placementEvaluationDelta > 0
        )
        const firstPositiveQuantum =
          laneCoordinator.quanta[firstPositiveQuantumIndex]
        expect(firstPositiveQuantum).toBeDefined()
        if (firstPositiveQuantum !== undefined) {
          const corruptedQuanta = [...laneCoordinator.quanta]
          corruptedQuanta[firstPositiveQuantumIndex] = {
            ...firstPositiveQuantum,
            placementEvaluationDelta:
              firstPositiveQuantum.placementEvaluationDelta + 1
          }
          expect(
            intrinsicCapacityLaneCoordinatorTraceValid(
              {
                ...laneCoordinator,
                quanta: corruptedQuanta
              },
              warmPrefixLanes,
              scheduled.capacityTrace?.qualityWarmPrefix
            )
          ).toBe(false)
        }
      }
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
      ).not.toContainEqual({ role: 'capacity-cold' })
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
      ).toBeLessThanOrEqual(warmLaneCount + 1)
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
      expect(computed.capacityTrace?.qualityWarmPrefix).toBeUndefined()
      expect(computed.portfolio.terminationReason).toBe('shared_archive_completed')
      expect(computed.unplacedPieceIds).toEqual([])
      expect(scheduled.placedCollisionGeometries).toEqual(computed.placedCollisionGeometries)
      expect(scheduled.unplacedPieceIds).toEqual([])
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.cancellationReason).toBe(
        'complete-endpoint-fitted'
      )
      expect(scheduled.intrinsicAnytimeSchedulerTrace?.quanta.at(-1)?.outcome).toBe(
        'settled'
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
      ).toEqual(
        expect.arrayContaining([
          'capacity-cold:checkpointed',
          'legacy-complete:checkpointed',
          'capacity-cold:settled',
          'legacy-complete:settled',
          'experimental-place-defer-complete:settled'
        ])
      )
      const diagnosticCodes = computed.diagnostics.map(({ code }) => code)
      expect(diagnosticCodes).toContain('capacity_preflight_inconclusive')
      expect(diagnosticCodes).toContain('complete_archive_fitted')
      expect(diagnosticCodes).not.toContain('capacity_subset_settled')
      expect(diagnosticCodes).not.toContain('bounded_complete_archive_miss')
    },
    120_000
  )
})
