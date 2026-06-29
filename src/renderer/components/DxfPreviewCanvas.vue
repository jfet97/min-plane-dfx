<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAppStore } from '../composables/useAppStore.js'
import { useHistoryStore } from '../composables/useHistoryStore.js'
import { useViewport } from '../composables/useViewport.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { Placement } from '@shared/domain/nesting.js'

type Segment = NonNullable<ImportedPiece['geometry']['segments'][number]>
type VisualMode = 'shape' | 'footprint'
type CanvasMode = 'import' | 'result'

const props = defineProps<{
  readonly mode: CanvasMode
}>()

const store = useAppStore()
const history = useHistoryStore()
const viewport = useViewport()

const containerRef = ref<HTMLDivElement | null>(null)
const containerSize = ref({ width: 0, height: 0 })

onMounted(() => {
  const el = containerRef.value
  if (!el) return
  const observer = new ResizeObserver(() => {
    const rect = el.getBoundingClientRect()
    containerSize.value = { width: rect.width, height: rect.height }
  })
  observer.observe(el)
  onUnmounted(() => observer.disconnect())
})

interface ViewBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const padding = 10
const sourceGap = 40

interface SourcePreviewItem {
  readonly piece: ImportedPiece
  readonly offsetX: number
  readonly offsetY: number
  readonly bounds: ViewBox
}

const sourcePreviewItems = computed<ReadonlyArray<SourcePreviewItem>>(() => {
  let cursorX = 0
  return store.state.value.pieces.map((piece) => {
    const bounds = {
      x: cursorX,
      y: 0,
      width: piece.realBounds.width,
      height: piece.realBounds.height
    }
    const item = {
      piece,
      offsetX: cursorX - piece.realBounds.x,
      offsetY: -piece.realBounds.y,
      bounds
    }
    cursorX += piece.realBounds.width + sourceGap
    return item
  })
})

/**
 * Bounds union of either the imported pieces (when no result is available)
 * or the placements of the selected history frame or final result.
 */
const sourceBounds = computed<ViewBox | null>(() => {
  const items = sourcePreviewItems.value
  if (items.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const item of items) {
    const b = item.bounds
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2
  }
})

const placementBounds = computed<ViewBox | null>(() => {
  if (props.mode !== 'result') return null
  const frame = history.selectedFrame.value
  const placements: ReadonlyArray<Placement> =
    frame?.plate.placements ?? history.selectedRun.value?.placements ?? []
  if (placements.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of placements) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.width)
    maxY = Math.max(maxY, p.y + p.height)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2
  }
})

const viewBox = computed<ViewBox>(() => {
  const bounds = props.mode === 'result' ? placementBounds.value : sourceBounds.value
  if (bounds) return bounds
  return { x: 0, y: 0, width: 100, height: 100 }
})

const sheetOutline = computed(() => history.selectedRun.value?.placements ?? null)

const selectedId = ref<string | null>(null)
const visualMode = ref<VisualMode>('shape')
const showFreeRectangles = ref(true)

function linePath(s: Segment): string {
  if (s.kind === 'line') {
    return `M ${s.x1} ${s.y1} L ${s.x2} ${s.y2}`
  }
  return ''
}

function arcPath(s: Segment): string {
  if (s.kind !== 'arc') return ''
  const cx = s.cx ?? 0
  const cy = s.cy ?? 0
  const r = s.radius ?? 0
  if (r <= 0) return ''
  const start = ((s.startAngle ?? 0) * Math.PI) / 180
  const end = ((s.endAngle ?? 0) * Math.PI) / 180
  const x1 = cx + r * Math.cos(start)
  const y1 = cy + r * Math.sin(start)
  const x2 = cx + r * Math.cos(end)
  const y2 = cy + r * Math.sin(end)
  const rawDelta = (s.endAngle ?? 0) - (s.startAngle ?? 0)
  const normalizedDelta = ((rawDelta % 360) + 360) % 360
  const largeArc = normalizedDelta > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`
}

function segmentPath(s: Segment): string {
  return s.kind === 'line' ? linePath(s) : arcPath(s)
}

function circlePath(piece: ImportedPiece): string {
  const radius = Math.min(piece.realBounds.width, piece.realBounds.height) / 2
  const cx = piece.realBounds.x + piece.realBounds.width / 2
  const cy = piece.realBounds.y + piece.realBounds.height / 2
  return `M ${cx - radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx + radius} ${cy} A ${radius} ${radius} 0 1 1 ${cx - radius} ${cy}`
}

/**
 * SVG viewBox string, padded for the current scale. Combines the
 * user-controlled viewport (offset/scale) on top of the world bounds so
 * pan/zoom does not lose the source area.
 */
const viewBoxString = computed(() => {
  const vb = viewBox.value
  const cx = vb.x + vb.width / 2 + viewport.state.value.offsetX
  const cy = vb.y + vb.height / 2 + viewport.state.value.offsetY
  const w = vb.width / viewport.state.value.scale
  const h = vb.height / viewport.state.value.scale
  return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`
})

const placementsToRender = computed<ReadonlyArray<Placement>>(() => {
  if (props.mode !== 'result') return []
  const frame = history.selectedFrame.value
  return frame?.plate.placements ?? history.selectedRun.value?.placements ?? []
})

const freeRectanglesToRender = computed(() => {
  if (props.mode !== 'result' || !showFreeRectangles.value) return []
  return history.selectedFrame.value?.plate.freeRectangles ?? []
})

const showSourceGeometry = computed(() => props.mode === 'import')
const showSourceRectangles = computed(
  () => props.mode === 'import' && visualMode.value === 'footprint'
)
const showResultRectangles = computed(() => placementsToRender.value.length > 0)

function setVisualMode(mode: VisualMode): void {
  if (props.mode !== 'import') return
  visualMode.value = mode
}

function isSelected(piece: ImportedPiece): boolean {
  return selectedId.value === piece.id || store.isPieceSelected(piece.id)
}

function selectPiece(piece: ImportedPiece): void {
  selectedId.value = piece.id
  store.setPieceSelected(piece.id, !store.isPieceSelected(piece.id))
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.1 : 0.9
  viewport.zoom(factor)
}
</script>

<template>
  <div class="canvas" ref="containerRef" @wheel="onWheel">
    <svg
      v-if="
        (props.mode === 'import' && store.state.value.pieces.length > 0) ||
        placementsToRender.length > 0
      "
      :viewBox="viewBoxString"
      preserveAspectRatio="xMidYMid meet"
    >
      <!-- Sheet outline (only visible when a result is loaded) -->
      <g v-if="history.selectedRun.value">
        <rect
          v-if="sheetOutline && sheetOutline.length > 0"
          :x="store.state.value.pieces[0]?.realBounds.x ?? 0"
          :y="store.state.value.pieces[0]?.realBounds.y ?? 0"
          width="0"
          height="0"
          fill="none"
        />
      </g>

      <!-- Imported source geometry (rendered only when no placements are present,
           so the preview view is the source and the result view is the placements). -->
      <g v-if="props.mode === 'import'">
        <g
          v-for="item in sourcePreviewItems"
          :key="item.piece.id"
          :transform="`translate(${item.offsetX}, ${item.offsetY})`"
        >
          <template v-if="showSourceGeometry">
            <path
              v-if="item.piece.geometry.entityType === 'CIRCLE'"
              :d="circlePath(item.piece)"
              :stroke="isSelected(item.piece) ? 'var(--accent)' : 'var(--text-primary)'"
              :stroke-opacity="store.isPieceSelected(item.piece.id) ? 1 : 0.65"
              stroke-width="2"
              fill="none"
              @click.stop="selectPiece(item.piece)"
            />
            <path
              v-else
              v-for="(seg, i) in item.piece.geometry.segments"
              :key="`seg-${item.piece.id}-${i}`"
              :d="segmentPath(seg)"
              :stroke="isSelected(item.piece) ? 'var(--accent)' : 'var(--text-primary)'"
              :stroke-opacity="store.isPieceSelected(item.piece.id) ? 1 : 0.45"
              stroke-width="1.8"
              fill="none"
              @click.stop="selectPiece(item.piece)"
            />
          </template>
          <rect
            v-if="showSourceRectangles"
            :x="item.piece.realBounds.x"
            :y="item.piece.realBounds.y"
            :width="item.piece.realBounds.width"
            :height="item.piece.realBounds.height"
            fill="none"
            :stroke="isSelected(item.piece) ? 'var(--accent)' : 'var(--warning)'"
            :stroke-opacity="store.isPieceSelected(item.piece.id) ? 1 : 0.55"
            stroke-width="1"
            stroke-dasharray="4 3"
            @click.stop="selectPiece(item.piece)"
            class="bbox"
          />
        </g>
      </g>

      <!-- Result rectangles are driven by the selected run or selected frame. -->
      <g v-if="showResultRectangles">
        <rect
          v-for="(p, i) in placementsToRender"
          :key="`place-${i}-${p.pieceId}`"
          :x="p.x"
          :y="p.y"
          :width="p.width"
          :height="p.height"
          fill="rgba(0, 122, 204, 0.1)"
          stroke="var(--accent)"
          stroke-width="0.4"
        />
      </g>

      <!-- Free-rectangle overlays from the selected frame. -->
      <g v-if="freeRectanglesToRender.length > 0">
        <rect
          v-for="fr in freeRectanglesToRender"
          :key="`fr-${fr.id}`"
          :x="fr.x"
          :y="fr.y"
          :width="fr.width"
          :height="fr.height"
          fill="none"
          stroke="var(--ok)"
          stroke-width="0.3"
          stroke-dasharray="1 1"
        />
      </g>
    </svg>

    <div v-else-if="props.mode === 'import'" class="empty">
      <p>Import a DXF file to preview shapes and bounding boxes.</p>
    </div>

    <div v-else class="empty">
      <p>
        No result yet. Run sends selected imported objects to the worker and renders the returned
        placements.
      </p>
    </div>

    <div
      v-if="props.mode === 'result' && placementsToRender.length === 0 && history.selectedRun.value"
      class="empty-state"
    >
      <p>
        No placements in the selected result. Check unplaced pieces and the selected beam frame.
      </p>
    </div>

    <div class="viewport-controls">
      <button type="button" title="Zoom in" @click="viewport.zoom(1.2)">+</button>
      <button type="button" title="Zoom out" @click="viewport.zoom(0.8)">−</button>
      <button
        type="button"
        title="Reset pan and zoom to fit the current preview/result."
        @click="viewport.reset"
      >
        Reset
      </button>
      <span class="scale">{{ viewport.state.value.scale.toFixed(2) }}x</span>
      <span v-if="containerSize.width > 0" class="dim">
        {{ Math.round(containerSize.width) }} × {{ Math.round(containerSize.height) }}
      </span>
    </div>

    <div v-if="props.mode === 'import'" class="view-controls">
      <button
        type="button"
        :class="{ active: visualMode === 'shape' }"
        title="Show imported DXF geometry as source shapes."
        @click="setVisualMode('shape')"
      >
        Shapes
      </button>
      <button
        type="button"
        :class="{ active: visualMode === 'footprint' }"
        title="Overlay bounding footprints for the imported objects."
        @click="setVisualMode('footprint')"
      >
        Footprints
      </button>
      <label
        v-if="history.selectedFrame.value?.plate.freeRectangles.length"
        title="Shows the current MaxRects free-rectangle candidates emitted by the algorithm history frame."
      >
        <input v-model="showFreeRectangles" type="checkbox" />
        Free rectangles
      </label>
    </div>

    <div v-if="props.mode === 'import' && store.state.value.pieces.length > 0" class="legend">
      <span><i class="box"></i> Imported object footprint</span>
      <span><i class="line"></i> Real DXF geometry</span>
    </div>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: 100%;
  background: var(--bg-app);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: stretch;
  overflow: hidden;
  position: relative;
}

svg {
  width: 100%;
  height: 100%;
}

.bbox {
  cursor: pointer;
}

.bbox:hover {
  stroke: var(--accent);
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 12px;
}

.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30, 30, 30, 0.75);
  color: var(--warning);
  font-size: 13px;
  text-align: center;
  padding: 16px;
  pointer-events: none;
}

.viewport-controls {
  position: absolute;
  bottom: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 11px;
}

.view-controls {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 11px;
}

.view-controls button {
  font-size: 11px;
  padding: 2px 6px;
}

.view-controls button.active {
  border-color: var(--accent);
}

.view-controls label {
  display: flex;
  align-items: center;
  gap: 4px;
}

.legend {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 10px;
  padding: 4px 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 11px;
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.legend i {
  display: inline-block;
  width: 14px;
  height: 8px;
}

.legend .line {
  border-top: 1px solid var(--text-secondary);
}

.legend .box {
  border: 1px dashed var(--warning);
}

.viewport-controls button {
  font-size: 11px;
  padding: 2px 6px;
}

.scale,
.dim {
  margin-left: 4px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
</style>
