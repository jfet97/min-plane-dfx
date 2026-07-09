import type { DxfArcSegment } from '@shared/domain/dxf.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'

export const ArcFlattening = {
  samplePoints,
  computeSampleCount
} as const

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

function computeSampleCount(arc: DxfArcSegment, sagToleranceMm: number): number {
  // invalid or degenerate arcs can only contribute their imported endpoints
  if (!Number.isFinite(arc.radius) || arc.radius <= 0) return 1

  // zero or invalid tolerance means no interior samples are requested
  if (!Number.isFinite(sagToleranceMm) || sagToleranceMm <= 0) return 1

  // compute the positive counter-clockwise DXF sweep in radians
  const sweepRad = degreesToRadians(computeCounterClockwiseSweepDegrees(arc))

  // degenerate sweeps can only contribute their imported endpoints
  if (sweepRad <= 0) return 1

  // cap the sagitta tolerance so the acos input always stays inside its domain
  const cappedSagToleranceMm = Math.min(sagToleranceMm, arc.radius)

  // derive the largest chord angle whose sagitta is still within tolerance
  const maxStepRad = 2 * Math.acos(1 - cappedSagToleranceMm / arc.radius)

  // fall back to endpoints if numeric inputs still produced an unusable step
  if (!Number.isFinite(maxStepRad) || maxStepRad <= 0) return 1

  // return the number of chords, not the number of emitted points
  return Math.max(1, Math.ceil(sweepRad / maxStepRad))
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
