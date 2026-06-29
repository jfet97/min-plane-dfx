import type { NestingRequest, NestingStrategyResult } from '@shared/domain/nesting.js'

/**
 * Result-envelope selection layer.
 *
 * There is currently one worker result row: the beam search run. Candidate
 * strategy ids already compete inside that run before this point.
 *
 * Returning `null` is allowed and means "no strategy is selected". The
 * aggregator in `computeNesting` falls back to the core outcome fields.
 */
export function selectFinalStrategyResult(
  strategyResults: ReadonlyArray<NestingStrategyResult>,
  _request: NestingRequest
): NestingStrategyResult | null {
  if (strategyResults.length === 0) return null
  return strategyResults[0] ?? null
}
