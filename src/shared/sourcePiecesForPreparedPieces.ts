import type { ImportedPiece } from './domain/dxf.js'
import { PieceId } from './domain/ids.js'
import type { PreparedPiece } from './domain/nesting.js'

export function cloneImportedPiece(piece: ImportedPiece): ImportedPiece {
  return {
    id: piece.id,
    sourceFileId: piece.sourceFileId,
    ...(piece.sourceLayer !== undefined ? { sourceLayer: piece.sourceLayer } : {}),
    label: piece.label,
    realBounds: { ...piece.realBounds },
    geometry: {
      entityType: piece.geometry.entityType,
      closed: piece.geometry.closed,
      segments: piece.geometry.segments.map((segment) => ({ ...segment }))
    },
    warnings: piece.warnings.map((warning) => ({ ...warning }))
  }
}

function sourcePieceForPreparedPiece(
  piece: PreparedPiece,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ImportedPiece | null {
  const direct = sourcePieces.find((sourcePiece) => sourcePiece.id === piece.sourcePieceId)
  if (direct !== undefined) return cloneImportedPiece(direct)

  const baseSourcePieceId = PieceId.make(piece.sourcePieceId.replace(/-copy-\d+$/, ''))
  const base = sourcePieces.find((sourcePiece) => sourcePiece.id === baseSourcePieceId)
  if (base === undefined) return null

  return {
    ...cloneImportedPiece(base),
    id: piece.sourcePieceId
  }
}

export function sourcePiecesForPreparedPieces(
  pieces: ReadonlyArray<PreparedPiece>,
  sourcePieces: ReadonlyArray<ImportedPiece>
): ReadonlyArray<ImportedPiece> {
  const byId = new Map<ImportedPiece['id'], ImportedPiece>()
  for (const piece of pieces) {
    const sourcePiece = sourcePieceForPreparedPiece(piece, sourcePieces)
    if (sourcePiece !== null && !byId.has(sourcePiece.id)) {
      byId.set(sourcePiece.id, sourcePiece)
    }
  }
  return [...byId.values()]
}
