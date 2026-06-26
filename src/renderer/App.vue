<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import AppShell from './components/AppShell.vue'
import SheetSettingsPanel from './components/SheetSettingsPanel.vue'
import PieceTable from './components/PieceTable.vue'
import DxfPreviewCanvas from './components/DxfPreviewCanvas.vue'
import HistoryTimeline from './components/HistoryTimeline.vue'
import StrategyRunsPanel from './components/StrategyRunsPanel.vue'
import { useAppStore } from './composables/useAppStore.js'
import { useSettings } from './composables/useSettings.js'
import { useHistoryStore } from './composables/useHistoryStore.js'
import { useFinalSelection } from './composables/useFinalSelection.js'
import { useJobRunner } from './composables/useJobRunner.js'
import { preparePieces } from '@shared/preparePieces.js'
import { newJobId } from './utils/ids.js'
import type { NestingRequest, NestingWarning } from '@shared/domain/nesting.js'
import type { Unsubscribe } from '@shared/protocol/ipc.js'

const lastPong = ref<string | null>(null)
const lastPing = ref<string | null>(null)
let unsubscribe: Unsubscribe | null = null
const store = useAppStore()
const settings = useSettings()
const history = useHistoryStore()
const finalSelection = useFinalSelection()
const runner = useJobRunner()

const preparationWarnings = ref<ReadonlyArray<NestingWarning>>([])

onMounted(() => {
  const api = window.appApi
  if (!api) return
  unsubscribe = api.onPong((at) => {
    lastPong.value = at
  })
  void api.ping().then((value) => {
    lastPing.value = value.at
  })
})

onUnmounted(() => {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  runner.clear()
})

function buildRequest(): NestingRequest | null {
  const sheet = settings.state.value.sheet
  const padding = settings.state.value.padding
  if (sheet.width <= 0 || sheet.height <= 0) return null
  if (store.pieceCount.value === 0) return null

  const prep = preparePieces(store.state.value.pieces, sheet, padding, newJobId())
  preparationWarnings.value = prep.warnings

  return {
    version: 1,
    jobId: newJobId(),
    sheet: { ...sheet },
    padding,
    pieces: prep.pieces,
    options: { ...settings.state.value.options }
  }
}

async function exportRequest(): Promise<void> {
  const api = window.appApi
  if (!api) return
  const request = buildRequest()
  if (!request) return
  await api.exportNestingRequest(request)
}

async function runNesting(): Promise<void> {
  const request = buildRequest()
  if (!request) return
  history.clear()
  await runner.start(request, {
    onHistoryFrame: (frame) => history.pushFrame(frame),
    onHistoryComplete: (jobId, summary) => {
      history.completeRun(jobId, summary)
    },
    onResult: (result) => {
      history.setResult(result)
      finalSelection.syncFromResult(result)
    },
    onError: (message) => {
      console.error('[runner] error:', message)
    }
  })
}

async function exportHistory(): Promise<void> {
  const api = window.appApi
  if (!api) return
  const ref = history.state.value.lastHistoryRef
  if (!ref) {
    console.warn('No history ref available for export')
    return
  }
  const allFrames = Object.values(history.state.value.framesByRun).flat()
  if (allFrames.length === 0) {
    console.warn('No history frames to export')
    return
  }
  await api.exportNestingHistory(ref)
}

async function exportResult(): Promise<void> {
  const api = window.appApi
  const result = history.result.value
  if (!api || !result) return
  await api.exportNestingResult(result)
}

function cancelJob(): void {
  runner.cancel()
}

async function saveProject(): Promise<void> {
  const api = window.appApi
  if (!api) return
  // Compose a minimal ProjectDocument from the current session state.
  // Phase 8 schema validation runs on the main process.
  const sourceFiles = store.state.value.documents.map((d) => ({
    id: d.id,
    path: d.path,
    fileName: d.fileName,
    available: true
  }))
  await api.saveProject({
    version: 1,
    savedAt: new Date().toISOString(),
    sourceFiles,
    importedPieces: [...store.state.value.pieces],
    sheet: { ...settings.state.value.sheet },
    padding: settings.state.value.padding,
    options: { ...settings.state.value.options },
    ...(history.hasResult.value && history.result.value ? { lastResult: history.result.value } : {})
  })
}

async function openProject(): Promise<void> {
  const api = window.appApi
  if (!api) return
  await api.openProject()
}
</script>

<template>
  <AppShell :last-ping="lastPing" :last-pong="lastPong">
    <template #toolbar>
      <button type="button" :disabled="store.pieceCount.value === 0 || runner.status.value === 'running'" @click="runNesting">
        {{ runner.status.value === 'running' ? 'Running...' : 'Run' }}
      </button>
      <button type="button" :disabled="runner.status.value !== 'running'" @click="cancelJob">
        Cancel
      </button>
      <button type="button" :disabled="store.pieceCount.value === 0" @click="exportRequest">
        Export Request
      </button>
      <button
        type="button"
        :disabled="!history.hasResult.value"
        :title="history.hasResult.value ? '' : 'No nesting result yet'"
        @click="exportResult"
      >
        Export Result
      </button>
      <button
        type="button"
        :disabled="!history.state.value.lastHistoryRef"
        :title="history.state.value.lastHistoryRef ? '' : 'No history ref available'"
        @click="exportHistory"
      >
        Export History
      </button>
      <button type="button" @click="saveProject">Save Project</button>
      <button type="button" @click="openProject">Open Project</button>
    </template>

    <template #settings>
      <SheetSettingsPanel />
    </template>

    <template #canvas>
      <h2>Preview / Result</h2>
      <DxfPreviewCanvas />
    </template>

    <template #pieces>
      <h2>
        Pieces
        <span class="counter">{{ store.pieceCount.value }}</span>
      </h2>
      <PieceTable />
    </template>

    <template #timeline>
      <div class="strategy-runs-slot">
        <StrategyRunsPanel />
      </div>
      <div class="history-slot">
        <HistoryTimeline />
      </div>
      <div class="warnings-slot">
        <h3>Preparation warnings</h3>
        <ul v-if="preparationWarnings.length > 0" class="warnings">
          <li v-for="(w, i) in preparationWarnings" :key="i">{{ w.message }}</li>
        </ul>
        <p v-else class="muted">No preparation issues yet.</p>
      </div>
    </template>

    <template #status>
      <span class="muted">
        {{ store.documentCount.value }} document(s) /
        {{ store.pieceCount.value }} piece(s) /
        {{ store.warningCount.value }} warning(s) ·
        worker: {{ runner.status.value }}
        <span v-if="history.hasResult.value" class="empty-msg">
          · {{ history.strategyResults.value.length }} strategy run(s) available
        </span>
        <span v-else class="empty-msg">
          · Algorithm intentionally not implemented.
        </span>
      </span>
    </template>
  </AppShell>
</template>

<style scoped>
.muted {
  color: var(--text-muted);
  font-size: 12px;
  margin: 8px 0 0 0;
}

.counter {
  display: inline-block;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  padding: 1px 6px;
  border-radius: var(--radius);
  font-size: 11px;
  margin-left: 6px;
}

.empty-msg {
  margin-left: 12px;
  color: var(--warning);
}

.warnings {
  margin: 0;
  padding: 0 0 0 18px;
  font-size: 12px;
  color: var(--warning);
}

.warnings li {
  margin-bottom: 2px;
}

.strategy-runs-slot,
.history-slot,
.warnings-slot {
  margin-bottom: 8px;
}

.warnings-slot h3 {
  margin: 0 0 4px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}
</style>