//! Sheet spec and sheet-space diagnostic/material carriers.
//!
//! TS source: `src/shared/domain/nesting.ts:59-63` (`SheetSpec`) and
//! `src/shared/irregular/domain.ts:786-881` (`IrregularNfp`,
//! `IrregularIfpBounds`, `FreeMaterialRegion`, `FreeMaterialSnapshot`).

use serde::{Deserialize, Serialize};

use super::collision::CollisionGeometryDiagnostic;
use super::geometry::{IrregularBounds, IrregularPolygon};
use super::ids::PieceId;

/// TS: `src/shared/domain/nesting.ts:59-63` `class SheetSpec`.
///
/// Per `docs/planning/rust-irregular-backend/characterization/effect-boundary.md`
/// §14 item 7: `SheetSpec` is a real, validating `Schema.Class` in TS despite
/// crossing into hot-path territory, because it is constructed once per job,
/// not once per candidate. The Rust port keeps this as an ordinary struct
/// (validation stays TS-side like every other trusted carrier in this
/// module) — callers must preserve the same "construct once per job"
/// discipline rather than reconstructing one per placement candidate.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SheetSpec {
    /// TS: `nesting.ts:60` `PositiveIntegerMillimeters` — mirrored as `f64`
    /// per this module's number-fidelity convention (see
    /// `transform.rs`'s doc comment on `IrregularTransformCandidate::index`).
    pub width: f64,
    pub height: f64,
    pub label: String,
}

/// TS: `domain.ts:793-807` `class IrregularNfp`. A no-fit polygon boundary
/// in moving-placement-coordinate space.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularNfp {
    pub fixed_piece_id: PieceId,
    pub moving_piece_id: PieceId,
    pub boundary: IrregularPolygon,
}

/// TS: `domain.ts:817-831` `class IrregularIfpBounds`. A rectangular
/// inner-fit bound for one transformed moving piece.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularIfpBounds {
    pub sheet: SheetSpec,
    pub moving_piece_id: PieceId,
    pub bounds: IrregularBounds,
}

/// TS: `domain.ts:833-857` `class FreeMaterialRegion`.
///
/// One sheet-space material region: material inside `boundary` except for
/// its explicitly represented interior `holes`. This is a diagnostic and
/// scoring display model, not a nesting-legality model
/// (`domain.ts:837-839`): it must not be used as an implicit concave or
/// hole-aware placement feature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FreeMaterialRegion {
    pub boundary: IrregularPolygon,
    pub holes: Vec<IrregularPolygon>,
}

/// TS: `domain.ts:867-881` `class FreeMaterialSnapshot`. Remaining
/// sheet-space material and diagnostics after placed collision geometry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeMaterialSnapshot {
    pub sheet: SheetSpec,
    pub regions: Vec<FreeMaterialRegion>,
    pub diagnostics: Vec<CollisionGeometryDiagnostic>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::geometry::IrregularPoint;

    fn sample_sheet() -> SheetSpec {
        SheetSpec {
            width: 2000.0,
            height: 2700.0,
            label: "default 1x1 m".to_string(),
        }
    }

    fn sample_polygon() -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(10.0, 0.0),
            IrregularPoint::new(10.0, 10.0),
            IrregularPoint::new(0.0, 10.0),
        ])
    }

    #[test]
    fn sheet_spec_round_trips_through_json() {
        let sheet = sample_sheet();
        let json = serde_json::to_string(&sheet).expect("sheet spec serializes");
        assert_eq!(
            json,
            r#"{"width":2000.0,"height":2700.0,"label":"default 1x1 m"}"#
        );
        let decoded: SheetSpec = serde_json::from_str(&json).expect("sheet spec deserializes");
        assert_eq!(decoded, sheet);
    }

    #[test]
    fn irregular_nfp_round_trips_through_json() {
        let nfp = IrregularNfp {
            fixed_piece_id: PieceId::new("fixed-1"),
            moving_piece_id: PieceId::new("moving-1"),
            boundary: sample_polygon(),
        };
        let json = serde_json::to_string(&nfp).expect("nfp serializes");
        let decoded: IrregularNfp = serde_json::from_str(&json).expect("nfp deserializes");
        assert_eq!(decoded, nfp);
    }

    #[test]
    fn free_material_snapshot_round_trips_with_holes() {
        let snapshot = FreeMaterialSnapshot {
            sheet: sample_sheet(),
            regions: vec![FreeMaterialRegion {
                boundary: sample_polygon(),
                holes: vec![sample_polygon()],
            }],
            diagnostics: vec![],
        };
        let json = serde_json::to_string(&snapshot).expect("snapshot serializes");
        let decoded: FreeMaterialSnapshot =
            serde_json::from_str(&json).expect("snapshot deserializes");
        assert_eq!(decoded, snapshot);
    }
}
