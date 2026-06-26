import type { NestingStrategyDefinition } from './nesting.js'
import data from './strategies.json'

/**
 * Schema-compatible view of the JSON file. Kept loose intentionally: the
 * data file is the source of truth, not the TypeScript literal unions. The
 * schema in `nesting.ts` accepts any descriptive string for `prefix` and
 * `tail`, so the validator does not need to match the literal options.
 */
interface StrategiesData {
  readonly version: number
  readonly strategies: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly description: string
    readonly prefix: string
    readonly tail: ReadonlyArray<string>
  }>
}

const loaded = data as StrategiesData

export const STRATEGY_DEFINITIONS: ReadonlyArray<NestingStrategyDefinition> =
  loaded.strategies.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
    prefix: s.prefix,
    tail: [...s.tail]
  }))

/** Default strategy id used by the stub when the request does not specify one. */
export const DEFAULT_STRATEGY_ID =
  STRATEGY_DEFINITIONS[0]?.id ?? 'balanced_compactness/rr'

/** Lookup helper used by the worker stub and the renderer. */
export function findStrategy(id: string): NestingStrategyDefinition | undefined {
  return STRATEGY_DEFINITIONS.find((s) => s.id === id)
}
