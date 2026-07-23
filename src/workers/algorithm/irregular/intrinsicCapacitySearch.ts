import { Effect } from 'effect'
import { performance } from 'node:perf_hooks'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularPlacementCandidate,
  type IrregularPreparedPiece,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel, GeometrySettings } from '../../irregular/geometryKernel.js'
import {
  IrregularNfpIfpCandidateMemoScope,
  NfpIfpService,
  type IrregularGeometryInputError,
  type IrregularNestingNotImplementedError,
  type IrregularNfpIfpControl,
  type IrregularNfpIfpControlAbortError
} from '../../irregular/services.js'
import {
  compareIntrinsicCapacityEndpoints,
  intrinsicCapacitySpanFitsSheet,
  intrinsicCapacityStateGridSpan,
  materializeIntrinsicCapacityEndpoint,
  measureIntrinsicCapacityCavities,
  type IntrinsicCapacityCavityCache,
  type IntrinsicCapacityCavityMetrics,
  type IntrinsicCapacityEndpoint,
  type IntrinsicCapacityGridSpan
} from './intrinsicCapacityEndpoint.js'
import {
  intrinsicCapacityPreparedPieceId
} from './intrinsicCapacityMaterial.js'
import { IntrinsicCapacityError } from './intrinsicCapacityPreflight.js'
import {
  INTRINSIC_COORDINATE_DOMAIN,
  originAnchorCandidates,
  transformCandidateOrder
} from './intrinsicStrictDecoder.js'
import { IrregularBeamState } from './irregularBeamState.js'

/** Fixed first-version bounds of the empty-start intrinsic capacity search. */
export const INTRINSIC_CAPACITY_V1_BOUNDS = {
  coldBeamWidth: 16,
  localLegalPlacementFanout: 3,
  minimumPlacementEvaluationCap: 50_000,
  placementEvaluationQuotaPerDepth: 4_096
} as const

export type IntrinsicCapacitySettlement = 'exhausted' | 'evaluation-cap'

export interface IntrinsicCapacitySearchTrace {
  readonly beamWidth: number
  readonly localLegalPlacementFanout: number
  readonly placementEvaluationCap: number
  readonly placementEvaluationQuotaPerDepth: number
  readonly consumedPlacementEvaluations: number
  /** Prefix terminalization must never consume placement evaluations. */
  readonly auxiliaryPlacementEvaluations: number
  readonly prunedByAttainableCount: number
  readonly prunedByAttainableMaterial: number
  readonly deduplicatedSuccessors: number
  readonly fitRejectedCandidates: number
  readonly invalidCandidates: number
  readonly endpointFitRejections: number
  readonly completedDepths: number
  readonly depthQuotaExhaustions: number
  readonly pieceCount: number
  readonly settlement: IntrinsicCapacitySettlement
}

/** Benchmark-only phase buckets; capture must default off in production. */
export interface IntrinsicCapacitySearchPhaseTimings {
  readonly candidateGenerationMs: number
  readonly candidateEvaluationMs: number
  readonly successorConstructionMs: number
  readonly cavityMeasurementMs: number
  readonly retentionMs: number
  readonly endpointMaterializationMs: number
  readonly totalMs: number
}

export interface IntrinsicCapacitySearchResult {
  /** Deduplicated cold endpoints ranked by the capacity objective. */
  readonly endpoints: ReadonlyArray<IntrinsicCapacityEndpoint>
  readonly trace: IntrinsicCapacitySearchTrace
  readonly phaseTimings: IntrinsicCapacitySearchPhaseTimings | undefined
}

export interface RunIntrinsicCapacityColdSearchInput {
  readonly sheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
  readonly cavityCache: IntrinsicCapacityCavityCache
  /** Optional prefix incumbent used only for the strict attainable bounds. */
  readonly incumbent?: IntrinsicCapacityEndpoint
  readonly control?: IrregularNfpIfpControl
  readonly capturePhaseTimings?: boolean
}

interface CapacityBeamEntry {
  readonly state: IrregularBeamState
  readonly placedDoubledMaterialAreaGrid2: bigint
  readonly anchoredOccupiedKey: string
  readonly gridSpan: IntrinsicCapacityGridSpan
  readonly cavities: IntrinsicCapacityCavityMetrics
}

interface ScoredCandidateReference {
  readonly moving: TransformedCollisionGeometry
  readonly candidate: IrregularPlacementCandidate
  readonly maximumSideGrid: number
  readonly envelopeAreaGrid2: number
  readonly envelopeSpanGrid: number
  readonly transformOrdinal: number
  readonly gridX: number
  readonly gridY: number
}

type CapacitySearchError =
  | IntrinsicCapacityError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError
  | IrregularNfpIfpControlAbortError

/**
 * Empty-start intrinsic capacity search `intrinsic-capacity-v1`.
 *
 * A depth-synchronized cold beam processes the immutable prepared order. At
 * every piece depth each retained state emits up to three ordinary legal
 * placement successors and one mandatory skip successor. Successors are
 * checked for exact partial q0/q90 fit and deduplicated by canonical
 * occupied-union identity before retention; states from different piece depths
 * never compete. The prefix incumbent may prune only through the strict
 * attainable-count and attainable-material bounds. A reached evaluation cap
 * settles the best retained endpoints deterministically.
 */
export function runIntrinsicCapacityColdSearch(
  input: RunIntrinsicCapacityColdSearchInput
): Effect.Effect<
  IntrinsicCapacitySearchResult,
  CapacitySearchError,
  GeometryKernel | GeometrySettings | NfpIfpService
> {
  return Effect.gen(function* () {
    const startedAt = performance.now()
    const capture = input.capturePhaseTimings === true
    const settings = yield* GeometrySettings
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    const {
      coldBeamWidth,
      localLegalPlacementFanout,
      minimumPlacementEvaluationCap,
      placementEvaluationQuotaPerDepth
    } = INTRINSIC_CAPACITY_V1_BOUNDS
    const placementEvaluationCap = Math.max(
      minimumPlacementEvaluationCap,
      input.preparedPieces.length * placementEvaluationQuotaPerDepth
    )

    const sheetWidthGrid = toGridMm(input.sheet.width)
    const sheetHeightGrid = toGridMm(input.sheet.height)
    if (sheetWidthGrid === undefined || sheetHeightGrid === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchSheet',
          message: 'requested sheet has no exact canonical-grid representation.'
        })
      )
    }
    const preparedIds = input.preparedPieces.map(intrinsicCapacityPreparedPieceId)
    const suffixMaterial = suffixMaterialSums(preparedIds, input.materialAreasByPieceId)
    if (suffixMaterial === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchMaterial',
          message: 'capacity material accounting is incomplete for the prepared pieces.'
        })
      )
    }

    const candidateMemoScope = new IrregularNfpIfpCandidateMemoScope()
    const timings = {
      candidateGenerationMs: 0,
      candidateEvaluationMs: 0,
      successorConstructionMs: 0,
      cavityMeasurementMs: 0,
      retentionMs: 0,
      endpointMaterializationMs: 0
    }
    let consumedPlacementEvaluations = 0
    let prunedByAttainableCount = 0
    let prunedByAttainableMaterial = 0
    let deduplicatedSuccessors = 0
    let fitRejectedCandidates = 0
    let invalidCandidates = 0
    let endpointFitRejections = 0
    let completedDepths = 0
    let depthQuotaExhaustions = 0
    let settlement: IntrinsicCapacitySettlement = 'exhausted'

    const emptyState = IrregularBeamState.empty(input.preparedPieces)
    const emptySpan = intrinsicCapacityStateGridSpan(emptyState)
    if (emptySpan === undefined) {
      return yield* Effect.fail(
        new IntrinsicCapacityError({
          operation: 'coldSearchEmptyState',
          message: 'the empty capacity state must have finite occupied bounds.'
        })
      )
    }
    let beam: ReadonlyArray<CapacityBeamEntry> = [
      {
        state: emptyState,
        placedDoubledMaterialAreaGrid2: 0n,
        anchoredOccupiedKey: emptyState.canonicalOccupiedGeometryKey,
        gridSpan: emptySpan,
        cavities: { count: 0, totalAreaMm2: 0 }
      }
    ]

    for (let depth = 0; depth < input.preparedPieces.length; depth += 1) {
      const piece = input.preparedPieces[depth]
      if (piece === undefined) continue
      const pieceId = preparedIds[depth]
      if (pieceId === undefined) continue
      const pieceMaterial = input.materialAreasByPieceId.get(pieceId)
      if (pieceMaterial === undefined) {
        return yield* Effect.fail(
          new IntrinsicCapacityError({
            operation: 'coldSearchMaterial',
            message: `piece ${pieceId} has no exact material accounting.`
          })
        )
      }
      const remainingPreparedPieces = input.preparedPieces.slice(depth + 1)
      const successors: CapacityBeamEntry[] = []
      const successorKeys = new Set<string>()

      // reserve the skip path for every retained state before spending this depth's placement quota
      for (const entry of beam) {
        const skipState = entry.state.withUnplacedPiece({
          remainingPreparedPieces,
          unplacedPieceId: pieceId
        })
        pushSuccessor(
          successors,
          successorKeys,
          {
            state: skipState,
            placedDoubledMaterialAreaGrid2: entry.placedDoubledMaterialAreaGrid2,
            anchoredOccupiedKey: entry.anchoredOccupiedKey,
            gridSpan: entry.gridSpan,
            cavities: entry.cavities
          },
          () => {
            deduplicatedSuccessors += 1
          }
        )
      }

      let consumedAtDepth = 0
      let depthQuotaExhausted = false
      for (const entry of beam) {
        if (depthQuotaExhausted) break
        const scored: ScoredCandidateReference[] = []
        const sortedTransforms = [...piece.transforms].sort((first, second) =>
          transformCandidateOrder(first, second)
        )
        for (
          let transformOrdinal = 0;
          transformOrdinal < sortedTransforms.length;
          transformOrdinal += 1
        ) {
          if (depthQuotaExhausted) break
          const transform = sortedTransforms[transformOrdinal]
          if (transform === undefined) continue
          const generationStartedAt = capture ? performance.now() : 0
          if (input.control !== undefined) yield* input.control.checkpoint('candidate-points')
          const moving = yield* geometryKernel.transformCollisionGeometry({
            geometry: piece.collisionGeometry,
            transform
          })
          const legalCandidates =
            entry.state.placedCollisionGeometries.length === 0
              ? originAnchorCandidates(moving)
              : yield* nfpIfpService.generatePlacementCandidates({
                  sheet: INTRINSIC_COORDINATE_DOMAIN,
                  placed: entry.state.placedCollisionGeometries,
                  placedCollisionIndex: entry.state.placedCollisionIndex,
                  moving,
                  settings,
                  candidateDomain: 'sheetless-nfp',
                  candidateMemoScope,
                  ...(input.control === undefined ? {} : { control: input.control })
                })
          if (capture) timings.candidateGenerationMs += performance.now() - generationStartedAt

          const evaluationStartedAt = capture ? performance.now() : 0
          for (const candidate of legalCandidates) {
            if (
              consumedAtDepth >= placementEvaluationQuotaPerDepth ||
              consumedPlacementEvaluations >= placementEvaluationCap
            ) {
              settlement = 'evaluation-cap'
              depthQuotaExhausted = true
              if (capture) {
                timings.candidateEvaluationMs += performance.now() - evaluationStartedAt
              }
              break
            }
            consumedAtDepth += 1
            consumedPlacementEvaluations += 1
            const evaluated = evaluateCandidate(entry, moving, candidate, transformOrdinal)
            if (evaluated === undefined) {
              invalidCandidates += 1
              continue
            }
            const fits = intrinsicCapacitySpanFitsSheet(
              { widthGrid: evaluated.widthGrid, heightGrid: evaluated.heightGrid },
              sheetWidthGrid,
              sheetHeightGrid
            )
            if (!fits.q0 && !fits.q90) {
              fitRejectedCandidates += 1
              continue
            }
            scored.push(evaluated)
          }
          if (capture) timings.candidateEvaluationMs += performance.now() - evaluationStartedAt
        }

        const constructionStartedAt = capture ? performance.now() : 0
        scored.sort(compareScoredCandidateReferences)
        let builtCount = 0
        for (const reference of scored) {
          if (builtCount >= localLegalPlacementFanout) break
          const placedState = entry.state.withPlacement({
            remainingPreparedPieces,
            placedCollisionGeometry: new IrregularPlacedPiece({
              placement: makeCapacityPlacement(piece, reference.candidate),
              collisionGeometry: reference.moving
            }),
            placementOrderPieceId: pieceId
          })
          const gridSpan = intrinsicCapacityStateGridSpan(placedState)
          if (gridSpan === undefined) {
            invalidCandidates += 1
            continue
          }
          const builtFits = intrinsicCapacitySpanFitsSheet(
            gridSpan,
            sheetWidthGrid,
            sheetHeightGrid
          )
          if (!builtFits.q0 && !builtFits.q90) {
            fitRejectedCandidates += 1
            continue
          }
          const anchoredOccupiedKey = placedState.bottomLeftAnchoredCanonicalOccupiedGeometryKey()
          if (anchoredOccupiedKey === undefined) {
            invalidCandidates += 1
            continue
          }
          const added = pushSuccessor(
            successors,
            successorKeys,
            {
              state: placedState,
              placedDoubledMaterialAreaGrid2:
                entry.placedDoubledMaterialAreaGrid2 + pieceMaterial,
              anchoredOccupiedKey,
              gridSpan,
              cavities: { count: 0, totalAreaMm2: 0 }
            },
            () => {
              deduplicatedSuccessors += 1
            }
          )
          if (added) builtCount += 1
        }
        if (capture) timings.successorConstructionMs += performance.now() - constructionStartedAt
      }
      if (depthQuotaExhausted) depthQuotaExhaustions += 1

      const retentionStartedAt = capture ? performance.now() : 0
      const remainingCountAfterDepth = input.preparedPieces.length - (depth + 1)
      const remainingMaterialAfterDepth = suffixMaterial[depth + 1] ?? 0n
      const incumbent = input.incumbent
      const surviving: CapacityBeamEntry[] = []
      for (const successor of successors) {
        if (incumbent !== undefined) {
          const attainableCount = successor.state.placementOrder.length + remainingCountAfterDepth
          if (attainableCount < incumbent.metrics.placedCount) {
            prunedByAttainableCount += 1
            continue
          }
          if (attainableCount === incumbent.metrics.placedCount) {
            const attainableMaterial =
              successor.placedDoubledMaterialAreaGrid2 + remainingMaterialAfterDepth
            if (attainableMaterial < incumbent.metrics.placedDoubledMaterialAreaGrid2) {
              prunedByAttainableMaterial += 1
              continue
            }
          }
        }
        surviving.push(successor)
      }

      const cavityStartedAt = capture ? performance.now() : 0
      const measuredSurvivors: CapacityBeamEntry[] = []
      for (const successor of surviving) {
        if (successor.state.placementOrder.length === 0) {
          measuredSurvivors.push(successor)
          continue
        }
        const cavities = measureIntrinsicCapacityCavities(successor.state, input.cavityCache)
        if (cavities === undefined) {
          invalidCandidates += 1
          continue
        }
        measuredSurvivors.push({ ...successor, cavities })
      }
      if (capture) timings.cavityMeasurementMs += performance.now() - cavityStartedAt

      measuredSurvivors.sort(compareCapacityBeamEntries)
      beam = measuredSurvivors.slice(0, coldBeamWidth)
      completedDepths = depth + 1
      if (capture) timings.retentionMs += performance.now() - retentionStartedAt
      if (beam.length === 0) break
    }

    const materializationStartedAt = capture ? performance.now() : 0
    const endpointsByHash = new Map<string, IntrinsicCapacityEndpoint>()
    for (const entry of beam) {
      const placedIdSet = new Set(entry.state.placementOrder)
      const unplacedPreparedIds = preparedIds.filter((id) => !placedIdSet.has(id))
      const endpoint = materializeIntrinsicCapacityEndpoint({
        sheet: input.sheet,
        state: entry.state,
        unplacedPreparedIds,
        origin: 'cold-search',
        materialAreasByPieceId: input.materialAreasByPieceId,
        cavityCache: input.cavityCache
      })
      if (endpoint === undefined) {
        endpointFitRejections += 1
        continue
      }
      const existing = endpointsByHash.get(endpoint.canonicalGeometryHash)
      if (existing === undefined || compareIntrinsicCapacityEndpoints(endpoint, existing) < 0) {
        endpointsByHash.set(endpoint.canonicalGeometryHash, endpoint)
      }
    }
    const endpoints = [...endpointsByHash.values()].toSorted(compareIntrinsicCapacityEndpoints)
    if (capture) {
      timings.endpointMaterializationMs += performance.now() - materializationStartedAt
    }

    const totalMs = Math.max(0, performance.now() - startedAt)
    return {
      endpoints,
      trace: {
        beamWidth: coldBeamWidth,
        localLegalPlacementFanout,
        placementEvaluationCap,
        placementEvaluationQuotaPerDepth,
        consumedPlacementEvaluations,
        auxiliaryPlacementEvaluations: 0,
        prunedByAttainableCount,
        prunedByAttainableMaterial,
        deduplicatedSuccessors,
        fitRejectedCandidates,
        invalidCandidates,
        endpointFitRejections,
        completedDepths,
        depthQuotaExhaustions,
        pieceCount: input.preparedPieces.length,
        settlement
      },
      phaseTimings: capture ? { ...timings, totalMs } : undefined
    }
  })
}

function pushSuccessor(
  successors: CapacityBeamEntry[],
  successorKeys: Set<string>,
  successor: CapacityBeamEntry,
  onDuplicate: () => void
): boolean {
  const successorKey = intrinsicCapacitySuccessorIdentity(successor)
  if (successorKeys.has(successorKey)) {
    onDuplicate()
    return false
  }
  successorKeys.add(successorKey)
  successors.push(successor)
  return true
}

/** Future-equivalent identity at one synchronized prepared-piece depth. */
function intrinsicCapacitySuccessorIdentity(successor: CapacityBeamEntry): string {
  return `${successor.anchoredOccupiedKey}|placed=${JSON.stringify(
    [...successor.state.placementOrder].toSorted(compareStrings)
  )}`
}

interface EvaluatedCandidateReference extends ScoredCandidateReference {
  readonly widthGrid: number
  readonly heightGrid: number
}

/**
 * Cheap exact candidate evaluation from incrementally derived occupied bounds.
 * No placement object, beam state, spatial index, contact measurement, or
 * anchored rebuild is constructed for candidates that are not selected.
 */
function evaluateCandidate(
  entry: CapacityBeamEntry,
  moving: TransformedCollisionGeometry,
  candidate: IrregularPlacementCandidate,
  transformOrdinal: number
): EvaluatedCandidateReference | undefined {
  const parentBounds = entry.state.translatedCollisionBounds
  if (parentBounds === undefined) return undefined
  const movingMinX = moving.bounds.minX + candidate.point.x
  const movingMinY = moving.bounds.minY + candidate.point.y
  const movingMaxX = moving.bounds.maxX + candidate.point.x
  const movingMaxY = moving.bounds.maxY + candidate.point.y
  const isFirstPlacement = entry.state.placedCollisionGeometries.length === 0
  const minX = isFirstPlacement ? movingMinX : Math.min(parentBounds.minX, movingMinX)
  const minY = isFirstPlacement ? movingMinY : Math.min(parentBounds.minY, movingMinY)
  const maxX = isFirstPlacement ? movingMaxX : Math.max(parentBounds.maxX, movingMaxX)
  const maxY = isFirstPlacement ? movingMaxY : Math.max(parentBounds.maxY, movingMaxY)
  const minXGrid = toGridMm(minX)
  const minYGrid = toGridMm(minY)
  const maxXGrid = toGridMm(maxX)
  const maxYGrid = toGridMm(maxY)
  const gridX = toGridMm(candidate.point.x)
  const gridY = toGridMm(candidate.point.y)
  if (
    minXGrid === undefined ||
    minYGrid === undefined ||
    maxXGrid === undefined ||
    maxYGrid === undefined ||
    gridX === undefined ||
    gridY === undefined
  ) {
    return undefined
  }
  const widthGrid = maxXGrid - minXGrid
  const heightGrid = maxYGrid - minYGrid
  return {
    moving,
    candidate,
    maximumSideGrid: Math.max(widthGrid, heightGrid),
    envelopeAreaGrid2: widthGrid * heightGrid,
    envelopeSpanGrid: widthGrid + heightGrid,
    transformOrdinal,
    gridX,
    gridY,
    widthGrid,
    heightGrid
  }
}

function compareScoredCandidateReferences(
  first: ScoredCandidateReference,
  second: ScoredCandidateReference
): number {
  return (
    first.maximumSideGrid - second.maximumSideGrid ||
    first.envelopeAreaGrid2 - second.envelopeAreaGrid2 ||
    first.envelopeSpanGrid - second.envelopeSpanGrid ||
    first.transformOrdinal - second.transformOrdinal ||
    first.gridX - second.gridX ||
    first.gridY - second.gridY
  )
}

/**
 * Within one depth the capacity retention order mirrors the endpoint
 * objective: count, exact material, exact cavities, then intrinsic envelope
 * compactness and deterministic occupied identity. Depths never compete.
 */
function compareCapacityBeamEntries(first: CapacityBeamEntry, second: CapacityBeamEntry): number {
  const firstCount = first.state.placementOrder.length
  const secondCount = second.state.placementOrder.length
  if (firstCount !== secondCount) return secondCount - firstCount
  if (first.placedDoubledMaterialAreaGrid2 !== second.placedDoubledMaterialAreaGrid2) {
    return first.placedDoubledMaterialAreaGrid2 > second.placedDoubledMaterialAreaGrid2 ? -1 : 1
  }
  return (
    first.cavities.count - second.cavities.count ||
    Math.round(first.cavities.totalAreaMm2 * 1_000_000) -
      Math.round(second.cavities.totalAreaMm2 * 1_000_000) ||
    Math.max(first.gridSpan.widthGrid, first.gridSpan.heightGrid) -
      Math.max(second.gridSpan.widthGrid, second.gridSpan.heightGrid) ||
    first.gridSpan.widthGrid * first.gridSpan.heightGrid -
      second.gridSpan.widthGrid * second.gridSpan.heightGrid ||
    first.gridSpan.widthGrid +
      first.gridSpan.heightGrid -
      (second.gridSpan.widthGrid + second.gridSpan.heightGrid) ||
    compareStrings(first.anchoredOccupiedKey, second.anchoredOccupiedKey)
  )
}

function compareStrings(first: string, second: string): number {
  if (first < second) return -1
  if (first > second) return 1
  return 0
}

function makeCapacityPlacement(
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

function suffixMaterialSums(
  preparedIds: ReadonlyArray<PieceId>,
  materialAreasByPieceId: ReadonlyMap<PieceId, bigint>
): ReadonlyArray<bigint> | undefined {
  const sums = new Array<bigint>(preparedIds.length + 1)
  sums[preparedIds.length] = 0n
  for (let index = preparedIds.length - 1; index >= 0; index -= 1) {
    const pieceId = preparedIds[index]
    const area = pieceId === undefined ? undefined : materialAreasByPieceId.get(pieceId)
    const nextSum = sums[index + 1]
    if (area === undefined || nextSum === undefined) return undefined
    sums[index] = nextSum + area
  }
  return sums
}
