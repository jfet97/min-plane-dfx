import { describe, expect, it } from 'vitest'
import { NestingOptions, SheetSpec } from '@shared/domain/nesting.js'
import { ProjectDocument, WorkspaceProjectSettings } from '@shared/domain/project.js'
import { useSettings } from '../../src/renderer/composables/useSettings.js'
import {
  normalizeWorkerTimeoutPatch,
  workerTimeoutForEdit
} from '../../src/renderer/utils/workerTimeoutEdit.js'

function options(
  workerMode: NestingOptions['workerMode'],
  timeoutMs: number
): NestingOptions {
  return new NestingOptions({
    allowGlobalRotation: true,
    allowGlobalMirror: true,
    timeoutMs,
    workerMode,
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [],
    layoutSelectionStrategyId: 'compact-first',
    finalSelectionMode: 'manual'
  })
}

const sheet = new SheetSpec({ width: 1000, height: 1000, label: 'hydration test' })

describe('settings timeout hydration', () => {
  it('raises a stale irregular project timeout to the current floor', () => {
    const settings = useSettings()
    settings.hydrateFromProject(
      new ProjectDocument({
        version: 2,
        savedAt: '2026-07-19T00:00:00.000Z',
        sourceFiles: [],
        importedPieces: [],
        sheet,
        padding: 0,
        options: options('irregular-convex-v2', 60_000)
      })
    )

    expect(settings.state.value.options.timeoutMs).toBe(120_000)
  })

  it('preserves a larger custom irregular workspace timeout', () => {
    const settings = useSettings()
    settings.hydrateWorkspaceSettings(
      new WorkspaceProjectSettings({
        sheet,
        padding: 0,
        pieceQuantities: {},
        options: options('irregular-convex-v2', 180_000)
      })
    )

    expect(settings.state.value.options.timeoutMs).toBe(180_000)
  })

  it('raises a stale irregular workspace timeout to the current floor', () => {
    const settings = useSettings()
    settings.hydrateWorkspaceSettings(
      new WorkspaceProjectSettings({
        sheet,
        padding: 0,
        pieceQuantities: {},
        options: options('irregular-convex-v2', 60_000)
      })
    )

    expect(settings.state.value.options.timeoutMs).toBe(120_000)
  })

  it('preserves rectangular workspace timeouts', () => {
    const settings = useSettings()
    settings.hydrateWorkspaceSettings(
      new WorkspaceProjectSettings({
        sheet,
        padding: 0,
        pieceQuantities: {},
        options: options('maxrects-beam-search', 60_000)
      })
    )

    expect(settings.state.value.options.timeoutMs).toBe(60_000)
  })

  it('normalizes every direct composable timeout edit for the active worker', () => {
    const settings = useSettings()
    settings.setWorkerMode('irregular-convex-v2')
    settings.setTimeoutMs(1_000)
    expect(settings.state.value.options.timeoutMs).toBe(120_000)

    settings.setTimeoutMs(180_000)
    expect(settings.state.value.options.timeoutMs).toBe(180_000)

    settings.setWorkerMode('maxrects-beam-search')
    settings.setTimeoutMs(1_000)
    expect(settings.state.value.options.timeoutMs).toBe(1_000)
  })

  it('normalizes the timeout values emitted by local settings models', () => {
    const irregular = options('irregular-convex-v2', 180_000)
    const rectangular = options('maxrects-beam-search', 1_000)
    expect(normalizeWorkerTimeoutPatch(irregular, { timeoutMs: 1_000 }).timeoutMs).toBe(120_000)
    expect(normalizeWorkerTimeoutPatch(irregular, { timeoutMs: 180_000 }).timeoutMs).toBe(180_000)
    expect(normalizeWorkerTimeoutPatch(rectangular, { timeoutMs: 1_000 }).timeoutMs).toBe(1_000)
    expect(
      normalizeWorkerTimeoutPatch(rectangular, { workerMode: 'irregular-convex-v2' }).timeoutMs
    ).toBe(120_000)
    expect(workerTimeoutForEdit('irregular-convex-v2', 1_000)).toBe(120_000)
  })
})
