import { Context, Data, Effect, Layer, Order } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacementCandidate,
  IrregularTransformCandidate,
  TransformedCollisionGeometry
} from '@shared/irregular/domain.js'

/** The only local irregular placement policy currently implemented. */
export const BALANCED_COMPACTNESS_POLICY_ID = 'balanced-compactness' as const

/** A typed failure raised only when a candidate cannot produce a finite score. */
export class IrregularPlacementScoringError extends Data.TaggedError(
  'IrregularPlacementScoringError'
)<{
  readonly operation: string
  readonly message: string
}> {}

/**
 * One candidate that geometry has already accepted as legal.
 *
 * The scorer uses the translated collision polygons only to compare the shape
 * of the resulting used cluster. It must not repeat NFP/IFP generation or
 * direct placement validation.
 */
export interface ScoreIrregularPlacementCandidateInput {
  /** Rectangular sheet used to normalize the post-placement cluster span. */
  readonly sheet: SheetSpec
  /** Collision polygons already committed to this partial layout. */
  readonly placed: ReadonlyArray<IrregularPlacedPiece>
  /** Local moving collision polygon for the candidate's selected transform. */
  readonly moving: TransformedCollisionGeometry
  /** Already-legal translation whose resulting cluster is being compared. */
  readonly candidate: IrregularPlacementCandidate
}

/** One comparable score for an already-legal irregular placement candidate. */
export interface IrregularPlacementScore {
  /** Explicit policy identity so later policies cannot be accidentally mixed. */
  readonly policyId: typeof BALANCED_COMPACTNESS_POLICY_ID
  /** Largest post-placement sheet-axis consumption, normalized by that axis. */
  readonly worstNormalizedSheetConsumption: number
  /** Sum of both post-placement normalized sheet-axis consumptions. */
  readonly normalizedSheetSpanSum: number
  /** Area in square millimeters of the post-placement collision-polygon bounds. */
  readonly usedClusterAreaMm2: number
  /** Width plus height in millimeters of the post-placement collision bounds. */
  readonly usedClusterSpanMm: number
  /** Sheet-space bottom edge of the translated moving collision polygon. */
  readonly candidateBottomMm: number
  /** Sheet-space left edge of the translated moving collision polygon. */
  readonly candidateLeftMm: number
  /** Candidate retained for deterministic metadata and piece-id tie-breaking. */
  readonly candidate: IrregularPlacementCandidate
}

export namespace IrregularPlacementScorer {
  export interface Service {
    readonly policyId: typeof BALANCED_COMPACTNESS_POLICY_ID
    readonly scoreCandidate: (
      input: ScoreIrregularPlacementCandidateInput
    ) => Effect.Effect<IrregularPlacementScore, IrregularPlacementScoringError>
    readonly compare: (
      first: IrregularPlacementScore,
      second: IrregularPlacementScore
    ) => -1 | 0 | 1
  }
}

/**
 * The complete ascending lexicographic order for the only local policy.
 *
 * Earlier entries are the compactness criteria; the remaining entries make
 * otherwise identical legal candidates deterministic without changing their
 * geometric score.
 */
const balancedCompactnessOrder = Order.combineAll<IrregularPlacementScore>([
  Order.mapInput(Order.Number, (score) => score.worstNormalizedSheetConsumption),
  Order.mapInput(Order.Number, (score) => score.normalizedSheetSpanSum),
  Order.mapInput(Order.Number, (score) => score.usedClusterAreaMm2),
  Order.mapInput(Order.Number, (score) => score.usedClusterSpanMm),
  Order.mapInput(Order.Number, (score) => score.candidateBottomMm),
  Order.mapInput(Order.Number, (score) => score.candidateLeftMm),
  Order.mapInput(Order.Number, (score) => score.candidate.transform.index),
  Order.mapInput(Order.Number, (score) => score.candidate.transform.rotationDeg),
  Order.mapInput(Order.Boolean, (score) => score.candidate.transform.mirrored),
  Order.mapInput(Order.String, (score) => score.candidate.transform.reason),
  Order.mapInput(Order.String, (score) => score.candidate.pieceId)
])

/**
 * Ranks already-legal irregular candidates without participating in legality.
 *
 * `Make` is deliberately dependency-free: the candidate generator owns
 * legality, while this service only compares its completed outputs.
 */
export class IrregularPlacementScorer extends Context.Service<
  IrregularPlacementScorer,
  IrregularPlacementScorer.Service
>()('min-plane-dfx/algorithm/irregular/IrregularPlacementScorer') {
  static readonly Make = IrregularPlacementScorer.of({
    policyId: BALANCED_COMPACTNESS_POLICY_ID,
    scoreCandidate,
    compare: compareScores
  })

  static readonly Live = Layer.succeed(IrregularPlacementScorer, IrregularPlacementScorer.Make)
}

function scoreCandidate(
  input: ScoreIrregularPlacementCandidateInput
): Effect.Effect<IrregularPlacementScore, IrregularPlacementScoringError> {
  const metadataError = validateCandidateMetadata(input.moving, input.candidate)
  if (metadataError !== undefined) return failScoring(metadataError)

  const combinedBounds = makeCombinedBounds(input)
  if (combinedBounds === undefined) {
    return failScoring('candidate and placed collision polygons must produce finite bounds.')
  }

  const clusterWidth = combinedBounds.maxX - combinedBounds.minX
  const clusterHeight = combinedBounds.maxY - combinedBounds.minY
  const normalizedWidth = clusterWidth / input.sheet.width
  const normalizedHeight = clusterHeight / input.sheet.height
  const candidateBottom = combinedBounds.moving.minY
  const candidateLeft = combinedBounds.moving.minX
  const worstNormalizedSheetConsumption = Math.max(normalizedWidth, normalizedHeight)
  const normalizedSheetSpanSum = normalizedWidth + normalizedHeight
  const usedClusterAreaMm2 = clusterWidth * clusterHeight
  const usedClusterSpanMm = clusterWidth + clusterHeight

  if (
    !Number.isFinite(worstNormalizedSheetConsumption) ||
    !Number.isFinite(normalizedSheetSpanSum) ||
    !Number.isFinite(usedClusterAreaMm2) ||
    !Number.isFinite(usedClusterSpanMm) ||
    !Number.isFinite(candidateBottom) ||
    !Number.isFinite(candidateLeft)
  ) {
    return failScoring('candidate score arithmetic must remain finite.')
  }

  return Effect.succeed({
    policyId: BALANCED_COMPACTNESS_POLICY_ID,
    worstNormalizedSheetConsumption,
    normalizedSheetSpanSum,
    usedClusterAreaMm2,
    usedClusterSpanMm,
    candidateBottomMm: candidateBottom,
    candidateLeftMm: candidateLeft,
    candidate: input.candidate
  })
}

function compareScores(first: IrregularPlacementScore, second: IrregularPlacementScore): -1 | 0 | 1 {
  return balancedCompactnessOrder(first, second)
}

interface CombinedBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
  readonly moving: Bounds
}

interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

function makeCombinedBounds(input: ScoreIrregularPlacementCandidateInput): CombinedBounds | undefined {
  // derive every bound from polygon vertices so stale cached bounds cannot affect ranking
  const moving = translatedBounds(
    input.moving.polygon.points,
    input.candidate.point.x,
    input.candidate.point.y
  )
  if (moving === undefined) return undefined

  let minX = moving.minX
  let minY = moving.minY
  let maxX = moving.maxX
  let maxY = moving.maxY

  for (const placed of input.placed) {
    const translation = placed.placement.transform
    const placedBounds = translatedBounds(
      placed.collisionGeometry.polygon.points,
      translation.translateX,
      translation.translateY
    )
    if (placedBounds === undefined) return undefined
    minX = Math.min(minX, placedBounds.minX)
    minY = Math.min(minY, placedBounds.minY)
    maxX = Math.max(maxX, placedBounds.maxX)
    maxY = Math.max(maxY, placedBounds.maxY)
  }

  const values = [minX, minY, maxX, maxY]
  if (!values.every(Number.isFinite)) return undefined
  return { minX, minY, maxX, maxY, moving }
}

function translatedBounds(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  translateX: number,
  translateY: number
): Bounds | undefined {
  const firstPoint = points[0]
  if (firstPoint === undefined) return undefined

  const firstX = firstPoint.x + translateX
  const firstY = firstPoint.y + translateY
  if (!Number.isFinite(firstX) || !Number.isFinite(firstY)) return undefined

  let minX = firstX
  let minY = firstY
  let maxX = firstX
  let maxY = firstY

  for (const point of points.slice(1)) {
    const x = point.x + translateX
    const y = point.y + translateY
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  return { minX, minY, maxX, maxY }
}

function validateCandidateMetadata(
  moving: TransformedCollisionGeometry,
  candidate: IrregularPlacementCandidate
): string | undefined {
  if (moving.sourcePieceId !== candidate.pieceId) {
    return 'moving geometry source piece id must match the candidate piece id.'
  }

  if (!sameTransform(moving.transform, candidate.transform)) {
    return 'moving geometry transform metadata must match the candidate transform metadata.'
  }

  return undefined
}

function sameTransform(
  first: IrregularTransformCandidate,
  second: IrregularTransformCandidate
): boolean {
  return (
    first.index === second.index &&
    first.rotationDeg === second.rotationDeg &&
    first.mirrored === second.mirrored &&
    first.reason === second.reason
  )
}

function failScoring(message: string): Effect.Effect<never, IrregularPlacementScoringError> {
  return Effect.fail(
    new IrregularPlacementScoringError({
      operation: 'scoreCandidate',
      message
    })
  )
}
