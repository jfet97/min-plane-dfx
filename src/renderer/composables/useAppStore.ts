import { reactive, computed, type UnwrapNestedRefs } from 'vue'
import type { ImportedDxfDocument, ImportedPiece, ImportWarning } from '@shared/domain/dxf.js'
import type { ProjectDocument } from '@shared/domain/project.js'

export interface ImportFailure {
  readonly path: string
  readonly code: 'file_read_error' | 'dxf_parse_error' | 'unknown_error'
  readonly message: string
}

interface MutableAppState {
  documents: ImportedDxfDocument[]
  pieces: ImportedPiece[]
  warnings: ImportWarning[]
  failures: ImportFailure[]
  isImporting: boolean
}

const state: UnwrapNestedRefs<MutableAppState> = reactive<MutableAppState>({
  documents: [],
  pieces: [],
  warnings: [],
  failures: [],
  isImporting: false
})

function recomputeAggregates(): void {
  const allPieces: ImportedPiece[] = []
  const allWarnings: ImportWarning[] = []
  for (const doc of state.documents) {
    for (const p of doc.pieces) allPieces.push(p)
    for (const w of doc.warnings) allWarnings.push(w)
  }
  state.pieces = allPieces
  state.warnings = allWarnings
}

async function importPaths(paths: ReadonlyArray<string>): Promise<void> {
  const api = window.appApi
  if (!api || paths.length === 0) return
  state.isImporting = true
  try {
    const imported = await api.importDxfFiles(paths)
    state.documents = [...state.documents, ...imported]
    recomputeAggregates()
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
      state.documents = [...state.documents, ...docs]
      recomputeAggregates()
    }
  } finally {
    state.isImporting = false
  }
}

function clear(): void {
  state.documents = []
  state.pieces = []
  state.warnings = []
  state.failures = []
}

function hydrateFromProject(project: ProjectDocument): void {
  state.documents = [...(project.importedDocuments ?? [])]
  state.pieces =
    project.importedDocuments !== undefined
      ? state.documents.flatMap((document) => document.pieces)
      : [...project.importedPieces]
  state.warnings =
    project.importedDocuments !== undefined
      ? state.documents.flatMap((document) => document.warnings)
      : project.importedPieces.flatMap((piece) => piece.warnings)
  state.failures = []
  state.isImporting = false
}

export function useAppStore() {
  return {
    state: computed(() => state),
    documentCount: computed(() => state.documents.length),
    pieceCount: computed(() => state.pieces.length),
    warningCount: computed(() => state.warnings.length),
    selectAndImport,
    importPaths,
    hydrateFromProject,
    clear
  }
}
