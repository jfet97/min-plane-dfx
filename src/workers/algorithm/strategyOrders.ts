import { Order } from 'effect'
import type {
  LayoutSelectionStrategyDefinition,
  NestingStrategyDefinition
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

function neutralCandidateOrderFactory(): Order.Order<NestingAlgorithmCandidate> {
  return neutralCandidateOrder
}

function nonEmptyCandidateOrders(orders: ReadonlyArray<CandidateOrder>): CandidateOrders {
  const first = orders[0]
  if (first === undefined) return [neutralCandidateOrderFactory]
  return [first, ...orders.slice(1)]
}

/**
 * Adapter from persisted strategy configuration to algorithm ordering hooks.
 *
 * Candidate strategies all feed the same beam run. The layout-selection
 * strategy chooses survivors after expansion. For now both adapters stay
 * neutral until the scoring formulas are implemented.
 */
export function makeStrategyOrders(
  candidateStrategies: ReadonlyArray<NestingStrategyDefinition | undefined>,
  _layoutSelectionStrategy: LayoutSelectionStrategyDefinition | undefined
): StrategyOrders {
  const candidateOrders = candidateStrategies.map(() => neutralCandidateOrderFactory)

  return {
    candidateOrder: nonEmptyCandidateOrders(candidateOrders),
    stateOrder: () => neutralStateOrder
  }
}
