import { Data, Effect, Order } from 'effect'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPreparedPiece,
  IrregularTransform,
  IrregularTransformCandidate,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import {
  analyzeCanonicalLayoutStructure,
  assertCanonicalGridLegalLayout,
  canonicalCollisionLayoutIdentity,
  measureCanonicalEnclosedCavities,
  measureCanonicalLayoutContacts,
  measureCanonicalLayoutEnvelope,
  measureCanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import { fromGrid, toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  type IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  IrregularNestingNotImplementedError,
  type NfpIfpCandidateProvenance,
  NfpIfpService
} from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  candidateContainedInIntrinsicGap,
  deriveCanonicalIntrinsicGapRegions,
  type CanonicalIntrinsicGapRegion
} from './intrinsicGapRegions.js'

const INTRINSIC_COORDINATE_DOMAIN = new SheetSpec({
  width: 1,
  height: 1,
  label: 'intrinsic-sheetless-coordinate-domain'
})

const transformCandidateOrder = Order.combineAll<IrregularTransformCandidate>([
  Order.mapInput(Order.Number, (transform) => transform.index),
  Order.mapInput(Order.Number, (transform) => transform.rotationDeg),
  Order.mapInput(Order.Boolean, (transform) => transform.mirrored),
  Order.mapInput(Order.String, (transform) => transform.reason)
])

export const INTRINSIC_STRICT_COHESION_FLOORS = {
  maximumEnclosedCavityCount: 2,
  maximumIsolatedPieceCount: 2,
  minimumLargestPositiveContactComponentRatio: 0.8,
  maximumLargestOccupiedHullGapRatio: 0.15
} as const

export class IntrinsicStrictDecoderError extends Data.TaggedError('IntrinsicStrictDecoderError')<{
  readonly operation: string
  readonly message: string
}> {}

export interface IntrinsicStrictStepTrace {
  readonly pieceId: PieceId
  readonly candidateCount: number
  readonly transformFamilyCount: number
  readonly selectedTransformFamily: string | undefined
  readonly selectedScore: IntrinsicStrictLocalScore | undefined
}

export interface IntrinsicStrictLocalScore {
  readonly maximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalCombinedGeometryKey: string
}

export type IntrinsicStrictComparatorMode =
  | 'pure-growth'
  | 'legacy-absolute-envelope'
  | 'contact-band'

export type IntrinsicStrictCandidateMode =
  | IntrinsicStrictComparatorMode
  | { readonly kind: 'gap-contained' }

export interface IntrinsicStrictFamilyWinner {
  readonly score: IntrinsicStrictLocalScore
  readonly movingCollisionAreaMm2: number
}

export interface IntrinsicStrictCompletedMetrics {
  readonly envelopeMaximumSideMm: number
  readonly envelopeAreaMm2: number
  readonly envelopeSpanMm: number
  readonly enclosedCavityCount: number
  readonly totalEnclosedCavityAreaMm2: number
  readonly largestOccupiedHullGapRatio: number
  readonly isolatedPieceCount: number
  readonly positiveContactComponentCount: number
  readonly largestPositiveContactComponentSize: number
  readonly largestPositiveContactComponentRatio: number
  readonly occupiedAreaOutsideLargestContactComponentMm2: number
  readonly occupiedHullWasteRatio: number
  readonly totalStructuralContacts: number
  readonly dominantStructuralContacts: number
  readonly contactUnits: number
  readonly sharedBoundaryLengthMm: number
  readonly canonicalGeometryHash: string
  readonly runtimeMs: number
}

export interface IntrinsicSheetlessCompletedLayout {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly canonicalGeometryIdentity: string
  readonly canonicalGeometryHash: string
  readonly metrics: IntrinsicStrictCompletedMetrics
}

export interface IntrinsicStrictCertificate {
  readonly passes: boolean
  readonly violatedFloors: ReadonlyArray<keyof typeof INTRINSIC_STRICT_COHESION_FLOORS>
  readonly relativeDeficitSum: number
}

export interface IntrinsicStrictDecodeResult {
  readonly status: 'completed' | 'incomplete' | 'infeasible-final-sheet'
  readonly placements: ReadonlyArray<IrregularPlacement>
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly terminalRotationDeg: 0 | 90 | undefined
  readonly canonicalGeometryHash: string | undefined
  readonly metrics: IntrinsicStrictCompletedMetrics | undefined
  readonly certificate: IntrinsicStrictCertificate | undefined
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}

export interface IntrinsicStrictConstructResult {
  readonly state: IrregularBeamState
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly gapFillEvidence: ReadonlyArray<IntrinsicStrictGapFillEvidence>
  readonly runtimeMs: number
}

export interface IntrinsicStrictGapFillEvidence {
  readonly pieceId: PieceId
  readonly regionKey: string
  readonly regionAreaBeforeMm2: number
  readonly regionAreaAfterMm2: number
  readonly envelopeMaximumSideDeltaMm: number
  readonly envelopeAreaDeltaMm2: number
  readonly sharedBoundaryLengthMm: number
  readonly nonInert: boolean
}

/** Observer-only F0 trace records. They are emitted before scoring changes no behavior. */
export interface IntrinsicStrictFeatureContactObserver {
  readonly onCandidateProvenance: (observation: {
    readonly step: number
    readonly parentStateId: string
    readonly pieceId: PieceId
    readonly transform: IrregularTransformCandidate
    readonly provenance: NfpIfpCandidateProvenance
    readonly gapCoverage: {
      readonly enclosedRegionCount: number
      readonly hullOpenRegionCount: number
      readonly directLegalInEnclosedCavity: number
      readonly directLegalInHullOpenGap: number
      readonly canonicalLegalInEnclosedCavity: number
      readonly canonicalLegalInHullOpenGap: number
    }
  }) => void
  readonly onStepSelection: (observation: {
    readonly step: number
    readonly parentStateId: string
    readonly pieceId: PieceId
    readonly selectedTransform: IrregularTransformCandidate | undefined
    readonly selectedGridPoint: { readonly gridX: number; readonly gridY: number } | undefined
    readonly selectedGap:
      | {
          readonly kind: CanonicalIntrinsicGapRegion['kind']
          readonly canonicalKey: string
          readonly areaMm2: number
        }
      | undefined
  }) => void
}

export interface ConstructIntrinsicStrictStateInput {
  readonly allPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly frozenPlaced: ReadonlyArray<IrregularPlacedPiece>
  readonly candidateMode: IntrinsicStrictCandidateMode
  readonly maximumRuntimeMs?: number
  readonly featureContactObserver?: IntrinsicStrictFeatureContactObserver
  readonly control?: IrregularNfpIfpControl
}

interface ScoredCandidate {
  readonly state: IrregularBeamState
  readonly score: IntrinsicStrictLocalScore
  readonly transformFamily: string
  readonly candidate: IrregularPlacementCandidate
  readonly movingCollisionAreaMm2: number
  readonly containingGap: CanonicalIntrinsicGapRegion | undefined
}

export function measureIntrinsicStrictCanonicalEnvelope(
  placed: ReadonlyArray<IrregularPlacedPiece>
):
  | Pick<IntrinsicStrictLocalScore, 'maximumSideMm' | 'envelopeAreaMm2' | 'envelopeSpanMm'>
  | undefined {
  const envelope = measureCanonicalLayoutEnvelope(placed)
  return envelope === undefined
    ? undefined
    : {
        maximumSideMm: envelope.maximumSideMm,
        envelopeAreaMm2: envelope.areaMm2,
        envelopeSpanMm: envelope.spanMm
      }
}

/** One strict, sheet-independent constructive decode followed by real-sheet legality. */
export function decodeIntrinsicStrictPriorityOrder(
  finalSheet: SheetSpec,
  pieces: ReadonlyArray<IrregularPreparedPiece>,
  options: {
    readonly maximumRuntimeMs?: number
    readonly comparatorMode?: IntrinsicStrictComparatorMode
  } = {}
): Effect.Effect<
  IntrinsicStrictDecodeResult,
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const maximumRuntimeMs = options.maximumRuntimeMs ?? 120_000
    const comparatorMode = options.comparatorMode ?? 'pure-growth'
    const constructed = yield* constructIntrinsicStrictState({
      allPreparedPieces: pieces,
      remainingPreparedPieces: pieces,
      frozenPlaced: [],
      candidateMode: comparatorMode,
      maximumRuntimeMs
    })
    return yield* finalizeIntrinsicStrictState(
      finalSheet,
      constructed,
      Math.max(0, performance.now() - startedAt)
    )
  })
}

/** Applies only terminal q0/q90 real-sheet legality to one sheetless constructed state. */
export function finalizeIntrinsicStrictState(
  finalSheet: SheetSpec,
  constructed: IntrinsicStrictConstructResult,
  runtimeMs = constructed.runtimeMs
): Effect.Effect<IntrinsicStrictDecodeResult, IntrinsicStrictDecoderError> {
  const state = constructed.state
  const stepTrace = constructed.stepTrace
  if (state.unplacedPieceIds.length > 0) {
    return Effect.succeed(makeResult({ status: 'incomplete', state, stepTrace, runtimeMs }))
  }
  const terminal = selectTerminalOrientation(state, finalSheet)
  if (terminal === undefined) {
    return Effect.succeed(
      makeResult({ status: 'infeasible-final-sheet', state, stepTrace, runtimeMs })
    )
  }
  const measured = measureIntrinsicSheetlessCompletedLayout(terminal.state, runtimeMs)
  if (measured === undefined) {
    return Effect.fail(
      new IntrinsicStrictDecoderError({
        operation: 'completedMetrics',
        message: 'completed canonical layout metrics must remain finite and exact.'
      })
    )
  }
  return Effect.succeed({
    ...makeResult({ status: 'completed', state: terminal.state, stepTrace, runtimeMs }),
    terminalRotationDeg: terminal.rotationDeg,
    canonicalGeometryHash: terminal.canonicalHash,
    metrics: measured.metrics,
    certificate: evaluateIntrinsicStrictCertificate(measured.metrics)
  })
}

/** Builds one exact sheetless E1 state from an optional real frozen seed. */
export function constructIntrinsicStrictState(
  input: ConstructIntrinsicStrictStateInput
): Effect.Effect<
  IntrinsicStrictConstructResult,
  | IntrinsicStrictDecoderError
  | IrregularNestingNotImplementedError
  | IrregularGeometryInputError
  | IrregularNfpIfpControlAbortError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const maximumRuntimeMs = input.maximumRuntimeMs ?? 120_000
    const partition = validateSeedPartition(input)
    if (partition !== undefined) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({ operation: 'seedPartition', message: partition })
      )
    }
    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const control: IrregularNfpIfpControl = {
      checkpoint: (phase) =>
        Effect.gen(function* () {
          if (input.control !== undefined) yield* input.control.checkpoint(phase)
          if (performance.now() - startedAt >= maximumRuntimeMs) {
            return yield* Effect.fail(
              new IrregularNfpIfpControlAbortError({
                reason: 'deadline',
                message: `intrinsic strict decode exceeded ${maximumRuntimeMs} ms.`
              })
            )
          }
        })
    }
    let state = new IrregularBeamState({
      remainingPreparedPieces: input.remainingPreparedPieces,
      placedCollisionGeometries: input.frozenPlaced,
      placementOrder: input.frozenPlaced.map(placedPieceId)
    }).withBottomLeftAnchored()
    if (
      state === undefined ||
      (state.placedCollisionGeometries.length > 0 &&
        !assertCanonicalGridLegalLayout(
          intrinsicBoundsSheet(state),
          state.placedCollisionGeometries
        ))
    ) {
      return yield* Effect.fail(
        new IntrinsicStrictDecoderError({
          operation: 'frozenPlaced',
          message: 'frozen seed placements must form one exact canonical sheetless layout.'
        })
      )
    }
    const stepTrace: IntrinsicStrictStepTrace[] = []
    const gapFillEvidence: IntrinsicStrictGapFillEvidence[] = []

    for (let pieceIndex = 0; pieceIndex < input.remainingPreparedPieces.length; pieceIndex += 1) {
      const piece = input.remainingPreparedPieces[pieceIndex]
      if (piece === undefined) continue
      const pieceId = piece.pieceId ?? piece.source.id
      const parentStateId = state.canonicalOccupiedGeometryKey
      const remainingPreparedPieces = input.remainingPreparedPieces.slice(pieceIndex + 1)
      const candidatesByFamily = new Map<string, ScoredCandidate>()
      const containedCandidatesByFamily = new Map<
        string,
        ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion }
      >()
      const gapRegions =
        typeof input.candidateMode === 'object' || input.featureContactObserver !== undefined
          ? deriveCanonicalIntrinsicGapRegions(state.placedCollisionGeometries)
          : undefined
      let candidateCount = 0

      for (const transform of [...piece.transforms].sort(transformCandidateOrder)) {
        yield* control.checkpoint('candidate-points')
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const movingCollisionAreaMm2 = canonicalCollisionAreaMm2(moving)
        if (movingCollisionAreaMm2 === undefined) continue
        let candidateProvenance: NfpIfpCandidateProvenance | undefined
        const legalCandidates =
          state.placedCollisionGeometries.length === 0
            ? originAnchorCandidates(moving)
            : yield* nfpIfpService.generatePlacementCandidates({
                sheet: INTRINSIC_COORDINATE_DOMAIN,
                placed: state.placedCollisionGeometries,
                placedCollisionIndex: state.placedCollisionIndex,
                moving,
                settings,
                candidateDomain: 'sheetless-nfp',
                candidateMemoScope,
                ...(input.featureContactObserver === undefined
                  ? {}
                  : {
                      onCandidateProvenance: (provenance: NfpIfpCandidateProvenance) => {
                        candidateProvenance = provenance
                      }
                    }),
                control
              })
        candidateCount += legalCandidates.length
        const family = transformFamilyKey(transform)
        const scoredCandidates: ScoredCandidate[] = []
        for (const candidate of legalCandidates) {
          const scored = scoreCandidate({
            state,
            piece,
            moving,
            candidate,
            remainingPreparedPieces,
            transformFamily: family,
            movingCollisionAreaMm2,
            gapRegions
          })
          if (scored === undefined) continue
          scoredCandidates.push(scored)
          const incumbent = candidatesByFamily.get(family)
          if (incumbent === undefined || compareLocalScores(scored.score, incumbent.score) < 0) {
            candidatesByFamily.set(family, scored)
          }
          if (scored.containingGap !== undefined) {
            const containedScored = { ...scored, containingGap: scored.containingGap }
            const containedIncumbent = containedCandidatesByFamily.get(family)
            if (
              containedIncumbent === undefined ||
              compareGapContainedCandidates(containedScored, containedIncumbent) < 0
            ) {
              containedCandidatesByFamily.set(family, containedScored)
            }
          }
        }
        if (candidateProvenance !== undefined) {
          const canonicalLegality = scoredCandidates.map((candidate) => ({
            candidate,
            legal: isCanonicalSheetlessStateLegal(candidate.state)
          }))
          input.featureContactObserver?.onCandidateProvenance({
            step: pieceIndex,
            parentStateId,
            pieceId,
            transform,
            provenance: {
              ...candidateProvenance,
              canonicalChecked: scoredCandidates.length,
              canonicalLegal: canonicalLegality.filter(({ legal }) => legal).length
            },
            gapCoverage: {
              enclosedRegionCount:
                gapRegions?.filter(({ kind }) => kind === 'enclosed-cavity').length ?? 0,
              hullOpenRegionCount:
                gapRegions?.filter(({ kind }) => kind === 'hull-open-gap').length ?? 0,
              directLegalInEnclosedCavity: scoredCandidates.filter(
                ({ containingGap }) => containingGap?.kind === 'enclosed-cavity'
              ).length,
              directLegalInHullOpenGap: scoredCandidates.filter(
                ({ containingGap }) => containingGap?.kind === 'hull-open-gap'
              ).length,
              canonicalLegalInEnclosedCavity: canonicalLegality.filter(
                ({ candidate, legal }) =>
                  legal && candidate.containingGap?.kind === 'enclosed-cavity'
              ).length,
              canonicalLegalInHullOpenGap: canonicalLegality.filter(
                ({ candidate, legal }) => legal && candidate.containingGap?.kind === 'hull-open-gap'
              ).length
            }
          })
        }
      }

      const familyWinners = [...candidatesByFamily.values()]
      const selected =
        typeof input.candidateMode === 'object'
          ? selectGapContainedWinner([...containedCandidatesByFamily.values(), ...familyWinners])
          : selectIntrinsicStrictFamilyWinner(familyWinners, input.candidateMode)
      stepTrace.push({
        pieceId,
        candidateCount,
        transformFamilyCount: candidatesByFamily.size,
        selectedTransformFamily: selected?.transformFamily,
        selectedScore: selected?.score
      })
      const selectedGridX =
        selected === undefined ? undefined : toGridMm(selected.candidate.point.x)
      const selectedGridY =
        selected === undefined ? undefined : toGridMm(selected.candidate.point.y)
      input.featureContactObserver?.onStepSelection({
        step: pieceIndex,
        parentStateId,
        pieceId,
        selectedTransform: selected?.candidate.transform,
        selectedGridPoint:
          selectedGridX === undefined || selectedGridY === undefined
            ? undefined
            : { gridX: selectedGridX, gridY: selectedGridY },
        selectedGap:
          selected?.containingGap === undefined
            ? undefined
            : {
                kind: selected.containingGap.kind,
                canonicalKey: selected.containingGap.canonicalKey,
                areaMm2: selected.containingGap.areaMm2
              }
      })
      if (selected?.containingGap !== undefined) {
        const beforeBounds = state.translatedCollisionBounds
        const afterBounds = selected.state.translatedCollisionBounds
        const recomputedGapRegions = deriveCanonicalIntrinsicGapRegions(
          selected.state.placedCollisionGeometries
        )
        const totalGapAreaBeforeMm2 =
          gapRegions?.reduce((sum, region) => sum + region.areaMm2, 0) ?? Number.NaN
        const totalGapAreaAfterMm2 =
          recomputedGapRegions?.reduce((sum, region) => sum + region.areaMm2, 0) ?? Number.NaN
        const regionAreaAfterMm2 = Math.max(
          0,
          selected.containingGap.areaMm2 - (totalGapAreaBeforeMm2 - totalGapAreaAfterMm2)
        )
        const envelopeMaximumSideDeltaMm =
          beforeBounds === undefined || afterBounds === undefined
            ? Number.POSITIVE_INFINITY
            : Math.max(afterBounds.width, afterBounds.height) -
              Math.max(beforeBounds.width, beforeBounds.height)
        const envelopeAreaDeltaMm2 =
          beforeBounds === undefined || afterBounds === undefined
            ? Number.POSITIVE_INFINITY
            : afterBounds.width * afterBounds.height - beforeBounds.width * beforeBounds.height
        const beforeSharedBoundaryLengthMm = state.sharedCollisionBoundaryLengthMm ?? 0
        const afterSharedBoundaryLengthMm = selected.state.sharedCollisionBoundaryLengthMm ?? 0
        const insertedSharedBoundaryLengthMm =
          afterSharedBoundaryLengthMm >= beforeSharedBoundaryLengthMm
            ? afterSharedBoundaryLengthMm - beforeSharedBoundaryLengthMm
            : Number.NaN
        gapFillEvidence.push({
          pieceId,
          regionKey: selected.containingGap.canonicalKey,
          regionAreaBeforeMm2: selected.containingGap.areaMm2,
          regionAreaAfterMm2,
          envelopeMaximumSideDeltaMm,
          envelopeAreaDeltaMm2,
          sharedBoundaryLengthMm: insertedSharedBoundaryLengthMm,
          nonInert:
            insertedSharedBoundaryLengthMm > 0 &&
            envelopeMaximumSideDeltaMm === 0 &&
            envelopeAreaDeltaMm2 === 0 &&
            regionAreaAfterMm2 < selected.containingGap.areaMm2
        })
      }
      state =
        selected?.state ??
        state.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: pieceId
        })
    }

    return {
      state,
      stepTrace,
      gapFillEvidence,
      runtimeMs: Math.max(0, performance.now() - startedAt)
    }
  })
}

function validateSeedPartition(input: ConstructIntrinsicStrictStateInput): string | undefined {
  const allIds = input.allPreparedPieces.map(preparedPieceId)
  const remainingIds = input.remainingPreparedPieces.map(preparedPieceId)
  const frozenIds = input.frozenPlaced.map(placedPieceId)
  if (new Set(allIds).size !== allIds.length) return 'all prepared piece ids must be unique.'
  if (new Set(remainingIds).size !== remainingIds.length)
    return 'remaining piece ids must be unique.'
  if (new Set(frozenIds).size !== frozenIds.length) return 'frozen placement ids must be unique.'
  const partitionIds = [...remainingIds, ...frozenIds]
  if (new Set(partitionIds).size !== partitionIds.length) {
    return 'frozen and remaining piece ids must be disjoint.'
  }
  if (
    partitionIds.length !== allIds.length ||
    partitionIds.toSorted().some((id, index) => id !== allIds.toSorted()[index])
  ) {
    return 'frozen and remaining piece ids must exactly partition all prepared pieces.'
  }
  return undefined
}

function preparedPieceId(piece: IrregularPreparedPiece): PieceId {
  return piece.pieceId ?? piece.source.id
}

function placedPieceId(piece: IrregularPlacedPiece): PieceId {
  return piece.placement.pieceId ?? piece.placement.sourcePieceId
}

function scoreCandidate(input: {
  readonly state: IrregularBeamState
  readonly piece: IrregularPreparedPiece
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
  readonly remainingPreparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly transformFamily: string
  readonly movingCollisionAreaMm2: number
  readonly gapRegions: ReadonlyArray<CanonicalIntrinsicGapRegion> | undefined
}): ScoredCandidate | undefined {
  const placement = makePlacement(input.piece, input.candidate)
  const placed = new IrregularPlacedPiece({
    placement,
    collisionGeometry: input.moving
  })
  const anchored = input.state
    .withPlacement({
      remainingPreparedPieces: input.remainingPreparedPieces,
      placedCollisionGeometry: placed,
      placementOrderPieceId: input.piece.pieceId ?? input.piece.source.id
    })
    .withBottomLeftAnchored()
  if (anchored === undefined) return undefined
  const envelope = measureIntrinsicStrictCanonicalEnvelope(anchored.placedCollisionGeometries)
  if (envelope === undefined) return undefined
  const { maximumSideMm, envelopeAreaMm2, envelopeSpanMm } = envelope
  const sharedBoundaryLengthMm = anchored.sharedCollisionBoundaryLengthMm
  if (
    sharedBoundaryLengthMm === undefined ||
    ![maximumSideMm, envelopeAreaMm2, envelopeSpanMm, sharedBoundaryLengthMm].every(Number.isFinite)
  ) {
    return undefined
  }
  return {
    state: anchored,
    transformFamily: input.transformFamily,
    candidate: input.candidate,
    movingCollisionAreaMm2: input.movingCollisionAreaMm2,
    containingGap: input.gapRegions
      ?.filter((region) =>
        candidateContainedInIntrinsicGap(input.moving, input.candidate.point, region)
      )
      .toSorted(
        (first, second) =>
          first.areaMm2 - second.areaMm2 || first.canonicalKey.localeCompare(second.canonicalKey)
      )[0],
    score: {
      maximumSideMm,
      envelopeAreaMm2,
      envelopeSpanMm,
      sharedBoundaryLengthMm,
      canonicalCombinedGeometryKey: anchored.canonicalOccupiedGeometryKey
    }
  }
}

function selectGapContainedWinner(
  candidates: ReadonlyArray<ScoredCandidate>
): ScoredCandidate | undefined {
  const contained = candidates
    .filter(
      (candidate): candidate is ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion } =>
        candidate.containingGap !== undefined
    )
    .toSorted(compareGapContainedCandidates)[0]
  return contained ?? selectIntrinsicStrictFamilyWinner(candidates, 'pure-growth')
}

function compareGapContainedCandidates(
  first: ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion },
  second: ScoredCandidate & { containingGap: CanonicalIntrinsicGapRegion }
): number {
  return (
    first.containingGap.areaMm2 - second.containingGap.areaMm2 ||
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    compareLocalScores(first.score, second.score)
  )
}

/** Selects among pure-growth transform-family winners under the requested E1 mode. */
export function selectIntrinsicStrictFamilyWinner<T extends IntrinsicStrictFamilyWinner>(
  candidates: ReadonlyArray<T>,
  comparatorMode: IntrinsicStrictComparatorMode
): T | undefined {
  if (comparatorMode === 'legacy-absolute-envelope') {
    return candidates.toSorted(compareLegacyAbsoluteEnvelopeCandidates)[0]
  }
  const pureLeader = candidates.reduce<T | undefined>(
    (best, candidate) =>
      best === undefined || compareLocalScores(candidate.score, best.score) < 0 ? candidate : best,
    undefined
  )
  if (pureLeader === undefined || comparatorMode === 'pure-growth') return pureLeader

  return candidates
    .filter(
      (candidate) =>
        canonicalLinearMetric(candidate.score.maximumSideMm) ===
          canonicalLinearMetric(pureLeader.score.maximumSideMm) &&
        canonicalAreaMetric(candidate.score.envelopeAreaMm2) <=
          canonicalAreaMetric(
            pureLeader.score.envelopeAreaMm2 + 0.02 * candidate.movingCollisionAreaMm2
          )
    )
    .toSorted(compareContactBandCandidates)[0]
}

/** Historical absolute-envelope role retained as an exact, sheet-free seed. */
function compareLegacyAbsoluteEnvelopeCandidates(
  first: IntrinsicStrictFamilyWinner,
  second: IntrinsicStrictFamilyWinner
): number {
  return (
    canonicalAreaMetric(first.score.envelopeAreaMm2) -
      canonicalAreaMetric(second.score.envelopeAreaMm2) ||
    canonicalLinearMetric(first.score.maximumSideMm) -
      canonicalLinearMetric(second.score.maximumSideMm) ||
    canonicalLinearMetric(first.score.envelopeSpanMm) -
      canonicalLinearMetric(second.score.envelopeSpanMm) ||
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    first.score.canonicalCombinedGeometryKey.localeCompare(
      second.score.canonicalCombinedGeometryKey
    )
  )
}

function compareContactBandCandidates(
  first: IntrinsicStrictFamilyWinner,
  second: IntrinsicStrictFamilyWinner
): number {
  return (
    second.score.sharedBoundaryLengthMm - first.score.sharedBoundaryLengthMm ||
    canonicalAreaMetric(first.score.envelopeAreaMm2) -
      canonicalAreaMetric(second.score.envelopeAreaMm2) ||
    canonicalLinearMetric(first.score.envelopeSpanMm) -
      canonicalLinearMetric(second.score.envelopeSpanMm) ||
    first.score.canonicalCombinedGeometryKey.localeCompare(
      second.score.canonicalCombinedGeometryKey
    )
  )
}

function compareLocalScores(
  first: IntrinsicStrictLocalScore,
  second: IntrinsicStrictLocalScore
): number {
  return (
    canonicalLinearMetric(first.maximumSideMm) - canonicalLinearMetric(second.maximumSideMm) ||
    canonicalAreaMetric(first.envelopeAreaMm2) - canonicalAreaMetric(second.envelopeAreaMm2) ||
    canonicalLinearMetric(first.envelopeSpanMm) - canonicalLinearMetric(second.envelopeSpanMm) ||
    second.sharedBoundaryLengthMm - first.sharedBoundaryLengthMm ||
    first.canonicalCombinedGeometryKey.localeCompare(second.canonicalCombinedGeometryKey)
  )
}

function canonicalLinearMetric(valueMm: number): number {
  return Math.round(valueMm * 1_000)
}

function canonicalAreaMetric(valueMm2: number): number {
  return Math.round(valueMm2 * 1_000_000)
}

function canonicalCollisionAreaMm2(moving: TransformedCollisionGeometry): number | undefined {
  let doubledAreaGrid2 = 0
  for (let index = 0; index < moving.polygon.points.length; index += 1) {
    const first = moving.polygon.points[index]
    const second = moving.polygon.points[(index + 1) % moving.polygon.points.length]
    if (first === undefined || second === undefined) return undefined
    const firstX = toGridMm(first.x)
    const firstY = toGridMm(first.y)
    const secondX = toGridMm(second.x)
    const secondY = toGridMm(second.y)
    if (
      firstX === undefined ||
      firstY === undefined ||
      secondX === undefined ||
      secondY === undefined
    ) {
      return undefined
    }
    doubledAreaGrid2 += firstX * secondY - secondX * firstY
  }
  const areaMm2 = Math.abs(doubledAreaGrid2) / 2_000_000
  return Number.isFinite(areaMm2) && areaMm2 > 0 ? areaMm2 : undefined
}

function originAnchorCandidates(
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPlacementCandidate> {
  const gridX = toGridMm(-moving.bounds.minX)
  const gridY = toGridMm(-moving.bounds.minY)
  if (gridX === undefined || gridY === undefined) return []
  return [
    new IrregularPlacementCandidate({
      pieceId: moving.sourcePieceId,
      transform: moving.transform,
      point: { x: fromGrid(gridX), y: fromGrid(gridY) },
      diagnostics: []
    })
  ]
}

function transformFamilyKey(transform: IrregularTransformCandidate): string {
  const remainder = transform.rotationDeg % 360
  const rotationDeg = remainder < 0 ? remainder + 360 : remainder
  return `${Object.is(rotationDeg, -0) ? 0 : rotationDeg}:${Number(transform.mirrored)}`
}

function makePlacement(
  piece: IrregularPreparedPiece,
  candidate: IrregularPlacementCandidate
): IrregularPlacement {
  const input = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: candidate.point.x,
      translateY: candidate.point.y,
      rotationDeg: candidate.transform.rotationDeg,
      mirrored: candidate.transform.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(input)
    : new IrregularPlacement({ ...input, pieceId: piece.pieceId })
}

function selectTerminalOrientation(
  state: IrregularBeamState,
  sheet: SheetSpec
):
  | {
      readonly state: IrregularBeamState
      readonly rotationDeg: 0 | 90
      readonly canonicalHash: string
    }
  | undefined {
  const legal: Array<{
    readonly state: IrregularBeamState
    readonly rotationDeg: 0 | 90
    readonly canonicalHash: string
  }> = []
  for (const rotationDeg of [0, 90] as const) {
    const oriented = state.withQuarterTurnBottomLeft(rotationDeg)
    if (
      oriented === undefined ||
      !assertCanonicalGridLegalLayout(sheet, oriented.placedCollisionGeometries)
    ) {
      continue
    }
    const canonicalIdentity = canonicalCollisionLayoutIdentity(oriented.placedCollisionGeometries)
    if (canonicalIdentity !== undefined) {
      legal.push({
        state: oriented,
        rotationDeg,
        canonicalHash: createHash('sha256').update(canonicalIdentity).digest('hex')
      })
    }
  }
  return legal.toSorted(
    (first, second) =>
      first.canonicalHash.localeCompare(second.canonicalHash) ||
      first.rotationDeg - second.rotationDeg
  )[0]
}

/** Measures one complete exact layout without consulting a requested sheet. */
export function measureIntrinsicSheetlessCompletedLayout(
  state: IrregularBeamState,
  runtimeMs = 0
): IntrinsicSheetlessCompletedLayout | undefined {
  const anchored = state.withBottomLeftAnchored()
  if (
    anchored === undefined ||
    anchored.unplacedPieceIds.length > 0 ||
    !assertCanonicalGridLegalLayout(
      intrinsicBoundsSheet(anchored),
      anchored.placedCollisionGeometries
    )
  ) {
    return undefined
  }
  const canonicalGeometryIdentity = canonicalCollisionLayoutIdentity(
    anchored.placedCollisionGeometries
  )
  if (canonicalGeometryIdentity === undefined) return undefined
  const canonicalGeometryHash = createHash('sha256').update(canonicalGeometryIdentity).digest('hex')
  const metrics = completedMetrics(anchored, canonicalGeometryHash, runtimeMs)
  return metrics === undefined
    ? undefined
    : {
        placedCollisionGeometries: anchored.placedCollisionGeometries,
        canonicalGeometryIdentity,
        canonicalGeometryHash,
        metrics
      }
}

function completedMetrics(
  state: IrregularBeamState,
  canonicalGeometryHash: string,
  runtimeMs: number
): IntrinsicStrictCompletedMetrics | undefined {
  const topology = measureCanonicalLayoutTopology(state.placedCollisionGeometries)
  const cavities = measureCanonicalEnclosedCavities(state.placedCollisionGeometries)
  const structure = analyzeCanonicalLayoutStructure(
    intrinsicBoundsSheet(state),
    state.placedCollisionGeometries
  )
  const contacts = measureCanonicalLayoutContacts(state.placedCollisionGeometries)
  const envelope = measureCanonicalLayoutEnvelope(state.placedCollisionGeometries)
  if (
    topology === undefined ||
    cavities === undefined ||
    structure === undefined ||
    contacts === undefined ||
    envelope === undefined
  ) {
    return undefined
  }
  const largestComponent = new Set(structure.positiveContactComponents[0] ?? [])
  const occupiedAreaOutsideLargestContactComponentMm2 =
    structure.pieces.reduce(
      (sum, piece) => sum + (largestComponent.has(piece.pieceId) ? 0 : piece.areaGrid2),
      0
    ) / 1_000_000
  const metrics = {
    envelopeMaximumSideMm: envelope.maximumSideMm,
    envelopeAreaMm2: envelope.areaMm2,
    envelopeSpanMm: envelope.spanMm,
    enclosedCavityCount: cavities.count,
    totalEnclosedCavityAreaMm2: cavities.totalAreaMm2,
    largestOccupiedHullGapRatio: topology.largestOccupiedHullGapRatio,
    isolatedPieceCount: topology.isolatedPieceCount,
    positiveContactComponentCount: topology.positiveContactComponentCount,
    largestPositiveContactComponentSize: topology.largestPositiveContactComponentSize,
    largestPositiveContactComponentRatio: topology.largestPositiveContactComponentRatio,
    occupiedAreaOutsideLargestContactComponentMm2,
    occupiedHullWasteRatio: envelope.occupiedHullWasteRatio,
    totalStructuralContacts: contacts.totalStructuralContacts,
    dominantStructuralContacts: contacts.dominantStructuralContacts,
    contactUnits: contacts.contactUnits,
    sharedBoundaryLengthMm: contacts.sharedBoundaryLengthMm,
    canonicalGeometryHash,
    runtimeMs
  }
  return Object.values(metrics).every((value) =>
    typeof value === 'string' ? value.length > 0 : Number.isFinite(value)
  )
    ? metrics
    : undefined
}

function intrinsicBoundsSheet(state: IrregularBeamState): SheetSpec {
  const bounds = state.translatedCollisionBounds
  return new SheetSpec({
    width: Math.max(1, Math.ceil(bounds?.maxX ?? 0)),
    height: Math.max(1, Math.ceil(bounds?.maxY ?? 0)),
    label: 'intrinsic-completed-layout-bounds'
  })
}

function isCanonicalSheetlessStateLegal(state: IrregularBeamState): boolean {
  const anchored = state.withBottomLeftAnchored()
  return (
    anchored !== undefined &&
    assertCanonicalGridLegalLayout(
      intrinsicBoundsSheet(anchored),
      anchored.placedCollisionGeometries
    )
  )
}

export function evaluateIntrinsicStrictCertificate(
  metrics: IntrinsicStrictCompletedMetrics
): IntrinsicStrictCertificate {
  const floors = INTRINSIC_STRICT_COHESION_FLOORS
  const violations: Array<keyof typeof floors> = []
  let relativeDeficitSum = 0
  if (metrics.enclosedCavityCount > floors.maximumEnclosedCavityCount) {
    violations.push('maximumEnclosedCavityCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.enclosedCavityCount - floors.maximumEnclosedCavityCount) /
        Math.max(1, floors.maximumEnclosedCavityCount)
    )
  }
  if (metrics.isolatedPieceCount > floors.maximumIsolatedPieceCount) {
    violations.push('maximumIsolatedPieceCount')
    relativeDeficitSum += Math.min(
      1,
      (metrics.isolatedPieceCount - floors.maximumIsolatedPieceCount) /
        Math.max(1, floors.maximumIsolatedPieceCount)
    )
  }
  if (
    metrics.largestPositiveContactComponentRatio <
    floors.minimumLargestPositiveContactComponentRatio
  ) {
    violations.push('minimumLargestPositiveContactComponentRatio')
    relativeDeficitSum += Math.min(
      1,
      (floors.minimumLargestPositiveContactComponentRatio -
        metrics.largestPositiveContactComponentRatio) /
        floors.minimumLargestPositiveContactComponentRatio
    )
  }
  if (metrics.largestOccupiedHullGapRatio > floors.maximumLargestOccupiedHullGapRatio) {
    violations.push('maximumLargestOccupiedHullGapRatio')
    relativeDeficitSum += Math.min(
      1,
      (metrics.largestOccupiedHullGapRatio - floors.maximumLargestOccupiedHullGapRatio) /
        floors.maximumLargestOccupiedHullGapRatio
    )
  }
  return {
    passes: violations.length === 0,
    violatedFloors: violations,
    relativeDeficitSum
  }
}

/** Preregistered completed-layout archive order, including negative topology ordering. */
export function rankIntrinsicStrictCompletedLayouts(
  layouts: ReadonlyArray<IntrinsicStrictCompletedMetrics>
): ReadonlyArray<IntrinsicStrictCompletedMetrics> {
  const assessed = layouts.map((metrics) => ({
    metrics,
    certificate: evaluateIntrinsicStrictCertificate(metrics)
  }))
  const minimumPassingArea = Math.min(
    ...assessed
      .filter(({ certificate }) => certificate.passes)
      .map(({ metrics }) => metrics.envelopeAreaMm2)
  )
  return assessed
    .toSorted((first, second) => {
      if (first.certificate.passes !== second.certificate.passes) {
        return first.certificate.passes ? -1 : 1
      }
      if (first.certificate.passes) {
        const firstWithinOnePercent = first.metrics.envelopeAreaMm2 <= minimumPassingArea * 1.01
        const secondWithinOnePercent = second.metrics.envelopeAreaMm2 <= minimumPassingArea * 1.01
        if (firstWithinOnePercent !== secondWithinOnePercent) return firstWithinOnePercent ? -1 : 1
        if (firstWithinOnePercent) {
          return (
            first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
            first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
            first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
          )
        }
        return (
          first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
          first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
          first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
        )
      }
      return (
        first.certificate.violatedFloors.length - second.certificate.violatedFloors.length ||
        first.certificate.relativeDeficitSum - second.certificate.relativeDeficitSum ||
        first.metrics.envelopeMaximumSideMm - second.metrics.envelopeMaximumSideMm ||
        first.metrics.envelopeAreaMm2 - second.metrics.envelopeAreaMm2 ||
        first.metrics.envelopeSpanMm - second.metrics.envelopeSpanMm ||
        first.metrics.canonicalGeometryHash.localeCompare(second.metrics.canonicalGeometryHash)
      )
    })
    .map(({ metrics }) => metrics)
}

function makeResult(input: {
  readonly status: IntrinsicStrictDecodeResult['status']
  readonly state: IrregularBeamState
  readonly stepTrace: ReadonlyArray<IntrinsicStrictStepTrace>
  readonly runtimeMs: number
}): IntrinsicStrictDecodeResult {
  return {
    status: input.status,
    placements: input.state.placedCollisionGeometries.map(({ placement }) => placement),
    placedCollisionGeometries: input.state.placedCollisionGeometries,
    unplacedPieceIds: input.state.unplacedPieceIds,
    terminalRotationDeg: undefined,
    canonicalGeometryHash: undefined,
    metrics: undefined,
    certificate: undefined,
    stepTrace: input.stepTrace,
    runtimeMs: input.runtimeMs
  }
}
