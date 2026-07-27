import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { DxfGeometrySummary, ImportedPiece } from '@shared/domain/dxf.js'
import { Rect } from '@shared/domain/geometry.js'
import { PieceId, SourceFileId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  CollisionGeometry,
  IrregularBounds,
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon,
  IrregularPreparedPiece,
  IrregularTransform,
  TransformedCollisionGeometry,
  IrregularTransformCandidate
} from '@shared/irregular/domain.js'
import {
  compareIntrinsicStrictCompletedLayoutDominance,
  decodeIntrinsicStrictPriorityOrder,
  constructIntrinsicStrictState,
  INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS,
  INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO,
  intrinsicStrictPhaseCoverageComplete,
  intrinsicStrictCompletedLayoutDominates,
  measureIntrinsicStrictCanonicalEnvelope,
  rankIntrinsicStrictCompletedLayouts,
  selectIntrinsicStrictFamilyWinner,
  type IntrinsicStrictDirectCheckpoint,
  type IntrinsicStrictComparatorMode,
  type IntrinsicStrictCompletedMetrics
} from '../../src/workers/algorithm/irregular/intrinsicStrictDecoder.js'
import {
  auditIntrinsicReferenceSuccessorReachability,
  runIntrinsicPartialGeometricBeam,
  runIntrinsicPeelReinsertObserver,
  runIntrinsicQueueBeamDiscriminator,
  measureExactDoubledPathsArea,
  selectIntrinsicCompactClosureCandidates,
  selectIntrinsicPartialGeometricBeam,
  type IntrinsicPartialGeometricBeamCandidate,
  type IntrinsicQueueBeamAxes
} from '../../src/workers/algorithm/irregular/intrinsicQueueBeamDiscriminator.js'
import { IrregularBeamState } from '../../src/workers/algorithm/irregular/irregularBeamState.js'
import { assertCanonicalGridLegalLayout } from '../../src/workers/irregular/canonicalLayoutGeometry.js'
import { GeometryKernel, GeometrySettings } from '../../src/workers/irregular/geometryKernel.js'
import { NfpIfpServiceLive } from '../../src/workers/irregular/nfpIfpService.js'
import { NfpIfpService } from '../../src/workers/irregular/services.js'

function point(x: number, y: number): IrregularPoint {
  return new IrregularPoint({ x, y })
}

function rectanglePoints(width: number, height: number): ReadonlyArray<IrregularPoint> {
  return [point(0, 0), point(width, 0), point(width, height), point(0, height)]
}

function bounds(points: ReadonlyArray<IrregularPoint>): IrregularBounds {
  return new IrregularBounds({
    minX: Math.min(...points.map(({ x }) => x)),
    minY: Math.min(...points.map(({ y }) => y)),
    maxX: Math.max(...points.map(({ x }) => x)),
    maxY: Math.max(...points.map(({ y }) => y))
  })
}

function sourcePiece(id: string): ImportedPiece {
  return new ImportedPiece({
    id: PieceId.make(id),
    sourceFileId: SourceFileId.make(`source-${id}`),
    label: id,
    realBounds: new Rect({ x: 0, y: 0, width: 1, height: 1 }),
    geometry: new DxfGeometrySummary({ entityType: 'PRESET_SHAPE', closed: true, segments: [] }),
    warnings: []
  })
}

function transform(index: number, rotationDeg: number): IrregularTransformCandidate {
  return new IrregularTransformCandidate({
    index,
    rotationDeg,
    mirrored: false,
    reason: 'configured'
  })
}

function preparedPiece(
  id: string,
  points: ReadonlyArray<IrregularPoint>,
  transforms: ReadonlyArray<IrregularTransformCandidate>
): IrregularPreparedPiece {
  const shape = new IrregularPolygon({ points })
  return new IrregularPreparedPiece({
    pieceId: PieceId.make(id),
    source: sourcePiece(id),
    allowMirror: false,
    collisionGeometry: new CollisionGeometry({
      sourcePieceId: PieceId.make(id),
      sourceBounds: bounds(points),
      sampledPoints: points,
      convexHull: shape,
      collisionPolygon: shape,
      placementReference: point(0, 0),
      diagnostics: []
    }),
    transforms
  })
}

function sheet(width: number, height: number): SheetSpec {
  return new SheetSpec({ width, height, label: `${width}x${height}` })
}

function decode(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  comparatorMode?: IntrinsicStrictComparatorMode
) {
  const options = comparatorMode === undefined ? {} : { comparatorMode }
  return Effect.runPromise(
    decodeIntrinsicStrictPriorityOrder(finalSheet, pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(NfpIfpServiceLive)
    )
  )
}

function decodeWithCandidateService(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  nfpLayer: Layer.Layer<NfpIfpService>,
  comparatorMode?: IntrinsicStrictComparatorMode
) {
  const options = comparatorMode === undefined ? {} : { comparatorMode }
  return Effect.runPromise(
    decodeIntrinsicStrictPriorityOrder(finalSheet, pieces, options).pipe(
      Effect.provide(GeometryKernel.Live),
      Effect.provide(GeometrySettings.Live),
      Effect.provide(nfpLayer)
    )
  )
}

describe('decodeIntrinsicStrictPriorityOrder', () => {
  it('fails strict phase coverage when unclassified residual exceeds one percent', () => {
    expect(intrinsicStrictPhaseCoverageComplete(100, 1)).toBe(true)
    expect(intrinsicStrictPhaseCoverageComplete(100, 1.000_001)).toBe(false)
  })

  it('accepts an instrumentation-sized residual once a phase shrinks below the ratio', () => {
    // the residual is dominated by the timing calls themselves, so the ratio
    // stops being meaningful when the phase approaches that cost. Above the
    // floor the one-percent rule still governs.
    expect(INTRINSIC_STRICT_PHASE_INSTRUMENTATION_ALLOWANCE_MS).toBe(0.05)
    expect(INTRINSIC_STRICT_PHASE_MAXIMUM_RELAXED_RESIDUAL_RATIO).toBe(0.05)
    expect(intrinsicStrictPhaseCoverageComplete(1.57, 0.03)).toBe(true)
    expect(intrinsicStrictPhaseCoverageComplete(1.57, 0.048)).toBe(true)
    expect(intrinsicStrictPhaseCoverageComplete(0.5, 0.5)).toBe(false)
    expect(intrinsicStrictPhaseCoverageComplete(0.5, 0.05)).toBe(false)
    expect(intrinsicStrictPhaseCoverageComplete(2, 0.05)).toBe(true)
    expect(intrinsicStrictPhaseCoverageComplete(2, 0.050_001)).toBe(false)
    // above the allowance the ratio still governs and still rejects
    expect(intrinsicStrictPhaseCoverageComplete(100, 1.5)).toBe(false)
    expect(intrinsicStrictPhaseCoverageComplete(1000, 50)).toBe(false)
  })

  it('stops strict construction at an exact candidate-evaluation cap', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)])
    ]
    const constructed = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        maximumCandidateEvaluationCount: 1
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(constructed.candidateEvaluationCount).toBe(1)
    expect(constructed.truncationReason).toBe('maximum-candidate-evaluations')
    expect(constructed.state.placedCollisionGeometries).toHaveLength(0)
    expect(constructed.state.remainingPreparedPieces).toHaveLength(2)
    expect(constructed.stepTrace).toEqual([])
    expect(constructed.checkpoint).toBeUndefined()
  })

  it('reproduces uninterrupted canonical construction through every-piece resume', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('fourth', rectanglePoints(2, 1), [transform(0, 0), transform(1, 90)])
    ]
    const run = (
      checkpoint?: Parameters<typeof constructIntrinsicStrictState>[0]['checkpoint']
    ) =>
      Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: 'pure-growth',
          producerRole: 'canonical-grid',
          captureCandidateEvaluationCount: true,
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(checkpoint === undefined ||
          checkpoint.nextPieceIndex < pieces.length - 1
            ? { maximumCompletedPieceBoundaries: 1 }
            : {})
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    const uninterrupted = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        producerRole: 'canonical-grid',
        captureCandidateEvaluationCount: true
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    let resumed = await run()
    const resumeBoundaries: number[] = []
    while (resumed.checkpoint !== undefined) {
      resumeBoundaries.push(resumed.checkpoint.nextPieceIndex)
      resumed = await run(resumed.checkpoint)
    }

    expect(resumeBoundaries).toEqual([1, 2, 3])
    expect(resumed.pauseReason).toBeUndefined()
    expect(resumed.state).toEqual(uninterrupted.state)
    expect(resumed.stepTrace).toEqual(uninterrupted.stepTrace)
    expect(resumed.gapFillEvidence).toEqual(uninterrupted.gapFillEvidence)
    expect(resumed.candidateEvaluationCount).toBe(
      uninterrupted.candidateEvaluationCount
    )
    expect(resumed.state.placementOrder).toEqual(
      uninterrupted.state.placementOrder
    )

    const firstCheckpointed = await run()
    const checkpoint = firstCheckpointed.checkpoint
    if (checkpoint === undefined) throw new Error('expected direct checkpoint')
    await expect(
      Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: 'legacy-absolute-envelope',
          producerRole: 'canonical-grid',
          checkpoint,
          maximumCompletedPieceBoundaries: 1
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    ).rejects.toMatchObject({
      _tag: 'IntrinsicStrictDecoderError',
      operation: 'directCheckpoint'
    })
  })

  it('rejects corrupted direct state lineage and changed settlement policy', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const run = (input: {
      readonly checkpoint?: IntrinsicStrictDirectCheckpoint
      readonly maximumRuntimeMs?: number
      readonly maximumCandidateEvaluationCount?: number
      readonly capturePhaseTimings?: boolean
    }) =>
      Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: 'pure-growth',
          producerRole: 'canonical-grid',
          maximumCompletedPieceBoundaries: 1,
          ...(input.checkpoint === undefined
            ? {}
            : { checkpoint: input.checkpoint }),
          ...(input.maximumRuntimeMs === undefined
            ? {}
            : { maximumRuntimeMs: input.maximumRuntimeMs }),
          ...(input.maximumCandidateEvaluationCount === undefined
            ? {}
            : {
                maximumCandidateEvaluationCount:
                  input.maximumCandidateEvaluationCount
              }),
          ...(input.capturePhaseTimings !== true
            ? {}
            : { capturePhaseTimings: true })
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    const expectCheckpointRejection = async (
      checkpoint: IntrinsicStrictDirectCheckpoint,
      options: {
        readonly maximumRuntimeMs?: number
        readonly maximumCandidateEvaluationCount?: number
        readonly capturePhaseTimings?: boolean
      } = {}
    ) => {
      await expect(run({ checkpoint, ...options })).rejects.toMatchObject({
        _tag: 'IntrinsicStrictDecoderError',
        operation: 'directCheckpoint'
      })
    }

    const first = await run({})
    const checkpoint = first.checkpoint
    if (checkpoint === undefined) throw new Error('expected direct checkpoint')
    const root = checkpoint.state.parent
    if (root === undefined) throw new Error('expected direct checkpoint root')

    const missingProcessedState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: [],
      placementOrder: [],
      parent: root
    })
    const changedPlacementOrderState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: [],
      parent: root
    })
    const changedUnplacedDecisionState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      unplacedPieceIds: [PieceId.make('first')],
      placementOrder: checkpoint.state.placementOrder,
      parent: root
    })
    const brokenParentState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder
    })
    const mismatchedIdentityState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder,
      parent: root
    })
    Object.defineProperty(mismatchedIdentityState, 'canonicalOccupiedGeometryKey', {
      value: 'corrupted-occupied-identity'
    })

    await expectCheckpointRejection({
      ...checkpoint,
      state: missingProcessedState
    })
    await expectCheckpointRejection({
      ...checkpoint,
      state: changedPlacementOrderState
    })
    await expectCheckpointRejection({
      ...checkpoint,
      state: changedUnplacedDecisionState
    })
    await expectCheckpointRejection({ ...checkpoint, state: brokenParentState })
    await expectCheckpointRejection({
      ...checkpoint,
      state: mismatchedIdentityState
    })
    await expectCheckpointRejection({
      ...checkpoint,
      candidateEvaluationCount: checkpoint.candidateEvaluationCount - 1
    })
    await expectCheckpointRejection(checkpoint, { maximumRuntimeMs: 120_001 })

    const selfCycleState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder
    })
    Reflect.set(selfCycleState, 'parent', selfCycleState)
    await expectCheckpointRejection({ ...checkpoint, state: selfCycleState })

    const firstCycleState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder
    })
    const secondCycleState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder,
      parent: firstCycleState
    })
    Reflect.set(firstCycleState, 'parent', secondCycleState)
    await expectCheckpointRejection({ ...checkpoint, state: secondCycleState })

    const corruptedCacheState = new IrregularBeamState({
      remainingPreparedPieces: checkpoint.state.remainingPreparedPieces,
      placedCollisionGeometries: checkpoint.state.placedCollisionGeometries,
      placementOrder: checkpoint.state.placementOrder,
      parent: root
    })
    Reflect.set(corruptedCacheState, 'canonicalEntryKeys', ['corrupted'])
    Reflect.set(
      corruptedCacheState,
      'nearCompleteStructuralContactSignatureCounts',
      new Map([['corrupted', 99]])
    )
    Reflect.set(corruptedCacheState.placedCollisionIndex, 'buckets', new Map())
    await expectCheckpointRejection({
      ...checkpoint,
      state: corruptedCacheState
    })

    const capped = await run({
      maximumCandidateEvaluationCount: Number.MAX_SAFE_INTEGER
    })
    const cappedCheckpoint = capped.checkpoint
    if (cappedCheckpoint === undefined) {
      throw new Error('expected candidate-bounded direct checkpoint')
    }
    await expectCheckpointRejection(cappedCheckpoint, {
      maximumCandidateEvaluationCount: Number.MAX_SAFE_INTEGER - 1
    })

    const phased = await run({ capturePhaseTimings: true })
    const phasedCheckpoint = phased.checkpoint
    const phaseLedger = phasedCheckpoint?.phaseLedger
    if (phasedCheckpoint === undefined || phaseLedger === undefined) {
      throw new Error('expected phase-accounted direct checkpoint')
    }
    await expectCheckpointRejection(phasedCheckpoint)
    await expectCheckpointRejection(
      {
        ...phasedCheckpoint,
        phaseLedger: {
          ...phaseLedger,
          candidateGenerationMs: -1
        }
      },
      { capturePhaseTimings: true }
    )
  })

  it('preserves E1 output through the empty seeded-construction wrapper', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const decoded = await decode(sheet(20, 10), pieces)
    const constructed = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        maximumCandidateEvaluationCount: Number.MAX_SAFE_INTEGER
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    const exactCandidateEvaluationCount = constructed.candidateEvaluationCount
    if (exactCandidateEvaluationCount === undefined) {
      throw new Error('explicit candidate-evaluation accounting expected')
    }
    const exactlyCapped = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        maximumCandidateEvaluationCount: exactCandidateEvaluationCount
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(constructed.state.placedCollisionGeometries).toEqual(decoded.placedCollisionGeometries)
    expect(constructed.stepTrace).toEqual(decoded.stepTrace)
    expect(constructed.candidateEvaluationCount).toBe(
      constructed.stepTrace.reduce((sum, step) => sum + step.candidateCount, 0)
    )
    expect(constructed.truncationReason).toBeUndefined()
    expect(exactlyCapped.state).toEqual(constructed.state)
    expect(exactlyCapped.stepTrace).toEqual(constructed.stepTrace)
    expect(exactlyCapped.candidateEvaluationCount).toBe(constructed.candidateEvaluationCount)
    expect(exactlyCapped.truncationReason).toBeUndefined()

    const historicalDefault = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth'
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(historicalDefault.state).toEqual(constructed.state)
    expect(historicalDefault.stepTrace).toEqual(constructed.stepTrace)
    expect('candidateEvaluationCount' in historicalDefault).toBe(false)
    expect('truncationReason' in historicalDefault).toBe(false)
    expect('phaseTimings' in historicalDefault).toBe(false)

    const accountingOnly = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        captureCandidateEvaluationCount: true
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(accountingOnly.state).toEqual(constructed.state)
    expect(accountingOnly.stepTrace).toEqual(constructed.stepTrace)
    expect(accountingOnly.candidateEvaluationCount).toBe(exactCandidateEvaluationCount)
    expect(accountingOnly.truncationReason).toBeUndefined()

    const timed = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        capturePhaseTimings: true,
        timingNow: () => 0
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(timed.state).toEqual(constructed.state)
    expect(timed.stepTrace).toEqual(constructed.stepTrace)
    const phaseTimings = timed.phaseTimings
    if (phaseTimings === undefined) throw new Error('expected strict construction phase timings')
    expect(
      phaseTimings.candidateGenerationMs +
        phaseTimings.candidateStateScoringMs +
        phaseTimings.bookkeepingMs
    ).toBeCloseTo(phaseTimings.totalMs, 6)
    expect(
      phaseTimings.candidateStateScoring.placementObjectMs +
        phaseTimings.candidateStateScoring.statePlacementMs +
        phaseTimings.candidateStateScoring.bottomLeftAnchoringMs +
        phaseTimings.candidateStateScoring.envelopeScoringMs +
        phaseTimings.candidateStateScoring.gapClassificationMs +
        phaseTimings.candidateStateScoring.scoreBookkeepingMs +
        phaseTimings.candidateStateScoring.candidateSelectionMs +
        phaseTimings.candidateStateScoring.bookkeepingMs
    ).toBeCloseTo(phaseTimings.candidateStateScoring.totalMs, 6)
    expect(phaseTimings.candidateStateScoring.coverageComplete).toBe(true)
    expect(phaseTimings.candidateStateScoring.gapClassificationMs).toBeGreaterThanOrEqual(0)
    expect(phaseTimings.coverageComplete).toBe(true)

    let phaseClockTick = 0
    const incompletelyAccounted = await Effect.runPromise(
      constructIntrinsicStrictState({
        allPreparedPieces: pieces,
        remainingPreparedPieces: pieces,
        frozenPlaced: [],
        candidateMode: 'pure-growth',
        capturePhaseTimings: true,
        timingNow: () => phaseClockTick++
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(incompletelyAccounted.state).toEqual(constructed.state)
    expect(incompletelyAccounted.stepTrace).toEqual(constructed.stepTrace)
    expect(incompletelyAccounted.phaseTimings?.candidateStateScoring.coverageComplete).toBe(false)
    expect(incompletelyAccounted.phaseTimings?.coverageComplete).toBe(false)
  })

  it('keeps the strict seed output byte-identical while F0 observes source admission', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const run = (observed: boolean) => {
      let candidateObservations = 0
      let selectionObservations = 0
      const canonicalChecks: number[] = []
      return Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: 'pure-growth',
          ...(observed
            ? {
                featureContactObserver: {
                  onCandidateProvenance: ({ provenance }) => {
                    candidateObservations += 1
                    if (typeof provenance.canonicalChecked === 'number') {
                      canonicalChecks.push(provenance.canonicalChecked)
                    }
                    expect(provenance.phaseIncompatible).toBe('not-evaluated')
                  },
                  onStepSelection: () => {
                    selectionObservations += 1
                  }
                }
              }
            : {})
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (observed) {
                expect(candidateObservations).toBeGreaterThan(0)
                expect(selectionObservations).toBe(pieces.length)
                expect(canonicalChecks.some((count) => count > 0)).toBe(true)
              }
              return result
            })
          )
        )
      )
    }

    const [ordinary, observed] = await Promise.all([run(false), run(true)])
    expect(observed.state).toEqual(ordinary.state)
    expect(observed.stepTrace).toEqual(ordinary.stepTrace)
    expect(observed.gapFillEvidence).toEqual(ordinary.gapFillEvidence)
  })

  it('keeps selected geometry unchanged when the separate queue-beam audit runs', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const before = await decode(sheet(20, 10), pieces)
    const runAudit = (referenceLineageCanonicalGeometryKeys?: ReadonlyArray<string>) =>
      Effect.runPromise(
        runIntrinsicQueueBeamDiscriminator({
          orderedPreparedPieces: pieces,
          maximumRuntimeMs: 10_000,
          maximumEvaluations: 20_000,
          ...(referenceLineageCanonicalGeometryKeys === undefined
            ? {}
            : { referenceLineageCanonicalGeometryKeys })
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    const baselineAudit = await runAudit()
    const referenceLineageCanonicalGeometryKeys = baselineAudit.steps.flatMap(({ scheduled }) =>
      scheduled.selectedCanonicalGeometryKey === undefined
        ? []
        : [scheduled.selectedCanonicalGeometryKey]
    )
    const audit = await runAudit(referenceLineageCanonicalGeometryKeys)
    const after = await decode(sheet(20, 10), pieces)

    expect(audit.status).toBe('completed')
    expect(audit.selectedLineageFinalCanonicalGeometryKey.length).toBeGreaterThan(0)
    expect(audit.delayedLineage).toEqual({
      provided: true,
      matchedDepthCount: pieces.length,
      firstMissingDepth: undefined,
      minimumObservedSurvivalCapacity: 1,
      minimumObservedExperimentalWidth: 0
    })
    expect(
      audit.steps.every(({ commensurateQueue }) =>
        ['no-alternate-class', 'no-non-inert-alternate', 'completed'].includes(
          commensurateQueue.status
        )
      )
    ).toBe(true)
    expect(after.placedCollisionGeometries).toEqual(before.placedCollisionGeometries)
    expect(after.stepTrace).toEqual(before.stepTrace)
  })

  it('runs the bounded partial beam without enabling alternate-piece scheduling', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]

    const result = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet: sheet(20, 10),
        experimentalWidth: 3,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(result.status).toBe('completed')
    expect(result.completedDepthCount).toBe(pieces.length)
    expect(result.winner?.placedCollisionGeometries).toHaveLength(pieces.length)
    expect(result.protectedControlEvaluations).toBeGreaterThan(0)
    expect(result.experimentalEvaluations).toBeGreaterThan(0)
    expect(result.evaluations).toBe(
      result.protectedControlEvaluations + result.experimentalEvaluations
    )
    expect(result.steps.every(({ selectedSlots }) => selectedSlots.length <= 3)).toBe(true)
  })

  it('audits bounded generic peel/reinsert orders without changing the seed', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const finalSheet = sheet(20, 10)
    const seed = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet,
        experimentalWidth: 3,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(seed.winner).toBeDefined()
    if (seed.winner === undefined) throw new Error('expected a completed peel/reinsert seed')
    const seedPlacements = seed.winner.placedCollisionGeometries

    const observer = await Effect.runPromise(
      runIntrinsicPeelReinsertObserver({
        orderedPreparedPieces: pieces,
        finalSheet,
        seedPlacedCollisionGeometries: seedPlacements,
        seedMetrics: seed.winner.metrics,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(observer.status).toBe('completed')
    expect(observer.topContributorPieceIds).toHaveLength(3)
    expect(observer.subsetCount).toBe(4)
    expect(observer.reinsertionOrderCount).toBe(12)
    expect(observer.orderTraces).toHaveLength(observer.reinsertionOrderCount)
    expect(observer.orderTraces.every(({ status }) => status === 'completed')).toBe(true)
    for (const trace of observer.orderTraces) {
      const terminalStep = trace.steps.at(-1)
      expect(terminalStep).toBeDefined()
      expect(trace.generatedCompleteSuccessorCount).toBe(
        terminalStep?.uniqueFittingSuccessorCount
      )
      expect(terminalStep?.firstEvictedWitnesses).toHaveLength(0)
      for (const step of trace.steps.slice(0, -1)) {
        expect(step.allocationCells).toHaveLength(4)
        expect(
          step.allocationCells.find(({ cell }) => cell === 'w3-current')?.roles
        ).toEqual(['breadth', 'breadth', 'dispersion'])
        expect(
          step.allocationCells.find(({ cell }) => cell === 'w3-contact')?.roles
        ).toEqual(['breadth', 'contact', 'dispersion'])
      }
    }
    expect(observer.generatedCompleteSuccessorCount).toBeGreaterThan(0)
    expect(observer.terminallyAssessedSuccessorCount).toBeGreaterThan(0)
    expect(observer.terminallyAssessedSuccessorCount).toBeLessThanOrEqual(
      observer.generatedCompleteSuccessorCount
    )
    expect(observer.finalizedEndpointCount).toBeGreaterThan(0)
    expect(observer.uniqueEndpointCount).toBeGreaterThan(0)
    expect(
      observer.shadowCompletion.traces.some(
        ({ seedKinds }) => seedKinds.includes('contact-counterfactual')
      )
    ).toBe(true)
    expect(Array.isArray(observer.compactClosureComparisons)).toBe(true)
    expect(observer.evaluations).toBeGreaterThan(0)
    expect(seed.winner.placedCollisionGeometries).toEqual(seedPlacements)
  })

  it('deduplicates a four-piece reconstruction by geometry-class order', async () => {
    const pieces = ['first', 'second', 'third', 'fourth'].map((id) =>
      preparedPiece(id, rectanglePoints(1, 1), [transform(0, 0)])
    )
    const finalSheet = sheet(20, 10)
    const seed = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet,
        experimentalWidth: 3,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    expect(seed.winner).toBeDefined()
    if (seed.winner === undefined) throw new Error('expected a completed four-piece seed')

    const observer = await Effect.runPromise(
      runIntrinsicPeelReinsertObserver({
        orderedPreparedPieces: pieces,
        finalSheet,
        seedPlacedCollisionGeometries: seed.winner.placedCollisionGeometries,
        seedMetrics: seed.winner.metrics,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000,
        subsetSizes: [4],
        distinctGeometryClassOrdersOnly: true
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(observer.status).toBe('completed')
    expect(observer.subsetSizes).toEqual([4])
    expect(observer.distinctGeometryClassOrdersOnly).toBe(true)
    expect(observer.subsetCount).toBe(1)
    expect(observer.reinsertionOrderCount).toBe(1)
    expect(observer.orderTraces).toHaveLength(1)
    expect(observer.orderTraces[0]?.completedStepCount).toBe(4)
    expect(observer.generatedCompleteSuccessorCount).toBeGreaterThan(0)
    expect(observer.qualifyingCohesiveEndpointCount).toBeGreaterThanOrEqual(0)
    expect(
      observer.boundedEndpointWitnesses.every(
        (witness) =>
          witness.qualifiesCohesiveGate ===
          (witness.strictGeometricArchiveImprovement &&
            witness.improvesCohesion &&
            witness.passesTopologyGuard)
      )
    ).toBe(true)
  })

  it('keeps the width-zero control identical to the strict decoder at every depth', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const finalSheet = sheet(20, 10)
    const strict = await decode(finalSheet, pieces)
    const control = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet,
        experimentalWidth: 0,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(control.status).toBe('completed')
    expect(control.protectedControlEvaluations).toBeGreaterThan(0)
    expect(control.steps.every(({ selectedSlots }) => selectedSlots.length === 0)).toBe(true)
    expect(control.winner?.canonicalGeometryHash).toBe(strict.canonicalGeometryHash)
    expect(control.winner?.terminalRotationDeg).toBe(strict.terminalRotationDeg)
    expect(control.winner?.placedCollisionGeometries).toEqual(strict.placedCollisionGeometries)
  })

  it('keeps the completed protected control when experimental expansion exhausts its budget', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
    ]
    const finalSheet = sheet(20, 10)
    const strict = await decode(finalSheet, pieces)
    const calibrated = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet,
        experimentalWidth: 0,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: 20_000
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )
    const truncated = await Effect.runPromise(
      runIntrinsicPartialGeometricBeam({
        orderedPreparedPieces: pieces,
        finalSheet,
        experimentalWidth: 3,
        maximumRuntimeMs: 10_000,
        maximumEvaluations: calibrated.protectedControlEvaluations
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(truncated.status).toBe('truncated')
    expect(truncated.protectedControlEvaluations).toBe(calibrated.protectedControlEvaluations)
    expect(truncated.finalists.map(({ canonicalGeometryHash }) => canonicalGeometryHash)).toContain(
      strict.canonicalGeometryHash
    )
  })

  it('classifies a generated canonical successor as exactly reachable', async () => {
    const first = preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0)])
    const second = preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0)])
    const construct = (pieces: ReadonlyArray<IrregularPreparedPiece>) =>
      Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces: pieces,
          frozenPlaced: [],
          candidateMode: 'pure-growth'
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )
    const parent = await construct([first])
    const expected = await construct([first, second])
    const audit = await Effect.runPromise(
      auditIntrinsicReferenceSuccessorReachability({
        parentState: parent.state,
        expectedState: expected.state,
        piece: second,
        remainingPreparedPieces: []
      }).pipe(
        Effect.provide(GeometryKernel.Live),
        Effect.provide(GeometrySettings.Live),
        Effect.provide(NfpIfpServiceLive)
      )
    )

    expect(audit.classification).toBe('reachable-exact-successor')
    expect(audit.directLegal).toBe(true)
    expect(audit.exactTargetGenerated).toBe(true)
    expect(audit.envelopeEventCandidateCount).toBeGreaterThan(0)
    expect(audit.exactTargetEnvelopeEventGenerated).toBe(true)
    expect(audit.targetCanonicalLegal).toBe(true)
    expect(audit.targetMatchesExpectedCanonicalGeometry).toBe(true)
    expect(audit.freshRunsConsistent).toBe(true)
  })

  it('continues an exact frozen seed and rejects non-partitions', async () => {
    const pieces = [
      preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0)]),
      preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0)]),
      preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0)])
    ]
    const decoded = await decode(sheet(20, 10), pieces)
    const first = decoded.placedCollisionGeometries[0]
    expect(first).toBeDefined()
    if (first === undefined) return
    const run = (remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>) =>
      Effect.runPromise(
        constructIntrinsicStrictState({
          allPreparedPieces: pieces,
          remainingPreparedPieces,
          frozenPlaced: [first],
          candidateMode: 'pure-growth'
        }).pipe(
          Effect.provide(GeometryKernel.Live),
          Effect.provide(GeometrySettings.Live),
          Effect.provide(NfpIfpServiceLive)
        )
      )

    const continued = await run(pieces.slice(1))
    expect(continued.state.placedCollisionGeometries).toEqual(decoded.placedCollisionGeometries)
    await expect(run(pieces)).rejects.toMatchObject({
      _tag: 'IntrinsicStrictDecoderError',
      operation: 'seedPartition'
    })
  })

  it.each(['pure-growth', 'contact-band'] as const)(
    'keeps %s sheet-blind across differently sized legal sheets',
    async (comparatorMode) => {
      const pieces = [
        preparedPiece('first', rectanglePoints(3, 2), [transform(0, 0), transform(1, 90)]),
        preparedPiece('second', rectanglePoints(2, 2), [transform(0, 0), transform(1, 90)]),
        preparedPiece('third', rectanglePoints(1, 2), [transform(0, 0), transform(1, 90)])
      ]

      const landscape = await decode(sheet(20, 10), pieces, comparatorMode)
      const portrait = await decode(sheet(10, 20), pieces, comparatorMode)

      expect(landscape.status).toBe('completed')
      expect(portrait.status).toBe('completed')
      expect(landscape.canonicalGeometryHash).toBe(portrait.canonicalGeometryHash)
      expect(landscape.placements).toEqual(portrait.placements)
      expect(landscape.unplacedPieceIds).toEqual([])
      expect(landscape.certificate?.passes).toBe(true)
      expect(
        assertCanonicalGridLegalLayout(sheet(20, 10), landscape.placedCollisionGeometries)
      ).toBe(true)
    }
  )

  it('anchors the first transformed collision polygon at the normalized origin', async () => {
    const centered = [point(-2, -1), point(2, -1), point(2, 1), point(-2, 1)]
    const result = await decode(sheet(10, 10), [
      preparedPiece('centered', centered, [transform(0, 90)])
    ])

    expect(result.status).toBe('completed')
    expect(result.placedCollisionGeometries[0]?.placement.transform.translateX).toBe(1)
    expect(result.placedCollisionGeometries[0]?.placement.transform.translateY).toBe(2)
    expect(result.metrics?.envelopeMaximumSideMm).toBe(4)
  })

  it('preserves the best candidate from each transform family before selection', async () => {
    const candidateDomains: Array<string | undefined> = []
    const candidateService = Layer.succeed(NfpIfpService, {
      computeNfp: () => Effect.die('unused'),
      computeIfpBounds: () => Effect.die('unused'),
      generatePlacementCandidates: ({ moving, candidateDomain }) => {
        candidateDomains.push(candidateDomain)
        const candidatePoint = moving.transform.rotationDeg === 0 ? point(2, 0) : point(3, 0)
        return Effect.succeed([
          new IrregularPlacementCandidate({
            pieceId: moving.sourcePieceId,
            transform: moving.transform,
            point: candidatePoint,
            diagnostics: []
          })
        ])
      }
    })
    const result = await decodeWithCandidateService(
      sheet(20, 20),
      [
        preparedPiece('anchor', rectanglePoints(2, 2), [transform(0, 0)]),
        preparedPiece('family', rectanglePoints(4, 1), [transform(0, 0), transform(1, 90)])
      ],
      candidateService,
      'contact-band'
    )

    expect(result.status).toBe('completed')
    expect(result.stepTrace[1]).toMatchObject({
      candidateCount: 2,
      transformFamilyCount: 2,
      selectedTransformFamily: '90:0'
    })
    expect(result.placements[1]?.transform.rotationDeg).toBe(90)
    expect(candidateDomains).toEqual(['sheetless-nfp', 'sheetless-nfp'])
  })

  it('admits the exact two-percent area boundary and rejects the next value', () => {
    const pureLeader = familyWinner('pure', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_000,
      envelopeSpanMm: 200,
      sharedBoundaryLengthMm: 1
    })
    const atBoundary = familyWinner('boundary', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_020,
      envelopeSpanMm: 201,
      sharedBoundaryLengthMm: 10
    })
    const outsideBoundary = familyWinner('outside', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_020.001,
      envelopeSpanMm: 201,
      sharedBoundaryLengthMm: 100
    })

    expect(selectIntrinsicStrictFamilyWinner([pureLeader, atBoundary], 'contact-band')?.id).toBe(
      'boundary'
    )
    expect(
      selectIntrinsicStrictFamilyWinner([pureLeader, atBoundary, outsideBoundary], 'contact-band')
        ?.id
    ).toBe('boundary')
    expect(selectIntrinsicStrictFamilyWinner([pureLeader, atBoundary], 'pure-growth')?.id).toBe(
      'pure'
    )
  })

  it('ignores sub-grid ulp noise in family and contact-band compactness', () => {
    const quiet = familyWinner('quiet', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_000,
      envelopeSpanMm: 200,
      sharedBoundaryLengthMm: 1
    })
    const contact = familyWinner('contact', {
      maximumSideMm: 100 + 1e-10,
      envelopeAreaMm2: 10_000 + 1e-10,
      envelopeSpanMm: 200 + 1e-10,
      sharedBoundaryLengthMm: 2
    })

    expect(selectIntrinsicStrictFamilyWinner([quiet, contact], 'contact-band')?.id).toBe('contact')
  })

  it('keeps one-grid-square envelope differences exact near the coordinate limit', () => {
    const larger = familyWinner('larger', {
      maximumSideMm: 1_000_000,
      envelopeAreaMm2: 999_999_998_000,
      envelopeSpanMm: 2_000_000,
      sharedBoundaryLengthMm: 0,
      exact: {
        maximumSideGrid: 1_000_000_000,
        envelopeAreaGrid2: '999999998000000001',
        envelopeSpanGrid: 2_000_000_000
      }
    })
    const smaller = familyWinner('smaller', {
      maximumSideMm: 1_000_000,
      envelopeAreaMm2: 999_999_998_000,
      envelopeSpanMm: 2_000_000,
      sharedBoundaryLengthMm: 0,
      exact: {
        maximumSideGrid: 1_000_000_000,
        envelopeAreaGrid2: '999999998000000000',
        envelopeSpanGrid: 2_000_000_000
      }
    })

    expect(
      selectIntrinsicStrictFamilyWinner(
        [larger, smaller],
        'legacy-absolute-envelope'
      )?.id
    ).toBe('smaller')
  })

  it('measures the authoritative rounded world envelope after fractional translation', () => {
    const pieceId = PieceId.make('fractional-envelope')
    const localPoints = [point(0.00049, 0), point(1.001, 0), point(1.001, 1), point(0.00049, 1)]
    const transformCandidate = transform(0, 0)
    const placed = new IrregularPlacedPiece({
      placement: new IrregularPlacement({
        pieceId,
        sourcePieceId: pieceId,
        placementReference: point(0, 0),
        transform: new IrregularTransform({
          translateX: 0.00002,
          translateY: 0,
          rotationDeg: 0,
          mirrored: false
        })
      }),
      collisionGeometry: new TransformedCollisionGeometry({
        sourcePieceId: pieceId,
        transform: transformCandidate,
        polygon: new IrregularPolygon({ points: localPoints }),
        bounds: bounds(localPoints)
      })
    })

    expect(measureIntrinsicStrictCanonicalEnvelope([placed])).toEqual({
      maximumSideMm: 1,
      envelopeAreaMm2: 1,
      envelopeSpanMm: 2
    })
  })

  it('does not let a contact-rich chain buy maximum-side or area growth', () => {
    const pureLeader = familyWinner('pure', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_000,
      envelopeSpanMm: 200,
      sharedBoundaryLengthMm: 1
    })
    const longerChain = familyWinner('longer', {
      maximumSideMm: 100.001,
      envelopeAreaMm2: 9_000,
      envelopeSpanMm: 190,
      sharedBoundaryLengthMm: 1_000
    })
    const widerChain = familyWinner('wider', {
      maximumSideMm: 100,
      envelopeAreaMm2: 10_021,
      envelopeSpanMm: 201,
      sharedBoundaryLengthMm: 1_000
    })

    expect(
      selectIntrinsicStrictFamilyWinner([pureLeader, longerChain, widerChain], 'contact-band')?.id
    ).toBe('pure')
  })

  it('uses contact as a bounded frontier selector without making it a dominance veto', () => {
    const base: IntrinsicStrictCompletedMetrics = {
      envelopeMaximumSideMm: 100,
      envelopeAreaMm2: 8_000,
      envelopeSpanMm: 180,
      enclosedCavityCount: 0,
      totalEnclosedCavityAreaMm2: 0,
      largestOccupiedHullGapRatio: 0.05,
      isolatedPieceCount: 0,
      positiveContactComponentCount: 1,
      largestPositiveContactComponentSize: 10,
      largestPositiveContactComponentRatio: 1,
      occupiedAreaOutsideLargestContactComponentMm2: 0,
      occupiedHullWasteRatio: 0.05,
      totalStructuralContacts: 9,
      dominantStructuralContacts: 9,
      contactUnits: 9,
      sharedBoundaryLengthMm: 90,
      canonicalGeometryHash: 'fifteen-isolates',
      runtimeMs: 1
    }
    const fifteenIsolates = {
      ...base,
      isolatedPieceCount: 15
    }
    const twentySixIsolates = {
      ...base,
      isolatedPieceCount: 26,
      canonicalGeometryHash: 'twenty-six-isolates'
    }

    expect(compareIntrinsicStrictCompletedLayoutDominance(fifteenIsolates, twentySixIsolates)).toBe(
      0
    )
    expect(intrinsicStrictCompletedLayoutDominates(fifteenIsolates, twentySixIsolates)).toBe(false)
    expect(
      rankIntrinsicStrictCompletedLayouts([twentySixIsolates, fifteenIsolates]).map(
        ({ canonicalGeometryHash }) => canonicalGeometryHash
      )
    ).toEqual(['fifteen-isolates', 'twenty-six-isolates'])
  })

  it('lets geometric compactness and void quality dominate weaker contact topology', () => {
    const cohesive = completedMetrics('cohesive')
    const compactFragment = {
      ...cohesive,
      envelopeMaximumSideMm: 80,
      envelopeAreaMm2: 6_000,
      envelopeSpanMm: 160,
      isolatedPieceCount: 5,
      positiveContactComponentCount: 4,
      largestPositiveContactComponentSize: 4,
      largestPositiveContactComponentRatio: 0.4,
      occupiedAreaOutsideLargestContactComponentMm2: 5_000,
      largestOccupiedHullGapRatio: 0.04,
      occupiedHullWasteRatio: 0.04,
      totalStructuralContacts: 4,
      dominantStructuralContacts: 3,
      contactUnits: 4,
      sharedBoundaryLengthMm: 30,
      canonicalGeometryHash: 'compact-fragment'
    }

    expect(compareIntrinsicStrictCompletedLayoutDominance(cohesive, compactFragment)).toBe(1)
    expect(compareIntrinsicStrictCompletedLayoutDominance(compactFragment, cohesive)).toBe(-1)
    expect(intrinsicStrictCompletedLayoutDominates(cohesive, compactFragment)).toBe(false)
    expect(intrinsicStrictCompletedLayoutDominates(compactFragment, cohesive)).toBe(true)
  })

  it('does not let a contact-floor certificate partition override geometry', () => {
    const cohesive = completedMetrics('cohesive')
    const chain = {
      ...cohesive,
      envelopeMaximumSideMm: 500,
      envelopeAreaMm2: 5_000,
      envelopeSpanMm: 510,
      largestOccupiedHullGapRatio: 0.3,
      canonicalGeometryHash: 'chain'
    }
    const fragment = {
      ...cohesive,
      envelopeMaximumSideMm: 50,
      envelopeAreaMm2: 2_500,
      envelopeSpanMm: 100,
      isolatedPieceCount: 5,
      largestPositiveContactComponentRatio: 0.4,
      canonicalGeometryHash: 'fragment'
    }

    const ranked = rankIntrinsicStrictCompletedLayouts([fragment, chain, cohesive])
    expect(ranked[0]?.canonicalGeometryHash).toBe('fragment')
    expect(ranked.map(({ canonicalGeometryHash }) => canonicalGeometryHash)).toEqual([
      'fragment',
      'cohesive',
      'chain'
    ])
  })

  it('reserves experimental width for a repeated within-layer dispersion visit', () => {
    const candidates = [
      partialBeamCandidate('a', 0, 0, 0),
      partialBeamCandidate('b', 1, 2, 1),
      partialBeamCandidate('c', 2, 1, 2),
      partialBeamCandidate('d', 3, 3, 3)
    ]

    const selection = selectIntrinsicPartialGeometricBeam({
      candidates,
      experimentalWidth: 3
    })

    expect(selection.slots).toEqual([
      expect.objectContaining({ role: 'breadth', layer: 0, visit: 1 }),
      expect.objectContaining({ role: 'breadth', layer: 1, visit: 1 }),
      expect.objectContaining({ role: 'dispersion', layer: 1, visit: 2 })
    ])
    expect(selection.retained.map(({ futureEquivalenceKey }) => futureEquivalenceKey)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(selection.diagnostics).toEqual({
      inputCandidateCount: 4,
      futureDeduplicatedCandidateCount: 4,
      protectedCandidateExcludedCount: 0,
      selectableCandidateCount: 4,
      paretoLayerSizes: [1, 2, 1],
      paretoLayerExtractionComplete: true,
      unlayeredCandidateCount: 0
    })
    expect(selection.slots[2]?.dispersion).toBeUndefined()
  })

  it('allows only one contact turn and preserves a later dispersion slot', () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      partialBeamCandidate(
        `candidate-${index}`,
        index,
        8 - index,
        index === 7 ? -10 : index
      )
    )

    const selection = selectIntrinsicPartialGeometricBeam({
      candidates,
      experimentalWidth: 7
    })

    expect(selection.slots.filter(({ role }) => role === 'contact')).toHaveLength(1)
    expect(selection.slots.filter(({ role }) => role === 'dispersion').length).toBeGreaterThan(0)
    expect(selection.slots).toHaveLength(7)
  })

  it('conditions compact closure candidates against the compactness-first sibling', () => {
    const sibling = partialBeamCandidate('sibling', 0, 0, 2)
    const contactA = partialBeamCandidate('contact-a', 1, 2, 1)
    const contactB = partialBeamCandidate('contact-b', 2, 1, 0)
    const dominatedContact = partialBeamCandidate('dominated-contact', 3, 3, 1)

    const selection = selectIntrinsicCompactClosureCandidates([
      dominatedContact,
      contactB,
      sibling,
      contactA
    ])

    expect(selection?.sibling.futureEquivalenceKey).toBe('sibling')
    expect(selection?.candidates.map(({ entry }) => entry.futureEquivalenceKey)).toEqual([
      'contact-a',
      'contact-b'
    ])
    expect(selection?.candidates.map(({ marginalGrowth }) => marginalGrowth)).toEqual([
      { maximumSideGrid: 1, envelopeAreaGrid2: 1, hullWasteDoubledAreaGrid2: 2 },
      { maximumSideGrid: 2, envelopeAreaGrid2: 2, hullWasteDoubledAreaGrid2: 1 }
    ])
  })

  it('opens the next Pareto layer when shallow singleton layers cannot fill capacity', () => {
    const candidates = [
      partialBeamCandidate('layer-0', 0, 0, 0),
      partialBeamCandidate('layer-1', 1, 1, 1),
      partialBeamCandidate('layer-2', 2, 2, 2)
    ]

    const selection = selectIntrinsicPartialGeometricBeam({
      candidates,
      experimentalWidth: 3
    })

    expect(selection.retained.map(({ futureEquivalenceKey }) => futureEquivalenceKey)).toEqual([
      'layer-0',
      'layer-1',
      'layer-2'
    ])
    expect(selection.slots.map(({ role, layer }) => ({ role, layer }))).toEqual([
      { role: 'breadth', layer: 0 },
      { role: 'breadth', layer: 1 },
      { role: 'breadth', layer: 2 }
    ])
  })

  it('measures Clipper path area exactly across holes, components, and quarter turns', () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const hole = [
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 2 }
    ]
    const component = [
      { x: 20, y: 0 },
      { x: 23, y: 0 },
      { x: 23, y: 2 },
      { x: 20, y: 2 }
    ]
    const quarterTurned = outer.map(({ x, y }) => ({ x: -y, y: x }))

    expect(measureExactDoubledPathsArea([outer, hole])).toBe(192n)
    expect(measureExactDoubledPathsArea([outer, component])).toBe(212n)
    expect(measureExactDoubledPathsArea([quarterTurned])).toBe(200n)
    expect(
      measureExactDoubledPathsArea([
        [
          { x: Number.MAX_SAFE_INTEGER + 1, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 }
        ]
      ])
    ).toBeUndefined()
  })
})

function partialBeamCandidate(
  key: string,
  compactness: number,
  voids: number,
  fragmentation: number
): IntrinsicPartialGeometricBeamCandidate {
  const axes: IntrinsicQueueBeamAxes = {
    compactness: {
      maximumSideGrid: compactness,
      envelopeAreaGrid2: compactness,
      spanGrid: compactness
    },
    fragmentation: {
      occupiedDoubledAreaOutsideLargestComponentGrid2: fragmentation,
      isolatedPieceCount: fragmentation,
      positiveContactComponentCount: fragmentation,
      negativeLargestPositiveContactComponentSize: fragmentation,
      totalStructuralContacts: -fragmentation,
      dominantStructuralContacts: -fragmentation
    },
    voids: {
      enclosedCavityCount: voids,
      totalEnclosedCavityDoubledAreaGrid2: voids,
      largestHullGapDoubledAreaGrid2: voids,
      occupiedHullDoubledAreaGrid2: 1,
      occupiedHullWasteDoubledAreaGrid2: voids,
      occupiedDoubledAreaGrid2: 1
    }
  }
  return {
    futureEquivalenceKey: key,
    canonicalGeometryKey: key,
    axes,
    placedCollisionGeometries: []
  }
}

function completedMetrics(hash: string): IntrinsicStrictCompletedMetrics {
  return {
    envelopeMaximumSideMm: 100,
    envelopeAreaMm2: 8_000,
    envelopeSpanMm: 180,
    enclosedCavityCount: 0,
    totalEnclosedCavityAreaMm2: 0,
    largestOccupiedHullGapRatio: 0.05,
    isolatedPieceCount: 0,
    positiveContactComponentCount: 1,
    largestPositiveContactComponentSize: 10,
    largestPositiveContactComponentRatio: 1,
    occupiedAreaOutsideLargestContactComponentMm2: 0,
    occupiedHullWasteRatio: 0.05,
    totalStructuralContacts: 9,
    dominantStructuralContacts: 9,
    contactUnits: 9,
    sharedBoundaryLengthMm: 90,
    canonicalGeometryHash: hash,
    runtimeMs: 1
  }
}

function familyWinner(
  id: string,
  score: Omit<
    Parameters<typeof selectIntrinsicStrictFamilyWinner>[0][number]['score'],
    'canonicalCombinedGeometryKey'
  >
) {
  return {
    id,
    movingCollisionAreaMm2: 1_000,
    score: {
      ...score,
      canonicalCombinedGeometryKey: id
    }
  }
}
