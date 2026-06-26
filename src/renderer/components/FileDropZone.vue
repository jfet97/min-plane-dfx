<script setup lang="ts">
import { useAppStore } from '../composables/useAppStore.js'

const store = useAppStore()
</script>

<template>
  <div class="dropzone">
    <button
      type="button"
      title="Import one or more DXF files. Supported entities become nesting pieces; real geometry and bounding boxes are stored separately."
      @click="store.selectAndImport"
      :disabled="store.state.value.isImporting"
    >
      {{ store.state.value.isImporting ? 'Importing...' : 'Open DXF' }}
    </button>
    <p class="hint">Supported: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE.</p>
    <p v-if="store.state.value.failures.length > 0" class="failures">
      {{ store.state.value.failures.length }} file(s) failed to import.
    </p>
  </div>
</template>

<style scoped>
.dropzone {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg-elevated);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
}

.hint {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}

.failures {
  color: var(--warning);
  font-size: 12px;
  margin: 0;
}
</style>
