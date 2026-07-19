import { Effect } from 'effect'
import { SheetSpec } from '@shared/domain/nesting.js'
import {
  IrregularPlacement,
  IrregularPlacementCandidate,
  IrregularPlacedPiece
} from '@shared/irregular/domain.js'
import {
  assertCanonicalGridLegalLayout,
  measureCanonicalLayoutTopology,
  type CanonicalLayoutTopology
} from '../../irregular/canonicalLayoutGeometry.js'
import { boundsForPoints } from '../../irregular/convexBounds.js'
import { measureConvexSatPenetration } from '../../irregular/convexSatPenetration.js'
import type { InternalPoint } from '../../irregular/internalGeometry.js'
import { PlacementValidation } from '../../irregular/placementValidation.js'
import type { IrregularGeometryInputError } from '../../irregular/services.js'
import { IrregularBeamState } from './irregularBeamState.js'
import { OverlapRelaxationTracker } from './overlapRelaxationTracker.js'

const GRID_MM = 0.001
const DEFAULT_SQUEEZE_RATIOS = [0.005, 0.01, 0.02] as const

export interface OverlapRelaxationOptions {
  readonly squeezeRatios?: ReadonlyArray<number>
  readonly maximumEvaluations?: number
  readonly completedAttemptBudget?: number
}

export interface IntrinsicRelaxationMetrics {
  readonly width: number
  readonly height: number
  readonly maxSide: number
  readonly area: number
  readonly span: number
  readonly topology: CanonicalLayoutTopology
  readonly nearCompleteStructuralContactCount: number
  readonly dominantNearCompleteStructuralContactCount: number
  readonly sharedCollisionBoundaryContactUnits: number
}

export interface OverlapRelaxationResult {
  readonly placedCollisionGeometries: ReadonlyArray<IrregularPlacedPiece>
  readonly accepted: boolean
  readonly evaluations: number
  readonly completedAttempts: number
  readonly exactCandidatesChecked: number
  readonly squeezeRatiosCompleted: ReadonlyArray<number>
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
  readonly selectedMetrics: IntrinsicRelaxationMetrics
}

interface RelaxedPiece {
  readonly entry: IrregularPlacedPiece
  readonly localPoints: ReadonlyArray<InternalPoint>
  readonly scale: number
  readonly minimumDimension: number
}

interface RelaxedLayout {
  readonly translations: ReadonlyArray<InternalPoint>
}

interface Violation {
  readonly key: string
  readonly firstIndex: number
  readonly secondIndex: number | undefined
  readonly firstMtv: InternalPoint
  readonly depth: number
  readonly energy: number
}

interface LayoutLoss {
  readonly rawLoss: number
  readonly weightedLoss: number
  readonly pieceWeightedLoss: ReadonlyArray<number>
  readonly violations: ReadonlyArray<Violation>
}

interface SearchBudget {
  evaluations: number
  completedAttempts: number
  exactCandidatesChecked: number
}

/** Standalone fixed-rotation translation repair; overlapping states never become beam states. */
export function relaxOverlappingLayout(
  sheet: SheetSpec,
  incumbent: ReadonlyArray<IrregularPlacedPiece>,
  options: OverlapRelaxationOptions = {}
): Effect.Effect<OverlapRelaxationResult, IrregularGeometryInputError> {
  return Effect.gen(function* () {
    const incumbentMetrics = measureIntrinsicMetrics(incumbent)
    if (incumbentMetrics === undefined) {
      return makeUnchangedResult(incumbent, emptyMetrics(), {
        evaluations: 0,
        completedAttempts: 0,
        exactCandidatesChecked: 0
      })
    }
    const pieces = prepareRelaxedPieces(incumbent)
    if (pieces === undefined) {
      return makeUnchangedResult(incumbent, incumbentMetrics, {
        evaluations: 0,
        completedAttempts: 0,
        exactCandidatesChecked: 0
      })
    }

    const maximumEvaluations = Math.max(1, Math.floor(options.maximumEvaluations ?? 25_000))
    const completedAttemptBudget = Math.max(
      1,
      Math.floor(options.completedAttemptBudget ?? 768)
    )
    const squeezeRatios = options.squeezeRatios ?? DEFAULT_SQUEEZE_RATIOS
    const validSqueezeRatios = squeezeRatios.filter(
      (ratio) => Number.isFinite(ratio) && ratio > 0 && ratio < 1
    )
    const budget: SearchBudget = {
      evaluations: 0,
      completedAttempts: 0,
      exactCandidatesChecked: 0
    }
    const completedRatios: number[] = []
    let selected = incumbent
    let selectedMetrics = incumbentMetrics

    for (let ratioIndex = 0; ratioIndex < validSqueezeRatios.length; ratioIndex += 1) {
      const squeezeRatio = validSqueezeRatios[ratioIndex]
      if (squeezeRatio === undefined) continue
      if (
        budget.evaluations >= maximumEvaluations ||
        budget.completedAttempts >= completedAttemptBudget
      ) {
        continue
      }
      const evaluationsRemaining = maximumEvaluations - budget.evaluations
      const ratiosRemaining = validSqueezeRatios.length - ratioIndex
      const attemptsRemaining = completedAttemptBudget - budget.completedAttempts
      const evaluationLimit =
        budget.evaluations + Math.ceil(evaluationsRemaining / ratiosRemaining)
      const attemptLimit =
        budget.completedAttempts + Math.ceil(attemptsRemaining / ratiosRemaining)
      const attempt = yield* runSqueezeAttempt({
        sheet,
        pieces,
        squeezeRatio,
        maximumEvaluations: evaluationLimit,
        completedAttemptBudget: attemptLimit,
        budget,
        incumbentMetrics
      })
      completedRatios.push(squeezeRatio)
      if (
        attempt !== undefined &&
        isAdmissibleImprovement(incumbentMetrics, attempt.metrics) &&
        compareMetrics(attempt.metrics, selectedMetrics) < 0
      ) {
        selected = attempt.placed
        selectedMetrics = attempt.metrics
      }
    }

    return {
      placedCollisionGeometries: selected,
      accepted: selected !== incumbent,
      evaluations: budget.evaluations,
      completedAttempts: budget.completedAttempts,
      exactCandidatesChecked: budget.exactCandidatesChecked,
      squeezeRatiosCompleted: completedRatios,
      incumbentMetrics,
      selectedMetrics
    }
  })
}

function runSqueezeAttempt(input: {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<RelaxedPiece>
  readonly squeezeRatio: number
  readonly maximumEvaluations: number
  readonly completedAttemptBudget: number
  readonly budget: SearchBudget
  readonly incumbentMetrics: IntrinsicRelaxationMetrics
}): Effect.Effect<
  | {
      readonly placed: ReadonlyArray<IrregularPlacedPiece>
      readonly metrics: IntrinsicRelaxationMetrics
    }
  | undefined,
  IrregularGeometryInputError
> {
  return Effect.gen(function* () {
    const targetWidth = input.incumbentMetrics.width * (1 - input.squeezeRatio)
    const targetHeight = input.incumbentMetrics.height * (1 - input.squeezeRatio)
    let current = squeezeLayout(input.pieces, input.squeezeRatio)
    if (current === undefined) return undefined
    const hazards = new Map<string, number>()
    let currentLoss = evaluateLayout(input.pieces, current, targetWidth, targetHeight, hazards)
    input.budget.evaluations += 1
    const tracker = new OverlapRelaxationTracker({
      value: current,
      rawLoss: currentLoss.rawLoss,
      tieKey: layoutTieKey(current)
    })
    let stalls = 0

    while (
      input.budget.evaluations < input.maximumEvaluations &&
      input.budget.completedAttempts < input.completedAttemptBudget
    ) {
      if (currentLoss.rawLoss === 0) {
        input.budget.exactCandidatesChecked += 1
        const exact = yield* rebuildAndValidate(input.sheet, input.pieces, current)
        if (exact !== undefined) {
          const metrics = measureIntrinsicMetrics(exact)
          if (metrics !== undefined) return { placed: exact, metrics }
        }
        return undefined
      }

      const selectedIndex = highestLossPiece(currentLoss.pieceWeightedLoss)
      if (selectedIndex === undefined) return undefined
      const proposals = movementProposals(
        input.pieces,
        current,
        currentLoss.violations,
        selectedIndex
      )
      let best:
        | {
            readonly layout: RelaxedLayout
            readonly loss: LayoutLoss
            readonly tieKey: string
          }
        | undefined
      for (const proposal of proposals) {
        if (input.budget.evaluations >= input.maximumEvaluations) break
        const loss = evaluateLayout(input.pieces, proposal, targetWidth, targetHeight, hazards)
        input.budget.evaluations += 1
        const tieKey = layoutTieKey(proposal)
        if (
          best === undefined ||
          loss.weightedLoss < best.loss.weightedLoss ||
          (loss.weightedLoss === best.loss.weightedLoss && loss.rawLoss < best.loss.rawLoss) ||
          (loss.weightedLoss === best.loss.weightedLoss &&
            loss.rawLoss === best.loss.rawLoss &&
            tieKey < best.tieKey)
        ) {
          best = { layout: proposal, loss, tieKey }
        }
      }
      input.budget.completedAttempts += 1

      if (best !== undefined && best.loss.weightedLoss < currentLoss.weightedLoss) {
        current = best.layout
        currentLoss = best.loss
        tracker.record({ value: current, rawLoss: currentLoss.rawLoss, tieKey: best.tieKey })
        stalls = 0
        continue
      }

      for (const violation of currentLoss.violations) {
        if (violation.firstIndex === selectedIndex || violation.secondIndex === selectedIndex) {
          hazards.set(violation.key, (hazards.get(violation.key) ?? 1) + 1)
        }
      }
      stalls += 1
      if (stalls >= 8) {
        current = tracker.leastRaw().value
        currentLoss = evaluateLayout(input.pieces, current, targetWidth, targetHeight, hazards)
        stalls = 0
      } else {
        currentLoss = reweightLoss(currentLoss, hazards)
      }
    }
    return undefined
  })
}

function prepareRelaxedPieces(
  incumbent: ReadonlyArray<IrregularPlacedPiece>
): ReadonlyArray<RelaxedPiece> | undefined {
  const result: RelaxedPiece[] = []
  for (const entry of incumbent) {
    const localPoints = entry.collisionGeometry.polygon.points.map(({ x, y }) => ({ x, y }))
    const bounds = boundsForPoints(localPoints)
    if (bounds === undefined) return undefined
    const width = bounds.maxX - bounds.minX
    const height = bounds.maxY - bounds.minY
    const minimumDimension = Math.min(width, height)
    const scale = Math.sqrt(Math.max(width * height, GRID_MM * GRID_MM))
    if (!Number.isFinite(minimumDimension) || minimumDimension <= 0 || !Number.isFinite(scale)) {
      return undefined
    }
    result.push({ entry, localPoints, scale, minimumDimension })
  }
  return result
}

function squeezeLayout(
  pieces: ReadonlyArray<RelaxedPiece>,
  squeezeRatio: number
): RelaxedLayout | undefined {
  const original = pieces.map(({ entry }) => ({
    x: entry.placement.transform.translateX,
    y: entry.placement.transform.translateY
  }))
  const absolutePoints = pieces.flatMap((piece, index) => {
    const translation = original[index]
    return translation === undefined
      ? []
      : piece.localPoints.map(({ x, y }) => ({ x: x + translation.x, y: y + translation.y }))
  })
  const bounds = boundsForPoints(absolutePoints)
  if (bounds === undefined) return undefined
  const translations: InternalPoint[] = []
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    const translation = original[index]
    if (piece === undefined || translation === undefined) return undefined
    const center = polygonCenter(piece.localPoints)
    if (center === undefined) return undefined
    const absoluteCenterX = translation.x + center.x - bounds.minX
    const absoluteCenterY = translation.y + center.y - bounds.minY
    translations.push({
      x: translation.x - bounds.minX - absoluteCenterX * squeezeRatio,
      y: translation.y - bounds.minY - absoluteCenterY * squeezeRatio
    })
  }
  return { translations }
}

function evaluateLayout(
  pieces: ReadonlyArray<RelaxedPiece>,
  layout: RelaxedLayout,
  targetWidth: number,
  targetHeight: number,
  hazards: ReadonlyMap<string, number>
): LayoutLoss {
  const polygons = pieces.map((piece, index) => {
    const translation = layout.translations[index] ?? { x: 0, y: 0 }
    return piece.localPoints.map(({ x, y }) => ({ x: x + translation.x, y: y + translation.y }))
  })
  const violations: Violation[] = []
  for (let index = 0; index < pieces.length; index += 1) {
    const piece = pieces[index]
    const polygon = polygons[index]
    if (piece === undefined || polygon === undefined) continue
    const bounds = boundsForPoints(polygon)
    if (bounds === undefined) continue
    addWallViolation(violations, index, 'left', -bounds.minX, { x: 1, y: 0 }, piece.scale)
    addWallViolation(violations, index, 'bottom', -bounds.minY, { x: 0, y: 1 }, piece.scale)
    addWallViolation(
      violations,
      index,
      'right',
      bounds.maxX - targetWidth,
      { x: -1, y: 0 },
      piece.scale
    )
    addWallViolation(
      violations,
      index,
      'top',
      bounds.maxY - targetHeight,
      { x: 0, y: -1 },
      piece.scale
    )
  }
  for (let firstIndex = 0; firstIndex < pieces.length; firstIndex += 1) {
    const first = pieces[firstIndex]
    const firstPolygon = polygons[firstIndex]
    if (first === undefined || firstPolygon === undefined) continue
    for (let secondIndex = 0; secondIndex < firstIndex; secondIndex += 1) {
      const second = pieces[secondIndex]
      const secondPolygon = polygons[secondIndex]
      if (second === undefined || secondPolygon === undefined) continue
      const penetration = measureConvexSatPenetration(firstPolygon, secondPolygon)
      if (penetration === undefined) continue
      const scale = Math.min(first.scale, second.scale)
      const normalized = penetration.depth / scale
      violations.push({
        key: `pair:${secondIndex}:${firstIndex}`,
        firstIndex,
        secondIndex,
        firstMtv: penetration.translation,
        depth: penetration.depth,
        energy: normalized * normalized
      })
    }
  }
  return lossFromViolations(pieces.length, violations, hazards)
}

function addWallViolation(
  violations: Violation[],
  pieceIndex: number,
  side: string,
  depth: number,
  direction: InternalPoint,
  scale: number
): void {
  if (!Number.isFinite(depth) || depth <= 0) return
  const normalized = depth / scale
  violations.push({
    key: `wall:${pieceIndex}:${side}`,
    firstIndex: pieceIndex,
    secondIndex: undefined,
    firstMtv: { x: direction.x * depth, y: direction.y * depth },
    depth,
    energy: normalized * normalized
  })
}

function lossFromViolations(
  pieceCount: number,
  violations: ReadonlyArray<Violation>,
  hazards: ReadonlyMap<string, number>
): LayoutLoss {
  let rawLoss = 0
  let weightedLoss = 0
  const pieceWeightedLoss = Array.from({ length: pieceCount }, () => 0)
  for (const violation of violations) {
    const weight = hazards.get(violation.key) ?? 1
    const weighted = violation.energy * weight
    rawLoss += violation.energy
    weightedLoss += weighted
    pieceWeightedLoss[violation.firstIndex] =
      (pieceWeightedLoss[violation.firstIndex] ?? 0) + weighted
    if (violation.secondIndex !== undefined) {
      pieceWeightedLoss[violation.secondIndex] =
        (pieceWeightedLoss[violation.secondIndex] ?? 0) + weighted
    }
  }
  return { rawLoss, weightedLoss, pieceWeightedLoss, violations }
}

function reweightLoss(loss: LayoutLoss, hazards: ReadonlyMap<string, number>): LayoutLoss {
  return lossFromViolations(loss.pieceWeightedLoss.length, loss.violations, hazards)
}

function highestLossPiece(losses: ReadonlyArray<number>): number | undefined {
  let selected: number | undefined
  let highest = 0
  for (let index = 0; index < losses.length; index += 1) {
    const loss = losses[index] ?? 0
    if (loss > highest) {
      highest = loss
      selected = index
    }
  }
  return selected
}

function movementProposals(
  pieces: ReadonlyArray<RelaxedPiece>,
  layout: RelaxedLayout,
  violations: ReadonlyArray<Violation>,
  selectedIndex: number
): ReadonlyArray<RelaxedLayout> {
  const piece = pieces[selectedIndex]
  const current = layout.translations[selectedIndex]
  if (piece === undefined || current === undefined) return []
  const movements: InternalPoint[] = []
  for (const violation of violations) {
    let mtv: InternalPoint | undefined
    if (violation.firstIndex === selectedIndex) mtv = violation.firstMtv
    if (violation.secondIndex === selectedIndex) {
      mtv = { x: -violation.firstMtv.x, y: -violation.firstMtv.y }
    }
    if (mtv === undefined) continue
    const length = Math.hypot(mtv.x, mtv.y)
    if (!Number.isFinite(length) || length <= 0) continue
    const outward = { x: (mtv.x / length) * GRID_MM, y: (mtv.y / length) * GRID_MM }
    movements.push(
      { x: mtv.x + outward.x, y: mtv.y + outward.y },
      { x: mtv.x * 0.5 + outward.x, y: mtv.y * 0.5 + outward.y }
    )
  }
  for (const divisor of [8, 32, 128] as const) {
    const step = piece.minimumDimension / divisor
    movements.push(
      { x: step, y: 0 },
      { x: -step, y: 0 },
      { x: 0, y: step },
      { x: 0, y: -step }
    )
  }

  const seen = new Set<string>()
  const proposals: RelaxedLayout[] = []
  for (const movement of movements) {
    const next = { x: current.x + movement.x, y: current.y + movement.y }
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) continue
    const key = `${next.x}:${next.y}`
    if (seen.has(key)) continue
    seen.add(key)
    const translations = [...layout.translations]
    translations[selectedIndex] = next
    proposals.push({ translations })
  }
  return proposals
}

function rebuildAndValidate(
  sheet: SheetSpec,
  pieces: ReadonlyArray<RelaxedPiece>,
  layout: RelaxedLayout
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

function bottomLeftGridTranslations(
  pieces: ReadonlyArray<RelaxedPiece>,
  layout: RelaxedLayout
): ReadonlyArray<InternalPoint> | undefined {
  const points = pieces.flatMap((piece, index) => {
    const translation = layout.translations[index]
    return translation === undefined
      ? []
      : piece.localPoints.map(({ x, y }) => ({ x: x + translation.x, y: y + translation.y }))
  })
  const bounds = boundsForPoints(points)
  if (bounds === undefined) return undefined
  return layout.translations.map(({ x, y }) => ({
    x: toGrid(x - bounds.minX),
    y: toGrid(y - bounds.minY)
  }))
}

function measureIntrinsicMetrics(
  placed: ReadonlyArray<IrregularPlacedPiece>
): IntrinsicRelaxationMetrics | undefined {
  const points = placed.flatMap(({ placement, collisionGeometry }) =>
    collisionGeometry.polygon.points.map(({ x, y }) => ({
      x: x + placement.transform.translateX,
      y: y + placement.transform.translateY
    }))
  )
  const bounds = boundsForPoints(points)
  const topology = measureCanonicalLayoutTopology(placed)
  if (bounds === undefined || topology === undefined) return undefined
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const state = new IrregularBeamState({
    remainingPreparedPieces: [],
    placedCollisionGeometries: placed,
    placementOrder: placed.map(({ placement }) => placement.pieceId ?? placement.sourcePieceId)
  })
  return {
    width,
    height,
    maxSide: Math.max(width, height),
    area: width * height,
    span: width + height,
    topology,
    nearCompleteStructuralContactCount: state.nearCompleteStructuralContactCount ?? 0,
    dominantNearCompleteStructuralContactCount:
      state.dominantNearCompleteStructuralContactCount ?? 0,
    sharedCollisionBoundaryContactUnits: state.sharedCollisionBoundaryContactUnits ?? 0
  }
}

function isAdmissibleImprovement(
  incumbent: IntrinsicRelaxationMetrics,
  candidate: IntrinsicRelaxationMetrics
): boolean {
  const contactFloorsPreserved =
    candidate.nearCompleteStructuralContactCount >= incumbent.nearCompleteStructuralContactCount &&
    candidate.dominantNearCompleteStructuralContactCount >=
      incumbent.dominantNearCompleteStructuralContactCount &&
    candidate.sharedCollisionBoundaryContactUnits + 1e-9 >=
      incumbent.sharedCollisionBoundaryContactUnits
  const intrinsicGuardsPreserved =
    candidate.maxSide <= incumbent.maxSide + GRID_MM &&
    candidate.area <= incumbent.area + GRID_MM &&
    candidate.topology.enclosedCavityCount <= incumbent.topology.enclosedCavityCount &&
    candidate.topology.largestOccupiedHullGapRatio <=
      incumbent.topology.largestOccupiedHullGapRatio + 1e-12 &&
    candidate.topology.positiveContactComponentCount <=
      incumbent.topology.positiveContactComponentCount &&
    candidate.topology.isolatedPieceCount <= incumbent.topology.isolatedPieceCount &&
    candidate.topology.largestPositiveContactComponentSize >=
      incumbent.topology.largestPositiveContactComponentSize
  const strictImprovement =
    candidate.maxSide < incumbent.maxSide - GRID_MM ||
    candidate.area < incumbent.area - GRID_MM ||
    candidate.topology.largestOccupiedHullGapRatio <
      incumbent.topology.largestOccupiedHullGapRatio - 1e-12 ||
    candidate.topology.positiveContactComponentCount <
      incumbent.topology.positiveContactComponentCount
  return contactFloorsPreserved && intrinsicGuardsPreserved && strictImprovement
}

function compareMetrics(
  first: IntrinsicRelaxationMetrics,
  second: IntrinsicRelaxationMetrics
): number {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [first.maxSide, second.maxSide],
    [first.area, second.area],
    [first.topology.largestOccupiedHullGapRatio, second.topology.largestOccupiedHullGapRatio],
    [first.topology.positiveContactComponentCount, second.topology.positiveContactComponentCount],
    [first.topology.isolatedPieceCount, second.topology.isolatedPieceCount],
    [-first.nearCompleteStructuralContactCount, -second.nearCompleteStructuralContactCount]
  ]
  for (const [left, right] of pairs) {
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

function makeUnchangedResult(
  incumbent: ReadonlyArray<IrregularPlacedPiece>,
  metrics: IntrinsicRelaxationMetrics,
  budget: SearchBudget
): OverlapRelaxationResult {
  return {
    placedCollisionGeometries: incumbent,
    accepted: false,
    evaluations: budget.evaluations,
    completedAttempts: budget.completedAttempts,
    exactCandidatesChecked: budget.exactCandidatesChecked,
    squeezeRatiosCompleted: [],
    incumbentMetrics: metrics,
    selectedMetrics: metrics
  }
}

function emptyMetrics(): IntrinsicRelaxationMetrics {
  return {
    width: 0,
    height: 0,
    maxSide: 0,
    area: 0,
    span: 0,
    topology: {
      enclosedCavityCount: 0,
      largestOccupiedHullGapRatio: 0,
      occupiedEnvelopeAspectRatio: 0,
      positiveContactComponentCount: 0,
      isolatedPieceCount: 0,
      largestPositiveContactComponentSize: 0,
      largestPositiveContactComponentRatio: 0
    },
    nearCompleteStructuralContactCount: 0,
    dominantNearCompleteStructuralContactCount: 0,
    sharedCollisionBoundaryContactUnits: 0
  }
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

function layoutTieKey(layout: RelaxedLayout): string {
  return layout.translations.map(({ x, y }) => `${x.toPrecision(17)},${y.toPrecision(17)}`).join(';')
}

function toGrid(value: number): number {
  return Math.round(value / GRID_MM) * GRID_MM
}

export const overlapRelaxationInternals = {
  evaluateLayout,
  highestLossPiece,
  movementProposals
} as const
