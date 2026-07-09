import type { ImportedPiece } from '@shared/domain/dxf.js'
import type { NestingHistoryFrame, Placement, SheetSpec } from '@shared/domain/nesting.js'
import {
  encodeIndexedGif,
  gifPaletteCssColor,
  nearestGifPaletteIndex
} from '@shared/utils/gifEncoder.js'

export interface RunHistoryGifOptions {
  readonly sheet: SheetSpec
  readonly strategyRunId?: string
  readonly strategyRunIds?: ReadonlyArray<string>
  readonly sheetsByStrategyRunId?: Readonly<Record<string, SheetSpec>>
  readonly sourcePieces: ReadonlyArray<ImportedPiece>
  readonly width?: number
  readonly frameDelayMs?: number
}

export function selectFirstBeamSequence(
  frames: ReadonlyArray<NestingHistoryFrame>,
  strategyRunId: string
): ReadonlyArray<NestingHistoryFrame> {
  const selectedByStep = new Map<number, NestingHistoryFrame>()
  for (const frame of frames) {
    if (frame.strategyRunId === strategyRunId && frame.beamRank === 0) {
      selectedByStep.set(frame.stepIndex, frame)
    }
  }
  if (selectedByStep.size === 0) {
    for (const frame of frames) {
      if (frame.strategyRunId === strategyRunId) {
        const existing = selectedByStep.get(frame.stepIndex)
        if (!existing || frame.beamRank < existing.beamRank) {
          selectedByStep.set(frame.stepIndex, frame)
        }
      }
    }
  }
  const sorted = [...selectedByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex)
  const meaningful: NestingHistoryFrame[] = []
  let previousSignature = ''
  for (const frame of sorted) {
    const signature = placementSignature(frame)
    if (frame.plate.placements.length === 0 && sorted.some((f) => f.plate.placements.length > 0)) {
      continue
    }
    if (signature !== previousSignature) {
      meaningful.push(frame)
      previousSignature = signature
    }
  }
  return meaningful.length > 0 ? meaningful : sorted
}

export function createRunHistoryGif(
  frames: ReadonlyArray<NestingHistoryFrame>,
  options: RunHistoryGifOptions
): Uint8Array {
  const strategyRunIds =
    options.strategyRunIds && options.strategyRunIds.length > 0
      ? options.strategyRunIds
      : options.strategyRunId
        ? [options.strategyRunId]
        : []
  const sequence = strategyRunIds.flatMap((strategyRunId) =>
    selectFirstBeamSequence(frames, strategyRunId)
  )
  if (sequence.length === 0) {
    throw new Error('No first-beam history frames available for this run.')
  }

  const size = fitCanvasSize(options.sheet, options.width ?? 720)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a canvas context for GIF export.')

  const delayCs = Math.max(5, Math.round((options.frameDelayMs ?? 220) / 10))
  const finalDelayCs = Math.max(delayCs, 90)
  const gifFrames = sequence.map((frame, index) => {
    const sheet = options.sheetsByStrategyRunId?.[frame.strategyRunId] ?? options.sheet
    return {
      indexes: renderFrameIndexes(ctx, size.width, size.height, sheet, options.sourcePieces, frame),
      delayCs: index === sequence.length - 1 ? finalDelayCs : delayCs
    }
  })
  return encodeIndexedGif(size.width, size.height, gifFrames)
}

function fitCanvasSize(
  sheet: SheetSpec,
  preferredWidth: number
): { readonly width: number; readonly height: number } {
  const rawWidth = Math.max(360, Math.min(960, Math.round(preferredWidth)))
  const rawHeight = Math.max(260, Math.round((rawWidth * sheet.height) / sheet.width) + 44)
  if (rawHeight <= 720) return { width: rawWidth, height: rawHeight }
  return { width: Math.max(360, Math.round((676 * sheet.width) / sheet.height)), height: 720 }
}

function renderFrameIndexes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sheet: SheetSpec,
  sourcePieces: ReadonlyArray<ImportedPiece>,
  frame: NestingHistoryFrame
): Uint8Array {
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = gifPaletteCssColor(0)
  ctx.fillRect(0, 0, width, height)

  const margin = 18
  const headerHeight = 40
  const scale = Math.min(
    (width - margin * 2) / sheet.width,
    (height - headerHeight - margin * 2) / sheet.height
  )
  const sheetWidth = sheet.width * scale
  const sheetHeight = sheet.height * scale
  const ox = (width - sheetWidth) / 2
  const oy = headerHeight + (height - headerHeight - sheetHeight) / 2

  drawHeader(ctx, width, frame)
  ctx.fillStyle = gifPaletteCssColor(1)
  ctx.fillRect(ox, oy, sheetWidth, sheetHeight)
  ctx.strokeStyle = gifPaletteCssColor(2)
  ctx.lineWidth = 1
  ctx.strokeRect(ox + 0.5, oy + 0.5, Math.max(1, sheetWidth - 1), Math.max(1, sheetHeight - 1))

  const insertedPieceId = frame.beam?.insertedPieceId ?? null
  const sourcePiecesById = new Map(sourcePieces.map((piece) => [piece.id, piece]))
  for (const placement of frame.plate.placements) {
    drawPlacement(ctx, sheet, placement, scale, ox, oy, placement.pieceId === insertedPieceId)
    const sourcePiece = sourcePieceForPlacement(sourcePiecesById, placement)
    if (sourcePiece) {
      drawSourceGeometry(ctx, sheet, placement, sourcePiece, scale, ox, oy)
    }
  }

  ctx.strokeStyle = gifPaletteCssColor(5)
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  for (const rect of frame.plate.freeRectangles) {
    const x = ox + rect.x * scale
    const y = oy + (sheet.height - rect.y - rect.height) * scale
    ctx.strokeRect(
      x + 0.5,
      y + 0.5,
      Math.max(1, rect.width * scale),
      Math.max(1, rect.height * scale)
    )
  }
  ctx.setLineDash([])

  return quantize(ctx.getImageData(0, 0, width, height).data)
}

function sourcePieceForPlacement(
  sourcePiecesById: ReadonlyMap<string, ImportedPiece>,
  placement: Placement
): ImportedPiece | null {
  const id = placement.pieceId
  return sourcePiecesById.get(id) ?? sourcePiecesById.get(id.replace(/-copy-\d+$/, '')) ?? null
}

function drawHeader(
  ctx: CanvasRenderingContext2D,
  width: number,
  frame: NestingHistoryFrame
): void {
  ctx.fillStyle = gifPaletteCssColor(9)
  ctx.fillRect(0, 0, width, 40)
  ctx.fillStyle = gifPaletteCssColor(8)
  ctx.font = '600 16px system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillText(`Step ${frame.stepIndex + 1}`, 18, 25)
  ctx.font = '12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif'
  ctx.fillStyle = gifPaletteCssColor(7)
  ctx.fillText(`placed ${frame.plate.placements.length} · first beam`, 96, 25)
}

function drawPlacement(
  ctx: CanvasRenderingContext2D,
  sheet: SheetSpec,
  placement: Placement,
  scale: number,
  ox: number,
  oy: number,
  highlighted: boolean
): void {
  const x = ox + placement.x * scale
  const y = oy + (sheet.height - placement.y - placement.height) * scale
  const width = Math.max(1, placement.width * scale)
  const height = Math.max(1, placement.height * scale)
  ctx.fillStyle = gifPaletteCssColor(highlighted ? 6 : 3)
  ctx.strokeStyle = gifPaletteCssColor(highlighted ? 8 : 4)
  ctx.lineWidth = 1
  ctx.fillRect(x, y, width, height)
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, width - 1), Math.max(1, height - 1))
}

function drawSourceGeometry(
  ctx: CanvasRenderingContext2D,
  sheet: SheetSpec,
  placement: Placement,
  piece: ImportedPiece,
  scale: number,
  ox: number,
  oy: number
): void {
  const bounds = piece.realBounds
  const placementY = sheet.height - placement.y - placement.height
  ctx.save()
  ctx.lineWidth = 1.8
  ctx.strokeStyle = gifPaletteCssColor(8)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (placement.rotation === 0) {
    const padX = Math.max(0, (placement.width - bounds.width) / 2)
    const padY = Math.max(0, (placement.height - bounds.height) / 2)
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      ox + (placement.x + padX - bounds.x) * scale,
      oy + (placementY + padY - bounds.y) * scale
    )
  } else {
    const padX = Math.max(0, (placement.width - bounds.height) / 2)
    const padY = Math.max(0, (placement.height - bounds.width) / 2)
    ctx.setTransform(
      0,
      scale,
      -scale,
      0,
      ox + (placement.x + padX + bounds.y + bounds.height) * scale,
      oy + (placementY + padY - bounds.x) * scale
    )
  }

  if (piece.geometry.entityType === 'CIRCLE') {
    drawCircleGeometry(ctx, piece)
  } else {
    for (const segment of piece.geometry.segments) {
      drawSegment(ctx, segment)
    }
  }
  ctx.restore()
}

function drawCircleGeometry(ctx: CanvasRenderingContext2D, piece: ImportedPiece): void {
  const radius = Math.min(piece.realBounds.width, piece.realBounds.height) / 2
  if (radius <= 0) return
  const cx = piece.realBounds.x + piece.realBounds.width / 2
  const cy = piece.realBounds.y + piece.realBounds.height / 2
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  segment: ImportedPiece['geometry']['segments'][number]
): void {
  ctx.beginPath()
  ctx.moveTo(segment.x1, segment.y1)
  if (segment.kind === 'line') {
    ctx.lineTo(segment.x2, segment.y2)
  } else {
    const cx = segment.cx
    const cy = segment.cy
    const radius = segment.radius
    if (radius <= 0) return
    const start = (segment.startAngle * Math.PI) / 180
    const end = (segment.endAngle * Math.PI) / 180
    ctx.arc(cx, cy, radius, start, end)
  }
  ctx.stroke()
}

function placementSignature(frame: NestingHistoryFrame): string {
  return frame.plate.placements
    .map((p) => `${p.pieceId}:${p.x}:${p.y}:${p.width}:${p.height}:${p.rotation}`)
    .join('|')
}

function quantize(data: Uint8ClampedArray): Uint8Array {
  const indexes = new Uint8Array(data.length / 4)
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    indexes[pixel] = nearestGifPaletteIndex(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
  }
  return indexes
}
