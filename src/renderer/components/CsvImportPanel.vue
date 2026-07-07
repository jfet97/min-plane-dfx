<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { useCsvImportStore } from '../composables/useCsvImportStore.js'
import { useAppStore } from '../composables/useAppStore.js'
import { PieceId } from '@shared/domain/ids.js'
import { STRATEGY_DEFINITIONS } from '@shared/domain/strategies.js'
import { SheetSpec } from '@shared/domain/nesting.js'
import type { NestingOptions, SheetSpec as SheetSpecType } from '@shared/domain/nesting.js'
import type { ProjectCsvImport } from '@shared/domain/project.js'

/* A writable copy of the nesting options shape used only for local subrun
 * configuration. The public NestingOptions type is treated as readonly by
 * TypeScript, so we build a mutable clone and cast it back when emitting. */
interface MutableSubrunOptions {
  allowGlobalRotation: boolean
  timeoutMs: number
  workerMode: NestingOptions['workerMode']
  historyMode: 'stream' | 'final' | 'off'
  historyScope: 'winning_path'
  strategySelectionMode: 'single' | 'all_configured'
  strategyIds: string[]
  layoutSelectionStrategyId: string
  finalSelectionMode: 'manual' | 'best' | 'top_n'
  topN?: number
  maxHistoryEvents?: number
}

const csvStore = useCsvImportStore()
const appStore = useAppStore()

const emit = defineEmits<{
  (event: 'run-csv', importId: string): void
  (
    event: 'start-subrun',
    importId: string,
    sheet: SheetSpecType,
    padding: number,
    options: NestingOptions
  ): void
  (event: 'export-csv', importId: string): void
}>()

defineExpose({ openNextSubrunConfig })

const allStrategyIds = computed(() => STRATEGY_DEFINITIONS.map((strategy) => strategy.id))

const selectedCsv = computed(() => csvStore.selectedCsv.value)

const selectedSession = computed(() => csvStore.selectedSession.value)

const activeRunRecord = computed(() => csvStore.activeCsvRunRecord.value)

const canRun = computed(() => {
  const csv = selectedCsv.value
  if (!csv) return false
  const sheet = csv.runConfiguration.defaultSheet
  if (sheet.width <= 0 || sheet.height <= 0) return false
  if (csv.rows.length === 0) return false
  return csv.rows.every((row) => isRowLinked(row))
})

const canExport = computed(
  () => activeRunRecord.value !== null && activeRunRecord.value.subRuns.length > 0
)

const canNextSubrun = computed(() => {
  const session = selectedSession.value
  return session !== null && session.subRuns.length > 0 && session.unplacedPieceIds.length > 0
})

const allRowsLinked = computed(() => {
  const csv = selectedCsv.value
  return csv === null || csv.rows.length === 0 || csv.rows.every((row) => isRowLinked(row))
})

function makeDefaultOptions(): MutableSubrunOptions {
  return {
    allowGlobalRotation: true,
    timeoutMs: 30000,
    workerMode: 'maxrects-beam-search',
    historyMode: 'final',
    historyScope: 'winning_path',
    strategySelectionMode: 'single',
    strategyIds: [STRATEGY_DEFINITIONS[0]?.id ?? ''],
    layoutSelectionStrategyId: 'largest-free-area-first',
    finalSelectionMode: 'manual',
    topN: 3
  }
}

const subrunConfig = reactive<{
  open: boolean
  width: number
  height: number
  label: string
  padding: number
  options: MutableSubrunOptions
}>({
  open: false,
  width: 1500,
  height: 1500,
  label: 'mother plate 1500x1500',
  padding: 10,
  options: makeDefaultOptions()
})

const importFailures = computed(() => csvStore.state.value.importFailures)

const sourcePieceIds = computed(() => new Set(appStore.state.value.pieces.map((piece) => piece.id)))

function isPieceIdLinked(pieceId: PieceId | undefined): pieceId is PieceId {
  return pieceId !== undefined && sourcePieceIds.value.has(pieceId)
}

function isRowLinked(row: { linkedPieceId?: PieceId | undefined }): boolean {
  return isPieceIdLinked(row.linkedPieceId)
}

watch(
  () => selectedCsv.value?.id,
  () => {
    subrunConfig.open = false
  }
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

function normalizeCsvImportResult(result: unknown): {
  documents: ProjectCsvImport[]
  failures: Array<{ path: string; message: string }>
} {
  if (Array.isArray(result)) {
    return { documents: [...(result as ReadonlyArray<ProjectCsvImport>)], failures: [] }
  }
  const objectResult = result as {
    readonly documents?: ReadonlyArray<ProjectCsvImport>
    readonly failures?: ReadonlyArray<{
      readonly path: string
      readonly error?: unknown
      readonly message?: string
      readonly code?: string
    }>
  }
  const documents = objectResult.documents ? [...objectResult.documents] : []
  const failures = (objectResult.failures ?? []).map((failure) => ({
    path: failure.path,
    message:
      typeof failure.message === 'string'
        ? failure.message
        : failure.error instanceof Error
          ? failure.error.message
          : String(failure.error ?? 'unknown error')
  }))
  return { documents, failures }
}

async function onImportCsv(): Promise<void> {
  const api = window.appApi
  if (!api) return
  csvStore.clearImportFailures()
  try {
    const result = await api.selectCsvFiles()
    const { documents, failures } = normalizeCsvImportResult(result)
    if (documents.length > 0) {
      csvStore.appendCsvImports(documents)
    }
    csvStore.setImportFailures(failures)
  } catch (error: unknown) {
    console.error('[csv-import-panel] failed to import CSV:', error)
    csvStore.setImportFailures([
      { path: '', message: error instanceof Error ? error.message : String(error) }
    ])
  }
}

async function onRemoveSelected(): Promise<void> {
  const csv = selectedCsv.value
  if (!csv) return
  if (!confirm(`Remove imported CSV '${csv.fileName}'?`)) return
  const api = window.appApi
  if (api) {
    await api.removeImportedCsv(csv.id)
  }
  csvStore.removeCsvImport(csv.id)
}

async function onClearAll(): Promise<void> {
  if (!confirm('Remove all imported CSVs?')) return
  const api = window.appApi
  if (api) {
    await api.clearImportedCsvs()
  }
  csvStore.clear()
}

function onSelectCsv(id: string): void {
  csvStore.selectCsv(id)
}

async function onLinkRow(csvImportId: string, rowId: string, pieceId: PieceId): Promise<void> {
  await csvStore.linkRowToPiece(csvImportId, rowId, pieceId || undefined)
}

function setMainSheetWidth(csvImportId: string, value: number): void {
  const csv = selectedCsv.value
  if (!csv) return
  const width = Math.max(1, Math.round(value))
  const height = csv.runConfiguration.defaultSheet.height
  const label = `mother plate ${width}x${height}`
  void csvStore.updateRunConfiguration(csvImportId, {
    defaultSheet: new SheetSpec({ width, height, label })
  })
}

function setMainSheetHeight(csvImportId: string, value: number): void {
  const csv = selectedCsv.value
  if (!csv) return
  const width = csv.runConfiguration.defaultSheet.width
  const height = Math.max(1, Math.round(value))
  const label = `mother plate ${width}x${height}`
  void csvStore.updateRunConfiguration(csvImportId, {
    defaultSheet: new SheetSpec({ width, height, label })
  })
}

function setMainPadding(csvImportId: string, value: number): void {
  void csvStore.updateRunConfiguration(csvImportId, {
    padding: Math.max(0, Math.round(value))
  })
}

function setMainOption(csvImportId: string, patch: Partial<NestingOptions>): void {
  const csv = selectedCsv.value
  if (!csv) return
  const base = csv.runConfiguration.options
  void csvStore.updateRunConfiguration(csvImportId, {
    options: {
      ...base,
      ...patch,
      strategyIds: patch.strategyIds ?? base.strategyIds
    }
  })
}

function setMainAllowGlobalRotation(csvImportId: string, value: boolean): void {
  setMainOption(csvImportId, { allowGlobalRotation: value })
}

function setMainTimeoutMs(csvImportId: string, value: number): void {
  setMainOption(csvImportId, { timeoutMs: Math.max(1000, value) })
}

function setMainWorkerMode(csvImportId: string, value: NestingOptions['workerMode']): void {
  setMainOption(csvImportId, { workerMode: value })
}

function setMainStrategySelectionMode(
  csvImportId: string,
  value: 'single' | 'all_configured'
): void {
  setMainOption(csvImportId, { strategySelectionMode: value })
}

function toggleMainStrategyId(csvImportId: string, id: string): void {
  const csv = selectedCsv.value
  if (!csv) return
  const current = csv.runConfiguration.options.strategyIds
  const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id]
  setMainOption(csvImportId, { strategyIds: next })
}

function setMainStrategyIds(csvImportId: string, ids: string[]): void {
  setMainOption(csvImportId, { strategyIds: ids })
}

function onRun(csvImportId: string): void {
  emit('run-csv', csvImportId)
}

function onExport(csvImportId: string): void {
  emit('export-csv', csvImportId)
}

function openNextSubrunConfig(): void {
  const csv = selectedCsv.value
  if (!csv) return
  const cfg = csv.runConfiguration
  subrunConfig.open = true
  subrunConfig.width = cfg.defaultSheet.width
  subrunConfig.height = cfg.defaultSheet.height
  subrunConfig.label = cfg.defaultSheet.label
  subrunConfig.padding = cfg.padding
  subrunConfig.options = {
    allowGlobalRotation: cfg.options.allowGlobalRotation,
    timeoutMs: cfg.options.timeoutMs,
    workerMode: cfg.options.workerMode,
    historyMode: cfg.options.historyMode,
    historyScope: cfg.options.historyScope,
    strategySelectionMode: cfg.options.strategySelectionMode,
    strategyIds: [...cfg.options.strategyIds],
    layoutSelectionStrategyId: cfg.options.layoutSelectionStrategyId,
    finalSelectionMode: cfg.options.finalSelectionMode,
    ...(cfg.options.topN !== undefined ? { topN: cfg.options.topN } : {}),
    ...(cfg.options.maxHistoryEvents !== undefined
      ? { maxHistoryEvents: cfg.options.maxHistoryEvents }
      : {})
  }
}

function onNextSubrun(): void {
  openNextSubrunConfig()
}

function setSubrunWidth(value: number): void {
  subrunConfig.width = Math.max(1, Math.round(value))
  subrunConfig.label = `mother plate ${subrunConfig.width}x${subrunConfig.height}`
}

function setSubrunHeight(value: number): void {
  subrunConfig.height = Math.max(1, Math.round(value))
  subrunConfig.label = `mother plate ${subrunConfig.width}x${subrunConfig.height}`
}

function setSubrunPadding(value: number): void {
  subrunConfig.padding = Math.max(0, Math.round(value))
}

function patchSubrunOptions(patch: Partial<MutableSubrunOptions>): void {
  subrunConfig.options = { ...subrunConfig.options, ...patch }
}

function toggleSubrunStrategyId(id: string): void {
  const current = subrunConfig.options.strategyIds
  const next = current.includes(id) ? current.filter((s) => s !== id) : [...current, id]
  patchSubrunOptions({ strategyIds: next })
}

function setSubrunStrategyIds(ids: string[]): void {
  patchSubrunOptions({ strategyIds: ids })
}

function onStartSubrun(csvImportId: string): void {
  const sheet = new SheetSpec({
    width: subrunConfig.width,
    height: subrunConfig.height,
    label: subrunConfig.label
  })
  const options: NestingOptions = {
    ...subrunConfig.options,
    allowGlobalRotation: subrunConfig.options.allowGlobalRotation,
    timeoutMs: Math.max(1000, subrunConfig.options.timeoutMs),
    strategySelectionMode: subrunConfig.options.strategySelectionMode,
    strategyIds: [...subrunConfig.options.strategyIds]
  }
  emit('start-subrun', csvImportId, sheet, subrunConfig.padding, options)
  subrunConfig.open = false
}
</script>

<template>
  <div class="panel-content">
    <h2>CSV imports</h2>

    <div class="csv-actions-top">
      <button type="button" @click="void onImportCsv()">Import CSV</button>
      <button type="button" :disabled="selectedCsv === null" @click="void onRemoveSelected()">
        Remove selected
      </button>
      <button
        type="button"
        :disabled="csvStore.state.value.csvImports.length === 0"
        @click="void onClearAll()"
      >
        Clear all
      </button>
    </div>

    <ul class="csv-list">
      <li v-if="csvStore.state.value.csvImports.length === 0" class="empty">
        No imported CSVs yet.
      </li>
      <li
        v-for="csv in csvStore.state.value.csvImports"
        :key="csv.id"
        :class="{ active: csv.id === csvStore.state.value.selectedCsvId }"
        @click="onSelectCsv(csv.id)"
      >
        <span class="csv-name">{{ csv.fileName }}</span>
        <span class="csv-meta">
          {{ csv.materialCode }} · {{ csv.materialDescription }} · {{ csv.thicknessMm }}mm
          <template v-if="csv.jobDate">· {{ csv.jobDate }}</template>
        </span>
      </li>
    </ul>

    <div v-if="importFailures.length > 0" class="csv-import-warnings">
      <p class="warning">CSV import completed with warnings:</p>
      <ul class="failure-list">
        <li v-for="failure in importFailures" :key="failure.path">
          <strong>{{ failure.path }}</strong
          >: {{ failure.message }}
        </li>
      </ul>
    </div>

    <div v-if="selectedCsv" class="active-csv">
      <div class="csv-header">
        <strong>{{ selectedCsv.materialCode }}</strong>
        <span>{{ selectedCsv.materialDescription }}</span>
        <span class="csv-header-detail">{{ selectedCsv.thicknessMm }} mm</span>
        <span v-if="selectedCsv.jobDate" class="csv-header-detail">
          Job date: {{ selectedCsv.jobDate }}
        </span>
      </div>

      <div class="run-config-card">
        <h3>Main run configuration</h3>
        <p class="hint">Material and thickness come from the CSV.</p>
        <div class="grid">
          <label title="Mother plate width in millimeters.">
            Width (mm)
            <input
              type="number"
              min="1"
              step="1"
              :value="selectedCsv.runConfiguration.defaultSheet.width"
              @input="setMainSheetWidth(selectedCsv.id, Number(inputValue($event)))"
            />
          </label>
          <label title="Mother plate height in millimeters.">
            Height (mm)
            <input
              type="number"
              min="1"
              step="1"
              :value="selectedCsv.runConfiguration.defaultSheet.height"
              @input="setMainSheetHeight(selectedCsv.id, Number(inputValue($event)))"
            />
          </label>
          <label class="span-2" title="Auto-generated sheet label.">
            Label
            <input type="text" :value="selectedCsv.runConfiguration.defaultSheet.label" readonly />
          </label>
          <label title="Total integer clearance around each source shape.">
            Padding (mm)
            <input
              type="number"
              min="0"
              step="1"
              :value="selectedCsv.runConfiguration.padding"
              @input="setMainPadding(selectedCsv.id, Number(inputValue($event)))"
            />
          </label>
          <label title="Allows candidate generation to try rotated placements.">
            Allow rotation
            <input
              type="checkbox"
              :checked="selectedCsv.runConfiguration.options.allowGlobalRotation"
              @change="setMainAllowGlobalRotation(selectedCsv.id, inputChecked($event))"
            />
          </label>
          <label title="Maximum worker runtime before the job is reported as timed out.">
            Timeout (ms)
            <input
              type="number"
              min="1000"
              step="1000"
              :value="selectedCsv.runConfiguration.options.timeoutMs"
              @input="setMainTimeoutMs(selectedCsv.id, Number(inputValue($event)))"
            />
          </label>
          <label title="Selects the worker engine for this CSV run.">
            Engine
            <select
              :value="selectedCsv.runConfiguration.options.workerMode"
              @change="
                setMainWorkerMode(
                  selectedCsv.id,
                  selectValue($event) as NestingOptions['workerMode']
                )
              "
            >
              <option value="maxrects-beam-search">MaxRects beam</option>
              <option value="irregular-convex-v2">Irregular convex</option>
            </select>
          </label>
          <label class="span-2 full" title="Single runs only the checked strategy IDs.">
            Candidate set
            <select
              :value="selectedCsv.runConfiguration.options.strategySelectionMode"
              @change="
                setMainStrategySelectionMode(
                  selectedCsv.id,
                  selectValue($event) as 'single' | 'all_configured'
                )
              "
            >
              <option value="single">Checked only</option>
              <option value="all_configured">All candidate orders</option>
            </select>
          </label>
        </div>
        <div class="section-actions">
          <p class="hint">Selected ids feed one beam run.</p>
          <button
            type="button"
            :disabled="
              allStrategyIds.length === 0 ||
              selectedCsv.runConfiguration.options.strategyIds.length === allStrategyIds.length
            "
            @click="setMainStrategyIds(selectedCsv.id, allStrategyIds)"
          >
            All
          </button>
          <button
            type="button"
            :disabled="selectedCsv.runConfiguration.options.strategyIds.length === 0"
            @click="setMainStrategyIds(selectedCsv.id, [])"
          >
            None
          </button>
        </div>
        <ul class="strategy-list">
          <li v-for="strategy in STRATEGY_DEFINITIONS" :key="strategy.id">
            <label class="strategy-row">
              <input
                type="checkbox"
                :disabled="
                  selectedCsv.runConfiguration.options.strategySelectionMode === 'all_configured'
                "
                :checked="selectedCsv.runConfiguration.options.strategyIds.includes(strategy.id)"
                @change="toggleMainStrategyId(selectedCsv.id, strategy.id)"
              />
              <span class="strategy-meta" :title="strategy.description">
                <strong>{{ strategy.label }}</strong>
                <code class="muted">{{ strategy.id }}</code>
                <small>{{ strategy.description }}</small>
              </span>
            </label>
          </li>
        </ul>
      </div>

      <h3>CUT rows</h3>
      <p class="hint">Import DXFs or presets first, then pick the matching source shape per row.</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th title="Quantity required for this reference.">Qty</th>
              <th title="Customer name from the CSV.">Customer</th>
              <th title="Raw packslip and position reference.">Reference</th>
              <th title="Source shape from the shared project library.">Source shape</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="selectedCsv.rows.length === 0">
              <td colspan="4" class="empty">No CUT rows in this CSV.</td>
            </tr>
            <tr v-for="row in selectedCsv.rows" :key="row.id">
              <td>{{ row.amount }}</td>
              <td>{{ row.customerName }}</td>
              <td>{{ row.reference }}</td>
              <td>
                <select
                  :value="row.linkedPieceId ?? ''"
                  @change="void onLinkRow(selectedCsv.id, row.id, selectValue($event) as PieceId)"
                >
                  <option value="">Select shape...</option>
                  <option
                    v-for="piece in appStore.state.value.pieces"
                    :key="piece.id"
                    :value="piece.id"
                  >
                    {{ piece.label }} ({{ piece.realBounds.width }}×{{ piece.realBounds.height }})
                  </option>
                </select>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!allRowsLinked" class="warning">
        Every CUT row must be linked to a source shape before running.
      </p>

      <div class="csv-actions-bottom">
        <button type="button" :disabled="!canRun" @click="onRun(selectedCsv.id)">Run</button>
        <button type="button" :disabled="!canExport" @click="onExport(selectedCsv.id)">
          Export Result
        </button>
        <button v-if="canNextSubrun" type="button" @click="onNextSubrun">Next subrun</button>
      </div>

      <div v-if="subrunConfig.open" class="subrun-config-card">
        <h3>Subrun configuration</h3>
        <p class="hint">Configure the next mother plate for leftover pieces.</p>
        <div class="grid">
          <label title="Mother plate width in millimeters for the next subrun.">
            Width (mm)
            <input
              type="number"
              min="1"
              step="1"
              :value="subrunConfig.width"
              @input="setSubrunWidth(Number(inputValue($event)))"
            />
          </label>
          <label title="Mother plate height in millimeters for the next subrun.">
            Height (mm)
            <input
              type="number"
              min="1"
              step="1"
              :value="subrunConfig.height"
              @input="setSubrunHeight(Number(inputValue($event)))"
            />
          </label>
          <label class="span-2" title="Auto-generated sheet label.">
            Label
            <input type="text" :value="subrunConfig.label" readonly />
          </label>
          <label title="Total integer clearance around each source shape for this subrun.">
            Padding (mm)
            <input
              type="number"
              min="0"
              step="1"
              :value="subrunConfig.padding"
              @input="setSubrunPadding(Number(inputValue($event)))"
            />
          </label>
          <label title="Allows candidate generation to try rotated placements.">
            Allow rotation
            <input
              type="checkbox"
              :checked="subrunConfig.options.allowGlobalRotation"
              @change="patchSubrunOptions({ allowGlobalRotation: inputChecked($event) })"
            />
          </label>
          <label title="Maximum worker runtime before the job is reported as timed out.">
            Timeout (ms)
            <input
              type="number"
              min="1000"
              step="1000"
              :value="subrunConfig.options.timeoutMs"
              @input="patchSubrunOptions({ timeoutMs: Math.max(1000, Number(inputValue($event))) })"
            />
          </label>
          <label title="Selects the worker engine for this subrun.">
            Engine
            <select
              :value="subrunConfig.options.workerMode"
              @change="
                patchSubrunOptions({
                  workerMode: selectValue($event) as NestingOptions['workerMode']
                })
              "
            >
              <option value="maxrects-beam-search">MaxRects beam</option>
              <option value="irregular-convex-v2">Irregular convex</option>
            </select>
          </label>
          <label class="span-2 full" title="Single runs only the checked strategy IDs.">
            Candidate set
            <select
              :value="subrunConfig.options.strategySelectionMode"
              @change="
                patchSubrunOptions({
                  strategySelectionMode: selectValue($event) as 'single' | 'all_configured'
                })
              "
            >
              <option value="single">Checked only</option>
              <option value="all_configured">All candidate orders</option>
            </select>
          </label>
        </div>
        <div class="section-actions">
          <p class="hint">Selected ids feed one beam run.</p>
          <button
            type="button"
            :disabled="
              allStrategyIds.length === 0 ||
              subrunConfig.options.strategyIds.length === allStrategyIds.length
            "
            @click="setSubrunStrategyIds(allStrategyIds)"
          >
            All
          </button>
          <button
            type="button"
            :disabled="subrunConfig.options.strategyIds.length === 0"
            @click="setSubrunStrategyIds([])"
          >
            None
          </button>
        </div>
        <ul class="strategy-list">
          <li v-for="strategy in STRATEGY_DEFINITIONS" :key="strategy.id">
            <label class="strategy-row">
              <input
                type="checkbox"
                :disabled="subrunConfig.options.strategySelectionMode === 'all_configured'"
                :checked="subrunConfig.options.strategyIds.includes(strategy.id)"
                @change="toggleSubrunStrategyId(strategy.id)"
              />
              <span class="strategy-meta" :title="strategy.description">
                <strong>{{ strategy.label }}</strong>
                <code class="muted">{{ strategy.id }}</code>
                <small>{{ strategy.description }}</small>
              </span>
            </label>
          </li>
        </ul>
        <div class="subrun-actions">
          <button
            type="button"
            :disabled="subrunConfig.width <= 0 || subrunConfig.height <= 0"
            @click="onStartSubrun(selectedCsv.id)"
          >
            Start subrun
          </button>
          <button type="button" @click="subrunConfig.open = false">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
  height: 100%;
}

h2,
h3 {
  margin: 12px 0 4px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.csv-actions-top {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.csv-actions-top button {
  font-size: 11px;
  padding: 2px 6px;
}

.csv-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
  max-height: 160px;
}

.csv-list li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  cursor: pointer;
  border: 1px solid transparent;
}

.csv-list li.active {
  border-color: var(--text-secondary);
}

.csv-list li.empty {
  background: transparent;
  color: var(--text-muted);
  cursor: default;
  text-align: center;
  padding: 12px;
}

.csv-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.csv-meta {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.active-csv {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
  min-height: 0;
}

.csv-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  font-size: 12px;
}

.csv-header strong {
  color: var(--text-primary);
  font-size: 13px;
}

.csv-header-detail {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.run-config-card,
.subrun-config-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
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

.strategy-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 140px;
  overflow: auto;
}

.strategy-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  padding: 4px 6px;
  border-radius: var(--radius);
  background: var(--bg-panel);
}

.strategy-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
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

.table-wrap {
  overflow: auto;
  max-height: 240px;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

th,
td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

th {
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-panel);
  position: sticky;
  top: 0;
}

td {
  color: var(--text-primary);
  font-family: var(--font-mono);
}

td select {
  font-size: 11px;
}

.empty {
  color: var(--text-muted);
  text-align: center;
  padding: 12px;
}

.csv-actions-bottom,
.subrun-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.csv-actions-bottom button:first-child,
.subrun-actions button:first-child {
  margin-right: auto;
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

.csv-import-warnings {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.failure-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.failure-list li {
  word-break: break-word;
}

.muted {
  color: var(--text-muted);
}
</style>
