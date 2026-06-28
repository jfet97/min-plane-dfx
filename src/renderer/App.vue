<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
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

type CenterView = 'import' | 'result'

const lastPong = ref<string | null>(null)
const lastPing = ref<string | null>(null)
const centerView = ref<CenterView>('import')
let unsubscribe: Unsubscribe | null = null
const store = useAppStore()
const settings = useSettings()
const history = useHistoryStore()
const finalSelection = useFinalSelection()
const runner = useJobRunner()

const preparationWarnings = ref<ReadonlyArray<NestingWarning>>([])
const projectWarning = ref<string | null>(null)

watch(store.importRevision, () => {
  runner.clear()
  history.clear()
  finalSelection.syncFromResult(null)
  preparationWarnings.value = []
  projectWarning.value = null
})

onMounted(() => {
  const api = window.appApi
  if (!api) return
  void store.loadPersistedImports().catch((error: unknown) => {
    console.error('[imports] failed to load persisted DXFs:', error)
  })
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
  if (store.selectedPieceCount.value === 0) return null

  const jobId = newJobId()
  const prep = preparePieces(store.selectedPieces.value, sheet, padding, jobId)
  preparationWarnings.value = prep.warnings

  return {
    version: 1,
    jobId,
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
  projectWarning.value = null
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
    importedDocuments: [...store.state.value.documents],
    sheet: { ...settings.state.value.sheet },
    padding: settings.state.value.padding,
    options: { ...settings.state.value.options },
    ...(history.hasResult.value && history.result.value
      ? { lastResult: history.result.value }
      : {}),
    ...(history.state.value.lastHistoryRef
      ? { lastHistory: history.state.value.lastHistoryRef }
      : {})
  })
}

async function openProject(): Promise<void> {
  const api = window.appApi
  if (!api) return
  const project = await api.openProject()
  projectWarning.value = null
  runner.clear()
  store.hydrateFromProject(project)
  settings.hydrateFromProject(project)
  history.hydrateFromProject(project)
  finalSelection.hydrateFromProject(project)
  preparationWarnings.value = []

  if (project.lastHistory) {
    try {
      const frames = await api.loadHistoryReplay(project.lastHistory)
      for (const frame of frames) {
        history.pushFrame(frame)
      }
    } catch {
      projectWarning.value =
        'Saved result loaded, but the referenced NDJSON history file is missing or unreadable.'
    }
  }
}
</script>

<template>
  <AppShell :last-ping="lastPing" :last-pong="lastPong">
    <template #toolbar>
      <button
        type="button"
        :disabled="store.selectedPieceCount.value === 0 || runner.status.value === 'running'"
        :title="
          store.selectedPieceCount.value === 0
            ? 'Sends the prepared nesting request to the worker. Disabled until at least one imported shape is selected.'
            : 'Sends the prepared nesting request to the worker using the current sheet, padding, selected pieces, and strategy configuration.'
        "
        @click="runNesting"
      >
        {{ runner.status.value === 'running' ? 'Running...' : 'Run' }}
      </button>
      <button
        type="button"
        :disabled="runner.status.value !== 'running'"
        title="Cancels the active worker job."
        @click="cancelJob"
      >
        Cancel
      </button>
      <button
        type="button"
        :disabled="store.selectedPieceCount.value === 0"
        title="Exports the exact JSON request sent to the worker for the selected pieces, useful for debugging and reproducing algorithm runs."
        @click="exportRequest"
      >
        Export Request
      </button>
      <button
        type="button"
        :disabled="!history.hasResult.value"
        :title="
          history.hasResult.value
            ? 'Exports the latest worker result.'
            : 'Exports the latest worker result. Disabled until a result exists.'
        "
        @click="exportResult"
      >
        Export Result
      </button>
      <button
        type="button"
        :disabled="!history.state.value.lastHistoryRef"
        :title="
          history.state.value.lastHistoryRef
            ? 'Exports emitted history frames for replay or debugging.'
            : 'Exports emitted history frames. Disabled until history exists.'
        "
        @click="exportHistory"
      >
        Export History
      </button>
      <button
        type="button"
        title="Saves a user-chosen JSON project snapshot with imports, sheet/settings, options, latest result, and history reference when available."
        @click="saveProject"
      >
        Save Project
      </button>
      <button
        type="button"
        title="Opens and validates a saved JSON project, hydrates renderer state, and resets transient worker state to idle."
        @click="openProject"
      >
        Open Project
      </button>
    </template>

    <template #settings>
      <SheetSettingsPanel />
    </template>

    <template #canvas>
      <div class="center-header">
        <h2>{{ centerView === 'import' ? 'Import Preview' : 'Result' }}</h2>
        <div
          class="center-tabs"
          title="Switch between imported-object inspection and worker result output."
        >
          <button
            type="button"
            :class="{ active: centerView === 'import' }"
            @click="centerView = 'import'"
          >
            Import
          </button>
          <button
            type="button"
            :class="{ active: centerView === 'result' }"
            @click="centerView = 'result'"
          >
            Result
          </button>
        </div>
      </div>
      <DxfPreviewCanvas :mode="centerView" />
    </template>

    <template #pieces>
      <h2>
        Pieces
        <span class="counter">{{ store.pieceCount.value }}</span>
      </h2>
      <p v-if="store.state.value.lastSkippedDuplicateCount > 0" class="muted">
        {{ store.state.value.lastSkippedDuplicateCount }} already imported file(s) skipped.
      </p>
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
        <p v-if="projectWarning" class="project-warning">{{ projectWarning }}</p>
        <ul v-if="preparationWarnings.length > 0" class="warnings">
          <li v-for="(w, i) in preparationWarnings" :key="i">{{ w.message }}</li>
        </ul>
        <p v-else class="muted">No preparation issues yet.</p>
      </div>
    </template>

    <template #status>
      <span class="muted">
        {{ store.documentCount.value }} document(s) / {{ store.pieceCount.value }} piece(s) /
        {{ store.selectedPieceCount.value }} selected / {{ store.warningCount.value }} warning(s) ·
        worker: {{ runner.status.value }}
        <span v-if="history.hasResult.value" class="empty-msg">
          · {{ history.strategyResults.value.length }} strategy run(s) available
        </span>
        <span v-else class="empty-msg"> · Algorithm intentionally not implemented. </span>
      </span>
    </template>
  </AppShell>
</template>

<style scoped>
.center-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.center-header h2 {
  margin: 0;
}

.center-tabs {
  display: inline-flex;
  gap: 4px;
}

.center-tabs button {
  font-size: 12px;
  padding: 3px 8px;
}

.center-tabs button.active {
  border-color: var(--accent);
  color: var(--text-primary);
}

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

.project-warning {
  margin: 0 0 4px 0;
  font-size: 12px;
  color: var(--warning);
}

.warnings li {
  margin-bottom: 2px;
}

.strategy-runs-slot,
.history-slot,
.warnings-slot {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.warnings-slot h3 {
  margin: 0 0 4px 0;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}
</style>
