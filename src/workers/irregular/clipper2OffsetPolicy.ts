/**
 * Declares the complete deterministic policy for the initial Clipper2 offset.
 * Coordinates enter the library as integer Paths64 in scaled millimeters;
 * robust predicates remain the input and output geometry authority.
 */
export const CLIPPER2_OFFSET_POLICY = {
  backendPackage: 'clipper2-ts',
  backendVersion: '2.0.1-18',
  adapterPathMode: 'integer Paths64 via inflatePaths',
  decimalPrecision: 3,
  scale: 1000,
  gridStepMm: 0.001,
  rounding: 'nearest grid point, ties away from zero',
  conservativeOffsetAllowanceMm: 0.002,
  joinType: 'Miter',
  miterLimit: 10.0,
  endType: 'Polygon',
  futureRoundJoinArcToleranceMm: 0.01,
  fillRule: 'NonZero',
  winding: 'counter-clockwise',
  maxScaledCoordinate: 1_000_000_000,
  adapterPolicyVersion: 'clipper2-offset-v3'
} as const

/**
 * Adds the fixed allowance required to preserve the requested real-valued
 * collision envelope after nearest-grid coordinate and offset rounding.
 *
 * A source point can move by at most half a grid step on each axis, or less
 * than `sqrt(2) * gridStepMm / 2` in any direction. The requested offset can
 * then round down by another half grid step. `0.002 mm` exceeds their combined
 * `0.001208 mm` maximum while staying far below the configured curve sag.
 */
export function conservativeOffsetMm(distanceMm: number): number {
  return distanceMm + CLIPPER2_OFFSET_POLICY.conservativeOffsetAllowanceMm
}

/**
 * Quantizes millimeters to the adapter grid using nearest rounding with ties
 * away from zero. Undefined means the value cannot be represented safely.
 */
export function toGridMm(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm)) return undefined

  const scaledAbsoluteValue = Math.abs(valueMm) * CLIPPER2_OFFSET_POLICY.scale
  if (!Number.isFinite(scaledAbsoluteValue)) return undefined

  const roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)
  const gridValue = Math.sign(valueMm) * roundedAbsoluteValue
  return Number.isSafeInteger(gridValue) ? gridValue : undefined
}

/** Dequantizes one Clipper2 integer coordinate without applying another rounding pass. */
export function fromGrid(value: number): number {
  return value / CLIPPER2_OFFSET_POLICY.scale
}
