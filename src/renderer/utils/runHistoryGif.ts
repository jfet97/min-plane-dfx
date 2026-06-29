import type { NestingHistoryFrame, Placement, SheetSpec } from '@shared/domain/nesting.js'
import {
  encodeIndexedGif,
  gifPaletteCssColor,
  nearestGifPaletteIndex
} from '@shared/utils/gifEncoder.js'

export interface RunHistoryGifOptions {
  readonly sheet: SheetSpec
  readonly strategyRunId: string
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
  return [...selectedByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex)
}

export function createRunHistoryGif(
  frames: ReadonlyArray<NestingHistoryFrame>,
  options: RunHistoryGifOptions
): Uint8Array {
  const sequence = selectFirstBeamSequence(frames, options.strategyRunId)
  if (sequence.length === 0) {
    throw new Error('No first-beam history frames available for this run.')
  }

  const size = fitCanvasSize(options.sheet, options.width ?? 720)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create a canvas context for GIF export.')

  const delayCs = Math.max(2, Math.round((options.frameDelayMs ?? 180) / 10))
  const gifFrames = sequence.map((frame) => ({
    indexes: renderFrameIndexes(ctx, size.width, size.height, options.sheet, frame),
    delayCs
  }))
  return encodeIndexedGif(size.width, size.height, gifFrames)
}

function fitCanvasSize(
  sheet: SheetSpec,
  preferredWidth: number
): { readonly width: number; readonly height: number } {
  const rawWidth = Math.max(240, Math.min(960, Math.round(preferredWidth)))
  const rawHeight = Math.max(180, Math.round((rawWidth * sheet.height) / sheet.width))
  if (rawHeight <= 720) return { width: rawWidth, height: rawHeight }
  return { width: Math.max(240, Math.round((720 * sheet.width) / sheet.height)), height: 720 }
}

function renderFrameIndexes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sheet: SheetSpec,
  frame: NestingHistoryFrame
): Uint8Array {
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = gifPaletteCssColor(0)
  ctx.fillRect(0, 0, width, height)

  const margin = 10
  const scale = Math.min((width - margin * 2) / sheet.width, (height - margin * 2) / sheet.height)
  const sheetWidth = sheet.width * scale
  const sheetHeight = sheet.height * scale
  const ox = (width - sheetWidth) / 2
  const oy = (height - sheetHeight) / 2

  ctx.fillStyle = gifPaletteCssColor(1)
  ctx.fillRect(ox, oy, sheetWidth, sheetHeight)
  ctx.strokeStyle = gifPaletteCssColor(2)
  ctx.lineWidth = 1
  ctx.strokeRect(ox + 0.5, oy + 0.5, Math.max(1, sheetWidth - 1), Math.max(1, sheetHeight - 1))

  const insertedPieceId = frame.beam?.insertedPieceId ?? null
  for (const placement of frame.plate.placements) {
    drawPlacement(ctx, sheet, placement, scale, ox, oy, placement.pieceId === insertedPieceId)
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

function quantize(data: Uint8ClampedArray): Uint8Array {
  const indexes = new Uint8Array(data.length / 4)
  for (let i = 0, pixel = 0; i < data.length; i += 4, pixel += 1) {
    indexes[pixel] = nearestGifPaletteIndex(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
  }
  return indexes
}
