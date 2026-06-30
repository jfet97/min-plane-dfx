<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import AppShell from './components/AppShell.vue'
import SheetSettingsPanel from './components/SheetSettingsPanel.vue'
import PieceTable from './components/PieceTable.vue'
import DxfPreviewCanvas from './components/DxfPreviewCanvas.vue'
import HistoryTimeline from './components/HistoryTimeline.vue'
import StrategyRunsPanel from './components/StrategyRunsPanel.vue'
import CsvImportPanel from './components/CsvImportPanel.vue'
import { useAppStore } from './composables/useAppStore.js'
import { useSettings } from './composables/useSettings.js'
import { useHistoryStore } from './composables/useHistoryStore.js'
import { useFinalSelection } from './composables/useFinalSelection.js'
import { useJobRunner } from './composables/useJobRunner.js'
import { useCsvImportStore } from './composables/useCsvImportStore.js'
import { preparePieces } from '@shared/preparePieces.js'
import { prepareCsvPieces } from '@shared/prepareCsvPieces.js'
import { JobId, PieceId } from '@shared/domain/ids.js'
import type {
  NestingHistorySummary,
  NestingOptions,
  NestingRequest,
  NestingResult,
  NestingRunSummary,
  NestingStats,
  NestingStrategyResult,
  NestingSubRun,
  NestingWarning,
  Placement,
  PreparedPiece,
  ProjectHistoryRef,
  SheetSpec
} from '@shared/domain/nesting.js'
import type {
  CsvCutRow,
  CsvRunRecord,
  ProjectCsvImport,
  ProjectRunRecord as ProjectRunRecordModel,
  ProjectRunConfiguration,
  WorkspaceProjectSettings
} from '@shared/domain/project.js'
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
const csvStore = useCsvImportStore()
const csvImportPanelRef = ref<InstanceType<typeof CsvImportPanel> | null>(null)

const preparationWarnings = ref<ReadonlyArray<NestingWarning>>([])
const projectWarning = ref<string | null>(null)

interface NormalSubrunSession {
  readonly createdAt: string
  readonly sheet: SheetSpec
}

let normalSubrunSession: NormalSubrunSession | null = null

watch(store.importRevision, () => {
  if (workspaceHydrating) return
  runner.clear()
  history.clear()
  normalSubrunSession = null
  finalSelection.syncFromResult(null)
  preparationWarnings.value = []
  projectWarning.value = null
})

watch(
  () => csvStore.state.value.selectedCsvId,
  () => {
    if (workspaceHydrating) return
    scheduleWorkspaceSettingsSave()
  }
)

watch(
  () => csvStore.state.value.csvImports,
  (imports) => {
    if (workspaceHydrating) return
    store.setCsvImportsForCounting(imports)
  },
  { deep: true }
)

settings.setWorkspaceSettingsPersistor(persistWorkspaceSettings)
store.setWorkspaceSettingsPersistor(scheduleWorkspaceSettingsSave)
history.setWorkspaceSettingsPersistor(scheduleWorkspaceSettingsSave)
csvStore.setWorkspaceSettingsPersistor(scheduleWorkspaceSettingsSave)

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
  csvStore.setWorkspaceSettingsPersistor(null)
  runner.clear()
})

async function hydrateWorkspaceState(): Promise<void> {
  const api = window.appApi
  if (!api) return
  workspaceHydrating = true
  try {
    const persistedSettings = await api.loadWorkspaceSettings()
    await store.loadPersistedImports()
    await loadPersistedCsvImports()
    if (persistedSettings) {
      workspaceSettingsRevision = persistedSettings.revision ?? 0
      settings.hydrateWorkspaceSettings(persistedSettings)
      store.hydratePieceQuantities(persistedSettings.pieceQuantities)
      history.hydrateWorkspaceSettings(persistedSettings)
      csvStore.hydrateFromWorkspace(persistedSettings)
      store.setCsvImportsForCounting(csvStore.state.value.csvImports)
      await loadCurrentHistoryReplay()
    }
  } catch (error: unknown) {
    console.error('[workspace] failed to hydrate temporary project state:', error)
  } finally {
    workspaceSettingsReady = true
    workspaceHydrating = false
  }
}

async function loadPersistedCsvImports(): Promise<void> {
  const api = window.appApi
  if (!api) return
  try {
    const imports = await api.listImportedCsvs()
    csvStore.replaceCsvImports(imports)
  } catch (error: unknown) {
    console.error('[workspace] failed to load persisted CSV imports:', error)
  }
}

function buildWorkspaceSettings(): WorkspaceProjectSettings {
  const selectedCsvId = csvStore.state.value.selectedCsvId
  const csvRunRecords = csvStore.getCsvRunRecords().map(cloneCsvRunRecord)
  return {
    revision: workspaceSettingsRevision,
    sheet: cloneSheet(settings.state.value.sheet),
    padding: settings.state.value.padding,
    pieceQuantities: { ...store.state.value.pieceQuantities },
    options: cloneOptions(settings.state.value.options),
    runRecords: history.runRecords.value.map(cloneRunRecord),
    ...(selectedCsvId !== null ? { selectedCsvId } : {}),
    ...(csvRunRecords.length > 0 ? { csvRunRecords } : {})
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

function clonePreparedPiece(piece: PreparedPiece): PreparedPiece {
  return {
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
    allowRotation: piece.allowRotation,
    ...(piece.cutRowRef !== undefined ? { cutRowRef: { ...piece.cutRowRef } } : {})
  }
}

function clonePreparedPieces(pieces: ReadonlyArray<PreparedPiece>): ReadonlyArray<PreparedPiece> {
  return pieces.map(clonePreparedPiece)
}

function cloneCsvCutRow(row: CsvCutRow): CsvCutRow {
  return {
    id: row.id,
    reference: row.reference,
    customerName: row.customerName,
    amount: row.amount,
    ...(row.linkedPieceId !== undefined ? { linkedPieceId: row.linkedPieceId } : {})
  }
}

function cloneRunConfiguration(configuration: ProjectRunConfiguration): ProjectRunConfiguration {
  return {
    runId: configuration.runId,
    label: configuration.label,
    defaultSheet: cloneSheet(configuration.defaultSheet),
    padding: configuration.padding,
    options: cloneOptions(configuration.options),
    ...(configuration.materialFilter !== undefined
      ? { materialFilter: configuration.materialFilter }
      : {})
  }
}

function cloneCsvImport(csvImport: ProjectCsvImport): ProjectCsvImport {
  return {
    id: csvImport.id,
    sourcePath: csvImport.sourcePath,
    fileName: csvImport.fileName,
    materialCode: csvImport.materialCode,
    materialDescription: csvImport.materialDescription,
    thicknessMm: csvImport.thicknessMm,
    ...(csvImport.jobDate !== undefined ? { jobDate: csvImport.jobDate } : {}),
    rows: csvImport.rows.map(cloneCsvCutRow),
    runConfiguration: cloneRunConfiguration(csvImport.runConfiguration)
  }
}

function cloneSubRun(subRun: NestingSubRun): NestingSubRun {
  return {
    subRunId: subRun.subRunId,
    parentRunId: subRun.parentRunId,
    index: subRun.index,
    sheet: cloneSheet(subRun.sheet),
    padding: subRun.padding,
    options: cloneOptions(subRun.options),
    placements: subRun.placements.map(clonePlacement),
    unplacedPieceIds: [...subRun.unplacedPieceIds],
    pieceIds: [...subRun.pieceIds],
    requestPieceIds: [...subRun.requestPieceIds]
  } as NestingSubRun
}

function cloneRunSummary(summary: NestingRunSummary): NestingRunSummary {
  return {
    runId: summary.runId,
    subRuns: summary.subRuns.map(cloneSubRun),
    totalPlaced: summary.totalPlaced,
    totalUnplaced: summary.totalUnplaced,
    totalSheetAreaMm2: summary.totalSheetAreaMm2,
    usedAreaMm2: summary.usedAreaMm2
  } as NestingRunSummary
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
    stats: cloneStats(result.stats),
    ...(result.runSummary !== undefined ? { runSummary: cloneRunSummary(result.runSummary) } : {}),
    ...(result.preparedPieces !== undefined
      ? { preparedPieces: clonePreparedPieces(result.preparedPieces) }
      : {}),
    ...(result.csvImportId !== undefined ? { csvImportId: result.csvImportId } : {})
  }
}

function cloneHistoryRef(ref: ProjectHistoryRef | null): ProjectHistoryRef | null {
  if (!ref) return null
  return cloneRequiredHistoryRef(ref)
}

function cloneRequiredHistoryRef(ref: ProjectHistoryRef): ProjectHistoryRef {
  return {
    kind: ref.kind,
    jobId: ref.jobId,
    path: ref.path,
    frameCount: ref.frameCount,
    createdAt: ref.createdAt
  }
}

function shouldClearReplayReference(error: unknown): boolean {
  return error instanceof Error && error.message.includes('[file_read_error]')
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

async function loadCompletedHistoryReplay(
  jobId: NestingResult['jobId'],
  summary: NestingHistorySummary,
  context: string
): Promise<void> {
  history.completeRun(jobId, summary)
  const api = window.appApi
  if (!api || !summary.ndjsonPath) return
  try {
    const ref = cloneRequiredHistoryRef({
      kind: 'ndjson_replay',
      jobId,
      path: summary.ndjsonPath,
      frameCount: summary.frameCount,
      createdAt: new Date().toISOString()
    })
    const frames = await api.loadHistoryReplay(ref)
    for (const frame of frames) {
      history.pushFrame(frame)
    }
  } catch (error: unknown) {
    console.warn(`[history] failed to load replay for ${context}:`, error)
  }
}

function cloneCsvRunRecord(record: CsvRunRecord): CsvRunRecord {
  return {
    csvImportId: record.csvImportId,
    runId: record.runId,
    label: record.label,
    subRuns: record.subRuns.map(cloneSubRun),
    unplacedPieceIds: [...record.unplacedPieceIds],
    preparedPieces: record.preparedPieces.map(clonePreparedPiece),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
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

function mergePreparedPiecesById(
  previous: ReadonlyArray<PreparedPiece>,
  incoming: ReadonlyArray<PreparedPiece>
): PreparedPiece[] {
  const byId = new Map(previous.map((piece) => [piece.id, clonePreparedPiece(piece)]))
  for (const piece of incoming) {
    if (!byId.has(piece.id)) {
      byId.set(piece.id, clonePreparedPiece(piece))
    }
  }
  return [...byId.values()]
}

function normalizeIncomingSubRun(
  previous: NestingResult,
  incoming: NestingResult
): NestingSubRun | null {
  const subRun = incoming.runSummary?.subRuns[0]
  if (!subRun) return null
  const index = previous.runSummary?.subRuns.length ?? 0
  return {
    ...cloneSubRun(subRun),
    parentRunId: previous.jobId,
    index
  } as NestingSubRun
}

function aggregateNormalSubrunResult(
  previous: NestingResult,
  incoming: NestingResult
): NestingResult | null {
  const incomingSubRun = normalizeIncomingSubRun(previous, incoming)
  if (!incomingSubRun) return null

  const previousSubRuns = previous.runSummary?.subRuns.map(cloneSubRun) ?? []
  const subRuns = [...previousSubRuns, incomingSubRun]
  const requestPieceIds = new Set(incomingSubRun.requestPieceIds)
  const unplacedPieceIds = previous.unplacedPieceIds.filter(
    (pieceId) => !requestPieceIds.has(pieceId)
  )
  for (const pieceId of incoming.unplacedPieceIds) {
    if (!unplacedPieceIds.includes(pieceId)) {
      unplacedPieceIds.push(pieceId)
    }
  }

  const placements = [
    ...previous.placements.map(clonePlacement),
    ...incoming.placements.map(clonePlacement)
  ]
  const preparedPieces = mergePreparedPiecesById(
    previous.preparedPieces ?? [],
    incoming.preparedPieces ?? []
  )
  const elapsedMs = previous.stats.elapsedMs + incoming.stats.elapsedMs
  const algorithmElapsedMs = previous.stats.algorithm.elapsedMs + incoming.stats.algorithm.elapsedMs
  const selectedStrategyRunId =
    incoming.selectedStrategyRunId ?? incoming.strategyResults[0]?.strategyRunId
  const previousHistorySummary = previous.historySummary
  const incomingHistorySummary = incoming.historySummary
  const historySummary =
    previousHistorySummary || incomingHistorySummary
      ? ({
          frameCount:
            (previousHistorySummary?.frameCount ?? 0) + (incomingHistorySummary?.frameCount ?? 0),
          strategyRunCount: new Set([
            ...(previousHistorySummary?.strategyRunIds ?? []),
            ...(incomingHistorySummary?.strategyRunIds ?? [])
          ]).size,
          retainedFrameCount:
            (previousHistorySummary?.retainedFrameCount ?? 0) +
            (incomingHistorySummary?.retainedFrameCount ?? 0),
          truncated: Boolean(previousHistorySummary?.truncated || incomingHistorySummary?.truncated),
          scope: incomingHistorySummary?.scope ?? previousHistorySummary?.scope ?? 'winning_path',
          strategyRunIds: [
            ...new Set([
              ...(previousHistorySummary?.strategyRunIds ?? []),
              ...(incomingHistorySummary?.strategyRunIds ?? [])
            ])
          ],
          ...(incomingHistorySummary?.ndjsonPath
            ? { ndjsonPath: incomingHistorySummary.ndjsonPath }
            : previousHistorySummary?.ndjsonPath
              ? { ndjsonPath: previousHistorySummary.ndjsonPath }
              : {})
        } as NestingHistorySummary)
      : undefined
  const runSummary: NestingRunSummary = {
    runId: previous.runSummary?.runId ?? previous.jobId,
    subRuns,
    totalPlaced: placements.length,
    totalUnplaced: unplacedPieceIds.length,
    totalSheetAreaMm2: subRuns.reduce(
      (sum, subRun) => sum + subRun.sheet.width * subRun.sheet.height,
      0
    ),
    usedAreaMm2: placements.reduce((sum, placement) => sum + placement.width * placement.height, 0)
  } as NestingRunSummary

  return {
    version: 1,
    jobId: previous.jobId,
    status: unplacedPieceIds.length === 0 ? 'ok' : 'partial',
    strategyResults: [
      ...previous.strategyResults.map(cloneStrategyResult),
      ...incoming.strategyResults.map(cloneStrategyResult)
    ],
    ...(selectedStrategyRunId !== undefined ? { selectedStrategyRunId } : {}),
    sortedPieceIds: [...new Set([...previous.sortedPieceIds, ...incoming.sortedPieceIds])],
    placements,
    unplacedPieceIds,
    warnings: [
      ...previous.warnings.map((warning) => ({ ...warning })),
      ...incoming.warnings.map((warning) => ({ ...warning }))
    ],
    stats: {
      elapsedMs,
      pieceCount: preparedPieces.length,
      algorithm: {
        startedAt: previous.stats.algorithm.startedAt,
        endedAt: incoming.stats.algorithm.endedAt,
        elapsedMs: algorithmElapsedMs
      }
    },
    runSummary,
    preparedPieces,
    ...(historySummary !== undefined ? { historySummary } : {})
  } as NestingResult
}

function saveNormalRunRecord(result: NestingResult, request: NestingRequest): void {
  const createdAt = normalSubrunSession?.createdAt ?? new Date().toISOString()
  const sheet = normalSubrunSession?.sheet ?? cloneSheet(request.sheet)
  const pieceCount = result.preparedPieces?.length ?? request.pieces.length
  history.addRunRecord({
    jobId: result.jobId,
    createdAt,
    label: result.strategyResults[0]?.strategyLabel ?? `Run ${result.jobId}`,
    pieceCount,
    sheet,
    result,
    history: history.state.value.lastHistoryRef
  } as ProjectRunRecordModel)
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
  normalSubrunSession = {
    createdAt: new Date().toISOString(),
    sheet: cloneSheet(request.sheet)
  }
  centerView.value = 'result'
  await runner.start(request, {
    onHistoryFrame: (frame) => history.pushFrame(frame),
    onHistoryComplete: async (jobId, summary) => {
      await loadCompletedHistoryReplay(jobId, summary, 'completed run')
    },
    onResult: async (result) => {
      history.setResult(result)
      if (result.historySummary) {
        await loadCompletedHistoryReplay(result.jobId, result.historySummary, 'completed run')
      }
      saveNormalRunRecord(result, request)
      projectWarning.value =
        result.unplacedPieceIds.length > 0
          ? `${result.unplacedPieceIds.length} leftover piece(s). Use Run leftovers to start another plate.`
          : null
      await saveWorkspaceSettingsNow()
      finalSelection.syncFromResult(result)
    },
    onError: (message) => {
      console.error('[runner] error:', message)
    }
  })
}

function buildCsvSubrunRequest(
  csvImportId: string,
  subrunIndex: number,
  pieces: ReadonlyArray<PreparedPiece>,
  sheet: SheetSpec,
  padding: number,
  options: NestingOptions
): NestingRequest {
  return csvStore.startSubrun(csvImportId, subrunIndex, pieces, sheet, padding, options)
}

async function runCsvNestingRequest(request: NestingRequest, csvImportId: string): Promise<void> {
  await runner.start(request, {
    onHistoryFrame: (frame) => history.pushFrame(frame),
    onHistoryComplete: async (jobId, summary) => {
      await loadCompletedHistoryReplay(jobId, summary, 'CSV subrun')
    },
    onResult: async (result) => {
      if (result.historySummary) {
        await loadCompletedHistoryReplay(result.jobId, result.historySummary, 'CSV subrun')
      }
      csvStore.appendSubrunResult(csvImportId, result)
      const partialResult = csvStore.getSessionAggregatedResult(csvImportId)
      if (partialResult) {
        history.setResult(partialResult)
      }
      await saveWorkspaceSettingsNow()
      const session = csvStore.selectedSession.value
      if (session?.unplacedPieceIds.length === 0) {
        finalizeCsvSession(csvImportId)
      }
    },
    onError: (message) => {
      console.error('[csv-runner] error:', message)
    }
  })
}

async function runCsvSession(csvImportId: string): Promise<void> {
  const csv = csvStore.selectedCsv.value
  if (!csv || csv.id !== csvImportId) return

  const sourcePieces = new Map(
    store.state.value.pieces.map((piece) => [piece.id, piece] as [PieceId, typeof piece])
  )
  const prep = prepareCsvPieces(
    csv.rows,
    sourcePieces,
    csv.runConfiguration.defaultSheet,
    csv.runConfiguration.padding,
    JobId.make()
  )
  preparationWarnings.value = prep.warnings

  if (prep.pieces.length === 0) {
    projectWarning.value = 'No pieces to run. Link every CUT row to an available source shape.'
    return
  }

  const request = buildCsvSubrunRequest(
    csvImportId,
    0,
    prep.pieces,
    csv.runConfiguration.defaultSheet,
    csv.runConfiguration.padding,
    csv.runConfiguration.options
  )

  projectWarning.value = null
  history.clear()
  centerView.value = 'result'
  await runCsvNestingRequest(request, csvImportId)
}

async function startNextSubrun(
  csvImportId: string,
  sheet: SheetSpec,
  padding: number,
  options: NestingOptions
): Promise<void> {
  const session = csvStore.selectedSession.value
  if (!session || session.csvImportId !== csvImportId) return

  const remaining = store.computeRemainingPieces(session.unplacedPieceIds, session.preparedPieces)
  if (remaining.length === 0) {
    projectWarning.value = 'No remaining pieces for the next subrun.'
    return
  }

  const request = buildCsvSubrunRequest(
    csvImportId,
    session.subRuns.length,
    remaining,
    sheet,
    padding,
    options
  )
  await runCsvNestingRequest(request, csvImportId)
}

async function startNextNormalSubrun(): Promise<void> {
  const previous = history.result.value
  if (!previous || previous.csvImportId !== undefined) return
  const preparedPieces = previous.preparedPieces ?? []
  const remaining = store.computeRemainingPieces(previous.unplacedPieceIds, preparedPieces)
  if (remaining.length === 0) {
    projectWarning.value = 'No remaining pieces for the next subrun.'
    return
  }

  const sheet = settings.state.value.sheet
  if (sheet.width <= 0 || sheet.height <= 0) return
  const subRunIndex = previous.runSummary?.subRuns.length ?? 1
  const request: NestingRequest = {
    version: 1,
    jobId: previous.jobId,
    sheet: cloneSheet(sheet),
    padding: settings.state.value.padding,
    pieces: clonePreparedPieces(remaining),
    options: cloneOptions(settings.state.value.options),
    strategyRunId: `${previous.jobId}-subrun-${subRunIndex}`
  }

  projectWarning.value = null
  centerView.value = 'result'
  await runner.start(request, {
    onHistoryFrame: (frame) => history.pushFrame(frame),
    onHistoryComplete: async (jobId, summary) => {
      await loadCompletedHistoryReplay(jobId, summary, 'normal subrun')
    },
    onResult: async (result) => {
      if (result.historySummary) {
        await loadCompletedHistoryReplay(result.jobId, result.historySummary, 'normal subrun')
      }
      const aggregated = aggregateNormalSubrunResult(previous, result)
      if (!aggregated) return
      history.setResult(aggregated)
      saveNormalRunRecord(aggregated, request)
      projectWarning.value =
        aggregated.unplacedPieceIds.length > 0
          ? `${aggregated.unplacedPieceIds.length} leftover piece(s). Use Run leftovers to start another plate.`
          : null
      await saveWorkspaceSettingsNow()
      finalSelection.syncFromResult(aggregated)
    },
    onError: (message) => {
      console.error('[runner] error:', message)
    }
  })
}

function onStartNextSubrun(): void {
  if (history.result.value?.csvImportId !== undefined) {
    csvImportPanelRef.value?.openNextSubrunConfig()
    return
  }
  void startNextNormalSubrun()
}

function finalizeCsvSession(csvImportId: string): void {
  const finalized = csvStore.finalizeSession(csvImportId)
  if (!finalized) return
  history.setResult(finalized.result)
  finalSelection.syncFromResult(finalized.result)
}

async function importCsv(): Promise<void> {
  const api = window.appApi
  if (!api) return
  csvStore.clearImportFailures()
  try {
    const result = await api.selectCsvFiles()
    if (result.documents.length > 0) {
      csvStore.appendCsvImports(result.documents)
    }
    if (result.failures.length > 0) {
      const failures = result.failures.map((failure) => ({
        path: failure.path,
        message:
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error ?? 'unknown error')
      }))
      csvStore.setImportFailures(failures)
      console.warn('[app] CSV import completed with failures:', result.failures)
    }
  } catch (error: unknown) {
    console.error('[app] failed to import CSV:', error)
    csvStore.setImportFailures([
      { path: '', message: error instanceof Error ? error.message : String(error) }
    ])
  }
}

async function exportCsvResult(): Promise<void> {
  const api = window.appApi
  if (!api) return
  const csv = csvStore.selectedCsv.value
  if (!csv) return

  let record: CsvRunRecord | null = csvStore.activeCsvRunRecord.value
  if (!record && csvStore.selectedSession.value) {
    const finalized = csvStore.finalizeSession(csv.id)
    if (finalized) {
      record = finalized.csvRunRecord
      history.setResult(finalized.result)
      finalSelection.syncFromResult(finalized.result)
    }
  }
  if (!record) {
    console.warn('[app] no CSV run record available for export')
    return
  }

  try {
    if (record.unplacedPieceIds.length > 0) {
      projectWarning.value = `CSV export skipped ${record.unplacedPieceIds.length} unplaced piece(s).`
    } else {
      projectWarning.value = null
    }
    const path = await api.exportCsvResult(cloneCsvImport(csv), cloneCsvRunRecord(record))
    console.log('[app] exported CSV result to', path)
  } catch (error: unknown) {
    console.error('[app] failed to export CSV result:', error)
  }
}

async function exportHistory(): Promise<void> {
  const api = window.appApi
  if (!api) return
  const ref = history.state.value.lastHistoryRef
  if (!ref) {
    console.warn('No history ref available for export')
    return
  }
  await api.exportNestingHistory(cloneRequiredHistoryRef(ref))
}

async function exportResult(): Promise<void> {
  const api = window.appApi
  const result = history.result.value
  if (!api || !result) return
  await api.exportNestingResult(cloneResult(result))
}

function cancelJob(): void {
  runner.cancel()
}

async function saveProject(): Promise<void> {
  const api = window.appApi
  if (!api) return
  // compose a minimal ProjectDocument from the current session state.
  // phase 8 schema validation runs on the main process.
  const sourceFiles = store.state.value.documents.map((d) => ({
    id: d.id,
    path: d.path,
    fileName: d.fileName,
    available: true
  }))
  await api.saveProject({
    version: 2,
    savedAt: new Date().toISOString(),
    sourceFiles,
    importedPieces: [...store.state.value.pieces],
    importedDocuments: [...store.state.value.documents],
    sheet: cloneSheet(settings.state.value.sheet),
    padding: settings.state.value.padding,
    pieceQuantities: { ...store.state.value.pieceQuantities },
    options: cloneOptions(settings.state.value.options),
    runRecords: history.runRecords.value.map(cloneRunRecord),
    csvImports: csvStore.state.value.csvImports.map(cloneCsvImport),
    csvRunRecords: csvStore.getCsvRunRecords().map(cloneCsvRunRecord),
    ...(history.hasResult.value && history.result.value
      ? { lastResult: cloneResult(history.result.value) }
      : {}),
    ...(history.state.value.lastHistoryRef
      ? { lastHistory: cloneRequiredHistoryRef(history.state.value.lastHistoryRef) }
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
  csvStore.hydrateFromProject(project)
  store.setCsvImportsForCounting(csvStore.state.value.csvImports)
  finalSelection.hydrateFromProject(project)
  preparationWarnings.value = []

  if (project.csvImports && project.csvImports.length > 0) {
    try {
      await api.importCsvDocumentsFromProject(project.csvImports)
    } catch (error: unknown) {
      console.error('[app] failed to persist project CSV imports into workspace:', error)
    }
  }

  await loadCurrentHistoryReplay()
}

async function loadCurrentHistoryReplay(): Promise<void> {
  const api = window.appApi
  const ref = history.state.value.lastHistoryRef
  if (!api || !ref) return
  try {
    const frames = await api.loadHistoryReplay(cloneRequiredHistoryRef(ref))
    for (const frame of frames) {
      history.pushFrame(frame)
    }
  } catch (error: unknown) {
    console.warn('[history] failed to load current replay:', error)
    if (shouldClearReplayReference(error)) {
      history.clearRunRecordHistory(ref.jobId)
      await saveWorkspaceSettingsNow()
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
        :disabled="!csvStore.activeCsvRunRecord.value"
        :title="
          csvStore.activeCsvRunRecord.value
            ? 'Exports the selected CSV run in ABAS/CAMQUIX format.'
            : 'Exports the selected CSV run. Disabled until a CSV run has results.'
        "
        @click="exportCsvResult"
      >
        Export CSV Result
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
      <button
        type="button"
        title="Imports an ABAS/CAMQUIX cut-list CSV file into the project."
        @click="importCsv"
      >
        Import CSV
      </button>
    </template>

    <template #settings>
      <SheetSettingsPanel />
      <CsvImportPanel
        ref="csvImportPanelRef"
        @run-csv="runCsvSession"
        @start-subrun="startNextSubrun"
        @export-csv="() => exportCsvResult()"
      />
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
        <StrategyRunsPanel @start-next-subrun="onStartNextSubrun" />
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
        {{ store.csvLinkedPieceCount.value }} CSV-linked row(s) /
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
