import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type {
  NestingHistoryFrame,
  NestingHistorySummary,
  NestingResult,
  NestingStrategyResult,
  ProjectHistoryRef
} from '@shared/domain/nesting.js'
import type { JobId } from '@shared/domain/ids.js'
import type { ProjectDocument } from '@shared/domain/project.js'
import { newJobId } from '../utils/ids.js'

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
}

const state: UnwrapNestedRefs<MutableHistoryState> = reactive<MutableHistoryState>({
  result: null,
  framesByRun: {},
  selectedStrategyRunId: null,
  selectedFrameIndex: -1,
  isPlaying: false,
  speed: 1,
  truncated: false,
  lastHistoryRef: null
})

let playbackTimer: ReturnType<typeof setInterval> | null = null

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
  const frameCount = computed(() => currentFrames().length)
  const hasResult = computed(() => state.result !== null)

  return {
    state: computed(() => state),
    result,
    strategyResults,
    selectedRun,
    frames,
    selectedFrame,
    frameCount,
    hasResult,

    setResult(result: NestingResult): void {
      stopPlayback()
      state.result = result
      state.framesByRun = {}
      state.truncated = false
      const first = result.strategyResults[0]
      state.selectedStrategyRunId = result.selectedStrategyRunId ?? first?.strategyRunId ?? null
      state.selectedFrameIndex = -1
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
        const ref: ProjectHistoryRef = {
          kind: 'ndjson_replay',
          jobId,
          path: summary.ndjsonPath,
          frameCount: summary.frameCount,
          createdAt: new Date().toISOString()
        }
        state.lastHistoryRef = ref
      }
    },

    selectStrategyRun(runId: string): void {
      stopPlayback()
      state.selectedStrategyRunId = runId
      const list = state.framesByRun[runId] ?? []
      state.selectedFrameIndex = list.length - 1
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
      state.result = project.lastResult ?? null
      state.framesByRun = {}
      state.selectedStrategyRunId =
        project.lastResult?.selectedStrategyRunId ??
        project.lastResult?.strategyResults[0]?.strategyRunId ??
        null
      state.selectedFrameIndex = -1
      state.isPlaying = false
      state.truncated = false
      state.lastHistoryRef = project.lastHistory ?? null
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
export const __test = { newJobId }
