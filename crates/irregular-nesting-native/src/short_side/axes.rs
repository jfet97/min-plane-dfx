//! Physical Short Side axis resolution: the exact "which sheet dimension is
//! the short edge" convention shared by every producer in this cluster.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicShortSideAxes.ts`
//! (34 lines), ported here in full.
//!
//! See `docs/planning/rust-irregular-backend/characterization/short-side.md`
//! §3.1 for the exact behavior, including the **square-sheet rule**: because
//! the TS comparison is strict `<` (`sheet.width < sheet.height`), a square
//! sheet (`width === height`) always takes the `false` branch —
//! `short_axis = Height`, `long_axis = Width`,
//! `normalized_to_physical_rotation_deg = Ninety`. Combined with the 90°
//! quarter-turn semantics of `search::beam_state::IrregularBeamState::with_quarter_turn_bottom_left`
//! (`(x, y) -> (-y, x)`), this is exactly the "on square sheets physical Y is
//! the short axis, physical X is the long axis" rule migration prompt §12
//! requires: Short Side always constructs internally in normalized
//! coordinates where `x` is the short axis and `y` is the long axis, then
//! applies this prescribed rotation once at the end to map back onto the
//! sheet's physical width/height axes.

use crate::domain::SheetSpec;
use crate::search::beam_state::IrregularQuarterTurnDegrees;

/// TS: `intrinsicShortSideAxes.ts:1-6` `type: 'width' | 'height'` (both the
/// `shortAxis` and `longAxis` fields share this literal union).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortSideAxisDimension {
    Width,
    Height,
}

impl ShortSideAxisDimension {
    /// The literal TS string this value renders as in a trace field
    /// (`'width'` / `'height'`).
    pub fn as_str(self) -> &'static str {
        match self {
            ShortSideAxisDimension::Width => "width",
            ShortSideAxisDimension::Height => "height",
        }
    }
}

/// TS: `intrinsicShortSideAxes.ts:6` `normalizedToPhysicalRotationDeg: 0 |
/// 90`. Kept as its own narrow (never 180/270) closed type — distinct from
/// [`IrregularQuarterTurnDegrees`], which this cluster's beam-state rotation
/// calls need — because every trace field carrying this value in the TS
/// source is declared exactly `0 | 90`, never the full quarter-turn range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortSideRotationDeg {
    Zero,
    Ninety,
}

impl ShortSideRotationDeg {
    /// The plain `f64` degree value this cluster's trace fields serialize
    /// (TS: the literal `0` or `90` number).
    pub fn as_degrees_f64(self) -> f64 {
        match self {
            ShortSideRotationDeg::Zero => 0.0,
            ShortSideRotationDeg::Ninety => 90.0,
        }
    }

    /// Converts to the wider [`IrregularQuarterTurnDegrees`] this cluster's
    /// `IrregularBeamState::with_quarter_turn_bottom_left` calls need.
    pub fn as_quarter_turn(self) -> IrregularQuarterTurnDegrees {
        match self {
            ShortSideRotationDeg::Zero => IrregularQuarterTurnDegrees::Zero,
            ShortSideRotationDeg::Ninety => IrregularQuarterTurnDegrees::Ninety,
        }
    }
}

/// TS: `intrinsicShortSideAxes.ts:1-7` `IntrinsicShortSideAxes`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IntrinsicShortSideAxes {
    pub short_axis: ShortSideAxisDimension,
    pub long_axis: ShortSideAxisDimension,
    pub short_axis_mm: f64,
    pub long_axis_mm: f64,
    pub normalized_to_physical_rotation_deg: ShortSideRotationDeg,
}

/// TS: `intrinsicShortSideAxes.ts:15-27` (`intrinsicShortSideAxes`).
///
/// Resolves the physical Short Side axes once for every producer and gate.
/// Rectangles use their smaller dimension. Squares deterministically use
/// physical Y as the short axis and physical X as the long axis (see this
/// module's top doc for the exact mechanism).
pub fn intrinsic_short_side_axes(sheet: &SheetSpec) -> IntrinsicShortSideAxes {
    let short_axis_is_width = sheet.width < sheet.height;
    IntrinsicShortSideAxes {
        short_axis: if short_axis_is_width {
            ShortSideAxisDimension::Width
        } else {
            ShortSideAxisDimension::Height
        },
        long_axis: if short_axis_is_width {
            ShortSideAxisDimension::Height
        } else {
            ShortSideAxisDimension::Width
        },
        short_axis_mm: if short_axis_is_width {
            sheet.width
        } else {
            sheet.height
        },
        long_axis_mm: if short_axis_is_width {
            sheet.height
        } else {
            sheet.width
        },
        normalized_to_physical_rotation_deg: if short_axis_is_width {
            ShortSideRotationDeg::Zero
        } else {
            ShortSideRotationDeg::Ninety
        },
    }
}

/// A plain `(width, height)` pair, matching TS's inline `{ readonly width:
/// number; readonly height: number }` parameter type for
/// `intrinsicShortSideSpan` (`intrinsicShortSideAxes.ts:29-34`) — deliberately
/// not [`SheetSpec`] (no `label` field is available at every call site this
/// function is used from).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShortSideDimensions {
    pub width: f64,
    pub height: f64,
}

/// TS: `intrinsicShortSideAxes.ts:29-34` (`intrinsicShortSideSpan`). Picks
/// `dimensions.width` or `dimensions.height` by `axes.shortAxis`.
pub fn intrinsic_short_side_span(
    axes: &IntrinsicShortSideAxes,
    dimensions: ShortSideDimensions,
) -> f64 {
    match axes.short_axis {
        ShortSideAxisDimension::Width => dimensions.width,
        ShortSideAxisDimension::Height => dimensions.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test".to_string(),
        }
    }

    #[test]
    fn narrow_width_sheet_uses_width_as_the_short_axis() {
        // width (400) < height (600): TS `shortAxisIsWidth = width < height`
        // takes the `true` branch.
        let axes = intrinsic_short_side_axes(&sheet(400.0, 600.0));
        assert_eq!(axes.short_axis, ShortSideAxisDimension::Width);
        assert_eq!(axes.long_axis, ShortSideAxisDimension::Height);
        assert_eq!(axes.short_axis_mm, 400.0);
        assert_eq!(axes.long_axis_mm, 600.0);
        assert_eq!(
            axes.normalized_to_physical_rotation_deg,
            ShortSideRotationDeg::Zero
        );
    }

    #[test]
    fn narrow_height_sheet_uses_height_as_the_short_axis() {
        // width (2700) is not < height (2000): TS `shortAxisIsWidth` takes
        // the `false` branch, so height (the narrower dimension) is short.
        let axes = intrinsic_short_side_axes(&sheet(2700.0, 2000.0));
        assert_eq!(axes.short_axis, ShortSideAxisDimension::Height);
        assert_eq!(axes.long_axis, ShortSideAxisDimension::Width);
        assert_eq!(axes.short_axis_mm, 2000.0);
        assert_eq!(axes.long_axis_mm, 2700.0);
        assert_eq!(
            axes.normalized_to_physical_rotation_deg,
            ShortSideRotationDeg::Ninety
        );
    }

    #[test]
    fn square_sheet_deterministically_takes_the_height_short_axis_branch() {
        let axes = intrinsic_short_side_axes(&sheet(300.0, 300.0));
        assert_eq!(axes.short_axis, ShortSideAxisDimension::Height);
        assert_eq!(axes.long_axis, ShortSideAxisDimension::Width);
        assert_eq!(
            axes.normalized_to_physical_rotation_deg,
            ShortSideRotationDeg::Ninety
        );
    }

    #[test]
    fn span_picks_by_short_axis() {
        let axes = intrinsic_short_side_axes(&sheet(400.0, 600.0));
        let span = intrinsic_short_side_span(
            &axes,
            ShortSideDimensions {
                width: 111.0,
                height: 222.0,
            },
        );
        assert_eq!(span, 111.0);

        let axes = intrinsic_short_side_axes(&sheet(300.0, 300.0));
        let span = intrinsic_short_side_span(
            &axes,
            ShortSideDimensions {
                width: 111.0,
                height: 222.0,
            },
        );
        assert_eq!(span, 222.0);
    }
}
