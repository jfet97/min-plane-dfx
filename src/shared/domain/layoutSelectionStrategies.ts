import type { LayoutSelectionStrategyDefinition } from './nesting.js'
import data from './layoutSelectionStrategies.json'

interface LayoutSelectionStrategiesData {
  readonly version: number
  readonly strategies: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly description: string
    readonly criteria: ReadonlyArray<string>
  }>
}

const loaded = data as LayoutSelectionStrategiesData

export const LAYOUT_SELECTION_STRATEGIES: ReadonlyArray<LayoutSelectionStrategyDefinition> =
  loaded.strategies.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    criteria: [...s.criteria]
  }))

export const DEFAULT_LAYOUT_SELECTION_STRATEGY_ID =
  LAYOUT_SELECTION_STRATEGIES[0]?.id ?? 'compact-first'

export function findLayoutSelectionStrategy(
  id: string
): LayoutSelectionStrategyDefinition | undefined {
  return LAYOUT_SELECTION_STRATEGIES.find((s) => s.id === id)
}
