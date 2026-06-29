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
  CandidateOrders,
  NestingAlgorithmCandidate,
  NestingStateOrder
} from './nestingAlgorithm.js'

export interface StrategyOrders {
  readonly candidateOrder: CandidateOrders
  readonly stateOrder: NestingStateOrder
}

const neutralCandidateOrder: Order.Order<NestingAlgorithmCandidate> = Order.make(() => 0)
const neutralStateOrder: Order.Order<NestingBeamState> = Order.make(() => 0)
const descendingNumber = Order.flip(Order.Number)

/**
 * Adapter from persisted strategy configuration to algorithm ordering hooks.
 *
 * Candidate strategies all feed the same beam run. The layout-selection
 * strategy chooses survivors after expansion. `Order.combineAll` makes the
 * lexicographic "criterion 1, then criterion 2, then ..." semantics explicit.
 */
export function makeStrategyOrders(
  candidateStrategies: ReadonlyArray<NestingStrategyDefinition>,
  layoutSelectionStrategy: LayoutSelectionStrategyDefinition
): StrategyOrders {
  const candidateOrders = candidateStrategies.map((strategy) => makeCandidateOrder(strategy))
  const firstCandidateOrder = candidateOrders[0]

  return {
    candidateOrder:
      firstCandidateOrder === undefined
        ? [() => neutralCandidateOrder]
        : [firstCandidateOrder, ...candidateOrders.slice(1)],
    stateOrder: () => makeStateOrder(layoutSelectionStrategy)
  }
}

function makeCandidateOrder(strategy: NestingStrategyDefinition): CandidateOrder {
  return ({ sheet }) =>
    Order.combineAll<NestingAlgorithmCandidate>([
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
  if (prefix === 'balanced_compactness') {
    // (U' * V', max(U' / W, V' / H), U' / W + V' / H, U' + V')
    return [
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width * extents.height
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return Math.max(extents.width / sheet.width, extents.height / sheet.height)
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width / sheet.width + extents.height / sheet.height
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width + extents.height
      })
    ]
  }

  // short-fill keeps the same compactness guard, then prefers filling the
  // sheet's short direction before spreading along the long direction
  if (prefix === 'short_side_fill') {
    // (U' * V', -shortFill, longFill, U' / W + V' / H, U' + V')
    return [
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width * extents.height
      }),
      Order.mapInput(descendingNumber, (candidate) => {
        const extents = candidateExtents(candidate)
        return sheet.height <= sheet.width
          ? extents.height / sheet.height
          : extents.width / sheet.width
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return sheet.height <= sheet.width
          ? extents.width / sheet.width
          : extents.height / sheet.height
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width / sheet.width + extents.height / sheet.height
      }),
      Order.mapInput(Order.Number, (candidate) => {
        const extents = candidateExtents(candidate)
        return extents.width + extents.height
      })
    ]
  }

  return []
}

function candidateTailOrder(token: string): Order.Order<NestingAlgorithmCandidate> {
  // tail tokens are local tie-breakers. `strategies.json` chooses their order,
  // and `Order.combineAll` applies them only after the prefix criteria tie
  if (token === 'r') {
    // r: remaining area in the selected free rectangle; smaller preserves larger clean rectangles
    return Order.mapInput(
      Order.Number,
      (candidate) => area(candidate.freeRectangle) - area(candidate.placement)
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
  strategy: LayoutSelectionStrategyDefinition
): Order.Order<NestingBeamState> {
  return Order.combineAll<NestingBeamState>([
    // hard requirement from the notes: layouts with fewer rejected pieces dominate
    Order.mapInput(Order.Number, (state) => state.unplacedPieces.length),
    ...strategy.criteria.map(stateCriterionOrder)
  ])
}

function stateCriterionOrder(token: string): Order.Order<NestingBeamState> {
  // layout criteria compare successor beam states after candidate application
  // the three configured modes are just different priorities over these metrics
  if (token === 'used_area') {
    return Order.mapInput(Order.Number, (state) => usedArea(state.placements))
  }
  if (token === '-largest_free_rect_area') {
    return Order.mapInput(descendingNumber, (state) => largestFreeRectangleArea(state.freeRectangles))
  }
  if (token === '-largest_free_rect_short_side') {
    return Order.mapInput(descendingNumber, (state) =>
      largestFreeRectangleShortSide(state.freeRectangles)
    )
  }
  return neutralStateOrder
}

function candidateExtents(candidate: NestingAlgorithmCandidate): {
  readonly width: number
  readonly height: number
} {
  return usedClusterExtents([...candidate.state.placements, candidate.placement])
}

function usedArea(placements: ReadonlyArray<Placement>): number {
  const extents = usedClusterExtents(placements)
  return extents.width * extents.height
}

function usedClusterExtents(placements: ReadonlyArray<Placement>): {
  readonly width: number
  readonly height: number
} {
  let width = 0
  let height = 0
  for (const placement of placements) {
    width = Math.max(width, placement.x + placement.width)
    height = Math.max(height, placement.y + placement.height)
  }
  return { width, height }
}

function largestFreeRectangleArea(freeRectangles: ReadonlyArray<FreeRectangle>): number {
  return freeRectangles.reduce((largest, freeRectangle) => Math.max(largest, area(freeRectangle)), 0)
}

function largestFreeRectangleShortSide(freeRectangles: ReadonlyArray<FreeRectangle>): number {
  return freeRectangles.reduce(
    (largest, freeRectangle) => Math.max(largest, Math.min(freeRectangle.width, freeRectangle.height)),
    0
  )
}

function area(rectangle: Pick<FreeRectangle | Placement, 'width' | 'height'>): number {
  return rectangle.width * rectangle.height
}
