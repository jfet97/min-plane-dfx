<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '@shared/irregular/defaults.js'
import { useAppStore } from '../composables/useAppStore.js'
import { useSettings } from '../composables/useSettings.js'
import { useJobRunner } from '../composables/useJobRunner.js'

const store = useAppStore()
const settings = useSettings()
const runner = useJobRunner()

const visible = computed(() => settings.state.value.options.workerMode === 'irregular-convex-v2')
const selectedPieces = computed(() => store.selectedPieces.value)
const segmentCount = computed(() =>
  selectedPieces.value.reduce((sum, piece) => sum + piece.geometry.segments.length, 0)
)
const settingsSummary = computed(() => DEFAULT_IRREGULAR_NESTING_SETTINGS)
</script>

<template>
  <section v-if="visible" class="irregular-debug">
    <header>
      <h3>Irregular Debug</h3>
      <span class="badge">{{ runner.status.value }}</span>
    </header>

    <dl>
      <div>
        <dt>source shapes</dt>
        <dd>{{ selectedPieces.length }} selected / {{ segmentCount }} segment(s)</dd>
      </div>
      <div>
        <dt>flattened polygons</dt>
        <dd>not emitted</dd>
      </div>
      <div>
        <dt>collision polygons</dt>
        <dd>not emitted</dd>
      </div>
      <div>
        <dt>free material</dt>
        <dd>not emitted</dd>
      </div>
      <div>
        <dt>candidate points</dt>
        <dd>not emitted</dd>
      </div>
      <div>
        <dt>history</dt>
        <dd>worker frames only</dd>
      </div>
    </dl>

    <div class="settings-grid">
      <span>flatten {{ settingsSummary.geometry.flatteningSagToleranceMm }} mm</span>
      <span>margin {{ settingsSummary.geometry.clearanceSafetyMarginMm }} mm</span>
      <span>window {{ settingsSummary.optimizer.orderWindow }}</span>
      <span>beam {{ settingsSummary.optimizer.beamWidth }}</span>
      <span>ga {{ settingsSummary.optimizer.gaPopulation }}</span>
      <span>{{ settingsSummary.optimizer.gaTimeBudgetMs / 1000 }} s</span>
    </div>
  </section>
</template>

<style scoped>
.irregular-debug {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

h3 {
  margin: 0;
}

.badge {
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 2px 6px;
}

dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}

dl > div {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}

dt {
  color: var(--text-muted);
  font-size: 11px;
}

dd {
  margin: 2px 0 0;
  font-size: 12px;
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.settings-grid span {
  background: var(--bg-elevated);
  border-radius: 4px;
  color: var(--text-muted);
  font-size: 11px;
  padding: 4px 6px;
}
</style>
