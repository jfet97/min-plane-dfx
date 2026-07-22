import { describe, expect, it } from 'vitest'
import {
  makeCompactQualityIrregularOptimizerSettings,
  makeDefaultIrregularNestingSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings, IrregularPortfolioProgress } from '@shared/irregular/domain.js'
import {
  isIntrinsicSharedArchiveEligible,
  portfolioProgressForDecodeRole
} from '../../src/workers/algorithm/irregular/computeIrregularNesting.js'

function settings(overrides: Record<string, unknown>): IrregularNestingSettings {
  return new IrregularNestingSettings({
    ...makeDefaultIrregularNestingSettings(),
    optimizer: makeCompactQualityIrregularOptimizerSettings(overrides)
  })
}

describe('intrinsic shared archive admission', () => {
  it('enables the compact profile without a fixed reference-sheet role', () => {
    const defaults = makeDefaultIrregularNestingSettings()
    const compact = settings({})

    expect(defaults.optimizer.intrinsicSharedArchiveEnabled).toBe(false)
    expect(isIntrinsicSharedArchiveEligible(defaults)).toBe(false)
    expect(compact.optimizer.intrinsicSharedArchiveEnabled).toBe(true)
    expect(isIntrinsicSharedArchiveEligible(compact)).toBe(true)
  })

  it('keeps GA and short-side-fill policies outside the deterministic archive', () => {
    expect(
      isIntrinsicSharedArchiveEligible(
        settings({ gaEnabled: true, baselineOnly: false, gaTimeBudgetMs: 1000 })
      )
    ).toBe(false)
    expect(
      isIntrinsicSharedArchiveEligible(settings({ placementPolicyId: 'short-side-fill' }))
    ).toBe(false)
    expect(
      isIntrinsicSharedArchiveEligible(settings({ intrinsicSharedArchiveEnabled: false }))
    ).toBe(false)
  })

  it('keeps ordinary progress unmodified when no outer role is present', () => {
    const progress = new IrregularPortfolioProgress({
      phase: 'deterministic_beam',
      elapsedMs: 1
    })

    expect(portfolioProgressForDecodeRole(progress, undefined)).toBe(progress)
  })
})
