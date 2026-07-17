import { Context, Data, Effect, Layer, Order } from 'effect'
import type { PieceId } from '@shared/domain/ids.js'
import type { SheetSpec } from '@shared/domain/nesting.js'
import { FreeMaterialSnapshot, IrregularPolygon } from '@shared/irregular/domain.js'
import type { IrregularNestingSettings } from '@shared/irregular/domain.js'
import {
  FreeMaterialService,
  IrregularGeometryInputError,
  IrregularNestingNotImplementedError
} from '../../irregular/services.js'
import { FreeMaterialServiceLive } from '../../irregular/freeMaterialService.js'
import { GeometrySettings } from '../../irregular/geometryKernel.js'
import { GeometryPredicates } from '../../irregular/geometryPredicates.js'
import type { InternalPoint } from '../../irregular/internalGeometry.js'
import { IrregularBeamState } from './irregularBeamState.js'
import {
  canonicalizeIrregularScoreMillimeters,
  canonicalizeIrregularScoreScalar
} from './irregularScoreGrid.js'

/** A typed failure raised only when derived scoring arithmetic is non-finite. */
export class IrregularLayoutScoringError extends Data.TaggedError('IrregularLayoutScoringError')<{
  readonly operation: string
  readonly message: string
}> {}

export interface ScoreIrregularLayoutInput {
  readonly sheet: SheetSpec
  readonly state: IrregularBeamState
}

const MAX_FREE_MATERIAL_CACHE_ENTRIES = 256
const FREE_MATERIAL_CACHE_VERSION = 'irregular-free-material-v1'

/** Builds a cache key from every geometry input used by free-material calculation. */
function makeFreeMaterialCacheKey(
  input: ScoreIrregularLayoutInput,
  settings: IrregularNestingSettings
): string {
  return JSON.stringify({
    version: FREE_MATERIAL_CACHE_VERSION,
    sheet: {
      width: input.sheet.width,
      height: input.sheet.height,
      label: input.sheet.label
    },
    geometrySettings: {
      flatteningSagToleranceMm: settings.geometry.flatteningSagToleranceMm,
      clearanceSafetyMarginMm: settings.geometry.clearanceSafetyMarginMm,
      geometryBackendId: settings.geometry.geometryBackendId,
      geometryBackendVersion: settings.geometry.geometryBackendVersion
    },
    placedGeometry: input.state.canonicalOccupiedGeometryKey
  })
}

/** One lexicographically comparable score for a complete irregular beam state. */
export interface IrregularLayoutScore {
  /** Fewer unplaced prepared ids always dominate every later criterion. */
  readonly unplacedCount: number
  /** Total exact boundary shared by translated padded collision polygons. */
  readonly sharedCollisionBoundaryLengthMm: number
  /** Cumulative shared boundary normalized by each pair's structural edge scale. */
  readonly sharedCollisionBoundaryContactUnits: number
  /** Whole normalized contact units retained before compactness breaks the tie. */
  readonly sharedCollisionBoundaryContactBand: number
  /** Number of near-complete overlaps between structural-scale collision edges. */
  readonly nearCompleteStructuralContactCount: number
  /** Largest frequency of one invariant local structural-contact pattern. */
  readonly dominantNearCompleteStructuralContactCount: number
  /** Largest net boundary-minus-holes material region; larger is better. */
  readonly largestNetFreeMaterialRegionAreaMm2: number
  /** Number of disconnected material regions; smaller is better. */
  readonly freeMaterialRegionCount: number
  /** Total number of explicit interior holes across material regions. */
  readonly freeMaterialHoleCount: number
  /** Sum of perimeter-squared divided by net area for every material region. */
  readonly freeMaterialSliverMetric: number
  /** Largest normalized axis consumption of the placed collision bounds. */
  readonly collisionBoundsWorstNormalizedSheetConsumption: number
  /** Sum of normalized width and height of the placed collision bounds. */
  readonly collisionBoundsNormalizedSpanSum: number
  /** Area of the axis-aligned bounds around placed collision polygons. */
  readonly collisionBoundsAreaMm2: number
  /** Width plus height of the placed collision-polygon bounds. */
  readonly collisionBoundsSpanMm: number
  /** Empty fraction enclosed by the convex hull of the translated collision polygons. */
  readonly occupiedHullWasteRatio: number
  /** Sheet-space lower edge of the occupied collision envelope. */
  readonly collisionBoundsBottomMm: number
  /** Sheet-space left edge of the occupied collision envelope. */
  readonly collisionBoundsLeftMm: number
  /** Clipper2-derived snapshot retained for diagnostics and later consumers. */
  readonly freeMaterialSnapshot: FreeMaterialSnapshot
  /** Stable prepared-id order of committed placements. */
  readonly placementOrder: ReadonlyArray<PieceId>
  /** Stable prepared-id order of pieces recorded as unplaced. */
  readonly unplacedSourcePieceIds: ReadonlyArray<PieceId>
}

type IrregularLayoutScorerError =
  | IrregularLayoutScoringError
  | IrregularGeometryInputError
  | IrregularNestingNotImplementedError

export namespace IrregularLayoutScorer {
  export interface Service {
    readonly scoreState: (
      input: ScoreIrregularLayoutInput
    ) => Effect.Effect<IrregularLayoutScore, IrregularLayoutScorerError>
    readonly compare: (first: IrregularLayoutScore, second: IrregularLayoutScore) => -1 | 0 | 1
  }
}

/**
 * Scores only derived state quality. Free material never accepts or rejects a
 * placement; NFP/IFP generation and direct validation own that decision.
 */
export class IrregularLayoutScorer extends Context.Service<
  IrregularLayoutScorer,
  IrregularLayoutScorer.Service
>()('min-plane-dfx/algorithm/irregular/IrregularLayoutScorer') {
  static readonly Make = Effect.gen(function* () {
    const settings = yield* GeometrySettings
    const freeMaterialService = yield* FreeMaterialService
    const freeMaterialCache = new Map<string, FreeMaterialSnapshot>()

    return IrregularLayoutScorer.of({
      scoreState: (input) => {
        const cacheKey = makeFreeMaterialCacheKey(input, settings)
        const cachedSnapshot = freeMaterialCache.get(cacheKey)
        const snapshot =
          cachedSnapshot === undefined
            ? computeSnapshotWithParentFallback(
                input,
                settings,
                freeMaterialService,
                freeMaterialCache
              )
            : Effect.succeed(cachedSnapshot)

        return snapshot.pipe(
          Effect.flatMap((freeMaterialSnapshot) => scoreDerivedState(input, freeMaterialSnapshot))
        )
      },
      compare: compareScores
    })
  })

  static readonly Layer = Layer.effect(IrregularLayoutScorer, IrregularLayoutScorer.Make)
  static readonly Live = IrregularLayoutScorer.Layer.pipe(
    Layer.provideMerge(FreeMaterialServiceLive)
  )
}

function computeSnapshotWithParentFallback(
  input: ScoreIrregularLayoutInput,
  settings: IrregularNestingSettings,
  freeMaterialService: FreeMaterialService,
  freeMaterialCache: Map<string, FreeMaterialSnapshot>
): Effect.Effect<
  FreeMaterialSnapshot,
  IrregularGeometryInputError | IrregularNestingNotImplementedError
> {
  const parent = input.state.parent
  const newlyPlaced = getNewlyPlacedGeometry(input.state)
  const parentSnapshot =
    parent === undefined
      ? undefined
      : freeMaterialCache.get(makeFreeMaterialCacheKey({ sheet: input.sheet, state: parent }, settings))

  const full = () =>
    freeMaterialService.computeFreeMaterial({
      sheet: input.sheet,
      placed: input.state.placedCollisionGeometries,
      settings: settings.geometry
    })

  const computed =
    parentSnapshot === undefined || newlyPlaced === undefined
      ? full()
      : freeMaterialService
          .extendFreeMaterial({
            parent: parentSnapshot,
            placed: newlyPlaced,
            settings: settings.geometry
          })
          .pipe(Effect.catch(() => full()))

  return computed.pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        if (freeMaterialCache.size >= MAX_FREE_MATERIAL_CACHE_ENTRIES) {
          const oldestKey = freeMaterialCache.keys().next().value
          if (typeof oldestKey === 'string') freeMaterialCache.delete(oldestKey)
        }
        freeMaterialCache.set(
          makeFreeMaterialCacheKey(input, settings),
          snapshot
        )
      })
    )
  )
}

function getNewlyPlacedGeometry(
  state: IrregularBeamState
): IrregularBeamState['placedCollisionGeometries'][number] | undefined {
  const parent = state.parent
  if (parent === undefined) return undefined
  if (state.placedCollisionGeometries.length !== parent.placedCollisionGeometries.length + 1) {
    return undefined
  }

  for (let index = 0; index < parent.placedCollisionGeometries.length; index += 1) {
    if (state.placedCollisionGeometries[index] !== parent.placedCollisionGeometries[index]) {
      return undefined
    }
  }

  return state.placedCollisionGeometries[parent.placedCollisionGeometries.length]
}

function scoreDerivedState(
  input: ScoreIrregularLayoutInput,
  freeMaterialSnapshot: FreeMaterialSnapshot
): Effect.Effect<IrregularLayoutScore, IrregularLayoutScoringError> {
  const materialMetrics = deriveFreeMaterialMetrics(freeMaterialSnapshot)
  if (materialMetrics === undefined) {
    return failScoring('free-material metrics must remain finite.')
  }

  const collisionBounds = input.state.translatedCollisionBounds
  if (collisionBounds === undefined) {
    return failScoring('placed collision polygons must produce finite bounds.')
  }

  const canonicalWidth = canonicalizeIrregularScoreMillimeters(collisionBounds.width)
  const canonicalHeight = canonicalizeIrregularScoreMillimeters(collisionBounds.height)
  const canonicalMinX = canonicalizeIrregularScoreMillimeters(collisionBounds.minX)
  const canonicalMinY = canonicalizeIrregularScoreMillimeters(collisionBounds.minY)
  if (
    canonicalWidth === undefined ||
    canonicalHeight === undefined ||
    canonicalMinX === undefined ||
    canonicalMinY === undefined
  ) {
    return failScoring('collision bounds must fit the deterministic score grid.')
  }

  /**
   * Translation-equivalent layouts can acquire different low-order bits when
   * large translated maxima and minima are subtracted. Canonicalizing the
   * derived bounds to the existing 0.001 mm collision-geometry precision makes
   * those layouts score identically without introducing epsilon comparisons.
   */
  const normalizedWidth = canonicalWidth / input.sheet.width
  const normalizedHeight = canonicalHeight / input.sheet.height
  const collisionBoundsWorstNormalizedSheetConsumption = Math.max(normalizedWidth, normalizedHeight)
  const collisionBoundsNormalizedSpanSum = normalizedWidth + normalizedHeight
  const collisionBoundsAreaMm2 = canonicalWidth * canonicalHeight
  const collisionBoundsSpanMm = canonicalWidth + canonicalHeight
  const collisionBoundsBottomMm = canonicalMinY
  const collisionBoundsLeftMm = canonicalMinX
  const sharedCollisionBoundaryLengthMm = canonicalizeIrregularScoreMillimeters(
    input.state.sharedCollisionBoundaryLengthMm ?? Number.NaN
  )
  const sharedCollisionBoundaryContactUnits = canonicalizeIrregularScoreScalar(
    input.state.sharedCollisionBoundaryContactUnits ?? Number.NaN
  )
  const sharedCollisionBoundaryContactBand =
    sharedCollisionBoundaryContactUnits === undefined
      ? undefined
      : Math.floor(sharedCollisionBoundaryContactUnits)
  const nearCompleteStructuralContactCount = input.state.nearCompleteStructuralContactCount
  const dominantNearCompleteStructuralContactCount =
    input.state.dominantNearCompleteStructuralContactCount
  const occupiedHullWasteRatio = canonicalizeIrregularScoreScalar(
    deriveOccupiedHullWasteRatio(input.state) ?? Number.NaN
  )

  if (
    !Number.isFinite(normalizedWidth) ||
    !Number.isFinite(normalizedHeight) ||
    !Number.isFinite(collisionBoundsWorstNormalizedSheetConsumption) ||
    !Number.isFinite(collisionBoundsNormalizedSpanSum) ||
    !Number.isFinite(collisionBoundsAreaMm2) ||
    !Number.isFinite(collisionBoundsSpanMm) ||
    sharedCollisionBoundaryLengthMm === undefined ||
    sharedCollisionBoundaryContactUnits === undefined ||
    sharedCollisionBoundaryContactBand === undefined ||
    !Number.isSafeInteger(sharedCollisionBoundaryContactBand) ||
    nearCompleteStructuralContactCount === undefined ||
    !Number.isSafeInteger(nearCompleteStructuralContactCount) ||
    nearCompleteStructuralContactCount < 0 ||
    dominantNearCompleteStructuralContactCount === undefined ||
    !Number.isSafeInteger(dominantNearCompleteStructuralContactCount) ||
    dominantNearCompleteStructuralContactCount < 0 ||
    dominantNearCompleteStructuralContactCount > nearCompleteStructuralContactCount ||
    occupiedHullWasteRatio === undefined ||
    !Number.isFinite(collisionBoundsBottomMm) ||
    !Number.isFinite(collisionBoundsLeftMm)
  ) {
    return failScoring('collision-bounds score arithmetic must remain finite.')
  }

  return Effect.succeed({
    unplacedCount: input.state.unplacedSourcePieceIds.length,
    sharedCollisionBoundaryLengthMm,
    sharedCollisionBoundaryContactUnits,
    sharedCollisionBoundaryContactBand,
    nearCompleteStructuralContactCount,
    dominantNearCompleteStructuralContactCount,
    ...materialMetrics,
    collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2,
    collisionBoundsSpanMm,
    occupiedHullWasteRatio,
    collisionBoundsBottomMm,
    collisionBoundsLeftMm,
    freeMaterialSnapshot,
    placementOrder: input.state.placementOrder,
    unplacedSourcePieceIds: input.state.unplacedSourcePieceIds
  })
}

interface FreeMaterialMetrics {
  readonly largestNetFreeMaterialRegionAreaMm2: number
  readonly freeMaterialRegionCount: number
  readonly freeMaterialHoleCount: number
  readonly freeMaterialSliverMetric: number
}

/**
 * Uses boundary and hole vertices from the real material snapshot. The
 * sliver metric is dimensionless: perimeter squared divided by net area is
 * larger for long, thin, or hole-heavy regions and smaller for compact ones.
 */
function deriveFreeMaterialMetrics(
  snapshot: FreeMaterialSnapshot
): FreeMaterialMetrics | undefined {
  let largestNetFreeMaterialRegionAreaMm2 = 0
  let freeMaterialHoleCount = 0
  let freeMaterialSliverMetric = 0

  for (const region of snapshot.regions) {
    const boundaryArea = polygonArea(region.boundary)
    const boundaryPerimeter = polygonPerimeter(region.boundary)
    let holeArea = 0
    let perimeter = boundaryPerimeter

    for (const hole of region.holes) {
      holeArea += polygonArea(hole)
      perimeter += polygonPerimeter(hole)
      freeMaterialHoleCount += 1
    }

    const netArea = boundaryArea - holeArea
    largestNetFreeMaterialRegionAreaMm2 = Math.max(largestNetFreeMaterialRegionAreaMm2, netArea)
    if (
      !Number.isFinite(boundaryArea) ||
      !Number.isFinite(boundaryPerimeter) ||
      !Number.isFinite(holeArea) ||
      !Number.isFinite(perimeter) ||
      !Number.isFinite(netArea) ||
      netArea <= 0
    ) {
      return undefined
    }

    freeMaterialSliverMetric += (perimeter * perimeter) / netArea
  }

  if (
    !Number.isFinite(largestNetFreeMaterialRegionAreaMm2) ||
    !Number.isFinite(freeMaterialSliverMetric)
  ) {
    return undefined
  }

  return {
    largestNetFreeMaterialRegionAreaMm2,
    freeMaterialRegionCount: snapshot.regions.length,
    freeMaterialHoleCount,
    freeMaterialSliverMetric
  }
}

function polygonArea(polygon: IrregularPolygon): number {
  let crossSum = 0
  for (let index = 0; index < polygon.points.length; index += 1) {
    const first = polygon.points[index]
    const second = polygon.points[(index + 1) % polygon.points.length]
    if (first === undefined || second === undefined) return Number.NaN
    crossSum += first.x * second.y - second.x * first.y
  }
  return Math.abs(crossSum / 2)
}

function polygonPerimeter(polygon: IrregularPolygon): number {
  let perimeter = 0
  for (let index = 0; index < polygon.points.length; index += 1) {
    const first = polygon.points[index]
    const second = polygon.points[(index + 1) % polygon.points.length]
    if (first === undefined || second === undefined) return Number.NaN
    perimeter += Math.hypot(second.x - first.x, second.y - first.y)
  }
  return perimeter
}

function deriveOccupiedHullWasteRatio(state: IrregularBeamState): number | undefined {
  const occupiedPoints: InternalPoint[] = []
  let occupiedArea = 0

  for (const placed of state.placedCollisionGeometries) {
    const translation = placed.placement.transform
    const points = placed.collisionGeometry.polygon.points
    const translatedPoints: InternalPoint[] = points.map((point) => ({
      x: point.x + translation.translateX,
      y: point.y + translation.translateY
    }))

    if (translatedPoints.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return undefined
    }

    occupiedPoints.push(...translatedPoints)
    const area = absolutePolygonArea(translatedPoints)
    if (!Number.isFinite(area)) return undefined
    occupiedArea += area
  }

  if (occupiedPoints.length === 0) return 0

  const hull = convexHull(occupiedPoints)
  const hullArea = absolutePolygonArea(hull)
  if (!Number.isFinite(hullArea) || !Number.isFinite(occupiedArea)) return undefined
  if (hullArea === 0) return 0

  const waste = (hullArea - occupiedArea) / hullArea
  return Number.isFinite(waste) ? Math.max(0, Math.min(1, waste)) : undefined
}

function absolutePolygonArea(points: ReadonlyArray<InternalPoint>): number {
  if (points.length < 3) return 0

  let crossSum = 0
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]
    const second = points[(index + 1) % points.length]
    if (first === undefined || second === undefined) return Number.NaN
    crossSum += first.x * second.y - second.x * first.y
  }
  return Math.abs(crossSum / 2)
}

function convexHull(points: ReadonlyArray<InternalPoint>): ReadonlyArray<InternalPoint> {
  const sorted = [...points].sort(compareInternalPoints)
  const unique: InternalPoint[] = []
  for (const point of sorted) {
    const previous = unique[unique.length - 1]
    if (previous === undefined || point.x !== previous.x || point.y !== previous.y) {
      unique.push(point)
    }
  }

  if (unique.length <= 2) return unique

  const lower: InternalPoint[] = []
  for (const point of unique) {
    while (lower.length >= 2) {
      const last = lower[lower.length - 1]
      const beforeLast = lower[lower.length - 2]
      if (last === undefined || beforeLast === undefined) break
      if (GeometryPredicates.orientation(beforeLast, last, point) > 0) break
      lower.pop()
    }
    lower.push(point)
  }

  const upper: InternalPoint[] = []
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index]
    if (point === undefined) continue
    while (upper.length >= 2) {
      const last = upper[upper.length - 1]
      const beforeLast = upper[upper.length - 2]
      if (last === undefined || beforeLast === undefined) break
      if (GeometryPredicates.orientation(beforeLast, last, point) > 0) break
      upper.pop()
    }
    upper.push(point)
  }

  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function compareInternalPoints(first: InternalPoint, second: InternalPoint): number {
  return first.x - second.x || first.y - second.y
}

function compareScores(first: IrregularLayoutScore, second: IrregularLayoutScore): -1 | 0 | 1 {
  return layoutScoreOrder(first, second)
}

/** Small partial layouts keep exact contact ordering while repeated motifs form. */
export const STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT = 20
/** Larger layouts compare total structural contacts in adjacent-pair bands. */
export const STRUCTURAL_CONTACT_COUNT_BAND_WIDTH = 2

const strictLayoutScoreOrder: Order.Order<IrregularLayoutScore> = Order.combineAll([
  scoreCriterion((score) => score.unplacedCount),
  descendingScoreCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  descendingScoreCriterion((score) => score.nearCompleteStructuralContactCount),
  scoreCriterion((score) => score.collisionBoundsWorstNormalizedSheetConsumption),
  scoreCriterion((score) => score.collisionBoundsNormalizedSpanSum),
  scoreCriterion((score) => score.collisionBoundsAreaMm2),
  scoreCriterion((score) => score.collisionBoundsSpanMm),
  scoreCriterion((score) => score.occupiedHullWasteRatio),
  descendingScoreCriterion((score) => score.sharedCollisionBoundaryContactBand),
  descendingScoreCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoreCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  scoreCriterion((score) => score.collisionBoundsBottomMm),
  scoreCriterion((score) => score.collisionBoundsLeftMm),
  // free area is almost constant when every placed polygon remains inside one sheet region
  // so compact bounds and symmetric lower-left anchoring decide before material diagnostics
  descendingScoreCriterion((score) => score.largestNetFreeMaterialRegionAreaMm2),
  scoreCriterion((score) => score.freeMaterialRegionCount),
  scoreCriterion((score) => score.freeMaterialHoleCount),
  scoreCriterion((score) => score.freeMaterialSliverMetric),
  Order.mapInput(Order.Array(Order.String), (score) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), (score) => score.unplacedSourcePieceIds)
])

const scaleAwareLayoutScoreOrder: Order.Order<IrregularLayoutScore> = Order.combineAll([
  scoreCriterion((score) => score.unplacedCount),
  descendingScoreCriterion((score) => score.dominantNearCompleteStructuralContactCount),
  descendingScoreCriterion((score) =>
    Math.floor(score.nearCompleteStructuralContactCount / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH)
  ),
  scoreCriterion((score) => score.collisionBoundsWorstNormalizedSheetConsumption),
  scoreCriterion((score) => score.collisionBoundsNormalizedSpanSum),
  scoreCriterion((score) => score.collisionBoundsAreaMm2),
  scoreCriterion((score) => score.collisionBoundsSpanMm),
  scoreCriterion((score) => score.occupiedHullWasteRatio),
  descendingScoreCriterion((score) => score.nearCompleteStructuralContactCount),
  descendingScoreCriterion((score) => score.sharedCollisionBoundaryContactUnits),
  descendingScoreCriterion((score) => score.sharedCollisionBoundaryLengthMm),
  scoreCriterion((score) => score.collisionBoundsBottomMm),
  scoreCriterion((score) => score.collisionBoundsLeftMm),
  descendingScoreCriterion((score) => score.largestNetFreeMaterialRegionAreaMm2),
  scoreCriterion((score) => score.freeMaterialRegionCount),
  scoreCriterion((score) => score.freeMaterialHoleCount),
  scoreCriterion((score) => score.freeMaterialSliverMetric),
  Order.mapInput(Order.Array(Order.String), (score) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), (score) => score.unplacedSourcePieceIds)
])

const layoutScoreOrder: Order.Order<IrregularLayoutScore> = Order.make((first, second) => {
  const samePlacementDepth = first.placementOrder.length === second.placementOrder.length
  const useScaleAwareContactBands =
    samePlacementDepth &&
    first.placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
  return useScaleAwareContactBands
    ? scaleAwareLayoutScoreOrder(first, second)
    : strictLayoutScoreOrder(first, second)
})

function scoreCriterion(
  select: (score: IrregularLayoutScore) => number
): Order.Order<IrregularLayoutScore> {
  return Order.mapInput(Order.Number, select)
}

function descendingScoreCriterion(
  select: (score: IrregularLayoutScore) => number
): Order.Order<IrregularLayoutScore> {
  return Order.flip(scoreCriterion(select))
}

function failScoring(message: string): Effect.Effect<never, IrregularLayoutScoringError> {
  return Effect.fail(
    new IrregularLayoutScoringError({
      operation: 'scoreState',
      message
    })
  )
}
