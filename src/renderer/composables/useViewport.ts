import { reactive, computed, type UnwrapNestedRefs } from 'vue'

export interface ViewportState {
  /** SVG user-space translation in mm. */
  offsetX: number
  offsetY: number
  /** SVG user-space scale multiplier. */
  scale: number
  /** Whether a drag gesture is in progress. */
  isPanning: boolean
}

interface MutableViewportState {
  offsetX: number
  offsetY: number
  scale: number
  isPanning: boolean
}

const state: UnwrapNestedRefs<MutableViewportState> = reactive<MutableViewportState>({
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  isPanning: false
})

export function useViewport() {
  return {
    state: computed(() => state),
    beginPan(): void {
      state.isPanning = true
    },
    updatePan(offset: { readonly offsetX: number; readonly offsetY: number }): void {
      state.offsetX = offset.offsetX
      state.offsetY = offset.offsetY
      state.isPanning = true
    },
    endPan(): void {
      state.isPanning = false
    },
    zoom(factor: number): void {
      state.scale = Math.max(0.25, Math.min(6, state.scale * factor))
    },
    reset(): void {
      state.offsetX = 0
      state.offsetY = 0
      state.scale = 1
    }
  }
}
