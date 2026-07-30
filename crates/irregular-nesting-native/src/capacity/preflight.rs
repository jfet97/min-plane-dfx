//! Proof-only capacity preflight: exact impossibility proofs via exact area
//! and singleton q0/q90 rules, never a feasibility claim.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityPreflight.ts`
//! (254 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-core.md`
//! before touching this file -- §1 establishes this function as
//! unconditionally live on the production Compact shared-archive path
//! (always called first, before the complete/sheetless archive search);
//! §6/§7 document the exact bigint arithmetic; §10 documents the two
//! cooperative-checkpoint observation points; §11 documents every error
//! path; §13 documents the two associative/commutative parallelism
//! candidates (per-transform inner loop, per-piece outer loop) and their one
//! "first in prepared order, not first completion" constraint on
//! `singletonInfeasiblePieceIds[0]`.
//!
//! # Fail-fast, first-invalid-piece-in-prepared-order
//!
//! Every error in this file aborts the whole computation immediately
//! (`IntrinsicCapacityError`/`IrregularGeometryInputError`/an abort from the
//! caller-supplied [`NfpIfpControl`]) -- there is no partial/inconclusive
//! result on a mid-loop failure. `singletonInfeasiblePieceIds[0]` (the piece
//! id attached to a `singleton-transform-set-does-not-fit` outcome) is the
//! **first** piece in prepared order whose entire transform set fails to fit
//! either rigid orientation -- later infeasible pieces are silently not
//! individually reported (only present in the full
//! `measurements.singleton_infeasible_piece_ids` list).
//!
//! # Reused (GREEN) primitives -- never duplicated here
//!
//! - `canonical_grid::to_grid_mm` -- the canonical-grid quantization
//!   authority.
//! - `clipper::core::f64_to_bigint` -- integer-valued-`f64`-to-`BigInt`.
//! - `caches::{resolve_transformed_collision_geometry,
//!   TransformCollisionGeometryKeyInput, GeometryCacheStore}` -- the same
//!   cached transformed-collision-geometry resolver TS's
//!   `GeometryKernel.transformCollisionGeometry` calls
//!   (`geometryKernel.ts:179-190`); this file never recomputes that geometry
//!   independently.
//! - `nfp_ifp::{nfp_checkpoint, NfpIfpControl, NfpIfpControlAbortError,
//!   NfpIfpCheckpointPhase}` -- the cooperative cancellation/deadline seam,
//!   reused verbatim (TS reuses the same `'candidate-points'` phase tag,
//!   never introducing a phase specific to capacity preflight).
//! - `capacity::material::{intrinsic_capacity_prepared_piece_id,
//!   exact_doubled_polygon_area_grid2}` -- this file's sibling module.
//!
//! # Error taxonomy
//!
//! TS's function signature unions four error types:
//! `IntrinsicCapacityError | IrregularGeometryInputError |
//! IrregularNestingNotImplementedError | IrregularNfpIfpControlAbortError`.
//! The third arm never arises here (the same "GREEN reused module never
//! returns it" reasoning `search::layout_scorer`'s own doc comment
//! documents for the identical situation) -- [`IntrinsicCapacityPreflightError`]
//! covers exactly the three reachable arms.

use num_bigint::BigInt;
use serde::{Serialize, Serializer};

use crate::caches::{
    resolve_transformed_collision_geometry, GeometryCacheStore, TransformCollisionGeometryKeyInput,
};
use crate::canonical_grid::to_grid_mm;
use crate::clipper::core::f64_to_bigint;
use crate::domain::{
    IrregularGeometrySettings, IrregularPoint, IrregularPreparedPiece, PieceId, SheetSpec,
};
use crate::js_number::{js_math, number_to_js_string};
use crate::nfp_ifp::{
    nfp_checkpoint, NfpIfpCheckpointPhase, NfpIfpControl, NfpIfpControlAbortError,
};
use crate::validation::placement::IrregularGeometryInputError;

use super::material::{exact_doubled_polygon_area_grid2, intrinsic_capacity_prepared_piece_id};

/// TS: `intrinsicCapacityPreflight.ts:19-22` `IntrinsicCapacityError`
/// (`Data.TaggedError`). Invalid or incomplete capacity accounting is an
/// error, never a proof. Reused by name (not duplicated) by every other
/// module in this tower that raises it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntrinsicCapacityError {
    pub operation: String,
    pub message: String,
}

/// The three error arms [`preflight_intrinsic_complete_capacity`] can
/// actually produce. See this module's top doc, "Error taxonomy".
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicCapacityPreflightError {
    Capacity(IntrinsicCapacityError),
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

/// TS: `intrinsicCapacityPreflight.ts:24-38` `IntrinsicCapacityPreflightMeasurements`.
/// None of these fields are optional; every variant of
/// [`IntrinsicCapacityPreflightOutcome`] carries the full value.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityPreflightMeasurements {
    pub piece_count: f64,
    pub sheet_width_grid: f64,
    pub sheet_height_grid: f64,
    /// Exact doubled canonical requested-sheet area in grid-squared units.
    /// Wire: decimal string (see `capacity::serialize_bigint_decimal_string`).
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub sheet_doubled_area_grid2: BigInt,
    /// Exact sum over pieces of the minimum valid doubled collision area.
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub minimum_doubled_collision_area_sum_grid2: BigInt,
    /// Scale-free minimum collision-area pressure, rounded up to parts per million.
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub minimum_collision_area_pressure_ppm: BigInt,
    /// Worst piece's best exact q0/q90 axis pressure, rounded up to parts per million.
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub maximum_singleton_span_pressure_ppm: BigInt,
    /// Prepared ids whose entire transform set cannot fit the sheet at q0 or q90.
    pub singleton_infeasible_piece_ids: Vec<PieceId>,
}

/// TS: `intrinsicCapacityPreflight.ts:42-51` the two `proven_impossible`
/// variants' distinguishing `reason` discriminant, collapsed into this enum
/// so only the first variant carries a `piece_id` -- matching TS's "only the
/// first reason carries a `pieceId` field" shape exactly.
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicCapacityProvenImpossibleReason {
    SingletonTransformSetDoesNotFit { piece_id: PieceId },
    MinimumCollisionAreaExceedsSheetArea,
}

impl IntrinsicCapacityProvenImpossibleReason {
    /// TS: the literal `reason` string each variant carries
    /// (`intrinsicCapacityPreflight.ts:43,49`). Callers that interpolate this
    /// into a diagnostic message (or any other TS-facing string) must use
    /// this, not `{:?}` -- `Debug`'s PascalCase variant name is a Rust-only
    /// spelling and diverges from every TS string this type represents.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SingletonTransformSetDoesNotFit { .. } => "singleton-transform-set-does-not-fit",
            Self::MinimumCollisionAreaExceedsSheetArea => {
                "minimum-collision-area-exceeds-sheet-area"
            }
        }
    }
}

/// TS: `intrinsicCapacityPreflight.ts:40-55` `IntrinsicCapacityPreflightOutcome`.
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicCapacityPreflightOutcome {
    ProvenImpossible {
        reason: IntrinsicCapacityProvenImpossibleReason,
        measurements: IntrinsicCapacityPreflightMeasurements,
    },
    Inconclusive {
        measurements: IntrinsicCapacityPreflightMeasurements,
    },
}

/// TS: `intrinsicCapacityPreflight.ts:40-55` `IntrinsicCapacityPreflightOutcome`'s
/// discriminated-union wire shape: `kind: 'proven_impossible' |
/// 'inconclusive'`, `reason`/`pieceId` present only on the
/// `singleton-transform-set-does-not-fit` proven-impossible arm (`reason`
/// present on both proven-impossible arms, `pieceId` only the first),
/// `measurements` always present. A hand-written `Serialize` impl (not
/// `derive`) since no single `#[serde(tag = ...)]` shape reproduces "two
/// proven-impossible variants share `reason`'s field but only one also
/// carries `pieceId`" without restructuring
/// [`IntrinsicCapacityProvenImpossibleReason`] itself.
impl Serialize for IntrinsicCapacityPreflightOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        match self {
            IntrinsicCapacityPreflightOutcome::ProvenImpossible {
                reason,
                measurements,
            } => {
                map.serialize_entry("kind", "proven_impossible")?;
                map.serialize_entry("reason", reason.as_str())?;
                if let IntrinsicCapacityProvenImpossibleReason::SingletonTransformSetDoesNotFit {
                    piece_id,
                } = reason
                {
                    map.serialize_entry("pieceId", piece_id)?;
                }
                map.serialize_entry("measurements", measurements)?;
            }
            IntrinsicCapacityPreflightOutcome::Inconclusive { measurements } => {
                map.serialize_entry("kind", "inconclusive")?;
                map.serialize_entry("measurements", measurements)?;
            }
        }
        map.end()
    }
}

impl IntrinsicCapacityPreflightOutcome {
    /// Flat measurements access shared by both variants -- TS reads
    /// `outcome.measurements` directly via structural typing on the
    /// discriminated union; this is the Rust enum equivalent of that same
    /// flat field access, not a new TS-side concept.
    pub fn measurements(&self) -> &IntrinsicCapacityPreflightMeasurements {
        match self {
            IntrinsicCapacityPreflightOutcome::ProvenImpossible { measurements, .. } => {
                measurements
            }
            IntrinsicCapacityPreflightOutcome::Inconclusive { measurements } => measurements,
        }
    }
}

/// TS: `intrinsicCapacityPreflight.ts:65-193` `preflightIntrinsicCompleteCapacity`.
///
/// Proof-only capacity preflight. It can prove that complete packing is
/// impossible via exact necessary conditions; it can never claim
/// feasibility. The proofs use the exact canonical collision polygons:
/// collision polygons must stay pairwise disjoint inside the sheet, so their
/// exact area sum and each singleton q0/q90 span are sound necessary bounds
/// without any waste percentage, density factor, or safety allowance.
///
/// `cache`/`settings` mirror TS's `GeometryKernel`/`GeometrySettings`
/// context services threaded explicitly (this crate's established
/// job-owned-state convention, not a DI-resolved service object).
pub fn preflight_intrinsic_complete_capacity(
    sheet: &SheetSpec,
    pieces: &[IrregularPreparedPiece],
    settings: &IrregularGeometrySettings,
    cache: &mut GeometryCacheStore,
    mut control: Option<&mut dyn NfpIfpControl>,
) -> Result<IntrinsicCapacityPreflightOutcome, IntrinsicCapacityPreflightError> {
    let sheet_width_grid = to_grid_mm(sheet.width);
    let sheet_height_grid = to_grid_mm(sheet.height);
    let (sheet_width_grid, sheet_height_grid) = match (sheet_width_grid, sheet_height_grid) {
        (Some(width), Some(height)) if width > 0.0 && height > 0.0 => (width, height),
        _ => {
            return Err(IntrinsicCapacityPreflightError::Capacity(
                IntrinsicCapacityError {
                    operation: "preflightSheet".to_string(),
                    message: format!(
                        "requested sheet {}x{} has no exact positive canonical-grid area.",
                        number_to_js_string(sheet.width),
                        number_to_js_string(sheet.height)
                    ),
                },
            ))
        }
    };
    let sheet_doubled_area_grid2 =
        BigInt::from(2) * f64_to_bigint(sheet_width_grid) * f64_to_bigint(sheet_height_grid);

    let mut minimum_doubled_collision_area_sum_grid2 = BigInt::from(0);
    let mut maximum_singleton_span_pressure_ppm = BigInt::from(0);
    let mut singleton_infeasible_piece_ids: Vec<PieceId> = Vec::new();

    for piece in pieces {
        nfp_checkpoint(&mut control, NfpIfpCheckpointPhase::CandidatePoints, None)
            .map_err(IntrinsicCapacityPreflightError::Abort)?;

        let piece_id = intrinsic_capacity_prepared_piece_id(piece);
        if piece.transforms.is_empty() {
            return Err(IntrinsicCapacityPreflightError::Capacity(
                IntrinsicCapacityError {
                    operation: "preflightTransforms".to_string(),
                    message: format!(
                        "piece {} has an empty transform set; capacity accounting is incomplete.",
                        piece_id.as_str()
                    ),
                },
            ));
        }

        let mut minimum_doubled_area_grid2: Option<BigInt> = None;
        let mut minimum_singleton_span_pressure_ppm: Option<BigInt> = None;
        let mut singleton_fits = false;

        for transform in &piece.transforms {
            nfp_checkpoint(&mut control, NfpIfpCheckpointPhase::CandidatePoints, None)
                .map_err(IntrinsicCapacityPreflightError::Abort)?;

            let key_input = TransformCollisionGeometryKeyInput {
                geometry: &piece.collision_geometry,
                transform,
            };
            let moving =
                resolve_transformed_collision_geometry(&key_input, settings, cache, |computed| {
                    computed
                })
                .map_err(|message| {
                    IntrinsicCapacityPreflightError::Geometry(IrregularGeometryInputError {
                        operation: "transformCollisionGeometry".to_string(),
                        message,
                    })
                })?
                .value;

            let doubled_area_grid2 = exact_doubled_polygon_area_grid2(&moving.polygon.points);
            let span = transformed_grid_span(&moving.polygon.points);
            let (doubled_area_grid2, span) = match (doubled_area_grid2, span) {
                (Some(area), Some(span)) => (area, span),
                _ => {
                    return Err(IntrinsicCapacityPreflightError::Capacity(
                        IntrinsicCapacityError {
                            operation: "preflightTransformGeometry".to_string(),
                            message: format!(
                                "piece {} transform {} has no exact positive canonical collision polygon.",
                                piece_id.as_str(),
                                number_to_js_string(transform.index)
                            ),
                        },
                    ))
                }
            };

            if minimum_doubled_area_grid2
                .as_ref()
                .is_none_or(|current| doubled_area_grid2 < *current)
            {
                minimum_doubled_area_grid2 = Some(doubled_area_grid2);
            }

            let span_pressure_ppm =
                minimum_rigid_span_pressure_ppm(&span, sheet_width_grid, sheet_height_grid);
            if minimum_singleton_span_pressure_ppm
                .as_ref()
                .is_none_or(|current| span_pressure_ppm < *current)
            {
                minimum_singleton_span_pressure_ppm = Some(span_pressure_ppm);
            }

            singleton_fits = singleton_fits
                || (span.width <= sheet_width_grid && span.height <= sheet_height_grid)
                || (span.height <= sheet_width_grid && span.width <= sheet_height_grid);
        }

        let (minimum_doubled_area_grid2, minimum_singleton_span_pressure_ppm) = match (
            minimum_doubled_area_grid2,
            minimum_singleton_span_pressure_ppm,
        ) {
            (Some(area), Some(pressure)) => (area, pressure),
            _ => {
                return Err(IntrinsicCapacityPreflightError::Capacity(
                    IntrinsicCapacityError {
                        operation: "preflightTransformAccounting".to_string(),
                        message: format!(
                            "piece {} produced no valid transform measurement.",
                            piece_id.as_str()
                        ),
                    },
                ))
            }
        };

        minimum_doubled_collision_area_sum_grid2 += &minimum_doubled_area_grid2;
        if minimum_singleton_span_pressure_ppm > maximum_singleton_span_pressure_ppm {
            maximum_singleton_span_pressure_ppm = minimum_singleton_span_pressure_ppm;
        }
        if !singleton_fits {
            singleton_infeasible_piece_ids.push(piece_id);
        }
    }

    let minimum_collision_area_pressure_ppm = scaled_ratio_ceil_ppm(
        &minimum_doubled_collision_area_sum_grid2,
        &sheet_doubled_area_grid2,
    );
    let measurements = IntrinsicCapacityPreflightMeasurements {
        piece_count: pieces.len() as f64,
        sheet_width_grid,
        sheet_height_grid,
        sheet_doubled_area_grid2: sheet_doubled_area_grid2.clone(),
        minimum_doubled_collision_area_sum_grid2: minimum_doubled_collision_area_sum_grid2.clone(),
        minimum_collision_area_pressure_ppm,
        maximum_singleton_span_pressure_ppm,
        singleton_infeasible_piece_ids: singleton_infeasible_piece_ids.clone(),
    };

    if let Some(first_singleton_infeasible_piece_id) =
        singleton_infeasible_piece_ids.into_iter().next()
    {
        return Ok(IntrinsicCapacityPreflightOutcome::ProvenImpossible {
            reason: IntrinsicCapacityProvenImpossibleReason::SingletonTransformSetDoesNotFit {
                piece_id: first_singleton_infeasible_piece_id,
            },
            measurements,
        });
    }
    if minimum_doubled_collision_area_sum_grid2 > sheet_doubled_area_grid2 {
        return Ok(IntrinsicCapacityPreflightOutcome::ProvenImpossible {
            reason: IntrinsicCapacityProvenImpossibleReason::MinimumCollisionAreaExceedsSheetArea,
            measurements,
        });
    }
    Ok(IntrinsicCapacityPreflightOutcome::Inconclusive { measurements })
}

/// TS: `intrinsicCapacityPreflight.ts:195-213` `minimumRigidSpanPressurePpm`.
fn minimum_rigid_span_pressure_ppm(
    span: &TransformedGridSpan,
    sheet_width_grid: f64,
    sheet_height_grid: f64,
) -> BigInt {
    let q0 = maximum_ratio_ppm(span.width, sheet_width_grid, span.height, sheet_height_grid);
    let q90 = maximum_ratio_ppm(span.height, sheet_width_grid, span.width, sheet_height_grid);
    if q0 < q90 {
        q0
    } else {
        q90
    }
}

/// TS: `intrinsicCapacityPreflight.ts:215-224` `maximumRatioPpm`.
fn maximum_ratio_ppm(
    first_numerator: f64,
    first_denominator: f64,
    second_numerator: f64,
    second_denominator: f64,
) -> BigInt {
    let first = scaled_ratio_ceil_ppm(
        &f64_to_bigint(first_numerator),
        &f64_to_bigint(first_denominator),
    );
    let second = scaled_ratio_ceil_ppm(
        &f64_to_bigint(second_numerator),
        &f64_to_bigint(second_denominator),
    );
    if first > second {
        first
    } else {
        second
    }
}

/// TS: `intrinsicCapacityPreflight.ts:226-229` `scaledRatioCeilPpm`. Exact
/// ceiling division for non-negative bigints (`(numerator * 1_000_000n +
/// denominator - 1n) / denominator`); relies on both operands being `>= 0`,
/// which holds at every call site in this file.
fn scaled_ratio_ceil_ppm(numerator: &BigInt, denominator: &BigInt) -> BigInt {
    let scaled = numerator * BigInt::from(1_000_000);
    (scaled + denominator - BigInt::from(1)) / denominator
}

/// TS: `intrinsicCapacityPreflight.ts:236-238` the inline anonymous return
/// type of `transformedGridSpan`.
struct TransformedGridSpan {
    width: f64,
    height: f64,
}

/// TS: `intrinsicCapacityPreflight.ts:236-254` `transformedGridSpan`. Exact
/// canonical-grid span of one transformed collision polygon. A convex
/// polygon fits an axis-aligned sheet exactly when its grid span fits,
/// because grid-aligned translations preserve canonical coordinates exactly.
/// `None` for an empty `points` slice or any non-finite bound -- never
/// panics, always fails soft into an `IntrinsicCapacityError` at the call
/// site.
fn transformed_grid_span(points: &[IrregularPoint]) -> Option<TransformedGridSpan> {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        let grid_x = to_grid_mm(point.x)?;
        let grid_y = to_grid_mm(point.y)?;
        min_x = js_math::min(min_x, grid_x);
        min_y = js_math::min(min_y, grid_y);
        max_x = js_math::max(max_x, grid_x);
        max_y = js_math::max(max_y, grid_y);
    }
    if ![min_x, min_y, max_x, max_y]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    Some(TransformedGridSpan {
        width: max_x - min_x,
        height: max_y - min_y,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CollisionGeometry, DxfGeometryEntityType, DxfGeometrySummary, ImportedPiece,
        IrregularBounds, IrregularPolygon, IrregularTransformCandidate, IrregularTransformReason,
        Rect, SourceFileId,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn rectangle(width: f64, height: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(width, 0.0),
            IrregularPoint::new(width, height),
            IrregularPoint::new(0.0, height),
        ])
    }

    fn transform(index: f64, rotation_deg: f64) -> IrregularTransformCandidate {
        IrregularTransformCandidate {
            index,
            rotation_deg,
            mirrored: false,
            reason: IrregularTransformReason::Configured,
        }
    }

    fn prepared_rectangle(
        id: &str,
        width: f64,
        height: f64,
        transforms: Vec<IrregularTransformCandidate>,
    ) -> IrregularPreparedPiece {
        let shape = rectangle(width, height);
        IrregularPreparedPiece {
            piece_id: Some(PieceId::new(id)),
            interchangeability_key: None,
            source: ImportedPiece {
                id: PieceId::new(id),
                source_file_id: SourceFileId::new(format!("source-{id}")),
                source_layer: None,
                label: id.to_string(),
                real_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                geometry: DxfGeometrySummary {
                    entity_type: DxfGeometryEntityType::PresetShape,
                    closed: true,
                    segments: vec![],
                },
                warnings: vec![],
            },
            allow_mirror: false,
            collision_geometry: CollisionGeometry {
                source_piece_id: PieceId::new(id),
                source_bounds: IrregularBounds::new(0.0, 0.0, width, height),
                sampled_points: shape.points.clone(),
                convex_hull: shape.clone(),
                collision_polygon: shape,
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms,
            priority_order_key: None,
        }
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: format!("{width}x{height}"),
        }
    }

    fn geometry_settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    #[test]
    fn proves_impossibility_from_the_exact_collision_area_sum() {
        let pieces = vec![
            prepared_rectangle("square-a", 60.0, 60.0, vec![transform(0.0, 0.0)]),
            prepared_rectangle("square-b", 60.0, 60.0, vec![transform(0.0, 0.0)]),
            prepared_rectangle("square-c", 60.0, 60.0, vec![transform(0.0, 0.0)]),
        ];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let outcome = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .expect("preflight succeeds");
        match outcome {
            IntrinsicCapacityPreflightOutcome::ProvenImpossible {
                reason,
                measurements,
            } => {
                assert_eq!(
                    reason,
                    IntrinsicCapacityProvenImpossibleReason::MinimumCollisionAreaExceedsSheetArea
                );
                assert_eq!(
                    measurements.minimum_doubled_collision_area_sum_grid2,
                    BigInt::from(3) * BigInt::from(2) * BigInt::from(60_000) * BigInt::from(60_000)
                );
                assert_eq!(
                    measurements.sheet_doubled_area_grid2,
                    BigInt::from(2) * BigInt::from(100_000) * BigInt::from(100_000)
                );
                assert_eq!(
                    measurements.minimum_collision_area_pressure_ppm,
                    BigInt::from(1_080_000)
                );
                assert_eq!(
                    measurements.maximum_singleton_span_pressure_ppm,
                    BigInt::from(600_000)
                );
            }
            other => panic!("expected proven_impossible, got {other:?}"),
        }
    }

    #[test]
    fn proves_impossibility_from_an_exact_singleton_q0_q90_fit_failure() {
        let pieces = vec![
            prepared_rectangle("fits", 90.0, 20.0, vec![transform(0.0, 0.0)]),
            prepared_rectangle(
                "never-fits",
                150.0,
                20.0,
                vec![transform(0.0, 0.0), transform(1.0, 90.0)],
            ),
        ];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let outcome = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .expect("preflight succeeds");
        match outcome {
            IntrinsicCapacityPreflightOutcome::ProvenImpossible { reason, .. } => {
                assert_eq!(
                    reason,
                    IntrinsicCapacityProvenImpossibleReason::SingletonTransformSetDoesNotFit {
                        piece_id: PieceId::new("never-fits")
                    }
                );
            }
            other => panic!("expected proven_impossible, got {other:?}"),
        }
    }

    #[test]
    fn stays_inconclusive_for_physically_impossible_but_unproven_requests() {
        let pieces = vec![
            prepared_rectangle("square-a", 60.0, 60.0, vec![transform(0.0, 0.0)]),
            prepared_rectangle("square-b", 60.0, 60.0, vec![transform(0.0, 0.0)]),
        ];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        // NOTE: these two 60x60 squares (7200mm2 combined) physically cannot
        // both fit a 100x100 sheet's usable area once real placement
        // geometry is considered, but the exact-area proof alone does not
        // establish that -- this pins the "inconclusive is not proof" rule.
        let outcome = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .expect("preflight succeeds");
        match outcome {
            IntrinsicCapacityPreflightOutcome::Inconclusive { measurements } => {
                assert!(measurements.singleton_infeasible_piece_ids.is_empty());
            }
            other => panic!("expected inconclusive, got {other:?}"),
        }
    }

    #[test]
    fn fails_fast_on_a_piece_with_an_empty_transform_set() {
        let pieces = vec![prepared_rectangle("no-transforms", 10.0, 10.0, vec![])];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let error = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .unwrap_err();
        match error {
            IntrinsicCapacityPreflightError::Capacity(IntrinsicCapacityError {
                operation, ..
            }) => {
                assert_eq!(operation, "preflightTransforms");
            }
            other => panic!("expected a capacity error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_sheet_with_no_positive_canonical_grid_area() {
        let pieces = vec![prepared_rectangle(
            "piece",
            10.0,
            10.0,
            vec![transform(0.0, 0.0)],
        )];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let error = preflight_intrinsic_complete_capacity(
            &sheet(0.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .unwrap_err();
        match error {
            IntrinsicCapacityPreflightError::Capacity(IntrinsicCapacityError {
                operation, ..
            }) => {
                assert_eq!(operation, "preflightSheet");
            }
            other => panic!("expected a capacity error, got {other:?}"),
        }
    }

    #[test]
    fn honors_cancellation_from_the_caller_supplied_control() {
        let pieces = vec![prepared_rectangle(
            "square-a",
            60.0,
            60.0,
            vec![transform(0.0, 0.0)],
        )];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let mut control = |_phase: NfpIfpCheckpointPhase| {
            Err(NfpIfpControlAbortError {
                reason: crate::nfp_ifp::NfpIfpAbortReason::Cancelled,
                message: "test preflight cancellation".to_string(),
            })
        };
        let error = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            Some(&mut control),
        )
        .unwrap_err();
        match error {
            IntrinsicCapacityPreflightError::Abort(NfpIfpControlAbortError { reason, .. }) => {
                assert_eq!(reason, crate::nfp_ifp::NfpIfpAbortReason::Cancelled);
            }
            other => panic!("expected an abort error, got {other:?}"),
        }
    }

    #[test]
    fn honors_deadline_censoring_from_the_caller_supplied_control_after_the_first_checkpoint() {
        let pieces = vec![prepared_rectangle(
            "square-a",
            60.0,
            60.0,
            vec![transform(0.0, 0.0)],
        )];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let mut checkpoints = 0u32;
        let mut control = move |_phase: NfpIfpCheckpointPhase| {
            checkpoints += 1;
            if checkpoints > 1 {
                Err(NfpIfpControlAbortError {
                    reason: crate::nfp_ifp::NfpIfpAbortReason::Deadline,
                    message: "test preflight deadline".to_string(),
                })
            } else {
                Ok(())
            }
        };
        let error = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            Some(&mut control),
        )
        .unwrap_err();
        match error {
            IntrinsicCapacityPreflightError::Abort(NfpIfpControlAbortError { reason, .. }) => {
                assert_eq!(reason, crate::nfp_ifp::NfpIfpAbortReason::Deadline);
            }
            other => panic!("expected an abort error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_transform_producing_a_degenerate_collision_polygon() {
        let mut piece = prepared_rectangle("degenerate", 10.0, 10.0, vec![transform(0.0, 0.0)]);
        piece.collision_geometry.collision_polygon = square(0.0);
        let pieces = vec![piece];
        let settings = geometry_settings();
        let mut cache = GeometryCacheStore::new();
        let error = preflight_intrinsic_complete_capacity(
            &sheet(100.0, 100.0),
            &pieces,
            &settings,
            &mut cache,
            None,
        )
        .unwrap_err();
        match error {
            IntrinsicCapacityPreflightError::Geometry(_) => {}
            other => panic!("expected a geometry error, got {other:?}"),
        }
    }
}
