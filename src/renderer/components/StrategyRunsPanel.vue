<script setup lang="ts">
import { computed, ref } from 'vue'
import { useHistoryStore } from '../composables/useHistoryStore.js'
import { useAppStore } from '../composables/useAppStore.js'
import { createRunHistoryGif } from '../utils/runHistoryGif.js'
import type { ProjectRunRecord } from '@shared/domain/project.js'
import type { ProjectHistoryRef, NestingSubRun } from '@shared/domain/nesting.js'

const history = useHistoryStore()
const store = useAppStore()
const showSubRuns = ref(true)

const emit = defineEmits<{
  'start-next-subrun': []
}>()

function stats(run: NonNullable<typeof history.selectedRun.value>) {
  return {
    status: run.status,
    placed: run.placements.length,
    unplaced: run.unplacedPieceIds.length,
    elapsedMs: run.stats.algorithm.elapsedMs,
    startedAt: run.stats.algorithm.startedAt,
    endedAt: run.stats.algorithm.endedAt,
    pieceCount: run.stats.pieceCount,
    warningCount: run.warnings.length
  }
}

const currentSubRuns = computed<ReadonlyArray<NestingSubRun>>(
  () => history.result.value?.runSummary?.subRuns ?? []
)

const selectedSubRun = computed<NestingSubRun | null>(() => {
  const id = history.state.value.selectedStrategyRunId
  if (!id) return null
  return currentSubRuns.value.find((subRun) => subRun.subRunId === id) ?? null
})

const leftoverCount = computed(() => history.result.value?.unplacedPieceIds.length ?? 0)

function subRunUsedAreaMm2(subRun: NestingSubRun): number {
  return subRun.placements.reduce((sum, placement) => sum + placement.width * placement.height, 0)
}

function formatAreaMm2(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} m²`
  return `${value.toLocaleString()} mm²`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return `${time}.${date.getMilliseconds().toString().padStart(3, '0')}`
}

function isSelected(runId: string): boolean {
  return history.state.value.selectedStrategyRunId === runId
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function deleteAllRuns(): void {
  if (!window.confirm('Delete all saved runs for this project?')) return
  history.clearRunRecords()
}

function shouldClearReplayReference(error: unknown): boolean {
  return error instanceof Error && error.message.includes('[file_read_error]')
}

function cloneHistoryRefForApi(ref: ProjectHistoryRef): ProjectHistoryRef {
  return {
    kind: ref.kind,
    jobId: ref.jobId,
    path: ref.path,
    frameCount: ref.frameCount,
    createdAt: ref.createdAt
  }
}

async function selectRunRecord(record: ProjectRunRecord): Promise<void> {
  history.selectRunRecord(record)
  const api = window.appApi
  if (api && record.history) {
    try {
      const frames = await api.loadHistoryReplay(cloneHistoryRefForApi(record.history))
      for (const frame of frames) {
        history.pushFrame(frame)
      }
    } catch (error: unknown) {
      console.warn('[history] failed to load archived run replay:', error)
      if (shouldClearReplayReference(error)) {
        history.clearRunRecordHistory(record.jobId)
      }
    }
  }
  const runId =
    record.result.selectedStrategyRunId ?? record.result.strategyResults[0]?.strategyRunId
  if (runId) history.selectStrategyRun(runId)
}

function runGifName(record: ProjectRunRecord): string {
  const createdAt = record.createdAt.replace(/[:.]/g, '-')
  return `${record.label}-${createdAt}.gif`.replace(/[^a-z0-9._-]+/gi, '-')
}

async function exportRunGif(record: ProjectRunRecord): Promise<void> {
  const api = window.appApi
  if (!api || !record.history) return
  try {
    const frames = await api.loadHistoryReplay(cloneHistoryRefForApi(record.history))
    const strategyRunId =
      record.result.selectedStrategyRunId ?? record.result.strategyResults[0]?.strategyRunId
    if (!strategyRunId) throw new Error('Run has no strategy result to export.')
    const bytes = createRunHistoryGif(frames, {
      sheet: record.sheet,
      strategyRunId,
      sourcePieces: store.state.value.pieces
    })
    await api.exportRunGif({
      defaultName: runGifName(record),
      bytes
    })
  } catch (error: unknown) {
    console.warn('[history] failed to export run GIF:', error)
    if (shouldClearReplayReference(error)) {
      history.clearRunRecordHistory(record.jobId)
    }
  }
}

function selectSubRun(subRun: NestingSubRun): void {
  history.selectStrategyRun(subRun.subRunId)
}

function startNextSubRun(): void {
  emit('start-next-subrun')
}

function subRunLabel(subRun: NestingSubRun): string {
  return `Plate ${subRun.index + 1}`
}
</script>

<template>
  <div class="runs">
    <header>
      <div class="archive-head">
        <h2 title="Completed worker runs saved for this temporary or saved project.">Saved runs</h2>
        <button
          v-if="history.runRecords.value.length > 0"
          type="button"
          class="delete-all"
          title="Delete every saved run record. Source shapes and settings are unchanged."
          @click="deleteAllRuns"
        >
          Delete all
        </button>
      </div>
      <p class="muted">
        Each saved run stores one beam-search result and its NDJSON history reference.
      </p>
    </header>

    <p v-if="history.strategyResults.value.length === 0" class="empty">
      No strategy runs yet. Import pieces, configure the sheet, then run the worker.
    </p>

    <section v-if="history.runRecords.value.length > 0" class="archive">
      <ul class="archive-list">
        <li
          v-for="record in history.runRecords.value"
          :key="record.jobId"
          :class="{ selected: history.result.value?.jobId === record.jobId }"
        >
          <button
            type="button"
            class="archive-row"
            :title="`Restore run ${record.jobId}`"
            @click="selectRunRecord(record)"
          >
            <strong>{{ record.label }}</strong>
            <span>{{ formatDate(record.createdAt) }}</span>
            <code>{{ record.result.placements.length }}/{{ record.pieceCount }}</code>
          </button>
          <button
            type="button"
            class="delete"
            title="Delete this saved run record. The source project and imports are unchanged."
            @click="history.removeRunRecord(record.jobId)"
          >
            Delete
          </button>
          <button
            type="button"
            class="export-gif"
            :disabled="!record.history"
            :title="
              record.history
                ? 'Export an animated GIF from the first retained beam of this run.'
                : 'GIF export needs a saved history replay for this run.'
            "
            @click="exportRunGif(record)"
          >
            GIF
          </button>
        </li>
      </ul>
    </section>

    <h3
      v-if="history.strategyResults.value.length > 0"
      title="The currently restored run has one result row: the MaxRects beam-search outcome."
    >
      Current result
    </h3>
    <ul class="run-list">
      <li
        v-for="run in history.strategyResults.value"
        :key="run.strategyRunId"
        :class="{ selected: isSelected(run.strategyRunId) }"
      >
        <button
          type="button"
          class="run-card"
          @click="history.selectStrategyRun(run.strategyRunId)"
          :aria-pressed="isSelected(run.strategyRunId)"
        >
          <header class="card-head">
            <strong>{{ run.strategyLabel }}</strong>
            <code>{{ run.strategyId }}</code>
            <small v-if="run.strategyDescription">{{ run.strategyDescription }}</small>
          </header>
          <dl class="metrics">
            <div title="Worker-reported status for this strategy run.">
              <dt>Status</dt>
              <dd>{{ stats(run).status }}</dd>
            </div>
            <div title="Number of pieces placed by this strategy run.">
              <dt>Placed</dt>
              <dd>{{ stats(run).placed }}</dd>
            </div>
            <div title="Pieces the selected beam could not place.">
              <dt>Unplaced</dt>
              <dd>{{ stats(run).unplaced }}</dd>
            </div>
            <div
              :title="`Algorithm start: ${stats(run).startedAt}\nAlgorithm end: ${stats(run).endedAt}`"
            >
              <dt>Algorithm</dt>
              <dd>{{ stats(run).elapsedMs }} ms</dd>
            </div>
            <div title="Algorithm run start time.">
              <dt>Start</dt>
              <dd>{{ formatTime(stats(run).startedAt) }}</dd>
            </div>
            <div title="Algorithm run end time.">
              <dt>End</dt>
              <dd>{{ formatTime(stats(run).endedAt) }}</dd>
            </div>
            <div>
              <dt>Pieces</dt>
              <dd>{{ stats(run).pieceCount }}</dd>
            </div>
            <div title="Non-fatal warnings emitted while preparing or running this strategy.">
              <dt>Warnings</dt>
              <dd>{{ stats(run).warningCount }}</dd>
            </div>
          </dl>
        </button>
      </li>
    </ul>

    <div v-if="leftoverCount > 0" class="leftovers">
      <div>
        <strong>{{ leftoverCount }} leftover piece(s)</strong>
        <span>Start another plate from the current unplaced list.</span>
      </div>
      <button
        type="button"
        class="run-leftovers"
        title="Start another subrun with the pieces that did not fit."
        @click="startNextSubRun"
      >
        Run leftovers
      </button>
    </div>

    <section v-if="currentSubRuns.length > 0" class="subruns">
      <button
        type="button"
        class="subruns-toggle"
        :aria-expanded="showSubRuns"
        @click="showSubRuns = !showSubRuns"
      >
        <span>Subruns ({{ currentSubRuns.length }})</span>
        <span class="toggle-icon">{{ showSubRuns ? '▾' : '▸' }}</span>
      </button>

      <ul v-show="showSubRuns" class="subrun-list">
        <li
          v-for="subRun in currentSubRuns"
          :key="subRun.subRunId"
          :class="{
            selected: selectedSubRun?.subRunId === subRun.subRunId,
            leftovers: subRun.unplacedPieceIds.length > 0
          }"
        >
          <button
            type="button"
            class="subrun-card"
            :aria-pressed="selectedSubRun?.subRunId === subRun.subRunId"
            @click="selectSubRun(subRun)"
          >
            <header class="subrun-head">
              <strong>{{ subRunLabel(subRun) }}</strong>
              <code>{{ subRun.sheet.width }} × {{ subRun.sheet.height }} mm</code>
            </header>
            <dl class="subrun-metrics">
              <div title="Pieces placed on this subrun.">
                <dt>Placed</dt>
                <dd>{{ subRun.placements.length }}</dd>
              </div>
              <div title="Pieces remaining unplaced after this subrun.">
                <dt>Unplaced</dt>
                <dd>{{ subRun.unplacedPieceIds.length }}</dd>
              </div>
              <div title="Area covered by placed piece footprints on this subrun.">
                <dt>Used</dt>
                <dd>{{ formatAreaMm2(subRunUsedAreaMm2(subRun)) }}</dd>
              </div>
            </dl>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.runs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

header h2 {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.archive-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.muted {
  color: var(--text-muted);
  font-size: 11px;
  margin: 4px 0;
}

.run-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.archive {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

h3 {
  margin: 4px 0 0;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.archive-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.archive-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 4px;
}

.archive-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 8px;
  align-items: baseline;
  text-align: left;
  color: inherit;
}

.archive-row strong,
.archive-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.archive-row span {
  color: var(--text-muted);
  font-size: 10px;
}

.archive-row code {
  font-size: 10px;
  color: var(--text-muted);
}

.archive-list li.selected .archive-row {
  border-color: var(--accent);
  background: rgba(0, 122, 204, 0.08);
}

.delete {
  font-size: 10px;
  padding: 2px 6px;
}

.export-gif {
  font-size: 10px;
  padding: 2px 6px;
}

.delete-all {
  font-size: 10px;
  padding: 2px 6px;
}

.run-card {
  width: 100%;
  text-align: left;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  cursor: pointer;
  color: inherit;
}

.run-card:hover {
  border-color: var(--accent);
}

li.selected .run-card {
  border-color: var(--accent);
  background: rgba(0, 122, 204, 0.08);
}

.card-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}

.card-head code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}

.card-head small,
.empty {
  color: var(--text-muted);
  font-size: 11px;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px 8px;
  margin: 0;
  font-size: 10px;
}

.metrics > div {
  display: flex;
  flex-direction: column;
}

dt {
  color: var(--text-muted);
  font-weight: normal;
}

dd {
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.subruns {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}

.subruns-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 4px 6px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}

.subruns-toggle:hover {
  border-color: var(--accent);
}

.toggle-icon {
  font-size: 12px;
}

.subrun-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subrun-list li {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.subrun-card {
  width: 100%;
  text-align: left;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  cursor: pointer;
  color: inherit;
}

.subrun-card:hover {
  border-color: var(--accent);
}

li.selected .subrun-card {
  border-color: var(--accent);
  background: rgba(0, 122, 204, 0.08);
}

li.leftovers .subrun-card {
  border-color: rgba(255, 176, 32, 0.65);
}

li.leftovers .subrun-metrics div:nth-child(2) dd {
  color: var(--warning);
}

.subrun-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
}

.subrun-head strong {
  font-size: 11px;
}

.subrun-head code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}

.subrun-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px 6px;
  margin: 0;
  font-size: 10px;
}

.subrun-metrics > div {
  display: flex;
  flex-direction: column;
}

.leftovers {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid rgba(255, 176, 32, 0.55);
  border-radius: var(--radius);
  background: rgba(255, 176, 32, 0.08);
}

.leftovers div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.leftovers strong {
  color: var(--warning);
  font-size: 11px;
}

.leftovers span {
  color: var(--text-secondary);
  font-size: 10px;
}

.run-leftovers {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 3px 8px;
}
</style>
