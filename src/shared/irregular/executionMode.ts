import type { IrregularOptimizerSettings } from './domain.js'

export type IntrinsicSharedArchiveIneligibilityReason =
  | 'archive-disabled'
  | 'ga-active'
  | 'short-side-fill'

export type IntrinsicSharedArchiveEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false
      readonly reason: IntrinsicSharedArchiveIneligibilityReason
    }

/** Reports whether optimizer settings select the production Compact shared archive. */
export function intrinsicSharedArchiveEligibility(
  optimizer: IrregularOptimizerSettings
): IntrinsicSharedArchiveEligibility {
  if (optimizer.intrinsicSharedArchiveEnabled !== true) {
    return { eligible: false, reason: 'archive-disabled' }
  }
  if (optimizer.placementPolicyId === 'short-side-fill') {
    return { eligible: false, reason: 'short-side-fill' }
  }

  const gaDisabled =
    optimizer.gaEnabled === false ||
    optimizer.baselineOnly === true ||
    optimizer.gaTimeBudgetMs === 0 ||
    (optimizer.gaGenerationBudget ?? 4) === 0 ||
    (optimizer.gaEvaluationBudget ?? 128) === 0
  if (!gaDisabled) return { eligible: false, reason: 'ga-active' }

  return { eligible: true }
}
