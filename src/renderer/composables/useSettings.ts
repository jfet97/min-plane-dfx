import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type { SheetSpec, NestingOptions } from '@shared/domain/nesting.js'
import type { ProjectDocument, WorkspaceProjectSettings } from '@shared/domain/project.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'
import { DEFAULT_LAYOUT_SELECTION_STRATEGY_ID } from '@shared/domain/layoutSelectionStrategies.js'

export interface SettingsState {
  sheet: SheetSpec
  padding: number
  options: NestingOptions
}

interface MutableSettingsState {
  sheet: { width: number; height: number; label: string }
  padding: number
  options: {
    allowGlobalRotation: boolean
    timeoutMs: number
    workerMode: 'maxrects-beam-search'
    historyMode: 'stream' | 'final' | 'off'
    historyScope: 'winning_path'
    strategySelectionMode: 'single' | 'all_configured'
    strategyIds: string[]
    layoutSelectionStrategyId: string
    finalSelectionMode: 'manual' | 'best' | 'top_n'
    topN?: number | undefined
    maxHistoryEvents?: number | undefined
  }
}

type WorkspaceSettingsPersistor = (mode?: 'queued' | 'immediate') => void

let workspaceSettingsPersistor: WorkspaceSettingsPersistor | null = null

function notifyWorkspaceSettingsChanged(mode: 'queued' | 'immediate' = 'queued'): void {
  workspaceSettingsPersistor?.(mode)
}

export function makeDefaultSettings(): MutableSettingsState {
  return {
    sheet: { width: 1000, height: 1000, label: 'default 1x1 m' },
    padding: 10,
    options: {
      allowGlobalRotation: true,
      timeoutMs: 30000,
      workerMode: 'maxrects-beam-search',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [DEFAULT_STRATEGY_ID],
      layoutSelectionStrategyId: DEFAULT_LAYOUT_SELECTION_STRATEGY_ID,
      finalSelectionMode: 'manual',
      topN: 3
    }
  }
}

const state: UnwrapNestedRefs<MutableSettingsState> =
  reactive<MutableSettingsState>(makeDefaultSettings())

function replaceOptions(options: NestingOptions): void {
  state.options.allowGlobalRotation = options.allowGlobalRotation
  state.options.timeoutMs = options.timeoutMs
  state.options.workerMode = options.workerMode
  state.options.historyMode = options.historyMode
  state.options.historyScope = options.historyScope
  state.options.strategySelectionMode = options.strategySelectionMode
  state.options.strategyIds = [...options.strategyIds]
  state.options.layoutSelectionStrategyId = options.layoutSelectionStrategyId
  state.options.finalSelectionMode = options.finalSelectionMode
  state.options.topN = options.topN
  state.options.maxHistoryEvents = options.maxHistoryEvents
}

export function useSettings() {
  return {
    state: computed(() => state),
    setWorkspaceSettingsPersistor: (persistor: WorkspaceSettingsPersistor | null): void => {
      workspaceSettingsPersistor = persistor
    },
    setSheetWidth: (width: number): void => {
      state.sheet.width = Math.max(0, Math.round(width))
      notifyWorkspaceSettingsChanged()
    },
    setSheetHeight: (height: number): void => {
      state.sheet.height = Math.max(0, Math.round(height))
      notifyWorkspaceSettingsChanged()
    },
    setSheetLabel: (label: string): void => {
      state.sheet.label = label
      notifyWorkspaceSettingsChanged()
    },
    setPadding: (padding: number): void => {
      state.padding = Math.max(0, Math.round(padding))
      notifyWorkspaceSettingsChanged()
    },
    setAllowGlobalRotation: (allow: boolean): void => {
      state.options.allowGlobalRotation = allow
      notifyWorkspaceSettingsChanged()
    },
    setTimeoutMs: (timeoutMs: number): void => {
      state.options.timeoutMs = Math.max(1000, timeoutMs)
      notifyWorkspaceSettingsChanged()
    },
    setHistoryMode: (mode: 'stream' | 'final' | 'off'): void => {
      state.options.historyMode = mode
      notifyWorkspaceSettingsChanged()
    },
    setStrategySelectionMode: (mode: 'single' | 'all_configured'): void => {
      state.options.strategySelectionMode = mode
      notifyWorkspaceSettingsChanged('immediate')
    },
    setLayoutSelectionStrategyId: (id: string): void => {
      state.options.layoutSelectionStrategyId = id
      notifyWorkspaceSettingsChanged('immediate')
    },
    setFinalSelectionMode: (mode: 'manual' | 'best' | 'top_n'): void => {
      state.options.finalSelectionMode = mode
      notifyWorkspaceSettingsChanged()
    },
    setTopN: (n: number): void => {
      state.options.topN = Math.max(1, n)
      notifyWorkspaceSettingsChanged()
    },
    toggleStrategyId: (id: string): void => {
      const idx = state.options.strategyIds.indexOf(id)
      if (idx >= 0) {
        state.options.strategyIds.splice(idx, 1)
      } else {
        state.options.strategyIds.push(id)
      }
      notifyWorkspaceSettingsChanged('immediate')
    },
    setStrategyIds: (ids: ReadonlyArray<string>): void => {
      state.options.strategyIds = [...ids]
      notifyWorkspaceSettingsChanged('immediate')
    },
    resetDefaults: (): void => {
      const defaults = makeDefaultSettings()
      state.sheet.width = defaults.sheet.width
      state.sheet.height = defaults.sheet.height
      state.sheet.label = defaults.sheet.label
      state.padding = defaults.padding
      replaceOptions(defaults.options)
      notifyWorkspaceSettingsChanged()
    },
    hydrateFromProject: (project: ProjectDocument): void => {
      state.sheet.width = project.sheet.width
      state.sheet.height = project.sheet.height
      state.sheet.label = project.sheet.label
      state.padding = project.padding
      replaceOptions(project.options)
    },
    hydrateWorkspaceSettings: (settings: WorkspaceProjectSettings): void => {
      state.sheet.width = settings.sheet.width
      state.sheet.height = settings.sheet.height
      state.sheet.label = settings.sheet.label
      state.padding = settings.padding
      replaceOptions(settings.options)
    }
  }
}
