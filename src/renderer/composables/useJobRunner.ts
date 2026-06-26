import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type { NestingRequest, NestingResult, NestingHistoryFrame, NestingHistorySummary } from '@shared/domain/nesting.js'
import type { NestingHistoryEvent, Unsubscribe } from '@shared/protocol/ipc.js'
import type { JobId } from '@shared/domain/ids.js'

type RunnerStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

interface MutableRunnerState {
  status: RunnerStatus
  activeJobId: JobId | null
  lastError: string | null
  result: NestingResult | null
}

const state: UnwrapNestedRefs<MutableRunnerState> = reactive<MutableRunnerState>({
  status: 'idle',
  activeJobId: null,
  lastError: null,
  result: null
})

let historyUnsub: Unsubscribe | null = null

export interface RunNestingBindings {
  readonly onHistoryFrame: (frame: NestingHistoryFrame) => void
  readonly onHistoryComplete: (jobId: JobId, summary: NestingHistorySummary) => void
  readonly onResult: (result: NestingResult) => void
  readonly onError: (message: string) => void
}

export function useJobRunner() {
  return {
    state: computed(() => state),
    status: computed(() => state.status),

    async start(
      request: NestingRequest,
      bindings: RunNestingBindings
    ): Promise<void> {
      const api = window.appApi
      if (!api) return

      state.status = 'running'
      state.activeJobId = request.jobId
      state.lastError = null
      state.result = null

      historyUnsub?.()
      historyUnsub = api.onNestingHistory((event) => {
        handleHistoryEvent(event, bindings)
      })

      try {
        const result = await api.runNesting(request)
        state.result = result
        state.status = 'completed'
        state.activeJobId = null
        historyUnsub?.()
        historyUnsub = null
        bindings.onResult(result)
      } catch (err) {
        state.status = 'failed'
        state.lastError = err instanceof Error ? err.message : String(err)
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

function handleHistoryEvent(event: NestingHistoryEvent, bindings: RunNestingBindings): void {
  // The renderer-level envelope only carries the two history variants today.
  // Worker progress events are dropped here on purpose: the UI does not need
  // lifecycle markers, only history frames and a final summary.
  if (event.type === 'history_frame') {
    bindings.onHistoryFrame(event.payload)
    return
  }
  if (event.type === 'history_complete') {
    bindings.onHistoryComplete(event.jobId, event.payload)
    return
  }
}
