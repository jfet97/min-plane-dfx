import { performance } from 'node:perf_hooks'
import { Effect } from 'effect'
import type { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacedPiece,
  IrregularPlacement,
  IrregularTransform,
  type IrregularNestingSettings,
  type IrregularPlacementCandidate,
  type IrregularPreparedPiece,
  type TransformedCollisionGeometry
} from '@shared/irregular/domain.js'
import { toGridMm } from '../../irregular/clipper2OffsetPolicy.js'
import { GeometryKernel } from '../../irregular/geometryKernel.js'
import { placedCollisionWorldGridPath } from '../../irregular/canonicalLayoutGeometry.js'
import {
  hasPositiveCanonicalGridBoundaryContact,
  measureCanonicalGridBoundaryOverlapAxisUnits
} from '../../irregular/canonicalGridContact.js'
import {
  makeEmptyPlacedCollisionSpatialIndex,
  type PlacedCollisionSpatialIndex
} from '../../irregular/placedCollisionSpatialIndex.js'
import {
  IrregularNfpIfpControlAbortError,
  NfpIfpService
} from '../../irregular/services.js'

export const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION =
  'intrinsic-short-side-contact-strip-v3' as const
export const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS = 20_000 as const
export const INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES = 256 * 1_048_576
export const INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS =
  2_000 as const
export const INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS = 4 as const

export type IntrinsicShortSideContactStripStatus =
  | 'constructed'
  | 'no-legal-placement'
  | 'deadline'
  | 'memory-cap'
  | 'evaluation-cap'
  | 'failed-protected-fallback'

export interface IntrinsicShortSideContactStripTrace {
  readonly version: typeof INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION
  readonly status: IntrinsicShortSideContactStripStatus
  readonly executionModel: 'single-process-sequential'
  readonly selectionPolicy: IntrinsicShortSideContactStripSelectionPolicy
  readonly orderPolicy: IntrinsicShortSideContactStripOrderPolicy
  readonly stripShortAxisMm: number
  readonly stripLongAxisMm: number
  readonly transformEvaluations: number
  readonly candidateEvaluations: number
  readonly backtrackCount: number
  readonly reusedPrefixPlacements: number
  readonly placedCount: number
  readonly requestedCount: number
  readonly runtimeMs: number
  readonly peakRssDeltaBytes: number
  readonly failureReason: string | undefined
}

export type IntrinsicShortSideContactStripSelectionPolicy =
  | 'depth-first'
  | 'contact-first'

export type IntrinsicShortSideContactStripOrderPolicy =
  | 'prepared'
  | 'reverse'
  | 'piece-id-ascending'

export interface IntrinsicShortSideContactStripOutcome {
  readonly trace: IntrinsicShortSideContactStripTrace
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece> | undefined
}

/** Runtime bounds for the exact contact-driven directional construction. */
export interface IntrinsicShortSideContactStripRuntimeControl {
  readonly maximumRuntimeMs?: number
  readonly maximumRssDeltaBytes?: number
  readonly maximumCandidateEvaluations?: number
  readonly maximumBacktracks?: number
  readonly now?: () => number
  readonly currentRssBytes?: () => number
  readonly tieEvidenceSink?: (entry: IntrinsicShortSideContactStripTieEvidence) => void
}

/**
 * Exact per-tie evidence collected when more than one legal candidate shares
 * the winning `(long axis, short axis)` anchor for one prepared piece. The
 * contact score is `<positive-contact-count>:<axis-overlap-units>`. Positive
 * contact is classified directly on canonical integer-grid edges. The
 * axis-overlap suffix is an exact secondary tie-break only when every positive
 * contact is axis-aligned; diagonal contact leaves the score undefined so the
 * historical deterministic candidate tuple remains authoritative.
 */
export interface IntrinsicShortSideContactStripTieEvidence {
  readonly pieceIndex: number
  readonly tiedCount: number
  readonly winnerScore: string | undefined
  readonly bestAlternativeScore: string | undefined
  readonly winnerMaxCornerSharedByAllTied: boolean
  readonly selectionChanged: boolean
  readonly scores: ReadonlyArray<{
    readonly transformIndex: number
    readonly rotationDeg: number
    readonly mirrored: boolean
    readonly translationShortAxisGrid: number
    readonly translationLongAxisGrid: number
    readonly maxShortAxisGrid: number
    readonly maxLongAxisGrid: number
    readonly contactAxisUnits: string | undefined
  }>
}

interface StripRuntime {
  readonly startedAt: number
  readonly startingRssBytes: number
  peakRssBytes: number
  transformEvaluations: number
  candidateEvaluations: number
  placedCount: number
  backtrackCount: number
  reusedPrefixPlacements: number
  readonly maximumRuntimeMs: number
  readonly maximumRssDeltaBytes: number
  readonly maximumCandidateEvaluations: number
  readonly maximumBacktracks: number
  readonly now: () => number
  readonly currentRssBytes: () => number
}

/** One legal candidate together with the exact grid anchor it would occupy. */
interface AnchoredCandidate {
  readonly candidate: IrregularPlacementCandidate
  readonly moving: TransformedCollisionGeometry
  readonly anchorLongAxisGrid: number
  readonly anchorShortAxisGrid: number
  readonly translationLongAxisGrid: number
  readonly translationShortAxisGrid: number
  readonly maxLongAxisGrid: number
  readonly maxShortAxisGrid: number
  readonly transformIndex: number
  readonly rotationDeg: number
  readonly mirrored: boolean
}

interface ContactDecisionCheckpoint {
  readonly pieceIndex: number
  readonly placedBefore: ReadonlyArray<IrregularPlacedPiece>
  readonly collisionIndexBefore: PlacedCollisionSpatialIndex
  readonly baselinePiece: IrregularPlacedPiece
}

/**
 * Builds one exact contact-driven directional layout inside the requested
 * short-axis strip.
 *
 * The strip is expressed in normalized directional coordinates: `x` is the
 * requested short axis and `y` is the requested long axis, so filling the short
 * edge means spreading along `x` and compactness means minimizing `y`. Each
 * prepared piece is visited in prepared order. The protected depth-first lane
 * uses the shallowest exact candidate. The bounded contact-first lane retains
 * the depth-first decision as a checkpoint, prefers stronger exact contact,
 * and resumes the most recent saved prefix if the contact choice reaches a
 * dead end. Candidates come from the same exact NFP/IFP generator production
 * Compact uses, so every placement is contact-anchored and canonically legal.
 * There is no reordering, concurrent execution, or restart from empty.
 */
export function constructIntrinsicShortSideContactStrip(input: {
  readonly stripSheet: SheetSpec
  readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
  readonly settings: IrregularNestingSettings
  readonly selectionPolicy?: IntrinsicShortSideContactStripSelectionPolicy
  readonly orderPolicy?: IntrinsicShortSideContactStripOrderPolicy
  readonly runtimeControl?: IntrinsicShortSideContactStripRuntimeControl
}): Effect.Effect<
  IntrinsicShortSideContactStripOutcome,
  never,
  GeometryKernel | NfpIfpService
> {
  const now = input.runtimeControl?.now ?? (() => performance.now())
  const currentRssBytes = input.runtimeControl?.currentRssBytes ?? (() => process.memoryUsage.rss())
  const startingRssBytes = currentRssBytes()
  const runtime: StripRuntime = {
    startedAt: now(),
    startingRssBytes,
    peakRssBytes: startingRssBytes,
    transformEvaluations: 0,
    candidateEvaluations: 0,
    placedCount: 0,
    backtrackCount: 0,
    reusedPrefixPlacements: 0,
    maximumRuntimeMs:
      input.runtimeControl?.maximumRuntimeMs ?? INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS,
    maximumRssDeltaBytes:
      input.runtimeControl?.maximumRssDeltaBytes ??
      INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
    maximumCandidateEvaluations:
      input.runtimeControl?.maximumCandidateEvaluations ??
      Number.POSITIVE_INFINITY,
    maximumBacktracks:
      input.runtimeControl?.maximumBacktracks ?? Number.POSITIVE_INFINITY,
    now,
    currentRssBytes
  }
  return constructStrip(input, runtime).pipe(
    Effect.catchTags({
      IrregularNfpIfpControlAbortError: (error) =>
        Effect.succeed(
          failedOutcome(
            input,
            runtime,
            boundedStatus(runtime) ?? 'deadline',
            error.message,
            runtime.placedCount
          )
        ),
      IrregularGeometryInputError: (error) =>
        Effect.succeed(
          failedOutcome(input, runtime, 'failed-protected-fallback', error.message, 0)
        ),
      IrregularNestingNotImplementedError: (error) =>
        Effect.succeed(
          failedOutcome(input, runtime, 'failed-protected-fallback', error.message, 0)
        )
    })
  )
}

function constructStrip(
  input: {
    readonly stripSheet: SheetSpec
    readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly settings: IrregularNestingSettings
    readonly selectionPolicy?: IntrinsicShortSideContactStripSelectionPolicy
    readonly orderPolicy?: IntrinsicShortSideContactStripOrderPolicy
    readonly runtimeControl?: IntrinsicShortSideContactStripRuntimeControl
  },
  runtime: StripRuntime
) {
  return Effect.gen(function* () {
    const geometryKernel = yield* GeometryKernel
    const nfpIfpService = yield* NfpIfpService
    let placed: IrregularPlacedPiece[] = []
    let placedCollisionIndex: PlacedCollisionSpatialIndex = makeEmptyPlacedCollisionSpatialIndex()
    const checkpoints: ContactDecisionCheckpoint[] = []

    let pieceIndex = 0
    while (pieceIndex < input.preparedPieces.length) {
      const piece = input.preparedPieces[pieceIndex]
      if (piece === undefined) {
        return failedOutcome(
          input,
          runtime,
          'failed-protected-fallback',
          `prepared piece ${pieceIndex} is missing during contact-strip construction.`,
          placed.length
        )
      }
      const bounded = boundedStatus(runtime)
      if (bounded !== undefined) {
        return failedOutcome(
          input,
          runtime,
          bounded,
          `${bounded} reached after ${placed.length} contact placements.`,
          placed.length
        )
      }
      const anchoredCandidates: AnchoredCandidate[] = []
      for (const transform of piece.transforms) {
        runtime.transformEvaluations += 1
        const moving = yield* geometryKernel.transformCollisionGeometry({
          geometry: piece.collisionGeometry,
          transform
        })
        const candidates = yield* nfpIfpService.generatePlacementCandidates({
          sheet: input.stripSheet,
          placed,
          placedCollisionIndex,
          moving,
          settings: input.settings,
          control: {
            checkpoint: (phase) => {
              const bounded = boundedStatus(runtime)
              return bounded === undefined
                ? Effect.void
                : Effect.fail(
                    new IrregularNfpIfpControlAbortError({
                      reason: bounded === 'deadline' ? 'deadline' : 'cancelled',
                      message: `${bounded} reached during contact-strip ${phase}.`
                    })
                  )
            }
          }
        })
        const boundedAfterGeneration = boundedStatus(runtime)
        if (boundedAfterGeneration !== undefined) {
          return failedOutcome(
            input,
            runtime,
            boundedAfterGeneration,
            `${boundedAfterGeneration} reached after contact candidate generation.`,
            placed.length
          )
        }
        for (const candidate of candidates) {
          runtime.candidateEvaluations += 1
          if (
            runtime.candidateEvaluations >
            runtime.maximumCandidateEvaluations
          ) {
            return failedOutcome(
              input,
              runtime,
              'evaluation-cap',
              `evaluation-cap reached after ${runtime.candidateEvaluations - 1} contact candidate anchors.`,
              placed.length
            )
          }
          const boundedAfterAnchor = boundedStatus(runtime)
          if (boundedAfterAnchor !== undefined) {
            return failedOutcome(
              input,
              runtime,
              boundedAfterAnchor,
              `${boundedAfterAnchor} reached after ${runtime.candidateEvaluations} contact candidate anchors.`,
              placed.length
            )
          }
          const anchored = anchorCandidate(candidate, moving)
          if (anchored === undefined) continue
          anchoredCandidates.push(anchored)
        }
      }
      const selectionResult = selectContactAwareWinner(
        anchoredCandidates,
        placed,
        piece,
        input.selectionPolicy ?? 'depth-first',
        runtime
      )
      if (selectionResult.kind === 'bounded') {
        return failedOutcome(
          input,
          runtime,
          selectionResult.status,
          `${selectionResult.status} reached during contact-aware tie selection.`,
          placed.length
        )
      }
      if (selectionResult.kind === 'none') {
        const checkpoint =
          input.selectionPolicy === 'contact-first'
            ? checkpoints.pop()
            : undefined
        if (checkpoint !== undefined) {
          if (runtime.backtrackCount >= runtime.maximumBacktracks) {
            return failedOutcome(
              input,
              runtime,
              'evaluation-cap',
              `backtrack cap reached after ${runtime.backtrackCount} resumable contact decisions.`,
              placed.length
            )
          }
          placed = [...checkpoint.placedBefore, checkpoint.baselinePiece]
          placedCollisionIndex = checkpoint.collisionIndexBefore.add(
            checkpoint.baselinePiece
          )
          runtime.backtrackCount += 1
          runtime.reusedPrefixPlacements += checkpoint.placedBefore.length
          runtime.placedCount = placed.length
          pieceIndex = checkpoint.pieceIndex + 1
          continue
        }
        return failedOutcome(
          input,
          runtime,
          'no-legal-placement',
          `piece ${piece.pieceId ?? piece.source.id} has no legal contact placement inside the requested short-axis strip.`,
          placed.length
        )
      }
      const selection = selectionResult.selection
      const best = selection.winner
      if (selection.tiedCount >= 2) {
        input.runtimeControl?.tieEvidenceSink?.(
          measureTieEvidence(placed.length, selection, placed, piece, runtime)
        )
      }
      const placedPiece = new IrregularPlacedPiece({
        placement: makeStripPlacement(piece, best),
        collisionGeometry: best.moving
      })
      if (selection.selectionChanged) {
        checkpoints.push({
          pieceIndex,
          placedBefore: [...placed],
          collisionIndexBefore: placedCollisionIndex,
          baselinePiece: new IrregularPlacedPiece({
            placement: makeStripPlacement(piece, selection.baselineWinner),
            collisionGeometry: selection.baselineWinner.moving
          })
        })
      }
      placed.push(placedPiece)
      runtime.placedCount = placed.length
      placedCollisionIndex = placedCollisionIndex.add(placedPiece)
      pieceIndex += 1
    }

    const bounded = boundedStatus(runtime)
    if (bounded !== undefined) {
      return failedOutcome(
        input,
        runtime,
        bounded,
        `${bounded} reached after completing ${placed.length} contact placements.`,
        placed.length
      )
    }
    return {
      trace: {
        version: INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION,
        status: 'constructed' as const,
        executionModel: 'single-process-sequential' as const,
        selectionPolicy: input.selectionPolicy ?? 'depth-first',
        orderPolicy: input.orderPolicy ?? 'prepared',
        stripShortAxisMm: input.stripSheet.width,
        stripLongAxisMm: input.stripSheet.height,
        transformEvaluations: runtime.transformEvaluations,
        candidateEvaluations: runtime.candidateEvaluations,
        backtrackCount: runtime.backtrackCount,
        reusedPrefixPlacements: runtime.reusedPrefixPlacements,
        placedCount: placed.length,
        requestedCount: input.preparedPieces.length,
        runtimeMs: Math.max(0, runtime.now() - runtime.startedAt),
        peakRssDeltaBytes: sampleRss(runtime),
        failureReason: undefined
      },
      placedCollisionGeometries: placed
    }
  })
}

/**
 * Reduces one legal candidate to the exact grid anchor of the area it occupies.
 *
 * The anchor is the minimum corner of the placed collision bounds rather than
 * the candidate translation, so the comparison is independent of each piece's
 * placement-reference convention.
 */
function anchorCandidate(
  candidate: IrregularPlacementCandidate,
  moving: TransformedCollisionGeometry
): AnchoredCandidate | undefined {
  const anchorShortAxisGrid = toGridMm(moving.bounds.minX + candidate.point.x)
  const anchorLongAxisGrid = toGridMm(moving.bounds.minY + candidate.point.y)
  const translationShortAxisGrid = toGridMm(candidate.point.x)
  const translationLongAxisGrid = toGridMm(candidate.point.y)
  const maxShortAxisGrid = toGridMm(moving.bounds.maxX + candidate.point.x)
  const maxLongAxisGrid = toGridMm(moving.bounds.maxY + candidate.point.y)
  if (
    anchorShortAxisGrid === undefined ||
    anchorLongAxisGrid === undefined ||
    translationShortAxisGrid === undefined ||
    translationLongAxisGrid === undefined ||
    maxShortAxisGrid === undefined ||
    maxLongAxisGrid === undefined
  ) {
    return undefined
  }
  return {
    candidate,
    moving,
    anchorLongAxisGrid,
    anchorShortAxisGrid,
    translationLongAxisGrid,
    translationShortAxisGrid,
    maxLongAxisGrid,
    maxShortAxisGrid,
    transformIndex: moving.transform.index,
    rotationDeg: moving.transform.rotationDeg,
    mirrored: moving.transform.mirrored
  }
}

interface ContactAwareSelection {
  readonly winner: AnchoredCandidate
  readonly baselineWinner: AnchoredCandidate
  readonly tiedCount: number
  readonly tied: ReadonlyArray<AnchoredCandidate>
  readonly winnerScore: ContactScore | undefined
  readonly baselineScore: ContactScore | undefined
  readonly selectionChanged: boolean
}

interface ContactScore {
  readonly positiveContactCount: number
  readonly axisUnits: bigint
}

type ContactAwareSelectionResult =
  | { readonly kind: 'selection'; readonly selection: ContactAwareSelection }
  | { readonly kind: 'bounded'; readonly status: 'deadline' | 'memory-cap' }
  | { readonly kind: 'none' }

/**
 * Orders candidates by the directional bottom-left contract.
 *
 * Minimizing the long-axis anchor first keeps the layout shallow; minimizing the
 * short-axis anchor next spreads it along the requested short edge. The
 * remaining terms only remove ties so the construction stays deterministic.
 */
function compareAnchoredCandidates(first: AnchoredCandidate, second: AnchoredCandidate): number {
  return (
    first.maxLongAxisGrid - second.maxLongAxisGrid ||
    first.anchorLongAxisGrid - second.anchorLongAxisGrid ||
    first.anchorShortAxisGrid - second.anchorShortAxisGrid ||
    first.maxShortAxisGrid - second.maxShortAxisGrid ||
    first.translationShortAxisGrid - second.translationShortAxisGrid ||
    first.translationLongAxisGrid - second.translationLongAxisGrid ||
    first.transformIndex - second.transformIndex ||
    first.rotationDeg - second.rotationDeg ||
    Number(first.mirrored) - Number(second.mirrored)
  )
}

/**
 * Selects one legal candidate per prepared piece.
 *
 * The depth-first policy limits contact comparison to candidates with the same
 * shallowest maximum long-axis extent. The contact-first policy compares every
 * legal candidate by exact positive-contact count, exact axis-overlap units,
 * then the deterministic depth/anchor order. Its selected deviations retain a
 * resumable depth-first checkpoint, so a later dead end rolls back to preserved
 * construction work rather than restarting from empty.
 */
function selectContactAwareWinner(
  candidates: ReadonlyArray<AnchoredCandidate>,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  piece: IrregularPreparedPiece,
  selectionPolicy: IntrinsicShortSideContactStripSelectionPolicy,
  runtime: StripRuntime
): ContactAwareSelectionResult {
  let baseline: AnchoredCandidate | undefined
  for (const anchored of candidates) {
    const bounded = boundedStatus(runtime)
    if (bounded !== undefined) return { kind: 'bounded', status: bounded }
    if (baseline === undefined || compareAnchoredCandidates(anchored, baseline) < 0) {
      baseline = anchored
    }
  }
  if (baseline === undefined) return { kind: 'none' }
  const tied: AnchoredCandidate[] = []
  for (const anchored of candidates) {
    const bounded = boundedStatus(runtime)
    if (bounded !== undefined) return { kind: 'bounded', status: bounded }
    if (
      selectionPolicy === 'contact-first' ||
      anchored.maxLongAxisGrid === baseline.maxLongAxisGrid
    ) {
      tied.push(anchored)
    }
  }
  if (tied.length < 2) {
    return {
      kind: 'selection',
      selection: {
        winner: baseline,
        baselineWinner: baseline,
        tiedCount: tied.length,
        tied,
        winnerScore: undefined,
        baselineScore: undefined,
        selectionChanged: false
      }
    }
  }
  const baselineMeasurement = candidateContactAxisUnits(baseline, placed, piece, runtime)
  if (baselineMeasurement.bounded !== undefined) {
    return { kind: 'bounded', status: baselineMeasurement.bounded }
  }
  const baselineScore = baselineMeasurement.score
  if (baselineScore === undefined) {
    return {
      kind: 'selection',
      selection: {
        winner: baseline,
        baselineWinner: baseline,
        tiedCount: tied.length,
        tied,
        winnerScore: undefined,
        baselineScore: undefined,
        selectionChanged: false
      }
    }
  }
  let winner = baseline
  let winnerScore = baselineScore
  for (const challenger of tied) {
    const bounded = boundedStatus(runtime)
    if (bounded !== undefined) return { kind: 'bounded', status: bounded }
    if (challenger === baseline) continue
    if (
      selectionPolicy === 'depth-first' &&
      challenger.maxLongAxisGrid > baseline.maxLongAxisGrid
    ) {
      continue
    }
    const challengerMeasurement = candidateContactAxisUnits(challenger, placed, piece, runtime)
    if (challengerMeasurement.bounded !== undefined) {
      return { kind: 'bounded', status: challengerMeasurement.bounded }
    }
    const challengerScore = challengerMeasurement.score
    if (challengerScore === undefined) {
      return {
        kind: 'selection',
        selection: {
          winner: baseline,
          baselineWinner: baseline,
          tiedCount: tied.length,
          tied,
          winnerScore: baselineScore,
          baselineScore,
          selectionChanged: false
        }
      }
    }
    const scoreOrder = compareContactScores(challengerScore, winnerScore)
    if (
      scoreOrder > 0 ||
      (scoreOrder === 0 && compareAnchoredCandidates(challenger, winner) < 0)
    ) {
      winner = challenger
      winnerScore = challengerScore
    }
  }
  return {
    kind: 'selection',
    selection: {
      winner,
      baselineWinner: baseline,
      tiedCount: tied.length,
      tied,
      winnerScore,
      baselineScore,
      selectionChanged: winner !== baseline
    }
  }
}

/** Measures exact positive contact against the placed pieces. */
function candidateContactAxisUnits(
  anchored: AnchoredCandidate,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  piece: IrregularPreparedPiece,
  runtime: StripRuntime
): {
  readonly score: ContactScore | undefined
  readonly bounded: 'deadline' | 'memory-cap' | undefined
} {
  const worldPath = placedCollisionWorldGridPath(
    new IrregularPlacedPiece({
      placement: makeStripPlacement(piece, anchored),
      collisionGeometry: anchored.moving
    })
  )
  if (worldPath === undefined) return { score: undefined, bounded: undefined }
  let positiveContactCount = 0
  let axisUnits = 0n
  for (const placedPiece of placed) {
    const bounded = boundedStatus(runtime)
    if (bounded !== undefined) return { score: undefined, bounded }
    const placedWorldPath = placedCollisionWorldGridPath(placedPiece)
    if (placedWorldPath === undefined) return { score: undefined, bounded: undefined }
    const hasPositiveContact = hasPositiveCanonicalGridBoundaryContact(
      worldPath,
      placedWorldPath
    )
    if (hasPositiveContact === undefined) {
      return { score: undefined, bounded: undefined }
    }
    if (hasPositiveContact) positiveContactCount += 1
    let boundedDuringScan: 'deadline' | 'memory-cap' | undefined
    const overlap = measureCanonicalGridBoundaryOverlapAxisUnits(worldPath, placedWorldPath, () => {
      const bounded = boundedStatus(runtime)
      if (bounded !== undefined) boundedDuringScan = bounded
      return bounded === undefined
    })
    if (overlap.kind === 'aborted') {
      return { score: undefined, bounded: boundedDuringScan }
    }
    if (overlap.kind === 'undecidable') {
      return { score: undefined, bounded: undefined }
    }
    if (overlap.kind === 'measured') axisUnits += overlap.score
  }
  return {
    score: { positiveContactCount, axisUnits },
    bounded: undefined
  }
}

function compareContactScores(first: ContactScore, second: ContactScore): number {
  if (first.positiveContactCount !== second.positiveContactCount) {
    return first.positiveContactCount - second.positiveContactCount
  }
  return first.axisUnits < second.axisUnits
    ? -1
    : first.axisUnits > second.axisUnits
      ? 1
      : 0
}

function serializeContactScore(score: ContactScore | undefined): string | undefined {
  return score === undefined
    ? undefined
    : `${score.positiveContactCount}:${score.axisUnits.toString()}`
}

function measureTieEvidence(
  pieceIndex: number,
  selection: ContactAwareSelection,
  placed: ReadonlyArray<IrregularPlacedPiece>,
  piece: IrregularPreparedPiece,
  runtime: StripRuntime
): IntrinsicShortSideContactStripTieEvidence {
  const scored = selection.tied.map((anchored) => {
    if (anchored === selection.winner) {
      return { anchored, contactAxisUnits: selection.winnerScore }
    }
    if (anchored === selection.baselineWinner) {
      return { anchored, contactAxisUnits: selection.baselineScore }
    }
    const measurement = candidateContactAxisUnits(anchored, placed, piece, runtime)
    return {
      anchored,
      contactAxisUnits: measurement.bounded === undefined ? measurement.score : undefined
    }
  })
  const bestAlternativeScore = scored
    .filter((entry) => entry.anchored !== selection.winner)
    .map((entry) => entry.contactAxisUnits)
    .reduce<ContactScore | undefined>(
      (maximum, score) =>
        score === undefined
          ? maximum
          : maximum === undefined || compareContactScores(score, maximum) > 0
            ? score
            : maximum,
      undefined
    )
  const winnerMaxCornerSharedByAllTied = selection.tied.every(
    (anchored) =>
      anchored.maxLongAxisGrid === selection.baselineWinner.maxLongAxisGrid &&
      anchored.maxShortAxisGrid === selection.baselineWinner.maxShortAxisGrid
  )
  return {
    pieceIndex,
    tiedCount: selection.tiedCount,
    winnerScore: serializeContactScore(selection.winnerScore),
    bestAlternativeScore: serializeContactScore(bestAlternativeScore),
    winnerMaxCornerSharedByAllTied,
    selectionChanged: selection.selectionChanged,
    scores: scored.map(({ anchored, contactAxisUnits }) => ({
      transformIndex: anchored.transformIndex,
      rotationDeg: anchored.rotationDeg,
      mirrored: anchored.mirrored,
      translationShortAxisGrid: anchored.translationShortAxisGrid,
      translationLongAxisGrid: anchored.translationLongAxisGrid,
      maxShortAxisGrid: anchored.maxShortAxisGrid,
      maxLongAxisGrid: anchored.maxLongAxisGrid,
      contactAxisUnits: serializeContactScore(contactAxisUnits)
    }))
  }
}

function makeStripPlacement(
  piece: IrregularPreparedPiece,
  anchored: AnchoredCandidate
): IrregularPlacement {
  const placementInput = {
    sourcePieceId: piece.source.id,
    placementReference: piece.collisionGeometry.placementReference,
    transform: new IrregularTransform({
      translateX: anchored.candidate.point.x,
      translateY: anchored.candidate.point.y,
      rotationDeg: anchored.rotationDeg,
      mirrored: anchored.mirrored
    })
  }
  return piece.pieceId === undefined
    ? new IrregularPlacement(placementInput)
    : new IrregularPlacement({ ...placementInput, pieceId: piece.pieceId })
}

function boundedStatus(runtime: StripRuntime): 'deadline' | 'memory-cap' | undefined {
  if (runtime.now() - runtime.startedAt > runtime.maximumRuntimeMs) return 'deadline'
  return sampleRss(runtime) > runtime.maximumRssDeltaBytes ? 'memory-cap' : undefined
}

function sampleRss(runtime: StripRuntime): number {
  runtime.peakRssBytes = Math.max(runtime.peakRssBytes, runtime.currentRssBytes())
  return Math.max(0, runtime.peakRssBytes - runtime.startingRssBytes)
}

function failedOutcome(
  input: {
    readonly stripSheet: SheetSpec
    readonly preparedPieces: ReadonlyArray<IrregularPreparedPiece>
    readonly selectionPolicy?: IntrinsicShortSideContactStripSelectionPolicy
    readonly orderPolicy?: IntrinsicShortSideContactStripOrderPolicy
  },
  runtime: StripRuntime,
  status: Exclude<IntrinsicShortSideContactStripStatus, 'constructed'>,
  failureReason: string,
  placedCount: number
): IntrinsicShortSideContactStripOutcome {
  return {
    trace: {
      version: INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION,
      status,
      executionModel: 'single-process-sequential',
      selectionPolicy: input.selectionPolicy ?? 'depth-first',
      orderPolicy: input.orderPolicy ?? 'prepared',
      stripShortAxisMm: input.stripSheet.width,
      stripLongAxisMm: input.stripSheet.height,
      transformEvaluations: runtime.transformEvaluations,
      candidateEvaluations: runtime.candidateEvaluations,
      backtrackCount: runtime.backtrackCount,
      reusedPrefixPlacements: runtime.reusedPrefixPlacements,
      placedCount,
      requestedCount: input.preparedPieces.length,
      runtimeMs: Math.max(0, runtime.now() - runtime.startedAt),
      peakRssDeltaBytes: sampleRss(runtime),
      failureReason
    },
    placedCollisionGeometries: undefined
  }
}
