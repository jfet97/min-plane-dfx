import type { Path64 } from 'clipper2-ts'
import { canonicalGridCrossSign, type CanonicalGridPoint } from './canonicalGridMath.js'

/** Exact-grid contact metrics for canonical collision paths. */
export interface CanonicalGridBoundaryContact {
  readonly lengthMm: number
  readonly normalizedUnits: number
  readonly nearCompleteStructuralContactCount: number
  readonly nearCompleteStructuralContactSignatures: ReadonlyArray<string>
}

export type CanonicalGridBoundaryOverlapAxisUnitsResult =
  | { readonly kind: 'measured'; readonly score: bigint }
  | { readonly kind: 'undecidable' }
  | { readonly kind: 'aborted' }

interface CanonicalGridEdge {
  readonly start: CanonicalGridPoint
  readonly end: CanonicalGridPoint
  readonly startIndex: number
}

interface CanonicalGridBoundarySegment {
  readonly lengthMm: number
}

const MIN_STRUCTURAL_EDGE_LENGTH_RATIO = 0.5
const MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO = 0.95
const STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE = 1_000
const STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE = 1_000

/**
 * Tests positive shared boundary using integer-grid collinearity and overlap.
 * This is deliberately separate from source-geometry contact, whose floating
 * robust-predicate path remains authoritative before canonicalization.
 */
export function hasPositiveCanonicalGridBoundaryContact(
  first: Path64,
  second: Path64
): boolean | undefined {
  const firstEdges = canonicalGridPathEdges(first)
  const secondEdges = canonicalGridPathEdges(second)
  if (firstEdges === undefined || secondEdges === undefined) return undefined
  for (const firstEdge of firstEdges) {
    for (const secondEdge of secondEdges) {
      const overlap = canonicalGridCollinearOverlap(firstEdge, secondEdge)
      if (overlap === undefined) return undefined
      if (overlap.lengthMm > 0) return true
    }
  }
  return false
}

/**
 * Measures canonical contact after snapping, without projecting absolute grid
 * coordinates back to floating millimetres for contact classification.
 */
export function measureCanonicalGridBoundaryContact(
  first: Path64,
  second: Path64
): CanonicalGridBoundaryContact | undefined {
  const firstEdges = canonicalGridPathEdges(first)
  const secondEdges = canonicalGridPathEdges(second)
  if (firstEdges === undefined || secondEdges === undefined) return undefined

  const segments: CanonicalGridBoundarySegment[] = []
  for (const firstEdge of firstEdges) {
    for (const secondEdge of secondEdges) {
      const overlap = canonicalGridCollinearOverlap(firstEdge, secondEdge)
      if (overlap === undefined) return undefined
      if (overlap.lengthMm > 0) {
        segments.push({ lengthMm: overlap.lengthMm })
      }
    }
  }

  const lengthMm = segments.reduce((sum, segment) => sum + segment.lengthMm, 0)
  if (!Number.isFinite(lengthMm) || lengthMm < 0) return undefined
  if (lengthMm === 0) {
    return {
      lengthMm: 0,
      normalizedUnits: 0,
      nearCompleteStructuralContactCount: 0,
      nearCompleteStructuralContactSignatures: []
    }
  }

  const firstLongestEdgeMm = longestCanonicalGridEdgeLength(firstEdges)
  const secondLongestEdgeMm = longestCanonicalGridEdgeLength(secondEdges)
  if (firstLongestEdgeMm === undefined || secondLongestEdgeMm === undefined) return undefined
  const normalizationLengthMm = Math.min(firstLongestEdgeMm, secondLongestEdgeMm)
  const normalizedUnits = lengthMm / normalizationLengthMm
  if (!Number.isFinite(normalizedUnits) || normalizedUnits < 0) return undefined

  const nearCompleteStructuralContactSignatures =
    deriveNearCompleteStructuralContactSignatures(
      firstEdges,
      secondEdges,
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
  firstEdges: ReadonlyArray<CanonicalGridEdge>,
  secondEdges: ReadonlyArray<CanonicalGridEdge>,
  firstLongestEdgeMm: number,
  secondLongestEdgeMm: number
): ReadonlyArray<string> | undefined {
  const signatures: string[] = []
  for (const firstEdge of firstEdges) {
    const firstEdgeLengthMm = canonicalGridEdgeLengthMm(firstEdge)
    if (firstEdgeLengthMm === undefined) return undefined
    if (firstEdgeLengthMm < firstLongestEdgeMm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO) continue

    for (const secondEdge of secondEdges) {
      const secondEdgeLengthMm = canonicalGridEdgeLengthMm(secondEdge)
      if (secondEdgeLengthMm === undefined) return undefined
      if (secondEdgeLengthMm < secondLongestEdgeMm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO) continue

      const overlap = canonicalGridCollinearOverlap(firstEdge, secondEdge)
      if (overlap === undefined) return undefined
      const shorterEdgeLengthMm = Math.min(firstEdgeLengthMm, secondEdgeLengthMm)
      if (overlap.lengthMm >= shorterEdgeLengthMm * MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO) {
        const signature = structuralContactSignature(
          firstEdge,
          secondEdge,
          firstEdges,
          secondEdges,
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
  firstEdge: CanonicalGridEdge,
  secondEdge: CanonicalGridEdge,
  firstEdges: ReadonlyArray<CanonicalGridEdge>,
  secondEdges: ReadonlyArray<CanonicalGridEdge>,
  firstLongestEdgeMm: number,
  secondLongestEdgeMm: number
): string | undefined {
  const firstDescriptor = structuralEdgeDescriptor(firstEdge, firstEdges, firstLongestEdgeMm)
  const secondDescriptor = structuralEdgeDescriptor(secondEdge, secondEdges, secondLongestEdgeMm)
  if (firstDescriptor === undefined || secondDescriptor === undefined) return undefined
  return firstDescriptor <= secondDescriptor
    ? `${firstDescriptor}|${secondDescriptor}`
    : `${secondDescriptor}|${firstDescriptor}`
}

function structuralEdgeDescriptor(
  edge: CanonicalGridEdge,
  edges: ReadonlyArray<CanonicalGridEdge>,
  longestEdgeMm: number
): string | undefined {
  const previous = edges[(edge.startIndex - 1 + edges.length) % edges.length]
  const next = edges[(edge.startIndex + 1) % edges.length]
  if (previous === undefined || next === undefined) return undefined
  const edgeLengthMm = canonicalGridEdgeLengthMm(edge)
  const previousLengthMm = canonicalGridEdgeLengthMm(previous)
  const nextLengthMm = canonicalGridEdgeLengthMm(next)
  const startTurnCosine = turnCosine(previous.start, edge.start, edge.end)
  const endTurnCosine = turnCosine(edge.start, edge.end, next.end)
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

function canonicalGridPathEdges(
  path: ReadonlyArray<CanonicalGridPoint>,
  checkpoint: (() => boolean) | undefined = undefined
): ReadonlyArray<CanonicalGridEdge> | undefined {
  if (path.length < 3) return undefined
  const edges: CanonicalGridEdge[] = []
  for (let index = 0; index < path.length; index += 1) {
    if (checkpoint?.() === false) return undefined
    const start = path[index]
    const end = path[(index + 1) % path.length]
    if (
      start === undefined ||
      end === undefined ||
      !Number.isSafeInteger(start.x) ||
      !Number.isSafeInteger(start.y) ||
      !Number.isSafeInteger(end.x) ||
      !Number.isSafeInteger(end.y) ||
      (start.x === end.x && start.y === end.y)
    ) {
      return undefined
    }
    edges.push({ start, end, startIndex: index })
  }
  return edges
}

function canonicalGridCollinearOverlap(
  first: CanonicalGridEdge,
  second: CanonicalGridEdge
): { readonly lengthMm: number } | undefined {
  const axisUnits = canonicalGridCollinearOverlapAxisUnits(first, second)
  if (axisUnits === undefined || axisUnits <= 0n) {
    return axisUnits === undefined ? undefined : { lengthMm: 0 }
  }

  const dx = BigInt(first.end.x) - BigInt(first.start.x)
  const dy = BigInt(first.end.y) - BigInt(first.start.y)
  const useX = absoluteBigInt(dx) >= absoluteBigInt(dy)
  const firstAxisLength = absoluteBigInt(
    (useX ? BigInt(first.end.x) : BigInt(first.end.y)) -
      (useX ? BigInt(first.start.x) : BigInt(first.start.y))
  )
  const edgeLengthMm = canonicalGridEdgeLengthMm(first)
  const overlapAxisLength = Number(axisUnits)
  const axisLength = Number(firstAxisLength)
  if (
    edgeLengthMm === undefined ||
    !Number.isSafeInteger(overlapAxisLength) ||
    !Number.isSafeInteger(axisLength) ||
    axisLength <= 0
  ) {
    return undefined
  }
  const lengthMm = (overlapAxisLength * edgeLengthMm) / axisLength
  return Number.isFinite(lengthMm) && lengthMm > 0 ? { lengthMm } : undefined
}

/*
 * Exact axis-projected overlap of two collinear grid edges in canonical grid
 * units, or zero when the edges are collinear but disjoint. Not a Euclidean
 * length: an exact BigInt ordering surrogate shared by every consumer that
 * must compare contact strength without floating-point rounding.
 */
function canonicalGridCollinearOverlapAxisUnits(
  first: CanonicalGridEdge,
  second: CanonicalGridEdge
): bigint | undefined {
  const secondStartCross = canonicalGridCrossSign(first.start, first.end, second.start)
  const secondEndCross = canonicalGridCrossSign(first.start, first.end, second.end)
  if (secondStartCross === undefined || secondEndCross === undefined) return undefined
  if (secondStartCross !== 0 || secondEndCross !== 0) return 0n

  const dx = BigInt(first.end.x) - BigInt(first.start.x)
  const dy = BigInt(first.end.y) - BigInt(first.start.y)
  const useX = absoluteBigInt(dx) >= absoluteBigInt(dy)
  const firstStart = useX ? BigInt(first.start.x) : BigInt(first.start.y)
  const firstEnd = useX ? BigInt(first.end.x) : BigInt(first.end.y)
  const secondStart = useX ? BigInt(second.start.x) : BigInt(second.start.y)
  const secondEnd = useX ? BigInt(second.end.x) : BigInt(second.end.y)
  const overlappingAxisLength =
    minimumBigInt(maximumBigInt(firstStart, firstEnd), maximumBigInt(secondStart, secondEnd)) -
    maximumBigInt(minimumBigInt(firstStart, firstEnd), minimumBigInt(secondStart, secondEnd))
  return overlappingAxisLength > 0n ? overlappingAxisLength : 0n
}

/**
 * Sums exact overlap units for positive axis-aligned contacts between two
 * canonical grid paths. A positive diagonal contact makes the result
 * undecidable because dominant-axis projection is not comparable across
 * orientations. The optional checkpoint covers path construction and every
 * edge-pair comparison.
 */
export function measureCanonicalGridBoundaryOverlapAxisUnits(
  first: ReadonlyArray<CanonicalGridPoint>,
  second: ReadonlyArray<CanonicalGridPoint>,
  checkpoint: (() => boolean) | undefined = undefined
): CanonicalGridBoundaryOverlapAxisUnitsResult {
  let aborted = false
  const checked = (): boolean => {
    if (checkpoint === undefined || checkpoint()) return true
    aborted = true
    return false
  }
  const firstEdges = canonicalGridPathEdges(first, checked)
  if (firstEdges === undefined) {
    return { kind: aborted ? 'aborted' : 'undecidable' }
  }
  const secondEdges = canonicalGridPathEdges(second, checked)
  if (secondEdges === undefined) {
    return { kind: aborted ? 'aborted' : 'undecidable' }
  }
  let total = 0n
  for (const firstEdge of firstEdges) {
    if (!checked()) return { kind: 'aborted' }
    for (const secondEdge of secondEdges) {
      if (!checked()) return { kind: 'aborted' }
      const axisUnits = canonicalGridCollinearOverlapAxisUnits(firstEdge, secondEdge)
      if (axisUnits === undefined) return { kind: 'undecidable' }
      if (axisUnits > 0n) {
        const dx = BigInt(firstEdge.end.x) - BigInt(firstEdge.start.x)
        const dy = BigInt(firstEdge.end.y) - BigInt(firstEdge.start.y)
        if (dx !== 0n && dy !== 0n) return { kind: 'undecidable' }
      }
      total += axisUnits
    }
  }
  return { kind: 'measured', score: total }
}

function longestCanonicalGridEdgeLength(edges: ReadonlyArray<CanonicalGridEdge>): number | undefined {
  let longestEdgeLengthMm = 0
  for (const edge of edges) {
    const edgeLengthMm = canonicalGridEdgeLengthMm(edge)
    if (edgeLengthMm === undefined) return undefined
    longestEdgeLengthMm = Math.max(longestEdgeLengthMm, edgeLengthMm)
  }
  return longestEdgeLengthMm > 0 ? longestEdgeLengthMm : undefined
}

function canonicalGridEdgeLengthMm(edge: CanonicalGridEdge): number | undefined {
  const dx = edge.end.x - edge.start.x
  const dy = edge.end.y - edge.start.y
  const lengthMm = Math.hypot(dx, dy) / 1_000
  return Number.isFinite(lengthMm) && lengthMm > 0 ? lengthMm : undefined
}

function turnCosine(
  previous: CanonicalGridPoint,
  vertex: CanonicalGridPoint,
  next: CanonicalGridPoint
): number | undefined {
  const previousX = previous.x - vertex.x
  const previousY = previous.y - vertex.y
  const nextX = next.x - vertex.x
  const nextY = next.y - vertex.y
  const denominator = Math.hypot(previousX, previousY) * Math.hypot(nextX, nextY)
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined
  const cosine = (previousX * nextX + previousY * nextY) / denominator
  return Number.isFinite(cosine) ? Math.max(-1, Math.min(1, cosine)) : undefined
}

function ratioSignatureKey(value: number, longestEdgeMm: number): number | undefined {
  const key = Math.round((value / longestEdgeMm) * STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE)
  return Number.isSafeInteger(key) ? key : undefined
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

function minimumBigInt(first: bigint, second: bigint): bigint {
  return first < second ? first : second
}

function maximumBigInt(first: bigint, second: bigint): bigint {
  return first > second ? first : second
}
