import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { PreparedPiece } from '@shared/domain/nesting.js'
import type { ProjectRunRecord } from '@shared/domain/project.js'

export interface SavedRunRestorePlan {
  readonly available: true
  readonly quantities: Readonly<Record<string, number>>
  readonly mirrorEnabled: Readonly<Record<string, boolean>>
}

export interface SavedRunRestoreUnavailable {
  readonly available: false
  readonly reason: string
}

export type SavedRunRestoreStatus = SavedRunRestorePlan | SavedRunRestoreUnavailable

function sourceIdForPreparedPiece(piece: PreparedPiece): string {
  return piece.interchangeabilityKey ?? piece.sourcePieceId.replace(/-copy-\d+$/, '')
}

function sameSourceGeometry(current: ImportedPiece, snapshot: ImportedPiece): boolean {
  if (current.sourceFileId !== snapshot.sourceFileId) return false
  const currentBounds = current.realBounds
  const snapshotBounds = snapshot.realBounds
  if (
    currentBounds.x !== snapshotBounds.x ||
    currentBounds.y !== snapshotBounds.y ||
    currentBounds.width !== snapshotBounds.width ||
    currentBounds.height !== snapshotBounds.height
  ) {
    return false
  }
  return JSON.stringify(current.geometry) === JSON.stringify(snapshot.geometry)
}

export function savedRunRestoreStatus(
  record: Pick<ProjectRunRecord, 'request'>,
  currentPieces: ReadonlyArray<ImportedPiece>
): SavedRunRestoreStatus {
  const request = record.request
  if (request === undefined) {
    return {
      available: false,
      reason: 'Configuration restore is unavailable for runs saved before request snapshots.'
    }
  }
  if (request.sourcePieces === undefined) {
    return {
      available: false,
      reason: 'Configuration restore is unavailable because this run has no source-shape snapshot.'
    }
  }

  const currentById = new Map<string, ImportedPiece>(
    currentPieces.map((piece) => [piece.id, piece])
  )
  const snapshotById = new Map<string, ImportedPiece>(
    request.sourcePieces.map((piece) => [piece.id, piece])
  )
  const quantities: Record<string, number> = {}
  const mirrorEnabled: Record<string, boolean> = {}
  const missing = new Set<string>()
  const changed = new Set<string>()
  const incompatibleMirror = new Set<string>()

  for (const prepared of request.pieces) {
    const sourceId = sourceIdForPreparedPiece(prepared)
    const current = currentById.get(sourceId)
    const snapshot = snapshotById.get(prepared.sourcePieceId)
    if (current === undefined || snapshot === undefined) {
      missing.add(sourceId)
      continue
    }
    if (!sameSourceGeometry(current, snapshot)) {
      changed.add(sourceId)
      continue
    }

    quantities[sourceId] = (quantities[sourceId] ?? 0) + 1
    const expectedMirror = prepared.allowMirror ?? true
    const previousMirror = mirrorEnabled[sourceId]
    if (previousMirror !== undefined && previousMirror !== expectedMirror) {
      incompatibleMirror.add(sourceId)
      continue
    }
    mirrorEnabled[sourceId] = expectedMirror
  }

  if (missing.size > 0) {
    return {
      available: false,
      reason: `Missing source shape(s): ${[...missing].join(', ')}.`
    }
  }
  if (changed.size > 0) {
    return {
      available: false,
      reason: `Source geometry changed since this run: ${[...changed].join(', ')}.`
    }
  }
  if (incompatibleMirror.size > 0) {
    return {
      available: false,
      reason: `Per-copy mirror settings cannot be restored for: ${[...incompatibleMirror].join(', ')}.`
    }
  }

  return { available: true, quantities, mirrorEnabled }
}
