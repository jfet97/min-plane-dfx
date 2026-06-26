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
    label: piece.label,
    sourceLayer: piece.sourceLayer ?? '-',
    width: piece.realBounds.width.toFixed(2),
    height: piece.realBounds.height.toFixed(2),
    paddedWidth: (piece.realBounds.width + padding * 2).toFixed(2),
    paddedHeight: (piece.realBounds.height + padding * 2).toFixed(2),
    entityType: piece.geometry.entityType
  }))
})
</script>

<template>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th title="Piece label/name.">Label</th>
          <th title="Source DXF layer.">Layer</th>
          <th title="Source DXF entity type.">Entity</th>
          <th title="Real geometry bounding width before padding.">Width</th>
          <th title="Real geometry bounding height before padding.">Height</th>
          <th title="Effective nesting footprint width after padding on both sides.">Pad W</th>
          <th title="Effective nesting footprint height after padding on both sides.">Pad H</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td colspan="7" class="empty">No pieces yet. Import a DXF file.</td>
        </tr>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.label }}</td>
          <td>{{ row.sourceLayer }}</td>
          <td>{{ row.entityType }}</td>
          <td>{{ row.width }}</td>
          <td>{{ row.height }}</td>
          <td>{{ row.paddedWidth }}</td>
          <td>{{ row.paddedHeight }}</td>
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

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 12px;
}
</style>
