/** Deterministic adaptive flattening for preserved DXF ellipse parameters. */

import type { DxfEllipseSource } from '@shared/domain/dxf.js'
import type { IrregularPoint } from '@shared/irregular/domain.js'

const FULL_TURN_RADIANS = Math.PI * 2
const INITIAL_MAX_SWEEP_RADIANS = Math.PI / 2
const MAX_RECURSION_DEPTH = 20
const MAX_SAMPLE_POINTS = 1_000_000

/** Samples an ellipse arc until each accepted chord stays within sag tolerance. */
export const EllipseFlattening = {
  samplePoints
} as const

/**
 * Adaptively samples the preserved ellipse equation in source coordinates.
 *
 * Initial intervals are no wider than a quarter turn, then midpoint and
 * quarter-point chord distances drive subdivision. This avoids treating an
 * ellipse as a circle while keeping output deterministic for the same source
 * parameters and tolerance.
 */
function samplePoints(
  ellipse: DxfEllipseSource,
  sagToleranceMm: number
): ReadonlyArray<IrregularPoint> {
  const sweep = ellipseEndParameter(ellipse.startAngle, ellipse.endAngle) - ellipse.startAngle
  const majorAxisLength = Math.hypot(ellipse.majorAxisX, ellipse.majorAxisY)
  if (!Number.isFinite(sweep) || sweep <= 0 || !Number.isFinite(majorAxisLength) || majorAxisLength <= 0) {
    return []
  }

  const initialSegmentCount = Math.max(1, Math.ceil(sweep / INITIAL_MAX_SWEEP_RADIANS))
  const startPoint = ellipsePoint(ellipse, ellipse.startAngle)
  const points: IrregularPoint[] = [startPoint]
  const isFullEllipse = Math.abs(sweep - FULL_TURN_RADIANS) <= 1e-9

  for (let segmentIndex = 0; segmentIndex < initialSegmentCount; segmentIndex += 1) {
    const intervalStart = ellipse.startAngle + (sweep * segmentIndex) / initialSegmentCount
    const intervalEnd = ellipse.startAngle + (sweep * (segmentIndex + 1)) / initialSegmentCount
    const intervalStartPoint =
      segmentIndex === 0 ? startPoint : ellipsePoint(ellipse, intervalStart)
    const intervalEndPoint =
      segmentIndex === initialSegmentCount - 1 && isFullEllipse
        ? startPoint
        : ellipsePoint(ellipse, intervalEnd)
    appendFlattenedInterval(
      points,
      ellipse,
      intervalStart,
      intervalEnd,
      intervalStartPoint,
      intervalEndPoint,
      sagToleranceMm,
      0
    )
  }

  return points
}

/** Appends one accepted interval while preserving its exact analytic endpoint. */
function appendFlattenedInterval(
  output: IrregularPoint[],
  ellipse: DxfEllipseSource,
  intervalStart: number,
  intervalEnd: number,
  startPoint: IrregularPoint,
  endPoint: IrregularPoint,
  sagToleranceMm: number,
  recursionDepth: number
): void {
  if (
    recursionDepth >= MAX_RECURSION_DEPTH ||
    output.length >= MAX_SAMPLE_POINTS ||
    !needsSubdivision(ellipse, intervalStart, intervalEnd, startPoint, endPoint, sagToleranceMm)
  ) {
    output.push(endPoint)
    return
  }

  const intervalMiddle = (intervalStart + intervalEnd) / 2
  const middlePoint = ellipsePoint(ellipse, intervalMiddle)
  appendFlattenedInterval(
    output,
    ellipse,
    intervalStart,
    intervalMiddle,
    startPoint,
    middlePoint,
    sagToleranceMm,
    recursionDepth + 1
  )
  appendFlattenedInterval(
    output,
    ellipse,
    intervalMiddle,
    intervalEnd,
    middlePoint,
    endPoint,
    sagToleranceMm,
    recursionDepth + 1
  )
}

/** Uses a conservative analytic bound and sampled deviations before subdivision. */
function needsSubdivision(
  ellipse: DxfEllipseSource,
  intervalStart: number,
  intervalEnd: number,
  startPoint: IrregularPoint,
  endPoint: IrregularPoint,
  sagToleranceMm: number
): boolean {
  const intervalLength = intervalEnd - intervalStart
  const maximumAxisLength = Math.max(
    Math.hypot(ellipse.majorAxisX, ellipse.majorAxisY),
    Math.hypot(ellipse.majorAxisX, ellipse.majorAxisY) * ellipse.axisRatio
  )
  const conservativeDeviationBound = (maximumAxisLength * intervalLength * intervalLength) / 8
  if (conservativeDeviationBound <= sagToleranceMm) return false

  const quarterPoint = ellipsePoint(ellipse, intervalStart + intervalLength * 0.25)
  const middlePoint = ellipsePoint(ellipse, intervalStart + intervalLength * 0.5)
  const threeQuarterPoint = ellipsePoint(ellipse, intervalStart + intervalLength * 0.75)
  const maximumDeviation = Math.max(
    distanceToChord(quarterPoint, startPoint, endPoint),
    distanceToChord(middlePoint, startPoint, endPoint),
    distanceToChord(threeQuarterPoint, startPoint, endPoint)
  )
  return maximumDeviation > sagToleranceMm
}

/** Evaluates the DXF ellipse equation using its major and rotated minor vectors. */
function ellipsePoint(ellipse: DxfEllipseSource, parameter: number): IrregularPoint {
  const minorAxisX = -ellipse.majorAxisY * ellipse.axisRatio
  const minorAxisY = ellipse.majorAxisX * ellipse.axisRatio
  return {
    x: ellipse.cx + ellipse.majorAxisX * Math.cos(parameter) + minorAxisX * Math.sin(parameter),
    y: ellipse.cy + ellipse.majorAxisY * Math.cos(parameter) + minorAxisY * Math.sin(parameter)
  }
}

/** Measures a point's shortest distance to a finite chord segment. */
function distanceToChord(
  point: IrregularPoint,
  startPoint: IrregularPoint,
  endPoint: IrregularPoint
): number {
  const deltaX = endPoint.x - startPoint.x
  const deltaY = endPoint.y - startPoint.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (lengthSquared <= 0) return Math.hypot(point.x - startPoint.x, point.y - startPoint.y)

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((point.x - startPoint.x) * deltaX + (point.y - startPoint.y) * deltaY) / lengthSquared
    )
  )
  const closestX = startPoint.x + projection * deltaX
  const closestY = startPoint.y + projection * deltaY
  return Math.hypot(point.x - closestX, point.y - closestY)
}

/** Normalizes wrapped DXF ellipse angles into a positive parameter sweep. */
function ellipseEndParameter(startAngle: number, endAngle: number): number {
  return endAngle <= startAngle ? endAngle + FULL_TURN_RADIANS : endAngle
}
