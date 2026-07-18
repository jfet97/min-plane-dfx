<script setup lang="ts">
import { computed } from 'vue'
import { useSettings } from '../composables/useSettings.js'
import FileDropZone from './FileDropZone.vue'
import PresetShapePanel from './PresetShapePanel.vue'
import IrregularSettingsPanel from './IrregularSettingsPanel.vue'
import { STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'
import { LAYOUT_SELECTION_STRATEGIES } from '@shared/domain/layoutSelectionStrategies.js'
import {
  workerTimeoutForMode,
  IRREGULAR_WORKER_MODE,
  makeDefaultIrregularNestingSettings
} from '@shared/irregular/defaults.js'
import type { NestingOptions, SheetSpec } from '@shared/domain/nesting.js'

interface SettingsModel {
  sheet: SheetSpec
  padding: number
  options: NestingOptions
}

const props = defineProps<{
  modelValue?: SettingsModel
  csvNote?: string | null
  heading?: string
  showSourceControls?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: SettingsModel]
}>()

const settings = useSettings()

const isLocal = computed(() => props.modelValue !== undefined)
const model = computed<SettingsModel>(() => props.modelValue ?? settings.state.value)
const heading = computed(() => props.heading ?? 'Settings')
const showSourceControls = computed(() => props.showSourceControls ?? true)
const isIrregularMode = computed(() => model.value.options.workerMode === IRREGULAR_WORKER_MODE)

const sheetInvalid = computed(() => model.value.sheet.width <= 0 || model.value.sheet.height <= 0)
const allStrategyIds = computed(() => STRATEGY_DEFINITIONS.map((strategy) => strategy.id))
const allStrategiesChecked = computed(
  () =>
    allStrategyIds.value.length > 0 &&
    allStrategyIds.value.every((id) => model.value.options.strategyIds.includes(id))
)
const selectedLayoutStrategy = computed(() => {
  const current = LAYOUT_SELECTION_STRATEGIES.find(
    (strategy) => strategy.id === model.value.options.layoutSelectionStrategyId
  )
  if (current !== undefined) return current
  return LAYOUT_SELECTION_STRATEGIES[0]
})
const selectedLayoutStrategyTooltip = computed(() =>
  selectedLayoutStrategy.value === undefined
    ? 'Used by the beam to keep the best retained states.'
    : `${selectedLayoutStrategy.value.label}: ${selectedLayoutStrategy.value.description}`
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

function updateModel(patch: Partial<SettingsModel>): void {
  if (!props.modelValue) return
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

function updateSheet(patch: Partial<SheetSpec>): void {
  if (isLocal.value) {
    updateModel({ sheet: { ...model.value.sheet, ...patch } })
  } else {
    if (patch.width !== undefined) settings.setSheetWidth(patch.width)
    if (patch.height !== undefined) settings.setSheetHeight(patch.height)
    if (patch.label !== undefined) settings.setSheetLabel(patch.label)
  }
}

function updatePadding(padding: number): void {
  if (isLocal.value) {
    updateModel({ padding })
  } else {
    settings.setPadding(padding)
  }
}

function updateOptions(patch: Partial<NestingOptions>): void {
  if (isLocal.value) {
    updateModel({ options: { ...model.value.options, ...patch } })
  } else {
    if (patch.allowGlobalRotation !== undefined)
      settings.setAllowGlobalRotation(patch.allowGlobalRotation)
    if (patch.allowGlobalMirror !== undefined) settings.setAllowGlobalMirror(patch.allowGlobalMirror)
    if (patch.timeoutMs !== undefined) settings.setTimeoutMs(patch.timeoutMs)
    if (patch.workerMode !== undefined) settings.setWorkerMode(patch.workerMode)
    if (patch.irregularSettings !== undefined) settings.setIrregularSettings(patch.irregularSettings)
    if (patch.historyMode !== undefined) settings.setHistoryMode(patch.historyMode)
    if (patch.strategySelectionMode !== undefined)
      settings.setStrategySelectionMode(patch.strategySelectionMode)
    if (patch.layoutSelectionStrategyId !== undefined)
      settings.setLayoutSelectionStrategyId(patch.layoutSelectionStrategyId)
    if (patch.finalSelectionMode !== undefined)
      settings.setFinalSelectionMode(patch.finalSelectionMode)
    if (patch.topN !== undefined) settings.setTopN(patch.topN)
  }
}

function setStrategyIds(ids: ReadonlyArray<string>): void {
  if (isLocal.value) {
    updateModel({ options: { ...model.value.options, strategyIds: [...ids] } })
  } else {
    settings.setStrategyIds(ids)
  }
}

function toggleStrategyId(id: string): void {
  if (isLocal.value) {
    const ids = [...model.value.options.strategyIds]
    const idx = ids.indexOf(id)
    if (idx >= 0) {
      ids.splice(idx, 1)
    } else {
      ids.push(id)
    }
    updateModel({ options: { ...model.value.options, strategyIds: ids } })
  } else {
    settings.toggleStrategyId(id)
  }
}

function setHistoryMode(event: Event): void {
  updateOptions({ historyMode: selectValue(event) as NestingOptions['historyMode'] })
}

function selectWorkerMode(workerMode: NestingOptions['workerMode']): void {
  const needsIrregularSettings =
    workerMode === IRREGULAR_WORKER_MODE && model.value.options.irregularSettings === undefined
  updateOptions({
    workerMode,
    ...(needsIrregularSettings
      ? { irregularSettings: makeDefaultIrregularNestingSettings() }
      : {}),
    ...(workerMode === IRREGULAR_WORKER_MODE
      ? { timeoutMs: workerTimeoutForMode(workerMode, model.value.options.timeoutMs) }
      : {})
  })
}

function setStrategySelectionMode(event: Event): void {
  updateOptions({
    strategySelectionMode: selectValue(event) as NestingOptions['strategySelectionMode']
  })
}

function setFinalSelectionMode(event: Event): void {
  updateOptions({ finalSelectionMode: selectValue(event) as NestingOptions['finalSelectionMode'] })
}

function setLayoutSelectionStrategyId(event: Event): void {
  const id = selectValue(event)
  const known = LAYOUT_SELECTION_STRATEGIES.find((strategy) => strategy.id === id)
  if (!known) return
  updateOptions({ layoutSelectionStrategyId: known.id })
}
</script>

<template>
  <div class="panel-content">
    <h2>{{ heading }}</h2>

    <template v-if="showSourceControls">
      <h3>Source shapes</h3>
      <p class="hint">Add a built-in shape below, or import any custom closed outline as a DXF.</p>
      <FileDropZone />
      <PresetShapePanel />
    </template>

    <h3>Sheet</h3>
    <p v-if="csvNote" class="csv-note">{{ csvNote }}</p>
    <div class="grid">
      <label title="Usable sheet width in millimeters.">
        Width (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="model.sheet.width"
          @input="updateSheet({ width: Number(inputValue($event)) })"
        />
      </label>
      <label title="Usable sheet height in millimeters.">
        Height (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="model.sheet.height"
          @input="updateSheet({ height: Number(inputValue($event)) })"
        />
      </label>
      <label class="span-2" title="Human-readable sheet name used in saved projects and exports.">
        Label
        <input
          type="text"
          :value="model.sheet.label"
          @input="updateSheet({ label: inputValue($event) })"
        />
      </label>
      <p v-if="sheetInvalid" class="warning span-2">
        Sheet width and height must be greater than zero.
      </p>
    </div>

    <h3>Algorithm</h3>
    <div class="algorithm-cards">
      <button
        type="button"
        :class="{ active: !isIrregularMode }"
        title="Fast rectangular MaxRects nesting. Uses rectangular bounds and its own candidate and layout strategies."
        @click="selectWorkerMode('maxrects-beam-search')"
      >
        <strong>Rectangles</strong>
        <span>MaxRects beam</span>
        <small>Fast axis-aligned rectangle nesting.</small>
      </button>
      <button
        type="button"
        :class="{ active: isIrregularMode }"
        title="Experimental convex-polygon nesting. Uses DXF geometry, convex collision polygons, NFP/IFP placement, and optional portfolio search."
        @click="selectWorkerMode('irregular-convex-v2')"
      >
        <strong>Convex polygons</strong>
        <span>DXF geometry beam</span>
        <small>Conservative polygon collision nesting.</small>
      </button>
    </div>

    <h3>Cutting</h3>
    <div class="grid">
      <label
        title="Total integer clearance around each source shape. Odd values round outward per side."
      >
        Padding (mm)
        <input
          type="number"
          min="0"
          step="1"
          :value="model.padding"
          @input="updatePadding(Number(inputValue($event)))"
        />
      </label>
      <label
        v-if="!isIrregularMode"
        title="Allows candidate generation to try rotated placements when the piece fits that way."
      >
        Allow 90° rotation
        <input
          type="checkbox"
          :checked="model.options.allowGlobalRotation"
          @change="updateOptions({ allowGlobalRotation: inputChecked($event) })"
        />
      </label>
      <label
        v-else
        title="Allows convex polygon candidate generation to try orthogonal, edge-derived, and explicitly configured rotations."
      >
        Allow rotations
        <input
          type="checkbox"
          :checked="model.options.allowGlobalRotation"
          @change="updateOptions({ allowGlobalRotation: inputChecked($event) })"
        />
      </label>
      <label
        v-if="isIrregularMode"
        title="Allows convex polygon candidate generation to try mirrored source geometry for eligible source shapes."
      >
        Allow mirroring
        <input
          type="checkbox"
          :checked="model.options.allowGlobalMirror ?? true"
          @change="updateOptions({ allowGlobalMirror: inputChecked($event) })"
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
          :value="model.options.timeoutMs"
          @input="updateOptions({ timeoutMs: Number(inputValue($event)) })"
        />
      </label>
      <label title="Controls whether worker-emitted algorithm frames are retained or streamed.">
        History mode
        <select :value="model.options.historyMode" @change="setHistoryMode">
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

    <IrregularSettingsPanel
      v-if="isIrregularMode"
      :settings="model.options.irregularSettings"
      :timeout-ms="model.options.timeoutMs"
      @update="updateOptions({ irregularSettings: $event })"
    />

    <template v-else>
      <h3 title="Candidate strategies order legal placements before they are applied to the beam.">
      Candidate strategies
      </h3>
      <div class="section-actions">
      <p class="hint">Selected ids feed one beam run; they are not separate worker runs.</p>
      <button
        type="button"
        :disabled="allStrategiesChecked"
        title="Check every candidate strategy in the list."
        @click="setStrategyIds(allStrategyIds)"
      >
        All
      </button>
      <button
        type="button"
        :disabled="model.options.strategyIds.length === 0"
        title="Clear the checked candidate strategy list."
        @click="setStrategyIds([])"
      >
        None
      </button>
      </div>
      <label
      class="span-2 full"
      title="Single runs only the checked strategy IDs. All configured runs every listed strategy."
    >
      Candidate set
      <select :value="model.options.strategySelectionMode" @change="setStrategySelectionMode">
        <option value="single" title="Use only the checked candidate strategy IDs.">
          Checked only
        </option>
        <option
          value="all_configured"
          title="Use every candidate strategy listed in the strategy configuration."
        >
          All candidate orders
        </option>
      </select>
      </label>
      <ul class="strategy-list">
      <li v-for="strategy in STRATEGY_DEFINITIONS" :key="strategy.id">
        <label class="strategy-row">
          <input
            type="checkbox"
            :disabled="model.options.strategySelectionMode === 'all_configured'"
            :checked="model.options.strategyIds.includes(strategy.id)"
            @change="toggleStrategyId(strategy.id)"
          />
          <span class="strategy-meta" :title="strategy.description">
            <strong>{{ strategy.label }}</strong>
            <code class="muted">{{ strategy.id }}</code>
            <small>{{ strategy.description }}</small>
          </span>
        </label>
      </li>
      </ul>

      <h3
      title="Beam survivor metric used after each candidate is applied to decide which retained states survive the next expansion."
      >
      Layout selection
      </h3>
      <label class="span-2 full">
      Survivor metric
      <select
        :value="model.options.layoutSelectionStrategyId"
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
      <p
      v-if="selectedLayoutStrategy"
      class="strategy-description"
      :title="selectedLayoutStrategyTooltip"
      >
      <small>{{ selectedLayoutStrategy.description }}</small>
      </p>
    </template>

    <template v-if="!isIrregularMode">
      <h3>Result selection</h3>
      <div class="grid">
      <label title="Manual mode uses the result row selected in the Strategy Runs panel.">
        Mode
        <select :value="model.options.finalSelectionMode" @change="setFinalSelectionMode">
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
          :value="model.options.topN ?? 3"
          @input="updateOptions({ topN: Number(inputValue($event)) })"
        />
      </label>
      </div>
    </template>
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
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.algorithm-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.algorithm-cards button {
  display: grid;
  min-height: 86px;
  align-content: start;
  gap: 3px;
  padding: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-primary);
  text-align: left;
}

.algorithm-cards button.active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--panel));
}

.algorithm-cards span,
.algorithm-cards small {
  color: var(--text-secondary);
}

.span-2 {
  grid-column: span 2;
}

.full {
  grid-column: span 2;
}

label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}

input,
select {
  width: 100%;
  min-width: 0;
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

.section-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-actions .hint {
  flex: 1;
}

.section-actions button {
  font-size: 11px;
  padding: 2px 6px;
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

.strategy-description {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  font-size: 11px;
  color: var(--text);
}

.strategy-description small {
  color: var(--text);
  font-size: 11px;
  line-height: 1.4;
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

.csv-note {
  margin: 0 0 6px;
  padding: 4px 6px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 11px;
}
</style>
