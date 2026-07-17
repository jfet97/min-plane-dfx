/** Millimeter resolution used to canonicalize derived irregular score inputs. */
export const IRREGULAR_SCORE_GRID_STEP_MM = 0.001
/** Dimensionless resolution used before grouping normalized score values. */
export const IRREGULAR_SCORE_SCALAR_STEP = 0.000001

const IRREGULAR_SCORE_GRID_SCALE = 1 / IRREGULAR_SCORE_GRID_STEP_MM
const IRREGULAR_SCORE_SCALAR_SCALE = 1 / IRREGULAR_SCORE_SCALAR_STEP

/**
 * Canonicalizes one finite millimeter value to the explicit irregular score
 * grid using nearest rounding with ties away from zero. Collision geometry is
 * already resolved at this precision; scoring at the same grid removes only
 * sub-grid arithmetic noise and does not use tolerance-based comparison.
 */
export function canonicalizeIrregularScoreMillimeters(valueMm: number): number | undefined {
  const gridUnits = canonicalizeIrregularScoreMillimeterUnits(valueMm)
  return gridUnits === undefined ? undefined : gridUnits / IRREGULAR_SCORE_GRID_SCALE
}

/** Converts one finite millimeter value to an exact integer score-grid identity. */
export function canonicalizeIrregularScoreMillimeterUnits(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm)) return undefined

  const scaledAbsoluteValue = Math.abs(valueMm) * IRREGULAR_SCORE_GRID_SCALE
  if (!Number.isFinite(scaledAbsoluteValue)) return undefined

  const roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)
  const gridValue = Math.sign(valueMm) * roundedAbsoluteValue
  return Number.isSafeInteger(gridValue) ? gridValue : undefined
}

/** Canonicalizes one finite dimensionless score before deterministic banding. */
export function canonicalizeIrregularScoreScalar(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined

  const scaledAbsoluteValue = Math.abs(value) * IRREGULAR_SCORE_SCALAR_SCALE
  if (!Number.isFinite(scaledAbsoluteValue)) return undefined

  const roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)
  const gridValue = Math.sign(value) * roundedAbsoluteValue
  return Number.isSafeInteger(gridValue) ? gridValue / IRREGULAR_SCORE_SCALAR_SCALE : undefined
}
