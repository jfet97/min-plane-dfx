import { describe, expect, it } from 'vitest'
import {
  makeCompactQualityIrregularOptimizerSettings,
  makeDefaultIrregularNestingSettings
} from '@shared/irregular/defaults.js'
import { IrregularNestingSettings } from '@shared/irregular/domain.js'
import {
  applyCompactQualityPreset,
  irregularSettingsUiState
} from '../../src/renderer/utils/irregularSettingsUi.js'

describe('irregular settings UI', () => {
  it('applies the complete Compact preset while preserving geometry', () => {
    const initial = makeDefaultIrregularNestingSettings()
    const compact = applyCompactQualityPreset(initial)

    expect(compact.geometry).toEqual(initial.geometry)
    expect(compact.optimizer).toEqual(makeCompactQualityIrregularOptimizerSettings())
    expect(compact.optimizer.intrinsicSharedArchiveEnabled).toBe(true)
    expect(compact.optimizer.gaEnabled).toBe(false)
    expect(compact.optimizer.baselineOnly).toBe(true)
    expect(compact.optimizer.localRepairBudget).toBe(0)
    expect(compact.optimizer.transformCap).toBe(8)
  })

  it('keeps persisted transform thresholds stable for replay compatibility', () => {
    const compact = applyCompactQualityPreset(makeDefaultIrregularNestingSettings())

    expect(compact.optimizer.transformMinimumEdgeLengthMm).toBe(1.2)
    expect(compact.optimizer.transformAngleDeduplicationToleranceDeg).toBe(0.051)
  })

  it('removes legacy search controls when the Compact shared archive is active', () => {
    const compact = applyCompactQualityPreset(makeDefaultIrregularNestingSettings())

    expect(irregularSettingsUiState(compact)).toEqual({
      mode: 'compact-shared-archive',
      compactArchiveRequested: true,
      visibleControlGroups: ['geometry', 'orientations']
    })
  })

  it('marks saved legacy settings for migration without exposing legacy controls', () => {
    const base = makeDefaultIrregularNestingSettings()
    const legacy = new IrregularNestingSettings({
      geometry: base.geometry,
      optimizer: makeCompactQualityIrregularOptimizerSettings({
        intrinsicSharedArchiveEnabled: false
      })
    })
    const state = irregularSettingsUiState(legacy)

    expect(state).toEqual({
      mode: 'legacy-requires-migration',
      compactArchiveRequested: false,
      visibleControlGroups: ['geometry', 'orientations']
    })
  })

  it('reports why a requested shared archive is not the active execution path', () => {
    const base = makeDefaultIrregularNestingSettings()
    const withOptimizer = (
      overrides: Parameters<typeof makeCompactQualityIrregularOptimizerSettings>[0]
    ) =>
      new IrregularNestingSettings({
        geometry: base.geometry,
        optimizer: makeCompactQualityIrregularOptimizerSettings(overrides)
      })

    expect(
      irregularSettingsUiState(
        withOptimizer({ gaEnabled: true, baselineOnly: false, gaTimeBudgetMs: 1_000 })
      ).compactArchiveBlockedReason
    ).toBe('ga-active')
    expect(
      irregularSettingsUiState(withOptimizer({ placementPolicyId: 'short-side-fill' }))
        .compactArchiveBlockedReason
    ).toBe('short-side-fill')
  })
})
