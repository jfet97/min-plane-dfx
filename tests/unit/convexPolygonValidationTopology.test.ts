/**
 * Pins the linear simple-ring decision against the quadratic sweep it replaced.
 *
 * Accepting the same rings is not enough: the validator's diagnostics are part
 * of its contract, and a self-intersection is reported ahead of any turn
 * failure. The oracle here is the previous implementation verbatim, and every
 * comparison is on the exact returned object, message included.
 */
import { describe, expect, it } from 'vitest'

import { ConvexPolygonValidation } from '../../src/workers/irregular/convexPolygonValidation.js'
import { GeometryPredicates } from '../../src/workers/irregular/geometryPredicates.js'
import type { InternalPoint } from '../../src/workers/irregular/internalGeometry.js'

interface BoundaryEdge {
  readonly start: InternalPoint
  readonly end: InternalPoint
}

// ---- oracle: the validator before the linear simple-ring decision ----

function oracleValidate(
  points: ReadonlyArray<InternalPoint>
): { readonly winding: -1 | 1 } | { readonly message: string } {
  if (points.length < 3) return { message: 'polygon must contain at least three vertices.' }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (point === undefined) return { message: 'polygon points must form a closed boundary.' }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return { message: 'polygon coordinates must be finite.' }
    }
  }

  const edges: BoundaryEdge[] = []
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]
    const end = points[(index + 1) % points.length]
    if (start === undefined || end === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }
    if (start.x === end.x && start.y === end.y) {
      return { message: 'polygon must not repeat adjacent vertices.' }
    }
    edges.push({ start, end })
  }

  if (oracleHasSelfIntersection(edges)) {
    return { message: 'polygon must form a simple ring without self-intersections.' }
  }

  let winding: -1 | 1 | undefined
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]
    if (previous === undefined || current === undefined || next === undefined) {
      return { message: 'polygon points must form a closed boundary.' }
    }
    const turn = GeometryPredicates.orientation(previous, current, next)
    if (turn === 0) return { message: 'polygon must not contain collinear vertices.' }
    if (winding === undefined) {
      winding = turn
      continue
    }
    if (turn !== winding) {
      return { message: 'polygon must be strictly convex with one consistent winding.' }
    }
  }

  if (winding === undefined) return { message: 'polygon must have a non-zero area.' }
  return { winding }
}

function oracleHasSelfIntersection(edges: ReadonlyArray<BoundaryEdge>): boolean {
  for (let first = 0; first < edges.length; first += 1) {
    const firstEdge = edges[first]
    if (firstEdge === undefined) return true
    for (let second = first + 1; second < edges.length; second += 1) {
      const adjacent = second === first + 1 || (first === 0 && second === edges.length - 1)
      if (adjacent) continue
      const secondEdge = edges[second]
      if (secondEdge === undefined) return true
      if (oracleSegmentsIntersect(firstEdge, secondEdge)) return true
    }
  }
  return false
}

function oracleSegmentsIntersect(first: BoundaryEdge, second: BoundaryEdge): boolean {
  const d1 = GeometryPredicates.orientation(first.start, first.end, second.start)
  const d2 = GeometryPredicates.orientation(first.start, first.end, second.end)
  const d3 = GeometryPredicates.orientation(second.start, second.end, first.start)
  const d4 = GeometryPredicates.orientation(second.start, second.end, first.end)

  if (d1 === 0 && onSegment(first.start, second.start, first.end)) return true
  if (d2 === 0 && onSegment(first.start, second.end, first.end)) return true
  if (d3 === 0 && onSegment(second.start, first.start, second.end)) return true
  if (d4 === 0 && onSegment(second.start, first.end, second.end)) return true
  return d1 !== d2 && d3 !== d4
}

function onSegment(start: InternalPoint, point: InternalPoint, end: InternalPoint): boolean {
  return (
    Math.min(start.x, end.x) <= point.x &&
    point.x <= Math.max(start.x, end.x) &&
    Math.min(start.y, end.y) <= point.y &&
    point.y <= Math.max(start.y, end.y)
  )
}

// ---- corpus ----

function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

function convexRing(vertexCount: number, radius: number, cx = 0, cy = 0): InternalPoint[] {
  const points: InternalPoint[] = []
  for (let index = 0; index < vertexCount; index += 1) {
    const angle = (2 * Math.PI * index) / vertexCount
    points.push({
      x: Number((cx + radius * Math.cos(angle)).toFixed(4)),
      y: Number((cy + radius * Math.sin(angle)).toFixed(4))
    })
  }
  return points
}

function starRing(vertexCount: number, step: number): InternalPoint[] {
  const points: InternalPoint[] = []
  for (let index = 0; index < vertexCount; index += 1) {
    const angle = (2 * Math.PI * ((index * step) % vertexCount)) / vertexCount
    points.push({
      x: Number((50 * Math.cos(angle)).toFixed(6)),
      y: Number((50 * Math.sin(angle)).toFixed(6))
    })
  }
  return points
}

function rotations(points: ReadonlyArray<InternalPoint>): InternalPoint[][] {
  const out: InternalPoint[][] = []
  for (let offset = 0; offset < points.length; offset += 1) {
    const rotated = [...points.slice(offset), ...points.slice(0, offset)]
    out.push(rotated, [...rotated].reverse())
  }
  return out
}

/**
 * Reports whether every corner turns the same non-zero way. This separates the
 * topology classes exercised by the corpus; production also requires the
 * independent coordinate-envelope guard before using the linear decision.
 */
function turnsAreConsistent(points: ReadonlyArray<InternalPoint>): boolean {
  let winding: number | undefined
  for (let index = 0; index < points.length; index += 1) {
    const turn = GeometryPredicates.orientation(
      points[(index - 1 + points.length) % points.length] as InternalPoint,
      points[index] as InternalPoint,
      points[(index + 1) % points.length] as InternalPoint
    )
    if (turn === 0) return false
    if (winding === undefined) winding = turn
    else if (turn !== winding) return false
  }
  return winding !== undefined
}

describe('strict boundary validation topology', () => {
  it('returns exactly what the quadratic sweep returned, message included', () => {
    const random = makeRandom(1357911)
    let compared = 0
    let accepted = 0
    let simpleRingRejections = 0
    let turnRejections = 0
    // the cell the linear decision alone is answerable for: consistent turns and
    // a crossing, where nothing but the revolution count can reject the ring
    let linearOnlyRejections = 0

    const check = (points: ReadonlyArray<InternalPoint>): void => {
      const expected = oracleValidate(points)
      expect(ConvexPolygonValidation.validateStrictBoundary(points)).toEqual(expected)
      compared += 1
      if ('winding' in expected) accepted += 1
      else if (expected.message.includes('simple ring')) {
        simpleRingRejections += 1
        if (turnsAreConsistent(points)) linearOnlyRejections += 1
      } else turnRejections += 1
    }

    // wide star families: many vertex counts, steps, phases, radii and windings,
    // all of which land in the consistent-turns-and-crossing cell
    for (let vertexCount = 5; vertexCount <= 41; vertexCount += 2) {
      for (let step = 2; step * 2 < vertexCount; step += 1) {
        for (let variant = 0; variant < 4; variant += 1) {
          const phase = random() * Math.PI
          const radius = 20 + random() * 80
          const jitter = variant === 0 ? 0 : random() * 1.5
          const star: InternalPoint[] = []
          for (let index = 0; index < vertexCount; index += 1) {
            const angle = phase + (2 * Math.PI * ((index * step) % vertexCount)) / vertexCount
            const scaled = radius + (variant === 0 ? 0 : (random() * 2 - 1) * jitter)
            star.push({
              x: Number((scaled * Math.cos(angle)).toFixed(6)),
              y: Number((scaled * Math.sin(angle)).toFixed(6))
            })
          }
          check(variant % 3 === 0 ? [...star].reverse() : star)
        }
      }
    }

    // rings pinched by a duplicated non-adjacent vertex, and a vertex resting on
    // a non-adjacent edge: the sweep counts touching as crossing
    const pinchBase = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 14, y: 6 },
      { x: 7, y: 12 },
      { x: -3, y: 6 }
    ]
    for (let source = 0; source < pinchBase.length; source += 1) {
      for (let target = 0; target < pinchBase.length; target += 1) {
        const adjacent =
          Math.abs(source - target) <= 1 ||
          (source === 0 && target === pinchBase.length - 1) ||
          (target === 0 && source === pinchBase.length - 1)
        if (adjacent) continue
        const pinched = pinchBase.map((point) => ({ ...point }))
        pinched[target] = { ...(pinchBase[source] as InternalPoint) }
        check(pinched)
      }
    }
    check([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 8 }
    ])
    check([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 5, y: 0 },
      { x: 0, y: 10 }
    ])

    // a ring climbing away from its start still counts one revolution, because
    // the implicit closing edge descends; no consistently turning closed ring
    // can count zero, since every edge pointing weakly upwards would force all
    // ordinates equal and the ring would be rejected as collinear first
    check([
      { x: 0, y: 0 },
      { x: 5, y: 1 },
      { x: 10, y: 5 }
    ])

    // regular stars in every rotation and winding
    for (let vertexCount = 5; vertexCount <= 17; vertexCount += 2) {
      for (let step = 2; step * 2 < vertexCount; step += 1) {
        for (const variant of rotations(starRing(vertexCount, step))) check(variant)
      }
    }

    // axis-aligned rings, where the revolution count is most delicate
    const axisRings = [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 }
      ],
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 15, y: 7 },
        { x: 5, y: 7 }
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 14, y: 5 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: -4, y: 5 }
      ],
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 8 }
      ]
    ]
    for (const ring of axisRings) for (const variant of rotations(ring)) check(variant)

    // regular and perturbed convex rings, both windings
    for (let vertexCount = 3; vertexCount <= 24; vertexCount += 1) {
      for (const variant of rotations(convexRing(vertexCount, 30))) check(variant)
    }

    // random rings, which reach concave, collinear, and crossing outcomes
    for (let trial = 0; trial < 6000; trial += 1) {
      const vertexCount = 3 + Math.floor(random() * 10)
      const points: InternalPoint[] = []
      if (trial % 2 === 0) {
        for (let index = 0; index < vertexCount; index += 1) {
          points.push({
            x: Number((random() * 100 - 50).toFixed(2)),
            y: Number((random() * 100 - 50).toFixed(2))
          })
        }
      } else {
        for (const point of convexRing(vertexCount, 20 + random() * 20)) {
          points.push({
            x: Number((point.x + (random() * 2 - 1) * 6).toFixed(2)),
            y: Number((point.y + (random() * 2 - 1) * 6).toFixed(2))
          })
        }
      }
      if (trial % 5 === 0) points.reverse()
      check(points)
    }

    // the corpus must actually reach every outcome, or it proves nothing; the
    // last bound is the one that matters, since it counts the rings only the
    // linear revolution count can reject
    expect(compared).toBeGreaterThan(6500)
    expect(accepted).toBeGreaterThan(500)
    expect(simpleRingRejections).toBeGreaterThan(100)
    expect(turnRejections).toBeGreaterThan(500)
    expect(linearOnlyRejections).toBeGreaterThan(1000)
  })

  it('reports a crossing ahead of the turn failure it also has', () => {
    // a bowtie crosses itself and is not convex; the crossing is what is named
    const bowtie = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 }
    ]
    const result = ConvexPolygonValidation.validateStrictBoundary(bowtie)
    expect(result).toEqual(oracleValidate(bowtie))
    expect(result).toEqual({
      message: 'polygon must form a simple ring without self-intersections.'
    })
  })

  it('keeps the diagnostics that precede the simple-ring decision', () => {
    expect(ConvexPolygonValidation.validateStrictBoundary([{ x: 0, y: 0 }])).toEqual({
      message: 'polygon must contain at least three vertices.'
    })
    expect(
      ConvexPolygonValidation.validateStrictBoundary([
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
        { x: 2, y: 0 }
      ])
    ).toEqual({ message: 'polygon coordinates must be finite.' })
    expect(
      ConvexPolygonValidation.validateStrictBoundary([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 2, y: 0 }
      ])
    ).toEqual({ message: 'polygon must not repeat adjacent vertices.' })
    expect(
      ConvexPolygonValidation.validateStrictBoundary([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 }
      ])
    ).toEqual({ message: 'polygon must not contain collinear vertices.' })
  })

  it('falls back to the historical sweep outside the safe numeric envelope', () => {
    const extreme = [
      { x: -Number.MIN_VALUE, y: 2.2250738585072014e-308 },
      { x: Number.MAX_VALUE, y: Number.MIN_VALUE },
      { x: -Number.MAX_VALUE, y: -2.2250738585072014e-308 },
      { x: -Number.MAX_VALUE / 2, y: 2.2250738585072014e-308 }
    ]

    expect(ConvexPolygonValidation.validateStrictBoundary(extreme)).toEqual(
      oracleValidate(extreme)
    )
    expect(ConvexPolygonValidation.validateStrictBoundary(extreme)).toEqual({
      message: 'polygon must form a simple ring without self-intersections.'
    })
  })
})
