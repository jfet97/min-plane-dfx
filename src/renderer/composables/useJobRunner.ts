import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type {
  NestingRequest,
  NestingResult,
  NestingHistoryFramePayload,
  NestingHistorySummary
} from '@shared/domain/nesting.js'
import type { NestingHistoryEvent, Unsubscribe } from '@shared/protocol/ipc.js'
import type { JobId } from '@shared/domain/ids.js'
import type { WorkerProgress } from '@shared/protocol/worker.js'

type RunnerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

interface MutableRunnerState {
  status: RunnerStatus
  activeJobId: JobId | null
  lastError: string | null
  result: NestingResult | null
  progress: WorkerProgress | null
}

const state: UnwrapNestedRefs<MutableRunnerState> = reactive<MutableRunnerState>({
  status: 'idle',
  activeJobId: null,
  lastError: null,
  result: null,
  progress: null
})

let historyUnsub: Unsubscribe | null = null

export interface RunNestingBindings {
  readonly onHistoryFrame: (frame: NestingHistoryFramePayload) => void
  readonly onHistoryComplete: (jobId: JobId, summary: NestingHistorySummary) => void
  readonly onResult: (result: NestingResult) => void | Promise<void>
  readonly onError: (message: string) => void
  readonly onProgress?: (progress: WorkerProgress) => void
}

export function useJobRunner() {
  return {
    state: computed(() => state),
    status: computed(() => state.status),
    statusLabel: computed(() => progressLabel(state.status, state.progress)),

    async start(request: NestingRequest, bindings: RunNestingBindings): Promise<void> {
      const api = window.appApi
      if (!api) return

      state.status = 'running'
      state.activeJobId = request.jobId
      state.lastError = null
      state.result = null
      state.progress = null

      historyUnsub?.()
      historyUnsub = api.onNestingHistory((event) => {
        handleWorkerEvent(event, bindings)
      })

      try {
        const result = await api.runNesting(request)
        if (state.activeJobId !== request.jobId) return
        state.result = result
        state.status = 'completed'
        state.activeJobId = null
        await bindings.onResult(result)
        historyUnsub?.()
        historyUnsub = null
      } catch (err) {
        if (state.activeJobId !== request.jobId) return
        state.status = 'failed'
        state.lastError = err instanceof Error ? err.message : String(err)
        console.error('[renderer:nesting] run failed', {
          jobId: request.jobId,
          message: state.lastError
        })
        bindings.onError(state.lastError)
        historyUnsub?.()
        historyUnsub = null
        state.activeJobId = null
      }
    },

    cancel(): void {
      const api = window.appApi
      if (!api || state.activeJobId === null) return
      void api.cancelJob(state.activeJobId)
      state.status = 'cancelled'
      state.activeJobId = null
      state.progress = null
      historyUnsub?.()
      historyUnsub = null
    },

    clear(): void {
      historyUnsub?.()
      historyUnsub = null
      state.status = 'idle'
      state.activeJobId = null
      state.lastError = null
      state.result = null
      state.progress = null
    },

    setResult(result: NestingResult): void {
      state.result = result
      state.status = 'completed'
      state.activeJobId = null
      historyUnsub?.()
      historyUnsub = null
    }
  }
}

function handleWorkerEvent(event: NestingHistoryEvent, bindings: RunNestingBindings): void {
  if (event.jobId !== state.activeJobId) return
  if (event.type === 'progress') {
    state.progress = event.payload
    bindings.onProgress?.(event.payload)
    return
  }
  if (event.type === 'history_frame') {
    bindings.onHistoryFrame(event.payload)
    return
  }
  if (event.type === 'history_complete') {
    bindings.onHistoryComplete(event.jobId, event.payload)
    return
  }
}

function progressLabel(status: RunnerStatus, progress: WorkerProgress | null): string {
  if (status !== 'running') return status
  if (progress === null) return 'starting worker'

  if (progress.portfolio?.phase === 'deterministic_beam') {
    return 'convex baseline beam'
  }
  if (progress.portfolio?.phase === 'ga_search') {
    const evaluations = progress.portfolio.evaluationsCompleted ?? 0
    const generation = progress.portfolio.generation ?? 0
    return `convex GA · generation ${generation + 1}, evaluation ${evaluations}`
  }
  if (progress.portfolio?.phase === 'validating') {
    return 'replaying selected convex layout'
  }
  if (progress.portfolio?.phase === 'short_side_profile') {
    return 'Compact Short Side selector'
  }

  switch (progress.phase) {
    case 'received':
      return 'worker received request'
    case 'validated':
      return 'validating request'
    case 'started':
      return 'preparing geometry'
    case 'completed':
      return 'finalizing result'
    case 'cancelled':
      return 'cancelling worker'
  }
}
