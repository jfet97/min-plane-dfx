import type { ImportedPiece } from '@shared/domain/dxf.js'
import { NestingWarning, PreparedPiece, type SheetSpec } from '@shared/domain/nesting.js'
import { Rect, RectWith } from '@shared/domain/geometry.js'
import type { JobId } from '@shared/domain/ids.js'

export interface PreparedPieceWithWarnings {
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly warnings: ReadonlyArray<NestingWarning>
}

/**
 * Build the validation-time piece list sent to the worker.
 *
 * UI padding is total clearance in integer millimeters. The worker footprint
 * expands by `ceil(padding / 2)` on every side, so odd values round outward and
 * no fractional rectangles reach the algorithm.
 */
export function preparePieces(
  imported: ReadonlyArray<ImportedPiece>,
  sheet: SheetSpec,
  padding: number,
  _jobId: JobId,
  cutRowRef?: PreparedPiece['cutRowRef'],
  allowMirrorForPiece?: (pieceId: ImportedPiece['id']) => boolean,
  interchangeabilityKeyForPiece?: (piece: ImportedPiece) => string
): PreparedPieceWithWarnings {
  const pieces: PreparedPiece[] = []
  const warnings: NestingWarning[] = []
  const integerPadding = Math.max(0, Math.round(padding))
  const sidePadding = Math.ceil(integerPadding / 2)

  for (const p of imported) {
    const paddedWidth = p.realBounds.width + 2 * sidePadding
    const paddedHeight = p.realBounds.height + 2 * sidePadding

    const fitsAsIs = paddedWidth <= sheet.width && paddedHeight <= sheet.height
    const fitsRotated = paddedHeight <= sheet.width && paddedWidth <= sheet.height

    if (!fitsAsIs && !fitsRotated) {
      warnings.push(
        new NestingWarning({
          code: 'piece_does_not_fit',
          message: `Piece ${p.label} (${paddedWidth.toFixed(2)} x ${paddedHeight.toFixed(2)}) cannot fit on the sheet (${sheet.width} x ${sheet.height}), even after rotation.`,
          pieceId: p.id
        })
      )
    } else if (!fitsAsIs) {
      warnings.push(
        new NestingWarning({
          code: 'piece_requires_rotation',
          message: `Piece ${p.label} only fits rotated 90 degrees.`,
          pieceId: p.id
        })
      )
    }

    pieces.push(
      new PreparedPiece({
        id: p.id,
        sourcePieceId: p.id,
        ...(interchangeabilityKeyForPiece === undefined
          ? {}
          : { interchangeabilityKey: interchangeabilityKeyForPiece(p) }),
        realBounds: new Rect(p.realBounds),
        paddedBounds: new RectWith({
          x: p.realBounds.x,
          y: p.realBounds.y,
          width: paddedWidth,
          height: paddedHeight,
          longestEdge: Math.max(paddedWidth, paddedHeight),
          area: paddedWidth * paddedHeight,
          imbalance: Math.abs(paddedWidth - paddedHeight)
        }),
        padding: sidePadding,
        allowRotation: fitsRotated,
        allowMirror: allowMirrorForPiece?.(p.id) ?? true,
        ...(cutRowRef !== undefined ? { cutRowRef } : {})
      })
    )
  }

  return { pieces, warnings }
}
