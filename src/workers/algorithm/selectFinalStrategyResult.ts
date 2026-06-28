import type { NestingRequest, NestingStrategyResult } from '@shared/domain/nesting.js'

/**
 * Cross-strategy final selection stub. Picks the strategy run that should
 * populate the top-level NestingResult.placements / sortedPieceIds /
 * unplacedPieceIds / selectedStrategyRunId fields.
 *
 * For now the stub always returns the first strategy run when one exists,
 * regardless of `finalSelectionMode` (`manual` / `best` / `top_n`). The
 * ranking criteria for `best` and `top_n` are intentionally undecided; the
 * user-written scoring layer will replace this function later.
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
