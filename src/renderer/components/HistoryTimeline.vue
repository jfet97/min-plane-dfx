<script setup lang="ts">
import { useHistoryStore } from '../composables/useHistoryStore.js'

const history = useHistoryStore()

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ''
}

function onSliderInput(event: Event): void {
  history.selectStepPosition(Number(inputValue(event)))
}

function onSpeedChange(event: Event): void {
  history.setSpeed(Number(inputValue(event)))
}
</script>

<template>
  <div class="timeline">
    <header class="head">
      <h2 title="Frames appear only when the algorithm emits them.">History timeline</h2>
      <div class="run-label" v-if="history.selectedRun.value">
        <span class="muted">Run:</span>
        <strong>{{ history.selectedRun.value.strategyLabel }}</strong>
        <code class="muted">({{ history.selectedRun.value.strategyId }})</code>
      </div>
    </header>

    <div v-if="history.stepCount.value === 0" class="empty">
      <p class="muted">No history frames yet. Real history starts when the algorithm emits it.</p>
    </div>

    <div v-else class="controls">
      <input
        type="range"
        title="Scrub through emitted algorithm frames for the selected strategy run."
        min="0"
        :max="Math.max(0, history.stepCount.value - 1)"
        :value="history.selectedStepPosition.value"
        @input="onSliderInput"
        class="slider"
      />
      <div class="buttons">
        <button
          type="button"
          :disabled="history.stepCount.value === 0"
          title="Move to the previous emitted algorithm step."
          @click="history.stepFrame(-1)"
        >
          Prev
        </button>
        <button
          type="button"
          :disabled="history.stepCount.value === 0"
          title="Play or pause timeline playback by algorithm step."
          @click="history.togglePlayback"
        >
          {{ history.state.value.isPlaying ? 'Pause' : 'Play' }}
        </button>
        <button
          type="button"
          :disabled="history.stepCount.value === 0"
          title="Move to the next emitted algorithm step."
          @click="history.stepFrame(1)"
        >
          Next
        </button>
        <label class="speed" title="Timeline playback speed multiplier.">
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
        Step {{ history.selectedStepPosition.value + 1 }} of {{ history.stepCount.value }}
        <span v-if="history.selectedFrame.value" class="rank">
          History step {{ history.selectedFrame.value.stepIndex }} · Beam rank
          {{ history.selectedFrame.value.beamRank + 1 }}
        </span>
        <span v-if="history.state.value.truncated" class="warn"
          >(truncated; see NDJSON replay)</span
        >
      </p>
      <div v-if="history.selectedFrame.value" class="state-info">
        <span title="Number of committed placements in this retained beam state.">
          Placed {{ history.selectedFrame.value.plate.placements.length }}
        </span>
        <span title="Number of MaxRects free rectangles in this retained beam state.">
          Free rects {{ history.selectedFrame.value.plate.freeRectangles.length }}
        </span>
        <span title="Pieces still queued for future placement attempts in the selected beam state.">
          Remaining {{ history.selectedFrame.value.state.remainingPieceIds.length }}
        </span>
        <span title="Pieces already rejected as not fitting in the selected beam state.">
          Unplaced {{ history.selectedFrame.value.state.unplacedPieceIds.length }}
        </span>
      </div>
      <div v-if="history.selectedStepFrames.value.length > 1" class="beam-ranks">
        <span class="muted">Beam rank</span>
        <button
          v-for="frame in history.selectedStepFrames.value"
          :key="`${frame.strategyRunId}-${frame.stepIndex}-${frame.beamRank}`"
          type="button"
          :class="{ active: frame.frameId === history.selectedFrame.value?.frameId }"
          :title="`Show retained beam state rank ${frame.beamRank + 1} for this step.`"
          @click="history.selectBeamRank(frame.beamRank)"
        >
          {{ frame.beamRank + 1 }}
        </button>
      </div>
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

.rank {
  margin-left: 8px;
  color: var(--text-primary);
}

.state-info {
  display: flex;
  gap: 10px;
  font-size: 11px;
  color: var(--text-secondary);
}

.beam-ranks {
  display: flex;
  align-items: center;
  gap: 4px;
}

.beam-ranks button {
  min-width: 22px;
  padding: 2px 6px;
  font-size: 11px;
}

.beam-ranks button.active {
  border-color: var(--accent);
  color: var(--accent);
}

.warn {
  color: var(--warning);
  margin-left: 6px;
}
</style>
