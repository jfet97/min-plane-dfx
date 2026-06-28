<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../composables/useAppStore.js'
import { useSettings } from '../composables/useSettings.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'

const store = useAppStore()
const settings = useSettings()

const rows = computed(() => {
  const padding = settings.state.value.padding
  return store.state.value.pieces.map((piece: ImportedPiece) => ({
    id: piece.id,
    selected: store.isPieceSelected(piece.id),
    label: piece.label,
    width: piece.realBounds.width.toFixed(2),
    height: piece.realBounds.height.toFixed(2),
    paddedWidth: (piece.realBounds.width + padding * 2).toFixed(2),
    paddedHeight: (piece.realBounds.height + padding * 2).toFixed(2),
    entityType: piece.geometry.entityType,
    segmentCount: piece.geometry.segments.length
  }))
})

const allSelected = computed(
  () => store.pieceCount.value > 0 && store.selectedPieceCount.value === store.pieceCount.value
)
</script>

<template>
  <div class="table-wrap">
    <div class="piece-actions" title="Choose which imported shapes are sent to the worker.">
      <span>{{ store.selectedPieceCount.value }} selected</span>
      <button type="button" :disabled="allSelected" @click="store.setAllPiecesSelected(true)">
        All
      </button>
      <button
        type="button"
        :disabled="store.selectedPieceCount.value === 0"
        @click="store.setAllPiecesSelected(false)"
      >
        None
      </button>
      <button
        type="button"
        :disabled="store.pieceCount.value === 0"
        title="Remove all imported DXF shapes from this in-memory session."
        @click="void store.clear()"
      >
        Clear all
      </button>
    </div>
    <table>
      <thead>
        <tr>
          <th title="Whether this imported shape is included in the next worker request.">Use</th>
          <th title="Imported DXF object name.">Object</th>
          <th title="Real geometry bounding size before padding.">Bounds</th>
          <th title="Effective nesting footprint size after padding on both sides.">Footprint</th>
          <th title="Raw DXF entity summary kept for inspection, not as separate nesting objects.">
            Detail
          </th>
          <th title="Remove this imported shape from the in-memory session.">Remove</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td colspan="6" class="empty">No imported objects yet. Import a DXF file.</td>
        </tr>
        <tr v-for="row in rows" :key="row.id">
          <td>
            <input
              type="checkbox"
              :checked="row.selected"
              title="Include this shape in the next worker request."
              @change="store.setPieceSelected(row.id, !row.selected)"
            />
          </td>
          <td>{{ row.label }}</td>
          <td>{{ row.width }} × {{ row.height }}</td>
          <td>{{ row.paddedWidth }} × {{ row.paddedHeight }}</td>
          <td>{{ row.entityType }} · {{ row.segmentCount }} segment(s)</td>
          <td>
            <button
              type="button"
              class="remove"
              title="Remove this imported shape."
              @click="void store.removePiece(row.id)"
            >
              Remove
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.table-wrap {
  overflow: auto;
  max-height: 100%;
}

.piece-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.piece-actions button {
  font-size: 11px;
  padding: 2px 6px;
}

.piece-actions button:last-child {
  margin-left: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

th,
td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

th {
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  position: sticky;
  top: 0;
}

td {
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.remove {
  font-size: 11px;
  padding: 2px 6px;
}

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 12px;
}
</style>
