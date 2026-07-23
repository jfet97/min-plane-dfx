<script setup lang="ts">
import { isIrregularHistoryFrame } from '@shared/domain/nesting.js'
import type { NestingHistoryFramePayload } from '@shared/domain/nesting.js'
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

function placedCount(frame: NestingHistoryFramePayload): number {
  return isIrregularHistoryFrame(frame) ? frame.placements.length : frame.plate.placements.length
}

function remainingCount(frame: NestingHistoryFramePayload): number {
  return isIrregularHistoryFrame(frame)
    ? frame.remainingPieceIds.length
    : frame.state.remainingPieceIds.length
}

function unplacedCount(frame: NestingHistoryFramePayload): number {
  return isIrregularHistoryFrame(frame)
    ? frame.unplacedPieceIds.length
    : frame.state.unplacedPieceIds.length
}

function freeRectangleCount(frame: NestingHistoryFramePayload): number | null {
  return isIrregularHistoryFrame(frame) ? null : frame.plate.freeRectangles.length
}

function candidateCount(frame: NestingHistoryFramePayload): number | null {
  return isIrregularHistoryFrame(frame)
    ? (frame.candidateCount ?? null)
    : (frame.beam?.candidateCount ?? null)
}

function selectedTransform(frame: NestingHistoryFramePayload): string | null {
  if (!isIrregularHistoryFrame(frame) || frame.selectedTransform === undefined) return null
  const transform = frame.selectedTransform
  const mirror = transform.mirrored ? ' mirrored' : ''
  return (
    String(transform.rotationDeg) +
    '°' +
    mirror +
    ' at ' +
    transform.translateX +
    ', ' +
    transform.translateY +
    ' mm'
  )
}

function isSharedArchiveFrame(frame: NestingHistoryFramePayload): boolean {
  return isIrregularHistoryFrame(frame) && frame.title.startsWith('shared-archive-')
}

function displayedStrategyId(): string {
  const run = history.selectedRun.value
  return run?.layout?.kind === 'irregular' && run.layout.source === 'shared-archive'
    ? 'irregular-convex-shared-archive'
    : (run?.strategyId ?? '')
}
</script>

<template>
  <div class="timeline">
    <header class="head">
      <h2 title="Frames appear only when the algorithm emits them.">History timeline</h2>
      <div class="run-label" v-if="history.selectedRun.value">
        <span class="muted">Run:</span>
        <strong>{{ history.selectedRun.value.strategyLabel }}</strong>
        <code class="muted">({{ displayedStrategyId() }})</code>
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
        Frame {{ history.selectedStepPosition.value + 1 }} of {{ history.stepCount.value }}
        <span
          v-if="
            history.selectedFrame.value &&
            isSharedArchiveFrame(history.selectedFrame.value)
          "
          class="rank"
        >
          Selected layout reveal · {{ placedCount(history.selectedFrame.value) }} placed
        </span>
        <span v-else-if="history.selectedFrame.value" class="rank">
          History step {{ history.selectedFrame.value.stepIndex }} · Beam rank
          {{ history.selectedFrame.value.beamRank + 1 }}
        </span>
        <span v-if="history.state.value.truncated" class="warn"
          >(truncated; see NDJSON replay)</span
        >
      </p>
      <div v-if="history.selectedFrame.value" class="state-info">
        <span
          :title="
            isSharedArchiveFrame(history.selectedFrame.value)
              ? 'Number of pieces visible in this prefix of the selected exact layout.'
              : 'Number of committed placements in this retained beam state.'
          "
        >
          Placed {{ placedCount(history.selectedFrame.value) }}
        </span>
        <span
          v-if="freeRectangleCount(history.selectedFrame.value) !== null"
          title="Number of MaxRects free rectangles in this retained beam state."
        >
          Free rects {{ freeRectangleCount(history.selectedFrame.value) }}
        </span>
        <span
          :title="
            isSharedArchiveFrame(history.selectedFrame.value)
              ? 'Pieces not yet visible in this selected-layout reveal.'
              : 'Pieces still queued for future placement attempts in the selected beam state.'
          "
        >
          Remaining {{ remainingCount(history.selectedFrame.value) }}
        </span>
        <span title="Pieces already rejected as not fitting in the selected beam state.">
          Unplaced {{ unplacedCount(history.selectedFrame.value) }}
        </span>
        <span
          v-if="candidateCount(history.selectedFrame.value) !== null"
          title="Real candidate count emitted for this beam expansion."
        >
          Candidates {{ candidateCount(history.selectedFrame.value) }}
        </span>
        <span
          v-if="selectedTransform(history.selectedFrame.value)"
          title="Real selected transform for this history frame."
        >
          Transform {{ selectedTransform(history.selectedFrame.value) }}
        </span>
      </div>
      <div
        v-if="
          history.selectedStepFrames.value.length > 1 &&
          history.selectedFrame.value &&
          !isSharedArchiveFrame(history.selectedFrame.value)
        "
        class="beam-ranks"
      >
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
      <p
        v-if="
          history.selectedStepFrames.value.length > 1 &&
          history.selectedFrame.value &&
          !isSharedArchiveFrame(history.selectedFrame.value)
        "
        class="beam-note"
      >
        Beam rank is a snapshot at this step; rank 1 across steps can switch lineage.
      </p>
      <p
        v-if="
          history.selectedFrame.value &&
          isSharedArchiveFrame(history.selectedFrame.value)
        "
        class="beam-note"
      >
        This reveals the selected exact layout piece by piece; it is not search ancestry.
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

.beam-note {
  margin: -2px 0 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.warn {
  color: var(--warning);
  margin-left: 6px;
}
</style>
