<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAppStore } from '../composables/useAppStore.js'
import { useHistoryStore } from '../composables/useHistoryStore.js'
import { useSettings } from '../composables/useSettings.js'
import { useViewport } from '../composables/useViewport.js'
import {
  buildIrregularCanvasModel,
  rectangularPlacementSvgTransform,
  type IrregularCanvasModel
} from '../utils/resultCanvas.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import {
  isIrregularHistoryFrame,
  type NestingSubRun,
  type Placement,
  type PreparedPiece,
  type SheetSpec
} from '@shared/domain/nesting.js'

type Segment = NonNullable<ImportedPiece['geometry']['segments'][number]>
type VisualMode = 'shape' | 'footprint'
type CanvasMode = 'import' | 'result'

const props = defineProps<{
  readonly mode: CanvasMode
  readonly isRunning?: boolean
}>()

const store = useAppStore()
const history = useHistoryStore()
const settings = useSettings()
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

interface ResultPlacementItem {
  readonly placement: Placement
  readonly piece: ImportedPiece | null
  readonly geometryTransform: string | null
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
    const b =
      visualMode.value === 'footprint' && showSourcePadding.value
        ? sourcePaddingRect(item.piece)
        : item.bounds
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
  if (!history.selectedRun.value) return null
  const sheet = resultSheet.value
  return {
    x: -padding,
    y: -padding,
    width: sheet.width + padding * 2,
    height: sheet.height + padding * 2
  }
})

const viewBox = computed<ViewBox>(() => {
  const bounds = props.mode === 'result' ? placementBounds.value : sourceBounds.value
  if (bounds) return bounds
  return { x: 0, y: 0, width: 100, height: 100 }
})

const selectedSubRun = computed<NestingSubRun | null>(() => {
  const id = history.state.value.selectedStrategyRunId
  if (!id) return null
  return history.result.value?.runSummary?.subRuns.find((subRun) => subRun.subRunId === id) ?? null
})

const resultSheet = computed<SheetSpec>(
  () =>
    selectedSubRun.value?.sheet ??
    history.selectedRunRecord.value?.sheet ??
    settings.state.value.sheet
)

const sheetOutline = computed(() => {
  if (props.mode !== 'result' || !history.selectedRun.value) return null
  return resultSheet.value
})

const selectedId = ref<string | null>(null)
const visualMode = ref<VisualMode>('shape')
const showSourcePadding = ref(true)
const showFreeRectangles = ref(true)
const panStart = ref<{
  readonly clientX: number
  readonly clientY: number
  readonly offsetX: number
  readonly offsetY: number
} | null>(null)

function linePath(s: Segment): string {
  if (s.kind === 'line') {
    return `M ${s.x1} ${s.y1} L ${s.x2} ${s.y2}`
  }
  return ''
}

function arcPath(s: Segment): string {
  if (s.kind !== 'arc') return ''
  const cx = s.cx
  const cy = s.cy
  const r = s.radius
  if (r <= 0) return ''
  const start = (s.startAngle * Math.PI) / 180
  const end = (s.endAngle * Math.PI) / 180
  const x1 = cx + r * Math.cos(start)
  const y1 = cy + r * Math.sin(start)
  const x2 = cx + r * Math.cos(end)
  const y2 = cy + r * Math.sin(end)
  const rawDelta = s.endAngle - s.startAngle
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
  if (frame && !isIrregularHistoryFrame(frame) && frame.plate.placements.length > 0) {
    return frame.plate.placements
  }
  return selectedSubRun.value?.placements ?? history.selectedRun.value?.placements ?? []
})

const irregularLayout = computed(() => {
  const frame = history.selectedFrame.value
  if (frame && isIrregularHistoryFrame(frame)) return frame
  const subRunLayout = selectedSubRun.value?.layout
  if (subRunLayout?.kind === 'irregular') return subRunLayout
  const layout = history.selectedRun.value?.layout ?? history.result.value?.layout
  return layout?.kind === 'irregular' ? layout : null
})

const irregularCanvasModel = computed<IrregularCanvasModel | null>(() => {
  const source = irregularLayout.value
  if (source === null) return null
  return buildIrregularCanvasModel({
    source,
    sourcePieces: store.state.value.pieces,
    sheet: resultSheet.value
  })
})

const hasIrregularResultPlacements = computed(
  () => irregularCanvasModel.value?.placements.some((item) => item.status === 'rendered') ?? false
)

const hasResultPlacements = computed(
  () => placementsToRender.value.length > 0 || hasIrregularResultPlacements.value
)

const sourcePiecesById = computed(() => {
  const byId = new Map<string, ImportedPiece>()
  for (const piece of store.state.value.pieces) {
    byId.set(piece.id, piece)
  }
  return byId
})

const preparedPiecesById = computed(() => {
  const byId = new Map<string, PreparedPiece>()
  for (const prepared of history.result.value?.preparedPieces ?? []) {
    byId.set(prepared.id, prepared)
  }
  return byId
})

const resultPlacementItems = computed<ReadonlyArray<ResultPlacementItem>>(() =>
  placementsToRender.value.map((placement) => {
    const piece = sourcePieceForPlacement(placement)
    return {
      placement,
      piece,
      geometryTransform: piece
        ? rectangularPlacementSvgTransform(placement, piece.realBounds, resultSheet.value.height)
        : null
    }
  })
)

const freeRectanglesToRender = computed(() => {
  if (props.mode !== 'result' || !showFreeRectangles.value) return []
  const frame = history.selectedFrame.value
  return frame && !isIrregularHistoryFrame(frame) ? frame.plate.freeRectangles : []
})

const showSourceGeometry = computed(() => props.mode === 'import')
const showSourceRectangles = computed(
  () => props.mode === 'import' && visualMode.value === 'footprint'
)
const showResultRectangles = computed(() => placementsToRender.value.length > 0)
const sourceSidePadding = computed(() =>
  Math.ceil(Math.max(0, Math.round(settings.state.value.padding)) / 2)
)

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

function originalPieceId(id: string): string {
  return id.replace(/-copy-\d+$/, '')
}

function sourcePieceForPlacement(placement: Placement): ImportedPiece | null {
  const id = placement.pieceId
  const prepared = preparedPiecesById.value.get(id)
  if (prepared !== undefined) {
    return (
      sourcePiecesById.value.get(prepared.sourcePieceId) ??
      sourcePiecesById.value.get(originalPieceId(prepared.sourcePieceId)) ??
      sourcePiecesById.value.get(originalPieceId(id)) ??
      null
    )
  }
  return sourcePiecesById.value.get(id) ?? sourcePiecesById.value.get(originalPieceId(id)) ?? null
}

function resultY(rect: { readonly y: number; readonly height: number }): number {
  return resultSheet.value.height - rect.y - rect.height
}

function panScale(): { readonly x: number; readonly y: number } {
  const size = containerSize.value
  const vb = viewBox.value
  return {
    x: size.width > 0 ? vb.width / viewport.state.value.scale / size.width : 0,
    y: size.height > 0 ? vb.height / viewport.state.value.scale / size.height : 0
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  panStart.value = {
    clientX: event.clientX,
    clientY: event.clientY,
    offsetX: viewport.state.value.offsetX,
    offsetY: viewport.state.value.offsetY
  }
  viewport.beginPan()
  if (event.currentTarget instanceof Element) {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
}

function onPointerMove(event: PointerEvent): void {
  const start = panStart.value
  if (!start) return
  const scale = panScale()
  viewport.updatePan({
    offsetX: start.offsetX - (event.clientX - start.clientX) * scale.x,
    offsetY: start.offsetY - (event.clientY - start.clientY) * scale.y
  })
}

function onPointerUp(event: PointerEvent): void {
  panStart.value = null
  viewport.endPan()
  if (event.currentTarget instanceof Element) {
    event.currentTarget.releasePointerCapture(event.pointerId)
  }
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.1 : 0.9
  viewport.zoom(factor)
}

function stopCanvasGesture(): void {
  // controls sit inside the canvas; consuming pointer events keeps them from starting a pan
}

function sourcePaddingRect(piece: ImportedPiece): ViewBox {
  const side = sourceSidePadding.value
  return {
    x: piece.realBounds.x - side,
    y: piece.realBounds.y - side,
    width: piece.realBounds.width + side * 2,
    height: piece.realBounds.height + side * 2
  }
}
</script>

<template>
  <div
    class="canvas"
    :class="{ panning: viewport.state.value.isPanning }"
    ref="containerRef"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <svg
      v-if="
        (props.mode === 'import' && store.state.value.pieces.length > 0) ||
        placementsToRender.length > 0 ||
        irregularCanvasModel !== null
      "
      :viewBox="viewBoxString"
      preserveAspectRatio="xMidYMid meet"
    >
      <!-- Sheet outline (only visible when a result is loaded) -->
      <g v-if="sheetOutline">
        <rect
          x="0"
          y="0"
          :width="sheetOutline.width"
          :height="sheetOutline.height"
          fill="rgba(0, 122, 204, 0.04)"
          stroke="var(--accent)"
          stroke-width="1"
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
          <rect
            v-if="showSourceRectangles && showSourcePadding && sourceSidePadding > 0"
            :x="sourcePaddingRect(item.piece).x"
            :y="sourcePaddingRect(item.piece).y"
            :width="sourcePaddingRect(item.piece).width"
            :height="sourcePaddingRect(item.piece).height"
            fill="rgba(0, 122, 204, 0.08)"
            stroke="var(--accent)"
            stroke-opacity="0.85"
            stroke-width="1"
            stroke-dasharray="6 3"
            @click.stop="selectPiece(item.piece)"
            class="bbox"
          />
        </g>
      </g>

      <!-- Result rectangles are driven by the selected run or selected frame. -->
      <g v-if="showResultRectangles">
        <rect
          v-for="(item, i) in resultPlacementItems"
          :key="`place-footprint-${i}-${item.placement.pieceId}`"
          :x="item.placement.x"
          :y="resultY(item.placement)"
          :width="item.placement.width"
          :height="item.placement.height"
          fill="rgba(0, 122, 204, 0.1)"
          stroke="var(--accent)"
          stroke-width="0.4"
        />
        <g
          v-for="(item, i) in resultPlacementItems"
          :key="`place-shape-${i}-${item.placement.pieceId}`"
        >
          <g v-if="item.piece && item.geometryTransform" :transform="item.geometryTransform">
            <path
              v-if="item.piece.geometry.entityType === 'CIRCLE'"
              :d="circlePath(item.piece)"
              stroke="var(--text-primary)"
              stroke-opacity="0.9"
              stroke-width="1.4"
              fill="none"
            />
            <path
              v-else
              v-for="(seg, segIndex) in item.piece.geometry.segments"
              :key="`result-seg-${item.placement.pieceId}-${segIndex}`"
              :d="segmentPath(seg)"
              stroke="var(--text-primary)"
              stroke-opacity="0.85"
              stroke-width="1.2"
              fill="none"
            />
          </g>
          <rect
            v-else
            :x="item.placement.x"
            :y="resultY(item.placement)"
            :width="item.placement.width"
            :height="item.placement.height"
            fill="none"
            stroke="var(--warning)"
            stroke-width="0.8"
            stroke-dasharray="4 3"
          />
        </g>
      </g>

      <!-- irregular results replay original source geometry with worker transforms. -->
      <g v-if="irregularCanvasModel">
        <g
          v-for="(item, i) in irregularCanvasModel.placements"
          :key="`irregular-place-${i}-${item.placement.pieceId ?? item.placement.sourcePieceId}`"
        >
          <g v-if="item.sourcePiece && item.svgTransform" :transform="item.svgTransform">
            <path
              v-if="item.sourcePiece.geometry.entityType === 'CIRCLE'"
              :d="circlePath(item.sourcePiece)"
              stroke="var(--text-primary)"
              stroke-opacity="0.9"
              stroke-width="1.4"
              fill="none"
            />
            <path
              v-else
              v-for="(seg, segIndex) in item.sourcePiece.geometry.segments"
              :key="`irregular-seg-${item.placement.sourcePieceId}-${segIndex}`"
              :d="segmentPath(seg)"
              stroke="var(--text-primary)"
              stroke-opacity="0.85"
              stroke-width="1.2"
              fill="none"
            />
          </g>
        </g>
      </g>

      <text
        v-if="irregularCanvasModel && irregularCanvasModel.unrenderablePlacementCount > 0"
        x="8"
        y="18"
        fill="var(--warning)"
        font-size="11"
      >
        {{ irregularCanvasModel.unrenderablePlacementCount }} irregular placement(s) have no
        renderable source transform.
      </text>

      <!-- Free-rectangle overlays from the selected frame. -->
      <g v-if="freeRectanglesToRender.length > 0">
        <rect
          v-for="fr in freeRectanglesToRender"
          :key="`fr-${fr.id}`"
          :x="fr.x"
          :y="resultY(fr)"
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

    <div v-else-if="props.isRunning" class="empty">
      <p>Running nesting algorithm...</p>
    </div>

    <div v-else class="empty">
      <p>
        No result yet. Run sends selected imported objects to the worker and renders the returned
        placements.
      </p>
    </div>

    <div
      v-if="props.mode === 'result' && !hasResultPlacements && history.selectedRun.value"
      class="empty-state"
    >
      <p>
        No placements in the selected result. Check unplaced pieces and the selected beam frame.
      </p>
    </div>

    <div
      class="viewport-controls"
      @pointerdown.stop="stopCanvasGesture"
      @pointermove.stop="stopCanvasGesture"
      @pointerup.stop="stopCanvasGesture"
      @pointercancel.stop="stopCanvasGesture"
      @wheel.stop="stopCanvasGesture"
    >
      <button type="button" title="Zoom in" @click.stop="viewport.zoom(1.2)">+</button>
      <button type="button" title="Zoom out" @click.stop="viewport.zoom(0.8)">−</button>
      <button
        type="button"
        title="Reset pan and zoom to fit the current preview/result."
        @click.stop="viewport.reset()"
      >
        Reset
      </button>
      <span class="scale">{{ viewport.state.value.scale.toFixed(2) }}x</span>
      <span v-if="containerSize.width > 0" class="dim">
        {{ Math.round(containerSize.width) }} × {{ Math.round(containerSize.height) }}
      </span>
    </div>

    <div
      v-if="props.mode === 'import'"
      class="view-controls"
      @pointerdown.stop="stopCanvasGesture"
      @pointermove.stop="stopCanvasGesture"
      @pointerup.stop="stopCanvasGesture"
      @pointercancel.stop="stopCanvasGesture"
      @wheel.stop="stopCanvasGesture"
    >
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
        v-if="visualMode === 'footprint' && sourceSidePadding > 0"
        title="Overlay the effective padded footprint sent to the nesting worker."
      >
        <input v-model="showSourcePadding" type="checkbox" />
        Padding
      </label>
    </div>

    <div
      v-if="props.mode === 'result' && freeRectanglesToRender.length"
      class="view-controls"
      @pointerdown.stop="stopCanvasGesture"
      @pointermove.stop="stopCanvasGesture"
      @pointerup.stop="stopCanvasGesture"
      @pointercancel.stop="stopCanvasGesture"
      @wheel.stop="stopCanvasGesture"
    >
      <label
        title="Shows the current MaxRects free-rectangle candidates emitted by the selected history frame."
      >
        <input v-model="showFreeRectangles" type="checkbox" />
        Free rects
      </label>
    </div>

    <div v-if="props.mode === 'import' && store.state.value.pieces.length > 0" class="legend">
      <span><i class="box"></i> Imported object footprint</span>
      <span v-if="visualMode === 'footprint' && showSourcePadding && sourceSidePadding > 0">
        <i class="padding-box"></i> Padded footprint
      </span>
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
  cursor: grab;
  touch-action: none;
}

.canvas.panning {
  cursor: grabbing;
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

.legend .padding-box {
  border: 1px dashed var(--accent);
  background: rgba(0, 122, 204, 0.12);
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
