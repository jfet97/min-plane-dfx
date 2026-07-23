import { Effect, Exit, Layer, Schema } from 'effect'
import type {
  IrregularPoint,
  IrregularTransformCandidate,
  IrregularTransformReason
} from '@shared/irregular/domain.js'
import { IrregularTransformCandidate as IrregularTransformCandidateSchema } from '@shared/irregular/domain.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'
import {
  GenerateTransformsInput,
  IrregularGeometryInputError,
  TransformGenerator
} from './services.js'
import { ConvexPolygonValidation } from './convexPolygonValidation.js'

const FULL_TURN_DEGREES = 360
const DEGREES_PER_RADIAN = 180 / Math.PI
const COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG = 0.051
const COMPACT_EDGE_SAG_MULTIPLIER = 4
const COMPACT_EDGE_SMALLER_DIMENSION_RATIO = 0.01

type AngleReason = IrregularTransformReason

interface AngleCandidate {
  readonly rotationDeg: number
  readonly reason: AngleReason
  readonly edgeLengthMm: number
  readonly sourceOrdinal: number
}

interface UsableEdge {
  readonly rotationDeg: number
  readonly lengthMm: number
  readonly sourceOrdinal: number
}

interface GeometryFailure {
  readonly message: string
}

interface EffectiveTransformPolicy {
  readonly minimumEdgeLengthMm: number
  readonly angleDeduplicationToleranceDeg: number
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
 * direction angle, which makes that edge horizontal. For a convex polygon,
 * minimum-area oriented bounding boxes have a side parallel to one of those
 * edges, so the complete edge-alignment set already contains every OBB
 * orientation; there is no separate redundant `oriented_bounds` source.
 *
 * Orthogonal choices are the baseline priority, followed by geometry-derived
 * edge angles, followed by configured angles. When mirroring is enabled and the
 * cap is larger than the baseline, extra choices are taken as mirrored and
 * unmirrored pairs in that priority order, then mirrored baseline choices. This
 * reserves mirror capacity while keeping exact source-edge alignments ahead of
 * manually supplied approximations. Candidate indexes are assigned only after capping.
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

      const effectivePolicy = deriveEffectiveTransformPolicy(decoded, boundary)
      if ('message' in effectivePolicy) {
        return failInvalidGeometry('generateTransforms', effectivePolicy.message)
      }

      const usableEdges = deriveUsableEdges(
        boundary,
        effectivePolicy.value.minimumEdgeLengthMm
      )
      if ('message' in usableEdges) {
        return failInvalidGeometry('generateTransforms', usableEdges.message)
      }

      const candidates = deduplicateAngles(
        transformAngleCandidates(decoded.allowRotation, decoded.settings, usableEdges.value),
        effectivePolicy.value.angleDeduplicationToleranceDeg
      )
      if ('message' in candidates) {
        return failInvalidGeometry('generateTransforms', candidates.message)
      }

      const selectedCandidates = selectTransformChoices(
        candidates.value,
        decoded.settings.transformCap,
        decoded.allowMirror,
        effectivePolicy.value.angleDeduplicationToleranceDeg
      )

      return Effect.succeed(
        selectedCandidates.map(
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

/** Builds legal orientation metadata after global and prepared-piece rotation gates. */
function transformAngleCandidates(
  allowRotation: boolean,
  settings: GenerateTransformsInput['settings'],
  usableEdges: ReadonlyArray<UsableEdge>
): ReadonlyArray<AngleCandidate> {
  if (!allowRotation) {
    return [{ rotationDeg: 0, reason: 'orthogonal', edgeLengthMm: 0, sourceOrdinal: 0 }]
  }

  return [
    { rotationDeg: 0, reason: 'orthogonal', edgeLengthMm: 0, sourceOrdinal: 0 },
    { rotationDeg: 90, reason: 'orthogonal', edgeLengthMm: 0, sourceOrdinal: 1 },
    { rotationDeg: 180, reason: 'orthogonal', edgeLengthMm: 0, sourceOrdinal: 2 },
    { rotationDeg: 270, reason: 'orthogonal', edgeLengthMm: 0, sourceOrdinal: 3 },
    ...(settings.edgeAlignmentEnabled !== false
      ? usableEdges.map(({ rotationDeg, lengthMm, sourceOrdinal }) => ({
          rotationDeg,
          reason: 'edge_alignment' as const,
          edgeLengthMm: lengthMm,
          sourceOrdinal
        }))
      : []),
    ...(settings.configuredRotationEnabled !== false
      ? settings.configuredRotationDeg.map((rotationDeg, sourceOrdinal) => ({
          rotationDeg,
          reason: 'configured' as const,
          edgeLengthMm: 0,
          sourceOrdinal
        }))
      : [])
  ]
}

function deriveEffectiveTransformPolicy(
  input: GenerateTransformsInput,
  boundary: ReadonlyArray<IrregularPoint>
): { readonly value: EffectiveTransformPolicy } | GeometryFailure {
  if (!intrinsicSharedArchiveEligibility(input.settings).eligible) {
    return {
      value: {
        minimumEdgeLengthMm: input.settings.transformMinimumEdgeLengthMm,
        angleDeduplicationToleranceDeg:
          input.settings.transformAngleDeduplicationToleranceDeg
      }
    }
  }

  const bounds = boundsForBoundary(boundary)
  if ('message' in bounds) return bounds

  const sagMm = input.geometrySettings.flatteningSagToleranceMm
  const smallerCollisionDimensionMm = Math.min(bounds.value.widthMm, bounds.value.heightMm)
  const minimumEdgeLengthMm = Math.min(
    COMPACT_EDGE_SAG_MULTIPLIER * sagMm,
    COMPACT_EDGE_SMALLER_DIMENSION_RATIO * smallerCollisionDimensionMm
  )
  // collision vertices are already local to placementReference, whose local coordinate is (0, 0)
  const maximumRadiusMm = boundary.reduce(
    (maximum, point) => Math.max(maximum, Math.hypot(point.x, point.y)),
    0
  )
  const angleDeduplicationToleranceDeg =
    maximumRadiusMm === 0
      ? COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG
      : Math.min(
          COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG,
          2 *
            Math.asin(Math.min(1, sagMm / (2 * maximumRadiusMm))) *
            DEGREES_PER_RADIAN
        )

  if (
    !Number.isFinite(minimumEdgeLengthMm) ||
    minimumEdgeLengthMm < 0 ||
    !Number.isFinite(angleDeduplicationToleranceDeg) ||
    angleDeduplicationToleranceDeg <= 0
  ) {
    return { message: 'adaptive transform tolerances must be finite and non-negative.' }
  }

  return {
    value: {
      minimumEdgeLengthMm,
      angleDeduplicationToleranceDeg
    }
  }
}

function boundsForBoundary(
  points: ReadonlyArray<IrregularPoint>
):
  | { readonly value: { readonly widthMm: number; readonly heightMm: number } }
  | GeometryFailure {
  const first = points[0]
  if (first === undefined) return { message: 'polygon boundary must contain points.' }

  let minX = first.x
  let minY = first.y
  let maxX = first.x
  let maxY = first.y
  for (const point of points.slice(1)) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  const widthMm = maxX - minX
  const heightMm = maxY - minY
  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm)) {
    return { message: 'collision polygon bounds must be finite.' }
  }

  return { value: { widthMm, heightMm } }
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
      usableEdges.push({ rotationDeg, lengthMm: length, sourceOrdinal: index })
    }
  }

  return { value: usableEdges }
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
    normalized.push({ ...candidate, rotationDeg })
  }

  normalized.sort(compareRepresentativeSignificance)

  const retained: AngleCandidate[] = []
  for (const candidate of normalized) {
    if (
      retained.some(
        (existing) =>
          !(candidate.reason === 'orthogonal' && existing.reason === 'orthogonal') &&
          circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
      )
    ) {
      continue
    }
    retained.push(candidate)
  }

  retained.sort(compareOutputOrder)
  return { value: retained }
}

function compareRepresentativeSignificance(
  first: AngleCandidate,
  second: AngleCandidate
): number {
  const priorityComparison = reasonPriority(first.reason) - reasonPriority(second.reason)
  if (priorityComparison !== 0) return priorityComparison

  if (first.reason === 'edge_alignment' && second.reason === 'edge_alignment') {
    const lengthComparison = second.edgeLengthMm - first.edgeLengthMm
    if (lengthComparison !== 0) return lengthComparison
  }

  const rotationComparison = first.rotationDeg - second.rotationDeg
  if (rotationComparison !== 0) return rotationComparison
  return first.sourceOrdinal - second.sourceOrdinal
}

function compareOutputOrder(first: AngleCandidate, second: AngleCandidate): number {
  const priorityComparison = reasonPriority(first.reason) - reasonPriority(second.reason)
  if (priorityComparison !== 0) return priorityComparison
  const rotationComparison = first.rotationDeg - second.rotationDeg
  if (rotationComparison !== 0) return rotationComparison
  const lengthComparison = second.edgeLengthMm - first.edgeLengthMm
  if (lengthComparison !== 0) return lengthComparison
  return first.sourceOrdinal - second.sourceOrdinal
}

interface TransformChoice {
  readonly rotationDeg: number
  readonly reason: AngleReason
  readonly mirrored: boolean
}

function selectTransformChoices(
  angles: ReadonlyArray<AngleCandidate>,
  transformCap: number,
  allowMirror: boolean,
  toleranceDeg: number
): ReadonlyArray<TransformChoice> {
  const baseline = angles.filter(({ reason }) => reason === 'orthogonal')
  const baselineChoices = baseline.map((candidate) => toTransformChoice(candidate, false))
  const selected: TransformChoice[] = baselineChoices.slice(0, transformCap)
  if (selected.length >= transformCap || !allowMirror) {
    if (!allowMirror) {
      selected.push(
        ...angles
          .filter(({ reason }) => reason !== 'orthogonal')
          .map((candidate) => toTransformChoice(candidate, false))
          .slice(0, Math.max(0, transformCap - selected.length))
      )
    }
    return selected.slice(0, transformCap)
  }

  const extraChoices: TransformChoice[] = []
  for (const candidate of angles.filter(({ reason }) => reason !== 'orthogonal')) {
    appendDistinctChoice(extraChoices, toTransformChoice(candidate, true), toleranceDeg)
    appendDistinctChoice(extraChoices, toTransformChoice(candidate, false), toleranceDeg)
  }
  for (const candidate of baseline) {
    appendDistinctChoice(extraChoices, toTransformChoice(candidate, true), toleranceDeg)
  }

  selected.push(...extraChoices.slice(0, transformCap - selected.length))
  return selected
}

function appendDistinctChoice(
  choices: TransformChoice[],
  candidate: TransformChoice,
  toleranceDeg: number
): void {
  if (
    choices.some(
      (existing) =>
        existing.mirrored === candidate.mirrored &&
        circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
    )
  ) {
    return
  }
  choices.push(candidate)
}

function toTransformChoice(candidate: AngleCandidate, mirrored: boolean): TransformChoice {
  const rotationDeg =
    mirrored && candidate.reason === 'edge_alignment'
      ? normalizeRotationDeg(180 - candidate.rotationDeg) ?? candidate.rotationDeg
      : candidate.rotationDeg
  return { rotationDeg, reason: candidate.reason, mirrored }
}

function reasonPriority(reason: AngleReason): number {
  switch (reason) {
    case 'orthogonal':
      return 0
    case 'edge_alignment':
      return 1
    case 'configured':
      return 2
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
