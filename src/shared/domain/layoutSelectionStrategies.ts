import { Schema } from 'effect'
import { LayoutSelectionStrategyDefinition } from './nesting.js'
import data from './layoutSelectionStrategies.json'

const LayoutSelectionStrategiesData = Schema.Struct({
  version: Schema.Literal(1),
  strategies: Schema.Array(LayoutSelectionStrategyDefinition)
})

const loaded = Schema.decodeUnknownSync(LayoutSelectionStrategiesData)(data)

// beam survivor/layout definitions loaded from JSON and validated at module load
export const LAYOUT_SELECTION_STRATEGIES: ReadonlyArray<LayoutSelectionStrategyDefinition> =
  loaded.strategies

// default survivor metric used by new settings
export const DEFAULT_LAYOUT_SELECTION_STRATEGY_ID = 'largest-free-area-first'

// lookup keeps caller-side error handling explicit
export function findLayoutSelectionStrategy(
  id: string
): LayoutSelectionStrategyDefinition | undefined {
  return LAYOUT_SELECTION_STRATEGIES.find((s) => s.id === id)
}
