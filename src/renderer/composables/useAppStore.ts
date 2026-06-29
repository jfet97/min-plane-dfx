import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type {
  DxfGeometrySummary,
  ImportedDxfDocument,
  ImportedPiece,
  ImportWarning
} from '@shared/domain/dxf.js'
import type { ProjectDocument } from '@shared/domain/project.js'
import { PieceId } from '@shared/domain/ids.js'

export interface ImportFailure {
  readonly path: string
  readonly code: 'file_read_error' | 'dxf_parse_error' | 'unknown_error'
  readonly message: string
}

interface MutableAppState {
  documents: ImportedDxfDocument[]
  pieces: ImportedPiece[]
  selectedPieceIds: string[]
  pieceQuantities: Record<string, number>
  warnings: ImportWarning[]
  failures: ImportFailure[]
  isImporting: boolean
  importRevision: number
  lastSkippedDuplicateCount: number
}

const state: UnwrapNestedRefs<MutableAppState> = reactive<MutableAppState>({
  documents: [],
  pieces: [],
  selectedPieceIds: [],
  pieceQuantities: {},
  warnings: [],
  failures: [],
  isImporting: false,
  importRevision: 0,
  lastSkippedDuplicateCount: 0
})

function normalizePath(path: string): string {
  return path.trim()
}

function knownPaths(): Set<string> {
  return new Set(state.documents.map((document) => normalizePath(document.path)))
}

function unionBounds(pieces: ReadonlyArray<ImportedPiece>): ImportedPiece['realBounds'] | null {
  if (pieces.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const piece of pieces) {
    const bounds = piece.realBounds
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function documentObjectPiece(document: ImportedDxfDocument): ImportedPiece | null {
  if (document.pieces.length === 0) return null
  if (document.pieces.length === 1) {
    const only = document.pieces[0]
    return only ?? null
  }
  const bounds = unionBounds(document.pieces)
  if (!bounds) return null
  const firstPiece = document.pieces[0]
  if (!firstPiece) return null
  const entityTypes = new Set(document.pieces.map((piece) => piece.geometry.entityType))
  const segments: DxfGeometrySummary['segments'] = document.pieces.flatMap(
    (piece) => piece.geometry.segments
  )
  return {
    id: firstPiece.id,
    sourceFileId: document.id,
    sourceLayer: 'multiple',
    label: document.fileName.replace(/\.dxf$/i, ''),
    realBounds: bounds,
    geometry: {
      entityType:
        document.pieces.length === 1 && entityTypes.size === 1
          ? firstPiece.geometry.entityType
          : 'DXF_SHAPE',
      closed: segments.length > 0,
      segments
    },
    warnings: document.pieces.flatMap((piece) => piece.warnings)
  }
}

function appendDocuments(documents: ReadonlyArray<ImportedDxfDocument>): void {
  if (documents.length === 0) return
  const paths = knownPaths()
  const next: ImportedDxfDocument[] = []
  let skipped = 0
  for (const document of documents) {
    const path = normalizePath(document.path)
    if (paths.has(path)) {
      skipped++
      continue
    }
    paths.add(path)
    next.push(document)
  }
  state.lastSkippedDuplicateCount = skipped
  if (next.length === 0) return
  state.documents = [...state.documents, ...next]
  recomputeAggregates()
  state.importRevision++
}

function appendPresetDocument(document: ImportedDxfDocument): void {
  state.documents = [...state.documents, document]
  recomputeAggregates()
  const piece = documentObjectPiece(document)
  if (piece) {
    setPieceQuantity(piece.id, 1)
  }
  state.importRevision++
}

function replaceImportedDocuments(documents: ReadonlyArray<ImportedDxfDocument>): void {
  state.documents = [...documents]
  state.failures = []
  state.lastSkippedDuplicateCount = 0
  recomputeAggregates()
  state.importRevision++
}

function recomputeAggregates(): void {
  const allPieces: ImportedPiece[] = []
  const allWarnings: ImportWarning[] = []
  for (const doc of state.documents) {
    const piece = documentObjectPiece(doc)
    if (piece) allPieces.push(piece)
    for (const w of doc.warnings) allWarnings.push(w)
  }
  state.pieces = allPieces
  state.warnings = allWarnings

  const nextQuantities: Record<string, number> = {}
  for (const piece of allPieces) {
    nextQuantities[piece.id] = state.pieceQuantities[piece.id] ?? 1
  }
  state.pieceQuantities = nextQuantities
  state.selectedPieceIds = allPieces
    .filter((piece) => (nextQuantities[piece.id] ?? 0) > 0)
    .map((piece) => piece.id)
}

async function loadPersistedImports(): Promise<void> {
  const api = window.appApi
  if (!api) return
  state.isImporting = true
  try {
    const documents = await api.listImportedDxfs()
    replaceImportedDocuments(documents)
  } finally {
    state.isImporting = false
  }
}

async function importPaths(paths: ReadonlyArray<string>): Promise<void> {
  const api = window.appApi
  if (!api || paths.length === 0) return
  state.isImporting = true
  try {
    const freshPaths = paths.filter((path) => !knownPaths().has(normalizePath(path)))
    state.lastSkippedDuplicateCount = paths.length - freshPaths.length
    if (freshPaths.length === 0) return
    const imported = await api.importDxfFiles(freshPaths)
    appendDocuments(imported)
  } finally {
    state.isImporting = false
  }
}

async function selectAndImport(): Promise<void> {
  const api = window.appApi
  if (!api) return
  state.isImporting = true
  try {
    const docs = await api.selectDxfFiles()
    if (docs.length > 0) {
      appendDocuments(docs)
    } else {
      state.lastSkippedDuplicateCount = 0
    }
  } finally {
    state.isImporting = false
  }
}

async function clear(): Promise<void> {
  const api = window.appApi
  if (api) {
    await api.clearImportedDxfs()
  }
  state.documents = []
  state.pieces = []
  state.selectedPieceIds = []
  state.pieceQuantities = {}
  state.warnings = []
  state.failures = []
  state.importRevision++
  state.lastSkippedDuplicateCount = 0
}

async function removePiece(pieceId: ImportedPiece['id']): Promise<void> {
  const api = window.appApi
  if (api) {
    await api.removeImportedDxf(pieceId)
  }
  let changed = false
  state.documents = state.documents.filter((document) => {
    const objectPiece = documentObjectPiece(document)
    const keep =
      objectPiece?.id !== pieceId && !document.pieces.some((piece) => piece.id === pieceId)
    if (!keep) changed = true
    return keep
  })
  if (!changed) return
  delete state.pieceQuantities[pieceId]
  recomputeAggregates()
  state.importRevision++
}

function hydrateFromProject(project: ProjectDocument): void {
  state.documents = [...(project.importedDocuments ?? [])]
  if (project.importedDocuments !== undefined) {
    recomputeAggregates()
  } else {
    state.pieces = [...project.importedPieces]
    state.warnings = project.importedPieces.flatMap((piece) => piece.warnings)
  }
  state.pieceQuantities = {}
  for (const piece of state.pieces) {
    state.pieceQuantities[piece.id] = project.pieceQuantities?.[piece.id] ?? 1
  }
  state.selectedPieceIds = state.pieces
    .filter((piece) => getPieceQuantity(piece.id) > 0)
    .map((piece) => piece.id)
  state.failures = []
  state.isImporting = false
  state.lastSkippedDuplicateCount = 0
}

function isPieceSelected(pieceId: ImportedPiece['id']): boolean {
  return getPieceQuantity(pieceId) > 0
}

function setPieceSelected(pieceId: ImportedPiece['id'], selected: boolean): void {
  const exists = state.pieces.some((piece) => piece.id === pieceId)
  if (!exists) return
  const current = new Set(state.selectedPieceIds)
  if (selected) {
    current.add(pieceId)
  } else {
    current.delete(pieceId)
  }
  state.selectedPieceIds = [...current]
  state.pieceQuantities[pieceId] = selected ? Math.max(1, state.pieceQuantities[pieceId] ?? 1) : 0
}

function setAllPiecesSelected(selected: boolean): void {
  state.selectedPieceIds = selected ? state.pieces.map((piece) => piece.id) : []
  for (const piece of state.pieces) {
    state.pieceQuantities[piece.id] = selected
      ? Math.max(1, state.pieceQuantities[piece.id] ?? 1)
      : 0
  }
}

function getPieceQuantity(pieceId: ImportedPiece['id']): number {
  return Math.max(0, Math.floor(state.pieceQuantities[pieceId] ?? 0))
}

function setPieceQuantity(pieceId: ImportedPiece['id'], quantity: number): void {
  const exists = state.pieces.some((piece) => piece.id === pieceId)
  if (!exists) return
  const next = Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0
  state.pieceQuantities[pieceId] = next
  setPieceSelected(pieceId, next > 0)
}

function requestCopies(piece: ImportedPiece): ReadonlyArray<ImportedPiece> {
  const quantity = getPieceQuantity(piece.id)
  return Array.from({ length: quantity }, (_, index) => ({
    ...piece,
    id: PieceId.make(`${piece.id}-copy-${index + 1}`),
    label: quantity === 1 ? piece.label : `${piece.label} #${index + 1}`
  }))
}

export function useAppStore() {
  return {
    state: computed(() => state),
    documentCount: computed(() => state.documents.length),
    pieceCount: computed(() => state.pieces.length),
    selectedSourcePieceCount: computed(
      () => state.pieces.filter((piece) => isPieceSelected(piece.id)).length
    ),
    selectedPieceCount: computed(() =>
      state.pieces.reduce((total, piece) => total + getPieceQuantity(piece.id), 0)
    ),
    selectedPieces: computed(() => state.pieces.flatMap((piece) => requestCopies(piece))),
    importRevision: computed(() => state.importRevision),
    warningCount: computed(() => state.warnings.length),
    selectAndImport,
    importPaths,
    appendPresetDocument,
    loadPersistedImports,
    replaceImportedDocuments,
    hydrateFromProject,
    isPieceSelected,
    setPieceSelected,
    getPieceQuantity,
    setPieceQuantity,
    setAllPiecesSelected,
    removePiece,
    clear
  }
}
