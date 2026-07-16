import type { InternalPoint, InternalPolygonWithBounds } from './internalGeometry.js'
import { areDisjoint } from './convexBounds.js'
import { GeometryPredicates } from './geometryPredicates.js'

/** Exact contact length plus a scale-normalized amount for whole-layout scoring. */
export interface SharedConvexPolygonBoundaryContact {
  readonly lengthMm: number
  readonly normalizedUnits: number
  readonly nearCompleteStructuralContactCount: number
  readonly nearCompleteStructuralContactSignatures: ReadonlyArray<string>
}

const MIN_STRUCTURAL_EDGE_LENGTH_RATIO = 0.5
const MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO = 0.95
const STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE = 1_000
const STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE = 1_000

/** Measures exact shared boundary length between two already-translated convex polygons. */
export function sharedConvexPolygonBoundaryLength(
  first: InternalPolygonWithBounds,
  second: InternalPolygonWithBounds
): number | undefined {
  if (areDisjoint(first.bounds, second.bounds)) return 0

  let totalLength = 0
  for (const firstEdge of polygonEdges(first.polygon.points)) {
    for (const secondEdge of polygonEdges(second.polygon.points)) {
      const overlapLength = collinearOverlapLength(firstEdge, secondEdge)
      if (overlapLength === undefined) return undefined
      totalLength += overlapLength
      if (!Number.isFinite(totalLength)) return undefined
    }
  }
  return totalLength
}

/**
 * Measures shared boundary relative to the smaller polygon's longest edge.
 * One unit therefore represents contact comparable to one structural edge,
 * while short offset chamfers contribute only a small fraction of one unit.
 */
export function measureSharedConvexPolygonBoundaryContact(
  first: InternalPolygonWithBounds,
  second: InternalPolygonWithBounds
): SharedConvexPolygonBoundaryContact | undefined {
  const lengthMm = sharedConvexPolygonBoundaryLength(first, second)
  if (lengthMm === undefined) return undefined
  if (lengthMm === 0) {
    return {
      lengthMm: 0,
      normalizedUnits: 0,
      nearCompleteStructuralContactCount: 0,
      nearCompleteStructuralContactSignatures: []
    }
  }

  const firstLongestEdgeMm = longestPolygonEdgeLength(first.polygon.points)
  const secondLongestEdgeMm = longestPolygonEdgeLength(second.polygon.points)
  if (firstLongestEdgeMm === undefined || secondLongestEdgeMm === undefined) return undefined

  const normalizationLengthMm = Math.min(firstLongestEdgeMm, secondLongestEdgeMm)
  const normalizedUnits = lengthMm / normalizationLengthMm
  if (!Number.isFinite(normalizedUnits) || normalizedUnits < 0) return undefined
  const nearCompleteStructuralContactSignatures = deriveNearCompleteStructuralContactSignatures(
    first.polygon.points,
    second.polygon.points,
    firstLongestEdgeMm,
    secondLongestEdgeMm
  )
  if (nearCompleteStructuralContactSignatures === undefined) return undefined
  return {
    lengthMm,
    normalizedUnits,
    nearCompleteStructuralContactCount: nearCompleteStructuralContactSignatures.length,
    nearCompleteStructuralContactSignatures
  }
}

function deriveNearCompleteStructuralContactSignatures(
  firstPoints: ReadonlyArray<InternalPoint>,
  secondPoints: ReadonlyArray<InternalPoint>,
  firstLongestEdgeMm: number,
  secondLongestEdgeMm: number
): ReadonlyArray<string> | undefined {
  const signatures: string[] = []
  for (const firstEdge of polygonEdges(firstPoints)) {
    const firstEdgeLengthMm = polygonEdgeLength(firstEdge)
    if (firstEdgeLengthMm === undefined) return undefined
    if (firstEdgeLengthMm < firstLongestEdgeMm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO) continue

    for (const secondEdge of polygonEdges(secondPoints)) {
      const secondEdgeLengthMm = polygonEdgeLength(secondEdge)
      if (secondEdgeLengthMm === undefined) return undefined
      if (secondEdgeLengthMm < secondLongestEdgeMm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO) continue

      const overlapLengthMm = collinearOverlapLength(firstEdge, secondEdge)
      if (overlapLengthMm === undefined) return undefined
      const shorterEdgeLengthMm = Math.min(firstEdgeLengthMm, secondEdgeLengthMm)
      if (overlapLengthMm >= shorterEdgeLengthMm * MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO) {
        const signature = structuralContactSignature(
          firstEdge,
          secondEdge,
          firstPoints,
          secondPoints,
          firstLongestEdgeMm,
          secondLongestEdgeMm
        )
        if (signature === undefined) return undefined
        signatures.push(signature)
      }
    }
  }
  return signatures
}

function structuralContactSignature(
  firstEdge: PolygonEdge,
  secondEdge: PolygonEdge,
  firstPoints: ReadonlyArray<InternalPoint>,
  secondPoints: ReadonlyArray<InternalPoint>,
  firstLongestEdgeMm: number,
  secondLongestEdgeMm: number
): string | undefined {
  const firstDescriptor = structuralEdgeDescriptor(
    firstEdge,
    firstPoints,
    firstLongestEdgeMm
  )
  const secondDescriptor = structuralEdgeDescriptor(
    secondEdge,
    secondPoints,
    secondLongestEdgeMm
  )
  if (firstDescriptor === undefined || secondDescriptor === undefined) return undefined

  return firstDescriptor <= secondDescriptor
    ? `${firstDescriptor}|${secondDescriptor}`
    : `${secondDescriptor}|${firstDescriptor}`
}

function structuralEdgeDescriptor(
  edge: PolygonEdge,
  points: ReadonlyArray<InternalPoint>,
  longestEdgeMm: number
): string | undefined {
  const previousPoint = points[(edge.startIndex - 1 + points.length) % points.length]
  const nextPoint = points[(edge.startIndex + 2) % points.length]
  if (previousPoint === undefined || nextPoint === undefined) return undefined

  const edgeLengthMm = polygonEdgeLength(edge)
  const previousLengthMm = pointDistance(previousPoint, edge.start)
  const nextLengthMm = pointDistance(edge.end, nextPoint)
  const startTurnCosine = turnCosine(previousPoint, edge.start, edge.end)
  const endTurnCosine = turnCosine(edge.start, edge.end, nextPoint)
  if (
    edgeLengthMm === undefined ||
    previousLengthMm === undefined ||
    nextLengthMm === undefined ||
    startTurnCosine === undefined ||
    endTurnCosine === undefined
  ) {
    return undefined
  }

  const edgeRatioKey = ratioSignatureKey(edgeLengthMm, longestEdgeMm)
  const previousRatioKey = ratioSignatureKey(previousLengthMm, longestEdgeMm)
  const nextRatioKey = ratioSignatureKey(nextLengthMm, longestEdgeMm)
  const startTurnKey = Math.round(startTurnCosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE)
  const endTurnKey = Math.round(endTurnCosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE)
  if (
    edgeRatioKey === undefined ||
    previousRatioKey === undefined ||
    nextRatioKey === undefined ||
    !Number.isSafeInteger(startTurnKey) ||
    !Number.isSafeInteger(endTurnKey)
  ) {
    return undefined
  }

  const firstEndpoint = `${previousRatioKey}:${startTurnKey}`
  const secondEndpoint = `${nextRatioKey}:${endTurnKey}`
  const endpointPair =
    firstEndpoint <= secondEndpoint
      ? `${firstEndpoint}:${secondEndpoint}`
      : `${secondEndpoint}:${firstEndpoint}`
  return `${edgeRatioKey}:${endpointPair}`
}

function ratioSignatureKey(value: number, longestEdgeMm: number): number | undefined {
  const key = Math.round((value / longestEdgeMm) * STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE)
  return Number.isSafeInteger(key) ? key : undefined
}

function pointDistance(first: InternalPoint, second: InternalPoint): number | undefined {
  const distance = Math.hypot(second.x - first.x, second.y - first.y)
  return Number.isFinite(distance) && distance > 0 ? distance : undefined
}

function turnCosine(
  previous: InternalPoint,
  vertex: InternalPoint,
  next: InternalPoint
): number | undefined {
  const previousX = previous.x - vertex.x
  const previousY = previous.y - vertex.y
  const nextX = next.x - vertex.x
  const nextY = next.y - vertex.y
  const previousLength = Math.hypot(previousX, previousY)
  const nextLength = Math.hypot(nextX, nextY)
  const denominator = previousLength * nextLength
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined

  const cosine = (previousX * nextX + previousY * nextY) / denominator
  return Number.isFinite(cosine) ? Math.max(-1, Math.min(1, cosine)) : undefined
}

interface PolygonEdge {
  readonly start: InternalPoint
  readonly end: InternalPoint
  readonly startIndex: number
}

function polygonEdges(points: ReadonlyArray<InternalPoint>): ReadonlyArray<PolygonEdge> {
  const edges: PolygonEdge[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) return []
    edges.push({ start, end, startIndex: index })
  }
  return edges
}

function longestPolygonEdgeLength(points: ReadonlyArray<InternalPoint>): number | undefined {
  let longestEdgeLength = 0
  for (const edge of polygonEdges(points)) {
    const edgeLength = polygonEdgeLength(edge)
    if (edgeLength === undefined) return undefined
    longestEdgeLength = Math.max(longestEdgeLength, edgeLength)
  }
  return longestEdgeLength > 0 ? longestEdgeLength : undefined
}

function polygonEdgeLength(edge: PolygonEdge): number | undefined {
  const edgeLength = Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y)
  return Number.isFinite(edgeLength) && edgeLength > 0 ? edgeLength : undefined
}

function collinearOverlapLength(first: PolygonEdge, second: PolygonEdge): number | undefined {
  if (
    GeometryPredicates.orientation(first.start, first.end, second.start) !== 0 ||
    GeometryPredicates.orientation(first.start, first.end, second.end) !== 0
  ) {
    return 0
  }

  const dx = first.end.x - first.start.x
  const dy = first.end.y - first.start.y
  const edgeLength = Math.hypot(dx, dy)
  if (!Number.isFinite(edgeLength) || edgeLength <= 0) return undefined

  const useX = Math.abs(dx) >= Math.abs(dy)
  const firstStart = useX ? first.start.x : first.start.y
  const firstEnd = useX ? first.end.x : first.end.y
  const secondStart = useX ? second.start.x : second.start.y
  const secondEnd = useX ? second.end.x : second.end.y
  const overlappingAxisLength =
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd)) -
    Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd))
  if (!Number.isFinite(overlappingAxisLength) || overlappingAxisLength <= 0) return 0

  const firstAxisLength = Math.abs(firstEnd - firstStart)
  if (!Number.isFinite(firstAxisLength) || firstAxisLength <= 0) return undefined
  const overlapLength = (overlappingAxisLength * edgeLength) / firstAxisLength
  return Number.isFinite(overlapLength) ? overlapLength : undefined
}
