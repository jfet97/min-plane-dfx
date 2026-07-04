import { Order } from 'effect'
import type {
  FreeRectangle,
  LayoutSelectionStrategyDefinition,
  NestingStrategyDefinition,
  Placement,
  SheetSpec
} from '@shared/domain/nesting.js'
import type { NestingBeamState } from './beam/state.js'
import type {
  CandidateOrder,
  NestingAlgorithmCandidate,
  NestingStateOrder
} from './nestingAlgorithm.js'

export class StrategyOrderEntry {
  readonly strategyId: string
  readonly order: CandidateOrder

  constructor(input: { readonly strategyId: string; readonly order: CandidateOrder }) {
    this.strategyId = input.strategyId
    this.order = input.order
  }
}

export interface StrategyOrders {
  readonly candidateOrder: ReadonlyArray<StrategyOrderEntry>
  readonly stateOrder: NestingStateOrder
}

const neutralCandidateOrder: Order.Order<NestingAlgorithmCandidate> = Order.make(() => 0)
const neutralStateOrder: Order.Order<NestingBeamState> = Order.make(() => 0)
const descendingNumber = Order.flip(Order.Number)

/**
 * Geometry terms used by the scoring notes.
 *
 * A cluster is the bounding rectangle that contains every committed placement
 * in a beam state. Its extents are the cluster width and height measured from
 * the sheet origin, so a placement ending at x = 10 contributes width 10.
 */
namespace ScoringGeometry {
  export interface ClusterExtents {
    readonly width: number
    readonly height: number
  }

  // candidate scores use the cluster extents after committing the candidate
  export function candidateExtents(candidate: NestingAlgorithmCandidate): ClusterExtents {
    let width = candidate.placement.x + candidate.placement.width
    let height = candidate.placement.y + candidate.placement.height
    for (const placement of candidate.state.placements) {
      width = Math.max(width, placement.x + placement.width)
      height = Math.max(height, placement.y + placement.height)
    }
    return { width, height }
  }

  // used area is the bounding cluster area, not the sum of placed piece areas
  export function usedClusterArea(placements: ReadonlyArray<Placement>): number {
    const extents = usedClusterExtents(placements)
    return area(extents)
  }

  // worst normalized fill catches tall-thin or wide-thin layouts with the same area
  export function maxUsedSheetRatio(
    placements: ReadonlyArray<Placement>,
    sheet: SheetSpec
  ): number {
    const extents = usedClusterExtents(placements)
    return Math.max(extents.width / sheet.width, extents.height / sheet.height)
  }

  // normalized span sum prefers using less of the sheet perimeter after ratio ties
  export function normalizedUsedSpanSum(
    placements: ReadonlyArray<Placement>,
    sheet: SheetSpec
  ): number {
    const extents = usedClusterExtents(placements)
    return extents.width / sheet.width + extents.height / sheet.height
  }

  // absolute span sum is the final compactness tie-breaker in millimeters
  export function usedSpanSum(placements: ReadonlyArray<Placement>): number {
    const extents = usedClusterExtents(placements)
    return extents.width + extents.height
  }

  // residual-space metrics look only at MaxRects records, which may overlap
  export function largestFreeRectangleArea(freeRectangles: ReadonlyArray<FreeRectangle>): number {
    return freeRectangles.reduce(
      (largest, freeRectangle) => Math.max(largest, area(freeRectangle)),
      0
    )
  }

  // short-side quality avoids preferring a huge but unusably thin remainder
  export function largestFreeRectangleShortSide(
    freeRectangles: ReadonlyArray<FreeRectangle>
  ): number {
    return freeRectangles.reduce(
      (largest, freeRectangle) =>
        Math.max(largest, Math.min(freeRectangle.width, freeRectangle.height)),
      0
    )
  }

  export function area(rectangle: Pick<FreeRectangle | Placement, 'width' | 'height'>): number {
    return rectangle.width * rectangle.height
  }

  // returns the bounding cluster width and height for a set of placements
  function usedClusterExtents(placements: ReadonlyArray<Placement>): ClusterExtents {
    let width = 0
    let height = 0
    for (const placement of placements) {
      width = Math.max(width, placement.x + placement.width)
      height = Math.max(height, placement.y + placement.height)
    }
    return { width, height }
  }
}

/**
 * Adapter from persisted strategy configuration to algorithm ordering hooks.
 *
 * Candidate strategies all feed the same beam run. The layout-selection
 * strategy chooses survivors after expansion. `Order.combineAll` makes the
 * lexicographic "criterion 1, then criterion 2, then ..." semantics explicit.
 */
export function makeStrategyOrders(
  sheet: SheetSpec,
  candidateStrategies: ReadonlyArray<NestingStrategyDefinition>,
  layoutSelectionStrategy: LayoutSelectionStrategyDefinition
): StrategyOrders {
  const candidateOrders: ReadonlyArray<StrategyOrderEntry> = candidateStrategies.map(
    (strategy) =>
      new StrategyOrderEntry({
        strategyId: strategy.id,
        order: makeCandidateOrder(sheet, strategy)
      })
  )
  const firstEntry = candidateOrders[0]

  return {
    candidateOrder:
      firstEntry === undefined
        ? [new StrategyOrderEntry({ strategyId: '', order: neutralCandidateOrder })]
        : [firstEntry, ...candidateOrders.slice(1)],
    stateOrder: () => makeStateOrder(sheet, layoutSelectionStrategy)
  }
}

function makeCandidateOrder(
  sheet: SheetSpec,
  strategy: NestingStrategyDefinition
): CandidateOrder {
  return Order.combineAll<NestingAlgorithmCandidate>([
    ...candidatePrefixOrders(strategy.prefix, sheet),
    ...strategy.tail.map(candidateTailOrder)
  ])
}

function candidatePrefixOrders(
  prefix: string,
  sheet: SheetSpec
): ReadonlyArray<Order.Order<NestingAlgorithmCandidate>> {
  // prefix criteria are the shared global placement score from the notes
  // they evaluate the used cluster after the candidate is committed
  // U' and V' are the candidate cluster width and height; W and H are the sheet size
  if (prefix === 'balanced_compactness') {
    return balancedCompactnessOrders(sheet)
  }

  // short-fill keeps the same compactness guard, then prefers filling the
  // sheet's short direction before spreading along the long direction
  if (prefix === 'short_side_fill') {
    if (sheet.width === sheet.height) {
      // a square sheet has no short direction; falling back avoids an arbitrary vertical bias
      return balancedCompactnessOrders(sheet)
    }

    // (-shortFill, longFill, U' / W + V' / H, U' * V', U' + V')
    return [
      // 1. short-side fill: negate it because larger short-axis usage is better
      Order.mapInput(descendingNumber, (candidate) => {
        const extents = ScoringGeometry.candidateExtents(candidate)
        return sheet.height <= sheet.width
          ? extents.height / sheet.height
          : extents.width / sheet.width
      }),
      // 2. long-side fill: after short-side progress ties, avoid spreading along the long axis
      Order.mapInput(Order.Number, (candidate) => {
        const extents = ScoringGeometry.candidateExtents(candidate)
        return sheet.height <= sheet.width
          ? extents.width / sheet.width
          : extents.height / sheet.height
      }),
      // 3. normalized perimeter-like tie-breaker: respect rectangular sheet proportions
      Order.mapInput(Order.Number, (candidate) => {
        const extents = ScoringGeometry.candidateExtents(candidate)
        return extents.width / sheet.width + extents.height / sheet.height
      }),
      // 4. used cluster area: avoid spending much more occupied area after shape ties
      Order.mapInput(Order.Number, (candidate) => {
        const extents = ScoringGeometry.candidateExtents(candidate)
        return extents.width * extents.height
      }),
      // 5. absolute perimeter-like tie-breaker: prefer smaller final occupied millimeters
      Order.mapInput(Order.Number, (candidate) => {
        const extents = ScoringGeometry.candidateExtents(candidate)
        return extents.width + extents.height
      })
    ]
  }

  return []
}

function balancedCompactnessOrders(
  sheet: SheetSpec
): ReadonlyArray<Order.Order<NestingAlgorithmCandidate>> {
  // (max(U' / W, V' / H), U' / W + V' / H, U' * V', U' + V')
  return [
    // 1. worst normalized consumption: avoid skinny columns or rows
    Order.mapInput(Order.Number, (candidate) => {
      const extents = ScoringGeometry.candidateExtents(candidate)
      return Math.max(extents.width / sheet.width, extents.height / sheet.height)
    }),
    // 2. normalized perimeter-like tie-breaker: make growth in the tighter axis cost more
    Order.mapInput(Order.Number, (candidate) => {
      const extents = ScoringGeometry.candidateExtents(candidate)
      return extents.width / sheet.width + extents.height / sheet.height
    }),
    // 3. used cluster area: break shape ties by occupied bounding area
    Order.mapInput(Order.Number, (candidate) => {
      const extents = ScoringGeometry.candidateExtents(candidate)
      return ScoringGeometry.area(extents)
    }),
    // 4. absolute perimeter-like tie-breaker: prefer fewer occupied millimeters after shape ties
    Order.mapInput(Order.Number, (candidate) => {
      const extents = ScoringGeometry.candidateExtents(candidate)
      return extents.width + extents.height
    })
  ]
}

function candidateTailOrder(token: string): Order.Order<NestingAlgorithmCandidate> {
  // tail tokens are local tie-breakers. `strategies.json` chooses their order,
  // and `Order.combineAll` applies them only after the prefix criteria tie
  if (token === 'r') {
    // r: remaining area in the selected free rectangle; smaller preserves larger clean rectangles
    return Order.mapInput(
      Order.Number,
      (candidate) =>
        ScoringGeometry.area(candidate.freeRectangle) - ScoringGeometry.area(candidate.placement)
    )
  }
  if (token === 's') {
    // s: local short-side leftover; smaller snaps into tighter local slots
    return Order.mapInput(Order.Number, (candidate) =>
      Math.min(
        candidate.freeRectangle.width - candidate.placement.width,
        candidate.freeRectangle.height - candidate.placement.height
      )
    )
  }
  if (token === 'y') {
    // y: global bottom coordinate; smaller keeps the cluster low
    return Order.mapInput(Order.Number, (candidate) => candidate.placement.y)
  }
  if (token === 'x') {
    // x: global left coordinate; smaller keeps the cluster left
    return Order.mapInput(Order.Number, (candidate) => candidate.placement.x)
  }
  return neutralCandidateOrder
}

function makeStateOrder(
  sheet: SheetSpec,
  strategy: LayoutSelectionStrategyDefinition
): Order.Order<NestingBeamState> {
  return Order.combineAll<NestingBeamState>([
    // hard requirement from the notes: layouts with fewer rejected pieces dominate
    Order.mapInput(Order.Number, (state) => state.unplacedPieces.length),
    ...strategy.criteria.map((criterion) => stateCriterionOrder(criterion, sheet))
  ])
}

function stateCriterionOrder(token: string, sheet: SheetSpec): Order.Order<NestingBeamState> {
  // layout criteria compare successor beam states after candidate application.
  // smaller values win, except criteria prefixed with "-" use a flipped order.
  if (token === 'used_area') {
    // U * V: bounding cluster area, not the sum of individual piece areas
    return Order.mapInput(Order.Number, (state) =>
      ScoringGeometry.usedClusterArea(state.placements)
    )
  }
  if (token === 'max_used_sheet_ratio') {
    // max(U / W, V / H): penalizes skinny columns or rows with compact area
    return Order.mapInput(Order.Number, (state) =>
      ScoringGeometry.maxUsedSheetRatio(state.placements, sheet)
    )
  }
  if (token === 'normalized_used_span_sum') {
    // U / W + V / H: prefers balanced sheet usage after worst-axis ties
    return Order.mapInput(Order.Number, (state) =>
      ScoringGeometry.normalizedUsedSpanSum(state.placements, sheet)
    )
  }
  if (token === 'used_span_sum') {
    // U + V: final millimeter-scale compactness tie-breaker
    return Order.mapInput(Order.Number, (state) => ScoringGeometry.usedSpanSum(state.placements))
  }
  if (token === '-largest_free_rect_area') {
    // larger is better: preserve a large clean rectangle for future pieces
    return Order.mapInput(descendingNumber, (state) =>
      ScoringGeometry.largestFreeRectangleArea(state.freeRectangles)
    )
  }
  if (token === '-largest_free_rect_short_side') {
    // larger is better: avoid preserving only long, thin leftovers
    return Order.mapInput(descendingNumber, (state) =>
      ScoringGeometry.largestFreeRectangleShortSide(state.freeRectangles)
    )
  }
  return neutralStateOrder
}
