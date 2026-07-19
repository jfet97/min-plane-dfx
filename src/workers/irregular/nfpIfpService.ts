import { Effect, Layer } from 'effect'
import {
  IrregularBounds,
  IrregularIfpBounds,
  IrregularNfp,
  IrregularPlacementCandidate,
  IrregularPlacedPiece,
  IrregularPoint,
  IrregularPolygon,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput
} from './services.js'
import type { InternalBounds, InternalPoint, InternalPolygon } from './internalGeometry.js'
import {
  IrregularGeometryInfeasibleError,
  GeometryCache,
  GeometryCacheInMemory,
  IrregularGeometryInputError,
  IrregularNfpIfpCandidateMemoScope,
  IrregularNfpIfpControl,
  IrregularNfpIfpControlAbortError,
  type IrregularNfpIfpCheckpointPhase,
  NfpIfpService
} from './services.js'
import { ConvexHull } from './convexHull.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'
import type { ConvexPolygonWinding } from './convexPolygonValidation.js'
import { areDisjoint, boundsForPoints } from './convexBounds.js'
import { GeometryPredicates } from './geometryPredicates.js'
import { PlacementValidation } from './placementValidation.js'
import {
  DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  innerFitBoundsCacheKey,
  isValidCachedIfp,
  isValidCachedNfpBoundary,
  legalPlacementCandidateMemoKey,
  pairwiseNfpCacheKey
} from './geometryCacheKeys.js'
import type {
  NfpCandidatePruningMode,
  NfpConstructionAlgorithm
} from './geometryCacheKeys.js'

export { DEFAULT_NFP_CONSTRUCTION_ALGORITHM }
export type { NfpCandidatePruningMode, NfpConstructionAlgorithm }

const ORIGIN: InternalPoint = { x: 0, y: 0 }

/** Provides deterministic convex IFP bounds and outer NFP boundaries. */
export function makeNfpIfpServiceLayer(
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  candidatePruningMode: NfpCandidatePruningMode = 'indexed'
) {
  return Layer.effect(
    NfpIfpService,
    Effect.gen(function* () {
      const geometryCache = yield* GeometryCache
      return NfpIfpService.of({
        computeNfp: (input) => computeNfpCached(input, geometryCache, constructionAlgorithm),
        computeIfpBounds: (input) => computeIfpBoundsCached(input, geometryCache),
        generatePlacementCandidates: makeGeneratePlacementCandidates(
          geometryCache,
          constructionAlgorithm,
          candidatePruningMode
        )
      })
    })
  )
}

export const NfpIfpServiceLayer = makeNfpIfpServiceLayer()

/** Standalone service layer with a private deterministic cache for direct callers. */
export function makeNfpIfpServiceLive(
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
  candidatePruningMode: NfpCandidatePruningMode = 'indexed'
) {
  return makeNfpIfpServiceLayer(constructionAlgorithm, candidatePruningMode).pipe(
    Layer.provideMerge(GeometryCacheInMemory)
  )
}

export const NfpIfpServiceLive = makeNfpIfpServiceLive()

/**
 * Computes the outer forbidden translation boundary for two strict convex polygons.
 *
 * For a fixed polygon `F` already translated into sheet space and a moving local
 * polygon `M`, the forbidden placement translations are `F ⊕ (-M)`. A
 * Minkowski sum is defined exactly as `A ⊕ B = { a + b | a ∈ A, b ∈ B }`.
 * Here `-M` means multiplying every moving local point by `-1`: translating
 * `M` by `t` meets `F` exactly when some `f + (-m)` equals `t`, so collision
 * translations become this sum. The explicit linear construction merges edge
 * directions in O(n + m), but its safe translated-ring canonicalization can
 * require an exact hull fallback. The pairwise vertex-sum hull construction is
 * the live default and differential correctness oracle.
 *
 * The returned NFP uses placement-coordinate space: its interior means
 * positive-area overlap is forbidden, while its boundary means touching is
 * allowed.
 */
function computeNfpCached(
  input: ComputeNfpInput,
  geometryCache: GeometryCache,
  constructionAlgorithm: NfpConstructionAlgorithm
): Effect.Effect<IrregularNfp, IrregularGeometryInputError> {
  return computeNfpBoundaryCached(input, geometryCache, constructionAlgorithm).pipe(
    Effect.map((boundary) =>
      new IrregularNfp({
        fixedPieceId: input.fixed.placement.sourcePieceId,
        movingPieceId: input.moving.sourcePieceId,
        boundary: toDomainPolygon(boundary)
      })
    )
  )
}

function computeNfpBoundaryCached(
  input: ComputeNfpInput,
  geometryCache: GeometryCache,
  constructionAlgorithm: NfpConstructionAlgorithm
): Effect.Effect<InternalPolygon, IrregularGeometryInputError> {
  const fixedValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.fixed.collisionGeometry.polygon.points
  )
  if ('message' in fixedValidation)
    return failInvalidGeometry('computeNfp', fixedValidation.message)
  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.moving.polygon.points
  )
  if ('message' in movingValidation)
    return failInvalidGeometry('computeNfp', movingValidation.message)

  const key = pairwiseNfpCacheKey(input, constructionAlgorithm)
  return geometryCache.get<InternalPolygon>(key).pipe(
    Effect.flatMap((cached) => {
      if (isValidCachedNfpBoundary(cached)) return translateNfpBoundaryInternal(input, cached)

      const removeInvalid = cached === undefined ? Effect.void : geometryCache.remove(key)
      return removeInvalid.pipe(
        Effect.flatMap(() => computeNfpBoundaryUncached(input, constructionAlgorithm)),
        Effect.tap((computed) => geometryCache.set(key, computed)),
        Effect.flatMap((boundary) => translateNfpBoundaryInternal(input, boundary))
      )
    })
  )
}

function computeNfpBoundaryUncached(
  input: ComputeNfpInput,
  constructionAlgorithm: NfpConstructionAlgorithm
): Effect.Effect<InternalPolygon, IrregularGeometryInputError> {
  const construct =
    constructionAlgorithm === 'linear-edge-merge'
      ? computeRelativeNfpBoundaryLinearInternal
      : computeRelativeNfpBoundaryReferenceInternal
  const boundary = construct(
    input.fixed.collisionGeometry.polygon.points,
    input.moving.polygon.points
  )
  if ('message' in boundary) return failInvalidGeometry('computeNfp', boundary.message)
  return Effect.succeed(boundary)
}

export type NfpBoundaryConstructionResult = IrregularPolygon | { readonly message: string }
type InternalNfpBoundaryConstructionResult =
  | InternalPolygon
  | { readonly message: string }

/** Removes exact cyclic repeats and redundant collinear vertices in linear time. */
export function canonicalizeTranslatedConvexRing(
  points: ReadonlyArray<InternalPoint>
): NfpBoundaryConstructionResult {
  return toPublicBoundary(canonicalizeTranslatedConvexRingInternal(points))
}

function canonicalizeTranslatedConvexRingInternal(
  points: ReadonlyArray<InternalPoint>
): InternalNfpBoundaryConstructionResult {
  if (points.length < 3) return { message: 'polygon must contain at least three vertices.' }

  const previousIndexes = points.map(
    (_, index) => (index - 1 + points.length) % points.length
  )
  const nextIndexes = points.map((_, index) => (index + 1) % points.length)
  const active = points.map(() => true)
  const pendingIndexes = points.map((_, index) => index)
  let activeCount = points.length

  for (let pendingIndex = 0; pendingIndex < pendingIndexes.length; pendingIndex += 1) {
    const currentIndex = pendingIndexes[pendingIndex]
    if (currentIndex === undefined || !active[currentIndex]) continue
    if (activeCount < 3) return { message: 'polygon must contain at least three vertices.' }

    const previousIndex = previousIndexes[currentIndex]
    const nextIndex = nextIndexes[currentIndex]
    if (previousIndex === undefined || nextIndex === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }
    const previousPoint = points[previousIndex]
    const currentPoint = points[currentIndex]
    const nextPoint = points[nextIndex]
    if (previousPoint === undefined || currentPoint === undefined || nextPoint === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    const repeated = pointsEqual(previousPoint, currentPoint) || pointsEqual(currentPoint, nextPoint)
    const collinear =
      GeometryPredicates.orientation(previousPoint, currentPoint, nextPoint) === 0 &&
      pointIsBetween(previousPoint, currentPoint, nextPoint)
    if (!repeated && !collinear) continue

    active[currentIndex] = false
    activeCount -= 1
    if (activeCount < 3) return { message: 'polygon must contain at least three vertices.' }
    nextIndexes[previousIndex] = nextIndex
    previousIndexes[nextIndex] = previousIndex
    pendingIndexes.push(previousIndex, nextIndex)
  }

  const firstActiveIndex = active.findIndex((isActive) => isActive)
  if (firstActiveIndex < 0 || activeCount < 3) {
    return { message: 'polygon must contain at least three vertices.' }
  }

  const canonicalPoints: InternalPoint[] = []
  let currentIndex = firstActiveIndex
  do {
    const currentPoint = points[currentIndex]
    if (currentPoint === undefined) return { message: 'polygon points must form a closed boundary.' }
    canonicalPoints.push(currentPoint)
    const nextIndex = nextIndexes[currentIndex]
    if (nextIndex === undefined) return { message: 'polygon points must form a closed boundary.' }
    currentIndex = nextIndex
  } while (currentIndex !== firstActiveIndex)

  if (canonicalPoints.length !== activeCount) {
    return { message: 'polygon points must form a closed boundary.' }
  }

  const validation = ConvexPolygonValidation.validateStrictBoundary(canonicalPoints)
  if ('message' in validation) return validation
  return { points: rotateToStableStart(canonicalPoints) }
}

/** Exposes focused NFP construction and boundary-intersection algorithms to tests. */
export const NfpBoundaryAlgorithms = {
  reference: computeRelativeNfpBoundaryReference,
  linear: computeRelativeNfpBoundaryLinear,
  segmentIntersection: (
    firstStart: InternalPoint,
    firstEnd: InternalPoint,
    secondStart: InternalPoint,
    secondEnd: InternalPoint
  ) =>
    intersectSegments(
      { start: firstStart, end: firstEnd, bounds: segmentBounds(firstStart, firstEnd) },
      { start: secondStart, end: secondEnd, bounds: segmentBounds(secondStart, secondEnd) }
    )
} as const

function computeRelativeNfpBoundaryReference(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): NfpBoundaryConstructionResult {
  return toPublicBoundary(computeRelativeNfpBoundaryReferenceInternal(fixedPoints, movingPoints))
}

function computeRelativeNfpBoundaryReferenceInternal(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): InternalNfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if ('message' in inputValidation) return inputValidation

  const negatedMovingPoints = movingPoints.map(
    (point) => ({ x: -point.x, y: -point.y })
  )
  const minkowskiPoints: InternalPoint[] = []
  for (const fixedPoint of fixedPoints) {
    for (const movingPoint of negatedMovingPoints) {
      const sum = sumPoints(fixedPoint, movingPoint, 'Minkowski sum')
      if ('message' in sum) return sum
      minkowskiPoints.push(sum)
    }
  }

  const boundary = ConvexHull.compute(minkowskiPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation) return boundaryValidation

  return { points: rotateToStableStart(boundary.points) }
}

function computeRelativeNfpBoundaryLinear(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): NfpBoundaryConstructionResult {
  return toPublicBoundary(computeRelativeNfpBoundaryLinearInternal(fixedPoints, movingPoints))
}

function computeRelativeNfpBoundaryLinearInternal(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): InternalNfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if ('message' in inputValidation) return inputValidation

  const fixedBoundary = counterClockwiseStablePoints(fixedPoints, inputValidation.fixedWinding)
  const negatedMovingPoints = movingPoints.map(
    (point) => ({ x: -point.x, y: -point.y })
  )
  const movingBoundary = counterClockwiseStablePoints(
    negatedMovingPoints,
    inputValidation.movingWinding
  )
  const fixedEdges = edgeVectors(fixedBoundary)
  if ('message' in fixedEdges) return fixedEdges
  const movingEdges = edgeVectors(movingBoundary)
  if ('message' in movingEdges) return movingEdges

  const initialFixedPoint = fixedBoundary[0]
  const initialMovingPoint = movingBoundary[0]
  if (initialFixedPoint === undefined || initialMovingPoint === undefined) {
    return { message: 'Minkowski edge merge lost a starting vertex.' }
  }
  const initialSum = sumPoints(initialFixedPoint, initialMovingPoint, 'Minkowski sum')
  if ('message' in initialSum) return initialSum

  let fixedEdgeIndex = 0
  let movingEdgeIndex = 0
  const boundaryPoints: InternalPoint[] = [initialSum]
  while (fixedEdgeIndex < fixedEdges.length || movingEdgeIndex < movingEdges.length) {
    if (fixedEdgeIndex < fixedEdges.length && movingEdgeIndex < movingEdges.length) {
      const fixedEdge = fixedEdges[fixedEdgeIndex]
      const movingEdge = movingEdges[movingEdgeIndex]
      if (fixedEdge === undefined || movingEdge === undefined) {
        return { message: 'Minkowski edge merge lost an edge direction.' }
      }
      const directionOrder = compareEdgeDirections(fixedEdge, movingEdge)
      if (directionOrder <= 0) fixedEdgeIndex += 1
      if (directionOrder >= 0) movingEdgeIndex += 1
    } else if (fixedEdgeIndex < fixedEdges.length) {
      fixedEdgeIndex += 1
    } else {
      movingEdgeIndex += 1
    }

    const nextFixedPoint = fixedBoundary[fixedEdgeIndex % fixedBoundary.length]
    const nextMovingPoint = movingBoundary[movingEdgeIndex % movingBoundary.length]
    if (nextFixedPoint === undefined || nextMovingPoint === undefined) {
      return { message: 'Minkowski edge merge lost a polygon vertex.' }
    }
    const nextSum = sumPoints(nextFixedPoint, nextMovingPoint, 'Minkowski sum')
    if ('message' in nextSum) return nextSum
    if (fixedEdgeIndex < fixedEdges.length || movingEdgeIndex < movingEdges.length) {
      boundaryPoints.push(nextSum)
    }
  }

  const canonicalBoundary = canonicalizeTranslatedConvexRingInternal(boundaryPoints)
  if (!('message' in canonicalBoundary)) {
    const canonicalValidation = ConvexPolygonValidation.validateStrictBoundary(
      canonicalBoundary.points
    )
    if (!('message' in canonicalValidation)) {
      const counterClockwisePoints =
        canonicalValidation.winding === 1
          ? canonicalBoundary.points
          : [...canonicalBoundary.points].reverse()
      return { points: rotateToStableStart(counterClockwisePoints) }
    }
  }

  const boundary = ConvexHull.compute(boundaryPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation) return boundaryValidation
  const counterClockwisePoints =
    boundaryValidation.winding === 1 ? boundary.points : [...boundary.points].reverse()
  return { points: rotateToStableStart(counterClockwisePoints) }
}

interface ValidatedRelativeNfpInputs {
  readonly fixedWinding: ConvexPolygonWinding
  readonly movingWinding: ConvexPolygonWinding
}

function validateRelativeNfpInputs(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): ValidatedRelativeNfpInputs | { readonly message: string } {
  const fixedFiniteMessage = finitePointsMessage(fixedPoints)
  if (fixedFiniteMessage !== undefined) return { message: fixedFiniteMessage }
  const movingFiniteMessage = finitePointsMessage(movingPoints)
  if (movingFiniteMessage !== undefined) return { message: movingFiniteMessage }

  const fixedValidation = ConvexPolygonValidation.validateStrictBoundary(fixedPoints)
  if ('message' in fixedValidation) return fixedValidation
  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(movingPoints)
  if ('message' in movingValidation) return movingValidation
  return { fixedWinding: fixedValidation.winding, movingWinding: movingValidation.winding }
}

function finitePointsMessage(points: ReadonlyArray<InternalPoint>): string | undefined {
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? undefined
    : 'polygon coordinates must be finite.'
}

function counterClockwiseStablePoints(
  points: ReadonlyArray<InternalPoint>,
  winding: ConvexPolygonWinding
): InternalPoint[] {
  const counterClockwisePoints = winding === 1 ? [...points] : [...points].reverse()
  return rotateToStableStart(counterClockwisePoints)
}

function edgeVectors(
  points: ReadonlyArray<InternalPoint>
): ReadonlyArray<InternalPoint> | { readonly message: string } {
  const vectors: InternalPoint[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) {
      return { message: 'Minkowski edge merge lost a polygon edge.' }
    }
    const x = end.x - start.x
    const y = end.y - start.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { message: 'Minkowski edge arithmetic must produce finite vectors.' }
    }
    vectors.push({ x, y })
  }
  return vectors
}

function compareEdgeDirections(firstEdge: InternalPoint, secondEdge: InternalPoint): -1 | 0 | 1 {
  const firstHalf = edgeDirectionHalf(firstEdge)
  const secondHalf = edgeDirectionHalf(secondEdge)
  if (firstHalf !== secondHalf) return firstHalf < secondHalf ? -1 : 1

  const directionTurn = GeometryPredicates.orientation(ORIGIN, firstEdge, secondEdge)
  if (directionTurn > 0) return -1
  if (directionTurn < 0) return 1
  return 0
}

function edgeDirectionHalf(edge: InternalPoint): 0 | 1 {
  return edge.y > 0 || (edge.y === 0 && edge.x >= 0) ? 0 : 1
}

function sumPoints(
  firstPoint: InternalPoint,
  secondPoint: InternalPoint,
  operation: string
): InternalPoint | { readonly message: string } {
  const x = firstPoint.x + secondPoint.x
  const y = firstPoint.y + secondPoint.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { message: `${operation} must produce finite coordinates.` }
  }
  return { x, y }
}

function pointsEqual(firstPoint: InternalPoint, secondPoint: InternalPoint): boolean {
  return firstPoint.x === secondPoint.x && firstPoint.y === secondPoint.y
}

function pointIsBetween(
  firstPoint: InternalPoint,
  point: InternalPoint,
  secondPoint: InternalPoint
): boolean {
  return (
    point.x >= Math.min(firstPoint.x, secondPoint.x) &&
    point.x <= Math.max(firstPoint.x, secondPoint.x) &&
    point.y >= Math.min(firstPoint.y, secondPoint.y) &&
    point.y <= Math.max(firstPoint.y, secondPoint.y)
  )
}

function translateNfpBoundaryInternal(
  input: ComputeNfpInput,
  relativeBoundary: InternalPolygon
): Effect.Effect<InternalPolygon, IrregularGeometryInputError> {
  const translatedPoints: InternalPoint[] = []
  for (const point of relativeBoundary.points) {
    const x = point.x + input.fixed.placement.transform.translateX
    const y = point.y + input.fixed.placement.transform.translateY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failInvalidGeometry('computeNfp', 'fixed translation must produce finite coordinates.')
    }
    translatedPoints.push({ x, y })
  }

  const translatedBoundary = canonicalizeTranslatedConvexRingInternal(translatedPoints)
  const canonicalBoundary =
    'message' in translatedBoundary
      ? canonicalizeTranslatedConvexRingWithHullFallback(translatedPoints)
      : translatedBoundary
  if ('message' in canonicalBoundary) return failInvalidGeometry('computeNfp', canonicalBoundary.message)

  return Effect.succeed(canonicalBoundary)
}

/** Uses the exact hull only when the linear translated-ring pass cannot prove strict convexity. */
function canonicalizeTranslatedConvexRingWithHullFallback(
  points: ReadonlyArray<InternalPoint>
): InternalNfpBoundaryConstructionResult {
  const boundary = ConvexHull.compute(points)
  const validation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in validation) return validation
  return { points: rotateToStableStart(boundary.points) }
}

function toPublicBoundary(
  result: InternalNfpBoundaryConstructionResult
): NfpBoundaryConstructionResult {
  if ('message' in result) return result
  return toDomainPolygon(result)
}

function toDomainPolygon(polygon: InternalPolygon): IrregularPolygon {
  return new IrregularPolygon({
    points: polygon.points.map((point) => new IrregularPoint({ x: point.x, y: point.y }))
  })
}

function toDomainBounds(bounds: InternalBounds): IrregularBounds {
  return new IrregularBounds(bounds)
}

/**
 * Computes sheet translation bounds from the actual polygon vertices.
 *
 * `TransformedCollisionGeometry.bounds` is derived cache data and is not
 * trusted at this legality boundary; a stale cache must not enlarge the IFP.
 */
function computeIfpBoundsCached(
  input: ComputeIfpBoundsInput,
  geometryCache: GeometryCache
): Effect.Effect<
  IrregularIfpBounds,
  IrregularGeometryInputError | IrregularGeometryInfeasibleError
> {
  return computeIfpBoundsValuesCached(input, geometryCache).pipe(
    Effect.map(({ bounds }) =>
      new IrregularIfpBounds({
        sheet: input.sheet,
        movingPieceId: input.moving.sourcePieceId,
        bounds: toDomainBounds(bounds)
      })
    )
  )
}

function computeIfpBoundsValuesCached(
  input: ComputeIfpBoundsInput,
  geometryCache: GeometryCache
): Effect.Effect<
  InternalIfpBounds,
  IrregularGeometryInputError | IrregularGeometryInfeasibleError
> {
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return failInvalidGeometry('computeIfpBounds', validation.message)

  const key = innerFitBoundsCacheKey(input)
  return geometryCache.get<InternalIfpBounds>(key).pipe(
    Effect.flatMap((cached) => {
      if (isValidCachedIfp(cached, input)) return Effect.succeed(cached)
      const removeInvalid = cached === undefined ? Effect.void : geometryCache.remove(key)
      return removeInvalid.pipe(
        Effect.flatMap(() => computeIfpBoundsValuesUncached(input)),
        Effect.tap((computed) => geometryCache.set(key, computed))
      )
    })
  )
}

function computeIfpBoundsValuesUncached(
  input: ComputeIfpBoundsInput
): Effect.Effect<InternalIfpBounds, IrregularGeometryInputError | IrregularGeometryInfeasibleError> {
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return failInvalidGeometry('computeIfpBounds', validation.message)

  const polygonBounds = boundsForPoints(input.moving.polygon.points)
  if (polygonBounds === undefined) {
    return failInvalidGeometry('computeIfpBounds', 'moving polygon bounds must be finite.')
  }

  const minX = normalizeNegativeZero(-polygonBounds.minX)
  const minY = normalizeNegativeZero(-polygonBounds.minY)
  const maxX = normalizeNegativeZero(input.sheet.width - polygonBounds.maxX)
  const maxY = normalizeNegativeZero(input.sheet.height - polygonBounds.maxY)
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    return failInvalidGeometry('computeIfpBounds', 'IFP arithmetic must produce finite bounds.')
  }
  if (minX > maxX || minY > maxY) {
    return Effect.fail(
      new IrregularGeometryInfeasibleError({
        operation: 'computeIfpBounds',
        message: 'moving polygon cannot fit inside the sheet.'
      })
    )
  }

  const bounds: InternalBounds = { minX, minY, maxX, maxY }

  return Effect.succeed({
    sheet: input.sheet,
    movingPieceId: input.moving.sourcePieceId,
    bounds
  })
}

/** Builds deterministic IFP/NFP contact candidates and filters illegal results. */
function generatePlacementCandidatesUncached(
  input: GeneratePlacementCandidatesInput,
  geometryCache: GeometryCache,
  constructionAlgorithm: NfpConstructionAlgorithm,
  candidatePruningMode: NfpCandidatePruningMode
): Effect.Effect<
  ReadonlyArray<IrregularPlacementCandidate>,
  IrregularGeometryInputError | IrregularNfpIfpControlAbortError
> {
  return Effect.gen(function* () {
    yield* nfpCheckpoint(input.control, 'ifp')
    const ifp = yield* computeIfpBoundsValuesCached(
      { sheet: input.sheet, moving: input.moving },
      geometryCache
    ).pipe(Effect.catchTag('IrregularGeometryInfeasibleError', () => Effect.succeed(undefined)))
    if (ifp === undefined) return []
    yield* nfpCheckpoint(input.control, 'ifp')
    const placedCollisionIndex =
      input.placedCollisionIndex !== undefined && input.placedCollisionIndex.matches(input.placed)
        ? input.placedCollisionIndex
        : undefined
    const nfpBoundaries: NfpBoundary[] = []

    for (const placed of input.placed) {
      yield* nfpCheckpoint(input.control, 'placed-nfp')
      const boundary = yield* computeNfpBoundaryCached(
        {
          fixed: placed,
          moving: input.moving,
          settings: input.settings.geometry
        },
        geometryCache,
        constructionAlgorithm
      )
      yield* nfpCheckpoint(input.control, 'placed-nfp')
      const validation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
      if ('message' in validation)
        return yield* failInvalidGeometry('generatePlacementCandidates', validation.message)
      const bounds = boundsForPoints(boundary.points)
      if (bounds === undefined) {
        return yield* failInvalidGeometry(
          'generatePlacementCandidates',
          'NFP boundary bounds must be finite.'
        )
      }
      const segments = polygonSegments(boundary)
      nfpBoundaries.push({
        index: nfpBoundaries.length,
        fixed: placed,
        boundary,
        winding: validation.winding,
        bounds,
        segments,
        segmentIndex: new BoundsIndex(
          segments.map((segment) => ({ value: segment, bounds: segment.bounds }))
        )
      })
    }

    yield* nfpCheckpoint(input.control, 'ifp')
    const ifpSegments = rectangleSegments(ifp.bounds)
    const contactOnly = input.candidateDomain === 'contact-only'
    const points = makeCanonicalPointSet()
    const allNfpIndex = new BoundsIndex(
      nfpBoundaries.map((boundary) => ({ value: boundary, bounds: boundary.bounds }))
    )
    const candidateNfpBoundaries =
      candidatePruningMode === 'indexed' ? allNfpIndex.query(ifp.bounds) : nfpBoundaries
    const candidateNfpIndex = new BoundsIndex(
      candidateNfpBoundaries.map((boundary) => ({ value: boundary, bounds: boundary.bounds }))
    )
    const candidateBounds = candidatePruningMode === 'indexed' ? ifp.bounds : undefined

    if (input.placed.length === 0) {
      addPoint(points, { x: ifp.bounds.minX, y: ifp.bounds.minY }, candidateBounds)
    } else if (!contactOnly) {
      for (const point of rectangleCorners(ifp.bounds)) addPoint(points, point, candidateBounds)
    }
    for (const boundary of candidateNfpBoundaries) {
      for (const point of boundary.boundary.points) addPoint(points, point, candidateBounds)
      const supportPointError = addAntiparallelEdgeSupportPoints(
        points,
        boundary.fixed,
        input.moving,
        candidateBounds
      )
      if (supportPointError !== undefined) {
        return yield* failInvalidGeometry('generatePlacementCandidates', supportPointError)
      }
    }

    if (!contactOnly) {
      for (const boundary of candidateNfpBoundaries) {
        yield* nfpCheckpoint(input.control, 'ifp-boundary-intersection')
        const intersections = yield* addBoundaryIntersections(
          points,
          ifpSegments,
          boundary.segments,
          candidatePruningMode === 'indexed' ? boundary.segmentIndex : undefined,
          candidateBounds,
          input.control,
          'ifp-boundary-intersection'
        )
        if (intersections !== undefined) {
          return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
        }
      }
    }

    if (candidatePruningMode === 'indexed') {
      for (const first of candidateNfpBoundaries) {
        yield* nfpCheckpoint(input.control, 'pairwise-nfp-boundary-intersection')
        for (const second of candidateNfpIndex.query(first.bounds)) {
          if (second.index <= first.index) continue
          yield* nfpCheckpoint(input.control, 'pairwise-nfp-boundary-intersection')
          const intersections = yield* addBoundaryIntersections(
            points,
            first.segments,
            second.segments,
            second.segmentIndex,
            candidateBounds,
            input.control,
            'pairwise-nfp-boundary-intersection'
          )
          if (intersections !== undefined) {
            return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
          }
        }
      }
    } else {
      for (let firstIndex = 0; firstIndex < nfpBoundaries.length; firstIndex += 1) {
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < nfpBoundaries.length;
          secondIndex += 1
        ) {
          yield* nfpCheckpoint(input.control, 'pairwise-nfp-boundary-intersection')
          const first = nfpBoundaries[firstIndex]
          if (first === undefined)
            return yield* failInvalidGeometry('generatePlacementCandidates', 'NFP boundary is missing.')

          const second = nfpBoundaries[secondIndex]
          if (second === undefined)
            return yield* failInvalidGeometry(
              'generatePlacementCandidates',
              'NFP boundary is missing.'
            )

          if (areDisjoint(first.bounds, second.bounds)) continue

          const intersections = yield* addBoundaryIntersections(
            points,
            first.segments,
            second.segments,
            undefined,
            undefined,
            input.control,
            'pairwise-nfp-boundary-intersection'
          )
          if (intersections !== undefined) {
            return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
          }
        }
      }
    }

    const candidates: IrregularPlacementCandidate[] = []
    const sortedPoints = [...points.points].sort(comparePoints)
    for (let pointIndex = 0; pointIndex < sortedPoints.length; pointIndex += 1) {
      if (pointIndex % 32 === 0)
        yield* nfpCheckpoint(input.control, 'candidate-points')
      const point = sortedPoints[pointIndex]
      if (point === undefined) continue
      if (!isInsideBounds(point, ifp.bounds)) continue
      const boundariesForPoint =
        candidatePruningMode === 'indexed'
          ? candidateNfpIndex.query(pointBounds(point))
          : nfpBoundaries
      if (
        boundariesForPoint.some(
          ({ boundary, winding, bounds }) =>
            isInsideBounds(point, bounds) && isStrictlyInside(point, boundary, winding)
        )
      ) {
        continue
      }

      const candidate: InternalPlacementCandidate = {
        pieceId: input.moving.sourcePieceId,
        transform: input.moving.transform,
        point,
        diagnostics: []
      }
      const legal = yield* PlacementValidation.check({
        sheet: input.sheet,
        placed: input.placed,
        ...(placedCollisionIndex !== undefined ? { placedCollisionIndex } : {}),
        moving: input.moving,
        candidate
      })
      if (legal) candidates.push(toDomainPlacementCandidate(candidate))
    }

    yield* nfpCheckpoint(input.control, 'candidate-points')
    return candidates
  })
}

function makeGeneratePlacementCandidates(
  geometryCache: GeometryCache,
  constructionAlgorithm: NfpConstructionAlgorithm,
  candidatePruningMode: NfpCandidatePruningMode
): NfpIfpService['generatePlacementCandidates'] {
  const candidatesByScope = new WeakMap<
    IrregularNfpIfpCandidateMemoScope,
    Map<string, ReadonlyArray<CachedLegalCandidate>>
  >()

  function service(
    input: GeneratePlacementCandidatesInput & { readonly control: IrregularNfpIfpControl }
  ): Effect.Effect<
    ReadonlyArray<IrregularPlacementCandidate>,
    IrregularGeometryInputError | IrregularNfpIfpControlAbortError
  >
  function service(
    input: GeneratePlacementCandidatesInput
  ): Effect.Effect<ReadonlyArray<IrregularPlacementCandidate>, IrregularGeometryInputError>
  function service(
    input: GeneratePlacementCandidatesInput
  ): Effect.Effect<
    ReadonlyArray<IrregularPlacementCandidate>,
    IrregularGeometryInputError | IrregularNfpIfpControlAbortError
  > {
    const scope = input.candidateMemoScope
    if (scope === undefined) {
      return generatePlacementCandidatesUncached(
        input,
        geometryCache,
        constructionAlgorithm,
        candidatePruningMode
      )
    }

    let candidatesByGeometry = candidatesByScope.get(scope)
    if (candidatesByGeometry === undefined) {
      candidatesByGeometry = new Map()
      candidatesByScope.set(scope, candidatesByGeometry)
    }
    const key = legalPlacementCandidateMemoKey(
      input,
      constructionAlgorithm,
      candidatePruningMode
    )
    const cached = candidatesByGeometry.get(key)
    if (cached !== undefined) {
      return nfpCheckpoint(input.control, 'candidate-points').pipe(
        Effect.map(() => restoreCachedLegalCandidates(cached, input.moving))
      )
    }

    return generatePlacementCandidatesUncached(
      input,
      geometryCache,
      constructionAlgorithm,
      candidatePruningMode
    ).pipe(
      Effect.tap((candidates) =>
        Effect.sync(() => {
          candidatesByGeometry?.set(key, cacheLegalCandidates(candidates))
        })
      )
    )
  }

  return service
}

interface CachedLegalCandidate {
  readonly point: InternalPoint
  readonly diagnostics: IrregularPlacementCandidate['diagnostics']
}

function cacheLegalCandidates(
  candidates: ReadonlyArray<IrregularPlacementCandidate>
): ReadonlyArray<CachedLegalCandidate> {
  return candidates.map(({ point, diagnostics }) => ({
    point: { x: point.x, y: point.y },
    diagnostics: [...diagnostics]
  }))
}

function restoreCachedLegalCandidates(
  cached: ReadonlyArray<CachedLegalCandidate>,
  moving: TransformedCollisionGeometry
): ReadonlyArray<IrregularPlacementCandidate> {
  return cached.map(
    ({ point, diagnostics }) =>
      new IrregularPlacementCandidate({
        pieceId: moving.sourcePieceId,
        transform: moving.transform,
        point: new IrregularPoint(point),
        diagnostics: [...diagnostics]
      })
  )
}

interface BoundsIndexEntry<T> {
  readonly value: T
  readonly bounds: InternalBounds
}

/** Indexes inclusive axis-aligned bounds without dropping boundary contacts. */
class BoundsIndex<T> {
  private readonly entries: ReadonlyArray<SortedBoundsIndexEntry<T>>
  private readonly prefixMaxX: ReadonlyArray<number>

  constructor(entries: ReadonlyArray<BoundsIndexEntry<T>>) {
    this.entries = entries
      .map((entry, sourceIndex) => ({ ...entry, sourceIndex }))
      .toSorted(compareBoundsIndexEntries)

    const prefixMaxX: number[] = []
    let currentMaxX = Number.NEGATIVE_INFINITY
    for (const entry of this.entries) {
      currentMaxX = Math.max(currentMaxX, entry.bounds.maxX)
      prefixMaxX.push(currentMaxX)
    }
    this.prefixMaxX = prefixMaxX
  }

  query(bounds: InternalBounds): ReadonlyArray<T> {
    const firstIndex = lowerBoundAtLeast(this.prefixMaxX, bounds.minX)
    const endIndex = upperBoundMinX(this.entries, bounds.maxX)
    const matches: T[] = []

    for (let index = firstIndex; index < endIndex; index += 1) {
      const entry = this.entries[index]
      if (entry !== undefined && !areDisjoint(entry.bounds, bounds)) {
        matches.push(entry.value)
      }
    }

    return matches
  }
}

interface SortedBoundsIndexEntry<T> extends BoundsIndexEntry<T> {
  readonly sourceIndex: number
}

function compareBoundsIndexEntries<T>(
  first: SortedBoundsIndexEntry<T>,
  second: SortedBoundsIndexEntry<T>
): number {
  if (first.bounds.minX !== second.bounds.minX) {
    return first.bounds.minX - second.bounds.minX
  }
  if (first.bounds.maxX !== second.bounds.maxX) {
    return first.bounds.maxX - second.bounds.maxX
  }
  if (first.bounds.minY !== second.bounds.minY) {
    return first.bounds.minY - second.bounds.minY
  }
  if (first.bounds.maxY !== second.bounds.maxY) {
    return first.bounds.maxY - second.bounds.maxY
  }
  return first.sourceIndex - second.sourceIndex
}

function lowerBoundAtLeast(values: ReadonlyArray<number>, target: number): number {
  let start = 0
  let end = values.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    const value = values[middle]
    if (value !== undefined && value < target) start = middle + 1
    else end = middle
  }
  return start
}

function upperBoundMinX<T>(
  entries: ReadonlyArray<SortedBoundsIndexEntry<T>>,
  target: number
): number {
  let start = 0
  let end = entries.length
  while (start < end) {
    const middle = Math.floor((start + end) / 2)
    const entry = entries[middle]
    if (entry !== undefined && entry.bounds.minX <= target) start = middle + 1
    else end = middle
  }
  return start
}

interface Segment {
  readonly start: InternalPoint
  readonly end: InternalPoint
  readonly bounds: InternalBounds
}

interface NfpBoundary {
  readonly index: number
  /** Placed collision polygon whose NFP boundary produced this contact family. */
  readonly fixed: IrregularPlacedPiece
  readonly boundary: InternalPolygon
  readonly winding: -1 | 1
  readonly bounds: InternalBounds
  readonly segments: ReadonlyArray<Segment>
  readonly segmentIndex: BoundsIndex<Segment>
}

/**
 * Adds endpoint alignments for antiparallel fixed and moving edges.
 *
 * A full edge mate may lie in the middle of an NFP edge rather than at an NFP
 * corner. Aligning either endpoint of the two antiparallel collision edges
 * yields the two finite support translations at the ends of that contact
 * interval. Existing NFP and direct-validation filters remain authoritative.
 */
function addAntiparallelEdgeSupportPoints(
  points: CanonicalPointSet,
  fixed: IrregularPlacedPiece,
  moving: TransformedCollisionGeometry,
  candidateBounds: InternalBounds | undefined
): string | undefined {
  const fixedTranslation = fixed.placement.transform
  const fixedPoints = fixed.collisionGeometry.polygon.points.map((point) => ({
    x: point.x + fixedTranslation.translateX,
    y: point.y + fixedTranslation.translateY
  }))
  const movingPoints = moving.polygon.points

  for (const fixedEdge of polygonEdgesFromPoints(fixedPoints)) {
    const fixedDirection = {
      x: fixedEdge.end.x - fixedEdge.start.x,
      y: fixedEdge.end.y - fixedEdge.start.y
    }
    for (const movingEdge of polygonEdgesFromPoints(movingPoints)) {
      const movingDirection = {
        x: movingEdge.end.x - movingEdge.start.x,
        y: movingEdge.end.y - movingEdge.start.y
      }
      if (GeometryPredicates.orientation(ORIGIN, fixedDirection, movingDirection) !== 0) continue

      const directionDotProduct =
        fixedDirection.x * movingDirection.x + fixedDirection.y * movingDirection.y
      if (!Number.isFinite(directionDotProduct) || directionDotProduct >= 0) continue

      const firstSupportPoint = {
        x: fixedEdge.start.x - movingEdge.end.x,
        y: fixedEdge.start.y - movingEdge.end.y
      }
      const secondSupportPoint = {
        x: fixedEdge.end.x - movingEdge.start.x,
        y: fixedEdge.end.y - movingEdge.start.y
      }
      if (!isFinitePoint(firstSupportPoint) || !isFinitePoint(secondSupportPoint)) {
        return 'antiparallel edge support arithmetic must produce finite coordinates.'
      }
      addPoint(points, firstSupportPoint, candidateBounds)
      addPoint(points, secondSupportPoint, candidateBounds)
    }
  }
  return undefined
}

interface PolygonEdge {
  readonly start: InternalPoint
  readonly end: InternalPoint
}

function polygonEdgesFromPoints(points: ReadonlyArray<InternalPoint>): ReadonlyArray<PolygonEdge> {
  const edges: PolygonEdge[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) return []
    edges.push({ start, end })
  }
  return edges
}

function isFinitePoint(point: InternalPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

interface CanonicalPointSet {
  readonly keys: Set<string>
  readonly points: InternalPoint[]
}

interface SegmentIntersection {
  readonly points: ReadonlyArray<InternalPoint>
}

interface InternalIfpBounds {
  readonly sheet: ComputeIfpBoundsInput['sheet']
  readonly movingPieceId: ComputeIfpBoundsInput['moving']['sourcePieceId']
  readonly bounds: InternalBounds
}

interface InternalPlacementCandidate {
  readonly pieceId: IrregularPlacementCandidate['pieceId']
  readonly transform: IrregularPlacementCandidate['transform']
  readonly point: InternalPoint
  readonly diagnostics: IrregularPlacementCandidate['diagnostics']
}

function rectangleCorners(bounds: InternalBounds): ReadonlyArray<InternalPoint> {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY }
  ]
}

function rectangleSegments(bounds: InternalBounds): ReadonlyArray<Segment> {
  const corners = rectangleCorners(bounds)
  return polygonSegments({ points: corners })
}

function polygonSegments(polygon: InternalPolygon): ReadonlyArray<Segment> {
  const segments: Segment[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start !== undefined && end !== undefined) {
      segments.push({ start, end, bounds: segmentBounds(start, end) })
    }
  }
  return segments
}

function segmentBounds(first: InternalPoint, second: InternalPoint): InternalBounds {
  return {
    minX: Math.min(first.x, second.x),
    minY: Math.min(first.y, second.y),
    maxX: Math.max(first.x, second.x),
    maxY: Math.max(first.y, second.y)
  }
}

function addBoundaryIntersections(
  points: CanonicalPointSet,
  firstSegments: ReadonlyArray<Segment>,
  secondSegments: ReadonlyArray<Segment>,
  secondSegmentIndex: BoundsIndex<Segment> | undefined,
  candidateBounds: InternalBounds | undefined,
  control: IrregularNfpIfpControl | undefined,
  phase: IrregularNfpIfpCheckpointPhase
): Effect.Effect<string | undefined, IrregularNfpIfpControlAbortError> {
  return Effect.gen(function* () {
    for (const first of firstSegments) {
      const firstQueryBounds =
        candidateBounds === undefined
          ? first.bounds
          : intersectionBounds(first.bounds, candidateBounds)
      if (firstQueryBounds === undefined) continue

      const possibleSecondSegments =
        secondSegmentIndex === undefined
          ? secondSegments
          : secondSegmentIndex.query(firstQueryBounds)
      let pairIndex = 0
      for (const second of possibleSecondSegments) {
        if (pairIndex % 32 === 0) yield* nfpCheckpoint(control, phase)
        pairIndex += 1
        if (candidateBounds !== undefined && areDisjoint(second.bounds, candidateBounds)) {
          continue
        }
        const intersection = intersectSegments(first, second)
        if ('message' in intersection) return intersection.message
        for (const point of intersection.points) addPoint(points, point, candidateBounds)
      }
    }
    return undefined
  })
}

function nfpCheckpoint(
  control: IrregularNfpIfpControl | undefined,
  phase: IrregularNfpIfpCheckpointPhase
): Effect.Effect<void, IrregularNfpIfpControlAbortError> {
  return control === undefined ? Effect.void : control.checkpoint(phase)
}

function intersectSegments(
  first: Segment,
  second: Segment
): SegmentIntersection | { readonly message: string } {
  const firstStartTurn = GeometryPredicates.orientation(first.start, first.end, second.start)
  const firstEndTurn = GeometryPredicates.orientation(first.start, first.end, second.end)
  const secondStartTurn = GeometryPredicates.orientation(second.start, second.end, first.start)
  const secondEndTurn = GeometryPredicates.orientation(second.start, second.end, first.end)
  const points: InternalPoint[] = []

  if (
    firstStartTurn !== 0 &&
    firstEndTurn !== 0 &&
    secondStartTurn !== 0 &&
    secondEndTurn !== 0 &&
    firstStartTurn !== firstEndTurn &&
    secondStartTurn !== secondEndTurn
  ) {
    const firstDirectionX = first.end.x - first.start.x
    const firstDirectionY = first.end.y - first.start.y
    const secondDirectionX = second.end.x - second.start.x
    const secondDirectionY = second.end.y - second.start.y
    const denominator = firstDirectionX * secondDirectionY - firstDirectionY * secondDirectionX
    const offsetX = second.start.x - first.start.x
    const offsetY = second.start.y - first.start.y
    const numerator = offsetX * secondDirectionY - offsetY * secondDirectionX
    if (
      !Number.isFinite(firstDirectionX) ||
      !Number.isFinite(firstDirectionY) ||
      !Number.isFinite(secondDirectionX) ||
      !Number.isFinite(secondDirectionY) ||
      !Number.isFinite(denominator) ||
      !Number.isFinite(offsetX) ||
      !Number.isFinite(offsetY) ||
      !Number.isFinite(numerator)
    ) {
      return { message: 'segment intersection arithmetic must produce finite coordinates.' }
    }

    if (denominator !== 0) {
      const parameter = numerator / denominator
      const x = first.start.x + parameter * firstDirectionX
      const y = first.start.y + parameter * firstDirectionY
      if (
        !Number.isFinite(parameter) ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return { message: 'segment intersection arithmetic must produce finite coordinates.' }
      }
      return { points: [{ x, y }] }
    }

    // exact predicates prove a strict crossing, but near-parallel direction
    // products can still round the floating denominator to zero
    const secondEndOffsetX = second.end.x - first.start.x
    const secondEndOffsetY = second.end.y - first.start.y
    const startArea = firstDirectionX * offsetY - firstDirectionY * offsetX
    const endArea =
      firstDirectionX * secondEndOffsetY - firstDirectionY * secondEndOffsetX
    if (
      !Number.isFinite(secondEndOffsetX) ||
      !Number.isFinite(secondEndOffsetY) ||
      !Number.isFinite(startArea) ||
      !Number.isFinite(endArea)
    ) {
      return { message: 'segment intersection arithmetic must produce finite coordinates.' }
    }

    // rounded areas can disagree with the exact predicate signs, so only use
    // a bounded interior parameter derived from strictly opposite signs
    const oppositeSigns =
      (startArea > 0 && endArea < 0) || (startArea < 0 && endArea > 0)
    const fallbackParameter = startArea / (startArea - endArea)
    const fallbackX = second.start.x + fallbackParameter * secondDirectionX
    const fallbackY = second.start.y + fallbackParameter * secondDirectionY
    if (
      !oppositeSigns ||
      !Number.isFinite(fallbackParameter) ||
      fallbackParameter <= 0 ||
      fallbackParameter >= 1 ||
      !Number.isFinite(fallbackX) ||
      !Number.isFinite(fallbackY)
    ) {
      return { points: [] }
    }
    const fallbackPoint = { x: fallbackX, y: fallbackY }
    if (
      !pointIsWithinSegmentBounds(fallbackPoint, first) ||
      !pointIsWithinSegmentBounds(fallbackPoint, second)
    ) {
      return { points: [] }
    }
    return { points: [fallbackPoint] }
  }

  if (firstStartTurn === 0 && pointIsWithinSegmentBounds(second.start, first)) {
    points.push(second.start)
  }
  if (firstEndTurn === 0 && pointIsWithinSegmentBounds(second.end, first)) points.push(second.end)
  if (secondStartTurn === 0 && pointIsWithinSegmentBounds(first.start, second)) {
    points.push(first.start)
  }
  if (secondEndTurn === 0 && pointIsWithinSegmentBounds(first.end, second)) points.push(first.end)

  return { points }
}

function pointIsWithinSegmentBounds(point: InternalPoint, segment: Segment): boolean {
  return (
    point.x >= Math.min(segment.start.x, segment.end.x) &&
    point.x <= Math.max(segment.start.x, segment.end.x) &&
    point.y >= Math.min(segment.start.y, segment.end.y) &&
    point.y <= Math.max(segment.start.y, segment.end.y)
  )
}

function makeCanonicalPointSet(): CanonicalPointSet {
  return { keys: new Set<string>(), points: [] }
}

function addPoint(
  points: CanonicalPointSet,
  point: InternalPoint,
  candidateBounds: InternalBounds | undefined
): void {
  const canonicalPoint: InternalPoint = {
    x: normalizeNegativeZero(point.x),
    y: normalizeNegativeZero(point.y)
  }
  if (candidateBounds !== undefined && !isInsideBounds(canonicalPoint, candidateBounds)) return
  const key = `${canonicalPoint.x}:${canonicalPoint.y}`
  if (points.keys.has(key)) return
  points.keys.add(key)
  points.points.push(canonicalPoint)
}

function comparePoints(first: InternalPoint, second: InternalPoint): number {
  if (first.y !== second.y) return first.y - second.y
  return first.x - second.x
}

function pointBounds(point: InternalPoint): InternalBounds {
  return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y }
}

function intersectionBounds(
  first: InternalBounds,
  second: InternalBounds
): InternalBounds | undefined {
  const minX = Math.max(first.minX, second.minX)
  const minY = Math.max(first.minY, second.minY)
  const maxX = Math.min(first.maxX, second.maxX)
  const maxY = Math.min(first.maxY, second.maxY)
  if (minX > maxX || minY > maxY) return undefined
  return { minX, minY, maxX, maxY }
}

function isInsideBounds(point: InternalPoint, bounds: InternalBounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  )
}

function isStrictlyInside(
  point: InternalPoint,
  polygon: InternalPolygon,
  winding: -1 | 1
): boolean {
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start === undefined || end === undefined) return false
    const turn = GeometryPredicates.orientation(start, end, point)
    if (turn === 0 || turn !== winding) return false
  }
  return true
}

function rotateToStableStart(points: ReadonlyArray<InternalPoint>): InternalPoint[] {
  let startIndex = 0
  for (let index = 1; index < points.length; index += 1) {
    const candidate = points[index]
    const current = points[startIndex]
    if (candidate === undefined || current === undefined) continue
    if (candidate.y < current.y || (candidate.y === current.y && candidate.x < current.x)) {
      startIndex = index
    }
  }

  return [...points.slice(startIndex), ...points.slice(0, startIndex)]
}

function toDomainPlacementCandidate(
  candidate: InternalPlacementCandidate
): IrregularPlacementCandidate {
  return new IrregularPlacementCandidate({
    pieceId: candidate.pieceId,
    transform: candidate.transform,
    point: new IrregularPoint({ x: candidate.point.x, y: candidate.point.y }),
    diagnostics: [...candidate.diagnostics]
  })
}

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
