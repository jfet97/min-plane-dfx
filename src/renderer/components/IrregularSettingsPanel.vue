<script setup lang="ts">
import { computed } from 'vue'
import {
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
  DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS,
  IrregularGeometrySettings,
  IrregularNestingSettings,
  IrregularOptimizerSettings,
  type IrregularPlacementPolicyId
} from '@shared/irregular/domain.js'
import {
  makeCompactQualityIrregularOptimizerSettings,
  makeDefaultIrregularNestingSettings
} from '@shared/irregular/defaults.js'
import type { NestingOptions } from '@shared/domain/nesting.js'

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
const placementPolicyIds = computed(
  () => optimizer.value.placementPolicyIds ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS
)
const placementPolicyId = computed(
  () => optimizer.value.placementPolicyId ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
)
const portfolioEnabled = computed(() => optimizer.value.gaEnabled && !optimizer.value.baselineOnly)
const localRepairEnabled = computed(() => (optimizer.value.localRepairBudget ?? 0) > 0)
const configuredRotationsText = computed(() => optimizer.value.configuredRotationDeg.join(', '))
const portfolioMayExceedTimeout = computed(
  () => portfolioEnabled.value && optimizer.value.gaTimeBudgetMs >= props.timeoutMs
)
const transformCapHelp = computed(() => {
  const cap = optimizer.value.transformCap
  if (cap === 1) return 'Identity only: 0°. The rotation and mirror gates cannot add another transform.'
  if (cap < 4) return `Keeps the first ${cap} quarter-turns: 0°${cap >= 2 ? ', 90°' : ''}${cap >= 3 ? ', 180°' : ''}.`
  if (cap === 4) return 'Uses the four quarter-turns: 0°, 90°, 180°, and 270°.'
  return `Uses the four quarter-turns, then up to ${cap - 4} explicit or edge-derived orientations.`
})
const reorderWindowHelp = computed(() => {
  const window = optimizer.value.orderWindow
  if (window === 1) return 'Uses the supplied priority order without reordering pieces.'
  return `May choose among the next ${window} unplaced pieces at each step.`
})
const beamWidthHelp = computed(() => {
  const width = optimizer.value.beamWidth
  if (width === 1) return 'Greedy: keeps only one partial layout after each step.'
  return `Keeps the best ${width} partial layouts after each expansion.`
})
const localCandidateFanoutHelp = computed(
  () => `Keeps up to ${optimizer.value.localCandidateFanout} legal contact positions per piece before beam pruning.`
)
const localRepairHelp = computed(() => {
  const budget = optimizer.value.localRepairBudget ?? 0
  if (budget === 0) return 'Disabled. The terminal beam result is returned unchanged.'
  return `Runs up to ${budget} deterministic remove-and-reinsert improvements after the beam completes.`
})

const MIN_FLATTENING_SAG_TOLERANCE_MM = 0.001

type GeometryNumericField = 'flatteningSagToleranceMm' | 'clearanceSafetyMarginMm'

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ''
}

function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : ''
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
  replaceOptimizer(makeCompactQualityIrregularOptimizerSettings())
}

function setLocalRepairEnabled(enabled: boolean): void {
  updateOptimizer({ localRepairBudget: enabled ? 8 : 0 })
}

function setPortfolioEnabled(enabled: boolean): void {
  updateOptimizer({ gaEnabled: enabled, baselineOnly: !enabled })
}

function setConfiguredRotations(event: Event): void {
  const rotations = inputValue(event)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value))
  updateOptimizer({ configuredRotationDeg: rotations })
}

function togglePolicy(policyId: IrregularPlacementPolicyId): void {
  const nextPolicyIds = placementPolicyIds.value.includes(policyId)
    ? placementPolicyIds.value.filter((value) => value !== policyId)
    : [...placementPolicyIds.value, policyId]
  if (nextPolicyIds.length === 0) return

  const nextPlacementPolicyId = nextPolicyIds.includes(placementPolicyId.value)
    ? placementPolicyId.value
    : nextPolicyIds[0]
  if (nextPlacementPolicyId === undefined) return
  updateOptimizer({ placementPolicyIds: nextPolicyIds, placementPolicyId: nextPlacementPolicyId })
}

</script>

<template>
  <section class="irregular-settings">
    <div class="mode-summary">
      <strong>Convex polygon nesting</strong>
      <p>
        Uses source outlines to build conservative convex collision polygons. The geometry, beam,
        and portfolio controls below apply only to this algorithm.
      </p>
      <button
        type="button"
        title="Apply the measured compact-search preset for small repeated-shape jobs. This replaces the optimizer settings below."
        @click="useCompactQualityProfile"
      >
        Apply compact preset
      </button>
      <p class="field-help">Sets reorder 4, beam 8, fanout 4, repair 8, transform cap 8, and edge contact.</p>
    </div>

    <h3 title="Controls how source curves and padding become conservative collision geometry.">Geometry</h3>
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
        <span class="field-help">Smaller follows curves more closely but creates more polygon vertices.</span>
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
        <span class="field-help">Extra outward buffer after half of the total cutting padding.</span>
      </label>
    </div>

    <h3 title="The deterministic baseline explores several partial layouts and retains only the best ones.">Deterministic beam</h3>
    <div class="grid">
      <label
        title="How many remaining pieces each beam state may reorder at one decision point. Higher values branch more heavily."
      >
        Reorder window
        <input
          type="number"
          min="1"
          step="1"
          :value="optimizer.orderWindow"
          @input="updateOptimizer({ orderWindow: Number(inputValue($event)) })"
        />
        <span class="field-help">{{ reorderWindowHelp }}</span>
      </label>
      <label
        title="How many partial layouts survive each beam expansion. Higher values improve search breadth but can become expensive quickly."
      >
        Beam width
        <input
          type="number"
          min="1"
          step="1"
          :value="optimizer.beamWidth"
          @input="updateOptimizer({ beamWidth: Number(inputValue($event)) })"
        />
        <span class="field-help">{{ beamWidthHelp }}</span>
      </label>
      <label
        title="How many legal local placements are retained per selected piece before whole-layout beam scoring."
      >
        Local candidate fanout
        <input
          type="number"
          min="1"
          step="1"
          :value="optimizer.localCandidateFanout"
          @input="updateOptimizer({ localCandidateFanout: Number(inputValue($event)) })"
        />
        <span class="field-help">{{ localCandidateFanoutHelp }}</span>
      </label>
      <label
        class="checkbox-row span-2"
        title="Run deterministic remove-and-reinsert improvements after the beam completes."
      >
        <input
          type="checkbox"
          :checked="localRepairEnabled"
          @change="setLocalRepairEnabled(inputChecked($event))"
        />
        Enable local repair
      </label>
      <label
        title="Maximum deterministic terminal repair iterations. Each iteration tries to remove and legally reinsert one placed piece."
      >
        Local repair budget
        <input
          type="number"
          min="1"
          step="1"
          :disabled="!localRepairEnabled"
          :value="optimizer.localRepairBudget ?? 0"
          @input="updateOptimizer({ localRepairBudget: Number(inputValue($event)) })"
        />
        <span class="field-help">{{ localRepairHelp }}</span>
      </label>
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
      <label
        title="Ignores source edges shorter than this length when deriving useful rotation angles."
      >
        Minimum edge (mm)
        <input
          type="number"
          min="0"
          step="0.1"
          :value="optimizer.transformMinimumEdgeLengthMm"
          @input="updateOptimizer({ transformMinimumEdgeLengthMm: Number(inputValue($event)) })"
        />
        <span class="field-help">Shorter edges do not contribute derived angle candidates.</span>
      </label>
      <label title="Treats derived angles within this number of degrees as the same orientation.">
        Angle dedupe (deg)
        <input
          type="number"
          min="0.001"
          step="0.01"
          :value="optimizer.transformAngleDeduplicationToleranceDeg"
          @input="
            updateOptimizer({ transformAngleDeduplicationToleranceDeg: Number(inputValue($event)) })
          "
        />
        <span class="field-help">Larger values merge nearly equal derived angles and reduce work.</span>
      </label>
    </div>

    <details>
      <summary title="Adds non-quarter-turn orientations after the Transform cap has room beyond four.">Additional rotations</summary>
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

    <h3 title="Ranks legal contact positions for one piece before the beam compares whole partial layouts.">Local candidate scoring</h3>
    <div class="grid">
      <label
        title="The one policy used by the deterministic beam. GA uses this only when policy mutation is disabled."
      >
        Deterministic beam policy
        <select
          :value="placementPolicyId"
          @change="
            updateOptimizer({
              placementPolicyId: selectValue($event) as IrregularPlacementPolicyId
            })
          "
        >
          <option value="balanced-compactness">Balanced compactness</option>
          <option value="short-side-fill">Short-side fill</option>
          <option value="edge-contact-then-balanced-compactness">Edge contact, then compactness</option>
        </select>
      </label>
      <div class="policy-list" title="Policies that an enabled GA may choose among as chromosome values.">
        <span>GA policy options</span>
        <small class="field-help">
          {{ portfolioEnabled ? 'GA may try any checked policy.' : 'Enable GA portfolio search to use these.' }}
        </small>
        <label
          v-for="policyId in DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS"
          :key="policyId"
          class="checkbox-row"
        >
          <input
            type="checkbox"
            :checked="placementPolicyIds.includes(policyId)"
            :disabled="!portfolioEnabled"
            @change="togglePolicy(policyId)"
          />
          {{
            policyId === 'balanced-compactness'
              ? 'Balanced compactness'
              : policyId === 'short-side-fill'
                ? 'Short-side fill'
                : 'Edge contact, then compactness'
          }}
        </label>
      </div>
    </div>

    <h3 title="Runs a bounded genetic search after the deterministic beam and keeps only a better legal layout.">Portfolio search</h3>
    <label
      class="checkbox-row"
      title="After the deterministic result, evaluates seeded genetic-search alternatives. This can take much longer."
    >
      <input
        type="checkbox"
        :checked="portfolioEnabled"
        @change="setPortfolioEnabled(inputChecked($event))"
      />
      Enable GA portfolio after the deterministic beam
    </label>
    <p v-if="portfolioEnabled" class="field-help">
      The GA starts from the beam result. Generation, evaluation, and time budgets are independent stop limits; the first one reached ends it.
    </p>
    <p v-if="portfolioMayExceedTimeout" class="warning">
      The GA time budget is at least as long as the worker timeout. Increase the job timeout or
      lower the GA time budget to avoid an intentional worker timeout.
    </p>
    <div v-if="portfolioEnabled" class="grid">
      <label title="Number of chromosomes in each GA generation.">
        Population
        <input
          type="number"
          min="1"
          step="1"
          :value="optimizer.gaPopulation"
          @input="updateOptimizer({ gaPopulation: Number(inputValue($event)) })"
        />
      </label>
      <label title="Maximum generated populations after the deterministic baseline.">
        Generation budget
        <input
          type="number"
          min="0"
          step="1"
          :value="optimizer.gaGenerationBudget"
          @input="updateOptimizer({ gaGenerationBudget: Number(inputValue($event)) })"
        />
      </label>
      <label title="Maximum total chromosome decodes across every generation.">
        Evaluation budget
        <input
          type="number"
          min="0"
          step="1"
          :value="optimizer.gaEvaluationBudget"
          @input="updateOptimizer({ gaEvaluationBudget: Number(inputValue($event)) })"
        />
      </label>
      <label
        title="Wall-clock budget for GA evaluations only. The whole worker is still bounded by the job timeout."
      >
        GA time budget (ms)
        <input
          type="number"
          min="0"
          step="1000"
          :value="optimizer.gaTimeBudgetMs"
          @input="updateOptimizer({ gaTimeBudgetMs: Number(inputValue($event)) })"
        />
      </label>
      <label class="span-2" title="Stable seed for reproducible portfolio experiments.">
        Seed
        <input
          type="text"
          :value="optimizer.gaSeed"
          @change="updateOptimizer({ gaSeed: inputValue($event) })"
        />
      </label>
      <label class="checkbox-row" title="Lets GA mutate the piece priority order.">
        <input
          type="checkbox"
          :checked="optimizer.priorityOrderMutationEnabled"
          @change="updateOptimizer({ priorityOrderMutationEnabled: inputChecked($event) })"
        />
        Mutate piece order
      </label>
      <label class="checkbox-row" title="Lets GA prefer different orientation candidates.">
        <input
          type="checkbox"
          :checked="optimizer.transformPreferenceMutationEnabled"
          @change="updateOptimizer({ transformPreferenceMutationEnabled: inputChecked($event) })"
        />
        Mutate transform preference
      </label>
      <label
        class="checkbox-row"
        title="Lets GA select among the enabled local candidate policies."
      >
        <input
          type="checkbox"
          :checked="optimizer.placementPolicyMutationEnabled"
          @change="updateOptimizer({ placementPolicyMutationEnabled: inputChecked($event) })"
        />
        Mutate scoring policy
      </label>
    </div>
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
