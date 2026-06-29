<script setup lang="ts">
import { useHistoryStore } from '../composables/useHistoryStore.js'

const history = useHistoryStore()

function stats(run: NonNullable<typeof history.selectedRun.value>) {
  return {
    status: run.status,
    placed: run.placements.length,
    unplaced: run.unplacedPieceIds.length,
    elapsedMs: run.stats.elapsedMs,
    pieceCount: run.stats.pieceCount,
    warningCount: run.warnings.length
  }
}

function isSelected(runId: string): boolean {
  return history.state.value.selectedStrategyRunId === runId
}
</script>

<template>
  <div class="runs">
    <header>
      <h2 title="Worker-reported runs for each selected strategy configuration.">Strategy runs</h2>
      <p class="muted">
        Candidate strategies feed one beam run. The selected row drives the result view and
        timeline.
      </p>
    </header>

    <p v-if="history.strategyResults.value.length === 0" class="empty">
      No strategy runs yet. Import pieces, configure the sheet, then run the worker.
    </p>

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
            <div title="Runtime reported by the worker.">
              <dt>Elapsed</dt>
              <dd>{{ stats(run).elapsedMs }} ms</dd>
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
