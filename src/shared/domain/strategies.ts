import type { NestingStrategyDefinition } from './nesting.js'

/**
 * The initial eight experimental strategy definitions. Each one composes a
 * prefix (`balanced_compactness` / `short_side_fill`) with a 3-letter tail
 * picked from the user-defined order.
 *
 * The exact meaning of each strategy is left to the user-written algorithm.
 * The app shell only registers the descriptive id and label so the UI can
 * list them, the worker can dispatch on `strategyId`, and the final-selection
 * layer can score them once that logic exists.
 */
export const STRATEGY_DEFINITIONS: ReadonlyArray<NestingStrategyDefinition> = [
  {
    id: 'balanced_compactness/rr',
    label: 'Balanced / right-then-right',
    description: 'Compactness-first, double right sweep.',
    prefix: 'balanced_compactness',
    tail: ['r', 'r', 'r']
  },
  {
    id: 'balanced_compactness/rs',
    label: 'Balanced / right then short-side',
    description: 'Compactness-first, right sweep then short-side fill.',
    prefix: 'balanced_compactness',
    tail: ['r', 's', 's']
  },
  {
    id: 'balanced_compactness/ry',
    label: 'Balanced / right then yield-by-y',
    description: 'Compactness-first, right sweep then sort by y dimension.',
    prefix: 'balanced_compactness',
    tail: ['r', 'y', 'x']
  },
  {
    id: 'balanced_compactness/rx',
    label: 'Balanced / right then x-axis',
    description: 'Compactness-first, right sweep then x-axis bias.',
    prefix: 'balanced_compactness',
    tail: ['r', 'x', 'x']
  },
  {
    id: 'short_side_fill/ss',
    label: 'Short-side / short-side',
    description: 'Short-side fill, double short-side.',
    prefix: 'short_side_fill',
    tail: ['s', 's', 's']
  },
  {
    id: 'short_side_fill/sy',
    label: 'Short-side / sort by y',
    description: 'Short-side fill, then sort by y.',
    prefix: 'short_side_fill',
    tail: ['s', 'y', 'x']
  },
  {
    id: 'short_side_fill/sx',
    label: 'Short-side / sort by x',
    description: 'Short-side fill, then sort by x.',
    prefix: 'short_side_fill',
    tail: ['s', 'x', 'x']
  },
  {
    id: 'short_side_fill/yr',
    label: 'Short-side / yield-by-y then right',
    description: 'Short-side fill, yield-by-y, right sweep.',
    prefix: 'short_side_fill',
    tail: ['y', 'r', 'r']
  }
]

/** Default strategy id used by the stub when the request does not specify one. */
export const DEFAULT_STRATEGY_ID = 'balanced_compactness/rr'

/** Lookup helper used by the worker stub and the renderer. */
export function findStrategy(id: string): NestingStrategyDefinition | undefined {
  return STRATEGY_DEFINITIONS.find((s) => s.id === id)
}