import {
  makeCompactQualityIrregularOptimizerSettings,
  type IrregularNestingSettings,
  IrregularNestingSettings as IrregularNestingSettingsModel
} from '@shared/irregular/index.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'

export type IrregularSettingsControlGroup =
  | 'geometry'
  | 'orientations'
  | 'legacy-beam'
  | 'legacy-local-scoring'
  | 'legacy-ga'

export interface IrregularSettingsUiState {
  readonly mode: 'compact-shared-archive' | 'legacy-beam-ga'
  readonly compactArchiveRequested: boolean
  readonly compactArchiveBlockedReason?: 'ga-active' | 'short-side-fill'
  readonly visibleControlGroups: ReadonlyArray<IrregularSettingsControlGroup>
}

const SHARED_CONTROL_GROUPS = ['geometry', 'orientations'] as const
const LEGACY_CONTROL_GROUPS = ['legacy-beam', 'legacy-local-scoring', 'legacy-ga'] as const

/** Derives the visible settings surface from the same Compact eligibility contract as the worker. */
export function irregularSettingsUiState(
  settings: IrregularNestingSettings
): IrregularSettingsUiState {
  const eligibility = intrinsicSharedArchiveEligibility(settings.optimizer)
  if (eligibility.eligible) {
    return {
      mode: 'compact-shared-archive',
      compactArchiveRequested: true,
      visibleControlGroups: SHARED_CONTROL_GROUPS
    }
  }

  return {
    mode: 'legacy-beam-ga',
    compactArchiveRequested: settings.optimizer.intrinsicSharedArchiveEnabled === true,
    ...(eligibility.reason === 'archive-disabled'
      ? {}
      : { compactArchiveBlockedReason: eligibility.reason }),
    visibleControlGroups: [...SHARED_CONTROL_GROUPS, ...LEGACY_CONTROL_GROUPS]
  }
}

/** Applies the complete Compact optimizer preset without changing collision geometry settings. */
export function applyCompactQualityPreset(
  settings: IrregularNestingSettings
): IrregularNestingSettings {
  return new IrregularNestingSettingsModel({
    geometry: settings.geometry,
    optimizer: makeCompactQualityIrregularOptimizerSettings()
  })
}
