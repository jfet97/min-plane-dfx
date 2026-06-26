import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type {
  DxfGeometrySummary,
  ImportedDxfDocument,
  ImportedPiece,
  ImportWarning
} from '@shared/domain/dxf.js'
import type { ProjectDocument } from '@shared/domain/project.js'

export interface ImportFailure {
  readonly path: string
  readonly code: 'file_read_error' | 'dxf_parse_error' | 'unknown_error'
  readonly message: string
}

interface MutableAppState {
  documents: ImportedDxfDocument[]
  pieces: ImportedPiece[]
  selectedPieceIds: string[]
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
      entityType: document.pieces.length === 1 && entityTypes.size === 1
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
  const validIds = new Set(allPieces.map((piece) => piece.id))
  const currentSelection = state.selectedPieceIds.filter((id) => validIds.has(id as ImportedPiece['id']))
  const current = new Set(currentSelection)
  const importedSelection = allPieces
    .map((piece) => piece.id)
    .filter((id) => !current.has(id))
  state.selectedPieceIds = [...currentSelection, ...importedSelection]
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
    const keep = objectPiece?.id !== pieceId && !document.pieces.some((piece) => piece.id === pieceId)
    if (!keep) changed = true
    return keep
  })
  if (!changed) return
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
  state.selectedPieceIds = state.pieces.map((piece) => piece.id)
  state.failures = []
  state.isImporting = false
  state.lastSkippedDuplicateCount = 0
}

function isPieceSelected(pieceId: ImportedPiece['id']): boolean {
  return state.selectedPieceIds.includes(pieceId)
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
}

function setAllPiecesSelected(selected: boolean): void {
  state.selectedPieceIds = selected ? state.pieces.map((piece) => piece.id) : []
}

export function useAppStore() {
  return {
    state: computed(() => state),
    documentCount: computed(() => state.documents.length),
    pieceCount: computed(() => state.pieces.length),
    selectedPieceCount: computed(() => state.selectedPieceIds.length),
    selectedPieces: computed(() =>
      state.pieces.filter((piece) => state.selectedPieceIds.includes(piece.id))
    ),
    importRevision: computed(() => state.importRevision),
    warningCount: computed(() => state.warnings.length),
    selectAndImport,
    importPaths,
    loadPersistedImports,
    replaceImportedDocuments,
    hydrateFromProject,
    isPieceSelected,
    setPieceSelected,
    setAllPiecesSelected,
    removePiece,
    clear
  }
}
