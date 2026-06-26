<script setup lang="ts">
import { useHistoryStore } from '../composables/useHistoryStore.js'

const history = useHistoryStore()

function onSliderInput(event: Event): void {
  const target = event.target as HTMLInputElement
  const value = Number(target.value)
  history.selectFrameIndex(value)
}

function onSpeedChange(event: Event): void {
  const target = event.target as HTMLInputElement
  history.setSpeed(Number(target.value))
}
</script>

<template>
  <div class="timeline">
    <header class="head">
      <h2>History timeline</h2>
      <div class="run-label" v-if="history.selectedRun.value">
        <span class="muted">Run:</span>
        <strong>{{ history.selectedRun.value.strategyLabel }}</strong>
        <code class="muted">({{ history.selectedRun.value.strategyId }})</code>
      </div>
    </header>

    <div v-if="history.frameCount.value === 0" class="empty">
      <p class="muted">
        No history frames yet. Real history starts when the algorithm emits it.
      </p>
    </div>

    <div v-else class="controls">
      <input
        type="range"
        min="0"
        :max="Math.max(0, history.frameCount.value - 1)"
        :value="history.state.value.selectedFrameIndex"
        @input="onSliderInput"
        class="slider"
      />
      <div class="buttons">
        <button type="button" :disabled="history.frameCount.value === 0" @click="history.stepFrame(-1)">
          Prev
        </button>
        <button
          type="button"
          :disabled="history.frameCount.value === 0"
          @click="history.togglePlayback"
        >
          {{ history.state.value.isPlaying ? 'Pause' : 'Play' }}
        </button>
        <button type="button" :disabled="history.frameCount.value === 0" @click="history.stepFrame(1)">
          Next
        </button>
        <label class="speed">
          Speed
          <input
            type="number"
            min="0.25"
            max="8"
            step="0.25"
            :value="history.state.value.speed"
            @change="onSpeedChange"
          />
          x
        </label>
      </div>
      <p class="frame-info">
        Frame {{ history.state.value.selectedFrameIndex + 1 }} of {{ history.frameCount.value }}
        <span v-if="history.state.value.truncated" class="warn">(truncated; see NDJSON replay)</span>
      </p>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

h2 {
  margin: 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}

.run-label {
  display: flex;
  gap: 6px;
  font-size: 12px;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}

.empty {
  padding: 8px 0;
}

.controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.slider {
  width: 100%;
}

.buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}

.speed {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
}

.speed input {
  width: 60px;
  font-size: 11px;
}

.frame-info {
  font-size: 11px;
  color: var(--text-secondary);
}

.warn {
  color: var(--warning);
  margin-left: 6px;
}
</style>