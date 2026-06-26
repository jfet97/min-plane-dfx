import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { NestingWarning, PreparedPiece, SheetSpec } from '@shared/domain/nesting.js'
import type { JobId, PieceId } from '@shared/domain/ids.js'

export interface PreparedPieceWithWarnings {
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly warnings: ReadonlyArray<NestingWarning>
}

/**
 * Build the validation-time piece list sent to the worker. Padding is
 * applied symmetrically to both sides; the worker algorithm does not sort
 * pieces here. Sorting belongs behind the worker boundary (currently the
 * identity sort stub).
 */
export function preparePieces(
  imported: ReadonlyArray<ImportedPiece>,
  sheet: SheetSpec,
  padding: number,
  _jobId: JobId
): PreparedPieceWithWarnings {
  const pieces: PreparedPiece[] = []
  const warnings: NestingWarning[] = []

  for (const p of imported) {
    const paddedWidth = p.realBounds.width + 2 * padding
    const paddedHeight = p.realBounds.height + 2 * padding

    const fitsAsIs = paddedWidth <= sheet.width && paddedHeight <= sheet.height
    const fitsRotated = paddedHeight <= sheet.width && paddedWidth <= sheet.height

    if (!fitsAsIs && !fitsRotated) {
      warnings.push({
        code: 'piece_does_not_fit',
        message: `Piece ${p.label} (${paddedWidth.toFixed(2)} x ${paddedHeight.toFixed(2)}) cannot fit on the sheet (${sheet.width} x ${sheet.height}), even after rotation.`,
        pieceId: p.id as PieceId
      })
    } else if (!fitsAsIs) {
      warnings.push({
        code: 'piece_requires_rotation',
        message: `Piece ${p.label} only fits rotated 90 degrees.`,
        pieceId: p.id as PieceId
      })
    }

    pieces.push({
      id: p.id as PieceId,
      sourcePieceId: p.id as PieceId,
      realBounds: p.realBounds,
      paddedBounds: {
        x: p.realBounds.x,
        y: p.realBounds.y,
        width: paddedWidth,
        height: paddedHeight
      },
      padding,
      allowRotation: fitsRotated
    })
  }

  return { pieces, warnings }
}
