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

let dragOrigin: { readonly x: number; readonly y: number; readonly startX: number; readonly startY: number } | null = null

export function useViewport() {
  return {
    state: computed(() => state),
    beginPan(clientX: number, clientY: number): void {
      state.isPanning = true
      dragOrigin = { x: clientX, y: clientY, startX: state.offsetX, startY: state.offsetY }
    },
    updatePan(clientX: number, clientY: number): void {
      if (!dragOrigin || !state.isPanning) return
      state.offsetX = dragOrigin.startX + (clientX - dragOrigin.x) / state.scale
      state.offsetY = dragOrigin.startY + (clientY - dragOrigin.y) / state.scale
    },
    endPan(): void {
      state.isPanning = false
      dragOrigin = null
    },
    zoom(factor: number, around?: { readonly x: number; readonly y: number }): void {
      const next = Math.max(0.1, Math.min(20, state.scale * factor))
      if (around) {
        // Keep the world point under the cursor stable while scaling.
        const wx = (around.x - state.offsetX) / state.scale
        const wy = (around.y - state.offsetY) / state.scale
        state.scale = next
        state.offsetX = around.x / next - wx
        state.offsetY = around.y / next - wy
      } else {
        state.scale = next
      }
    },
    reset(): void {
      state.offsetX = 0
      state.offsetY = 0
      state.scale = 1
    }
  }
}