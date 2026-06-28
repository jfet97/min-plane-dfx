import { Order } from 'effect'
import type { FreeRectangle, NestingStrategyDefinition } from '@shared/domain/nesting.js'
import type {
  FreeRectangleOrder,
  NestingAlgorithmState,
  NestingStateOrder
} from './nestingAlgorithm.js'

export interface StrategyOrders {
  readonly freeRectangleOrder: FreeRectangleOrder.ForPiece
  readonly stateOrder: NestingStateOrder
}

const neutralFreeRectangleOrder: Order.Order<FreeRectangle> = Order.make(() => 0)
const neutralStateOrder: Order.Order<NestingAlgorithmState> = Order.make(() => 0)

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
    freeRectangleOrder: () => neutralFreeRectangleOrder,
    stateOrder: neutralStateOrder
  }
}
