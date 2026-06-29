import type { NestingRequest, NestingStrategyResult } from '@shared/domain/nesting.js'

/**
 * Result-envelope selection stub. Picks the worker result row that should
 * populate the top-level NestingResult fields.
 *
 * For now the stub always returns the first strategy run when one exists,
 * regardless of `finalSelectionMode` (`manual` / `best` / `top_n`). Candidate
 * strategy ids already compete inside the single beam run before this point.
 *
 * Returning `null` is allowed and means "no strategy is selected". The
 * aggregator in `computeNestingStub` falls back to the empty input order.
 */
export function selectFinalStrategyResult(
  strategyResults: ReadonlyArray<NestingStrategyResult>,
  _request: NestingRequest
): NestingStrategyResult | null {
  if (strategyResults.length === 0) return null
  return strategyResults[0] ?? null
}
