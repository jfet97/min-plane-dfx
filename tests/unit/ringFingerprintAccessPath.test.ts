/**
 * Pins that the retained validation and the fingerprint guarding it read the
 * same positions of a ring.
 *
 * The guard exists to notice mutation, so it has to observe the ring the way
 * the validation does. A guard reading through the iterator while validation
 * reads by index can be shown an unchanging content while the indexed ring
 * moves underneath it, and it would then keep certifying a stale result.
 *
 * Matching the access path closes that specific divergence. It does not make
 * the two traversals atomic: coordinates exposed through accessors can still
 * change between the guard's read and validation's read within one call. That
 * residue is left in place deliberately, because closing it means copying every
 * ring on every call, and no caller in this worker supplies anything but plain
 * arrays of plain points.
 */
import { describe, expect, it } from 'vitest'

import {
  resolveNfpBoundary,
  type CoreNfpInput
} from '../../src/workers/irregular/core/nfpBoundaryCore.js'
import {
  serializeGeometryCacheKey,
  type GeometryCacheKey,
  type GeometryCacheStore
} from '../../src/workers/irregular/core/geometryCacheStore.js'
import type { InternalPoint } from '../../src/workers/irregular/internalGeometry.js'

const transform = {
  index: 0,
  rotationDeg: 0,
  mirrored: false,
  reason: 'configured'
} as const

const settings = {
  flatteningSagToleranceMm: 0.05,
  clearanceSafetyMarginMm: 0.05,
  geometryBackendId: 'clipper2-ts',
  geometryBackendVersion: '2.0.1-18'
} as const

const smallTriangle: ReadonlyArray<InternalPoint> = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 0, y: 2 }
]

/** A ring whose iterator always replays one fixed snapshot, whatever it holds. */
function ringWithFrozenIterator(initial: ReadonlyArray<InternalPoint>): InternalPoint[] {
  const snapshot = initial.map((point) => ({ ...point }))
  const ring = [...initial] as InternalPoint[]
  Object.defineProperty(ring, Symbol.iterator, {
    value: function* iterate(): Generator<InternalPoint> {
      for (const point of snapshot) yield point
    },
    configurable: true
  })
  return ring
}

function makeStore(): GeometryCacheStore {
  const entries = new Map<string, unknown>()
  return {
    get: <A>(key: GeometryCacheKey) => entries.get(serializeGeometryCacheKey(key)) as A | undefined,
    set: <A>(key: GeometryCacheKey, value: A) => {
      entries.set(serializeGeometryCacheKey(key), value)
    },
    remove: (key: GeometryCacheKey) => {
      entries.delete(serializeGeometryCacheKey(key))
    },
    clear: () => {
      entries.clear()
    }
  }
}

function makeNfpInput(
  fixedPoints: ReadonlyArray<InternalPoint>,
  movingPoints: ReadonlyArray<InternalPoint>
): CoreNfpInput {
  return {
    fixed: {
      collisionGeometry: { polygon: { points: fixedPoints }, transform },
      placement: { transform: { translateX: 0, translateY: 0 } }
    },
    moving: { polygon: { points: movingPoints }, transform },
    settings
  }
}

describe('the validation guard reads the ring the way validation does', () => {
  it('re-validates a rejected ring once its indexed positions become valid', () => {
    // this direction is the observable one. A retained rejection short-circuits
    // resolution, so a guard that misses the repair keeps refusing a ring that
    // is now legitimate. The opposite direction is masked downstream: a stale
    // acceptance still reaches construction, which validates the ring again.
    const store = makeStore()
    const collinear: ReadonlyArray<InternalPoint> = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 }
    ]
    const ring = ringWithFrozenIterator(collinear)

    const rejected = resolveNfpBoundary(
      makeNfpInput(ring, smallTriangle),
      store,
      'vertex-pair-hull'
    )
    expect(rejected.ok).toBe(false)

    // lift the ring off the line; the frozen iterator still replays the
    // collinear snapshot the retained rejection was derived from
    ring[1] = { x: 4, y: 0 }
    ring[2] = { x: 0, y: 4 }

    const accepted = resolveNfpBoundary(
      makeNfpInput(ring, smallTriangle),
      store,
      'vertex-pair-hull'
    )
    expect(accepted.ok).toBe(true)
  })

  it('accepts a plain ring identically however it is iterated', () => {
    const store = makeStore()
    const plain = resolveNfpBoundary(
      makeNfpInput(
        [
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 }
        ],
        smallTriangle
      ),
      store,
      'vertex-pair-hull'
    )
    const frozen = resolveNfpBoundary(
      makeNfpInput(
        ringWithFrozenIterator([
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 4 }
        ]),
        smallTriangle
      ),
      makeStore(),
      'vertex-pair-hull'
    )

    expect(frozen).toEqual(plain)
  })
})
