import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import { Schema } from 'effect'
import { JobId, PieceId } from '@shared/domain/ids.js'
import type { ImportedPiece } from '@shared/domain/dxf.js'
import type {
  AlgorithmBenchmark,
  NestingOptions,
  NestingLayout,
  NestingRequest,
  NestingResult,
  NestingStats,
  NestingStrategyResult,
  Placement,
  PreparedPiece,
  SheetSpec
} from '@shared/domain/nesting.js'
import type { IrregularPlacement } from '@shared/irregular/domain.js'
import {
  NestingLayout as NestingLayoutSchema,
  NestingRunSummary as NestingRunSummaryModel,
  NestingResult as NestingResultModel,
  NestingStrategyResult as NestingStrategyResultModel,
  NestingStats as NestingStatsModel,
  NestingSubRun,
  PreparedPiece as PreparedPieceModel,
  AlgorithmBenchmark as AlgorithmBenchmarkModel
} from '@shared/domain/nesting.js'
import {
  CsvCutRow as CsvCutRowModel,
  CsvRunRecord as CsvRunRecordModel,
  ProjectCsvImport as ProjectCsvImportModel,
  ProjectRunConfiguration as ProjectRunConfigurationModel,
  type CsvCutRow,
  type CsvRunRecord,
  type ProjectCsvImport,
  type ProjectDocument,
  type ProjectRunConfiguration,
  type WorkspaceProjectSettings
} from '@shared/domain/project.js'

/**
 * A transient run session for one imported CSV. Holds the subrun history, the
 * current set of unplaced pieces, and the prepared piece list used to map
 * placements back to CSV metadata.
 */
export interface CsvRunSession {
  csvImportId: string
  runId: string
  label: string
  subRuns: NestingSubRun[]
  unplacedPieceIds: PieceId[]
  preparedPieces: PreparedPiece[]
  /** Pieces most recently submitted to the worker for the current subrun. */
  currentRequestPieces?: PreparedPiece[]
  currentRequestSheet?: SheetSpec
  currentRequestPadding?: number
  currentRequestOptions?: NestingOptions
  createdAt: string
  updatedAt: string
}

export interface CsvImportFailure {
  path: string
  message: string
}

interface MutableCsvImportState {
  csvImports: ProjectCsvImport[]
  selectedCsvId: string | null
  activeSessions: Map<string, CsvRunSession>
  csvRunRecords: CsvRunRecord[]
  importFailures: CsvImportFailure[]
}

type WorkspaceSettingsPersistor = () => void

type RunConfigurationPatch = Partial<
  Pick<ProjectRunConfiguration, 'defaultSheet' | 'padding' | 'options' | 'label' | 'materialFilter'>
>

let workspaceSettingsPersistor: WorkspaceSettingsPersistor | null = null

const state: UnwrapNestedRefs<MutableCsvImportState> = reactive<MutableCsvImportState>({
  csvImports: [],
  selectedCsvId: null,
  activeSessions: new Map(),
  csvRunRecords: [],
  importFailures: []
})

function notifyWorkspaceSettingsChanged(): void {
  workspaceSettingsPersistor?.()
}

function nowIso(): string {
  return new Date().toISOString()
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
    allowGlobalMirror: options.allowGlobalMirror ?? true,
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
      : {}),
    ...(options.irregularSettings !== undefined
      ? { irregularSettings: options.irregularSettings }
      : {})
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

function cloneIrregularPlacement(placement: IrregularPlacement): IrregularPlacement {
  return {
    ...(placement.pieceId !== undefined ? { pieceId: placement.pieceId } : {}),
    sourcePieceId: placement.sourcePieceId,
    ...(placement.placementReference !== undefined
      ? {
          placementReference: {
            x: placement.placementReference.x,
            y: placement.placementReference.y
          }
        }
      : {}),
    transform: {
      translateX: placement.transform.translateX,
      translateY: placement.transform.translateY,
      rotationDeg: placement.transform.rotationDeg,
      mirrored: placement.transform.mirrored
    }
  }
}

function cloneLayout(layout: NestingLayout): NestingLayout {
  const cloned =
    layout.kind === 'rectangular'
      ? {
          kind: 'rectangular' as const,
          placements: layout.placements.map(clonePlacement),
          unplacedPieceIds: [...layout.unplacedPieceIds]
        }
      : {
          kind: 'irregular' as const,
          placements: layout.placements.map(cloneIrregularPlacement),
          ...(layout.collisionPolygons !== undefined
            ? {
                collisionPolygons: layout.collisionPolygons.map((polygon) => ({
                  points: polygon.points.map((point) => ({ x: point.x, y: point.y }))
                }))
              }
            : {}),
          unplacedPieceIds: [...layout.unplacedPieceIds],
          score: { ...layout.score },
          source: layout.source,
          status: layout.status,
          diagnostics: layout.diagnostics.map((diagnostic) => ({ ...diagnostic }))
        }
  return Schema.decodeUnknownSync(NestingLayoutSchema)(cloned)
}

function clonePreparedPiece(piece: PreparedPiece): PreparedPiece {
  return new PreparedPieceModel({
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
    allowMirror: piece.allowMirror ?? true,
    ...(piece.interchangeabilityKey !== undefined
      ? { interchangeabilityKey: piece.interchangeabilityKey }
      : {}),
    ...(piece.cutRowRef !== undefined ? { cutRowRef: { ...piece.cutRowRef } } : {})
  })
}

function clonePreparedPieces(pieces: ReadonlyArray<PreparedPiece>): PreparedPiece[] {
  return pieces.map(clonePreparedPiece)
}

function mergePreparedPieces(
  existing: ReadonlyArray<PreparedPiece>,
  incoming: ReadonlyArray<PreparedPiece>
): PreparedPiece[] {
  const byId = new Map(existing.map((piece) => [piece.id, clonePreparedPiece(piece)]))
  for (const piece of incoming) {
    if (!byId.has(piece.id)) {
      byId.set(piece.id, clonePreparedPiece(piece))
    }
  }
  return [...byId.values()]
}

function createSession(csvImportId: string, label: string): CsvRunSession {
  const createdAt = nowIso()
  return {
    csvImportId,
    runId: csvImportId,
    label,
    subRuns: [],
    unplacedPieceIds: [],
    preparedPieces: [],
    createdAt,
    updatedAt: createdAt
  }
}

function getOrCreateSession(csvImportId: string): CsvRunSession {
  const existing = state.activeSessions.get(csvImportId)
  if (existing) return existing
  const csvImport = state.csvImports.find((csv) => csv.id === csvImportId)
  const label = csvImport?.runConfiguration.label ?? `CSV run ${csvImportId}`
  const session = createSession(csvImportId, label)
  state.activeSessions.set(csvImportId, session)
  return session
}

function findCsvImport(csvImportId: string): ProjectCsvImport | undefined {
  return state.csvImports.find((csv) => csv.id === csvImportId)
}

function findCutRow(csvImport: ProjectCsvImport, rowId: string): CsvCutRow | undefined {
  return csvImport.rows.find((row) => row.id === rowId)
}

async function persistCsvImport(csvImport: ProjectCsvImport): Promise<void> {
  const api = window.appApi
  if (!api) return
  try {
    await api.updateImportedCsv(csvImport)
  } catch (error: unknown) {
    console.error('[csv-import] failed to persist CSV import:', error)
  }
}

function sessionToRunRecord(session: CsvRunSession): CsvRunRecord {
  return new CsvRunRecordModel({
    csvImportId: session.csvImportId,
    runId: session.runId,
    label: session.label,
    subRuns: [...session.subRuns],
    unplacedPieceIds: [...session.unplacedPieceIds],
    preparedPieces: clonePreparedPieces(session.preparedPieces),
    createdAt: session.createdAt,
    updatedAt: nowIso()
  })
}

function getAllCsvRunRecords(): CsvRunRecord[] {
  const activeIds = new Set(state.activeSessions.keys())
  const finalized = state.csvRunRecords.filter((record) => !activeIds.has(record.csvImportId))
  const active = [...state.activeSessions.values()].map(sessionToRunRecord)
  return [...finalized, ...active]
}

function buildSyntheticAlgorithmBenchmark(session: CsvRunSession): AlgorithmBenchmark {
  return new AlgorithmBenchmarkModel({
    startedAt: session.createdAt,
    endedAt: nowIso(),
    elapsedMs: 0
  })
}

function buildSyntheticStats(pieceCount: number, algorithm: AlgorithmBenchmark): NestingStats {
  return new NestingStatsModel({
    elapsedMs: 0,
    pieceCount,
    algorithm
  })
}

function buildSyntheticStrategyResult(
  subRun: NestingSubRun,
  _index: number,
  session: CsvRunSession
): NestingStrategyResult {
  const status = subRun.unplacedPieceIds.length === 0 ? 'completed' : 'partial'
  const algorithm = buildSyntheticAlgorithmBenchmark(session)
  return new NestingStrategyResultModel({
    strategyRunId: subRun.subRunId,
    strategyId: strategyIdForSubRun(subRun),
    strategyLabel: `Subrun ${subRun.index + 1}`,
    status,
    sortedPieceIds: [...subRun.requestPieceIds],
    placements: subRun.placements.map(clonePlacement),
    unplacedPieceIds: [...subRun.unplacedPieceIds],
    ...(subRun.layout !== undefined ? { layout: cloneLayout(subRun.layout) } : {}),
    stats: buildSyntheticStats(subRun.requestPieceIds.length, algorithm),
    warnings: []
  })
}

function strategyIdForSubRun(subRun: NestingSubRun): string {
  if (subRun.layout?.kind !== 'irregular') return 'maxrects-beam-search'
  if (subRun.layout.source !== 'shared-archive') return 'irregular-convex-windowed-beam'
  return subRun.options.irregularSettings?.optimizer.intrinsicObjectiveProfileId === 'short-side'
    ? 'irregular-convex-compact-short-side'
    : 'irregular-convex-shared-archive'
}

function buildAggregatedResult(session: CsvRunSession, csvImportId: string): NestingResult {
  const runId = session.runId
  const placements = session.subRuns.flatMap((subRun) => subRun.placements.map(clonePlacement))
  const unplacedPieceIds = [...session.unplacedPieceIds]
  const strategyResults = session.subRuns.map((subRun, index) =>
    buildSyntheticStrategyResult(subRun, index, session)
  )
  const sortedPieceIds = [...new Set(strategyResults.flatMap((result) => result.sortedPieceIds))]

  const totalPlaced = session.subRuns.reduce(
    (sum, subRun) =>
      sum +
      (subRun.layout?.kind === 'irregular'
        ? subRun.layout.placements.length
        : subRun.placements.length),
    0
  )
  const totalSheetAreaMm2 = session.subRuns.reduce(
    (sum, subRun) => sum + subRun.sheet.width * subRun.sheet.height,
    0
  )
  const usedAreaMm2 = session.subRuns.reduce(
    (sum, subRun) =>
      sum +
      (subRun.layout?.kind === 'irregular'
        ? subRun.layout.score.collisionBoundsAreaMm2
        : subRun.placements.reduce((area, placement) => area + placement.width * placement.height, 0)),
    0
  )

  const runSummary = new NestingRunSummaryModel({
    runId,
    subRuns: [...session.subRuns],
    totalPlaced,
    totalUnplaced: unplacedPieceIds.length,
    totalSheetAreaMm2,
    usedAreaMm2
  })

  const algorithm = buildSyntheticAlgorithmBenchmark(session)
  const stats = buildSyntheticStats(session.preparedPieces.length, algorithm)

  return new NestingResultModel({
    version: 1,
    jobId: JobId.make(),
    status: unplacedPieceIds.length === 0 ? 'ok' : 'partial',
    strategyResults,
    sortedPieceIds,
    placements,
    unplacedPieceIds,
    ...(session.subRuns.length === 1 && session.subRuns[0]?.layout !== undefined
      ? { layout: cloneLayout(session.subRuns[0].layout) }
      : {}),
    runSummary,
    preparedPieces: clonePreparedPieces(session.preparedPieces),
    csvImportId,
    stats,
    warnings: []
  })
}

function getSessionAggregatedResult(csvImportId: string): NestingResult | null {
  const session = state.activeSessions.get(csvImportId)
  if (!session || session.subRuns.length === 0) return null
  return buildAggregatedResult(session, csvImportId)
}

function setImportFailures(failures: ReadonlyArray<CsvImportFailure>): void {
  state.importFailures = [...failures]
}

function clearImportFailures(): void {
  state.importFailures = []
}

function appendCsvImports(imports: ReadonlyArray<ProjectCsvImport>): void {
  if (imports.length === 0) return
  const byId = new Map(state.csvImports.map((csv) => [csv.id, csv]))
  for (const csv of imports) {
    byId.set(csv.id, csv)
  }
  state.csvImports = [...byId.values()]
  if (
    state.selectedCsvId === null ||
    !state.csvImports.some((csv) => csv.id === state.selectedCsvId)
  ) {
    state.selectedCsvId = imports[0]?.id ?? null
    notifyWorkspaceSettingsChanged()
  }
}

function replaceCsvImports(imports: ReadonlyArray<ProjectCsvImport>): void {
  state.csvImports = [...imports]
  if (
    state.selectedCsvId === null ||
    !state.csvImports.some((csv) => csv.id === state.selectedCsvId)
  ) {
    state.selectedCsvId = state.csvImports[0]?.id ?? null
    notifyWorkspaceSettingsChanged()
  }
}

function hydrateSessionsFromRecords(records: ReadonlyArray<CsvRunRecord>): void {
  for (const record of records) {
    // only restore in-progress sessions that still have leftovers to place.
    // completed records live in csvRunRecords and are surfaced through
    // activeCsvRunRecord for export.
    if (record.unplacedPieceIds.length === 0) continue
    const session: CsvRunSession = {
      csvImportId: record.csvImportId,
      runId: record.runId,
      label: record.label,
      subRuns: [...record.subRuns],
      unplacedPieceIds: [...record.unplacedPieceIds],
      preparedPieces: clonePreparedPieces(record.preparedPieces),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }
    state.activeSessions.set(record.csvImportId, session)
  }
  /* Remove active records from the persisted list; getAllCsvRunRecords adds
   * live sessions back so keeping both would duplicate them. */
  state.csvRunRecords = state.csvRunRecords.filter((record) => record.unplacedPieceIds.length === 0)
}

function hydrateFromProject(project: ProjectDocument): void {
  state.csvImports = [...(project.csvImports ?? [])]
  state.csvRunRecords = [...(project.csvRunRecords ?? [])]
  state.activeSessions.clear()
  hydrateSessionsFromRecords(state.csvRunRecords)
}

function hydrateFromWorkspace(settings: WorkspaceProjectSettings): void {
  state.selectedCsvId = settings.selectedCsvId ?? null
  state.csvRunRecords = [...(settings.csvRunRecords ?? [])]
  state.activeSessions.clear()
  hydrateSessionsFromRecords(state.csvRunRecords)
}

async function linkRowToPiece(
  csvImportId: string,
  rowId: string,
  pieceId: PieceId | undefined
): Promise<void> {
  const csvImport = findCsvImport(csvImportId)
  if (!csvImport) return
  const row = findCutRow(csvImport, rowId)
  if (!row) return

  const nextRows = csvImport.rows.map((existing) =>
    existing.id === rowId
      ? new CsvCutRowModel({
          id: existing.id,
          reference: existing.reference,
          customerName: existing.customerName,
          amount: existing.amount,
          linkedPieceId: pieceId
        })
      : existing
  )

  const next = new ProjectCsvImportModel({
    id: csvImport.id,
    sourcePath: csvImport.sourcePath,
    fileName: csvImport.fileName,
    materialCode: csvImport.materialCode,
    materialDescription: csvImport.materialDescription,
    thicknessMm: csvImport.thicknessMm,
    rows: nextRows,
    runConfiguration: csvImport.runConfiguration,
    ...(csvImport.jobDate !== undefined ? { jobDate: csvImport.jobDate } : {})
  })

  const nextIndex = state.csvImports.findIndex((csv) => csv.id === csvImportId)
  if (nextIndex >= 0) {
    state.csvImports[nextIndex] = next
  }
  await persistCsvImport(next)
}

async function updateRunConfiguration(
  csvImportId: string,
  patch: RunConfigurationPatch
): Promise<void> {
  const csvImport = findCsvImport(csvImportId)
  if (!csvImport) return

  const nextRunConfiguration = new ProjectRunConfigurationModel({
    runId: csvImport.runConfiguration.runId,
    label: patch.label ?? csvImport.runConfiguration.label,
    defaultSheet: patch.defaultSheet ?? cloneSheet(csvImport.runConfiguration.defaultSheet),
    padding: patch.padding ?? csvImport.runConfiguration.padding,
    options: patch.options ?? cloneOptions(csvImport.runConfiguration.options),
    ...(patch.materialFilter !== undefined
      ? { materialFilter: patch.materialFilter }
      : csvImport.runConfiguration.materialFilter !== undefined
        ? { materialFilter: csvImport.runConfiguration.materialFilter }
        : {})
  })

  const next = new ProjectCsvImportModel({
    id: csvImport.id,
    sourcePath: csvImport.sourcePath,
    fileName: csvImport.fileName,
    materialCode: csvImport.materialCode,
    materialDescription: csvImport.materialDescription,
    thicknessMm: csvImport.thicknessMm,
    rows: csvImport.rows,
    runConfiguration: nextRunConfiguration,
    ...(csvImport.jobDate !== undefined ? { jobDate: csvImport.jobDate } : {})
  })

  const nextIndex = state.csvImports.findIndex((csv) => csv.id === csvImportId)
  if (nextIndex >= 0) {
    state.csvImports[nextIndex] = next
  }
  await persistCsvImport(next)
}

function selectCsv(id: string | null): void {
  state.selectedCsvId = id
  notifyWorkspaceSettingsChanged()
}

function startSubrun(
  csvImportId: string,
  subrunIndex: number,
  pieces: ReadonlyArray<PreparedPiece>,
  sheet: SheetSpec,
  padding: number,
  options: NestingOptions,
  sourcePieces: ReadonlyArray<ImportedPiece> = []
): NestingRequest {
  const session = getOrCreateSession(csvImportId)
  const clonedPieces = clonePreparedPieces(pieces)

  // a fresh run always starts at subrun 0. Reset any stale state left by a
  // previous session so the user can rerun the same CSV without restarting the
  // app or switching projects.
  if (subrunIndex === 0) {
    session.subRuns = []
    session.unplacedPieceIds = []
    session.preparedPieces = []
  }

  session.currentRequestPieces = clonedPieces
  session.currentRequestSheet = cloneSheet(sheet)
  session.currentRequestPadding = padding
  session.currentRequestOptions = cloneOptions(options)
  session.preparedPieces = mergePreparedPieces(session.preparedPieces, clonedPieces)
  session.updatedAt = nowIso()

  return {
    version: 1,
    jobId: JobId.make(),
    sheet: cloneSheet(sheet),
    padding,
    pieces: clonedPieces,
    sourcePieces,
    options: cloneOptions(options),
    strategyRunId: `${session.runId}-subrun-${subrunIndex}`
  }
}

function appendSubrunResult(csvImportId: string, result: NestingResult): void {
  const session = state.activeSessions.get(csvImportId)
  if (!session) return
  const previousUnplacedPieceIds = [...session.unplacedPieceIds]
  const summary = result.runSummary
  const subRun = summary?.subRuns[0] ?? makeSubRunFromResult(session, result)
  if (!subRun) return
  // the worker always reports subRun.index = 0 because each subrun is a fresh
  // worker request. Override it with the session position so the runs panel and
  // export emit subruns in the correct order.
  const indexedSubRun = new NestingSubRun({
    ...subRun,
    ...(subRun.layout !== undefined ? { layout: cloneLayout(subRun.layout) } : {}),
    parentRunId: session.runId,
    index: session.subRuns.length
  })
  const requestPieceIds = new Set(indexedSubRun.requestPieceIds)
  const nextUnplacedPieceIds = previousUnplacedPieceIds.filter(
    (pieceId) => !requestPieceIds.has(pieceId)
  )
  for (const pieceId of result.unplacedPieceIds) {
    if (!nextUnplacedPieceIds.includes(pieceId)) {
      nextUnplacedPieceIds.push(pieceId)
    }
  }
  session.subRuns.push(indexedSubRun)
  session.unplacedPieceIds = nextUnplacedPieceIds
  if (result.preparedPieces !== undefined && result.preparedPieces.length > 0) {
    session.preparedPieces = mergePreparedPieces(session.preparedPieces, result.preparedPieces)
  }
  session.updatedAt = nowIso()
  notifyWorkspaceSettingsChanged()
}

function makeSubRunFromResult(session: CsvRunSession, result: NestingResult): NestingSubRun | null {
  const sheet = session.currentRequestSheet
  const padding = session.currentRequestPadding
  const options = session.currentRequestOptions
  if (sheet === undefined || padding === undefined || options === undefined) return null
  const layout = result.layout ?? result.strategyResults[0]?.layout
  const requestPieceIds = session.currentRequestPieces?.map((piece) => piece.id) ?? []
  return new NestingSubRun({
    subRunId: result.selectedStrategyRunId ?? `${session.runId}-subrun-${session.subRuns.length}`,
    parentRunId: session.runId,
    index: 0,
    sheet,
    padding,
    options,
    placements: result.placements,
    unplacedPieceIds: result.unplacedPieceIds,
    ...(layout !== undefined ? { layout: cloneLayout(layout) } : {}),
    pieceIds: requestPieceIds,
    requestPieceIds
  })
}

function finalizeSession(
  csvImportId: string
): { result: NestingResult; csvRunRecord: CsvRunRecord } | null {
  const session = state.activeSessions.get(csvImportId)
  if (!session) return null
  const result = buildAggregatedResult(session, csvImportId)
  const csvRunRecord = sessionToRunRecord(session)
  const existingIndex = state.csvRunRecords.findIndex(
    (record) => record.csvImportId === csvImportId
  )
  if (existingIndex >= 0) {
    state.csvRunRecords[existingIndex] = csvRunRecord
  } else {
    state.csvRunRecords.push(csvRunRecord)
  }
  state.activeSessions.delete(csvImportId)
  notifyWorkspaceSettingsChanged()
  return { result, csvRunRecord }
}

function removeCsvImport(id: string): void {
  const next = state.csvImports.filter((csv) => csv.id !== id)
  if (next.length === state.csvImports.length) return
  state.csvImports = next
  state.activeSessions.delete(id)
  state.csvRunRecords = state.csvRunRecords.filter((record) => record.csvImportId !== id)
  if (state.selectedCsvId === id) {
    state.selectedCsvId = next[0]?.id ?? null
  }
  notifyWorkspaceSettingsChanged()
}

function clear(): void {
  state.csvImports = []
  state.selectedCsvId = null
  state.activeSessions.clear()
  state.csvRunRecords = []
  state.importFailures = []
  notifyWorkspaceSettingsChanged()
}

export function useCsvImportStore() {
  return {
    state: computed(() => state),
    selectedCsv: computed(() =>
      state.selectedCsvId
        ? (state.csvImports.find((csv) => csv.id === state.selectedCsvId) ?? null)
        : null
    ),
    selectedSession: computed(() =>
      state.selectedCsvId ? (state.activeSessions.get(state.selectedCsvId) ?? null) : null
    ),
    activeCsvRunRecord: computed(() => {
      const session = state.selectedCsvId
        ? (state.activeSessions.get(state.selectedCsvId) ?? null)
        : null
      if (session) return sessionToRunRecord(session)
      return (
        state.csvRunRecords.find((record) => record.csvImportId === state.selectedCsvId) ?? null
      )
    }),

    csvRunRecords: computed(() => getAllCsvRunRecords()),

    setWorkspaceSettingsPersistor(persistor: WorkspaceSettingsPersistor | null): void {
      workspaceSettingsPersistor = persistor
    },

    appendCsvImports,
    replaceCsvImports,
    hydrateFromProject,
    hydrateFromWorkspace,
    linkRowToPiece,
    updateRunConfiguration,
    selectCsv,
    startSubrun,
    appendSubrunResult,
    getSessionAggregatedResult,
    finalizeSession,
    removeCsvImport,
    clear,
    setImportFailures,
    clearImportFailures,

    getCsvRunRecords(): CsvRunRecord[] {
      return getAllCsvRunRecords()
    }
  }
}
