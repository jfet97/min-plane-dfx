//! Transform enumeration/generation and the adaptive Compact transform
//! policy.
//!
//! TS source: `src/workers/irregular/transformGenerator.ts` (full file, read
//! in full: lines 1-441), plus `src/shared/irregular/executionMode.ts`
//! (`intrinsicSharedArchiveEligibility`, its one non-trivial dependency) and
//! `docs/research/adaptive-compact-transform-policy.md` (the adaptive policy's
//! design rationale, quoted formulas match verbatim).
//!
//! # Scope: what is and is not ported here
//!
//! - **Ported**: everything from `deriveEffectiveTransformPolicy` onward
//!   (`transformGenerator.ts:70-433`) — i.e. the actual candidate-generation
//!   algorithm, its adaptive Compact policy branch, deduplication, cap
//!   selection, and output ordering.
//! - **Not ported / intentionally out of scope**: `decodeInput`
//!   (`transformGenerator.ts:241-250`, `Schema.decodeUnknownExit`). Per this
//!   crate's established domain-layer convention (see
//!   `crate::domain`'s module doc: "trusted request conversion after
//!   TypeScript schema validation... the validation itself is not [ported]"),
//!   [`GenerateTransformsInput`] here is a Rust-typed, already-trusted
//!   argument — its field *shapes* are enforced by the Rust type system at
//!   compile time, and its numeric refinements (`Schema.Finite`,
//!   `PositiveFiniteInteger`, etc.) are the N-API/JSON deserialization
//!   boundary's responsibility, not this pure algorithm function's. The one
//!   TS decode-failure message
//!   (`'transform input must satisfy its schema.'`,
//!   `transformGenerator.ts:246`) therefore has no Rust equivalent here.
//!
//! # The `intrinsicSharedArchiveEligibility` `?? 4`/`?? 128` fallback (flagged prominently, per task instruction)
//!
//! `executionMode.ts:27-29`'s `gaGenerationBudget ?? 4`/`gaEvaluationBudget
//! ?? 128` are documented (`docs/planning/rust-irregular-backend/characterization/collision-prep.md`,
//! "Possible latent inconsistency") as encoding *different* numbers than the
//! schema's actual decode defaults (`DEFAULT_IRREGULAR_GA_GENERATION_BUDGET =
//! 2`, `DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET = 24`,
//! `domain.ts:101-102`) — a real, if currently dead, discrepancy the source
//! itself carries. That collision-prep doc explicitly instructs: "a Rust port
//! must decide whether to encode the `4`/`128` fallback literally... or
//! obtain an explicit ruling that it is provably unreachable... Do not
//! silently 'fix' it to `2`/`24` without a ruling."
//!
//! This Rust port cannot literally encode that fallback at all: this crate's
//! `domain::settings::IrregularOptimizerSettings::ga_generation_budget`/
//! `ga_evaluation_budget` are already-resolved, **required** `f64` fields
//! (never `Option<f64>`) — a design the `domain::settings` module doc
//! justifies on exactly the same grounds as `executionMode.ts`'s own
//! precondition ("`Schema.Class`'s own generated constructor/decoder for
//! `optionalKey` + `withConstructorDefault`/`withDecodingDefaultKey` fields
//! *always* assigns a concrete value... so a real
//! `IrregularOptimizerSettings` instance... never has one of these fields
//! genuinely absent"). Since the field can never be absent in this crate's
//! typed representation, the `??` branch is structurally unreachable here,
//! not just practically unreachable as in the TS source -- there is no
//! `None`/absent state for `2.0`/`24.0` (or `4.0`/`128.0`) to ever
//! substitute for. [`intrinsic_shared_archive_eligible`] below therefore
//! reads `optimizer.ga_generation_budget`/`ga_evaluation_budget` directly,
//! with no fallback expression at all. This is flagged here prominently (not
//! silently assumed) exactly as the collision-prep doc requests.
//!
//! # Trig-into-canonical-geometry flag: `atan2`/`asin` V8-parity investigation (task-mandated, prominent)
//!
//! [`derive_usable_edges`] computes each polygon edge's alignment rotation
//! via `Math.atan2` (`transformGenerator.ts:272`), and
//! [`derive_effective_transform_policy`]'s adaptive-Compact branch computes
//! the angle-deduplication tolerance via `Math.asin`
//! (`transformGenerator.ts:190-193`). These `atan2`/`asin`-derived
//! `rotation_deg` values are exactly the **contractual candidate order**
//! this module is scored on: they feed the significance/output-order
//! comparators, the near-angle dedup, and ultimately every `edge_alignment`
//! `IrregularTransformCandidate.rotation_deg` this module returns -- values
//! that go on to become rotated collision-polygon coordinates
//! (`transforms::rotate`) hashed into canonical checkpoint/history
//! artifacts. Per the task's explicit instruction, this is flagged
//! prominently rather than assumed "close enough."
//!
//! **Measured evidence** (not an assumption): this port initially used
//! Rust's `f64::atan2`/`f64::asin` (glibc's system libm on Linux) directly
//! and failed its own differential vector suite
//! (`tests/transforms_vectors.rs`, generated from real
//! `TransformGeneratorLive.generateTransforms` output) on a synthetic
//! scalene-triangle edge (`dx = -1.2, dy = -3.7`): Rust's `f64::atan2`
//! produced `0xbffe26926b0e1c56`, V8's `Math.atan2` (captured via the
//! dump script's oracle) produced `0xbffe26926b0e1c57` -- a confirmed
//! 1-ULP divergence, exactly the risk the migration prompt's §8.1/§8.3 and
//! this task's own instructions warned would need vector evidence, not
//! assumption, to resolve. A follow-up 8,000-case random differential sweep
//! (`atan2`/`hypot`/`asin`/`sin`+`cos`, 2,000 cases each, against the same
//! real V8 oracle) measured:
//!
//! | function | Rust `std` (glibc) mismatches / 2000 | `libm` crate mismatches / 2000 |
//! | --- | ---: | ---: |
//! | `atan2` | 418 | 135 |
//! | `hypot` | 766 | 800 |
//! | `asin` | 164 | 103 |
//! | `sin`+`cos` | 359 | 267 |
//!
//! The pure-Rust [`libm`](https://docs.rs/libm) crate (musl/fdlibm lineage --
//! the same historical lineage V8's own `v8/src/base/ieee754.cc` trig
//! implementation descends from) measurably agrees with V8 more often than
//! `std`/glibc for `atan2`/`asin`/`sin`/`cos`, but is measurably **worse**
//! for `hypot`. The exact V8 corpus remains diagnostic characterization, not
//! a production requirement. Given that evidence and the maintenance-first
//! policy, this module routes only `atan2` and `asin` (the two functions
//! actually feeding `rotation_deg`/the angle-tolerance threshold here)
//! through `libm`, and keeps `hypot` (edge length,
//! `derive_usable_edges`; max-vertex-radius,
//! `derive_effective_transform_policy`) at the audited `std::f64::hypot`
//! boundary.
//! `transforms::rotate`'s `sin`/`cos` (a **different** call site, ported
//! separately) is left on `std` per that module's own doc -- its dedicated
//! 650-case/2,850-point differential vector suite passed 100% bit-exact
//! against V8 with `std` as generated, so there is no measured regression to
//! fix there today. If a future fixture or production angle ever fails
//! either suite, that is the signal this risk has become real for that
//! specific call site and needs its own resolution, not a silent tolerance
//! widening.

use crate::domain::{
    CollisionGeometry, IrregularGeometrySettings, IrregularOptimizerSettings,
    IrregularPlacementPolicyId, IrregularPoint, IrregularTransformCandidate,
    IrregularTransformReason,
};
use crate::js_number::{fold_negative_zero, js_math};
use std::cmp::Ordering;

use super::boundary_check::{validate_strict_boundary, BoundaryValidation};

/// TS: `transformGenerator.ts:15` `FULL_TURN_DEGREES`.
const FULL_TURN_DEGREES: f64 = 360.0;
/// TS: `transformGenerator.ts:16` `DEGREES_PER_RADIAN = 180 / Math.PI`.
/// `std::f64::consts::PI` is the same IEEE-754 binary64 closest-to-π constant
/// `Math.PI` is, so this division reproduces the identical `f64` bit pattern.
const DEGREES_PER_RADIAN: f64 = 180.0 / std::f64::consts::PI;
/// TS: `transformGenerator.ts:17` `COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG`.
const COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG: f64 = 0.051;
/// TS: `transformGenerator.ts:18` `COMPACT_EDGE_SAG_MULTIPLIER`.
const COMPACT_EDGE_SAG_MULTIPLIER: f64 = 4.0;
/// TS: `transformGenerator.ts:19` `COMPACT_EDGE_SMALLER_DIMENSION_RATIO`.
const COMPACT_EDGE_SMALLER_DIMENSION_RATIO: f64 = 0.01;

/// TS: `services.ts:117-123` `GenerateTransformsInput` (field order
/// preserved). See this module's top-level doc for why this is a trusted,
/// already-typed argument rather than a schema-decoding boundary value.
#[derive(Clone, Debug)]
pub struct GenerateTransformsInput {
    pub geometry: CollisionGeometry,
    pub allow_rotation: bool,
    pub allow_mirror: bool,
    pub geometry_settings: IrregularGeometrySettings,
    pub settings: IrregularOptimizerSettings,
}

/// TS: `services.ts:42-44` `IrregularGeometryInputError`. Mirrors the
/// `Data.TaggedError` shape (`operation`, `message`); the `_tag` Effect adds
/// automatically has no Rust equivalent needed here (this crate's error
/// carriers are not routed back through Effect).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularGeometryInputError {
    pub operation: String,
    pub message: String,
}

impl IrregularGeometryInputError {
    fn new(operation: &str, message: impl Into<String>) -> Self {
        Self {
            operation: operation.to_string(),
            message: message.into(),
        }
    }
}

type AngleReason = IrregularTransformReason;

/// TS: `transformGenerator.ts:23-28` `AngleCandidate`.
///
/// `source_ordinal` mirrors TS's plain `number` field (polygon edge index for
/// `edge_alignment`, one of `{0,1,2,3}` for `orthogonal`, or
/// `configuredRotationDeg` array index for `configured`) as a plain `i64`
/// rather than `f64`: unlike `domain::transform::IrregularTransformCandidate`
/// (a serialized trusted-carrier field), this is a purely local intermediate
/// value never crossing a JSON/N-API boundary, so it does not need to mirror
/// JS `number` representation -- it is always a small non-negative array
/// index by construction.
#[derive(Clone, Copy, Debug, PartialEq)]
struct AngleCandidate {
    rotation_deg: f64,
    reason: AngleReason,
    edge_length_mm: f64,
    source_ordinal: i64,
}

/// TS: `transformGenerator.ts:30-34` `UsableEdge`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct UsableEdge {
    rotation_deg: f64,
    length_mm: f64,
    source_ordinal: i64,
}

/// TS: `transformGenerator.ts:40-43` `EffectiveTransformPolicy`.
struct EffectiveTransformPolicy {
    minimum_edge_length_mm: f64,
    angle_deduplication_tolerance_deg: f64,
}

/// TS: `transformGenerator.ts:346-350` `TransformChoice`.
#[derive(Clone, Copy, Debug, PartialEq)]
struct TransformChoice {
    rotation_deg: f64,
    reason: AngleReason,
    mirrored: bool,
}

/// TS: `transformGenerator.ts:70-122` `generateTransforms`, the pure
/// algorithm body (post schema-decode; see module doc).
pub fn generate_transforms(
    input: &GenerateTransformsInput,
) -> Result<Vec<IrregularTransformCandidate>, IrregularGeometryInputError> {
    let boundary = &input.geometry.collision_polygon.points;

    match validate_strict_boundary(boundary) {
        BoundaryValidation::Invalid { message } => {
            return Err(IrregularGeometryInputError::new(
                "generateTransforms",
                message,
            ));
        }
        BoundaryValidation::Valid { .. } => {}
    }

    let effective_policy = derive_effective_transform_policy(input, boundary)
        .map_err(|message| IrregularGeometryInputError::new("generateTransforms", message))?;

    let usable_edges = derive_usable_edges(boundary, effective_policy.minimum_edge_length_mm)
        .map_err(|message| IrregularGeometryInputError::new("generateTransforms", message))?;

    let raw_candidates =
        transform_angle_candidates(input.allow_rotation, &input.settings, &usable_edges);
    let candidates = deduplicate_angles(
        raw_candidates,
        effective_policy.angle_deduplication_tolerance_deg,
    )
    .map_err(|message| IrregularGeometryInputError::new("generateTransforms", message))?;

    let transform_cap = positive_integer_setting_as_usize(input.settings.transform_cap);
    let selected = select_transform_choices(
        &candidates,
        transform_cap,
        input.allow_mirror,
        effective_policy.angle_deduplication_tolerance_deg,
    );

    Ok(selected
        .into_iter()
        .enumerate()
        .map(|(index, candidate)| IrregularTransformCandidate {
            index: index as f64,
            rotation_deg: candidate.rotation_deg,
            mirrored: candidate.mirrored,
            reason: candidate.reason,
        })
        .collect())
}

/// Converts a schema-guaranteed `PositiveFiniteInteger` `f64` field
/// (`transform_cap`) to a `usize` for use as a slice/`Vec` length. The value
/// is trusted to already be a non-negative integral `f64` (this crate's
/// domain layer does not re-validate schema refinements, see
/// `crate::domain`'s module doc); truncation toward zero is therefore exact,
/// never lossy, for any value this field can actually hold.
fn positive_integer_setting_as_usize(value: f64) -> usize {
    if value <= 0.0 {
        0
    } else {
        value as usize
    }
}

/// TS: `transformGenerator.ts:125-156` `transformAngleCandidates`.
fn transform_angle_candidates(
    allow_rotation: bool,
    settings: &IrregularOptimizerSettings,
    usable_edges: &[UsableEdge],
) -> Vec<AngleCandidate> {
    if !allow_rotation {
        return vec![AngleCandidate {
            rotation_deg: 0.0,
            reason: IrregularTransformReason::Orthogonal,
            edge_length_mm: 0.0,
            source_ordinal: 0,
        }];
    }

    let mut candidates = vec![
        AngleCandidate {
            rotation_deg: 0.0,
            reason: IrregularTransformReason::Orthogonal,
            edge_length_mm: 0.0,
            source_ordinal: 0,
        },
        AngleCandidate {
            rotation_deg: 90.0,
            reason: IrregularTransformReason::Orthogonal,
            edge_length_mm: 0.0,
            source_ordinal: 1,
        },
        AngleCandidate {
            rotation_deg: 180.0,
            reason: IrregularTransformReason::Orthogonal,
            edge_length_mm: 0.0,
            source_ordinal: 2,
        },
        AngleCandidate {
            rotation_deg: 270.0,
            reason: IrregularTransformReason::Orthogonal,
            edge_length_mm: 0.0,
            source_ordinal: 3,
        },
    ];

    // TS: `settings.edgeAlignmentEnabled !== false`. `edge_alignment_enabled`
    // is a required, already-decode-defaulted `bool` on this trusted carrier
    // (never absent/non-boolean), so `!== false` collapses exactly to a
    // direct boolean read -- see `domain::settings`'s module doc for why this
    // field can never be genuinely absent here.
    if settings.edge_alignment_enabled {
        for edge in usable_edges {
            candidates.push(AngleCandidate {
                rotation_deg: edge.rotation_deg,
                reason: IrregularTransformReason::EdgeAlignment,
                edge_length_mm: edge.length_mm,
                source_ordinal: edge.source_ordinal,
            });
        }
    }

    // TS: `settings.configuredRotationEnabled !== false` -- see the comment
    // above; same collapse to a direct boolean read.
    if settings.configured_rotation_enabled {
        for (source_ordinal, &rotation_deg) in settings.configured_rotation_deg.iter().enumerate() {
            candidates.push(AngleCandidate {
                rotation_deg,
                reason: IrregularTransformReason::Configured,
                edge_length_mm: 0.0,
                source_ordinal: source_ordinal as i64,
            });
        }
    }

    candidates
}

/// TS: `transformGenerator.ts:158-211` `deriveEffectiveTransformPolicy`.
fn derive_effective_transform_policy(
    input: &GenerateTransformsInput,
    boundary: &[IrregularPoint],
) -> Result<EffectiveTransformPolicy, String> {
    if !intrinsic_shared_archive_eligible(&input.settings) {
        return Ok(EffectiveTransformPolicy {
            minimum_edge_length_mm: input.settings.transform_minimum_edge_length_mm,
            angle_deduplication_tolerance_deg: input
                .settings
                .transform_angle_deduplication_tolerance_deg,
        });
    }

    let bounds = bounds_for_boundary(boundary)?;

    let sag_mm = input.geometry_settings.flattening_sag_tolerance_mm;
    let smaller_collision_dimension_mm = js_math::min(bounds.width_mm, bounds.height_mm);
    let minimum_edge_length_mm = js_math::min(
        COMPACT_EDGE_SAG_MULTIPLIER * sag_mm,
        COMPACT_EDGE_SMALLER_DIMENSION_RATIO * smaller_collision_dimension_mm,
    );

    /*
     * Collision vertices are already local to placementReference, whose local
     * coordinate is (0, 0), matching TS: `transformGenerator.ts:181-185`.
     *
     * N2 audit: `js_math::hypot` supplies `maximum_radius_mm`, which feeds
     * `angle_deduplication_tolerance_deg` below and determines the adaptive
     * Compact policy's transform candidate deduplication tolerance. This is a
     * semantic candidate-set-shaping value, not a diagnostic one.
     */
    let maximum_radius_mm = boundary.iter().fold(0.0_f64, |maximum, point| {
        js_math::max(maximum, js_math::hypot(point.x, point.y))
    });

    let angle_deduplication_tolerance_deg = if maximum_radius_mm == 0.0 {
        COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG
    } else {
        js_math::min(
            COMPACT_MAXIMUM_ANGLE_DEDUPLICATION_DEG,
            2.0 * libm::asin(js_math::min(1.0, sag_mm / (2.0 * maximum_radius_mm)))
                * DEGREES_PER_RADIAN,
        )
    };

    if !minimum_edge_length_mm.is_finite()
        || minimum_edge_length_mm < 0.0
        || !angle_deduplication_tolerance_deg.is_finite()
        || angle_deduplication_tolerance_deg <= 0.0
    {
        return Err("adaptive transform tolerances must be finite and non-negative.".to_string());
    }

    Ok(EffectiveTransformPolicy {
        minimum_edge_length_mm,
        angle_deduplication_tolerance_deg,
    })
}

struct BoundaryBounds {
    width_mm: f64,
    height_mm: f64,
}

/// TS: `transformGenerator.ts:213-239` `boundsForBoundary`.
fn bounds_for_boundary(points: &[IrregularPoint]) -> Result<BoundaryBounds, String> {
    let first = points
        .first()
        .ok_or_else(|| "polygon boundary must contain points.".to_string())?;

    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x;
    let mut max_y = first.y;
    for point in &points[1..] {
        min_x = js_math::min(min_x, point.x);
        min_y = js_math::min(min_y, point.y);
        max_x = js_math::max(max_x, point.x);
        max_y = js_math::max(max_y, point.y);
    }

    let width_mm = max_x - min_x;
    let height_mm = max_y - min_y;
    if !width_mm.is_finite() || !height_mm.is_finite() {
        return Err("collision polygon bounds must be finite.".to_string());
    }

    Ok(BoundaryBounds {
        width_mm,
        height_mm,
    })
}

/// TS: `src/shared/irregular/executionMode.ts:16-33`
/// `intrinsicSharedArchiveEligibility(...).eligible`. Only the boolean
/// `eligible` field this module's caller reads is reproduced (the
/// TS-side `reason` discriminant on the ineligible branch is not consumed by
/// `transformGenerator.ts` and is not ported here). See this module's
/// top-level doc for the `?? 4`/`?? 128` fallback discussion.
fn intrinsic_shared_archive_eligible(optimizer: &IrregularOptimizerSettings) -> bool {
    if !optimizer.intrinsic_shared_archive_enabled {
        return false;
    }
    if optimizer.placement_policy_id == IrregularPlacementPolicyId::ShortSideFill {
        return false;
    }

    !optimizer.ga_enabled
        || optimizer.baseline_only
        || optimizer.ga_time_budget_ms == 0.0
        || optimizer.ga_generation_budget == 0.0
        || optimizer.ga_evaluation_budget == 0.0
}

/// TS: `transformGenerator.ts:252-284` `deriveUsableEdges`.
fn derive_usable_edges(
    points: &[IrregularPoint],
    minimum_length: f64,
) -> Result<Vec<UsableEdge>, String> {
    let mut usable_edges = Vec::new();
    let n = points.len();

    for index in 0..n {
        let start = points[index];
        let end = points[(index + 1) % n];

        let delta_x = end.x - start.x;
        let delta_y = end.y - start.y;
        /*
         * The audited `js_math::hypot` boundary supplies `length`, which is
         * stored as `UsableEdge::length_mm` and
         * `AngleCandidate::edge_length_mm`. The
         * `compare_representative_significance` and `compare_output_order`
         * tie-breaks subtract these fields directly. Final legality, quality,
         * and deterministic candidate ordering are blocking; Node/V8 ULP
         * differences are diagnostic.
         */
        let length = js_math::hypot(delta_x, delta_y);
        if !delta_x.is_finite() || !delta_y.is_finite() || !length.is_finite() {
            return Err("derived polygon edge length must be finite.".to_string());
        }

        let direction_deg = libm::atan2(delta_y, delta_x) * DEGREES_PER_RADIAN;
        let rotation_deg = normalize_rotation_deg(-direction_deg)
            .ok_or_else(|| "derived polygon edge rotation must be finite.".to_string())?;

        if length >= minimum_length {
            usable_edges.push(UsableEdge {
                rotation_deg,
                length_mm: length,
                source_ordinal: index as i64,
            });
        }
    }

    Ok(usable_edges)
}

/// TS: `transformGenerator.ts:286-317` `deduplicateAngles`.
fn deduplicate_angles(
    raw_candidates: Vec<AngleCandidate>,
    tolerance_deg: f64,
) -> Result<Vec<AngleCandidate>, String> {
    let mut normalized = Vec::with_capacity(raw_candidates.len());
    for candidate in raw_candidates {
        let rotation_deg = normalize_rotation_deg(candidate.rotation_deg)
            .ok_or_else(|| "derived transform rotation must be finite.".to_string())?;
        normalized.push(AngleCandidate {
            rotation_deg,
            ..candidate
        });
    }

    // `Vec::sort_by` is a stable sort, matching `Array.prototype.sort`'s
    // ECMAScript-2019+ stability guarantee (see
    // `characterization/collision-prep.md` §5's discussion of why this
    // matters even though the current comparator's tie-break is injective in
    // practice).
    normalized.sort_by(compare_representative_significance);

    let mut retained: Vec<AngleCandidate> = Vec::new();
    for candidate in normalized {
        let is_near_duplicate = retained.iter().any(|existing| {
            !(candidate.reason == IrregularTransformReason::Orthogonal
                && existing.reason == IrregularTransformReason::Orthogonal)
                && circular_distance_deg(existing.rotation_deg, candidate.rotation_deg)
                    <= tolerance_deg
        });
        if is_near_duplicate {
            continue;
        }
        retained.push(candidate);
    }

    retained.sort_by(compare_output_order);
    Ok(retained)
}

/// TS: `transformGenerator.ts:319-334` `compareRepresentativeSignificance`.
/// Decides which candidate in a near-angle cluster survives deduplication.
fn compare_representative_significance(
    first: &AngleCandidate,
    second: &AngleCandidate,
) -> Ordering {
    let priority_cmp = reason_priority(first.reason).cmp(&reason_priority(second.reason));
    if priority_cmp != Ordering::Equal {
        return priority_cmp;
    }

    if first.reason == IrregularTransformReason::EdgeAlignment
        && second.reason == IrregularTransformReason::EdgeAlignment
    {
        let length_cmp = second.edge_length_mm - first.edge_length_mm;
        if length_cmp != 0.0 {
            return ordering_from_diff(length_cmp);
        }
    }

    let rotation_cmp = first.rotation_deg - second.rotation_deg;
    if rotation_cmp != 0.0 {
        return ordering_from_diff(rotation_cmp);
    }

    first.source_ordinal.cmp(&second.source_ordinal)
}

/// TS: `transformGenerator.ts:336-344` `compareOutputOrder`. Deliberately a
/// **different** comparator from [`compare_representative_significance`]
/// (step 2/3 swapped, and the length tie-break here has no "both
/// edge_alignment" guard) -- see this module's `super`-level parity-matrix
/// citation and `characterization/collision-prep.md` §6 for why these must
/// stay two independent functions, never unified.
fn compare_output_order(first: &AngleCandidate, second: &AngleCandidate) -> Ordering {
    let priority_cmp = reason_priority(first.reason).cmp(&reason_priority(second.reason));
    if priority_cmp != Ordering::Equal {
        return priority_cmp;
    }

    let rotation_cmp = first.rotation_deg - second.rotation_deg;
    if rotation_cmp != 0.0 {
        return ordering_from_diff(rotation_cmp);
    }

    let length_cmp = second.edge_length_mm - first.edge_length_mm;
    if length_cmp != 0.0 {
        return ordering_from_diff(length_cmp);
    }

    first.source_ordinal.cmp(&second.source_ordinal)
}

/// TS: `transformGenerator.ts:411-420` `reasonPriority`. Ascending:
/// `orthogonal` (0) beats `edge_alignment` (1) beats `configured` (2).
fn reason_priority(reason: AngleReason) -> i32 {
    match reason {
        IrregularTransformReason::Orthogonal => 0,
        IrregularTransformReason::EdgeAlignment => 1,
        IrregularTransformReason::Configured => 2,
    }
}

/// Converts a JS-comparator-style numeric difference (`first - second`) into
/// an `Ordering`, matching `Array.prototype.sort`'s "positive means `first`
/// sorts after `second`" contract. Callers only reach this after confirming
/// `diff != 0.0` (the TS comparator chains only continue past a `!== 0`
/// check), so `diff` here is never exactly zero in practice, but the
/// `Ordering::Equal` fallback is kept for totality.
fn ordering_from_diff(diff: f64) -> Ordering {
    if diff > 0.0 {
        Ordering::Greater
    } else if diff < 0.0 {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// TS: `transformGenerator.ts:352-384` `selectTransformChoices`.
fn select_transform_choices(
    angles: &[AngleCandidate],
    transform_cap: usize,
    allow_mirror: bool,
    tolerance_deg: f64,
) -> Vec<TransformChoice> {
    let baseline: Vec<&AngleCandidate> = angles
        .iter()
        .filter(|candidate| candidate.reason == IrregularTransformReason::Orthogonal)
        .collect();
    let baseline_choices: Vec<TransformChoice> = baseline
        .iter()
        .map(|candidate| to_transform_choice(candidate, false))
        .collect();

    let mut selected: Vec<TransformChoice> =
        baseline_choices.into_iter().take(transform_cap).collect();

    if selected.len() >= transform_cap || !allow_mirror {
        if !allow_mirror {
            let remaining = transform_cap.saturating_sub(selected.len());
            let extra: Vec<TransformChoice> = angles
                .iter()
                .filter(|candidate| candidate.reason != IrregularTransformReason::Orthogonal)
                .map(|candidate| to_transform_choice(candidate, false))
                .take(remaining)
                .collect();
            selected.extend(extra);
        }
        selected.truncate(transform_cap);
        return selected;
    }

    let mut extra_choices: Vec<TransformChoice> = Vec::new();
    for candidate in angles
        .iter()
        .filter(|candidate| candidate.reason != IrregularTransformReason::Orthogonal)
    {
        append_distinct_choice(
            &mut extra_choices,
            to_transform_choice(candidate, true),
            tolerance_deg,
        );
        append_distinct_choice(
            &mut extra_choices,
            to_transform_choice(candidate, false),
            tolerance_deg,
        );
    }
    for candidate in &baseline {
        append_distinct_choice(
            &mut extra_choices,
            to_transform_choice(candidate, true),
            tolerance_deg,
        );
    }

    let remaining = transform_cap.saturating_sub(selected.len());
    selected.extend(extra_choices.into_iter().take(remaining));
    selected
}

/// TS: `transformGenerator.ts:386-401` `appendDistinctChoice`.
fn append_distinct_choice(
    choices: &mut Vec<TransformChoice>,
    candidate: TransformChoice,
    tolerance_deg: f64,
) {
    let is_near_duplicate = choices.iter().any(|existing| {
        existing.mirrored == candidate.mirrored
            && circular_distance_deg(existing.rotation_deg, candidate.rotation_deg) <= tolerance_deg
    });
    if is_near_duplicate {
        return;
    }
    choices.push(candidate);
}

/// TS: `transformGenerator.ts:403-409` `toTransformChoice`.
fn to_transform_choice(candidate: &AngleCandidate, mirrored: bool) -> TransformChoice {
    let rotation_deg = if mirrored && candidate.reason == IrregularTransformReason::EdgeAlignment {
        normalize_rotation_deg(180.0 - candidate.rotation_deg).unwrap_or(candidate.rotation_deg)
    } else {
        candidate.rotation_deg
    };
    TransformChoice {
        rotation_deg,
        reason: candidate.reason,
        mirrored,
    }
}

/// TS: `transformGenerator.ts:422-425` `circularDistanceDeg`.
fn circular_distance_deg(first: f64, second: f64) -> f64 {
    let absolute_distance = (first - second).abs();
    js_math::min(absolute_distance, FULL_TURN_DEGREES - absolute_distance)
}

/// TS: `transformGenerator.ts:427-433` `normalizeRotationDeg`. `None` mirrors
/// TS's `undefined` return for non-finite input.
fn normalize_rotation_deg(rotation_deg: f64) -> Option<f64> {
    if !rotation_deg.is_finite() {
        return None;
    }
    let remainder = rotation_deg % FULL_TURN_DEGREES;
    let normalized = if remainder < 0.0 {
        remainder + FULL_TURN_DEGREES
    } else {
        remainder
    };
    // TS: `Object.is(normalized, -0) ? 0 : normalized`; reuses
    // `js_number::fold_negative_zero`, which folds exactly (and only) `-0.0`
    // per that function's own documented `Object.is(value, -0)` equivalence.
    Some(fold_negative_zero(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{IrregularBounds, IrregularPolygon, PieceId};

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn square_geometry(points: Vec<IrregularPoint>) -> CollisionGeometry {
        CollisionGeometry {
            source_piece_id: PieceId::new("transform-test-piece"),
            source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
            sampled_points: vec![p(0.0, 0.0), p(10.0, 0.0), p(10.0, 10.0), p(0.0, 10.0)],
            convex_hull: IrregularPolygon::new(vec![
                p(0.0, 0.0),
                p(10.0, 0.0),
                p(10.0, 10.0),
                p(0.0, 10.0),
            ]),
            collision_polygon: IrregularPolygon::new(points),
            placement_reference: p(0.0, 0.0),
            diagnostics: vec![],
        }
    }

    fn base_settings() -> IrregularOptimizerSettings {
        IrregularOptimizerSettings {
            order_window: 2.0,
            beam_width: 8.0,
            local_candidate_fanout: 4.0,
            local_repair_budget: 0.0,
            intrinsic_shared_archive_enabled: false,
            intrinsic_objective_profile_id: crate::domain::IntrinsicObjectiveProfileId::Compact,
            transform_cap: 16.0,
            transform_minimum_edge_length_mm: 1.0,
            transform_angle_deduplication_tolerance_deg: 0.01,
            configured_rotation_enabled: true,
            edge_alignment_enabled: true,
            configured_rotation_deg: vec![],
            ga_enabled: false,
            baseline_only: true,
            ga_population: 8.0,
            ga_generation_budget: 2.0,
            ga_evaluation_budget: 24.0,
            ga_time_budget_ms: 1000.0,
            ga_seed: "transform-test".to_string(),
            priority_order_mutation_enabled: true,
            transform_preference_mutation_enabled: true,
            placement_policy_mutation_enabled: true,
            placement_policy_id: IrregularPlacementPolicyId::BalancedCompactness,
            placement_policy_ids: crate::domain::default_irregular_placement_policy_ids(),
        }
    }

    fn base_geometry_settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "transform-test".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    fn generate(
        points: Vec<IrregularPoint>,
        mutate: impl FnOnce(&mut GenerateTransformsInput),
    ) -> Vec<IrregularTransformCandidate> {
        let mut input = GenerateTransformsInput {
            geometry: square_geometry(points),
            allow_rotation: true,
            allow_mirror: false,
            geometry_settings: base_geometry_settings(),
            settings: base_settings(),
        };
        mutate(&mut input);
        generate_transforms(&input).expect("valid transform input")
    }

    #[test]
    fn emits_only_zero_degree_when_rotation_disabled() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)],
            |input| {
                input.allow_rotation = false;
            },
        );
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.rotation_deg)
                .collect::<Vec<_>>(),
            vec![0.0]
        );
    }

    #[test]
    fn returns_four_orthogonal_baseline_choices_for_a_square() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)],
            |_| {},
        );
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.rotation_deg)
                .collect::<Vec<_>>(),
            vec![0.0, 90.0, 180.0, 270.0]
        );
        assert!(candidates
            .iter()
            .all(|c| c.reason == IrregularTransformReason::Orthogonal));
    }

    #[test]
    fn appends_mirrors_after_unmirrored_choices_and_caps_the_combined_list() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)],
            |input| {
                input.allow_mirror = true;
                input.settings.transform_cap = 6.0;
            },
        );
        assert_eq!(
            candidates.iter().map(|c| c.mirrored).collect::<Vec<_>>(),
            vec![false, false, false, false, true, true]
        );
        assert_eq!(
            candidates.iter().map(|c| c.index).collect::<Vec<_>>(),
            vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]
        );
    }

    #[test]
    fn keeps_exact_derived_edge_angles_ahead_of_configured_under_the_cap() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(3.0, 2.0), p(1.0, 3.0)],
            |input| {
                input.allow_mirror = true;
                input.settings.transform_cap = 6.0;
                input.settings.configured_rotation_deg = vec![12.5];
            },
        );
        assert!(candidates[4..]
            .iter()
            .all(|c| c.reason == IrregularTransformReason::EdgeAlignment));
    }

    #[test]
    fn can_disable_configured_angles_without_disabling_baseline() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)],
            |input| {
                input.settings.configured_rotation_enabled = false;
                input.settings.configured_rotation_deg = vec![12.5];
            },
        );
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.rotation_deg)
                .collect::<Vec<_>>(),
            vec![0.0, 90.0, 180.0, 270.0]
        );
    }

    #[test]
    fn can_disable_edge_derived_angles_without_disabling_configured() {
        let candidates = generate(vec![p(0.0, 0.0), p(3.0, 3.0), p(0.0, 1.0)], |input| {
            input.settings.configured_rotation_deg = vec![12.5];
            input.settings.edge_alignment_enabled = false;
        });
        assert!(candidates
            .iter()
            .any(|c| c.reason == IrregularTransformReason::Configured && c.rotation_deg == 12.5));
        assert!(!candidates
            .iter()
            .any(|c| c.reason == IrregularTransformReason::EdgeAlignment));
    }

    #[test]
    fn does_not_let_mirror_variants_bypass_the_transform_cap() {
        let candidates = generate(
            vec![p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)],
            |input| {
                input.allow_mirror = true;
                input.settings.transform_cap = 3.0;
            },
        );
        assert_eq!(candidates.len(), 3);
    }

    #[test]
    fn adaptive_compact_policy_derives_scale_aware_minimum_edge_length() {
        // Regression for the adaptive-policy formula itself, independent of
        // the full generate_transforms pipeline.
        let square = vec![p(0.0, 0.0), p(100.0, 0.0), p(100.0, 100.0), p(0.0, 100.0)];
        let mut settings = base_settings();
        settings.intrinsic_shared_archive_enabled = true;
        settings.placement_policy_id =
            IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness;
        let input = GenerateTransformsInput {
            geometry: square_geometry(square.clone()),
            allow_rotation: true,
            allow_mirror: false,
            geometry_settings: base_geometry_settings(),
            settings,
        };
        let policy = derive_effective_transform_policy(&input, &square).expect("policy derives");
        // min(4 * 0.25, 0.01 * 100) = min(1.0, 1.0) = 1.0
        assert_eq!(policy.minimum_edge_length_mm, 1.0);
    }

    #[test]
    fn short_side_fill_placement_policy_disables_the_adaptive_policy() {
        let mut settings = base_settings();
        settings.intrinsic_shared_archive_enabled = true;
        settings.placement_policy_id = IrregularPlacementPolicyId::ShortSideFill;
        settings.transform_minimum_edge_length_mm = 7.0;
        settings.transform_angle_deduplication_tolerance_deg = 3.0;
        assert!(!intrinsic_shared_archive_eligible(&settings));
    }

    #[test]
    fn ga_active_disables_the_adaptive_policy() {
        let mut settings = base_settings();
        settings.intrinsic_shared_archive_enabled = true;
        settings.placement_policy_id =
            IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness;
        settings.ga_enabled = true;
        settings.baseline_only = false;
        settings.ga_time_budget_ms = 5000.0;
        settings.ga_generation_budget = 3.0;
        settings.ga_evaluation_budget = 30.0;
        assert!(!intrinsic_shared_archive_eligible(&settings));
    }

    #[test]
    fn normalize_rotation_deg_folds_negative_zero() {
        // -360 % 360 === -0 in JS; must fold to +0.
        let normalized = normalize_rotation_deg(-360.0).expect("finite");
        assert_eq!(normalized.to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn circular_distance_handles_the_seam() {
        assert_eq!(circular_distance_deg(1.0, 359.0), 2.0);
        assert_eq!(circular_distance_deg(0.0, 180.0), 180.0);
    }
}
