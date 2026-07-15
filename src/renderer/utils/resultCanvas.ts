import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { Rect } from '@shared/domain/geometry.js'
import type { Placement, SheetSpec } from '@shared/domain/nesting.js'
import type {
  CollisionGeometryDiagnostic,
  IrregularHistoryFrame,
  IrregularLayout,
  IrregularPlacement,
  IrregularLayoutScoreSummary
} from '@shared/irregular/domain.js'

export interface CanvasPoint {
  readonly x: number
  readonly y: number
}

export type IrregularCanvasSource = Pick<
  IrregularLayout | IrregularHistoryFrame,
  'placements' | 'unplacedPieceIds'
> & {
  readonly score?: IrregularLayoutScoreSummary
  readonly diagnostics?: ReadonlyArray<CollisionGeometryDiagnostic>
}

export type IrregularCanvasPlacementStatus =
  | 'rendered'
  | 'source-missing'
  | 'placement-reference-missing'

export interface IrregularCanvasPlacement {
  readonly placement: IrregularPlacement
  readonly sourcePiece: ImportedPiece | null
  readonly svgTransform: string | null
  readonly status: IrregularCanvasPlacementStatus
}

export interface IrregularCanvasModel {
  readonly placements: ReadonlyArray<IrregularCanvasPlacement>
  readonly unplacedPieceIds: ReadonlyArray<string>
  readonly missingSourcePieceIds: ReadonlyArray<string>
  readonly unrenderablePlacementCount: number
  readonly score: IrregularLayoutScoreSummary | null
  readonly diagnostics: ReadonlyArray<CollisionGeometryDiagnostic>
}

/** Reuses the established rectangular source-geometry transform convention. */
export function rectangularPlacementSvgTransform(
  placement: Placement,
  pieceBounds: Pick<Rect, 'x' | 'y' | 'width' | 'height'>,
  sheetHeight: number
): string {
  const placementY = sheetHeight - placement.y - placement.height
  if (placement.rotation === 0) {
    const padX = Math.max(0, (placement.width - pieceBounds.width) / 2)
    const padY = Math.max(0, (placement.height - pieceBounds.height) / 2)
    const e = placement.x + padX - pieceBounds.x
    const f = placementY + padY - pieceBounds.y
    return `matrix(1 0 0 1 ${e} ${f})`
  }

  const padX = Math.max(0, (placement.width - pieceBounds.height) / 2)
  const padY = Math.max(0, (placement.height - pieceBounds.width) / 2)
  const e = placement.x + padX + pieceBounds.y + pieceBounds.height
  const f = placementY + padY - pieceBounds.x
  return `matrix(0 1 -1 0 ${e} ${f})`
}

/** Applies the worker transform order to one original source coordinate. */
export function transformIrregularPoint(
  point: CanvasPoint,
  placement: IrregularPlacement
): CanvasPoint | null {
  const reference = placement.placementReference
  if (reference === undefined) return null

  const relativeX = point.x - reference.x
  const relativeY = point.y - reference.y
  const mirroredX = placement.transform.mirrored ? -relativeX : relativeX
  const { cos, sin } = rotationValues(placement.transform.rotationDeg)

  return {
    x: placement.transform.translateX + normalizeNumber(mirroredX * cos - relativeY * sin),
    y: placement.transform.translateY + normalizeNumber(mirroredX * sin + relativeY * cos)
  }
}

/** Builds an SVG transform that maps DXF source coordinates into sheet space. */
export function irregularPlacementSvgTransform(
  placement: IrregularPlacement,
  sheetHeight: number
): string | null {
  const reference = placement.placementReference
  if (reference === undefined) return null

  const { cos, sin } = rotationValues(placement.transform.rotationDeg)
  const mirrorSign = placement.transform.mirrored ? -1 : 1
  const mathA = normalizeNumber(cos * mirrorSign)
  const mathB = normalizeNumber(sin * mirrorSign)
  const mathC = normalizeNumber(-sin)
  const mathD = normalizeNumber(cos)
  const e = normalizeNumber(
    placement.transform.translateX - mathA * reference.x - mathC * reference.y
  )
  const f = normalizeNumber(
    sheetHeight - placement.transform.translateY + mathB * reference.x + mathD * reference.y
  )

  return `matrix(${mathA} ${normalizeNumber(-mathB)} ${mathC} ${normalizeNumber(-mathD)} ${e} ${f})`
}

/** Creates the result/debug model from real irregular output and local source pieces. */
export function buildIrregularCanvasModel(input: {
  readonly source: IrregularCanvasSource
  readonly sourcePieces: ReadonlyArray<ImportedPiece>
  readonly sheet: Pick<SheetSpec, 'height'>
}): IrregularCanvasModel {
  const placements = input.source.placements.map((placement) => {
    const sourcePiece = findSourcePiece(input.sourcePieces, placement)
    const svgTransform = irregularPlacementSvgTransform(placement, input.sheet.height)
    const status: IrregularCanvasPlacementStatus =
      sourcePiece === null
        ? 'source-missing'
        : svgTransform === null
          ? 'placement-reference-missing'
          : 'rendered'
    return {
      placement,
      sourcePiece,
      svgTransform,
      status
    }
  })

  const missingSourcePieceIds = placements
    .filter((item) => item.status === 'source-missing')
    .map(({ placement }) => placement.sourcePieceId)

  return {
    placements,
    unplacedPieceIds: [...input.source.unplacedPieceIds],
    missingSourcePieceIds,
    unrenderablePlacementCount: placements.filter((item) => item.status !== 'rendered').length,
    score: input.source.score ?? null,
    diagnostics: [...(input.source.diagnostics ?? [])]
  }
}

function findSourcePiece(
  sourcePieces: ReadonlyArray<ImportedPiece>,
  placement: IrregularPlacement
): ImportedPiece | null {
  const ids = [
    placement.pieceId,
    placement.sourcePieceId,
    placement.pieceId === undefined ? undefined : originalPieceId(placement.pieceId),
    originalPieceId(placement.sourcePieceId)
  ]
  for (const id of ids) {
    if (id === undefined) continue
    const piece = sourcePieces.find((candidate) => candidate.id === id)
    if (piece !== undefined) return piece
  }
  return null
}

function originalPieceId(id: string): string {
  return id.replace(/-copy-\d+$/, '')
}

function rotationValues(rotationDeg: number): { readonly cos: number; readonly sin: number } {
  const normalized = ((rotationDeg % 360) + 360) % 360
  switch (normalized) {
    case 0:
      return { cos: 1, sin: 0 }
    case 90:
      return { cos: 0, sin: 1 }
    case 180:
      return { cos: -1, sin: 0 }
    case 270:
      return { cos: 0, sin: -1 }
    default: {
      const radians = (normalized * Math.PI) / 180
      return { cos: normalizeNumber(Math.cos(radians)), sin: normalizeNumber(Math.sin(radians)) }
    }
  }
}

function normalizeNumber(value: number): number {
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) return 0
  return value
}
