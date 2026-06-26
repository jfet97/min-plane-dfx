<script setup lang="ts">
import { useSettings } from '../composables/useSettings.js'
import FileDropZone from './FileDropZone.vue'
import { STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'

const settings = useSettings()
</script>

<template>
  <div class="panel-content">
    <h2>Settings</h2>
    <FileDropZone />

    <h3>Sheet</h3>
    <div class="grid">
      <label>
        Width (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="settings.state.value.sheet.width"
          @input="settings.setSheetWidth(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label>
        Height (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="settings.state.value.sheet.height"
          @input="settings.setSheetHeight(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="span-2">
        Label
        <input
          type="text"
          :value="settings.state.value.sheet.label"
          @input="settings.setSheetLabel(($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>

    <h3>Cutting</h3>
    <div class="grid">
      <label>
        Padding (mm)
        <input
          type="number"
          min="0"
          step="0.1"
          :value="settings.state.value.padding"
          @input="settings.setPadding(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label>
        Allow rotation
        <input
          type="checkbox"
          :checked="settings.state.value.options.allowGlobalRotation"
          @change="settings.setAllowGlobalRotation(($event.target as HTMLInputElement).checked)"
        />
      </label>
    </div>

    <h3>Job</h3>
    <div class="grid">
      <label>
        Timeout (ms)
        <input
          type="number"
          min="1000"
          step="1000"
          :value="settings.state.value.options.timeoutMs"
          @input="settings.setTimeoutMs(Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label>
        History mode
        <select
          :value="settings.state.value.options.historyMode"
          @change="settings.setHistoryMode(($event.target as HTMLSelectElement).value as 'stream' | 'final' | 'off')"
        >
          <option value="off">off</option>
          <option value="final">final</option>
          <option value="stream">stream</option>
        </select>
      </label>
    </div>

    <h3>Strategies</h3>
    <label class="span-2 full">
      Selection mode
      <select
        :value="settings.state.value.options.strategySelectionMode"
        @change="
          settings.setStrategySelectionMode(
            ($event.target as HTMLSelectElement).value as 'single' | 'all_configured'
          )
        "
      >
        <option value="single">Single (use strategyIds)</option>
        <option value="all_configured">All configured</option>
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
          <span class="strategy-meta">
            <strong>{{ strategy.label }}</strong>
            <code class="muted">{{ strategy.id }}</code>
            <small>{{ strategy.description }}</small>
          </span>
        </label>
      </li>
    </ul>

    <h3>Final selection</h3>
    <div class="grid">
      <label>
        Mode
        <select
          :value="settings.state.value.options.finalSelectionMode"
          @change="
            settings.setFinalSelectionMode(
              ($event.target as HTMLSelectElement).value as 'manual' | 'best' | 'top_n'
            )
          "
        >
          <option value="manual">manual</option>
          <option value="best" disabled>best (scoring TBD)</option>
          <option value="top_n" disabled>top N (scoring TBD)</option>
        </select>
      </label>
      <label>
        Top N
        <input
          type="number"
          min="1"
          step="1"
          :value="settings.state.value.options.topN ?? 3"
          @input="settings.setTopN(Number(($event.target as HTMLInputElement).value))"
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
</style>