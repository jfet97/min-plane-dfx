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
import { IrregularBeamState } from './irregularBeamState.js'

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
            ? freeMaterialService
                .computeFreeMaterial({
                  sheet: input.sheet,
                  placed: input.state.placedCollisionGeometries,
                  settings: settings.geometry
                })
                .pipe(
                  Effect.tap((computedSnapshot) =>
                    Effect.sync(() => {
                      if (freeMaterialCache.size >= MAX_FREE_MATERIAL_CACHE_ENTRIES) {
                        const oldestKey = freeMaterialCache.keys().next().value
                        if (typeof oldestKey === 'string') freeMaterialCache.delete(oldestKey)
                      }
                      freeMaterialCache.set(cacheKey, computedSnapshot)
                    })
                  )
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

  const normalizedWidth = collisionBounds.width / input.sheet.width
  const normalizedHeight = collisionBounds.height / input.sheet.height
  const collisionBoundsWorstNormalizedSheetConsumption = Math.max(normalizedWidth, normalizedHeight)
  const collisionBoundsNormalizedSpanSum = normalizedWidth + normalizedHeight
  const collisionBoundsAreaMm2 = collisionBounds.width * collisionBounds.height
  const collisionBoundsSpanMm = collisionBounds.width + collisionBounds.height

  if (
    !Number.isFinite(normalizedWidth) ||
    !Number.isFinite(normalizedHeight) ||
    !Number.isFinite(collisionBoundsWorstNormalizedSheetConsumption) ||
    !Number.isFinite(collisionBoundsNormalizedSpanSum) ||
    !Number.isFinite(collisionBoundsAreaMm2) ||
    !Number.isFinite(collisionBoundsSpanMm)
  ) {
    return failScoring('collision-bounds score arithmetic must remain finite.')
  }

  return Effect.succeed({
    unplacedCount: input.state.unplacedSourcePieceIds.length,
    ...materialMetrics,
    collisionBoundsWorstNormalizedSheetConsumption,
    collisionBoundsNormalizedSpanSum,
    collisionBoundsAreaMm2,
    collisionBoundsSpanMm,
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

function compareScores(first: IrregularLayoutScore, second: IrregularLayoutScore): -1 | 0 | 1 {
  return layoutScoreOrder(first, second)
}

const layoutScoreOrder: Order.Order<IrregularLayoutScore> = Order.combineAll([
  scoreCriterion((score) => score.unplacedCount),
  descendingScoreCriterion((score) => score.largestNetFreeMaterialRegionAreaMm2),
  scoreCriterion((score) => score.freeMaterialRegionCount),
  scoreCriterion((score) => score.freeMaterialHoleCount),
  scoreCriterion((score) => score.freeMaterialSliverMetric),
  scoreCriterion((score) => score.collisionBoundsWorstNormalizedSheetConsumption),
  scoreCriterion((score) => score.collisionBoundsNormalizedSpanSum),
  scoreCriterion((score) => score.collisionBoundsAreaMm2),
  scoreCriterion((score) => score.collisionBoundsSpanMm),
  Order.mapInput(Order.Array(Order.String), (score) => score.placementOrder),
  Order.mapInput(Order.Array(Order.String), (score) => score.unplacedSourcePieceIds)
])

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
