/** Deterministic sag-tolerance sampling for DXF circular arcs and bulge chords. */

import type { DxfArcSegment, DxfLineSegment } from '@shared/domain/dxf.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'

/** Samples source circular curves without mutating their imported endpoints. */
export const ArcFlattening = {
  samplePoints,
  sampleBulgePoints,
  computeSampleCount
} as const

/** Samples a circular DXF arc with endpoints preserved exactly. */
function samplePoints(arc: DxfArcSegment, sagToleranceMm: number): ReadonlyArray<IrregularPoint> {
  const points: IrregularPoint[] = []

  // compute how many straight chords are needed to respect the sagitta tolerance
  const sampleCount = computeSampleCount(arc, sagToleranceMm)

  // keep the imported start point exact so adjacent source segments stay connected
  points.push({ x: arc.x1, y: arc.y1 })

  // emit only interior analytic samples because endpoints come from the importer
  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    // convert the sample index into a deterministic position along the counter-clockwise sweep
    const sampleRatio = sampleIndex / sampleCount

    // interpolate the DXF arc angle in degrees before converting to radians
    const angleDeg = computeSampleAngleDegrees(arc, sampleRatio)

    // convert degrees to radians for plain JavaScript trigonometry
    const angleRad = degreesToRadians(angleDeg)

    // project the sampled angle back onto the analytic circle
    points.push({
      x: arc.cx + Math.cos(angleRad) * arc.radius,
      y: arc.cy + Math.sin(angleRad) * arc.radius
    })
  }

  // keep the imported end point exact for the same connectivity reason as the start point
  points.push({ x: arc.x2, y: arc.y2 })

  return points
}

/**
 * Samples an LWPOLYLINE/POLYLINE bulge chord using its signed analytic arc.
 *
 * The preview keeps the chord as a line for compatibility, but collision
 * geometry follows the signed bulge sweep so negative clockwise bulges are not
 * silently converted into the opposite major arc.
 */
function sampleBulgePoints(
  segment: DxfLineSegment,
  sagToleranceMm: number
): ReadonlyArray<IrregularPoint> {
  const points: IrregularPoint[] = [{ x: segment.x1, y: segment.y1 }]
  const arc = bulgeArcParameters(segment)
  if (arc === null) {
    points.push({ x: segment.x2, y: segment.y2 })
    return points
  }

  const sampleCount = computeSampleCountForSweep(arc.radius, Math.abs(arc.sweep), sagToleranceMm)
  for (let sampleIndex = 1; sampleIndex < sampleCount; sampleIndex += 1) {
    const sampleRatio = sampleIndex / sampleCount
    const angle = arc.startAngle + arc.sweep * sampleRatio
    points.push({
      x: arc.centerX + Math.cos(angle) * arc.radius,
      y: arc.centerY + Math.sin(angle) * arc.radius
    })
  }
  points.push({ x: segment.x2, y: segment.y2 })
  return points
}

interface BulgeArcParameters {
  readonly centerX: number
  readonly centerY: number
  readonly radius: number
  readonly startAngle: number
  readonly sweep: number
}

/** Converts a signed bulge into center, radius, and sweep parameters. */
function bulgeArcParameters(segment: DxfLineSegment): BulgeArcParameters | null {
  const bulge = segment.bulge
  if (
    bulge === undefined ||
    !Number.isFinite(bulge) ||
    bulge === 0 ||
    ![segment.x1, segment.y1, segment.x2, segment.y2].every(Number.isFinite)
  ) {
    return null
  }

  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const chord = Math.hypot(dx, dy)
  const sweep = 4 * Math.atan(bulge)
  const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge))
  if (
    !Number.isFinite(chord) ||
    chord <= 0 ||
    !Number.isFinite(sweep) ||
    !Number.isFinite(radius)
  ) {
    return null
  }

  const midpointX = (segment.x1 + segment.x2) / 2
  const midpointY = (segment.y1 + segment.y2) / 2
  const centerOffset = (chord * (1 - bulge * bulge)) / (4 * bulge)
  const centerX = midpointX + (-dy / chord) * centerOffset
  const centerY = midpointY + (dx / chord) * centerOffset
  const startAngle = Math.atan2(segment.y1 - centerY, segment.x1 - centerX)
  return { centerX, centerY, radius, startAngle, sweep }
}

/** Computes the chord count required by a radius and absolute angular sweep. */
function computeSampleCountForSweep(
  radius: number,
  sweepRad: number,
  sagToleranceMm: number
): number {
  if (!Number.isFinite(radius) || radius <= 0) return 1
  if (!Number.isFinite(sweepRad) || sweepRad <= 0) return 1
  if (!Number.isFinite(sagToleranceMm) || sagToleranceMm <= 0) return 1

  const cappedSagToleranceMm = Math.min(sagToleranceMm, radius)
  const maxStepRad = 2 * Math.acos(1 - cappedSagToleranceMm / radius)
  if (!Number.isFinite(maxStepRad) || maxStepRad <= 0) return 1
  return Math.max(1, Math.ceil(sweepRad / maxStepRad))
}

/** Computes how many chords are needed for the configured sag tolerance. */
function computeSampleCount(arc: DxfArcSegment, sagToleranceMm: number): number {
  const sweepRad = degreesToRadians(computeCounterClockwiseSweepDegrees(arc))
  return computeSampleCountForSweep(arc.radius, sweepRad, sagToleranceMm)
}

function computeSampleAngleDegrees(arc: DxfArcSegment, sampleRatio: number): number {
  // interpolate over the normalized counter-clockwise sweep without changing imported endpoints
  return arc.startAngle + computeCounterClockwiseSweepDegrees(arc) * sampleRatio
}

function computeCounterClockwiseSweepDegrees(arc: DxfArcSegment): number {
  // non-finite angles are treated as degenerate so the caller emits endpoints only
  if (!Number.isFinite(arc.startAngle) || !Number.isFinite(arc.endAngle)) return 0

  // compute the raw counter-clockwise sweep from the imported angle pair
  const rawSweepDeg = arc.endAngle - arc.startAngle

  // preserve already-positive sweeps, including larger-than-full-turn data if present
  if (rawSweepDeg > 0) return rawSweepDeg

  // normalize wrapped arcs such as 350deg -> 10deg into a positive 20deg sweep
  const wrappedSweepDeg = rawSweepDeg % 360

  // treat exactly matching start and end angles as a full counter-clockwise turn
  if (wrappedSweepDeg === 0) return 360

  // move negative wrapped sweeps into the positive counter-clockwise range
  return wrappedSweepDeg + 360
}

function degreesToRadians(degrees: number): number {
  // keep the unit conversion centralized so geometry math stays readable
  return (degrees * Math.PI) / 180
}
