<script setup lang="ts">
import { useHistoryStore } from '../composables/useHistoryStore.js'
import { useFinalSelection } from '../composables/useFinalSelection.js'

const history = useHistoryStore()
const finalSelection = useFinalSelection()

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
      <h2>Strategy runs</h2>
      <p class="muted">
        Each run is independent. The selected run drives the result view and the
        history timeline.
      </p>
    </header>

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
          </header>
          <dl class="metrics">
            <div><dt>Status</dt><dd>{{ stats(run).status }}</dd></div>
            <div><dt>Placed</dt><dd>{{ stats(run).placed }}</dd></div>
            <div><dt>Unplaced</dt><dd>{{ stats(run).unplaced }}</dd></div>
            <div><dt>Elapsed</dt><dd>{{ stats(run).elapsedMs }} ms</dd></div>
            <div><dt>Pieces</dt><dd>{{ stats(run).pieceCount }}</dd></div>
            <div><dt>Warnings</dt><dd>{{ stats(run).warningCount }}</dd></div>
          </dl>
        </button>
      </li>
    </ul>

    <section class="final-selection">
      <h3>Final selection</h3>
      <div class="row">
        <label>
          Mode
          <select
            :value="finalSelection.state.value.mode"
            @change="
              finalSelection.setMode(
                ($event.target as HTMLSelectElement).value as 'manual' | 'best' | 'top_n'
              )
            "
          >
            <option value="manual">manual</option>
            <option value="best" disabled title="Scoring criteria not implemented yet">best</option>
            <option value="top_n" disabled title="Scoring criteria not implemented yet">top N</option>
          </select>
        </label>
        <label>
          Top N
          <input
            type="number"
            min="1"
            step="1"
            :value="finalSelection.state.value.topN"
            @input="finalSelection.setTopN(Number(($event.target as HTMLInputElement).value))"
          />
        </label>
      </div>
      <p class="muted">
        <span v-if="finalSelection.state.value.mode === 'best'">
          "best" is reserved for the user-written scoring layer.
        </span>
        <span v-else-if="finalSelection.state.value.mode === 'top_n'">
          "top N" ranking is reserved for the user-written scoring layer.
        </span>
        <span v-else>
          Manual selection: pick a run above. The final result will follow the selected run.
        </span>
      </p>
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

.final-selection {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.final-selection h3 {
  margin: 0 0 4px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.row {
  display: grid;
  grid-template-columns: 1fr 80px;
  gap: 6px;
  margin-bottom: 4px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--text-secondary);
}
</style>