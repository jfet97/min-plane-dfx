<script setup lang="ts">
import { computed } from 'vue'
import { DEFAULT_IRREGULAR_NESTING_SETTINGS } from '@shared/irregular/defaults.js'
import { isIrregularHistoryFrame } from '@shared/domain/nesting.js'
import type { IrregularHistoryFrame, IrregularLayout } from '@shared/irregular/domain.js'
import { useAppStore } from '../composables/useAppStore.js'
import { useHistoryStore } from '../composables/useHistoryStore.js'
import { useSettings } from '../composables/useSettings.js'
import { useJobRunner } from '../composables/useJobRunner.js'

const store = useAppStore()
const history = useHistoryStore()
const settings = useSettings()
const runner = useJobRunner()

const finalLayout = computed<IrregularLayout | null>(() => {
  const layout = history.selectedRun.value?.layout ?? history.result.value?.layout
  return layout?.kind === 'irregular' ? layout : null
})
const selectedFrame = computed<IrregularHistoryFrame | null>(() => {
  const frame = history.selectedFrame.value
  return frame && isIrregularHistoryFrame(frame) ? frame : null
})
const selectedSubRun = computed(() => {
  const strategyRunId = history.state.value.selectedStrategyRunId
  if (strategyRunId === null) return null
  return (
    history.result.value?.runSummary?.subRuns.find(
      (subRun) => subRun.subRunId === strategyRunId
    ) ?? null
  )
})
const visible = computed(
  () =>
    settings.state.value.options.workerMode === 'irregular-convex-v2' ||
    finalLayout.value !== null ||
    selectedFrame.value !== null
)
const selectedPieces = computed(() => store.selectedPieces.value)
const segmentCount = computed(() =>
  selectedPieces.value.reduce((sum, piece) => sum + piece.geometry.segments.length, 0)
)
const settingsSummary = computed(
  () =>
    selectedSubRun.value?.options.irregularSettings ??
    settings.state.value.options.irregularSettings ??
    DEFAULT_IRREGULAR_NESTING_SETTINGS
)
const placementCount = computed(
  () => selectedFrame.value?.placements.length ?? finalLayout.value?.placements.length ?? 0
)
const unplacedPieceIds = computed(
  () => selectedFrame.value?.unplacedPieceIds ?? finalLayout.value?.unplacedPieceIds ?? []
)
const score = computed(() => finalLayout.value?.score ?? null)
const diagnostics = computed(() => finalLayout.value?.diagnostics ?? [])
const elapsedMs = computed(
  () => history.selectedRun.value?.stats.elapsedMs ?? history.result.value?.stats.elapsedMs ?? null
)
const selectedTransform = computed(() => {
  const transform = selectedFrame.value?.selectedTransform
  if (!transform) return null
  const mirror = transform.mirrored ? ' mirrored' : ''
  return (
    String(transform.rotationDeg) +
    '°' +
    mirror +
    ' → ' +
    transform.translateX +
    ', ' +
    transform.translateY +
    ' mm'
  )
})

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatArea(value: number): string {
  return formatNumber(value) + ' mm²'
}
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
        <dt>result status</dt>
        <dd>{{ finalLayout?.status ?? 'awaiting result' }}</dd>
      </div>
      <div>
        <dt>elapsed</dt>
        <dd>{{ elapsedMs === null ? 'awaiting result' : formatNumber(elapsedMs) + ' ms' }}</dd>
      </div>
      <div>
        <dt>placements</dt>
        <dd>{{ placementCount }}</dd>
      </div>
      <div>
        <dt>unplaced</dt>
        <dd :title="unplacedPieceIds.join(', ')">
          {{ unplacedPieceIds.length
          }}<span v-if="unplacedPieceIds.length > 0"> · {{ unplacedPieceIds.join(', ') }}</span>
        </dd>
      </div>
      <div>
        <dt>diagnostics</dt>
        <dd>{{ diagnostics.length }}</dd>
      </div>
      <div>
        <dt>history frame</dt>
        <dd v-if="selectedFrame">
          step {{ selectedFrame.stepIndex }} · beam {{ selectedFrame.beamRank + 1 }}/{{
            selectedFrame.beamWidth
          }}
        </dd>
        <dd v-else>final layout</dd>
      </div>
      <div v-if="selectedFrame">
        <dt>candidates</dt>
        <dd>{{ selectedFrame.candidateCount ?? 'not reported' }}</dd>
      </div>
      <div v-if="selectedFrame">
        <dt>selected transform</dt>
        <dd>{{ selectedTransform ?? 'not reported' }}</dd>
      </div>
    </dl>

    <h4 v-if="score">Final layout score</h4>
    <dl v-if="score" class="score-grid">
      <div title="Largest remaining free-material region reported by the worker.">
        <dt>largest free region</dt>
        <dd>{{ formatArea(score.largestNetFreeMaterialRegionAreaMm2) }}</dd>
      </div>
      <div title="Number of remaining free-material regions reported by the worker.">
        <dt>free regions</dt>
        <dd>{{ score.freeMaterialRegionCount }}</dd>
      </div>
      <div title="Number of holes in the remaining free-material regions.">
        <dt>free holes</dt>
        <dd>{{ score.freeMaterialHoleCount }}</dd>
      </div>
      <div title="Worker-reported free-material sliver metric.">
        <dt>sliver metric</dt>
        <dd>{{ formatNumber(score.freeMaterialSliverMetric) }}</dd>
      </div>
    </dl>

    <h4 v-if="diagnostics.length > 0">Final diagnostics</h4>
    <ul v-if="diagnostics.length > 0" class="diagnostics">
      <li v-for="diagnostic in diagnostics" :key="diagnostic.code + diagnostic.message">
        <code>{{ diagnostic.code }}</code>
        <span>{{ diagnostic.message }}</span>
      </li>
    </ul>

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

h4 {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: normal;
  text-transform: uppercase;
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

.score-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

dt {
  color: var(--text-muted);
  font-size: 11px;
}

dd {
  margin: 2px 0 0;
  font-size: 12px;
}

.diagnostics {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
}

.diagnostics li {
  display: flex;
  gap: 6px;
  border-left: 2px solid var(--warning);
  padding-left: 6px;
  color: var(--text-secondary);
  font-size: 11px;
}

.diagnostics code {
  color: var(--warning);
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
