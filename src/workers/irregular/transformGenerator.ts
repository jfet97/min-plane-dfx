import { Effect, Exit, Layer, Schema } from 'effect'
import type {
  IrregularPoint,
  IrregularTransformCandidate,
  IrregularTransformReason
} from '@shared/irregular/domain.js'
import { IrregularTransformCandidate as IrregularTransformCandidateSchema } from '@shared/irregular/domain.js'
import {
  GenerateTransformsInput,
  IrregularGeometryInputError,
  TransformGenerator
} from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'

const FULL_TURN_DEGREES = 360
const DEGREES_PER_RADIAN = 180 / Math.PI

type AngleReason = IrregularTransformReason

interface AngleCandidate {
  readonly rotationDeg: number
  readonly reason: AngleReason
}

interface UsableEdge {
  readonly start: IrregularPoint
  readonly end: IrregularPoint
  readonly length: number
  readonly rotationDeg: number
}

interface GeometryFailure {
  readonly message: string
}

/**
 * Effect layer providing deterministic finite transform choices for one
 * strictly convex collision polygon. The service returns transform metadata
 * only; it does not rotate polygons, place pieces, or score layouts.
 */
export const TransformGeneratorLive = Layer.succeed(TransformGenerator, {
  generateTransforms
})

/**
 * Generates the finite transform set for a prepared collision polygon.
 *
 * Every usable directed edge contributes the rotation by the negative of its
 * direction angle, which makes that edge horizontal. The longest usable edge contributes one bounded
 * oriented-bounds choice as the same rotation; this deliberately avoids an
 * unbounded principal-component analysis. Candidates are canonicalized to one
 * turn, deduplicated by circular angular distance, then mirrored and capped
 * in that order so the result is reproducible.
 */
function generateTransforms(
  input: GenerateTransformsInput
): Effect.Effect<ReadonlyArray<IrregularTransformCandidate>, IrregularGeometryInputError> {
  return decodeInput(input).pipe(
    Effect.flatMap((decoded) => {
      const boundary = decoded.geometry.collisionPolygon.points
      const validation = ConvexPolygonValidation.validateStrictBoundary(boundary)
      if ('message' in validation) {
        return failInvalidGeometry('generateTransforms', validation.message)
      }

      const usableEdges = deriveUsableEdges(boundary, decoded.settings.transformMinimumEdgeLengthMm)
      if ('message' in usableEdges) {
        return failInvalidGeometry('generateTransforms', usableEdges.message)
      }

      const longestEdge = findLongestEdge(usableEdges.value)

      const candidates = deduplicateAngles(
        [
          { rotationDeg: 0, reason: 'orthogonal' },
          { rotationDeg: 90, reason: 'orthogonal' },
          { rotationDeg: 180, reason: 'orthogonal' },
          { rotationDeg: 270, reason: 'orthogonal' },
          ...decoded.settings.configuredRotationDeg.map((rotationDeg) => ({
            rotationDeg,
            reason: 'configured' as const
          })),
          ...usableEdges.value.map(({ rotationDeg }) => ({
            rotationDeg,
            reason: 'edge_alignment' as const
          })),
          ...(longestEdge === undefined
            ? []
            : [
                {
                  rotationDeg: longestEdge.rotationDeg,
                  reason: 'oriented_bounds' as const
                }
              ])
        ],
        decoded.settings.transformAngleDeduplicationToleranceDeg
      )
      if ('message' in candidates) {
        return failInvalidGeometry('generateTransforms', candidates.message)
      }

      const unmirrored = candidates.value.map(({ rotationDeg, reason }) => ({
        rotationDeg,
        reason,
        mirrored: false
      }))
      const allCandidates = decoded.allowMirror
        ? [...unmirrored, ...unmirrored.map((candidate) => ({ ...candidate, mirrored: true }))]
        : unmirrored

      return Effect.succeed(
        allCandidates.slice(0, decoded.settings.transformCap).map(
          (candidate, index) =>
            new IrregularTransformCandidateSchema({
              index,
              rotationDeg: candidate.rotationDeg,
              mirrored: candidate.mirrored,
              reason: candidate.reason
            })
        )
      )
    })
  )
}

function decodeInput(
  input: GenerateTransformsInput
): Effect.Effect<GenerateTransformsInput, IrregularGeometryInputError> {
  const decoded = Schema.decodeUnknownExit(GenerateTransformsInput)(input)
  if (Exit.isFailure(decoded)) {
    return failInvalidGeometry('generateTransforms', 'transform input must satisfy its schema.')
  }

  return Effect.succeed(decoded.value)
}

function deriveUsableEdges(
  points: ReadonlyArray<IrregularPoint>,
  minimumLength: number
): { readonly value: ReadonlyArray<UsableEdge> } | GeometryFailure {
  const usableEdges: UsableEdge[] = []

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }

    const deltaX = end.x - start.x
    const deltaY = end.y - start.y
    const length = Math.hypot(deltaX, deltaY)
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || !Number.isFinite(length)) {
      return { message: 'derived polygon edge length must be finite.' }
    }

    const directionDeg = Math.atan2(deltaY, deltaX) * DEGREES_PER_RADIAN
    const rotationDeg = normalizeRotationDeg(-directionDeg)
    if (rotationDeg === undefined) {
      return { message: 'derived polygon edge rotation must be finite.' }
    }

    if (length >= minimumLength) {
      usableEdges.push({ start, end, length, rotationDeg })
    }
  }

  return { value: usableEdges }
}

function findLongestEdge(edges: ReadonlyArray<UsableEdge>): UsableEdge | undefined {
  let longest: UsableEdge | undefined
  for (const edge of edges) {
    if (
      longest === undefined ||
      edge.length > longest.length ||
      (edge.length === longest.length && compareEdges(edge, longest) < 0)
    ) {
      longest = edge
    }
  }
  return longest
}

function compareEdges(first: UsableEdge, second: UsableEdge): number {
  const startComparison = comparePoints(first.start, second.start)
  if (startComparison !== 0) return startComparison
  return comparePoints(first.end, second.end)
}

function comparePoints(first: IrregularPoint, second: IrregularPoint): number {
  if (first.x < second.x) return -1
  if (first.x > second.x) return 1
  if (first.y < second.y) return -1
  if (first.y > second.y) return 1
  return 0
}

function deduplicateAngles(
  rawCandidates: ReadonlyArray<AngleCandidate>,
  toleranceDeg: number
): { readonly value: ReadonlyArray<AngleCandidate> } | GeometryFailure {
  const normalized: AngleCandidate[] = []
  for (const candidate of rawCandidates) {
    const rotationDeg = normalizeRotationDeg(candidate.rotationDeg)
    if (rotationDeg === undefined) {
      return { message: 'derived transform rotation must be finite.' }
    }
    normalized.push({ rotationDeg, reason: candidate.reason })
  }

  normalized.sort((first, second) => {
    const priorityComparison = reasonPriority(first.reason) - reasonPriority(second.reason)
    if (priorityComparison !== 0) return priorityComparison
    return first.rotationDeg - second.rotationDeg
  })

  const retained: AngleCandidate[] = []
  for (const candidate of normalized) {
    if (
      retained.some(
        (existing) =>
          circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
      )
    ) {
      continue
    }
    retained.push(candidate)
  }

  retained.sort((first, second) => first.rotationDeg - second.rotationDeg)
  return { value: retained }
}

function reasonPriority(reason: AngleReason): number {
  switch (reason) {
    case 'orthogonal':
      return 0
    case 'configured':
      return 1
    case 'edge_alignment':
      return 2
    case 'oriented_bounds':
      return 3
  }
}

function circularDistanceDeg(first: number, second: number): number {
  const absoluteDistance = Math.abs(first - second)
  return Math.min(absoluteDistance, FULL_TURN_DEGREES - absoluteDistance)
}

function normalizeRotationDeg(rotationDeg: number): number | undefined {
  if (!Number.isFinite(rotationDeg)) return undefined

  const remainder = rotationDeg % FULL_TURN_DEGREES
  const normalized = remainder < 0 ? remainder + FULL_TURN_DEGREES : remainder
  return Object.is(normalized, -0) ? 0 : normalized
}

function failInvalidGeometry(
  operation: string,
  message: string
): Effect.Effect<never, IrregularGeometryInputError> {
  return Effect.fail(new IrregularGeometryInputError({ operation, message }))
}
