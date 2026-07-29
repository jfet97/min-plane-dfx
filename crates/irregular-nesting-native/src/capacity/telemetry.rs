//! Observer-only shadow telemetry: pressure ppm passthrough plus a bounded
//! "no-skip probe" cold-search sample. No field this module produces is ever
//! consumed by routing or ranking (`routingInfluence: 'none'`, always).
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityTelemetry.ts`
//! (158 lines), ported here in full **against a seam trait for the cold
//! search engine** -- see "Seam: cold-search probe" below.
//!
//! # Seam: cold-search probe
//!
//! TS's `measureIntrinsicCapacityShadowTelemetry` calls
//! `runIntrinsicCapacityColdSearch` (`intrinsicCapacitySearch.ts`, 2272
//! lines) directly. That beam-search engine is `capacity::search`'s
//! assignment -- a concurrently-running, still-unimplemented task, out of
//! this task's file-ownership scope (this task's brief names only
//! `preflight.rs`/`material.rs`/`endpoint.rs`/`mode.rs`/`telemetry.rs`).
//! [`IntrinsicCapacityColdSearchProbe`] is a **provisional seam trait**
//! (matching the established pattern, e.g. `search::layout_scorer`'s
//! `LayoutScorerBeamStateView` doc) carrying exactly the subset of
//! `IntrinsicCapacitySearchResult`/`IntrinsicAnytimeCheckpoint` this
//! function reads (`intrinsicCapacityTelemetry.ts:96-121`): whether the
//! probe settled at status `'paused'` with a `checkpoint` present, and if
//! so, that checkpoint's `nextDepth`/`noSkipFrontier.{present,firstLossDepth}`/
//! `budgetLedgers.totalConsumedPlacementEvaluations`/`version` fields. Once
//! `capacity::search::run_intrinsic_capacity_cold_search` exists, callers
//! should implement this trait (or supply a closure, via the blanket `impl`
//! below) against the real engine instead of a hand-rolled probe -- every
//! field name here already matches the real type's corresponding field 1:1
//! to make that swap mechanical.
//!
//! # `INTRINSIC_ANYTIME_CHECKPOINT_VERSION` duplication note
//!
//! TS: `intrinsicCapacitySearch.ts:61`
//! (`INTRINSIC_ANYTIME_CHECKPOINT_VERSION = 'intrinsic-anytime-checkpoint-v3'`),
//! re-exported and consumed here (`intrinsicCapacityTelemetry.ts:10-12,70`).
//! Since `capacity::search` does not exist yet in this port,
//! [`INTRINSIC_ANYTIME_CHECKPOINT_VERSION`] is defined locally as a
//! byte-exact copy of the TS literal. **Whoever ports `capacity::search`
//! must reconcile this into a single definition** (matching the precedent
//! `caches::transform_collision_geometry`'s own module doc sets for the
//! same kind of cross-module ownership overlap) rather than let two
//! independent copies of this string constant drift.

use num_bigint::BigInt;

use crate::domain::{IrregularPreparedPiece, PieceId, SheetSpec};
use crate::js_number::js_math;

use super::material::{intrinsic_capacity_material_areas, IntrinsicCapacityMaterialAreas};
use super::preflight::IntrinsicCapacityPreflightOutcome;

/// TS: `intrinsicCapacityTelemetry.ts:14`
/// `INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH = 4`.
pub const INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH: f64 = 4.0;

/// See this module's top doc, "`INTRINSIC_ANYTIME_CHECKPOINT_VERSION`
/// duplication note".
pub const INTRINSIC_ANYTIME_CHECKPOINT_VERSION: &str = "intrinsic-anytime-checkpoint-v3";

/// TS: `intrinsicCapacityTelemetry.ts:16-19` `IntrinsicCapacityPressureTelemetry`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityPressureTelemetry {
    pub minimum_collision_area_pressure_ppm: BigInt,
    pub maximum_singleton_span_pressure_ppm: BigInt,
}

/// TS: `intrinsicCapacityTelemetry.ts:28`
/// `status: 'observed' | 'trivial' | 'unavailable'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityNoSkipProbeStatus {
    Observed,
    Trivial,
    Unavailable,
}

/// TS: `intrinsicCapacityTelemetry.ts:21-31` `IntrinsicCapacityNoSkipProbeTelemetry`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityNoSkipProbeTelemetry {
    pub maximum_depth: f64,
    pub completed_depths: f64,
    pub no_skip_frontier_present: Option<bool>,
    pub first_loss_depth: Option<f64>,
    pub consumed_placement_evaluations: f64,
    pub elapsed_ms: f64,
    pub status: IntrinsicCapacityNoSkipProbeStatus,
    pub unavailable_reason: Option<String>,
    pub checkpoint_version: String,
}

/// TS: `intrinsicCapacityTelemetry.ts:37` `readonly routingInfluence: 'none'`
/// -- a genuine one-value literal type. Kept as a named single-variant enum
/// (rather than a bare `()`/comment) so the shape stays self-describing at
/// every construction site and in differential-vector JSON encodings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityRoutingInfluence {
    None,
}

/// TS: `intrinsicCapacityTelemetry.ts:34-38` `IntrinsicCapacityShadowTelemetry`.
/// Observer-only telemetry. No field is consumed by routing or ranking.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityShadowTelemetry {
    pub pressure: IntrinsicCapacityPressureTelemetry,
    pub no_skip_probe: IntrinsicCapacityNoSkipProbeTelemetry,
    pub routing_influence: IntrinsicCapacityRoutingInfluence,
}

/// The subset of one settled/paused
/// `IntrinsicAnytimeCheckpoint`/`IntrinsicCapacitySearchResult` this file
/// reads (`intrinsicCapacityTelemetry.ts:106-119`). See this module's top
/// doc, "Seam: cold-search probe".
#[derive(Clone, Debug, PartialEq)]
pub struct ColdSearchProbeCheckpoint {
    pub next_depth: f64,
    pub no_skip_frontier_present: bool,
    pub first_loss_depth: Option<f64>,
    pub total_consumed_placement_evaluations: f64,
    pub version: String,
}

/// The probe's outcome once it returns without raising an error: `None`
/// covers every TS branch collapsed by `probe.status !== 'paused' ||
/// checkpoint === undefined` (`intrinsicCapacityTelemetry.ts:98`) -- any
/// status other than a paused-with-checkpoint state is "unavailable" here,
/// identically to TS.
#[derive(Clone, Debug, PartialEq)]
pub struct ColdSearchProbeOutcome {
    pub paused_with_checkpoint: Option<ColdSearchProbeCheckpoint>,
}

/// TS: `intrinsicCapacityTelemetry.ts:89-94`'s inline
/// `runIntrinsicCapacityColdSearch` call-site input shape.
pub struct ColdSearchProbeInput<'a> {
    pub sheet: &'a SheetSpec,
    pub prepared_pieces: &'a [IrregularPreparedPiece],
    pub material_areas_by_piece_id: &'a std::collections::HashMap<PieceId, BigInt>,
    pub maximum_depth_boundaries: f64,
}

/// See this module's top doc, "Seam: cold-search probe".
pub trait IntrinsicCapacityColdSearchProbe {
    fn run(&mut self, input: ColdSearchProbeInput<'_>) -> Result<ColdSearchProbeOutcome, String>;
}

/// Ergonomic blanket impl so a plain closure can serve as a probe without a
/// caller needing to declare a named type -- matches
/// `nfp_ifp::service::NfpIfpControl`'s established blanket-`FnMut` pattern.
impl<F> IntrinsicCapacityColdSearchProbe for F
where
    F: FnMut(ColdSearchProbeInput<'_>) -> Result<ColdSearchProbeOutcome, String>,
{
    fn run(&mut self, input: ColdSearchProbeInput<'_>) -> Result<ColdSearchProbeOutcome, String> {
        self(input)
    }
}

/// TS: `intrinsicCapacityTelemetry.ts:40-135` `measureIntrinsicCapacityShadowTelemetry`.
///
/// `timing_now` mirrors TS's `performance.now()` calls -- diagnostic-only
/// (never routing/ranking-observable), so this crate's convention of an
/// explicit injectable clock (matching `search::beam_state`'s
/// `TimingNowFn` seam) is used instead of a hidden global default.
pub fn measure_intrinsic_capacity_shadow_telemetry(
    sheet: &SheetSpec,
    prepared_pieces: &[IrregularPreparedPiece],
    preflight: &IntrinsicCapacityPreflightOutcome,
    probe: &mut dyn IntrinsicCapacityColdSearchProbe,
    timing_now: &dyn Fn() -> f64,
) -> IntrinsicCapacityShadowTelemetry {
    let measurements = preflight.measurements();
    let pressure = IntrinsicCapacityPressureTelemetry {
        minimum_collision_area_pressure_ppm: measurements
            .minimum_collision_area_pressure_ppm
            .clone(),
        maximum_singleton_span_pressure_ppm: measurements
            .maximum_singleton_span_pressure_ppm
            .clone(),
    };

    if prepared_pieces.len() <= 1 {
        let no_skip_frontier_present = measurements.singleton_infeasible_piece_ids.is_empty();
        return IntrinsicCapacityShadowTelemetry {
            pressure,
            no_skip_probe: IntrinsicCapacityNoSkipProbeTelemetry {
                maximum_depth: prepared_pieces.len() as f64,
                completed_depths: prepared_pieces.len() as f64,
                no_skip_frontier_present: Some(no_skip_frontier_present),
                first_loss_depth: if no_skip_frontier_present {
                    None
                } else {
                    Some(1.0)
                },
                consumed_placement_evaluations: 0.0,
                elapsed_ms: 0.0,
                status: IntrinsicCapacityNoSkipProbeStatus::Trivial,
                unavailable_reason: None,
                checkpoint_version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION.to_string(),
            },
            routing_influence: IntrinsicCapacityRoutingInfluence::None,
        };
    }

    let areas_by_piece_id = match intrinsic_capacity_material_areas(prepared_pieces) {
        IntrinsicCapacityMaterialAreas::Invalid { piece_id } => {
            let maximum_depth = js_math::min(
                INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH,
                prepared_pieces.len() as f64 - 1.0,
            );
            return unavailable_telemetry(
                pressure,
                maximum_depth,
                format!(
                    "piece {} has no exact material accounting",
                    piece_id.as_str()
                ),
                0.0,
            );
        }
        IntrinsicCapacityMaterialAreas::Complete { areas_by_piece_id } => areas_by_piece_id,
    };

    let maximum_depth = js_math::min(
        INTRINSIC_CAPACITY_NO_SKIP_PROBE_DEPTH,
        prepared_pieces.len() as f64 - 1.0,
    );
    let started_at = timing_now();
    let probe_input = ColdSearchProbeInput {
        sheet,
        prepared_pieces,
        material_areas_by_piece_id: &areas_by_piece_id,
        maximum_depth_boundaries: maximum_depth,
    };

    match probe.run(probe_input) {
        Err(message) => {
            let elapsed_ms = js_math::max(0.0, timing_now() - started_at);
            unavailable_telemetry(pressure, maximum_depth, message, elapsed_ms)
        }
        Ok(ColdSearchProbeOutcome {
            paused_with_checkpoint: None,
        }) => {
            let elapsed_ms = js_math::max(0.0, timing_now() - started_at);
            unavailable_telemetry(
                pressure,
                maximum_depth,
                "bounded no-skip probe did not pause at its requested depth boundary".to_string(),
                elapsed_ms,
            )
        }
        Ok(ColdSearchProbeOutcome {
            paused_with_checkpoint: Some(checkpoint),
        }) => {
            let elapsed_ms = js_math::max(0.0, timing_now() - started_at);
            IntrinsicCapacityShadowTelemetry {
                pressure,
                no_skip_probe: IntrinsicCapacityNoSkipProbeTelemetry {
                    maximum_depth,
                    completed_depths: checkpoint.next_depth,
                    no_skip_frontier_present: Some(checkpoint.no_skip_frontier_present),
                    first_loss_depth: checkpoint.first_loss_depth,
                    consumed_placement_evaluations: checkpoint.total_consumed_placement_evaluations,
                    elapsed_ms,
                    status: IntrinsicCapacityNoSkipProbeStatus::Observed,
                    unavailable_reason: None,
                    checkpoint_version: checkpoint.version,
                },
                routing_influence: IntrinsicCapacityRoutingInfluence::None,
            }
        }
    }
}

/// TS: `intrinsicCapacityTelemetry.ts:137-158` `unavailableTelemetry`.
fn unavailable_telemetry(
    pressure: IntrinsicCapacityPressureTelemetry,
    maximum_depth: f64,
    unavailable_reason: String,
    elapsed_ms: f64,
) -> IntrinsicCapacityShadowTelemetry {
    IntrinsicCapacityShadowTelemetry {
        pressure,
        no_skip_probe: IntrinsicCapacityNoSkipProbeTelemetry {
            maximum_depth,
            completed_depths: 0.0,
            no_skip_frontier_present: None,
            first_loss_depth: None,
            consumed_placement_evaluations: 0.0,
            elapsed_ms,
            status: IntrinsicCapacityNoSkipProbeStatus::Unavailable,
            unavailable_reason: Some(unavailable_reason),
            checkpoint_version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION.to_string(),
        },
        routing_influence: IntrinsicCapacityRoutingInfluence::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capacity::preflight::{
        IntrinsicCapacityPreflightMeasurements, IntrinsicCapacityProvenImpossibleReason,
    };
    use crate::domain::{
        CollisionGeometry, DxfGeometryEntityType, DxfGeometrySummary, ImportedPiece,
        IrregularBounds, IrregularPoint, IrregularPolygon, IrregularTransformCandidate,
        IrregularTransformReason, Rect, SourceFileId,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn prepared(id: &str) -> IrregularPreparedPiece {
        let shape = square(10.0);
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
                source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
                sampled_points: shape.points.clone(),
                convex_hull: shape.clone(),
                collision_polygon: shape,
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms: vec![IrregularTransformCandidate {
                index: 0.0,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            }],
            priority_order_key: None,
        }
    }

    fn sheet() -> SheetSpec {
        SheetSpec {
            width: 1000.0,
            height: 800.0,
            label: "test".to_string(),
        }
    }

    fn inconclusive_preflight(piece_count: usize) -> IntrinsicCapacityPreflightOutcome {
        IntrinsicCapacityPreflightOutcome::Inconclusive {
            measurements: IntrinsicCapacityPreflightMeasurements {
                piece_count: piece_count as f64,
                sheet_width_grid: 1_000_000.0,
                sheet_height_grid: 800_000.0,
                sheet_doubled_area_grid2: BigInt::from(0),
                minimum_doubled_collision_area_sum_grid2: BigInt::from(0),
                minimum_collision_area_pressure_ppm: BigInt::from(123_456),
                maximum_singleton_span_pressure_ppm: BigInt::from(654_321),
                singleton_infeasible_piece_ids: vec![],
            },
        }
    }

    #[test]
    fn trivial_status_for_zero_or_one_pieces() {
        let sheet = sheet();
        let pieces: Vec<IrregularPreparedPiece> = vec![];
        let preflight = inconclusive_preflight(0);
        let mut probe =
            |_input: ColdSearchProbeInput<'_>| -> Result<ColdSearchProbeOutcome, String> {
                panic!("probe must not run for <= 1 pieces")
            };
        let telemetry = measure_intrinsic_capacity_shadow_telemetry(
            &sheet,
            &pieces,
            &preflight,
            &mut probe,
            &|| 0.0,
        );
        assert_eq!(
            telemetry.no_skip_probe.status,
            IntrinsicCapacityNoSkipProbeStatus::Trivial
        );
        assert_eq!(telemetry.no_skip_probe.no_skip_frontier_present, Some(true));
        assert_eq!(
            telemetry.pressure.minimum_collision_area_pressure_ppm,
            BigInt::from(123_456)
        );
        assert_eq!(
            telemetry.routing_influence,
            IntrinsicCapacityRoutingInfluence::None
        );
    }

    #[test]
    fn observed_status_when_the_probe_pauses_with_a_checkpoint() {
        let sheet = sheet();
        let pieces = vec![prepared("a"), prepared("b"), prepared("c")];
        let preflight = inconclusive_preflight(pieces.len());
        let mut probe =
            |input: ColdSearchProbeInput<'_>| -> Result<ColdSearchProbeOutcome, String> {
                assert_eq!(input.maximum_depth_boundaries, 2.0);
                Ok(ColdSearchProbeOutcome {
                    paused_with_checkpoint: Some(ColdSearchProbeCheckpoint {
                        next_depth: 2.0,
                        no_skip_frontier_present: true,
                        first_loss_depth: None,
                        total_consumed_placement_evaluations: 42.0,
                        version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION.to_string(),
                    }),
                })
            };
        let telemetry = measure_intrinsic_capacity_shadow_telemetry(
            &sheet,
            &pieces,
            &preflight,
            &mut probe,
            &|| 0.0,
        );
        assert_eq!(
            telemetry.no_skip_probe.status,
            IntrinsicCapacityNoSkipProbeStatus::Observed
        );
        assert_eq!(telemetry.no_skip_probe.completed_depths, 2.0);
        assert_eq!(telemetry.no_skip_probe.consumed_placement_evaluations, 42.0);
    }

    #[test]
    fn unavailable_status_when_the_probe_does_not_pause() {
        let sheet = sheet();
        let pieces = vec![prepared("a"), prepared("b")];
        let preflight = inconclusive_preflight(pieces.len());
        let mut probe =
            |_input: ColdSearchProbeInput<'_>| -> Result<ColdSearchProbeOutcome, String> {
                Ok(ColdSearchProbeOutcome {
                    paused_with_checkpoint: None,
                })
            };
        let telemetry = measure_intrinsic_capacity_shadow_telemetry(
            &sheet,
            &pieces,
            &preflight,
            &mut probe,
            &|| 0.0,
        );
        assert_eq!(
            telemetry.no_skip_probe.status,
            IntrinsicCapacityNoSkipProbeStatus::Unavailable
        );
        assert!(telemetry.no_skip_probe.unavailable_reason.is_some());
    }

    #[test]
    fn unavailable_status_when_the_probe_errors() {
        let sheet = sheet();
        let pieces = vec![prepared("a"), prepared("b")];
        let preflight = inconclusive_preflight(pieces.len());
        let mut probe =
            |_input: ColdSearchProbeInput<'_>| -> Result<ColdSearchProbeOutcome, String> {
                Err("boom".to_string())
            };
        let telemetry = measure_intrinsic_capacity_shadow_telemetry(
            &sheet,
            &pieces,
            &preflight,
            &mut probe,
            &|| 0.0,
        );
        assert_eq!(
            telemetry.no_skip_probe.status,
            IntrinsicCapacityNoSkipProbeStatus::Unavailable
        );
        assert_eq!(
            telemetry.no_skip_probe.unavailable_reason,
            Some("boom".to_string())
        );
    }

    #[test]
    fn unavailable_status_when_material_areas_are_invalid() {
        let sheet = sheet();
        let mut bad = prepared("bad");
        bad.collision_geometry.convex_hull = IrregularPolygon::new(vec![]);
        let pieces = vec![prepared("good"), bad];
        let preflight = inconclusive_preflight(pieces.len());
        let mut probe =
            |_input: ColdSearchProbeInput<'_>| -> Result<ColdSearchProbeOutcome, String> {
                panic!("probe must not run when material areas are invalid")
            };
        let telemetry = measure_intrinsic_capacity_shadow_telemetry(
            &sheet,
            &pieces,
            &preflight,
            &mut probe,
            &|| 0.0,
        );
        assert_eq!(
            telemetry.no_skip_probe.status,
            IntrinsicCapacityNoSkipProbeStatus::Unavailable
        );
        assert!(telemetry
            .no_skip_probe
            .unavailable_reason
            .unwrap()
            .contains("bad"));
    }

    #[test]
    fn reason_export_used_for_proven_impossible_pressure() {
        // Confirms this module compiles against the proven-impossible arm too
        // (not just inconclusive), pinning `IntrinsicCapacityProvenImpossibleReason`
        // stays importable from this test module.
        let _reason = IntrinsicCapacityProvenImpossibleReason::MinimumCollisionAreaExceedsSheetArea;
    }
}
