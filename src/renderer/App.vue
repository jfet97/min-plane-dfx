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
import { JobId } from '@shared/domain/ids.js'
import type {
  NestingHistorySummary,
  NestingOptions,
  NestingRequest,
  NestingResult,
  NestingStats,
  NestingStrategyResult,
  NestingWarning,
  Placement,
  PreparedPiece,
  SheetSpec
} from '@shared/domain/nesting.js'
import {
  ProjectRunRecord,
  type ProjectRunRecord as ProjectRunRecordModel,
  type WorkspaceProjectSettings
} from '@shared/domain/project.js'
import { ProjectHistoryRef } from '@shared/domain/nesting.js'
import type { Unsubscribe } from '@shared/protocol/ipc.js'

type CenterView = 'import' | 'result'

const lastPong = ref<string | null>(null)
const lastPing = ref<string | null>(null)
const centerView = ref<CenterView>('import')
let unsubscribe: Unsubscribe | null = null
let workspaceSettingsReady = false
let workspaceSettingsRevision = 0
let workspaceSettingsSaveInFlight = false
let workspaceSettingsSaveRequested = false
let workspaceHydrating = false
const store = useAppStore()
const settings = useSettings()
const history = useHistoryStore()
const finalSelection = useFinalSelection()
const runner = useJobRunner()

const preparationWarnings = ref<ReadonlyArray<NestingWarning>>([])
const projectWarning = ref<string | null>(null)

watch(store.importRevision, () => {
  if (workspaceHydrating) return
  runner.clear()
  history.clear()
  finalSelection.syncFromResult(null)
  preparationWarnings.value = []
  projectWarning.value = null
})

settings.setWorkspaceSettingsPersistor(persistWorkspaceSettings)
store.setWorkspaceSettingsPersistor(scheduleWorkspaceSettingsSave)
history.setWorkspaceSettingsPersistor(scheduleWorkspaceSettingsSave)

onMounted(() => {
  const api = window.appApi
  if (!api) return
  void hydrateWorkspaceState()
  window.addEventListener('beforeunload', flushWorkspaceSettingsBeforeUnload)
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
  window.removeEventListener('beforeunload', flushWorkspaceSettingsBeforeUnload)
  settings.setWorkspaceSettingsPersistor(null)
  store.setWorkspaceSettingsPersistor(null)
  history.setWorkspaceSettingsPersistor(null)
  runner.clear()
})

async function hydrateWorkspaceState(): Promise<void> {
  const api = window.appApi
  if (!api) return
  workspaceHydrating = true
  try {
    const persistedSettings = await api.loadWorkspaceSettings()
    await store.loadPersistedImports()
    if (persistedSettings) {
      workspaceSettingsRevision = persistedSettings.revision ?? 0
      settings.hydrateWorkspaceSettings(persistedSettings)
      store.hydratePieceQuantities(persistedSettings.pieceQuantities)
      history.hydrateWorkspaceSettings(persistedSettings)
      await loadCurrentHistoryReplay()
    }
  } catch (error: unknown) {
    console.error('[workspace] failed to hydrate temporary project state:', error)
  } finally {
    workspaceSettingsReady = true
    workspaceHydrating = false
  }
}

function buildWorkspaceSettings(): WorkspaceProjectSettings {
  return {
    revision: workspaceSettingsRevision,
    sheet: cloneSheet(settings.state.value.sheet),
    padding: settings.state.value.padding,
    pieceQuantities: { ...store.state.value.pieceQuantities },
    options: cloneOptions(settings.state.value.options),
    runRecords: history.runRecords.value.map(cloneRunRecord)
  }
}

function persistWorkspaceSettings(mode: 'queued' | 'immediate' = 'queued'): void {
  if (mode === 'immediate') {
    void saveWorkspaceSettingsNow()
    return
  }
  scheduleWorkspaceSettingsSave()
}

function scheduleWorkspaceSettingsSave(): void {
  if (!workspaceSettingsReady) return
  workspaceSettingsSaveRequested = true
  if (!workspaceSettingsSaveInFlight) {
    void drainWorkspaceSettingsSaves()
  }
}

async function drainWorkspaceSettingsSaves(): Promise<void> {
  workspaceSettingsSaveInFlight = true
  while (workspaceSettingsSaveRequested) {
    workspaceSettingsSaveRequested = false
    workspaceSettingsRevision++
    await saveWorkspaceSettingsSnapshot(buildWorkspaceSettings())
  }
  workspaceSettingsSaveInFlight = false
}

async function saveWorkspaceSettingsNow(): Promise<void> {
  if (!workspaceSettingsReady) return
  workspaceSettingsSaveRequested = false
  workspaceSettingsRevision++
  await saveWorkspaceSettingsSnapshot(buildWorkspaceSettings())
}

async function saveWorkspaceSettingsSnapshot(snapshot: WorkspaceProjectSettings): Promise<void> {
  const api = window.appApi
  if (!api || !workspaceSettingsReady) return
  try {
    await api.saveWorkspaceSettings(snapshot)
  } catch (error: unknown) {
    console.error('[workspace] failed to persist temporary project settings:', error)
  }
}

function flushWorkspaceSettingsBeforeUnload(): void {
  if (!workspaceSettingsReady) return
  workspaceSettingsSaveRequested = false
  workspaceSettingsRevision++
  window.appApi?.saveWorkspaceSettingsSync(buildWorkspaceSettings())
}

function cloneSheet(sheet: SheetSpec): SheetSpec {
  return {
    width: sheet.width,
    height: sheet.height,
    label: sheet.label
  }
}

function cloneOptions(options: NestingOptions): NestingOptions {
  return {
    allowGlobalRotation: options.allowGlobalRotation,
    timeoutMs: options.timeoutMs,
    workerMode: options.workerMode,
    historyMode: options.historyMode,
    historyScope: options.historyScope,
    strategySelectionMode: options.strategySelectionMode,
    strategyIds: [...options.strategyIds],
    layoutSelectionStrategyId: options.layoutSelectionStrategyId,
    finalSelectionMode: options.finalSelectionMode,
    ...(options.topN !== undefined ? { topN: options.topN } : {}),
    ...(options.maxHistoryEvents !== undefined
      ? { maxHistoryEvents: options.maxHistoryEvents }
      : {})
  }
}

function cloneHistorySummary(summary: NestingHistorySummary): NestingHistorySummary {
  return {
    frameCount: summary.frameCount,
    strategyRunCount: summary.strategyRunCount,
    retainedFrameCount: summary.retainedFrameCount,
    truncated: summary.truncated,
    scope: summary.scope,
    strategyRunIds: [...summary.strategyRunIds],
    ...(summary.ndjsonPath ? { ndjsonPath: summary.ndjsonPath } : {})
  }
}

function clonePlacement(placement: Placement): Placement {
  return {
    pieceId: placement.pieceId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    rotation: placement.rotation
  }
}

function cloneStats(stats: NestingStats): NestingStats {
  return {
    elapsedMs: stats.elapsedMs,
    pieceCount: stats.pieceCount,
    algorithm: {
      startedAt: stats.algorithm.startedAt,
      endedAt: stats.algorithm.endedAt,
      elapsedMs: stats.algorithm.elapsedMs
    }
  }
}

function cloneStrategyResult(result: NestingStrategyResult): NestingStrategyResult {
  return {
    strategyRunId: result.strategyRunId,
    strategyId: result.strategyId,
    strategyLabel: result.strategyLabel,
    ...(result.strategyDescription !== undefined
      ? { strategyDescription: result.strategyDescription }
      : {}),
    status: result.status,
    sortedPieceIds: [...result.sortedPieceIds],
    placements: result.placements.map(clonePlacement),
    unplacedPieceIds: [...result.unplacedPieceIds],
    ...(result.historySummary
      ? { historySummary: cloneHistorySummary(result.historySummary) }
      : {}),
    ...(result.finalScore ? { finalScore: { ...result.finalScore } } : {}),
    stats: cloneStats(result.stats),
    warnings: result.warnings.map((warning) => ({ ...warning }))
  }
}

function cloneResult(result: NestingResult): NestingResult {
  return {
    version: result.version,
    jobId: result.jobId,
    status: result.status,
    strategyResults: result.strategyResults.map(cloneStrategyResult),
    ...(result.selectedStrategyRunId
      ? { selectedStrategyRunId: result.selectedStrategyRunId }
      : {}),
    sortedPieceIds: [...result.sortedPieceIds],
    placements: result.placements.map(clonePlacement),
    unplacedPieceIds: [...result.unplacedPieceIds],
    ...(result.historySummary
      ? { historySummary: cloneHistorySummary(result.historySummary) }
      : {}),
    warnings: result.warnings.map((warning) => ({ ...warning })),
    stats: cloneStats(result.stats)
  }
}

function cloneHistoryRef(ref: ProjectHistoryRef | null): ProjectHistoryRef | null {
  if (!ref) return null
  return {
    kind: ref.kind,
    jobId: ref.jobId,
    path: ref.path,
    frameCount: ref.frameCount,
    createdAt: ref.createdAt
  }
}

function cloneRunRecord(record: ProjectRunRecordModel): ProjectRunRecordModel {
  return {
    jobId: record.jobId,
    createdAt: record.createdAt,
    label: record.label,
    pieceCount: record.pieceCount,
    sheet: cloneSheet(record.sheet),
    result: cloneResult(record.result),
    history: cloneHistoryRef(record.history)
  }
}

function clonePreparedPieces(pieces: ReadonlyArray<PreparedPiece>): ReadonlyArray<PreparedPiece> {
  return pieces.map((piece) => ({
    id: piece.id,
    sourcePieceId: piece.sourcePieceId,
    realBounds: {
      x: piece.realBounds.x,
      y: piece.realBounds.y,
      width: piece.realBounds.width,
      height: piece.realBounds.height
    },
    paddedBounds: {
      x: piece.paddedBounds.x,
      y: piece.paddedBounds.y,
      width: piece.paddedBounds.width,
      height: piece.paddedBounds.height,
      longestEdge: piece.paddedBounds.longestEdge,
      area: piece.paddedBounds.area,
      imbalance: piece.paddedBounds.imbalance
    },
    padding: piece.padding,
    allowRotation: piece.allowRotation
  }))
}

function buildRequest(): NestingRequest | null {
  const sheet = settings.state.value.sheet
  const padding = settings.state.value.padding
  if (sheet.width <= 0 || sheet.height <= 0) return null
  if (store.selectedPieceCount.value === 0) return null

  const jobId = JobId.make()
  const prep = preparePieces(store.selectedPieces.value, sheet, padding, jobId)
  preparationWarnings.value = prep.warnings

  return {
    version: 1,
    jobId,
    sheet: cloneSheet(sheet),
    padding,
    pieces: clonePreparedPieces(prep.pieces),
    options: cloneOptions(settings.state.value.options)
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
  centerView.value = 'result'
  await runner.start(request, {
    onHistoryFrame: (frame) => history.pushFrame(frame),
    onHistoryComplete: async (jobId, summary) => {
      history.completeRun(jobId, summary)
      const api = window.appApi
      if (!api || !summary.ndjsonPath) return
      try {
        const frames = await api.loadHistoryReplay(
          new ProjectHistoryRef({
            kind: 'ndjson_replay',
            jobId,
            path: summary.ndjsonPath,
            frameCount: summary.frameCount,
            createdAt: new Date().toISOString()
          })
        )
        for (const frame of frames) {
          history.pushFrame(frame)
        }
      } catch (error: unknown) {
        console.warn('[history] failed to load replay for completed run:', error)
      }
    },
    onResult: async (result) => {
      history.setResult(result)
      history.addRunRecord(
        new ProjectRunRecord({
          jobId: result.jobId,
          createdAt: new Date().toISOString(),
          label: result.strategyResults[0]?.strategyLabel ?? `Run ${result.jobId}`,
          pieceCount: request.pieces.length,
          sheet: cloneSheet(request.sheet),
          result,
          history: history.state.value.lastHistoryRef
        })
      )
      await saveWorkspaceSettingsNow()
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
    pieceQuantities: { ...store.state.value.pieceQuantities },
    options: { ...settings.state.value.options },
    runRecords: history.runRecords.value.map(cloneRunRecord),
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

  await loadCurrentHistoryReplay()
}

async function loadCurrentHistoryReplay(): Promise<void> {
  const api = window.appApi
  const ref = history.state.value.lastHistoryRef
  if (!api || !ref) return
  try {
    const frames = await api.loadHistoryReplay(ref)
    for (const frame of frames) {
      history.pushFrame(frame)
    }
  } catch (error: unknown) {
    console.warn('[history] failed to load current replay:', error)
    history.clearRunRecordHistory(ref.jobId)
    await saveWorkspaceSettingsNow()
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
            ? 'Sends the prepared nesting request to the worker. Disabled until at least one source shape has quantity greater than zero.'
            : 'Sends the prepared nesting request to the worker using the current sheet, padding, quantities, and strategy configuration.'
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
        title="Exports the exact JSON request sent to the worker for the current cut-list quantities."
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
      <DxfPreviewCanvas :mode="centerView" :is-running="runner.status.value === 'running'" />
    </template>

    <template #pieces>
      <h2>
        Cut list
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
        <p v-if="runner.state.value.lastError" class="project-warning">
          {{ runner.state.value.lastError }}
        </p>
        <ul v-if="preparationWarnings.length > 0" class="warnings">
          <li v-for="(w, i) in preparationWarnings" :key="i">{{ w.message }}</li>
        </ul>
        <p v-else-if="!projectWarning && !runner.state.value.lastError" class="muted">
          No preparation issues yet.
        </p>
      </div>
    </template>

    <template #status>
      <span class="muted">
        {{ store.documentCount.value }} document(s) / {{ store.pieceCount.value }} piece(s) /
        {{ store.selectedPieceCount.value }} cut piece(s) /
        {{ store.warningCount.value }} warning(s) · worker: {{ runner.status.value }}
        <span v-if="history.hasResult.value" class="empty-msg">
          · {{ history.strategyResults.value.length }} strategy run(s) available
        </span>
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
