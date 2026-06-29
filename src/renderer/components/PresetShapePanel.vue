<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useAppStore } from '../composables/useAppStore.js'
import { makePresetShapeDocument, type PresetShapeKind } from '@shared/presetShapes.js'

interface ShapeOption {
  readonly kind: PresetShapeKind
  readonly label: string
}

const store = useAppStore()

const options: ReadonlyArray<ShapeOption> = [
  { kind: 'rectangle', label: 'Rectangle' },
  { kind: 'square', label: 'Square' },
  { kind: 'circle', label: 'Circle' },
  { kind: 'triangle', label: 'Triangle' },
  { kind: 'pentagon', label: 'Pentagon' },
  { kind: 'hexagon', label: 'Hexagon' },
  { kind: 'star', label: 'Star' }
]

const form = reactive({
  kind: 'rectangle' as PresetShapeKind,
  width: 100,
  height: 60,
  label: ''
})

const primaryDimensionLabel = computed(() => (form.kind === 'circle' ? 'Diameter' : 'Width'))
const secondaryDimensionLabel = computed(() => {
  if (form.kind === 'circle') return 'Diameter'
  if (form.kind === 'triangle') return 'Height'
  return 'Height'
})

const locksHeight = computed(() => form.kind === 'square' || form.kind === 'circle')

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ''
}

function selectValue(event: Event): string {
  return event.target instanceof HTMLSelectElement ? event.target.value : ''
}

function setKind(event: Event): void {
  form.kind = selectValue(event) as PresetShapeKind
  if (locksHeight.value) {
    form.height = form.width
  }
}

function setWidth(value: number): void {
  form.width = Math.max(1, Math.round(value))
  if (locksHeight.value) {
    form.height = form.width
  }
}

function setHeight(value: number): void {
  form.height = Math.max(1, Math.round(value))
}

function addPreset(): void {
  const document = makePresetShapeDocument({
    kind: form.kind,
    width: form.width,
    height: locksHeight.value ? form.width : form.height,
    label: form.label
  })
  store.appendPresetDocument(document)
}
</script>

<template>
  <div class="preset-panel">
    <label title="Parametric shape inserted as one source object in the cut list.">
      Shape
      <select :value="form.kind" @change="setKind">
        <option v-for="option in options" :key="option.kind" :value="option.kind">
          {{ option.label }}
        </option>
      </select>
    </label>

    <div class="dimension-row">
      <label :title="`${primaryDimensionLabel} in integer millimeters.`">
        {{ primaryDimensionLabel }}
        <input
          type="number"
          min="1"
          step="1"
          :value="form.width"
          @input="setWidth(Number(inputValue($event)))"
        />
      </label>
      <label :title="`${secondaryDimensionLabel} in integer millimeters.`">
        {{ secondaryDimensionLabel }}
        <input
          type="number"
          min="1"
          step="1"
          :disabled="locksHeight"
          :value="locksHeight ? form.width : form.height"
          @input="setHeight(Number(inputValue($event)))"
        />
      </label>
    </div>

    <label class="label" title="Optional source label shown in the cut list.">
      Label
      <input
        type="text"
        :placeholder="`${form.kind} ${form.width}x${locksHeight ? form.width : form.height}`"
        :value="form.label"
        @input="form.label = inputValue($event)"
      />
    </label>

    <button type="button" title="Add this preset as a reusable source shape." @click="addPreset">
      Add preset
    </button>
  </div>
</template>

<style scoped>
.preset-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.dimension-row {
  display: grid;
  min-width: 0;
  gap: 8px;
}

.dimension-row {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.preset-panel label {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
}

.preset-panel input,
.preset-panel select {
  width: 100%;
  min-width: 0;
}

.label {
  display: flex;
}

button {
  width: 100%;
}
</style>
