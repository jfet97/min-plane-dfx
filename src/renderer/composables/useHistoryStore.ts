import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import { ProjectHistoryRef as ProjectHistoryRefModel } from '@shared/domain/nesting.js'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingResult,
  NestingStrategyResult,
  ProjectHistoryRef
} from '@shared/domain/nesting.js'
import { JobId } from '@shared/domain/ids.js'
import type {
  ProjectDocument,
  ProjectRunRecord,
  WorkspaceProjectSettings
} from '@shared/domain/project.js'

/**
 * Bounded history retention policy. Keeps the most recent N frames in memory;
 * older frames are dropped. NDJSON replay remains the source of truth for the
 * full history.
 */
const MAX_RETAINED_FRAMES = 500

interface MutableHistoryState {
  result: NestingResult | null
  framesByRun: Record<string, NestingHistoryFrame[]>
  selectedStrategyRunId: string | null
  selectedFrameIndex: number
  isPlaying: boolean
  speed: number
  truncated: boolean
  lastHistoryRef: ProjectHistoryRef | null
  runRecords: ProjectRunRecord[]
}

const state: UnwrapNestedRefs<MutableHistoryState> = reactive<MutableHistoryState>({
  result: null,
  framesByRun: {},
  selectedStrategyRunId: null,
  selectedFrameIndex: -1,
  isPlaying: false,
  speed: 1,
  truncated: false,
  lastHistoryRef: null,
  runRecords: []
})

let playbackTimer: ReturnType<typeof setInterval> | null = null
type WorkspaceSettingsPersistor = () => void
let workspaceSettingsPersistor: WorkspaceSettingsPersistor | null = null

function notifyWorkspaceSettingsChanged(): void {
  workspaceSettingsPersistor?.()
}

function stopPlayback(): void {
  if (playbackTimer !== null) {
    clearInterval(playbackTimer)
    playbackTimer = null
  }
  state.isPlaying = false
}

function startPlayback(): void {
  if (state.isPlaying) return
  state.isPlaying = true
  const baseIntervalMs = 250
  playbackTimer = setInterval(
    () => {
      const frames = currentFrames()
      if (frames.length === 0) {
        stopPlayback()
        return
      }
      if (state.selectedFrameIndex >= frames.length - 1) {
        stopPlayback()
        return
      }
      state.selectedFrameIndex = Math.min(frames.length - 1, state.selectedFrameIndex + 1)
    },
    Math.max(50, Math.round(baseIntervalMs / Math.max(0.25, state.speed)))
  )
}

function currentFrames(): NestingHistoryFrame[] {
  if (!state.selectedStrategyRunId) return []
  return state.framesByRun[state.selectedStrategyRunId] ?? []
}

function latestTopFrameIndex(frames: ReadonlyArray<NestingHistoryFrame>): number {
  if (frames.length === 0) return -1
  const latestStep = Math.max(...frames.map((frame) => frame.stepIndex))
  const topIndex = frames.findIndex(
    (frame) => frame.stepIndex === latestStep && frame.beamRank === 0
  )
  if (topIndex >= 0) return topIndex
  return frames.findIndex((frame) => frame.stepIndex === latestStep)
}

export function useHistoryStore() {
  const result = computed(() => state.result)
  const strategyResults = computed<ReadonlyArray<NestingStrategyResult>>(
    () => state.result?.strategyResults ?? []
  )
  const selectedRun = computed<NestingStrategyResult | null>(() => {
    if (!state.selectedStrategyRunId) return null
    return (
      state.result?.strategyResults.find((s) => s.strategyRunId === state.selectedStrategyRunId) ??
      null
    )
  })
  const frames = computed(() => currentFrames())
  const selectedFrame = computed<NestingHistoryFrame | null>(() => {
    const list = currentFrames()
    const idx = state.selectedFrameIndex
    if (idx < 0 || idx >= list.length) return null
    return list[idx] ?? null
  })
  const selectedStepFrames = computed<ReadonlyArray<NestingHistoryFrame>>(() => {
    const selected = selectedFrame.value
    if (!selected) return []
    return [...currentFrames()]
      .filter((frame) => frame.stepIndex === selected.stepIndex)
      .sort((a, b) => a.beamRank - b.beamRank)
  })
  const frameCount = computed(() => currentFrames().length)
  const hasResult = computed(() => state.result !== null)
  const runRecords = computed<ReadonlyArray<ProjectRunRecord>>(() => state.runRecords)
  const selectedRunRecord = computed<ProjectRunRecord | null>(() => {
    const jobId = state.result?.jobId
    if (!jobId) return null
    return state.runRecords.find((record) => record.jobId === jobId) ?? null
  })

  return {
    state: computed(() => state),
    result,
    strategyResults,
    selectedRun,
    frames,
    selectedFrame,
    selectedStepFrames,
    frameCount,
    hasResult,
    runRecords,
    selectedRunRecord,

    setWorkspaceSettingsPersistor(persistor: WorkspaceSettingsPersistor | null): void {
      workspaceSettingsPersistor = persistor
    },

    setResult(result: NestingResult): void {
      stopPlayback()
      state.result = result
      state.truncated = false
      const first = result.strategyResults[0]
      state.selectedStrategyRunId = result.selectedStrategyRunId ?? first?.strategyRunId ?? null
      state.selectedFrameIndex = latestTopFrameIndex(currentFrames())
    },

    addRunRecord(record: ProjectRunRecord): void {
      state.runRecords = [
        record,
        ...state.runRecords.filter((existing) => existing.jobId !== record.jobId)
      ]
      notifyWorkspaceSettingsChanged()
    },

    removeRunRecord(jobId: JobId): void {
      state.runRecords = state.runRecords.filter((record) => record.jobId !== jobId)
      if (state.result?.jobId === jobId) {
        stopPlayback()
        state.result = null
        state.framesByRun = {}
        state.selectedStrategyRunId = null
        state.selectedFrameIndex = -1
        state.truncated = false
        state.lastHistoryRef = null
      }
      notifyWorkspaceSettingsChanged()
    },

    selectRunRecord(record: ProjectRunRecord): void {
      stopPlayback()
      state.result = record.result
      state.framesByRun = {}
      state.selectedStrategyRunId =
        record.result.selectedStrategyRunId ??
        record.result.strategyResults[0]?.strategyRunId ??
        null
      state.selectedFrameIndex = -1
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = record.history
    },

    pushFrame(frame: NestingHistoryFrame): void {
      const runId = frame.strategyRunId
      const existing = state.framesByRun[runId] ?? []
      const next = [...existing, frame]
      if (next.length > MAX_RETAINED_FRAMES) {
        next.splice(0, next.length - MAX_RETAINED_FRAMES)
        state.truncated = true
      }
      state.framesByRun[runId] = next
      // Snap selectedFrameIndex to the latest frame when the user has not
      // explicitly chosen one yet for this run.
      if (state.selectedStrategyRunId === runId && state.selectedFrameIndex < 0) {
        state.selectedFrameIndex = next.length - 1
      }
    },

    completeRun(jobId: JobId, summary: NestingHistorySummary): void {
      // Persist a ProjectHistoryRef so the renderer can offer NDJSON export
      // even when the renderer has only a bounded in-memory window.
      if (summary.ndjsonPath) {
        const ref = new ProjectHistoryRefModel({
          kind: 'ndjson_replay',
          jobId,
          path: summary.ndjsonPath,
          frameCount: summary.frameCount,
          createdAt: new Date().toISOString()
        })
        state.lastHistoryRef = ref
      }
    },

    selectStrategyRun(runId: string): void {
      stopPlayback()
      state.selectedStrategyRunId = runId
      const list = state.framesByRun[runId] ?? []
      state.selectedFrameIndex = latestTopFrameIndex(list)
    },

    selectFrameIndex(idx: number): void {
      stopPlayback()
      const list = currentFrames()
      if (list.length === 0) {
        state.selectedFrameIndex = -1
        return
      }
      state.selectedFrameIndex = Math.max(0, Math.min(idx, list.length - 1))
    },

    selectBeamRank(rank: number): void {
      stopPlayback()
      const selected = selectedFrame.value
      const list = currentFrames()
      if (!selected || list.length === 0) return
      const nextIndex = list.findIndex(
        (frame) => frame.stepIndex === selected.stepIndex && frame.beamRank === rank
      )
      if (nextIndex >= 0) {
        state.selectedFrameIndex = nextIndex
      }
    },

    stepFrame(direction: -1 | 1): void {
      stopPlayback()
      const list = currentFrames()
      if (list.length === 0) return
      state.selectedFrameIndex = Math.max(
        0,
        Math.min(list.length - 1, state.selectedFrameIndex + direction)
      )
    },

    togglePlayback(): void {
      if (state.isPlaying) {
        stopPlayback()
      } else {
        startPlayback()
      }
    },

    setSpeed(speed: number): void {
      state.speed = Math.max(0.25, Math.min(8, speed))
      if (state.isPlaying) {
        stopPlayback()
        startPlayback()
      }
    },

    setLastHistoryRef(ref: ProjectHistoryRef | null): void {
      state.lastHistoryRef = ref
    },

    hydrateFromProject(project: ProjectDocument): void {
      stopPlayback()
      state.runRecords = [...(project.runRecords ?? [])]
      state.result = project.lastResult ?? state.runRecords[0]?.result ?? null
      state.framesByRun = {}
      state.selectedStrategyRunId =
        state.result?.selectedStrategyRunId ??
        state.result?.strategyResults[0]?.strategyRunId ??
        null
      state.selectedFrameIndex = -1
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = project.lastHistory ?? state.runRecords[0]?.history ?? null
    },

    hydrateWorkspaceSettings(settings: WorkspaceProjectSettings): void {
      stopPlayback()
      state.runRecords = [...(settings.runRecords ?? [])]
      state.result = state.runRecords[0]?.result ?? null
      state.framesByRun = {}
      state.selectedStrategyRunId =
        state.result?.selectedStrategyRunId ??
        state.result?.strategyResults[0]?.strategyRunId ??
        null
      state.selectedFrameIndex = -1
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = state.runRecords[0]?.history ?? null
    },

    clear(): void {
      stopPlayback()
      state.result = null
      state.framesByRun = {}
      state.selectedStrategyRunId = null
      state.selectedFrameIndex = -1
      state.truncated = false
      state.lastHistoryRef = null
    }
  }
}

// Exported for tests; not part of the public API surface.
export const __test = { newJobId: JobId.make }
