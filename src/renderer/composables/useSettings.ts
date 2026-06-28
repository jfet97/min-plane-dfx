import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type { SheetSpec, NestingOptions } from '@shared/domain/nesting.js'
import type { ProjectDocument } from '@shared/domain/project.js'
import { DEFAULT_STRATEGY_ID } from '@shared/domain/strategies.js'

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
    workerMode: 'stub'
    historyMode: 'stream' | 'final' | 'off'
    historyScope: 'winning_path'
    strategySelectionMode: 'single' | 'all_configured'
    strategyIds: string[]
    finalSelectionMode: 'manual' | 'best' | 'top_n'
    topN?: number | undefined
    maxHistoryEvents?: number | undefined
  }
}

export function makeDefaultSettings(): MutableSettingsState {
  return {
    sheet: { width: 1000, height: 1000, label: 'default 1x1 m' },
    padding: 2,
    options: {
      allowGlobalRotation: true,
      timeoutMs: 30000,
      workerMode: 'stub',
      historyMode: 'final',
      historyScope: 'winning_path',
      strategySelectionMode: 'single',
      strategyIds: [DEFAULT_STRATEGY_ID],
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
  state.options.finalSelectionMode = options.finalSelectionMode
  state.options.topN = options.topN
  state.options.maxHistoryEvents = options.maxHistoryEvents
}

export function useSettings() {
  return {
    state: computed(() => state),
    setSheetWidth: (width: number): void => {
      state.sheet.width = Math.max(0, width)
    },
    setSheetHeight: (height: number): void => {
      state.sheet.height = Math.max(0, height)
    },
    setSheetLabel: (label: string): void => {
      state.sheet.label = label
    },
    setPadding: (padding: number): void => {
      state.padding = Math.max(0, padding)
    },
    setAllowGlobalRotation: (allow: boolean): void => {
      state.options.allowGlobalRotation = allow
    },
    setTimeoutMs: (timeoutMs: number): void => {
      state.options.timeoutMs = Math.max(1000, timeoutMs)
    },
    setHistoryMode: (mode: 'stream' | 'final' | 'off'): void => {
      state.options.historyMode = mode
    },
    setStrategySelectionMode: (mode: 'single' | 'all_configured'): void => {
      state.options.strategySelectionMode = mode
    },
    setFinalSelectionMode: (mode: 'manual' | 'best' | 'top_n'): void => {
      state.options.finalSelectionMode = mode
    },
    setTopN: (n: number): void => {
      if (state.options.topN === undefined) {
        state.options.topN = Math.max(1, n)
      } else {
        state.options.topN = Math.max(1, n)
      }
    },
    toggleStrategyId: (id: string): void => {
      const idx = state.options.strategyIds.indexOf(id)
      if (idx >= 0) {
        state.options.strategyIds.splice(idx, 1)
      } else {
        state.options.strategyIds.push(id)
      }
    },
    resetDefaults: (): void => {
      const defaults = makeDefaultSettings()
      state.sheet.width = defaults.sheet.width
      state.sheet.height = defaults.sheet.height
      state.sheet.label = defaults.sheet.label
      state.padding = defaults.padding
      replaceOptions(defaults.options)
    },
    hydrateFromProject: (project: ProjectDocument): void => {
      state.sheet.width = project.sheet.width
      state.sheet.height = project.sheet.height
      state.sheet.label = project.sheet.label
      state.padding = project.padding
      replaceOptions(project.options)
    }
  }
}
