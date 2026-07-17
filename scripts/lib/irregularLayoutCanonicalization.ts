import { createHash } from 'node:crypto'

export interface LayoutPoint {
  readonly x: number
  readonly y: number
}

export interface CanonicalLayout {
  readonly key: string
  readonly sha256: string
  readonly rotationDeg: 0 | 90 | 180 | 270
}

const QUARTER_TURNS = [0, 90, 180, 270] as const

function rotatePoint(point: LayoutPoint, rotationDeg: (typeof QUARTER_TURNS)[number]): LayoutPoint {
  switch (rotationDeg) {
    case 0:
      return point
    case 90:
      return { x: -point.y, y: point.x }
    case 180:
      return { x: -point.x, y: -point.y }
    case 270:
      return { x: point.y, y: -point.x }
  }
}

function cyclicVariants(values: ReadonlyArray<string>): ReadonlyArray<string> {
  if (values.length === 0) return ['']
  const variants: string[] = []
  for (let offset = 0; offset < values.length; offset += 1) {
    variants.push([...values.slice(offset), ...values.slice(0, offset)].join(';'))
  }
  return variants
}

function canonicalRing(points: ReadonlyArray<{ readonly x: number; readonly y: number }>): string {
  const values = points.map(({ x, y }) => `${x},${y}`)
  const forward = cyclicVariants(values)
  const reversed = cyclicVariants([...values].reverse())
  return [...forward, ...reversed].sort()[0] ?? ''
}

function canonicalKeyForRotation(
  polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>,
  rotationDeg: (typeof QUARTER_TURNS)[number],
  gridSizeMm: number
): string {
  const rotated = polygons.map((polygon) =>
    polygon.map((point) => rotatePoint(point, rotationDeg))
  )
  const points = rotated.flat()
  if (points.length === 0) return ''
  const minX = Math.min(...points.map(({ x }) => x))
  const minY = Math.min(...points.map(({ y }) => y))
  const rings = rotated.map((polygon) =>
    canonicalRing(
      polygon.map(({ x, y }) => ({
        x: Math.round((x - minX) / gridSizeMm),
        y: Math.round((y - minY) / gridSizeMm)
      }))
    )
  )
  return rings.sort().join('|')
}

/** Canonicalizes collision geometry up to copy order, winding, translation, and quarter-turn. */
export function canonicalizeIrregularLayout(
  polygons: ReadonlyArray<ReadonlyArray<LayoutPoint>>,
  gridSizeMm = 0.001
): CanonicalLayout {
  if (!Number.isFinite(gridSizeMm) || gridSizeMm <= 0) {
    throw new Error('gridSizeMm must be finite and positive')
  }
  const variants = QUARTER_TURNS.map((rotationDeg) => ({
    rotationDeg,
    key: canonicalKeyForRotation(polygons, rotationDeg, gridSizeMm)
  })).sort((first, second) => first.key.localeCompare(second.key))
  const selected = variants[0]
  if (selected === undefined) throw new Error('quarter-turn canonicalization produced no variant')
  return {
    ...selected,
    sha256: createHash('sha256').update(selected.key).digest('hex')
  }
}
