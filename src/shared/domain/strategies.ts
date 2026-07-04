import { Schema } from 'effect'
import { NestingStrategyDefinition } from './nesting.js'
import data from './strategies.json'

const StrategiesData = Schema.Struct({
  version: Schema.Literal(1),
  strategies: Schema.Array(NestingStrategyDefinition)
})

const loaded = Schema.decodeUnknownSync(StrategiesData)(data)

// candidate placement-order definitions loaded from JSON and validated at module load
export const ALL_STRATEGY_DEFINITIONS: ReadonlyArray<NestingStrategyDefinition> = loaded.strategies

const activeStrategyIds = [
  'balanced-preserve-free-then-bottom-left',
  'short-fill-preserve-free-then-bottom-left',
  'balanced-bottom-left-then-short-side-fit',
  'balanced-short-side-fit-then-bottom-left'
]

// chosen from scratchpad/strategy-dominance.benchmark.ts:
// dominant final survivor plus strategies that dominate search candidate claims
export const STRATEGY_DEFINITIONS: ReadonlyArray<NestingStrategyDefinition> =
  activeStrategyIds.map(findLoaded)

// default candidate order used by new settings and request fallback
export const DEFAULT_STRATEGY_ID =
  STRATEGY_DEFINITIONS[0]?.id ?? 'balanced-preserve-free-then-bottom-left'

// lookup keeps caller-side error handling explicit
export function findStrategy(id: string): NestingStrategyDefinition | undefined {
  return ALL_STRATEGY_DEFINITIONS.find((s) => s.id === id)
}

function findLoaded(id: string): NestingStrategyDefinition {
  const strategy = ALL_STRATEGY_DEFINITIONS.find((s) => s.id === id)
  if (strategy === undefined) {
    throw new Error(`Unknown active strategy id: ${id}`)
  }
  return strategy
}
