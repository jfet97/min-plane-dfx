//! Ranks already-legal irregular placement candidates without participating
//! in legality.
//!
//! TS source: `src/workers/algorithm/irregular/irregularPlacementScorer.ts`
//! (451 lines). Read together with
//! `docs/planning/rust-irregular-backend/characterization/search-scoring.md`
//! before touching this file -- in particular §1 ("headline finding"): on
//! the production Compact/Compact Short Side path this module's comparator
//! chains (`compare_scores` and everything it dispatches to) are **not**
//! reachable; only [`score_candidate`]'s pure value computation is live
//! (`intrinsicCapacitySearch.ts:654` calls `IrregularPlacementScorer.Make.scoreCandidate`
//! directly, reading only `sharedCollisionBoundaryLengthMm` from the
//! result). The comparators are still ported here byte-exact per
//! `search-scoring.md` §15 item 1's recommendation: they remain part of the
//! public service contract, are exercised by non-default settings and by
//! `tests/unit/irregularPlacementScorer.test.ts`, and this task's mandate is
//! "TS behavior IS the spec," not "only the currently-reachable subset."
//!
//! # What this module does not port
//!
//! `IrregularPlacementScorer` is an `effect` `Context.Service` in TS with
//! `.Make`/`.Layer`/`.Live` static members implementing dependency
//! injection (`irregularPlacementScorer.ts:166-197`). Per this task's
//! instructions ("port the pure computation"), this module ports
//! [`score_candidate`] and the comparator functions only -- there is no
//! Rust equivalent of the `Context.Service`/`Layer` machinery itself, since
//! this crate's services are plain functions, not Effect-context-resolved
//! objects (matching the established convention elsewhere in this crate,
//! e.g. `geometry::free_material`'s "plain functions instead of a
//! closure-capturing service object" note). [`resolve_configured_placement_policy_id`]
//! ports the one piece of `.Layer`'s body (`irregularPlacementScorer.ts:181-187`)
//! that is ordinary application logic rather than DI wiring, since a caller
//! resolving "which policy does this job's settings select" needs it and it
//! is meaningless to reinvent per call site.

use std::cmp::Ordering;

use crate::canonical_grid::contact::shared_convex_polygon_boundary_length;
use crate::domain::{
    IrregularBounds, IrregularOptimizerSettings, IrregularPlacedPiece, IrregularPlacementCandidate,
    IrregularPlacementPolicyId, IrregularPoint, IrregularTransformCandidate,
    IrregularTransformReason, SheetSpec, TransformedCollisionGeometry,
    DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
};
use crate::geometry::convex::translate_polygon_with_bounds;
use crate::js_number::{cmp_js_code_units, js_math};

use super::score_grid::{self, cmp_number};

/// TS: `irregularPlacementScorer.ts:18` `BALANCED_COMPACTNESS_POLICY_ID`.
/// The current deterministic compactness policy. Kept here as a documented
/// alias for the corresponding [`IrregularPlacementPolicyId`] variant rather
/// than a second, independent string constant -- the domain enum already
/// carries the one true policy-id vocabulary (`domain.ts:45-52`), so
/// duplicating it as `&str` constants here would create exactly the
/// "structurally-identical duplicate type" hazard this crate's task
/// instructions warn against.
pub const BALANCED_COMPACTNESS_POLICY_ID: IrregularPlacementPolicyId =
    IrregularPlacementPolicyId::BalancedCompactness;
/// TS: `irregularPlacementScorer.ts:21` `SHORT_SIDE_FILL_POLICY_ID`. Fill the
/// shorter rectangular-sheet direction before spreading longways.
pub const SHORT_SIDE_FILL_POLICY_ID: IrregularPlacementPolicyId =
    IrregularPlacementPolicyId::ShortSideFill;
/// TS: `irregularPlacementScorer.ts:24-25`
/// `EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID`. Prefer the largest
/// exact padded-edge contact before compactness tie-breakers.
pub const EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID: IrregularPlacementPolicyId =
    IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness;

/// TS: `irregularPlacementScorer.ts:28-33` `IrregularPlacementScoringError`
/// (`Data.TaggedError` with fields `operation`, `message`). The Effect `_tag`
/// discriminant has no Rust equivalent needed: this crate's error carriers
/// are not routed back through Effect (matching the established convention,
/// e.g. `validation::placement::IrregularGeometryInputError`'s doc comment).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularPlacementScoringError {
    pub operation: String,
    pub message: String,
}

/// TS: `irregularPlacementScorer.ts:42-53` `ScoreIrregularPlacementCandidateInput`.
///
/// `policy_id: None` mirrors TS's `policyId?: IrregularPlacementPolicyId`
/// omission (resolved to [`DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID`] inside
/// [`score_candidate`], `irregularPlacementScorer.ts:248`).
#[derive(Clone, Debug)]
pub struct ScoreIrregularPlacementCandidateInput<'a> {
    /// Rectangular sheet used to normalize the post-placement cluster span.
    pub sheet: &'a SheetSpec,
    /// Collision polygons already committed to this partial layout.
    pub placed: &'a [IrregularPlacedPiece],
    /// Local moving collision polygon for the candidate's selected transform.
    pub moving: &'a TransformedCollisionGeometry,
    /// Already-legal translation whose resulting cluster is being compared.
    pub candidate: &'a IrregularPlacementCandidate,
    /// Optional explicit policy gene; `None` means the configured service
    /// policy (see this struct's top doc).
    pub policy_id: Option<IrregularPlacementPolicyId>,
}

/// TS: `irregularPlacementScorer.ts:56-81` `IrregularPlacementScore`. One
/// comparable score for an already-legal irregular placement candidate --
/// every field required, no optionals (`score_candidate` either fully
/// succeeds with every field finite or fails with a typed error, per
/// `search-scoring.md` §3.3).
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularPlacementScore {
    /// Explicit policy identity so later policies cannot be accidentally
    /// mixed.
    pub policy_id: IrregularPlacementPolicyId,
    /// Longest side in millimeters of the post-placement collision bounds.
    pub used_cluster_max_side_mm: f64,
    /// Largest post-placement sheet-axis consumption, normalized by that
    /// axis.
    pub worst_normalized_sheet_consumption: f64,
    /// Sum of both post-placement normalized sheet-axis consumptions.
    pub normalized_sheet_span_sum: f64,
    /// Area in square millimeters of the post-placement collision-polygon
    /// bounds.
    pub used_cluster_area_mm2: f64,
    /// Width plus height in millimeters of the post-placement collision
    /// bounds.
    pub used_cluster_span_mm: f64,
    /// Normalized fill of the sheet's shorter direction.
    pub short_side_fill: f64,
    /// Normalized fill of the sheet's longer direction.
    pub long_side_fill: f64,
    /// Total length of shared padded collision boundaries with already
    /// placed pieces.
    pub shared_collision_boundary_length_mm: f64,
    /// Sheet-space bottom edge of the translated moving collision polygon.
    pub candidate_bottom_mm: f64,
    /// Sheet-space left edge of the translated moving collision polygon.
    pub candidate_left_mm: f64,
    /// Candidate retained for deterministic metadata and piece-id
    /// tie-breaking.
    pub candidate: IrregularPlacementCandidate,
}

/// TS: `irregularPlacementScorer.ts:198-281` `scoreCandidate`.
pub fn score_candidate(
    input: &ScoreIrregularPlacementCandidateInput<'_>,
) -> Result<IrregularPlacementScore, IrregularPlacementScoringError> {
    if let Some(message) = validate_candidate_metadata(input.moving, input.candidate) {
        return Err(fail_scoring(message));
    }

    let combined_bounds = make_combined_bounds(input).ok_or_else(|| {
        fail_scoring(
            "candidate and placed collision polygons must produce finite bounds.".to_string(),
        )
    })?;
    let shared_collision_boundary_length_mm = make_shared_collision_boundary_length(input)
        .ok_or_else(|| {
            fail_scoring(
                "candidate and placed collision polygons must produce finite shared boundaries."
                    .to_string(),
            )
        })?;

    let cluster_width = score_grid::canonicalize_irregular_score_millimeters(
        combined_bounds.max_x - combined_bounds.min_x,
    );
    let cluster_height = score_grid::canonicalize_irregular_score_millimeters(
        combined_bounds.max_y - combined_bounds.min_y,
    );
    let candidate_bottom =
        score_grid::canonicalize_irregular_score_millimeters(combined_bounds.moving.min_y);
    let candidate_left =
        score_grid::canonicalize_irregular_score_millimeters(combined_bounds.moving.min_x);
    let canonical_shared_collision_boundary_length_mm =
        score_grid::canonicalize_irregular_score_millimeters(shared_collision_boundary_length_mm);

    let (
        cluster_width,
        cluster_height,
        candidate_bottom,
        candidate_left,
        canonical_shared_collision_boundary_length_mm,
    ) = match (
        cluster_width,
        cluster_height,
        candidate_bottom,
        candidate_left,
        canonical_shared_collision_boundary_length_mm,
    ) {
        (Some(width), Some(height), Some(bottom), Some(left), Some(boundary)) => {
            (width, height, bottom, left, boundary)
        }
        _ => {
            return Err(fail_scoring(
                "candidate score values must fit the deterministic score grid.".to_string(),
            ))
        }
    };

    let normalized_width = cluster_width / input.sheet.width;
    let normalized_height = cluster_height / input.sheet.height;
    let worst_normalized_sheet_consumption = js_math::max(normalized_width, normalized_height);
    let normalized_sheet_span_sum = normalized_width + normalized_height;
    let used_cluster_max_side_mm = js_math::max(cluster_width, cluster_height);
    let used_cluster_area_mm2 = cluster_width * cluster_height;
    let used_cluster_span_mm = cluster_width + cluster_height;
    let short_side_fill = if input.sheet.height <= input.sheet.width {
        cluster_height / input.sheet.height
    } else {
        cluster_width / input.sheet.width
    };
    let long_side_fill = if input.sheet.height <= input.sheet.width {
        cluster_width / input.sheet.width
    } else {
        cluster_height / input.sheet.height
    };
    let requested_policy_id = input
        .policy_id
        .unwrap_or(DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID);
    let policy_id = if input.sheet.width == input.sheet.height {
        BALANCED_COMPACTNESS_POLICY_ID
    } else {
        requested_policy_id
    };

    if !worst_normalized_sheet_consumption.is_finite()
        || !normalized_sheet_span_sum.is_finite()
        || !used_cluster_max_side_mm.is_finite()
        || !used_cluster_area_mm2.is_finite()
        || !used_cluster_span_mm.is_finite()
        || !short_side_fill.is_finite()
        || !long_side_fill.is_finite()
        || !canonical_shared_collision_boundary_length_mm.is_finite()
        || !candidate_bottom.is_finite()
        || !candidate_left.is_finite()
    {
        return Err(fail_scoring(
            "candidate score arithmetic must remain finite.".to_string(),
        ));
    }

    Ok(IrregularPlacementScore {
        policy_id,
        used_cluster_max_side_mm,
        worst_normalized_sheet_consumption,
        normalized_sheet_span_sum,
        used_cluster_area_mm2,
        used_cluster_span_mm,
        short_side_fill,
        long_side_fill,
        shared_collision_boundary_length_mm: canonical_shared_collision_boundary_length_mm,
        candidate_bottom_mm: candidate_bottom,
        candidate_left_mm: candidate_left,
        candidate: input.candidate.clone(),
    })
}

/// TS: `irregularPlacementScorer.ts:177-187`'s `.Layer` policy-resolution
/// logic, extracted as a pure function since this port does not model
/// `effect`'s `Context.Service`/`Layer` machinery (see this module's top
/// doc). TS: `configured !== undefined && available.includes(configured) ?
/// configured : DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID`, where `available =
/// settings.optimizer.placementPolicyIds ?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS`.
/// `crate::domain::IrregularOptimizerSettings`'s `placement_policy_id`/
/// `placement_policy_ids` are both already-decoded, non-optional trusted
/// fields (per `domain::settings`'s module doc: `Schema.Class`-generated
/// `optionalKey` + `withDecodingDefaultKey` fields never end up genuinely
/// absent on a trusted instance), so `configured !== undefined` and the
/// `?? DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS` fallback are both always-true
/// branches at this trusted-carrier layer and are provably absent from this
/// simplified port, not silently dropped.
pub fn resolve_configured_placement_policy_id(
    settings: &IrregularOptimizerSettings,
) -> IrregularPlacementPolicyId {
    if settings
        .placement_policy_ids
        .contains(&settings.placement_policy_id)
    {
        settings.placement_policy_id
    } else {
        DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
    }
}

/// TS: `irregularPlacementScorer.ts:283-297` `compareScores`, the production
/// `.compare` method body -- **not reachable on the production
/// Compact/Compact Short Side path** (see this module's top doc). Returns
/// `std::cmp::Ordering` as the idiomatic Rust equivalent of TS's `-1 | 0 |
/// 1` (`Less`/`Equal`/`Greater` map to `-1`/`0`/`1`).
///
/// Preserves the TS dispatch's asymmetric guard verbatim
/// (`search-scoring.md` §6.1/§15 item 5): each branch checks
/// `first.policy_id` against a constant, **not** "either side matches," so
/// `compare_scores(a, b)` is not provably `-compare_scores(b, a)` when
/// `a.policy_id != b.policy_id`. Unreachable in production, where every
/// compared pair within one job shares one configured policy id.
pub fn compare_scores(
    first: &IrregularPlacementScore,
    second: &IrregularPlacementScore,
) -> Ordering {
    if first.policy_id == SHORT_SIDE_FILL_POLICY_ID && first.policy_id == second.policy_id {
        return short_side_fill_order(first, second);
    }
    if first.policy_id == EDGE_CONTACT_THEN_BALANCED_COMPACTNESS_POLICY_ID
        && first.policy_id == second.policy_id
    {
        return edge_contact_then_balanced_compactness_order(first, second);
    }
    compare_balanced_compactness_placement_scores(first, second)
}

/// TS: `irregularPlacementScorer.ts:300-305`
/// `compareBalancedCompactnessPlacementScores`. Compares candidates with the
/// baseline compactness policy regardless of their selected policy.
pub fn compare_balanced_compactness_placement_scores(
    first: &IrregularPlacementScore,
    second: &IrregularPlacementScore,
) -> Ordering {
    balanced_compactness_order(first, second)
}

/// TS: `irregularPlacementScorer.ts:308-313`
/// `compareIntrinsicCompactnessPlacementScores`. Compares candidate
/// envelopes without using the containing sheet dimensions.
pub fn compare_intrinsic_compactness_placement_scores(
    first: &IrregularPlacementScore,
    second: &IrregularPlacementScore,
) -> Ordering {
    intrinsic_compactness_order(first, second)
}

/// TS: `irregularPlacementScorer.ts:103-107` `intrinsicEnvelopeOrder` --
/// ascending `usedClusterMaxSideMm`, then `usedClusterAreaMm2`, then
/// `usedClusterSpanMm`.
fn intrinsic_envelope_order(a: &IrregularPlacementScore, b: &IrregularPlacementScore) -> Ordering {
    cmp_number(a.used_cluster_max_side_mm, b.used_cluster_max_side_mm)
        .then_with(|| cmp_number(a.used_cluster_area_mm2, b.used_cluster_area_mm2))
        .then_with(|| cmp_number(a.used_cluster_span_mm, b.used_cluster_span_mm))
}

/// TS: `irregularPlacementScorer.ts:109-115` `deterministicLocalTieBreakOrder`
/// -- ascending `candidate.transform.index`, `rotationDeg`, `mirrored`
/// (`false < true`), `reason` (code-unit string order), `pieceId` (code-unit
/// string order).
fn deterministic_local_tie_break_order(
    a: &IrregularPlacementScore,
    b: &IrregularPlacementScore,
) -> Ordering {
    cmp_number(a.candidate.transform.index, b.candidate.transform.index)
        .then_with(|| {
            cmp_number(
                a.candidate.transform.rotation_deg,
                b.candidate.transform.rotation_deg,
            )
        })
        .then_with(|| {
            a.candidate
                .transform
                .mirrored
                .cmp(&b.candidate.transform.mirrored)
        })
        .then_with(|| {
            cmp_js_code_units(
                transform_reason_str(a.candidate.transform.reason),
                transform_reason_str(b.candidate.transform.reason),
            )
        })
        .then_with(|| {
            cmp_js_code_units(a.candidate.piece_id.as_str(), b.candidate.piece_id.as_str())
        })
}

/// TS: `irregularPlacementScorer.ts:14-21` `IrregularTransformReason` literal
/// spellings (`domain.ts:14-21`), needed here since `Order.String` compares
/// the TS string literal, not the Rust enum discriminant.
fn transform_reason_str(reason: IrregularTransformReason) -> &'static str {
    match reason {
        IrregularTransformReason::Orthogonal => "orthogonal",
        IrregularTransformReason::EdgeAlignment => "edge_alignment",
        IrregularTransformReason::Configured => "configured",
    }
}

/// TS: `irregularPlacementScorer.ts:117-120` `balancedCompactnessOrder` =
/// `intrinsicEnvelopeOrder` then `deterministicLocalTieBreakOrder` (8-term
/// chain total). The `compareScores` fallback for any `policyId` other than
/// `short-side-fill` or `edge-contact-then-balanced-compactness`.
fn balanced_compactness_order(
    a: &IrregularPlacementScore,
    b: &IrregularPlacementScore,
) -> Ordering {
    intrinsic_envelope_order(a, b).then_with(|| deterministic_local_tie_break_order(a, b))
}

/// TS: `irregularPlacementScorer.ts:122-126`
/// `edgeContactThenBalancedCompactnessOrder`: `-sharedCollisionBoundaryLengthMm`
/// (descending on that one field, via arithmetic negation rather than
/// `Order.flip`), then `intrinsicEnvelopeOrder`, then
/// `deterministicLocalTieBreakOrder`.
fn edge_contact_then_balanced_compactness_order(
    a: &IrregularPlacementScore,
    b: &IrregularPlacementScore,
) -> Ordering {
    cmp_number(
        -a.shared_collision_boundary_length_mm,
        -b.shared_collision_boundary_length_mm,
    )
    .then_with(|| intrinsic_envelope_order(a, b))
    .then_with(|| deterministic_local_tie_break_order(a, b))
}

/// TS: `irregularPlacementScorer.ts:133-142` `intrinsicCompactnessOrder` --
/// 8 terms inlined rather than composed from the two helpers above, but
/// (per `search-scoring.md` §6.1) "functionally identical to
/// `balancedCompactnessOrder` but a textually separate declaration." Both
/// this function and [`balanced_compactness_order`] delegate to the same two
/// composed sub-orders here, since the two TS bodies compute provably
/// identical results term-for-term -- duplicating the 8-line chain a second
/// time would add risk of the two copies silently drifting apart, not add
/// fidelity.
fn intrinsic_compactness_order(
    a: &IrregularPlacementScore,
    b: &IrregularPlacementScore,
) -> Ordering {
    intrinsic_envelope_order(a, b).then_with(|| deterministic_local_tie_break_order(a, b))
}

/// TS: `irregularPlacementScorer.ts:144-158` `shortSideFillOrder` -- ascending
/// 13-term chain: `worstNormalizedSheetConsumption`, `normalizedSheetSpanSum`,
/// `-shortSideFill` (descending), `longSideFill`, `usedClusterAreaMm2`,
/// `usedClusterSpanMm`, `candidateBottomMm`, `candidateLeftMm`, then the
/// 5-term [`deterministic_local_tie_break_order`].
fn short_side_fill_order(a: &IrregularPlacementScore, b: &IrregularPlacementScore) -> Ordering {
    cmp_number(
        a.worst_normalized_sheet_consumption,
        b.worst_normalized_sheet_consumption,
    )
    .then_with(|| cmp_number(a.normalized_sheet_span_sum, b.normalized_sheet_span_sum))
    .then_with(|| cmp_number(-a.short_side_fill, -b.short_side_fill))
    .then_with(|| cmp_number(a.long_side_fill, b.long_side_fill))
    .then_with(|| cmp_number(a.used_cluster_area_mm2, b.used_cluster_area_mm2))
    .then_with(|| cmp_number(a.used_cluster_span_mm, b.used_cluster_span_mm))
    .then_with(|| cmp_number(a.candidate_bottom_mm, b.candidate_bottom_mm))
    .then_with(|| cmp_number(a.candidate_left_mm, b.candidate_left_mm))
    .then_with(|| deterministic_local_tie_break_order(a, b))
}

/// TS: `irregularPlacementScorer.ts:315-335` `makeSharedCollisionBoundaryLength`.
fn make_shared_collision_boundary_length(
    input: &ScoreIrregularPlacementCandidateInput<'_>,
) -> Option<f64> {
    let moving = translate_polygon_with_bounds(&input.moving.polygon, input.candidate.point)?;

    let mut total_length = 0.0_f64;
    for placed in input.placed {
        let translation = placed.placement.transform;
        let translated_placed = translate_polygon_with_bounds(
            &placed.collision_geometry.polygon,
            IrregularPoint::new(translation.translate_x, translation.translate_y),
        )?;

        let contact_length = shared_convex_polygon_boundary_length(&moving, &translated_placed)?;
        total_length += contact_length;
        if !total_length.is_finite() {
            return None;
        }
    }
    Some(total_length)
}

/// TS: `irregularPlacementScorer.ts:337-350` `CombinedBounds` interface.
struct CombinedBounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    moving: IrregularBounds,
}

/// TS: `irregularPlacementScorer.ts:352-385` `makeCombinedBounds`.
///
/// TS declares its own local `translatedBounds` helper (`387-415`) rather
/// than reusing `translatePolygonWithBounds` (which
/// `makeSharedCollisionBoundaryLength` above calls directly) -- but the two
/// TS bodies are the same algorithm (first point separately, then
/// `Math.min`/`Math.max`-folding the rest), so this port reuses
/// [`translate_polygon_with_bounds`] here too rather than duplicating a
/// second, independently-maintained copy of that GREEN geometry primitive
/// (per this crate's task instructions: "REUSE, never duplicate"). Both
/// paths are provably the same computation for the same input.
fn make_combined_bounds(
    input: &ScoreIrregularPlacementCandidateInput<'_>,
) -> Option<CombinedBounds> {
    let moving = translate_polygon_with_bounds(&input.moving.polygon, input.candidate.point)?;

    let mut min_x = moving.bounds.min_x;
    let mut min_y = moving.bounds.min_y;
    let mut max_x = moving.bounds.max_x;
    let mut max_y = moving.bounds.max_y;

    for placed in input.placed {
        let translation = placed.placement.transform;
        let placed_bounds = translate_polygon_with_bounds(
            &placed.collision_geometry.polygon,
            IrregularPoint::new(translation.translate_x, translation.translate_y),
        )?;
        min_x = js_math::min(min_x, placed_bounds.bounds.min_x);
        min_y = js_math::min(min_y, placed_bounds.bounds.min_y);
        max_x = js_math::max(max_x, placed_bounds.bounds.max_x);
        max_y = js_math::max(max_y, placed_bounds.bounds.max_y);
    }

    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return None;
    }
    Some(CombinedBounds {
        min_x,
        min_y,
        max_x,
        max_y,
        moving: moving.bounds,
    })
}

/// TS: `irregularPlacementScorer.ts:417-430` `validateCandidateMetadata`.
fn validate_candidate_metadata(
    moving: &TransformedCollisionGeometry,
    candidate: &IrregularPlacementCandidate,
) -> Option<String> {
    if moving.source_piece_id != candidate.piece_id {
        return Some(
            "moving geometry source piece id must match the candidate piece id.".to_string(),
        );
    }

    if !same_transform(&moving.transform, &candidate.transform) {
        return Some(
            "moving geometry transform metadata must match the candidate transform metadata."
                .to_string(),
        );
    }

    None
}

/// TS: `irregularPlacementScorer.ts:432-442` `sameTransform`.
fn same_transform(
    first: &IrregularTransformCandidate,
    second: &IrregularTransformCandidate,
) -> bool {
    first.index == second.index
        && first.rotation_deg == second.rotation_deg
        && first.mirrored == second.mirrored
        && first.reason == second.reason
}

/// TS: `irregularPlacementScorer.ts:444-451` `failScoring`. Every error from
/// this file uses the same hardcoded `operation: 'scoreCandidate'` string
/// regardless of which specific check failed -- only `message` differentiates
/// (`search-scoring.md` §11, verbatim TS behavior, not a simplification).
fn fail_scoring(message: String) -> IrregularPlacementScoringError {
    IrregularPlacementScoringError {
        operation: "scoreCandidate".to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CollisionGeometryDiagnostic, IrregularPolygon, IrregularTransform, PieceId,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn moving_geometry(piece_id: &str, index: f64) -> TransformedCollisionGeometry {
        TransformedCollisionGeometry {
            source_piece_id: PieceId::new(piece_id),
            transform: IrregularTransformCandidate {
                index,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            },
            polygon: square(10.0),
            bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
        }
    }

    fn candidate(piece_id: &str, index: f64, x: f64, y: f64) -> IrregularPlacementCandidate {
        IrregularPlacementCandidate {
            piece_id: PieceId::new(piece_id),
            transform: IrregularTransformCandidate {
                index,
                rotation_deg: 0.0,
                mirrored: false,
                reason: IrregularTransformReason::Orthogonal,
            },
            point: IrregularPoint::new(x, y),
            diagnostics: Vec::<CollisionGeometryDiagnostic>::new(),
        }
    }

    fn placed_piece(x: f64, y: f64) -> IrregularPlacedPiece {
        IrregularPlacedPiece {
            placement: crate::domain::IrregularPlacement {
                piece_id: Some(PieceId::new("placed")),
                source_piece_id: PieceId::new("placed"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x: x,
                    translate_y: y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("placed"),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon: square(10.0),
                bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
            },
        }
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "test sheet".to_string(),
        }
    }

    #[test]
    fn score_candidate_computes_finite_score_for_a_simple_placement() {
        let sheet = sheet(1000.0, 800.0);
        let moving = moving_geometry("piece-1", 0.0);
        let candidate = candidate("piece-1", 0.0, 5.0, 5.0);
        let input = ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &[],
            moving: &moving,
            candidate: &candidate,
            policy_id: None,
        };
        let score = score_candidate(&input).expect("finite score");
        assert_eq!(score.used_cluster_max_side_mm, 10.0);
        assert_eq!(score.candidate_bottom_mm, 5.0);
        assert_eq!(score.candidate_left_mm, 5.0);
        assert_eq!(score.shared_collision_boundary_length_mm, 0.0);
    }

    #[test]
    fn score_candidate_rejects_mismatched_metadata() {
        let sheet = sheet(1000.0, 800.0);
        let moving = moving_geometry("piece-1", 0.0);
        let candidate = candidate("piece-2", 0.0, 5.0, 5.0);
        let input = ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &[],
            moving: &moving,
            candidate: &candidate,
            policy_id: None,
        };
        let error = score_candidate(&input).unwrap_err();
        assert_eq!(error.operation, "scoreCandidate");
        assert!(error.message.contains("source piece id"));
    }

    #[test]
    fn score_candidate_forces_balanced_compactness_on_a_square_sheet() {
        let sheet = sheet(1000.0, 1000.0);
        let moving = moving_geometry("piece-1", 0.0);
        let candidate = candidate("piece-1", 0.0, 5.0, 5.0);
        let input = ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &[],
            moving: &moving,
            candidate: &candidate,
            policy_id: Some(IrregularPlacementPolicyId::ShortSideFill),
        };
        let score = score_candidate(&input).expect("finite score");
        assert_eq!(score.policy_id, BALANCED_COMPACTNESS_POLICY_ID);
    }

    #[test]
    fn score_candidate_measures_shared_boundary_against_placed_pieces() {
        let sheet = sheet(1000.0, 800.0);
        let moving = moving_geometry("piece-1", 0.0);
        // Placed at (10, 0): the moving square's right edge touches the
        // placed square's left edge exactly along a 10mm shared boundary.
        let candidate = candidate("piece-1", 0.0, 0.0, 0.0);
        let placed = vec![placed_piece(10.0, 0.0)];
        let input = ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &placed,
            moving: &moving,
            candidate: &candidate,
            policy_id: None,
        };
        let score = score_candidate(&input).expect("finite score");
        assert_eq!(score.shared_collision_boundary_length_mm, 10.0);
    }

    #[test]
    fn compare_scores_dispatches_short_side_fill_when_both_sides_agree() {
        let sheet = sheet(1000.0, 800.0);
        let first_moving = moving_geometry("piece-1", 0.0);
        let second_moving = moving_geometry("piece-1", 1.0);
        let first_candidate = candidate("piece-1", 0.0, 0.0, 0.0);
        let second_candidate = candidate("piece-1", 1.0, 0.0, 0.0);
        let first = score_candidate(&ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &[],
            moving: &first_moving,
            candidate: &first_candidate,
            policy_id: Some(IrregularPlacementPolicyId::ShortSideFill),
        })
        .expect("finite score");
        let second = score_candidate(&ScoreIrregularPlacementCandidateInput {
            sheet: &sheet,
            placed: &[],
            moving: &second_moving,
            candidate: &second_candidate,
            policy_id: Some(IrregularPlacementPolicyId::ShortSideFill),
        })
        .expect("finite score");
        // Identical geometry, differing only by transform.index -- the
        // short-side-fill order's final deterministic tie-break decides.
        assert_eq!(compare_scores(&first, &second), Ordering::Less);
        assert_eq!(compare_scores(&second, &first), Ordering::Greater);
    }

    #[test]
    fn resolve_configured_placement_policy_id_falls_back_when_not_a_member() {
        let mut settings = crate::domain::IrregularOptimizerSettings {
            order_window: 4.0,
            beam_width: 8.0,
            local_candidate_fanout: 4.0,
            local_repair_budget: 0.0,
            intrinsic_shared_archive_enabled: true,
            intrinsic_objective_profile_id: crate::domain::IntrinsicObjectiveProfileId::Compact,
            transform_cap: 8.0,
            transform_minimum_edge_length_mm: 1.0,
            transform_angle_deduplication_tolerance_deg: 0.01,
            configured_rotation_enabled: true,
            edge_alignment_enabled: true,
            configured_rotation_deg: vec![],
            ga_enabled: false,
            baseline_only: true,
            ga_population: 12.0,
            ga_generation_budget: 2.0,
            ga_evaluation_budget: 24.0,
            ga_time_budget_ms: 15000.0,
            ga_seed: "default".to_string(),
            priority_order_mutation_enabled: true,
            transform_preference_mutation_enabled: true,
            placement_policy_mutation_enabled: true,
            placement_policy_id: IrregularPlacementPolicyId::ShortSideFill,
            placement_policy_ids: vec![IrregularPlacementPolicyId::BalancedCompactness],
        };
        assert_eq!(
            resolve_configured_placement_policy_id(&settings),
            DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
        );
        settings.placement_policy_ids = vec![IrregularPlacementPolicyId::ShortSideFill];
        assert_eq!(
            resolve_configured_placement_policy_id(&settings),
            IrregularPlacementPolicyId::ShortSideFill
        );
    }
}
