//! Finite point, bounds, and polygon-ring trusted carriers.
//!
//! TS source: `src/shared/irregular/domain.ts`. These are the *trusted*
//! plain classes (constructed only after the corresponding `Schema.Struct`
//! boundary value — `IrregularPointSchema`/`IrregularBoundsSchema`/
//! `IrregularPolygonSchema` — has already been decoded); this module does
//! not port those validating schema values themselves, since validation
//! stays TS-side (migration prompt §4.1).

use serde::{Deserialize, Serialize};

/// TS: `domain.ts:139-147` `class IrregularPoint`. One finite source or
/// collision-geometry coordinate in millimeters.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct IrregularPoint {
    pub x: f64,
    pub y: f64,
}

impl IrregularPoint {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// TS: `domain.ts:171-188` `class IrregularBounds`. Finite axis-aligned
/// bounds for source, collision, or transformed geometry. `domain.ts:150-153`
/// documents the invariant enforced by the schema counterpart at decode
/// time: `minX <= maxX && minY <= maxY` (the minimums may equal the maximums
/// for a degenerate derived artifact, but must never exceed them). This
/// trusted carrier does not re-check that invariant; callers that construct
/// one directly (rather than via a decoded/validated payload) are
/// responsible for it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl IrregularBounds {
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64) -> Self {
        Self {
            min_x,
            min_y,
            max_x,
            max_y,
        }
    }
}

/// TS: `domain.ts:196-202` `class IrregularPolygon`.
///
/// **Ring closure convention** (`domain.ts:190` doc comment, verbatim:
/// "Boundary schema for a polygon without an implicit closing vertex"):
/// `points` never repeats its first vertex as a trailing element to
/// explicitly "close" the ring. Every consumer that needs the closing edge
/// derives it implicitly from `points[len-1]` back to `points[0]`. A Rust
/// port that appended a duplicate closing point (or, conversely, one that
/// assumed an already-duplicated closing point and dropped the last vertex)
/// would silently corrupt every downstream area/perimeter/offset/clip
/// computation that consumes this ring. This module performs no ring-closure
/// normalization itself — `IrregularPolygon` is a plain carrier, and no
/// conversion logic in `domain.ts` normalizes ring closure either; only
/// later geometry-kernel modules (hull/offset/clip) read this convention.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IrregularPolygon {
    pub points: Vec<IrregularPoint>,
}

impl IrregularPolygon {
    pub fn new(points: Vec<IrregularPoint>) -> Self {
        Self { points }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn irregular_point_constructs_and_compares_by_value() {
        let a = IrregularPoint::new(1.5, -2.25);
        let b = IrregularPoint { x: 1.5, y: -2.25 };
        assert_eq!(a, b);
    }

    #[test]
    fn irregular_bounds_field_order_matches_ts_declaration_order() {
        let bounds = IrregularBounds::new(0.0, 0.0, 100.0, 60.0);
        assert_eq!(bounds.min_x, 0.0);
        assert_eq!(bounds.min_y, 0.0);
        assert_eq!(bounds.max_x, 100.0);
        assert_eq!(bounds.max_y, 60.0);
    }

    #[test]
    fn irregular_polygon_ring_has_no_implicit_closing_vertex() {
        // A closed square ring in the TS convention: exactly 4 points, the
        // first vertex never repeated at the end.
        let square = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(10.0, 0.0),
            IrregularPoint::new(10.0, 10.0),
            IrregularPoint::new(0.0, 10.0),
        ]);
        assert_eq!(square.points.len(), 4);
        assert_ne!(square.points.first(), square.points.last());
    }

    #[test]
    fn irregular_polygon_serde_round_trip_preserves_point_order() {
        let polygon = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(1.0, 2.0),
        ]);
        let json = serde_json::to_string(&polygon).expect("polygon serializes");
        assert_eq!(json, r#"{"points":[{"x":0.0,"y":0.0},{"x":1.0,"y":2.0}]}"#);
        let decoded: IrregularPolygon = serde_json::from_str(&json).expect("polygon deserializes");
        assert_eq!(decoded, polygon);
    }

    #[test]
    fn irregular_bounds_serde_round_trip_uses_camel_case_keys() {
        let bounds = IrregularBounds::new(0.0, 1.0, 2.0, 3.0);
        let json = serde_json::to_string(&bounds).expect("bounds serializes");
        assert_eq!(json, r#"{"minX":0.0,"minY":1.0,"maxX":2.0,"maxY":3.0}"#);
        let decoded: IrregularBounds = serde_json::from_str(&json).expect("bounds deserializes");
        assert_eq!(decoded, bounds);
    }
}
