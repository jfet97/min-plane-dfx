import {
  makeCompactQualityIrregularOptimizerSettings,
  makeCompactShortSideIrregularOptimizerSettings,
  type IrregularNestingSettings,
  IrregularNestingSettings as IrregularNestingSettingsModel
} from '@shared/irregular/index.js'
import { intrinsicSharedArchiveEligibility } from '@shared/irregular/executionMode.js'

export type IrregularSettingsControlGroup =
  | 'objective'
  | 'geometry'
  | 'orientations'

export interface IrregularSettingsUiState {
  readonly mode:
    | 'compact-shared-archive'
    | 'compact-short-side'
    | 'legacy-requires-migration'
  readonly compactArchiveRequested: boolean
  readonly compactArchiveBlockedReason?: 'ga-active' | 'short-side-fill'
  readonly visibleControlGroups: ReadonlyArray<IrregularSettingsControlGroup>
}

const SHARED_CONTROL_GROUPS = ['objective', 'geometry', 'orientations'] as const

/** Derives the visible settings surface from the same Compact eligibility contract as the worker. */
export function irregularSettingsUiState(
  settings: IrregularNestingSettings
): IrregularSettingsUiState {
  const eligibility = intrinsicSharedArchiveEligibility(settings.optimizer)
  if (eligibility.eligible) {
    return {
      mode:
        settings.optimizer.intrinsicObjectiveProfileId === 'short-side'
          ? 'compact-short-side'
          : 'compact-shared-archive',
      compactArchiveRequested: true,
      visibleControlGroups: SHARED_CONTROL_GROUPS
    }
  }

  return {
    mode: 'legacy-requires-migration',
    compactArchiveRequested: settings.optimizer.intrinsicSharedArchiveEnabled === true,
    ...(eligibility.reason === 'archive-disabled'
      ? {}
      : { compactArchiveBlockedReason: eligibility.reason }),
    visibleControlGroups: SHARED_CONTROL_GROUPS
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

/** Applies the Short Side Compact profile without changing collision geometry settings. */
export function applyCompactShortSidePreset(
  settings: IrregularNestingSettings
): IrregularNestingSettings {
  return new IrregularNestingSettingsModel({
    geometry: settings.geometry,
    optimizer: makeCompactShortSideIrregularOptimizerSettings()
  })
}
