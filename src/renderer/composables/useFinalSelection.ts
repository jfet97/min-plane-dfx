import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type { NestingResult, FinalResultScore } from '@shared/domain/nesting.js'
import type { ProjectDocument } from '@shared/domain/project.js'

/**
 * Final-selection placeholder store. The user-written scoring layer is
 * intentionally not implemented. The store surfaces:
 *   - the current selection mode (manual / best / top_n)
 *   - the list of candidate runs (placeholder: all runs)
 *   - the user-picked manual selection (when mode === 'manual')
 *
 * The store does NOT compute ranks or scores. UI surfaces these as disabled
 * controls so the workflow is visible without inventing logic.
 */
interface MutableFinalSelectionState {
  mode: 'manual' | 'best' | 'top_n'
  manualSelection: string | null
  topN: number
  /** Score placeholders emitted by the user-written algorithm. */
  scores: Record<string, FinalResultScore>
}

const state: UnwrapNestedRefs<MutableFinalSelectionState> = reactive<MutableFinalSelectionState>({
  mode: 'manual',
  manualSelection: null,
  topN: 3,
  scores: {}
})

export function useFinalSelection() {
  return {
    state: computed(() => state),
    setMode(mode: 'manual' | 'best' | 'top_n'): void {
      state.mode = mode
    },
    setTopN(n: number): void {
      state.topN = Math.max(1, n)
    },
    pickManually(runId: string): void {
      state.manualSelection = runId
    },
    syncFromResult(result: NestingResult | null): void {
      // Carry the worker-selected run as the default manual pick when the
      // store is fresh. Real ranking is not implemented yet.
      if (result?.selectedStrategyRunId && state.manualSelection === null) {
        state.manualSelection = result.selectedStrategyRunId
      }
      // Clear stale scores if the underlying result changed underneath.
      state.scores = {}
    },
    hydrateFromProject(project: ProjectDocument): void {
      state.mode = project.options.finalSelectionMode
      state.topN = project.options.topN ?? 3
      state.manualSelection = project.lastResult?.selectedStrategyRunId ?? null
      state.scores = {}
    },
    candidates(result: NestingResult | null): ReadonlyArray<string> {
      return result?.strategyResults.map((s) => s.strategyRunId) ?? []
    }
  }
}
