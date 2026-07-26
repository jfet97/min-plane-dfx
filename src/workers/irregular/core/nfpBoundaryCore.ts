import type { InternalPoint, InternalPolygon } from '../internalGeometry.js'
import { ConvexPolygonValidation } from '../convexPolygonValidation.js'
import type { ConvexPolygonWinding } from '../convexPolygonValidation.js'
import { GeometryPredicates } from '../geometryPredicates.js'
import { computeConvexHull } from './convexHullCore.js'
import type { GeometryCacheKey, GeometryCacheStore } from './geometryCacheStore.js'
import {
  makePairwiseNfpCacheKey,
  type CoreGeometrySettings,
  type CoreTransformCandidate,
  type NfpConstructionAlgorithm
} from './nfpCacheKey.js'

const ORIGIN: InternalPoint = { x: 0, y: 0 }

export interface CoreNfpInput {
  readonly fixed: {
    readonly collisionGeometry: {
      readonly polygon: InternalPolygon
      readonly transform: CoreTransformCandidate
    }
    readonly placement: {
      readonly transform: {
        readonly translateX: number
        readonly translateY: number
      }
    }
  }
  readonly moving: {
    readonly polygon: InternalPolygon
    readonly transform: CoreTransformCandidate
  }
  readonly settings: CoreGeometrySettings
}

export interface CoreNfpSuccess {
  readonly ok: true
  readonly boundary: InternalPolygon
  readonly key: GeometryCacheKey
}

export interface CoreNfpFailure {
  readonly ok: false
  readonly message: string
}

export type CoreNfpResult = CoreNfpSuccess | CoreNfpFailure
export type CoreNfpBoundaryConstructionResult = InternalPolygon | CoreNfpFailure

/** Resolves one relative NFP through a synchronous store and translates it into sheet space. */
export function resolveNfpBoundary(
  input: CoreNfpInput,
  cache: GeometryCacheStore,
  constructionAlgorithm: NfpConstructionAlgorithm
): CoreNfpResult {
  const fixedValidation = ConvexPolygonValidation.validateStrictBoundary(
    input.fixed.collisionGeometry.polygon.points
  )
  if ('message' in fixedValidation) return failure(fixedValidation.message)

  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(input.moving.polygon.points)
  if ('message' in movingValidation) return failure(movingValidation.message)

  const key = makePairwiseNfpCacheKey(
    {
      fixedPolygon: input.fixed.collisionGeometry.polygon.points,
      movingPolygon: input.moving.polygon.points,
      fixedTransform: input.fixed.collisionGeometry.transform,
      movingTransform: input.moving.transform,
      settings: input.settings
    },
    constructionAlgorithm
  )
  const cached = cache.get<InternalPolygon>(key)
  let relativeBoundary: InternalPolygon

  if (isValidCachedNfpBoundary(cached)) {
    relativeBoundary = cached
  } else {
    if (cached !== undefined) cache.remove(key)
    const computed = computeRelativeNfpBoundary(
      input.fixed.collisionGeometry.polygon.points,
      input.moving.polygon.points,
      constructionAlgorithm
    )
    if ('message' in computed) return computed
    relativeBoundary = computed
    cache.set(key, computed)
  }

  const translated = translateNfpBoundary(input, relativeBoundary)
  return 'message' in translated ? translated : { ok: true, boundary: translated, key }
}

export function computeRelativeNfpBoundary(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>,
  constructionAlgorithm: NfpConstructionAlgorithm
): CoreNfpBoundaryConstructionResult {
  return constructionAlgorithm === 'linear-edge-merge'
    ? computeRelativeNfpBoundaryLinear(fixedPoints, movingPoints)
    : computeRelativeNfpBoundaryReference(fixedPoints, movingPoints)
}

export function canonicalizeTranslatedConvexRing(
  points: ReadonlyArray<InternalPoint>
): CoreNfpBoundaryConstructionResult {
  if (points.length < 3) return failure('polygon must contain at least three vertices.')

  const previousIndexes = points.map((_, index) => (index - 1 + points.length) % points.length)
  const nextIndexes = points.map((_, index) => (index + 1) % points.length)
  const active = points.map(() => true)
  const pendingIndexes = points.map((_, index) => index)
  let activeCount = points.length

  for (let pendingIndex = 0; pendingIndex < pendingIndexes.length; pendingIndex += 1) {
    const currentIndex = pendingIndexes[pendingIndex]
    if (currentIndex === undefined || !active[currentIndex]) continue
    if (activeCount < 3) return failure('polygon must contain at least three vertices.')

    const previousIndex = previousIndexes[currentIndex]
    const nextIndex = nextIndexes[currentIndex]
    if (previousIndex === undefined || nextIndex === undefined) {
      return failure('polygon points must form a closed boundary.')
    }
    const previousPoint = points[previousIndex]
    const currentPoint = points[currentIndex]
    const nextPoint = points[nextIndex]
    if (previousPoint === undefined || currentPoint === undefined || nextPoint === undefined) {
      return failure('polygon points must form a closed boundary.')
    }

    const repeated =
      pointsEqual(previousPoint, currentPoint) || pointsEqual(currentPoint, nextPoint)
    const collinear =
      GeometryPredicates.orientation(previousPoint, currentPoint, nextPoint) === 0 &&
      pointIsBetween(previousPoint, currentPoint, nextPoint)
    if (!repeated && !collinear) continue

    active[currentIndex] = false
    activeCount -= 1
    if (activeCount < 3) return failure('polygon must contain at least three vertices.')
    nextIndexes[previousIndex] = nextIndex
    previousIndexes[nextIndex] = previousIndex
    pendingIndexes.push(previousIndex, nextIndex)
  }

  const firstActiveIndex = active.findIndex((isActive) => isActive)
  if (firstActiveIndex < 0 || activeCount < 3) {
    return failure('polygon must contain at least three vertices.')
  }

  const canonicalPoints: InternalPoint[] = []
  let currentIndex = firstActiveIndex
  do {
    const currentPoint = points[currentIndex]
    if (currentPoint === undefined) {
      return failure('polygon points must form a closed boundary.')
    }
    canonicalPoints.push(currentPoint)
    const nextIndex = nextIndexes[currentIndex]
    if (nextIndex === undefined) return failure('polygon points must form a closed boundary.')
    currentIndex = nextIndex
  } while (currentIndex !== firstActiveIndex)

  if (canonicalPoints.length !== activeCount) {
    return failure('polygon points must form a closed boundary.')
  }

  const validation = ConvexPolygonValidation.validateStrictBoundary(canonicalPoints)
  if ('message' in validation) return failure(validation.message)
  return { points: rotateToStableStart(canonicalPoints) }
}

export function isValidCachedNfpBoundary(value: unknown): value is InternalPolygon {
  if (value === undefined || typeof value !== 'object' || value === null) return false
  if (!('points' in value) || !Array.isArray(value.points) || value.points.length < 3) return false
  if (
    value.points.some(
      (point) =>
        typeof point !== 'object' ||
        point === null ||
        !('x' in point) ||
        !('y' in point) ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
    )
  ) {
    return false
  }
  return !('message' in ConvexPolygonValidation.validateStrictBoundary(value.points))
}

function computeRelativeNfpBoundaryReference(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): CoreNfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if (!inputValidation.ok) return inputValidation

  const negatedMovingPoints = movingPoints.map((point) => ({ x: -point.x, y: -point.y }))
  const minkowskiPoints: InternalPoint[] = []
  for (const fixedPoint of fixedPoints) {
    for (const movingPoint of negatedMovingPoints) {
      const sum = sumPoints(fixedPoint, movingPoint, 'Minkowski sum')
      if ('message' in sum) return sum
      minkowskiPoints.push(sum)
    }
  }

  const boundary = computeConvexHull(minkowskiPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation) return failure(boundaryValidation.message)
  return { points: rotateToStableStart(boundary.points) }
}

function computeRelativeNfpBoundaryLinear(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): CoreNfpBoundaryConstructionResult {
  const inputValidation = validateRelativeNfpInputs(fixedPoints, movingPoints)
  if (!inputValidation.ok) return inputValidation

  const fixedBoundary = counterClockwiseStablePoints(
    fixedPoints,
    inputValidation.fixedWinding
  )
  const negatedMovingPoints = movingPoints.map((point) => ({ x: -point.x, y: -point.y }))
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
    return failure('Minkowski edge merge lost a starting vertex.')
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
        return failure('Minkowski edge merge lost an edge direction.')
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
      return failure('Minkowski edge merge lost a polygon vertex.')
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
      return { points: rotateToStableStart(counterClockwisePoints) }
    }
  }

  const boundary = computeConvexHull(boundaryPoints)
  const boundaryValidation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  if ('message' in boundaryValidation) return failure(boundaryValidation.message)
  const counterClockwisePoints =
    boundaryValidation.winding === 1 ? boundary.points : [...boundary.points].reverse()
  return { points: rotateToStableStart(counterClockwisePoints) }
}

interface ValidatedRelativeNfpInputs {
  readonly ok: true
  readonly fixedWinding: ConvexPolygonWinding
  readonly movingWinding: ConvexPolygonWinding
}

function validateRelativeNfpInputs(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): ValidatedRelativeNfpInputs | CoreNfpFailure {
  const fixedFiniteMessage = finitePointsMessage(fixedPoints)
  if (fixedFiniteMessage !== undefined) return failure(fixedFiniteMessage)
  const movingFiniteMessage = finitePointsMessage(movingPoints)
  if (movingFiniteMessage !== undefined) return failure(movingFiniteMessage)

  const fixedValidation = ConvexPolygonValidation.validateStrictBoundary(fixedPoints)
  if ('message' in fixedValidation) return failure(fixedValidation.message)
  const movingValidation = ConvexPolygonValidation.validateStrictBoundary(movingPoints)
  if ('message' in movingValidation) return failure(movingValidation.message)
  return {
    ok: true,
    fixedWinding: fixedValidation.winding,
    movingWinding: movingValidation.winding
  }
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
): ReadonlyArray<InternalPoint> | CoreNfpFailure {
  const vectors: InternalPoint[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) {
      return failure('Minkowski edge merge lost a polygon edge.')
    }
    const x = end.x - start.x
    const y = end.y - start.y
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failure('Minkowski edge arithmetic must produce finite vectors.')
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
): InternalPoint | CoreNfpFailure {
  const x = firstPoint.x + secondPoint.x
  const y = firstPoint.y + secondPoint.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return failure(`${operation} must produce finite coordinates.`)
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

function translateNfpBoundary(
  input: CoreNfpInput,
  relativeBoundary: InternalPolygon
): CoreNfpBoundaryConstructionResult {
  const translatedPoints: InternalPoint[] = []
  for (const point of relativeBoundary.points) {
    const x = point.x + input.fixed.placement.transform.translateX
    const y = point.y + input.fixed.placement.transform.translateY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failure('fixed translation must produce finite coordinates.')
    }
    translatedPoints.push({ x, y })
  }

  const translatedBoundary = canonicalizeTranslatedConvexRing(translatedPoints)
  if (!('message' in translatedBoundary)) return translatedBoundary
  return canonicalizeTranslatedConvexRingWithHullFallback(translatedPoints)
}

function canonicalizeTranslatedConvexRingWithHullFallback(
  points: ReadonlyArray<InternalPoint>
): CoreNfpBoundaryConstructionResult {
  const boundary = computeConvexHull(points)
  const validation = ConvexPolygonValidation.validateStrictBoundary(boundary.points)
  return 'message' in validation
    ? failure(validation.message)
    : { points: rotateToStableStart(boundary.points) }
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

function failure(message: string): CoreNfpFailure {
  return { ok: false, message }
}
