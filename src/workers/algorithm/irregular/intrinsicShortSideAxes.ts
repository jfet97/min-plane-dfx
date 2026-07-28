export interface IntrinsicShortSideAxes {
  readonly shortAxis: 'width' | 'height'
  readonly longAxis: 'width' | 'height'
  readonly shortAxisMm: number
  readonly longAxisMm: number
  readonly normalizedToPhysicalRotationDeg: 0 | 90
}

/**
 * Resolves the physical Short Side axes once for every producer and gate.
 *
 * Rectangles use their smaller dimension. Squares deterministically use
 * physical Y as the short axis and physical X as the long axis.
 */
export function intrinsicShortSideAxes(sheet: {
  readonly width: number
  readonly height: number
}): IntrinsicShortSideAxes {
  const shortAxisIsWidth = sheet.width < sheet.height
  return {
    shortAxis: shortAxisIsWidth ? 'width' : 'height',
    longAxis: shortAxisIsWidth ? 'height' : 'width',
    shortAxisMm: shortAxisIsWidth ? sheet.width : sheet.height,
    longAxisMm: shortAxisIsWidth ? sheet.height : sheet.width,
    normalizedToPhysicalRotationDeg: shortAxisIsWidth ? 0 : 90
  }
}

export function intrinsicShortSideSpan(
  axes: IntrinsicShortSideAxes,
  dimensions: { readonly width: number; readonly height: number }
): number {
  return axes.shortAxis === 'width' ? dimensions.width : dimensions.height
}
