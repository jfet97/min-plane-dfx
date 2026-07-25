<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularOptimizerSettings
} from '@shared/irregular/domain.js'
import { makeDefaultIrregularNestingSettings } from '@shared/irregular/defaults.js'
import type { NestingOptions } from '@shared/domain/nesting.js'
import {
  applyCompactQualityPreset,
  irregularSettingsUiState
} from '../utils/irregularSettingsUi.js'

const props = defineProps<{
  settings?: NestingOptions['irregularSettings']
  timeoutMs: number
}>()

const emit = defineEmits<{
  update: [settings: IrregularNestingSettings]
}>()

const currentSettings = computed(() => props.settings ?? makeDefaultIrregularNestingSettings())
const optimizer = computed(() => currentSettings.value.optimizer)
const geometry = computed(() => currentSettings.value.geometry)
const uiState = computed(() => irregularSettingsUiState(currentSettings.value))
const compactArchiveActive = computed(
  () =>
    uiState.value.mode === 'compact-shared-archive' ||
    uiState.value.mode === 'compact-short-side'
)
const shortSideProfileActive = computed(() => uiState.value.mode === 'compact-short-side')
const configuredRotationsText = computed(() => optimizer.value.configuredRotationDeg.join(', '))
const transformCapHelp = computed(() => {
  const cap = optimizer.value.transformCap
  if (cap === 1)
    return 'Identity only: 0°. The rotation and mirror gates cannot add another transform.'
  if (cap < 4)
    return `Keeps the first ${cap} quarter-turns: 0°${cap >= 2 ? ', 90°' : ''}${cap >= 3 ? ', 180°' : ''}.`
  if (cap === 4) return 'Uses the four quarter-turns: 0°, 90°, 180°, and 270°.'
  return `Uses the four quarter-turns, then up to ${cap - 4} explicit or edge-derived orientations.`
})
const MIN_FLATTENING_SAG_TOLERANCE_MM = 0.001

type GeometryNumericField = 'flatteningSagToleranceMm' | 'clearanceSafetyMarginMm'

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ''
}

function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false
}

function updateGeometry(patch: Partial<IrregularGeometrySettings>): void {
  emit(
    'update',
    new IrregularNestingSettings({
      geometry: new IrregularGeometrySettings({ ...geometry.value, ...patch }),
      optimizer: optimizer.value
    })
  )
}

function updateGeometryField(field: GeometryNumericField, event: Event): void {
  const rawValue = inputValue(event).trim()
  if (rawValue === '') return

  const requestedValue = Number(rawValue)
  if (!Number.isFinite(requestedValue)) return

  const nextSagTolerance =
    field === 'flatteningSagToleranceMm'
      ? Math.max(MIN_FLATTENING_SAG_TOLERANCE_MM, requestedValue)
      : geometry.value.flatteningSagToleranceMm
  const nextClearance =
    field === 'clearanceSafetyMarginMm'
      ? Math.max(nextSagTolerance, requestedValue)
      : Math.max(geometry.value.clearanceSafetyMarginMm, nextSagTolerance)

  updateGeometry({
    flatteningSagToleranceMm: nextSagTolerance,
    clearanceSafetyMarginMm: nextClearance
  })
}

function updateOptimizer(patch: Partial<IrregularOptimizerSettings>): void {
  replaceOptimizer(new IrregularOptimizerSettings({ ...optimizer.value, ...patch }))
}

function replaceOptimizer(nextOptimizer: IrregularOptimizerSettings): void {
  emit(
    'update',
    new IrregularNestingSettings({
      geometry: geometry.value,
      optimizer: nextOptimizer
    })
  )
}

function useCompactQualityProfile(): void {
  emit('update', applyCompactQualityPreset(currentSettings.value))
}

function updateObjectiveProfile(event: Event): void {
  updateOptimizer({
    intrinsicObjectiveProfileId:
      inputValue(event) === 'short-side' ? 'short-side' : 'compact'
  })
}

function setConfiguredRotations(event: Event): void {
  const rotations = inputValue(event)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value))
  updateOptimizer({ configuredRotationDeg: rotations })
}

watch(
  currentSettings,
  (settings) => {
    if (irregularSettingsUiState(settings).mode === 'legacy-requires-migration') {
      useCompactQualityProfile()
    }
  },
  { immediate: true }
)
</script>

<template>
  <section class="irregular-settings">
    <div class="mode-summary compact-active">
      <div class="mode-heading">
        <strong>Convex polygon nesting</strong>
        <span class="mode-badge">
          {{ shortSideProfileActive ? 'Compact · Short Side' : 'Compact · shared archive' }}
        </span>
      </div>
      <p>
        {{
          shortSideProfileActive
            ? 'Builds Compact first, then runs one bounded exact Short Side selector inside the same worker. If it has no legal improvement, Compact remains the result.'
            : 'Builds and ranks complete layouts in one sheet-independent shared archive. Requested-sheet fit at 0° or 90° is applied afterward.'
        }}
      </p>
      <p v-if="!compactArchiveActive" class="warning">
        Updating saved legacy settings to the current Compact profile.
      </p>
      <p class="field-help">
        Shared archive on · GA off · one sequential algorithm worker. Only objective, geometry,
        and orientation controls affect this production path.
      </p>
    </div>

    <h3 title="Selects the terminal objective after the protected Compact archive has settled.">
      Objective
    </h3>
    <div class="grid">
      <label
        title="Compact keeps the settled sheet-independent winner. Short Side retains that construction, then selects an admitted legal directional layout or honestly falls back to Compact."
      >
        Compact profile
        <select
          :value="optimizer.intrinsicObjectiveProfileId"
          @change="updateObjectiveProfile"
        >
          <option value="compact">Compact</option>
          <option value="short-side">Compact · Short Side</option>
        </select>
        <span class="field-help">
          Short Side is sheet-aware only at its final bounded selector; it does not change the
          protected Compact constructor or start another worker.
        </span>
      </label>
    </div>

    <h3 title="Controls how source curves and padding become conservative collision geometry.">
      Geometry
    </h3>
    <div class="grid">
      <label
        title="Maximum inward curve approximation error in millimeters while flattening DXF arcs and ellipses."
      >
        Curve sag tolerance (mm)
        <input
          type="number"
          min="0.001"
          step="0.01"
          :value="geometry.flatteningSagToleranceMm"
          @input="updateGeometryField('flatteningSagToleranceMm', $event)"
        />
        <span class="field-help"
          >Smaller follows curves more closely but creates more polygon vertices.</span
        >
      </label>
      <label
        title="Extra conservative clearance added after flattening; it must be at least the sag tolerance."
      >
        Safety margin (mm)
        <input
          type="number"
          :min="geometry.flatteningSagToleranceMm"
          step="0.01"
          :value="geometry.clearanceSafetyMarginMm"
          @input="updateGeometryField('clearanceSafetyMarginMm', $event)"
        />
        <span class="field-help"
          >Extra outward buffer after half of the total cutting padding.</span
        >
      </label>
    </div>

    <h3 title="Controls the finite orientations available to both irregular execution paths.">
      Orientations
    </h3>
    <div class="grid">
      <label
        title="Maximum orientation candidates generated for one prepared polygon. Cap 4 covers the four quarter-turns; larger caps also admit explicit and edge-derived angles."
      >
        Transform cap
        <input
          type="number"
          min="1"
          step="1"
          :value="optimizer.transformCap"
          @input="updateOptimizer({ transformCap: Number(inputValue($event)) })"
        />
        <span class="field-help">{{ transformCapHelp }}</span>
      </label>
    </div>

    <details>
      <summary
        title="Adds non-quarter-turn orientations after the Transform cap has room beyond four."
      >
        Additional rotations
      </summary>
      <div class="grid details-grid">
        <label
          class="span-2"
          title="Adds comma-separated degrees to the orthogonal and edge-derived transform choices."
        >
          Explicit angles (deg)
          <input
            type="text"
            :value="configuredRotationsText"
            placeholder="e.g. 15, 30, 45"
            @change="setConfiguredRotations"
          />
        </label>
        <label
          class="checkbox-row"
          title="Turns the explicit angle list on or off without deleting it."
        >
          <input
            type="checkbox"
            :checked="optimizer.configuredRotationEnabled"
            @change="updateOptimizer({ configuredRotationEnabled: inputChecked($event) })"
          />
          Use explicit angles
        </label>
        <label
          class="checkbox-row"
          title="Adds angles that align each usable convex-polygon edge with the sheet axes. They are considered only when Transform cap is greater than 4."
        >
          <input
            type="checkbox"
            :checked="optimizer.edgeAlignmentEnabled"
            @change="updateOptimizer({ edgeAlignmentEnabled: inputChecked($event) })"
          />
          Use edge-derived angles
        </label>
      </div>
    </details>

  </section>
</template>

<style scoped>
.irregular-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 12px 0 4px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.mode-summary {
  display: grid;
  gap: 5px;
  padding: 8px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 80%, #174d63 20%);
}

.mode-summary.compact-active {
  border-color: color-mix(in srgb, var(--border) 55%, #43a6bd 45%);
  background: color-mix(in srgb, var(--panel) 72%, #13576b 28%);
}

.mode-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mode-badge {
  padding: 2px 5px;
  border: 1px solid var(--border);
  border-radius: 2px;
  color: var(--text-secondary);
  font-size: 9px;
  line-height: 1.2;
  text-transform: uppercase;
  letter-spacing: 0.35px;
}

.compact-active .mode-badge {
  border-color: color-mix(in srgb, var(--border) 45%, #57bdd1 55%);
  color: var(--text-primary);
}

.mode-summary p,
.warning {
  margin: 0;
  font-size: 11px;
  line-height: 1.35;
}

.mode-summary button {
  justify-self: start;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.span-2 {
  grid-column: span 2;
}

label,
.policy-list {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
}

.field-help {
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 1.2;
}

input,
select {
  width: 100%;
  min-width: 0;
  font-size: 12px;
}

.checkbox-row {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.checkbox-row input {
  width: auto;
}

.policy-list {
  gap: 4px;
}

details {
  border-left: 2px solid var(--border);
  padding-left: 8px;
}

summary {
  cursor: pointer;
  font-size: 11px;
}

.details-grid {
  margin-top: 6px;
}
</style>
