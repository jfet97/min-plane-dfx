interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export interface IndexedGifFrame {
  readonly indexes: Uint8Array
  readonly delayCs: number
}

interface GifPalette {
  readonly colors: ReadonlyArray<Rgb>
  readonly sizeCode: number
  readonly minCodeSize: number
}

interface BitWriter {
  readonly bytes: number[]
  write: (code: number, size: number) => void
  finish: () => void
}

const FALLBACK_COLOR: Rgb = { r: 0, g: 0, b: 0 }

export const RUN_HISTORY_GIF_PALETTE: GifPalette = {
  colors: [
    { r: 246, g: 248, b: 250 },
    { r: 232, g: 240, b: 246 },
    { r: 0, g: 95, b: 160 },
    { r: 146, g: 200, b: 230 },
    { r: 24, g: 63, b: 84 },
    { r: 70, g: 155, b: 95 },
    { r: 255, g: 185, b: 64 },
    { r: 88, g: 95, b: 102 },
    { r: 20, g: 24, b: 28 },
    { r: 255, g: 255, b: 255 },
    FALLBACK_COLOR,
    FALLBACK_COLOR,
    FALLBACK_COLOR,
    FALLBACK_COLOR,
    FALLBACK_COLOR,
    FALLBACK_COLOR
  ],
  sizeCode: 3,
  minCodeSize: 4
}

export function encodeIndexedGif(
  width: number,
  height: number,
  frames: ReadonlyArray<IndexedGifFrame>
): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error('GIF dimensions must be positive.')
  if (frames.length === 0) throw new Error('GIF export requires at least one frame.')

  const out: number[] = []
  writeAscii(out, 'GIF89a')
  writeShort(out, width)
  writeShort(out, height)
  out.push(0x80 | 0x70 | RUN_HISTORY_GIF_PALETTE.sizeCode, 0, 0)
  for (const color of RUN_HISTORY_GIF_PALETTE.colors) {
    out.push(color.r, color.g, color.b)
  }
  writeNetscapeLoop(out)

  for (const frame of frames) {
    if (frame.indexes.length !== width * height) {
      throw new Error('GIF frame size does not match the target dimensions.')
    }
    writeGraphicControl(out, frame.delayCs)
    out.push(0x2c)
    writeShort(out, 0)
    writeShort(out, 0)
    writeShort(out, width)
    writeShort(out, height)
    out.push(0)
    const compressed = lzwCompress(frame.indexes, RUN_HISTORY_GIF_PALETTE.minCodeSize)
    out.push(RUN_HISTORY_GIF_PALETTE.minCodeSize)
    writeSubBlocks(out, compressed)
  }

  out.push(0x3b)
  return new Uint8Array(out)
}

export function nearestGifPaletteIndex(r: number, g: number, b: number): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < RUN_HISTORY_GIF_PALETTE.colors.length; i += 1) {
    const color = RUN_HISTORY_GIF_PALETTE.colors[i]
    if (!color) continue
    const dr = r - color.r
    const dg = g - color.g
    const db = b - color.b
    const distance = dr * dr + dg * dg + db * db
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  }
  return best
}

export function gifPaletteCssColor(index: number): string {
  const color = RUN_HISTORY_GIF_PALETTE.colors[index] ?? FALLBACK_COLOR
  return `rgb(${color.r}, ${color.g}, ${color.b})`
}

function writeAscii(out: number[], value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    out.push(value.charCodeAt(i))
  }
}

function writeShort(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff)
}

function writeNetscapeLoop(out: number[]): void {
  out.push(0x21, 0xff, 0x0b)
  writeAscii(out, 'NETSCAPE2.0')
  out.push(0x03, 0x01)
  writeShort(out, 0)
  out.push(0)
}

function writeGraphicControl(out: number[], delayCs: number): void {
  out.push(0x21, 0xf9, 0x04, 0x00)
  writeShort(out, delayCs)
  out.push(0, 0)
}

function writeSubBlocks(out: number[], data: ReadonlyArray<number>): void {
  for (let offset = 0; offset < data.length; offset += 255) {
    const block = data.slice(offset, offset + 255)
    out.push(block.length, ...block)
  }
  out.push(0)
}

function makeBitWriter(): BitWriter {
  const bytes: number[] = []
  let current = 0
  let bitCount = 0
  return {
    bytes,
    write(code, size) {
      current |= code << bitCount
      bitCount += size
      while (bitCount >= 8) {
        bytes.push(current & 0xff)
        current >>= 8
        bitCount -= 8
      }
    },
    finish() {
      if (bitCount > 0) {
        bytes.push(current & 0xff)
      }
    }
  }
}

function lzwCompress(indexes: Uint8Array, minCodeSize: number): ReadonlyArray<number> {
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1
  let nextCode = endCode + 1
  let codeSize = minCodeSize + 1
  let dictionary = new Map<string, number>()
  const writer = makeBitWriter()

  const reset = (): void => {
    dictionary = new Map<string, number>()
    nextCode = endCode + 1
    codeSize = minCodeSize + 1
  }

  writer.write(clearCode, codeSize)
  let prefix = indexes[0] ?? 0

  for (let i = 1; i < indexes.length; i += 1) {
    const value = indexes[i] ?? 0
    const key = `${prefix},${value}`
    const existing = dictionary.get(key)
    if (existing !== undefined) {
      prefix = existing
      continue
    }

    writer.write(prefix, codeSize)
    if (nextCode < 4096) {
      dictionary.set(key, nextCode)
      nextCode += 1
      if (nextCode === 1 << codeSize && codeSize < 12) {
        codeSize += 1
      }
    } else {
      writer.write(clearCode, codeSize)
      reset()
    }
    prefix = value
  }

  writer.write(prefix, codeSize)
  writer.write(endCode, codeSize)
  writer.finish()
  return writer.bytes
}
