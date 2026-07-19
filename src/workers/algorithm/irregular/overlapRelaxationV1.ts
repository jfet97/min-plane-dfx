import { Effect } from 'effect'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece
} from '@shared/irregular/domain.js'
import { assertCanonicalGridLegalLayout } from '../../irregular/canonicalLayoutGeometry.js'
import { boundsForPoints } from '../../irregular/convexBounds.js'
import { measureConvexSatPenetration } from '../../irregular/convexSatPenetration.js'
import type { InternalPoint } from '../../irregular/internalGeometry.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'
import { IrregularGeometryInputError } from '../../irregular/services.js'
import {
  isAdmissibleRelaxationImprovement,
  measureRelaxationMetrics,
  type IntrinsicRelaxationMetrics
} from './overlapRelaxation.js'

const GRID_MM = 0.001
const DEFAULT_SQUEEZE_RATIO = 0.0005
const DEFAULT_MAXIMUM_EVALUATIONS = 250_000
const DEFAULT_MAXIMUM_SWEEPS = 100
const DEFAULT_STRIKE_LIMIT = 5
const GLOBAL_SAMPLE_COUNT = 50
const FOCUSED_SAMPLE_COUNT = 25
const GLS_WEIGHT_DECAY = 0.95
const GLS_WEIGHT_MIN_INCREASE = 1.2
const GLS_WEIGHT_MAX_INCREASE = 2
const COORDINATE_SUCCESS_MULTIPLIER = 1.1
const COORDINATE_FAILURE_MULTIPLIER = 0.5

export interface OverlapRelaxationV1Options {
  readonly targetWidth?: number
  readonly maximumEvaluations?: number
  readonly maximumSweeps?: number
  readonly strikeLimit?: number
  readonly maximumDiagnosticExactChecks?: number
}

export interface OverlapRelaxationSweepMeasurement {
  readonly sweep: number
  readonly strikeCount: number
  readonly collidingPieceCount: number
  readonly rawLossBefore: number
  readonly rawLossAfter: number
  readonly weightedLossAfter: number
  readonly collisionCountAfter: number
  readonly bestRawLoss: number
  readonly evaluations: number
}

export interface RawZeroRestorationMeasurement {
  readonly stage: 'initial' | 'sweep'
  readonly sweep: number
  readonly pieceIndex: number | undefined
  readonly restorationAttempted: true
  readonly exactGridLegal: boolean
  readonly relaxedEnvelope: {
    readonly width: number
    readonly height: number
    readonly area: number
    readonly widthDeltaFromIncumbent: number
    readonly heightDeltaFromIncumbent: number
    readonly areaDeltaFromIncumbent: number
  }
  readonly exactMetrics: IntrinsicRelaxationMetrics | undefined
  readonly intrinsicTupleComparison: -1 | 0 | 1 | undefined
}

export interface DiagnosticExactCheckMeasurement {
  readonly reason: 'new_best' | 'final'
  readonly sweep: number
  readonly pieceIndex: number | undefined
  readonly satRawLoss: number
  readonly satCollisionCount: number
  readonly exactGridLegal: boolean
  readonly relaxedEnvelope: RawZeroRestorationMeasurement['relaxedEnvelope']
  readonly exactMetrics: IntrinsicRelaxationMetrics | undefined
  readonly intrinsicTupleComparison: -1 | 0 | 1 | undefined
}

export interface FinalSatHazardMeasurement {
  readonly key: string
  readonly firstIndex: number
  readonly secondIndex: number | undefined
  readonly depthMm: number
  readonly normalizedSquaredLoss: number
  readonly weight: number
}

export interface OverlapRelaxationV1Result {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  /** Algorithm-private relaxed start material; never a publishable placement result. */
  readonly bestRelaxedSnapshot: ReadonlyArray<IrregularPlacedPiece>
  readonly separated: boolean
  readonly promotable: boolean
  readonly requestedTargetWidth: number
  readonly requestedTargetHeight: number
  readonly targetWidth: number
  readonly targetHeight: number
  readonly registeredBudget: {
    readonly maximumEvaluations: number
    readonly maximumSweeps: number
    readonly strikeLimit: number
    readonly maximumDiagnosticExactChecks: number
  }
  readonly evaluations: number
  readonly sweeps: number
  readonly strikes: number
  readonly exactCandidatesChecked: number
  readonly initialRawLoss: number
  readonly initialCollisionCount: number
  readonly bestRawLoss: number
  readonly bestCollisionCount: number
  readonly finalRawLoss: number
  readonly finalCollisionCount: number
  readonly trajectory: ReadonlyArray<OverlapRelaxationSweepMeasurement>
  readonly rawZeroRestorations: ReadonlyArray<RawZeroRestorationMeasurement>
  readonly diagnosticExactChecks: ReadonlyArray<DiagnosticExactCheckMeasurement>
  readonly finalSatHazards: ReadonlyArray<FinalSatHazardMeasurement>
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
  readonly selectedMetrics: IntrinsicRelaxationMetrics
  readonly bestFeasibleMetrics: IntrinsicRelaxationMetrics | undefined
}

interface RelaxedPieceV1 {
  readonly entry: IrregularPlacedPiece
  readonly localPoints: ReadonlyArray<InternalPoint>
  readonly scale: number
  readonly minimumDimension: number
  readonly localMinX: number
  readonly localMaxX: number
  readonly localMinY: number
  readonly localMaxY: number
  readonly localCenter: InternalPoint
}

interface RelaxedLayoutV1 {
  readonly translations: ReadonlyArray<InternalPoint>
}

interface HazardEntry {
  readonly key: string
  readonly firstIndex: number
  readonly secondIndex: number | undefined
  readonly loss: number
  readonly weight: number
  readonly depthMm: number
  readonly firstMtv: InternalPoint
}

interface CollisionTrackerV1 {
  readonly entries: ReadonlyMap<string, HazardEntry>
}

interface TrackerTotals {
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly collisionCount: number
}

interface CandidateEvaluation {
  readonly translation: InternalPoint
  readonly entries: ReadonlyArray<HazardEntry>
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly tieKey: string
}

interface EvaluationBudget {
  count: number
  exactCandidatesChecked: number
}

/** Deterministic Sparrow-style single-axis separator control for the f306 incumbent. */
export function relaxOverlappingLayoutV1(
  sheet: SheetSpec,
  incumbent: ReadonlyArray<IrregularPlacedPiece>,
  options: OverlapRelaxationV1Options = {}
): Effect.Effect<OverlapRelaxationV1Result, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const incumbentMetrics = measureRelaxationMetrics(incumbent)
    const pieces = preparePieces(incumbent)
    if (incumbentMetrics === undefined || pieces === undefined) {
      return yield* Effect.fail(
        new IrregularGeometryInputError({
          operation: 'relaxOverlappingLayoutV1',
          message: 'overlap relaxation v1 requires finite convex incumbent geometry.'
        })
      )
    }
    const requestedTargetWidth =
      options.targetWidth ?? incumbentMetrics.width * (1 - DEFAULT_SQUEEZE_RATIO)
    const requestedTargetHeight = incumbentMetrics.height
    const targetWidth = floorToGrid(requestedTargetWidth)
    const targetHeight = ceilToGrid(requestedTargetHeight)
    const maximumEvaluations = Math.max(
      1,
      Math.floor(options.maximumEvaluations ?? DEFAULT_MAXIMUM_EVALUATIONS)
    )
    const maximumSweeps = Math.max(1, Math.floor(options.maximumSweeps ?? DEFAULT_MAXIMUM_SWEEPS))
    const strikeLimit = Math.max(1, Math.floor(options.strikeLimit ?? DEFAULT_STRIKE_LIMIT))
    const maximumDiagnosticExactChecks = Math.max(
      0,
      Math.min(100, Math.floor(options.maximumDiagnosticExactChecks ?? 0))
    )
    const initialLayout = centerSplitLayout(pieces, incumbentMetrics.width, targetWidth)
    if (initialLayout === undefined) {
      return unchangedResult(
        incumbent,
        incumbentMetrics,
        requestedTargetWidth,
        requestedTargetHeight,
        targetWidth,
        targetHeight,
        {
          maximumEvaluations,
          maximumSweeps,
          strikeLimit,
          maximumDiagnosticExactChecks
        }
      )
    }

    let current = initialLayout
    let tracker = makeTracker(pieces, current, targetWidth, targetHeight)
    let totals = trackerTotals(tracker)
    const initialRawLoss = totals.rawLoss
    const initialCollisionCount = totals.collisionCount
    let bestLayout = current
    let bestTracker = tracker
    let bestTotals = totals
    let strikes = 0
    const budget: EvaluationBudget = { count: 0, exactCandidatesChecked: 0 }
    const trajectory: OverlapRelaxationSweepMeasurement[] = []
    const rawZeroRestorations: RawZeroRestorationMeasurement[] = []
    const diagnosticExactChecks: DiagnosticExactCheckMeasurement[] = []
    let bestFeasiblePlaced: ReadonlyArray<IrregularPlacedPiece> | undefined
    let bestFeasibleMetrics: IntrinsicRelaxationMetrics | undefined
    let promotablePlaced: ReadonlyArray<IrregularPlacedPiece> | undefined
    let promotableMetrics: IntrinsicRelaxationMetrics | undefined
    const considerExactCandidate = (
      placed: ReadonlyArray<IrregularPlacedPiece> | undefined
    ): void => {
      if (placed === undefined) return
      const metrics = measureRelaxationMetrics(placed)
      if (metrics === undefined) return
      if (
        bestFeasibleMetrics === undefined ||
        compareIntrinsicTuple(metrics, bestFeasibleMetrics) < 0
      ) {
        bestFeasiblePlaced = placed
        bestFeasibleMetrics = metrics
      }
      if (isAdmissibleRelaxationImprovement(incumbentMetrics, metrics)) {
        promotablePlaced = placed
        promotableMetrics = metrics
      }
    }

    if (totals.rawLoss === 0) {
      budget.exactCandidatesChecked += 1
      const restoration = yield* restoreRawZeroSnapshot({
        sheet,
        pieces,
        layout: current,
        incumbentMetrics,
        stage: 'initial',
        sweep: -1,
        pieceIndex: undefined
      })
      rawZeroRestorations.push(restoration.measurement)
      considerExactCandidate(restoration.placed)
    }

    for (
      let sweep = 0;
      sweep < maximumSweeps &&
      strikes < strikeLimit &&
      budget.count < maximumEvaluations &&
      promotablePlaced === undefined;
      sweep += 1
    ) {
      const rawLossBefore = totals.rawLoss
      const collidingPieces = collidingPieceIndices(pieces.length, tracker)
      let zeroAtPieceIndex: number | undefined
      for (const pieceIndex of collidingPieces) {
        if (budget.count >= maximumEvaluations) break
        if (pieceRawLoss(pieceIndex, tracker) <= 0) continue
        const candidate = searchMovedPiece({
          pieces,
          layout: current,
          tracker,
          pieceIndex,
          targetWidth,
          targetHeight,
          sweep,
          maximumEvaluations,
          budget
        })
        if (candidate === undefined) continue
        const currentWeightedLoss = pieceWeightedLoss(pieceIndex, tracker)
        if (candidate.weightedLoss > currentWeightedLoss) continue
        current = movePiece(current, pieceIndex, candidate.translation)
        tracker = applyMovedPieceEvaluation(tracker, pieceIndex, candidate.entries)
        totals = trackerTotals(tracker)
        if (totals.rawLoss < bestTotals.rawLoss) {
          bestLayout = current
          bestTracker = tracker
          bestTotals = totals
          if (diagnosticExactChecks.length < maximumDiagnosticExactChecks) {
            budget.exactCandidatesChecked += 1
            const diagnostic = yield* performDiagnosticExactCheck({
              sheet,
              pieces,
              layout: bestLayout,
              incumbentMetrics,
              reason: 'new_best',
              sweep,
              pieceIndex,
              satTotals: bestTotals
            })
            diagnosticExactChecks.push(diagnostic.measurement)
            considerExactCandidate(diagnostic.placed)
          }
        }
        if (promotablePlaced !== undefined) break
        if (totals.rawLoss === 0) {
          zeroAtPieceIndex = pieceIndex
          break
        }
      }

      totals = trackerTotals(tracker)
      if (promotablePlaced !== undefined) {
        trajectory.push({
          sweep,
          strikeCount: strikes,
          collidingPieceCount: collidingPieces.length,
          rawLossBefore,
          rawLossAfter: totals.rawLoss,
          weightedLossAfter: totals.weightedLoss,
          collisionCountAfter: totals.collisionCount,
          bestRawLoss: bestTotals.rawLoss,
          evaluations: budget.count
        })
        break
      }
      if (totals.rawLoss === 0) {
        budget.exactCandidatesChecked += 1
        const restoration = yield* restoreRawZeroSnapshot({
          sheet,
          pieces,
          layout: current,
          incumbentMetrics,
          stage: 'sweep',
          sweep,
          pieceIndex: zeroAtPieceIndex
        })
        rawZeroRestorations.push(restoration.measurement)
        considerExactCandidate(restoration.placed)
        if (promotablePlaced !== undefined) {
          trajectory.push({
            sweep,
            strikeCount: strikes,
            collidingPieceCount: collidingPieces.length,
            rawLossBefore,
            rawLossAfter: totals.rawLoss,
            weightedLossAfter: totals.weightedLoss,
            collisionCountAfter: totals.collisionCount,
            bestRawLoss: bestTotals.rawLoss,
            evaluations: budget.count
          })
          break
        }
      }

      tracker = updateAllHazardWeights(tracker)
      const substantialImprovement = bestTotals.rawLoss < rawLossBefore * 0.98
      strikes = substantialImprovement ? 0 : strikes + 1
      current = bestLayout
      tracker = restoreLossesKeepingWeights(tracker, bestTracker)
      totals = trackerTotals(tracker)
      trajectory.push({
        sweep,
        strikeCount: strikes,
        collidingPieceCount: collidingPieces.length,
        rawLossBefore,
        rawLossAfter: totals.rawLoss,
        weightedLossAfter: totals.weightedLoss,
        collisionCountAfter: totals.collisionCount,
        bestRawLoss: bestTotals.rawLoss,
        evaluations: budget.count
      })
    }

    if (
      promotablePlaced === undefined &&
      diagnosticExactChecks.length < maximumDiagnosticExactChecks
    ) {
      budget.exactCandidatesChecked += 1
      const diagnostic = yield* performDiagnosticExactCheck({
        sheet,
        pieces,
        layout: bestLayout,
        incumbentMetrics,
        reason: 'final',
        sweep: trajectory.length,
        pieceIndex: undefined,
        satTotals: bestTotals
      })
      diagnosticExactChecks.push(diagnostic.measurement)
      considerExactCandidate(diagnostic.placed)
    }

    const validSelectedMetrics = promotableMetrics ?? incumbentMetrics
    const promotable = promotablePlaced !== undefined
    return {
      placedCollisionGeometries: promotablePlaced ?? incumbent,
      bestRelaxedSnapshot: rebuildSnapshotV1(pieces, bestLayout) ?? incumbent,
      separated: bestFeasiblePlaced !== undefined,
      promotable,
      requestedTargetWidth,
      requestedTargetHeight,
      targetWidth,
      targetHeight,
      registeredBudget: {
        maximumEvaluations,
        maximumSweeps,
        strikeLimit,
        maximumDiagnosticExactChecks
      },
      evaluations: budget.count,
      sweeps: trajectory.length,
      strikes,
      exactCandidatesChecked: budget.exactCandidatesChecked,
      initialRawLoss,
      initialCollisionCount,
      bestRawLoss: bestTotals.rawLoss,
      bestCollisionCount: bestTotals.collisionCount,
      finalRawLoss: totals.rawLoss,
      finalCollisionCount: totals.collisionCount,
      trajectory,
      rawZeroRestorations,
      diagnosticExactChecks,
      finalSatHazards: positiveHazardMeasurements(tracker),
      incumbentMetrics,
      selectedMetrics: validSelectedMetrics,
      bestFeasibleMetrics
    }
  })
}

function searchMovedPiece(input: {
  readonly pieces: ReadonlyArray<RelaxedPieceV1>
  readonly layout: RelaxedLayoutV1
  readonly tracker: CollisionTrackerV1
  readonly pieceIndex: number
  readonly targetWidth: number
  readonly targetHeight: number
  readonly sweep: number
  readonly maximumEvaluations: number
  readonly budget: EvaluationBudget
}): CandidateEvaluation | undefined {
  const piece = input.pieces[input.pieceIndex]
  const currentTranslation = input.layout.translations[input.pieceIndex]
  if (piece === undefined || currentTranslation === undefined) return undefined
  const candidates: InternalPoint[] = [currentTranslation]
  const xMin = -piece.localMinX
  const xMax = input.targetWidth - piece.localMaxX
  const yMin = -piece.localMinY
  const yMax = input.targetHeight - piece.localMaxY
  if (xMin <= xMax && yMin <= yMax) {
    for (let sampleIndex = 0; sampleIndex < GLOBAL_SAMPLE_COUNT; sampleIndex += 1) {
      const sequenceIndex =
        input.sweep * input.pieces.length * GLOBAL_SAMPLE_COUNT +
        input.pieceIndex * GLOBAL_SAMPLE_COUNT +
        sampleIndex +
        1
      candidates.push({
        x: interpolate(xMin, xMax, halton(sequenceIndex, 2)),
        y: interpolate(yMin, yMax, halton(sequenceIndex, 3))
      })
    }
    const focusRadius = piece.minimumDimension
    for (let sampleIndex = 0; sampleIndex < FOCUSED_SAMPLE_COUNT; sampleIndex += 1) {
      const sequenceIndex =
        input.sweep * input.pieces.length * FOCUSED_SAMPLE_COUNT +
        input.pieceIndex * FOCUSED_SAMPLE_COUNT +
        sampleIndex +
        1
      candidates.push({
        x: clamp(
          currentTranslation.x + (halton(sequenceIndex, 5) * 2 - 1) * focusRadius,
          xMin,
          xMax
        ),
        y: clamp(
          currentTranslation.y + (halton(sequenceIndex, 7) * 2 - 1) * focusRadius,
          yMin,
          yMax
        )
      })
    }
  }
  candidates.push(...incidentMtvCandidates(input.pieceIndex, currentTranslation, input.tracker))

  const evaluated: CandidateEvaluation[] = []
  const seen = new Set<string>()
  for (const uncanonicalizedTranslation of candidates) {
    if (input.budget.count >= input.maximumEvaluations) break
    const translation = canonicalGridPoint(uncanonicalizedTranslation)
    const key = translationKey(translation)
    if (seen.has(key)) continue
    seen.add(key)
    evaluated.push(
      evaluateMovedPiece(
        input.pieces,
        input.layout,
        input.tracker,
        input.pieceIndex,
        translation,
        input.targetWidth,
        input.targetHeight
      )
    )
    input.budget.count += 1
  }
  const starts = evaluated.toSorted(compareCandidateEvaluations).slice(0, 3)
  for (const start of starts) {
    if (input.budget.count >= input.maximumEvaluations) break
    evaluated.push(
      coordinateDescent({
        ...input,
        start,
        xMin,
        xMax,
        yMin,
        yMax
      })
    )
  }
  return evaluated.toSorted(compareCandidateEvaluations)[0]
}

function coordinateDescent(input: {
  readonly pieces: ReadonlyArray<RelaxedPieceV1>
  readonly layout: RelaxedLayoutV1
  readonly tracker: CollisionTrackerV1
  readonly pieceIndex: number
  readonly targetWidth: number
  readonly targetHeight: number
  readonly maximumEvaluations: number
  readonly budget: EvaluationBudget
  readonly start: CandidateEvaluation
  readonly xMin: number
  readonly xMax: number
  readonly yMin: number
  readonly yMax: number
}): CandidateEvaluation {
  const piece = input.pieces[input.pieceIndex]
  if (piece === undefined) return input.start
  let current = input.start
  let xStep = piece.minimumDimension * 0.25
  let yStep = piece.minimumDimension * 0.25
  const stepLimit = piece.minimumDimension * 0.02
  let axisIndex = 0
  let iterations = 0
  while (
    (xStep >= stepLimit || yStep >= stepLimit) &&
    input.budget.count < input.maximumEvaluations &&
    iterations < 256
  ) {
    const axis = axisIndex % 4
    const moves = coordinateMoves(axis, xStep, yStep)
    const candidates: CandidateEvaluation[] = []
    const seen = new Set<string>()
    for (const move of moves) {
      if (input.budget.count >= input.maximumEvaluations) break
      const translation = canonicalGridPoint({
        x: clamp(current.translation.x + move.x, input.xMin, input.xMax),
        y: clamp(current.translation.y + move.y, input.yMin, input.yMax)
      })
      const key = translationKey(translation)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(
        evaluateMovedPiece(
          input.pieces,
          input.layout,
          input.tracker,
          input.pieceIndex,
          translation,
          input.targetWidth,
          input.targetHeight
        )
      )
      input.budget.count += 1
    }
    const best = candidates.toSorted(compareCandidateEvaluations)[0]
    const strictlyBetter = best !== undefined && best.weightedLoss < current.weightedLoss
    if (best !== undefined && best.weightedLoss <= current.weightedLoss) current = best
    const multiplier = strictlyBetter
      ? COORDINATE_SUCCESS_MULTIPLIER
      : COORDINATE_FAILURE_MULTIPLIER
    if (axis === 0) xStep *= multiplier
    if (axis === 1) yStep *= multiplier
    if (axis >= 2) {
      const diagonalMultiplier = Math.sqrt(multiplier)
      xStep *= diagonalMultiplier
      yStep *= diagonalMultiplier
    }
    if (!strictlyBetter) axisIndex += 1
    iterations += 1
  }
  return current
}

function evaluateMovedPiece(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1,
  tracker: CollisionTrackerV1,
  pieceIndex: number,
  translation: InternalPoint,
  targetWidth: number,
  targetHeight: number
): CandidateEvaluation {
  const piece = pieces[pieceIndex]
  const canonicalTranslation = canonicalGridPoint(translation)
  if (piece === undefined) {
    return {
      translation: canonicalTranslation,
      entries: [],
      rawLoss: Infinity,
      weightedLoss: Infinity,
      tieKey: ''
    }
  }
  const polygon = translatedPolygon(piece, canonicalTranslation)
  const entries: HazardEntry[] = [
    ...wallEntries(piece, pieceIndex, polygon, targetWidth, targetHeight, tracker)
  ]
  for (let otherIndex = 0; otherIndex < pieces.length; otherIndex += 1) {
    if (otherIndex === pieceIndex) continue
    const otherPiece = pieces[otherIndex]
    const otherTranslation = layout.translations[otherIndex]
    if (otherPiece === undefined || otherTranslation === undefined) continue
    const firstIndex = Math.max(pieceIndex, otherIndex)
    const secondIndex = Math.min(pieceIndex, otherIndex)
    const key = `pair:${secondIndex}:${firstIndex}`
    const existingWeight = tracker.entries.get(key)?.weight ?? 1
    const penetration = measureConvexSatPenetration(
      polygon,
      translatedPolygon(otherPiece, otherTranslation)
    )
    const scale = Math.min(piece.scale, otherPiece.scale)
    const normalized = penetration === undefined ? 0 : penetration.depth / scale
    const movingMtv = penetration?.translation ?? { x: 0, y: 0 }
    entries.push({
      key,
      firstIndex,
      secondIndex,
      loss: normalized * normalized,
      weight: existingWeight,
      depthMm: penetration?.depth ?? 0,
      firstMtv:
        pieceIndex === firstIndex
          ? movingMtv
          : { x: -movingMtv.x, y: -movingMtv.y }
    })
  }
  let rawLoss = 0
  let weightedLoss = 0
  for (const entry of entries) {
    rawLoss += entry.loss
    weightedLoss += entry.loss * entry.weight
  }
  return {
    translation: canonicalTranslation,
    entries,
    rawLoss,
    weightedLoss,
    tieKey: translationKey(canonicalTranslation)
  }
}

function makeTracker(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1,
  targetWidth: number,
  targetHeight: number
): CollisionTrackerV1 {
  let tracker: CollisionTrackerV1 = { entries: new Map() }
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
    const translation = layout.translations[pieceIndex]
    if (translation === undefined) continue
    const evaluation = evaluateMovedPiece(
      pieces,
      layout,
      tracker,
      pieceIndex,
      translation,
      targetWidth,
      targetHeight
    )
    tracker = applyMovedPieceEvaluation(tracker, pieceIndex, evaluation.entries)
  }
  return tracker
}

function applyMovedPieceEvaluation(
  tracker: CollisionTrackerV1,
  pieceIndex: number,
  replacements: ReadonlyArray<HazardEntry>
): CollisionTrackerV1 {
  const entries = new Map(tracker.entries)
  for (const [key, entry] of entries) {
    if (entry.firstIndex === pieceIndex || entry.secondIndex === pieceIndex) entries.delete(key)
  }
  for (const replacement of replacements) entries.set(replacement.key, replacement)
  return { entries }
}

function wallEntries(
  piece: RelaxedPieceV1,
  pieceIndex: number,
  polygon: ReadonlyArray<InternalPoint>,
  targetWidth: number,
  targetHeight: number,
  tracker: CollisionTrackerV1
): ReadonlyArray<HazardEntry> {
  const bounds = boundsForPoints(polygon)
  if (bounds === undefined) return []
  const specifications: ReadonlyArray<
    readonly [string, number, InternalPoint]
  > = [
    ['left', -bounds.minX, { x: 1, y: 0 }],
    ['bottom', -bounds.minY, { x: 0, y: 1 }],
    ['right', bounds.maxX - targetWidth, { x: -1, y: 0 }],
    ['top', bounds.maxY - targetHeight, { x: 0, y: -1 }]
  ]
  return specifications.map(([side, unboundedDepth, direction]) => {
    const depth = Math.max(0, unboundedDepth)
    const normalized = depth / piece.scale
    const key = `wall:${pieceIndex}:${side}`
    return {
      key,
      firstIndex: pieceIndex,
      secondIndex: undefined,
      loss: normalized * normalized,
      weight: tracker.entries.get(key)?.weight ?? 1,
      depthMm: depth,
      firstMtv: { x: direction.x * depth, y: direction.y * depth }
    }
  })
}

function updateAllHazardWeights(tracker: CollisionTrackerV1): CollisionTrackerV1 {
  let maximumLoss = 0
  for (const entry of tracker.entries.values()) maximumLoss = Math.max(maximumLoss, entry.loss)
  if (maximumLoss === 0) return tracker
  const entries = new Map<string, HazardEntry>()
  for (const [key, entry] of tracker.entries) {
    const multiplier =
      entry.loss === 0
        ? GLS_WEIGHT_DECAY
        : GLS_WEIGHT_MIN_INCREASE +
          (GLS_WEIGHT_MAX_INCREASE - GLS_WEIGHT_MIN_INCREASE) *
            (entry.loss / maximumLoss)
    entries.set(key, { ...entry, weight: Math.max(1, entry.weight * multiplier) })
  }
  return { entries }
}

function restoreLossesKeepingWeights(
  weighted: CollisionTrackerV1,
  bestRaw: CollisionTrackerV1
): CollisionTrackerV1 {
  const entries = new Map<string, HazardEntry>()
  for (const [key, bestEntry] of bestRaw.entries) {
    entries.set(key, { ...bestEntry, weight: weighted.entries.get(key)?.weight ?? bestEntry.weight })
  }
  return { entries }
}

function trackerTotals(tracker: CollisionTrackerV1): TrackerTotals {
  let rawLoss = 0
  let weightedLoss = 0
  let collisionCount = 0
  for (const entry of tracker.entries.values()) {
    rawLoss += entry.loss
    weightedLoss += entry.loss * entry.weight
    if (entry.loss > 0) collisionCount += 1
  }
  return { rawLoss, weightedLoss, collisionCount }
}

function pieceRawLoss(pieceIndex: number, tracker: CollisionTrackerV1): number {
  let loss = 0
  for (const entry of tracker.entries.values()) {
    if (entry.firstIndex === pieceIndex || entry.secondIndex === pieceIndex) loss += entry.loss
  }
  return loss
}

function pieceWeightedLoss(pieceIndex: number, tracker: CollisionTrackerV1): number {
  let loss = 0
  for (const entry of tracker.entries.values()) {
    if (entry.firstIndex === pieceIndex || entry.secondIndex === pieceIndex) {
      loss += entry.loss * entry.weight
    }
  }
  return loss
}

function collidingPieceIndices(
  pieceCount: number,
  tracker: CollisionTrackerV1
): ReadonlyArray<number> {
  return Array.from({ length: pieceCount }, (_, index) => index).filter(
    (index) => pieceRawLoss(index, tracker) > 0
  )
}

function incidentMtvCandidates(
  pieceIndex: number,
  current: InternalPoint,
  tracker: CollisionTrackerV1
): ReadonlyArray<InternalPoint> {
  const candidates: InternalPoint[] = []
  for (const entry of tracker.entries.values()) {
    let mtv: InternalPoint | undefined
    if (entry.loss <= 0) continue
    if (entry.firstIndex === pieceIndex) mtv = entry.firstMtv
    if (entry.secondIndex === pieceIndex) mtv = { x: -entry.firstMtv.x, y: -entry.firstMtv.y }
    if (mtv === undefined) continue
    const length = Math.hypot(mtv.x, mtv.y)
    if (!Number.isFinite(length) || length <= 0) continue
    const outward = { x: (mtv.x / length) * GRID_MM, y: (mtv.y / length) * GRID_MM }
    candidates.push(
      { x: current.x + mtv.x + outward.x, y: current.y + mtv.y + outward.y },
      {
        x: current.x + mtv.x * 0.5 + outward.x,
        y: current.y + mtv.y * 0.5 + outward.y
      }
    )
  }
  return candidates
}

function preparePieces(
  incumbent: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<RelaxedPieceV1> | undefined {
  const pieces: RelaxedPieceV1[] = []
  for (const entry of incumbent) {
    const localPoints = entry.collisionGeometry.polygon.points.map(({ x, y }) => ({ x, y }))
    const bounds = boundsForPoints(localPoints)
    if (bounds === undefined) return undefined
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const minimumDimension = Math.min(width, height)
    const scale = Math.sqrt(Math.max(width * height, GRID_MM * GRID_MM))
    const localCenter = polygonCenter(localPoints)
    if (
      localCenter === undefined ||
      !Number.isFinite(minimumDimension) ||
      minimumDimension <= 0 ||
      !Number.isFinite(scale)
    ) {
      return undefined
    }
    pieces.push({
      entry,
      localPoints,
      scale,
      minimumDimension,
      localMinX: bounds.minX,
      localMaxX: bounds.maxX,
      localMinY: bounds.minY,
      localMaxY: bounds.maxY,
      localCenter
    })
  }
  return pieces
}

function centerSplitLayout(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  incumbentWidth: number,
  targetWidth: number
): RelaxedLayoutV1 | undefined {
  const allPoints = pieces.flatMap(({ entry, localPoints }) =>
    localPoints.map(({ x, y }) => ({
      x: x + entry.placement.transform.translateX,
      y: y + entry.placement.transform.translateY
    }))
  )
  const bounds = boundsForPoints(allPoints)
  if (bounds === undefined || !Number.isFinite(targetWidth) || targetWidth <= 0) return undefined
  const split = bounds.minX + incumbentWidth / 2
  const delta = targetWidth - incumbentWidth
  return {
    translations: pieces.map(({ entry, localCenter }) => {
      const x = entry.placement.transform.translateX - bounds.minX
      const y = entry.placement.transform.translateY - bounds.minY
      const absoluteCenterX = entry.placement.transform.translateX + localCenter.x
      return canonicalGridPoint({ x: absoluteCenterX > split ? x + delta : x, y })
    })
  }
}

function restoreRawZeroSnapshot(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<RelaxedPieceV1>
  readonly layout: RelaxedLayoutV1
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
  readonly stage: RawZeroRestorationMeasurement['stage']
  readonly sweep: number
  readonly pieceIndex: number | undefined
}): Effect.Effect<
  {
    readonly placed: ReadonlyArray<IrregularPlacedPiece> | undefined
    readonly measurement: RawZeroRestorationMeasurement
  },
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const relaxedEnvelope = layoutEnvelope(input.pieces, input.layout)
    const placed = yield* rebuildAndValidateV1(input.sheet, input.pieces, input.layout)
    const exactMetrics = placed === undefined ? undefined : measureRelaxationMetrics(placed)
    return {
      placed,
      measurement: {
        stage: input.stage,
        sweep: input.sweep,
        pieceIndex: input.pieceIndex,
        restorationAttempted: true,
        exactGridLegal: placed !== undefined,
        relaxedEnvelope: {
          width: relaxedEnvelope.width,
          height: relaxedEnvelope.height,
          area: relaxedEnvelope.area,
          widthDeltaFromIncumbent: relaxedEnvelope.width - input.incumbentMetrics.width,
          heightDeltaFromIncumbent: relaxedEnvelope.height - input.incumbentMetrics.height,
          areaDeltaFromIncumbent: relaxedEnvelope.area - input.incumbentMetrics.area
        },
        exactMetrics,
        intrinsicTupleComparison:
          exactMetrics === undefined
            ? undefined
            : compareIntrinsicTuple(exactMetrics, input.incumbentMetrics)
      }
    }
  })
}

function performDiagnosticExactCheck(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<RelaxedPieceV1>
  readonly layout: RelaxedLayoutV1
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
  readonly reason: DiagnosticExactCheckMeasurement['reason']
  readonly sweep: number
  readonly pieceIndex: number | undefined
  readonly satTotals: TrackerTotals
}): Effect.Effect<
  {
    readonly placed: ReadonlyArray<IrregularPlacedPiece> | undefined
    readonly measurement: DiagnosticExactCheckMeasurement
  },
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const relaxedEnvelope = layoutEnvelope(input.pieces, input.layout)
    const placed = yield* rebuildAndValidateV1(input.sheet, input.pieces, input.layout)
    const exactMetrics = placed === undefined ? undefined : measureRelaxationMetrics(placed)
    return {
      placed,
      measurement: {
        reason: input.reason,
        sweep: input.sweep,
        pieceIndex: input.pieceIndex,
        satRawLoss: input.satTotals.rawLoss,
        satCollisionCount: input.satTotals.collisionCount,
        exactGridLegal: placed !== undefined,
        relaxedEnvelope: {
          width: relaxedEnvelope.width,
          height: relaxedEnvelope.height,
          area: relaxedEnvelope.area,
          widthDeltaFromIncumbent: relaxedEnvelope.width - input.incumbentMetrics.width,
          heightDeltaFromIncumbent: relaxedEnvelope.height - input.incumbentMetrics.height,
          areaDeltaFromIncumbent: relaxedEnvelope.area - input.incumbentMetrics.area
        },
        exactMetrics,
        intrinsicTupleComparison:
          exactMetrics === undefined
            ? undefined
            : compareIntrinsicTuple(exactMetrics, input.incumbentMetrics)
      }
    }
  })
}

function positiveHazardMeasurements(
  tracker: CollisionTrackerV1
): ReadonlyArray<FinalSatHazardMeasurement> {
  return [...tracker.entries.values()]
    .filter(({ loss }) => loss > 0)
    .toSorted((first, second) =>
      first.key < second.key ? -1 : first.key > second.key ? 1 : 0
    )
    .map(({ key, firstIndex, secondIndex, depthMm, loss, weight }) => ({
      key,
      firstIndex,
      secondIndex,
      depthMm,
      normalizedSquaredLoss: loss,
      weight
    }))
}

function layoutEnvelope(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1
): { readonly width: number; readonly height: number; readonly area: number } {
  const points = pieces.flatMap((piece, index) => {
    const translation = layout.translations[index]
    return translation === undefined ? [] : translatedPolygon(piece, translation)
  })
  const bounds = boundsForPoints(points)
  if (bounds === undefined) return { width: 0, height: 0, area: 0 }
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  return { width, height, area: width * height }
}

function compareIntrinsicTuple(
  first: IntrinsicRelaxationMetrics,
  second: IntrinsicRelaxationMetrics
): -1 | 0 | 1 {
  const values: ReadonlyArray<readonly [number, number]> = [
    [first.maxSide, second.maxSide],
    [first.area, second.area],
    [first.topology.enclosedCavityCount, second.topology.enclosedCavityCount],
    [first.topology.largestOccupiedHullGapRatio, second.topology.largestOccupiedHullGapRatio],
    [first.topology.positiveContactComponentCount, second.topology.positiveContactComponentCount],
    [first.topology.isolatedPieceCount, second.topology.isolatedPieceCount],
    [-first.nearCompleteStructuralContactCount, -second.nearCompleteStructuralContactCount],
    [
      -first.dominantNearCompleteStructuralContactCount,
      -second.dominantNearCompleteStructuralContactCount
    ]
  ]
  for (const [left, right] of values) {
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function rebuildAndValidateV1(
  sheet: SheetSpec,
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1
): Effect.Effect<ReadonlyArray<IrregularPlacedPiece> | undefined, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const normalized = bottomLeftGridTranslations(pieces, layout)
    if (normalized === undefined) return undefined
    const placed: IrregularPlacedPiece[] = []
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]
      const translation = normalized[index]
      if (piece === undefined || translation === undefined) return undefined
      const candidate = new IrregularPlacementCandidate({
        pieceId: piece.entry.placement.pieceId ?? piece.entry.placement.sourcePieceId,
        transform: piece.entry.collisionGeometry.transform,
        point: translation,
        diagnostics: []
      })
      const legal = yield* PlacementValidation.check({
        sheet,
        placed,
        moving: piece.entry.collisionGeometry,
        candidate
      })
      if (!legal) return undefined
      placed.push(
        new IrregularPlacedPiece({
          placement: new IrregularPlacement({
            ...piece.entry.placement,
            transform: {
              ...piece.entry.placement.transform,
              translateX: translation.x,
              translateY: translation.y
            }
          }),
          collisionGeometry: piece.entry.collisionGeometry
        })
      )
    }
    return assertCanonicalGridLegalLayout(sheet, placed) ? placed : undefined
  })
}

function rebuildSnapshotV1(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1
): ReadonlyArray<IrregularPlacedPiece> | undefined {
  const normalized = bottomLeftGridTranslations(pieces, layout)
  if (normalized === undefined) return undefined
  const placed: IrregularPlacedPiece[] = []
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    const translation = normalized[index]
    if (piece === undefined || translation === undefined) return undefined
    placed.push(
      new IrregularPlacedPiece({
        placement: new IrregularPlacement({
          ...piece.entry.placement,
          transform: {
            ...piece.entry.placement.transform,
            translateX: translation.x,
            translateY: translation.y
          }
        }),
        collisionGeometry: piece.entry.collisionGeometry
      })
    )
  }
  return placed
}

function bottomLeftGridTranslations(
  pieces: ReadonlyArray<RelaxedPieceV1>,
  layout: RelaxedLayoutV1
): ReadonlyArray<InternalPoint> | undefined {
  const points = pieces.flatMap((piece, index) => {
    const translation = layout.translations[index]
    return translation === undefined ? [] : translatedPolygon(piece, translation)
  })
  const bounds = boundsForPoints(points)
  if (bounds === undefined) return undefined
  return layout.translations.map(({ x, y }) => ({
    x: toGrid(x - bounds.minX),
    y: toGrid(y - bounds.minY)
  }))
}

function unchangedResult(
  incumbent: ReadonlyArray<IrregularPlacedPiece>,
  metrics: IntrinsicRelaxationMetrics,
  requestedTargetWidth: number,
  requestedTargetHeight: number,
  targetWidth: number,
  targetHeight: number,
  registeredBudget: OverlapRelaxationV1Result['registeredBudget']
): OverlapRelaxationV1Result {
  return {
    placedCollisionGeometries: incumbent,
    bestRelaxedSnapshot: incumbent,
    separated: false,
    promotable: false,
    requestedTargetWidth,
    requestedTargetHeight,
    targetWidth,
    targetHeight,
    registeredBudget,
    evaluations: 0,
    sweeps: 0,
    strikes: 0,
    exactCandidatesChecked: 0,
    initialRawLoss: 0,
    initialCollisionCount: 0,
    bestRawLoss: 0,
    bestCollisionCount: 0,
    finalRawLoss: 0,
    finalCollisionCount: 0,
    trajectory: [],
    rawZeroRestorations: [],
    diagnosticExactChecks: [],
    finalSatHazards: [],
    incumbentMetrics: metrics,
    selectedMetrics: metrics,
    bestFeasibleMetrics: undefined
  }
}

function translatedPolygon(
  piece: RelaxedPieceV1,
  translation: InternalPoint
): ReadonlyArray<InternalPoint> {
  return piece.localPoints.map(({ x, y }) => ({ x: x + translation.x, y: y + translation.y }))
}

function movePiece(
  layout: RelaxedLayoutV1,
  pieceIndex: number,
  translation: InternalPoint
): RelaxedLayoutV1 {
  const translations = [...layout.translations]
  translations[pieceIndex] = translation
  return { translations }
}

function coordinateMoves(
  axis: number,
  xStep: number,
  yStep: number
): readonly [InternalPoint, InternalPoint] {
  switch (axis) {
    case 0:
      return [{ x: xStep, y: 0 }, { x: -xStep, y: 0 }]
    case 1:
      return [{ x: 0, y: yStep }, { x: 0, y: -yStep }]
    case 2:
      return [{ x: xStep, y: yStep }, { x: -xStep, y: -yStep }]
    default:
      return [{ x: -xStep, y: yStep }, { x: xStep, y: -yStep }]
  }
}

function compareCandidateEvaluations(
  first: CandidateEvaluation,
  second: CandidateEvaluation
): number {
  if (first.weightedLoss !== second.weightedLoss) {
    return first.weightedLoss < second.weightedLoss ? -1 : 1
  }
  if (first.rawLoss !== second.rawLoss) return first.rawLoss < second.rawLoss ? -1 : 1
  return first.tieKey < second.tieKey ? -1 : first.tieKey > second.tieKey ? 1 : 0
}

function polygonCenter(points: ReadonlyArray<InternalPoint>): InternalPoint | undefined {
  if (points.length === 0) return undefined
  let x = 0
  let y = 0
  for (const point of points) {
    x += point.x
    y += point.y
  }
  x /= points.length
  y /= points.length
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

function halton(index: number, base: number): number {
  let result = 0
  let fraction = 1 / base
  let remaining = index
  while (remaining > 0) {
    result += fraction * (remaining % base)
    remaining = Math.floor(remaining / base)
    fraction /= base
  }
  return result
}

function interpolate(minimum: number, maximum: number, ratio: number): number {
  return minimum + (maximum - minimum) * ratio
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function translationKey({ x, y }: InternalPoint): string {
  return `${Math.round(x / GRID_MM)},${Math.round(y / GRID_MM)}`
}

function toGrid(value: number): number {
  return Math.round(value / GRID_MM) * GRID_MM
}

function canonicalGridPoint(point: InternalPoint): InternalPoint {
  return { x: toGrid(point.x), y: toGrid(point.y) }
}

function floorToGrid(value: number): number {
  return Math.floor(value / GRID_MM) * GRID_MM
}

function ceilToGrid(value: number): number {
  return Math.ceil(value / GRID_MM) * GRID_MM
}
