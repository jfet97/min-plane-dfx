<script setup lang="ts">
import { useHistoryStore } from '../composables/useHistoryStore.js'
import type { ProjectRunRecord } from '@shared/domain/project.js'

const history = useHistoryStore()

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

async function selectRunRecord(record: ProjectRunRecord): Promise<void> {
  history.selectRunRecord(record)
  const api = window.appApi
  if (api && record.history) {
    try {
      const frames = await api.loadHistoryReplay(record.history)
      for (const frame of frames) {
        history.pushFrame(frame)
      }
    } catch (error: unknown) {
      console.warn('[history] failed to load archived run replay:', error)
      history.clearRunRecordHistory(record.jobId)
    }
  }
  const runId =
    record.result.selectedStrategyRunId ?? record.result.strategyResults[0]?.strategyRunId
  if (runId) history.selectStrategyRun(runId)
}
</script>

<template>
  <div class="runs">
    <header>
      <h2 title="Completed worker runs saved for this temporary or saved project.">Saved runs</h2>
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
  grid-template-columns: minmax(0, 1fr) auto;
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
</style>
