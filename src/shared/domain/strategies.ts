import { Schema } from 'effect'
import { NestingStrategyDefinition } from './nesting.js'
import data from './strategies.json'

const StrategiesData = Schema.Struct({
  version: Schema.Literal(1),
  strategies: Schema.Array(NestingStrategyDefinition)
})

const loaded = Schema.decodeUnknownSync(StrategiesData)(data)

// candidate placement-order definitions loaded from JSON and validated at module load
export const STRATEGY_DEFINITIONS: ReadonlyArray<NestingStrategyDefinition> = loaded.strategies

// default candidate order used by new settings and request fallback
export const DEFAULT_STRATEGY_ID =
  STRATEGY_DEFINITIONS[0]?.id ?? 'balanced-preserve-free-then-bottom-left'

// lookup keeps caller-side error handling explicit
export function findStrategy(id: string): NestingStrategyDefinition | undefined {
  return STRATEGY_DEFINITIONS.find((s) => s.id === id)
}
