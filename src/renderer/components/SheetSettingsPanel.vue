<script setup lang="ts">
import { computed } from 'vue'
import { useSettings } from '../composables/useSettings.js'
import FileDropZone from './FileDropZone.vue'
import { STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'
import { LAYOUT_SELECTION_STRATEGIES } from '@shared/domain/layoutSelectionStrategies.js'
import type { NestingOptions } from '@shared/domain/nesting.js'

const settings = useSettings()

const sheetInvalid = computed(
  () => settings.state.value.sheet.width <= 0 || settings.state.value.sheet.height <= 0
)

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ''
}

function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : ''
}

function setHistoryMode(event: Event): void {
  settings.setHistoryMode(selectValue(event) as NestingOptions['historyMode'])
}

function setStrategySelectionMode(event: Event): void {
  settings.setStrategySelectionMode(selectValue(event) as NestingOptions['strategySelectionMode'])
}

function setFinalSelectionMode(event: Event): void {
  settings.setFinalSelectionMode(selectValue(event) as NestingOptions['finalSelectionMode'])
}

function setLayoutSelectionStrategyId(event: Event): void {
  settings.setLayoutSelectionStrategyId(selectValue(event))
}
</script>

<template>
  <div class="panel-content">
    <h2>Settings</h2>
    <FileDropZone />

    <h3>Sheet</h3>
    <div class="grid">
      <label title="Usable sheet width in millimeters.">
        Width (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="settings.state.value.sheet.width"
          @input="settings.setSheetWidth(Number(inputValue($event)))"
        />
      </label>
      <label title="Usable sheet height in millimeters.">
        Height (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="settings.state.value.sheet.height"
          @input="settings.setSheetHeight(Number(inputValue($event)))"
        />
      </label>
      <label class="span-2" title="Human-readable sheet name used in saved projects and exports.">
        Label
        <input
          type="text"
          :value="settings.state.value.sheet.label"
          @input="settings.setSheetLabel(inputValue($event))"
        />
      </label>
      <p v-if="sheetInvalid" class="warning span-2">
        Sheet width and height must be greater than zero.
      </p>
    </div>

    <h3>Cutting</h3>
    <div class="grid">
      <label
        title="Clearance added around each imported shape. The algorithm works with padded rectangular footprints."
      >
        Padding (mm)
        <input
          type="number"
          min="0"
          step="0.1"
          :value="settings.state.value.padding"
          @input="settings.setPadding(Number(inputValue($event)))"
        />
      </label>
      <label
        title="Passed to the worker for future algorithms. The current stub does not use rotation."
      >
        Allow rotation
        <input
          type="checkbox"
          :checked="settings.state.value.options.allowGlobalRotation"
          @change="settings.setAllowGlobalRotation(inputChecked($event))"
        />
      </label>
    </div>

    <h3>Job</h3>
    <div class="grid">
      <label
        title="Maximum worker runtime before the job should be cancelled or reported as timed out."
      >
        Timeout (ms)
        <input
          type="number"
          min="1000"
          step="1000"
          :value="settings.state.value.options.timeoutMs"
          @input="settings.setTimeoutMs(Number(inputValue($event)))"
        />
      </label>
      <label
        title="Controls whether worker-emitted algorithm frames are retained or streamed. The stub only emits placeholder lifecycle history."
      >
        History mode
        <select :value="settings.state.value.options.historyMode" @change="setHistoryMode">
          <option value="off" title="Do not collect algorithm history.">off</option>
          <option value="final" title="Collect history and return it at the end of the run.">
            final
          </option>
          <option value="stream" title="Stream history frames while the worker runs.">
            stream
          </option>
        </select>
      </label>
    </div>

    <h3 title="Candidate strategies order legal placements before they are applied to the beam.">
      Candidate strategies
    </h3>
    <p class="hint">Selected ids feed one beam run; they are not separate worker runs.</p>
    <label
      class="span-2 full"
      title="Single runs only the checked strategy IDs. All configured runs every listed strategy."
    >
      Selection mode
      <select
        :value="settings.state.value.options.strategySelectionMode"
        @change="setStrategySelectionMode"
      >
        <option value="single" title="Run only the checked strategy IDs.">Single</option>
        <option
          value="all_configured"
          title="Run every strategy listed in the strategy configuration."
        >
          All configured
        </option>
      </select>
    </label>
    <ul class="strategy-list">
      <li v-for="strategy in STRATEGY_DEFINITIONS" :key="strategy.id">
        <label class="strategy-row">
          <input
            type="checkbox"
            :disabled="settings.state.value.options.strategySelectionMode === 'all_configured'"
            :checked="settings.state.value.options.strategyIds.includes(strategy.id)"
            @change="settings.toggleStrategyId(strategy.id)"
          />
          <span class="strategy-meta" :title="strategy.description">
            <strong>{{ strategy.label }}</strong>
            <code class="muted">{{ strategy.id }}</code>
            <small>{{ strategy.description }}</small>
          </span>
        </label>
      </li>
    </ul>

    <h3 title="This metric chooses which beam states survive after candidate expansion.">
      Layout selection
    </h3>
    <label class="span-2 full" title="Used by the beam to keep the best retained states.">
      Survivor metric
      <select
        :value="settings.state.value.options.layoutSelectionStrategyId"
        @change="setLayoutSelectionStrategyId"
      >
        <option
          v-for="strategy in LAYOUT_SELECTION_STRATEGIES"
          :key="strategy.id"
          :value="strategy.id"
          :title="strategy.description"
        >
          {{ strategy.label }}
        </option>
      </select>
    </label>

    <h3>Result selection</h3>
    <div class="grid">
      <label title="Manual mode uses the result row selected in the Strategy Runs panel.">
        Mode
        <select
          :value="settings.state.value.options.finalSelectionMode"
          @change="setFinalSelectionMode"
        >
          <option
            value="manual"
            title="Manual mode uses the result row selected in the Strategy Runs panel."
          >
            manual
          </option>
          <option
            value="best"
            disabled
            title="Reserved for the future final-result scoring layer. Disabled until scoring is implemented."
          >
            best (scoring TBD)
          </option>
          <option
            value="top_n"
            disabled
            title="Reserved for returning the top N completed result rows. Disabled until final ranking is implemented."
          >
            top N (scoring TBD)
          </option>
        </select>
      </label>
      <label title="Number of ranked results to keep when top-N final selection is implemented.">
        Top N
        <input
          type="number"
          min="1"
          step="1"
          :value="settings.state.value.options.topN ?? 3"
          @input="settings.setTopN(Number(inputValue($event)))"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.panel-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h2,
h3 {
  margin: 12px 0 4px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.span-2 {
  grid-column: span 2;
}

.full {
  grid-column: span 2;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}

input,
select {
  font-size: 12px;
}

.strategy-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.strategy-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.strategy-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.strategy-meta code {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}

.strategy-meta small {
  color: var(--text-muted);
  font-size: 10px;
}

.muted {
  color: var(--text-muted);
}

.hint,
.warning {
  margin: 0;
  font-size: 11px;
}

.hint {
  color: var(--text-muted);
}

.warning {
  color: var(--warning);
}
</style>
