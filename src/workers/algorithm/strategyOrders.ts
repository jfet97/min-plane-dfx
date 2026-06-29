import { Order } from 'effect'
import type { NestingStrategyDefinition } from '@shared/domain/nesting.js'
import type { NestingBeamState } from './beam/state.js'
import type {
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

/**
 * Adapter from persisted strategy configuration to algorithm ordering hooks.
 *
 * The future algorithm will interpret `prefix` and `tail` from the strategy
 * definition here. For now the adapter is deliberately neutral so the app shell
 * does not invent placement scoring before the real algorithm exists.
 */
export function makeStrategyOrders(
  _strategy: NestingStrategyDefinition | undefined
): StrategyOrders {
  return {
    candidateOrder: [() => neutralCandidateOrder],
    stateOrder: () => neutralStateOrder
  }
}
