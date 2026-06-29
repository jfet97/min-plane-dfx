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
  selectedStepIndex: number
  selectedBeamRank: number
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
  selectedStepIndex: -1,
  selectedBeamRank: 0,
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
      const steps = currentStepIndexes()
      if (steps.length === 0) {
        stopPlayback()
        return
      }
      const current = currentStepPosition(steps)
      if (current >= steps.length - 1) {
        stopPlayback()
        return
      }
      state.selectedStepIndex = steps[Math.min(steps.length - 1, current + 1)] ?? -1
      preserveOrResetBeamRank()
    },
    Math.max(50, Math.round(baseIntervalMs / Math.max(0.25, state.speed)))
  )
}

function currentFrames(): NestingHistoryFrame[] {
  if (!state.selectedStrategyRunId) return []
  return state.framesByRun[state.selectedStrategyRunId] ?? []
}

function currentStepIndexes(): ReadonlyArray<number> {
  return [...new Set(currentFrames().map((frame) => frame.stepIndex))].sort((a, b) => a - b)
}

function currentStepPosition(steps: ReadonlyArray<number>): number {
  if (steps.length === 0) return -1
  const exact = steps.indexOf(state.selectedStepIndex)
  if (exact >= 0) return exact
  return Math.max(0, steps.length - 1)
}

function latestStepIndex(frames: ReadonlyArray<NestingHistoryFrame>): number {
  if (frames.length === 0) return -1
  const latestStep = Math.max(...frames.map((frame) => frame.stepIndex))
  return latestStep
}

function selectedFrameFromList(
  frames: ReadonlyArray<NestingHistoryFrame>
): NestingHistoryFrame | null {
  if (frames.length === 0 || state.selectedStepIndex < 0) return null
  const exact = frames.find(
    (frame) =>
      frame.stepIndex === state.selectedStepIndex && frame.beamRank === state.selectedBeamRank
  )
  if (exact) return exact
  return (
    frames
      .filter((frame) => frame.stepIndex === state.selectedStepIndex)
      .sort((a, b) => a.beamRank - b.beamRank)[0] ?? null
  )
}

function preserveOrResetBeamRank(): void {
  const exists = currentFrames().some(
    (frame) =>
      frame.stepIndex === state.selectedStepIndex && frame.beamRank === state.selectedBeamRank
  )
  if (!exists) {
    state.selectedBeamRank = 0
  }
}

function recoverRunRecordHistory(record: ProjectRunRecord): ProjectHistoryRef | null {
  if (record.history) return record.history
  const summary = record.result.historySummary
  if (!summary?.ndjsonPath) return null
  return new ProjectHistoryRefModel({
    kind: 'ndjson_replay',
    jobId: record.jobId,
    path: summary.ndjsonPath,
    frameCount: summary.frameCount,
    createdAt: record.createdAt
  })
}

function recoverRunRecord(record: ProjectRunRecord): ProjectRunRecord {
  const recovered = recoverRunRecordHistory(record)
  if (recovered === record.history) return record
  return { ...record, history: recovered }
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
    return selectedFrameFromList(currentFrames())
  })
  const selectedStepFrames = computed<ReadonlyArray<NestingHistoryFrame>>(() => {
    const selected = selectedFrame.value
    if (!selected) return []
    return [...currentFrames()]
      .filter((frame) => frame.stepIndex === selected.stepIndex)
      .sort((a, b) => a.beamRank - b.beamRank)
  })
  const frameCount = computed(() => currentFrames().length)
  const stepIndexes = computed(() => currentStepIndexes())
  const stepCount = computed(() => stepIndexes.value.length)
  const selectedStepPosition = computed(() => currentStepPosition(stepIndexes.value))
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
    stepIndexes,
    stepCount,
    selectedStepPosition,
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
      state.selectedStepIndex = latestStepIndex(currentFrames())
      state.selectedBeamRank = 0
    },

    addRunRecord(record: ProjectRunRecord): void {
      const normalizedRecord = recoverRunRecord(record)
      state.runRecords = [
        normalizedRecord,
        ...state.runRecords.filter((existing) => existing.jobId !== normalizedRecord.jobId)
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
        state.selectedStepIndex = -1
        state.selectedBeamRank = 0
        state.truncated = false
        state.lastHistoryRef = null
      }
      notifyWorkspaceSettingsChanged()
    },

    clearRunRecords(): void {
      stopPlayback()
      state.runRecords = []
      state.result = null
      state.framesByRun = {}
      state.selectedStrategyRunId = null
      state.selectedStepIndex = -1
      state.selectedBeamRank = 0
      state.truncated = false
      state.lastHistoryRef = null
      notifyWorkspaceSettingsChanged()
    },

    selectRunRecord(record: ProjectRunRecord): void {
      stopPlayback()
      const normalizedRecord = recoverRunRecord(record)
      state.runRecords = state.runRecords.map((existing) =>
        existing.jobId === normalizedRecord.jobId ? normalizedRecord : existing
      )
      state.result = normalizedRecord.result
      state.framesByRun = {}
      state.selectedStrategyRunId =
        normalizedRecord.result.selectedStrategyRunId ??
        normalizedRecord.result.strategyResults[0]?.strategyRunId ??
        null
      state.selectedStepIndex = -1
      state.selectedBeamRank = 0
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = normalizedRecord.history
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
      // snap to the latest top state until the user chooses a step/rank
      if (state.selectedStrategyRunId === runId && state.selectedStepIndex < 0) {
        state.selectedStepIndex = frame.stepIndex
        state.selectedBeamRank = 0
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
      state.selectedStepIndex = latestStepIndex(list)
      state.selectedBeamRank = 0
    },

    selectStepPosition(idx: number): void {
      stopPlayback()
      const steps = currentStepIndexes()
      if (steps.length === 0) {
        state.selectedStepIndex = -1
        state.selectedBeamRank = 0
        return
      }
      state.selectedStepIndex = steps[Math.max(0, Math.min(idx, steps.length - 1))] ?? -1
      preserveOrResetBeamRank()
    },

    selectBeamRank(rank: number): void {
      stopPlayback()
      const selected = selectedFrame.value
      if (!selected) return
      const exists = currentFrames().some(
        (frame) => frame.stepIndex === selected.stepIndex && frame.beamRank === rank
      )
      if (exists) {
        state.selectedBeamRank = rank
      }
    },

    stepFrame(direction: -1 | 1): void {
      stopPlayback()
      const steps = currentStepIndexes()
      if (steps.length === 0) return
      const current = currentStepPosition(steps)
      state.selectedStepIndex =
        steps[Math.max(0, Math.min(steps.length - 1, current + direction))] ?? -1
      preserveOrResetBeamRank()
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

    clearRunRecordHistory(jobId: JobId): void {
      state.runRecords = state.runRecords.map((record) =>
        record.jobId === jobId ? { ...record, history: null } : record
      )
      if (state.result?.jobId === jobId) {
        state.lastHistoryRef = null
      }
      notifyWorkspaceSettingsChanged()
    },

    hydrateFromProject(project: ProjectDocument): void {
      stopPlayback()
      state.runRecords = (project.runRecords ?? []).map(recoverRunRecord)
      state.result = project.lastResult ?? state.runRecords[0]?.result ?? null
      state.framesByRun = {}
      state.selectedStrategyRunId =
        state.result?.selectedStrategyRunId ??
        state.result?.strategyResults[0]?.strategyRunId ??
        null
      state.selectedStepIndex = -1
      state.selectedBeamRank = 0
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = project.lastHistory ?? state.runRecords[0]?.history ?? null
    },

    hydrateWorkspaceSettings(settings: WorkspaceProjectSettings): void {
      stopPlayback()
      state.runRecords = (settings.runRecords ?? []).map(recoverRunRecord)
      state.result = state.runRecords[0]?.result ?? null
      state.framesByRun = {}
      state.selectedStrategyRunId =
        state.result?.selectedStrategyRunId ??
        state.result?.strategyResults[0]?.strategyRunId ??
        null
      state.selectedStepIndex = -1
      state.selectedBeamRank = 0
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = state.runRecords[0]?.history ?? null
    },

    clear(): void {
      stopPlayback()
      state.result = null
      state.framesByRun = {}
      state.selectedStrategyRunId = null
      state.selectedStepIndex = -1
      state.selectedBeamRank = 0
      state.truncated = false
      state.lastHistoryRef = null
    }
  }
}

// Exported for tests; not part of the public API surface.
export const __test = { newJobId: JobId.make }
