import type { ImportedPiece } from '@shared/domain/dxf.js'
import { PieceId } from '@shared/domain/ids.js'
import { NestingWarning, PreparedPiece, type SheetSpec } from '@shared/domain/nesting.js'
import type { CsvCutRow } from '@shared/domain/project.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import type { JobId } from '@shared/domain/ids.js'
import type { PreparedPieceWithWarnings } from '@shared/preparePieces.js'

/**
 * Expand CSV cut rows into prepared pieces for the nesting worker.
 *
 * Each row with a linked source shape and a positive amount becomes that many
 * prepared copies, carrying the source geometry and the CSV row metadata needed
 * to reconstruct export rows from final placements.
 */
export function prepareCsvPieces(
  csvRows: readonly CsvCutRow[],
  sourcePiecesById: ReadonlyMap<PieceId, ImportedPiece>,
  sheet: SheetSpec,
  padding: number,
  _jobId: JobId
): PreparedPieceWithWarnings {
  const pieces: PreparedPiece[] = []
  const warnings: NestingWarning[] = []
  const integerPadding = Math.max(0, Math.round(padding))
  const sidePadding = Math.ceil(integerPadding / 2)
  const warnedSourcePieceIds = new Set<PieceId>()

  for (const row of csvRows) {
    if (row.amount <= 0) continue

    if (row.linkedPieceId === undefined) {
      warnings.push(
        new NestingWarning({
          code: 'csv_row_missing_shape',
          message: `CSV row ${row.reference} (${row.customerName}) is not linked to a source shape.`,
          pieceId: row.id
        })
      )
      continue
    }

    const sourcePiece = sourcePiecesById.get(row.linkedPieceId)
    if (sourcePiece === undefined) {
      warnings.push(
        new NestingWarning({
          code: 'csv_row_missing_shape',
          message: `CSV row ${row.reference} (${row.customerName}) links to source shape ${row.linkedPieceId}, which is not available.`,
          pieceId: row.id
        })
      )
      continue
    }

    const realBounds = new Rect(sourcePiece.realBounds)
    const paddedWidth = realBounds.width + 2 * sidePadding
    const paddedHeight = realBounds.height + 2 * sidePadding

    const fitsAsIs = paddedWidth <= sheet.width && paddedHeight <= sheet.height
    const fitsRotated = paddedHeight <= sheet.width && paddedWidth <= sheet.height

    if (!warnedSourcePieceIds.has(sourcePiece.id)) {
      if (!fitsAsIs && !fitsRotated) {
        warnings.push(
          new NestingWarning({
            code: 'piece_does_not_fit',
            message: `Source shape ${sourcePiece.label} (${paddedWidth} x ${paddedHeight}) cannot fit on the sheet (${sheet.width} x ${sheet.height}), even after rotation.`,
            pieceId: sourcePiece.id
          })
        )
        warnedSourcePieceIds.add(sourcePiece.id)
      } else if (!fitsAsIs) {
        warnings.push(
          new NestingWarning({
            code: 'piece_requires_rotation',
            message: `Source shape ${sourcePiece.label} only fits rotated 90 degrees.`,
            pieceId: sourcePiece.id
          })
        )
        warnedSourcePieceIds.add(sourcePiece.id)
      }
    }

    const paddedBounds = new RectWith({
      x: realBounds.x,
      y: realBounds.y,
      width: paddedWidth,
      height: paddedHeight,
      longestEdge: Math.max(paddedWidth, paddedHeight),
      area: paddedWidth * paddedHeight,
      imbalance: Math.abs(paddedWidth - paddedHeight)
    })

    for (let index = 0; index < row.amount; index++) {
      const copyId = PieceId.make(`copy-${index}-of-${sourcePiece.id}-for-${row.id}`)

      pieces.push(
        new PreparedPiece({
          id: copyId,
          sourcePieceId: sourcePiece.id,
          realBounds,
          paddedBounds,
          padding: sidePadding,
          allowRotation: fitsRotated,
          cutRowRef: {
            reference: row.reference,
            customerName: row.customerName,
            csvRowId: row.id
          }
        })
      )
    }
  }

  return { pieces, warnings }
}
