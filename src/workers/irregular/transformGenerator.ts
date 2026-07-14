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
 * direction angle, which makes that edge horizontal. For a convex polygon,
 * minimum-area oriented bounding boxes have a side parallel to one of those
 * edges, so the complete edge-alignment set already contains every OBB
 * orientation; there is no separate redundant `oriented_bounds` source.
 *
 * Orthogonal choices are the baseline priority, followed by configured angles,
 * followed by geometry-derived edge angles. When mirroring is enabled and the
 * cap is larger than the baseline, extra choices are taken as mirrored and
 * unmirrored pairs in that priority order, then mirrored baseline choices. This
 * reserves mirror capacity without allowing noisy edge angles to displace
 * configured choices. Candidate indexes are assigned only after capping.
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
          }))
        ],
        decoded.settings.transformAngleDeduplicationToleranceDeg
      )
      if ('message' in candidates) {
        return failInvalidGeometry('generateTransforms', candidates.message)
      }

      const selectedCandidates = selectTransformChoices(
        candidates.value,
        decoded.settings.transformCap,
        decoded.allowMirror,
        decoded.settings.transformAngleDeduplicationToleranceDeg
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
      usableEdges.push({ rotationDeg })
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
          !(candidate.reason === 'orthogonal' && existing.reason === 'orthogonal') &&
          circularDistanceDeg(existing.rotationDeg, candidate.rotationDeg) <= toleranceDeg
      )
    ) {
      continue
    }
    retained.push(candidate)
  }

  return { value: retained }
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
    case 'configured':
      return 1
    case 'edge_alignment':
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
