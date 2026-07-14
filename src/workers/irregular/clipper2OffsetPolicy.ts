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
  joinType: 'Miter',
  miterLimit: 2.0,
  endType: 'Polygon',
  futureRoundJoinArcToleranceMm: 0.01,
  fillRule: 'NonZero',
  winding: 'counter-clockwise',
  maxScaledCoordinate: 1_000_000_000,
  adapterPolicyVersion: 'clipper2-offset-v1'
} as const

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
