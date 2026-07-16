import { Effect, Layer } from 'effect'
import {
  IrregularBounds,
  IrregularIfpBounds,
  IrregularNfp,
  IrregularPlacementCandidate,
  IrregularPoint,
  IrregularPolygon
} from '@shared/irregular/domain.js'
import type {
  ComputeIfpBoundsInput,
  ComputeNfpInput,
  GeneratePlacementCandidatesInput
} from './services.js'
import {
  IrregularGeometryInfeasibleError,
  GeometryCache,
  GeometryCacheInMemory,
  IrregularGeometryInputError,
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
  pairwiseNfpCacheKey
} from './geometryCacheKeys.js'
import type { NfpConstructionAlgorithm } from './geometryCacheKeys.js'

export { DEFAULT_NFP_CONSTRUCTION_ALGORITHM }
export type { NfpConstructionAlgorithm }

/** Provides deterministic convex IFP bounds and outer NFP boundaries. */
export function makeNfpIfpServiceLayer(
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM
) {
  return Layer.effect(
    NfpIfpService,
    Effect.gen(function* () {
      const geometryCache = yield* GeometryCache
      return NfpIfpService.of({
        computeNfp: (input) => computeNfpCached(input, geometryCache, constructionAlgorithm),
        computeIfpBounds: (input) => computeIfpBoundsCached(input, geometryCache),
        generatePlacementCandidates: (input) =>
          generatePlacementCandidates(input, geometryCache, constructionAlgorithm)
      })
    })
  )
}

export const NfpIfpServiceLayer = makeNfpIfpServiceLayer()

/** Standalone service layer with a private deterministic cache for direct callers. */
export function makeNfpIfpServiceLive(
  constructionAlgorithm: NfpConstructionAlgorithm = DEFAULT_NFP_CONSTRUCTION_ALGORITHM
) {
  return makeNfpIfpServiceLayer(constructionAlgorithm).pipe(
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
  return geometryCache.get<IrregularPolygon>(key).pipe(
    Effect.flatMap((cached) => {
      if (isValidCachedNfpBoundary(cached)) return translateNfpBoundary(input, cached)

      const removeInvalid = cached === undefined ? Effect.void : geometryCache.remove(key)
      return removeInvalid.pipe(
        Effect.flatMap(() => computeNfpBoundaryUncached(input, constructionAlgorithm)),
        Effect.tap((computed) => geometryCache.set(key, computed)),
        Effect.flatMap((boundary) => translateNfpBoundary(input, boundary))
      )
    })
  )
}

function computeNfpBoundaryUncached(
  input: ComputeNfpInput,
  constructionAlgorithm: NfpConstructionAlgorithm
): Effect.Effect<IrregularPolygon, IrregularGeometryInputError> {
  const construct =
    constructionAlgorithm === 'linear-edge-merge'
      ? NfpBoundaryAlgorithms.linear
      : NfpBoundaryAlgorithms.reference
  const boundary = construct(
    input.fixed.collisionGeometry.polygon.points,
    input.moving.polygon.points
  )
  if ('message' in boundary) return failInvalidGeometry('computeNfp', boundary.message)
  return Effect.succeed(boundary)
}

export type NfpBoundaryConstructionResult = IrregularPolygon | { readonly message: string }

/** Removes exact cyclic repeats and redundant collinear vertices in linear time. */
export function canonicalizeTranslatedConvexRing(
  points: ReadonlyArray<IrregularPoint>
): NfpBoundaryConstructionResult {
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

  const canonicalPoints: IrregularPoint[] = []
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
  return new IrregularPolygon({ points: rotateToStableStart(canonicalPoints) })
}

/** Exposes the linear path and its hull-based differential oracle to focused tests. */
export const NfpBoundaryAlgorithms = {
  reference: computeRelativeNfpBoundaryReference,
  linear: computeRelativeNfpBoundaryLinear
} as const

function computeRelativeNfpBoundaryReference(
  fixedPoints: ReadonlyArray<IrregularPoint>,
  movingPoints: ReadonlyArray<IrregularPoint>
): NfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if ('message' in inputValidation) return inputValidation

  const negatedMovingPoints = movingPoints.map(
    (point) => new IrregularPoint({ x: -point.x, y: -point.y })
  )
  const minkowskiPoints: IrregularPoint[] = []
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

  return new IrregularPolygon({ points: rotateToStableStart(boundary.points) })
}

function computeRelativeNfpBoundaryLinear(
  fixedPoints: ReadonlyArray<IrregularPoint>,
  movingPoints: ReadonlyArray<IrregularPoint>
): NfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if ('message' in inputValidation) return inputValidation

  const fixedBoundary = counterClockwiseStablePoints(fixedPoints, inputValidation.fixedWinding)
  const negatedMovingPoints = movingPoints.map(
    (point) => new IrregularPoint({ x: -point.x, y: -point.y })
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
  const boundaryPoints: IrregularPoint[] = [initialSum]
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

  const canonicalBoundary = canonicalizeTranslatedConvexRing(boundaryPoints)
  if (!('message' in canonicalBoundary)) {
    const canonicalValidation = ConvexPolygonValidation.validateStrictBoundary(
      canonicalBoundary.points
    )
    if (!('message' in canonicalValidation)) {
      const counterClockwisePoints =
        canonicalValidation.winding === 1
          ? canonicalBoundary.points
          : [...canonicalBoundary.points].reverse()
      return new IrregularPolygon({ points: rotateToStableStart(counterClockwisePoints) })
    }
  }

  const boundary = ConvexHull.compute(boundaryPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation) return boundaryValidation
  const counterClockwisePoints =
    boundaryValidation.winding === 1 ? boundary.points : [...boundary.points].reverse()
  return new IrregularPolygon({ points: rotateToStableStart(counterClockwisePoints) })
}

interface ValidatedRelativeNfpInputs {
  readonly fixedWinding: ConvexPolygonWinding
  readonly movingWinding: ConvexPolygonWinding
}

function validateRelativeNfpInputs(
  fixedPoints: ReadonlyArray<IrregularPoint>,
  movingPoints: ReadonlyArray<IrregularPoint>
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

function finitePointsMessage(points: ReadonlyArray<IrregularPoint>): string | undefined {
  return points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? undefined
    : 'polygon coordinates must be finite.'
}

function counterClockwiseStablePoints(
  points: ReadonlyArray<IrregularPoint>,
  winding: ConvexPolygonWinding
): IrregularPoint[] {
  const counterClockwisePoints = winding === 1 ? [...points] : [...points].reverse()
  return rotateToStableStart(counterClockwisePoints)
}

function edgeVectors(
  points: ReadonlyArray<IrregularPoint>
): ReadonlyArray<IrregularPoint> | { readonly message: string } {
  const vectors: IrregularPoint[] = []
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
    vectors.push(new IrregularPoint({ x, y }))
  }
  return vectors
}

function compareEdgeDirections(firstEdge: IrregularPoint, secondEdge: IrregularPoint): -1 | 0 | 1 {
  const firstHalf = edgeDirectionHalf(firstEdge)
  const secondHalf = edgeDirectionHalf(secondEdge)
  if (firstHalf !== secondHalf) return firstHalf < secondHalf ? -1 : 1

  const directionTurn = GeometryPredicates.orientation(
    new IrregularPoint({ x: 0, y: 0 }),
    firstEdge,
    secondEdge
  )
  if (directionTurn > 0) return -1
  if (directionTurn < 0) return 1
  return 0
}

function edgeDirectionHalf(edge: IrregularPoint): 0 | 1 {
  return edge.y > 0 || (edge.y === 0 && edge.x >= 0) ? 0 : 1
}

function sumPoints(
  firstPoint: IrregularPoint,
  secondPoint: IrregularPoint,
  operation: string
): IrregularPoint | { readonly message: string } {
  const x = firstPoint.x + secondPoint.x
  const y = firstPoint.y + secondPoint.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { message: `${operation} must produce finite coordinates.` }
  }
  return new IrregularPoint({ x, y })
}

function pointsEqual(firstPoint: IrregularPoint, secondPoint: IrregularPoint): boolean {
  return firstPoint.x === secondPoint.x && firstPoint.y === secondPoint.y
}

function pointIsBetween(
  firstPoint: IrregularPoint,
  point: IrregularPoint,
  secondPoint: IrregularPoint
): boolean {
  return (
    point.x >= Math.min(firstPoint.x, secondPoint.x) &&
    point.x <= Math.max(firstPoint.x, secondPoint.x) &&
    point.y >= Math.min(firstPoint.y, secondPoint.y) &&
    point.y <= Math.max(firstPoint.y, secondPoint.y)
  )
}

function translateNfpBoundary(
  input: ComputeNfpInput,
  relativeBoundary: IrregularPolygon
): Effect.Effect<IrregularNfp, IrregularGeometryInputError> {
  const translatedPoints: IrregularPoint[] = []
  for (const point of relativeBoundary.points) {
    const x = point.x + input.fixed.placement.transform.translateX
    const y = point.y + input.fixed.placement.transform.translateY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failInvalidGeometry('computeNfp', 'fixed translation must produce finite coordinates.')
    }
    translatedPoints.push(new IrregularPoint({ x, y }))
  }

  const translatedBoundary = canonicalizeTranslatedConvexRing(translatedPoints)
  const canonicalBoundary =
    'message' in translatedBoundary
      ? canonicalizeTranslatedConvexRingWithHullFallback(translatedPoints)
      : translatedBoundary
  if ('message' in canonicalBoundary) return failInvalidGeometry('computeNfp', canonicalBoundary.message)

  return Effect.succeed(
    new IrregularNfp({
      fixedPieceId: input.fixed.placement.sourcePieceId,
      movingPieceId: input.moving.sourcePieceId,
      boundary: canonicalBoundary
    })
  )
}

/** Uses the exact hull only when the linear translated-ring pass cannot prove strict convexity. */
function canonicalizeTranslatedConvexRingWithHullFallback(
  points: ReadonlyArray<IrregularPoint>
): NfpBoundaryConstructionResult {
  const boundary = ConvexHull.compute(points)
  const validation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in validation) return validation
  return new IrregularPolygon({ points: rotateToStableStart(boundary.points) })
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
  const validation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in validation) return failInvalidGeometry('computeIfpBounds', validation.message)

  const key = innerFitBoundsCacheKey(input)
  return geometryCache.get<IrregularIfpBounds>(key).pipe(
    Effect.flatMap((cached) => {
      if (isValidCachedIfp(cached, input)) return Effect.succeed(cached)
      const removeInvalid = cached === undefined ? Effect.void : geometryCache.remove(key)
      return removeInvalid.pipe(
        Effect.flatMap(() => computeIfpBoundsUncached(input)),
        Effect.tap((computed) => geometryCache.set(key, computed))
      )
    })
  )
}

function computeIfpBoundsUncached(
  input: ComputeIfpBoundsInput
): Effect.Effect<
  IrregularIfpBounds,
  IrregularGeometryInputError | IrregularGeometryInfeasibleError
> {
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

  const bounds = new IrregularBounds({ minX, minY, maxX, maxY })

  return Effect.succeed(
    new IrregularIfpBounds({
      sheet: input.sheet,
      movingPieceId: input.moving.sourcePieceId,
      bounds
    })
  )
}

/** Builds deterministic IFP/NFP contact candidates and filters illegal results. */
function generatePlacementCandidates(
  input: GeneratePlacementCandidatesInput,
  geometryCache: GeometryCache,
  constructionAlgorithm: NfpConstructionAlgorithm
): Effect.Effect<ReadonlyArray<IrregularPlacementCandidate>, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const ifp = yield* computeIfpBoundsCached(
      { sheet: input.sheet, moving: input.moving },
      geometryCache
    ).pipe(Effect.catchTag('IrregularGeometryInfeasibleError', () => Effect.succeed(undefined)))
    if (ifp === undefined) return []
    const nfpBoundaries: NfpBoundary[] = []

    for (const placed of input.placed) {
      const nfp = yield* computeNfpCached(
        {
          fixed: placed,
          moving: input.moving,
          settings: input.settings.geometry
        },
        geometryCache,
        constructionAlgorithm
      )
      const validation = ConvexPolygonValidation.validateStrictBoundary(nfp.boundary.points)
      if ('message' in validation)
        return yield* failInvalidGeometry('generatePlacementCandidates', validation.message)
      const bounds = boundsForPoints(nfp.boundary.points)
      if (bounds === undefined) {
        return yield* failInvalidGeometry(
          'generatePlacementCandidates',
          'NFP boundary bounds must be finite.'
        )
      }
      nfpBoundaries.push({
        nfp,
        winding: validation.winding,
        bounds,
        segments: polygonSegments(nfp.boundary)
      })
    }

    const ifpSegments = rectangleSegments(ifp.bounds)
    const pointsByKey = new Map<string, IrregularPoint>()
    for (const point of rectangleCorners(ifp.bounds)) addPoint(pointsByKey, point)
    for (const { nfp } of nfpBoundaries) {
      for (const point of nfp.boundary.points) addPoint(pointsByKey, point)
    }

    for (const boundary of nfpBoundaries) {
      const intersections = addBoundaryIntersections(pointsByKey, ifpSegments, boundary.segments)
      if (intersections !== undefined) {
        return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
      }
    }

    for (let firstIndex = 0; firstIndex < nfpBoundaries.length; firstIndex += 1) {
      const first = nfpBoundaries[firstIndex]
      if (first === undefined)
        return yield* failInvalidGeometry('generatePlacementCandidates', 'NFP boundary is missing.')

      for (let secondIndex = firstIndex + 1; secondIndex < nfpBoundaries.length; secondIndex += 1) {
        const second = nfpBoundaries[secondIndex]
        if (second === undefined)
          return yield* failInvalidGeometry(
            'generatePlacementCandidates',
            'NFP boundary is missing.'
          )

        if (areDisjoint(first.bounds, second.bounds)) continue

        const intersections = addBoundaryIntersections(pointsByKey, first.segments, second.segments)
        if (intersections !== undefined) {
          return yield* failInvalidGeometry('generatePlacementCandidates', intersections)
        }
      }
    }

    const candidates: IrregularPlacementCandidate[] = []
    const sortedPoints = [...pointsByKey.values()].sort(comparePoints)
    for (const point of sortedPoints) {
      if (!isInsideBounds(point, ifp.bounds)) continue
      if (
        nfpBoundaries.some(
          ({ nfp, winding, bounds }) =>
            isInsideBounds(point, bounds) && isStrictlyInside(point, nfp.boundary, winding)
        )
      ) {
        continue
      }

      const candidate = new IrregularPlacementCandidate({
        pieceId: input.moving.sourcePieceId,
        transform: input.moving.transform,
        point,
        diagnostics: []
      })
      const legal = yield* PlacementValidation.check({
        sheet: input.sheet,
        placed: input.placed,
        moving: input.moving,
        candidate
      })
      if (legal) candidates.push(candidate)
    }

    return candidates
  })
}

interface Segment {
  readonly start: IrregularPoint
  readonly end: IrregularPoint
}

interface NfpBoundary {
  readonly nfp: IrregularNfp
  readonly winding: -1 | 1
  readonly bounds: IrregularBounds
  readonly segments: ReadonlyArray<Segment>
}

interface SegmentIntersection {
  readonly points: ReadonlyArray<IrregularPoint>
}

function rectangleCorners(bounds: IrregularBounds): ReadonlyArray<IrregularPoint> {
  return [
    new IrregularPoint({ x: bounds.minX, y: bounds.minY }),
    new IrregularPoint({ x: bounds.maxX, y: bounds.minY }),
    new IrregularPoint({ x: bounds.maxX, y: bounds.maxY }),
    new IrregularPoint({ x: bounds.minX, y: bounds.maxY })
  ]
}

function rectangleSegments(bounds: IrregularBounds): ReadonlyArray<Segment> {
  const corners = rectangleCorners(bounds)
  return polygonSegments(new IrregularPolygon({ points: corners }))
}

function polygonSegments(polygon: IrregularPolygon): ReadonlyArray<Segment> {
  const segments: Segment[] = []
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index]
    const end = polygon.points[(index + 1) % polygon.points.length]
    if (start !== undefined && end !== undefined) segments.push({ start, end })
  }
  return segments
}

function addBoundaryIntersections(
  pointsByKey: Map<string, IrregularPoint>,
  firstSegments: ReadonlyArray<Segment>,
  secondSegments: ReadonlyArray<Segment>
): string | undefined {
  for (const first of firstSegments) {
    for (const second of secondSegments) {
      const intersection = intersectSegments(first, second)
      if ('message' in intersection) return intersection.message
      for (const point of intersection.points) addPoint(pointsByKey, point)
    }
  }
  return undefined
}

function intersectSegments(
  first: Segment,
  second: Segment
): SegmentIntersection | { readonly message: string } {
  const firstStartTurn = GeometryPredicates.orientation(first.start, first.end, second.start)
  const firstEndTurn = GeometryPredicates.orientation(first.start, first.end, second.end)
  const secondStartTurn = GeometryPredicates.orientation(second.start, second.end, first.start)
  const secondEndTurn = GeometryPredicates.orientation(second.start, second.end, first.end)
  const points: IrregularPoint[] = []

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
    const parameter = numerator / denominator
    const x = first.start.x + parameter * firstDirectionX
    const y = first.start.y + parameter * firstDirectionY
    if (
      !Number.isFinite(firstDirectionX) ||
      !Number.isFinite(firstDirectionY) ||
      !Number.isFinite(secondDirectionX) ||
      !Number.isFinite(secondDirectionY) ||
      !Number.isFinite(denominator) ||
      !Number.isFinite(parameter) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      return { message: 'segment intersection arithmetic must produce finite coordinates.' }
    }
    return { points: [new IrregularPoint({ x, y })] }
  }

  if (firstStartTurn === 0 && pointIsOnSegment(second.start, first)) points.push(second.start)
  if (firstEndTurn === 0 && pointIsOnSegment(second.end, first)) points.push(second.end)
  if (secondStartTurn === 0 && pointIsOnSegment(first.start, second)) points.push(first.start)
  if (secondEndTurn === 0 && pointIsOnSegment(first.end, second)) points.push(first.end)

  return { points }
}

function pointIsOnSegment(point: IrregularPoint, segment: Segment): boolean {
  return (
    point.x >= Math.min(segment.start.x, segment.end.x) &&
    point.x <= Math.max(segment.start.x, segment.end.x) &&
    point.y >= Math.min(segment.start.y, segment.end.y) &&
    point.y <= Math.max(segment.start.y, segment.end.y)
  )
}

function addPoint(pointsByKey: Map<string, IrregularPoint>, point: IrregularPoint): void {
  const canonicalPoint = new IrregularPoint({
    x: normalizeNegativeZero(point.x),
    y: normalizeNegativeZero(point.y)
  })
  const key = `${canonicalPoint.x}:${canonicalPoint.y}`
  if (!pointsByKey.has(key)) pointsByKey.set(key, canonicalPoint)
}

function comparePoints(first: IrregularPoint, second: IrregularPoint): number {
  if (first.y !== second.y) return first.y - second.y
  return first.x - second.x
}

function isInsideBounds(point: IrregularPoint, bounds: IrregularBounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  )
}

function isStrictlyInside(
  point: IrregularPoint,
  polygon: IrregularPolygon,
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

function rotateToStableStart(points: ReadonlyArray<IrregularPoint>): IrregularPoint[] {
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

function normalizeNegativeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
