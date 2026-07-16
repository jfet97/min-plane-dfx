/** Millimeter resolution used to canonicalize derived irregular score inputs. */
export const IRREGULAR_SCORE_GRID_STEP_MM = 0.001

const IRREGULAR_SCORE_GRID_SCALE = 1 / IRREGULAR_SCORE_GRID_STEP_MM

/**
 * Canonicalizes one finite millimeter value to the explicit irregular score
 * grid using nearest rounding with ties away from zero. Collision geometry is
 * already resolved at this precision; scoring at the same grid removes only
 * sub-grid arithmetic noise and does not use tolerance-based comparison.
 */
export function canonicalizeIrregularScoreMillimeters(valueMm: number): number | undefined {
  if (!Number.isFinite(valueMm)) return undefined

  const scaledAbsoluteValue = Math.abs(valueMm) * IRREGULAR_SCORE_GRID_SCALE
  if (!Number.isFinite(scaledAbsoluteValue)) return undefined

  const roundedAbsoluteValue = Math.floor(scaledAbsoluteValue + 0.5)
  const gridValue = Math.sign(valueMm) * roundedAbsoluteValue
  return Number.isSafeInteger(gridValue) ? gridValue / IRREGULAR_SCORE_GRID_SCALE : undefined
}
