//! Exact canonical-grid contact terms plus the floating-mm "source geometry"
//! contact counterpart.
//!
//! TS sources ported here in full:
//! - `src/workers/irregular/canonicalGridContact.ts` (387 lines) — exact
//!   integer-grid collinearity/overlap between already-canonicalized
//!   collision paths.
//! - `src/workers/irregular/convexPolygonContact.ts` (319 lines) — the
//!   floating-mm counterpart, measuring shared boundary between already-
//!   translated **convex** collision polygons via the adaptive-precision
//!   `orient2d` predicate rather than exact BigInt arithmetic (division of
//!   responsibility per the migration prompt's §8.3: "robust predicates own
//!   unsnapped source-geometry decisions" vs. "canonical comparisons are
//!   exact").
//!
//! Grounding source:
//! `docs/planning/rust-irregular-backend/characterization/canonical-grid.md`
//! (this cluster's Stage 0 characterization; §1-§2 document both files'
//! production-liveness and exported-symbol call graph in full) and
//! `docs/planning/rust-irregular-backend/stage0-rulings.md`.
//!
//! # Structural duplication preserved verbatim
//!
//! Both TS files independently declare textually-near-identical private
//! helpers (`deriveNearCompleteStructuralContactSignatures`,
//! `structuralContactSignature`, `structuralEdgeDescriptor`, `turnCosine`,
//! `ratioSignatureKey`) — this is genuine duplication in the TS source (not a
//! shared utility), so this module keeps them as two independent families of
//! private functions (suffixed `_grid`/`convex_*`) rather than unifying them
//! behind one generic abstraction, per the migration prompt's "TS behavior IS
//! the spec — mechanical translation" rule: unifying them would risk a subtly
//! different result on some future edge case neither original TS
//! implementation intended to share.
//!
//! # `measureCanonicalGridBoundaryOverlapAxisUnits` — the one cancellation hook
//!
//! Per the task's framing and `canonical-grid.md` §2/§15:
//! [`measure_canonical_grid_boundary_overlap_axis_units`] is the **only**
//! function in this module with an external checkpoint/cancellation hook
//! (`intrinsicShortSideContactStrip.ts:680-696` is its sole production
//! caller). The exact placement of each `checked()` call —
//! once per path-construction step inside `canonicalGridPathEdges`, then once
//! before each outer-loop edge and once before each inner-loop edge in the
//! edge-pair scan — is preserved exactly; see that function's doc comment.

use std::cell::Cell;
use std::cmp::Ordering;

use num_bigint::BigInt;

use crate::clipper::core::{bigint_to_number, f64_to_bigint};
use crate::domain::IrregularPoint;
use crate::geometry::convex::{are_disjoint, IrregularPolygonWithBounds};
use crate::geometry::predicates::orientation;
use crate::js_number::{cmp_js_code_units, is_safe_integer, js_math, number_to_js_string};

use super::{canonical_grid_cross_sign, CanonicalGridPath, CanonicalGridPoint};

const MIN_STRUCTURAL_EDGE_LENGTH_RATIO: f64 = 0.5;
const MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO: f64 = 0.95;
const STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE: f64 = 1_000.0;
const STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE: f64 = 1_000.0;

// ===========================================================================
// canonicalGridContact.ts
// ===========================================================================

/// TS source: `canonicalGridContact.ts:5-10` (`CanonicalGridBoundaryContact`).
///
/// `near_complete_structural_contact_count` mirrors the TS `number` field
/// (always `signatures.length`, a non-negative safe integer in practice) as
/// `f64`, matching this crate's domain-layer convention that every TS
/// `number` field is a plain `f64`, never a narrower Rust integer type (see
/// `crate::domain`'s module doc).
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalGridBoundaryContact {
    pub length_mm: f64,
    pub normalized_units: f64,
    pub near_complete_structural_contact_count: f64,
    pub near_complete_structural_contact_signatures: Vec<String>,
}

/// TS source: `canonicalGridContact.ts:12-15`
/// (`CanonicalGridBoundaryOverlapAxisUnitsResult`).
///
/// Per that type's TS doc comment (reproduced in
/// `canonical-grid.md` §3): `Undecidable` is returned both for structural
/// failure (unsafe-integer coordinates, degenerate path) **and** for the
/// deliberate "positive diagonal contact is not comparable" case
/// (`canonicalGridContact.ts:331`) — these two causes are not distinguished
/// in the TS return type either, and the only production caller treats both
/// uniformly as "skip this pair," so this port does not distinguish them.
#[derive(Debug, Clone, PartialEq)]
pub enum CanonicalGridBoundaryOverlapAxisUnitsResult {
    Measured { score: BigInt },
    Undecidable,
    Aborted,
}

/// TS source: `canonicalGridContact.ts:17-21` (`CanonicalGridEdge`).
#[derive(Debug, Clone, Copy)]
struct CanonicalGridEdge {
    start: CanonicalGridPoint,
    end: CanonicalGridPoint,
    start_index: usize,
}

/// A safe-integer-valued grid coordinate converted to the `BigInt` it exactly
/// denotes, mirroring the implicit `BigInt(value)` conversions throughout
/// `canonicalGridContact.ts`. Every call site here operates on a coordinate
/// already validated by [`canonical_grid_path_edges`]'s
/// `Number.isSafeInteger` gate, so `clipper::core::f64_to_bigint`'s
/// integer-valued-input precondition always holds.
fn grid_coordinate_to_bigint(value: f64) -> BigInt {
    f64_to_bigint(value)
}

fn absolute_bigint(value: &BigInt) -> BigInt {
    if *value < BigInt::from(0) {
        -value
    } else {
        value.clone()
    }
}

fn minimum_bigint(first: &BigInt, second: &BigInt) -> BigInt {
    if first < second {
        first.clone()
    } else {
        second.clone()
    }
}

fn maximum_bigint(first: &BigInt, second: &BigInt) -> BigInt {
    if first > second {
        first.clone()
    } else {
        second.clone()
    }
}

/// TS source: `canonicalGridContact.ts:37-52`
/// (`hasPositiveCanonicalGridBoundaryContact`).
pub fn has_positive_canonical_grid_boundary_contact(
    first: &[CanonicalGridPoint],
    second: &[CanonicalGridPoint],
) -> Option<bool> {
    let first_edges = canonical_grid_path_edges(first, None)?;
    let second_edges = canonical_grid_path_edges(second, None)?;
    for first_edge in &first_edges {
        for second_edge in &second_edges {
            let overlap = canonical_grid_collinear_overlap(first_edge, second_edge)?;
            if overlap.length_mm > 0.0 {
                return Some(true);
            }
        }
    }
    Some(false)
}

/// TS source: `canonicalGridContact.ts:58-109`
/// (`measureCanonicalGridBoundaryContact`).
pub fn measure_canonical_grid_boundary_contact(
    first: &CanonicalGridPath,
    second: &CanonicalGridPath,
) -> Option<CanonicalGridBoundaryContact> {
    let first_edges = canonical_grid_path_edges(first, None)?;
    let second_edges = canonical_grid_path_edges(second, None)?;

    let mut segment_lengths_mm: Vec<f64> = Vec::new();
    for first_edge in &first_edges {
        for second_edge in &second_edges {
            let overlap = canonical_grid_collinear_overlap(first_edge, second_edge)?;
            if overlap.length_mm > 0.0 {
                segment_lengths_mm.push(overlap.length_mm);
            }
        }
    }

    // R11: serial left-to-right float fold, matching `segments.reduce((sum,
    // segment) => sum + segment.lengthMm, 0)` (`canonicalGridContact.ts:77`)
    // in discovery order (outer `firstEdge`, inner `secondEdge`).
    let length_mm = segment_lengths_mm
        .iter()
        .fold(0.0_f64, |sum, value| sum + value);
    if !length_mm.is_finite() || length_mm < 0.0 {
        return None;
    }
    if length_mm == 0.0 {
        return Some(CanonicalGridBoundaryContact {
            length_mm: 0.0,
            normalized_units: 0.0,
            near_complete_structural_contact_count: 0.0,
            near_complete_structural_contact_signatures: Vec::new(),
        });
    }

    let first_longest_edge_mm = longest_canonical_grid_edge_length(&first_edges)?;
    let second_longest_edge_mm = longest_canonical_grid_edge_length(&second_edges)?;
    let normalization_length_mm = js_math::min(first_longest_edge_mm, second_longest_edge_mm);
    let normalized_units = length_mm / normalization_length_mm;
    if !normalized_units.is_finite() || normalized_units < 0.0 {
        return None;
    }

    let signatures = derive_near_complete_structural_contact_signatures_grid(
        &first_edges,
        &second_edges,
        first_longest_edge_mm,
        second_longest_edge_mm,
    )?;
    Some(CanonicalGridBoundaryContact {
        length_mm,
        normalized_units,
        near_complete_structural_contact_count: signatures.len() as f64,
        near_complete_structural_contact_signatures: signatures,
    })
}

/// TS source: `canonicalGridContact.ts:111-146`
/// (`deriveNearCompleteStructuralContactSignatures`).
fn derive_near_complete_structural_contact_signatures_grid(
    first_edges: &[CanonicalGridEdge],
    second_edges: &[CanonicalGridEdge],
    first_longest_edge_mm: f64,
    second_longest_edge_mm: f64,
) -> Option<Vec<String>> {
    let mut signatures = Vec::new();
    for first_edge in first_edges {
        let first_edge_length_mm = canonical_grid_edge_length_mm(first_edge)?;
        if first_edge_length_mm < first_longest_edge_mm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO {
            continue;
        }
        for second_edge in second_edges {
            let second_edge_length_mm = canonical_grid_edge_length_mm(second_edge)?;
            if second_edge_length_mm < second_longest_edge_mm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO {
                continue;
            }
            let overlap = canonical_grid_collinear_overlap(first_edge, second_edge)?;
            let shorter_edge_length_mm = js_math::min(first_edge_length_mm, second_edge_length_mm);
            if overlap.length_mm >= shorter_edge_length_mm * MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO {
                let signature = canonical_grid_structural_contact_signature(
                    first_edge,
                    second_edge,
                    first_edges,
                    second_edges,
                    first_longest_edge_mm,
                    second_longest_edge_mm,
                )?;
                signatures.push(signature);
            }
        }
    }
    Some(signatures)
}

/// TS source: `canonicalGridContact.ts:148-162` (`structuralContactSignature`).
fn canonical_grid_structural_contact_signature(
    first_edge: &CanonicalGridEdge,
    second_edge: &CanonicalGridEdge,
    first_edges: &[CanonicalGridEdge],
    second_edges: &[CanonicalGridEdge],
    first_longest_edge_mm: f64,
    second_longest_edge_mm: f64,
) -> Option<String> {
    let first_descriptor =
        canonical_grid_structural_edge_descriptor(first_edge, first_edges, first_longest_edge_mm)?;
    let second_descriptor = canonical_grid_structural_edge_descriptor(
        second_edge,
        second_edges,
        second_longest_edge_mm,
    )?;
    Some(
        if cmp_js_code_units(&first_descriptor, &second_descriptor) != Ordering::Greater {
            format!("{first_descriptor}|{second_descriptor}")
        } else {
            format!("{second_descriptor}|{first_descriptor}")
        },
    )
}

/// TS source: `canonicalGridContact.ts:164-208` (`structuralEdgeDescriptor`).
fn canonical_grid_structural_edge_descriptor(
    edge: &CanonicalGridEdge,
    edges: &[CanonicalGridEdge],
    longest_edge_mm: f64,
) -> Option<String> {
    let len = edges.len();
    let previous = &edges[(edge.start_index + len - 1) % len];
    let next = &edges[(edge.start_index + 1) % len];
    let edge_length_mm = canonical_grid_edge_length_mm(edge)?;
    let previous_length_mm = canonical_grid_edge_length_mm(previous)?;
    let next_length_mm = canonical_grid_edge_length_mm(next)?;
    let start_turn_cosine = canonical_grid_turn_cosine(previous.start, edge.start, edge.end)?;
    let end_turn_cosine = canonical_grid_turn_cosine(edge.start, edge.end, next.end)?;

    let edge_ratio_key = ratio_signature_key(edge_length_mm, longest_edge_mm)?;
    let previous_ratio_key = ratio_signature_key(previous_length_mm, longest_edge_mm)?;
    let next_ratio_key = ratio_signature_key(next_length_mm, longest_edge_mm)?;
    let start_turn_key =
        js_math::round(start_turn_cosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE);
    let end_turn_key = js_math::round(end_turn_cosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE);
    if !is_safe_integer(start_turn_key) || !is_safe_integer(end_turn_key) {
        return None;
    }

    let first_endpoint = format!(
        "{}:{}",
        number_to_js_string(previous_ratio_key),
        number_to_js_string(start_turn_key)
    );
    let second_endpoint = format!(
        "{}:{}",
        number_to_js_string(next_ratio_key),
        number_to_js_string(end_turn_key)
    );
    let endpoint_pair = if cmp_js_code_units(&first_endpoint, &second_endpoint) != Ordering::Greater
    {
        format!("{first_endpoint}:{second_endpoint}")
    } else {
        format!("{second_endpoint}:{first_endpoint}")
    };
    Some(format!(
        "{}:{}",
        number_to_js_string(edge_ratio_key),
        endpoint_pair
    ))
}

/// TS source: `canonicalGridContact.ts:210-234` (`canonicalGridPathEdges`).
///
/// `checkpoint` mirrors the TS optional `(() => boolean) | undefined`
/// parameter: `None` here means "no checkpoint at all" (the two callers with
/// no checkpoint parameter in their own TS signature,
/// `hasPositiveCanonicalGridBoundaryContact`/`measureCanonicalGridBoundaryContact`,
/// always pass `None`), not "a checkpoint that always returns true."
fn canonical_grid_path_edges(
    path: &[CanonicalGridPoint],
    mut checkpoint: Option<&mut dyn FnMut() -> bool>,
) -> Option<Vec<CanonicalGridEdge>> {
    if path.len() < 3 {
        return None;
    }
    let mut edges = Vec::with_capacity(path.len());
    for index in 0..path.len() {
        if let Some(callback) = checkpoint.as_deref_mut() {
            if !callback() {
                return None;
            }
        }
        let start = path[index];
        let end = path[(index + 1) % path.len()];
        if !is_safe_integer(start.x)
            || !is_safe_integer(start.y)
            || !is_safe_integer(end.x)
            || !is_safe_integer(end.y)
            || (start.x == end.x && start.y == end.y)
        {
            return None;
        }
        edges.push(CanonicalGridEdge {
            start,
            end,
            start_index: index,
        });
    }
    Some(edges)
}

struct CanonicalGridCollinearOverlap {
    length_mm: f64,
}

/// TS source: `canonicalGridContact.ts:236-265` (`canonicalGridCollinearOverlap`).
fn canonical_grid_collinear_overlap(
    first: &CanonicalGridEdge,
    second: &CanonicalGridEdge,
) -> Option<CanonicalGridCollinearOverlap> {
    let axis_units = canonical_grid_collinear_overlap_axis_units(first, second)?;
    if axis_units <= BigInt::from(0) {
        return Some(CanonicalGridCollinearOverlap { length_mm: 0.0 });
    }

    let dx = grid_coordinate_to_bigint(first.end.x) - grid_coordinate_to_bigint(first.start.x);
    let dy = grid_coordinate_to_bigint(first.end.y) - grid_coordinate_to_bigint(first.start.y);
    let use_x = absolute_bigint(&dx) >= absolute_bigint(&dy);
    let first_axis_start =
        grid_coordinate_to_bigint(if use_x { first.start.x } else { first.start.y });
    let first_axis_end = grid_coordinate_to_bigint(if use_x { first.end.x } else { first.end.y });
    let first_axis_length = absolute_bigint(&(first_axis_end - first_axis_start));

    let edge_length_mm = canonical_grid_edge_length_mm(first)?;
    let overlap_axis_length = bigint_to_number(&axis_units);
    let axis_length = bigint_to_number(&first_axis_length);
    if !is_safe_integer(overlap_axis_length) || !is_safe_integer(axis_length) || axis_length <= 0.0
    {
        return None;
    }
    let length_mm = (overlap_axis_length * edge_length_mm) / axis_length;
    if length_mm.is_finite() && length_mm > 0.0 {
        Some(CanonicalGridCollinearOverlap { length_mm })
    } else {
        None
    }
}

/// TS source: `canonicalGridContact.ts:273-293`
/// (`canonicalGridCollinearOverlapAxisUnits`).
fn canonical_grid_collinear_overlap_axis_units(
    first: &CanonicalGridEdge,
    second: &CanonicalGridEdge,
) -> Option<BigInt> {
    let second_start_cross = canonical_grid_cross_sign(first.start, first.end, second.start)?;
    let second_end_cross = canonical_grid_cross_sign(first.start, first.end, second.end)?;
    if second_start_cross != 0 || second_end_cross != 0 {
        return Some(BigInt::from(0));
    }

    let dx = grid_coordinate_to_bigint(first.end.x) - grid_coordinate_to_bigint(first.start.x);
    let dy = grid_coordinate_to_bigint(first.end.y) - grid_coordinate_to_bigint(first.start.y);
    let use_x = absolute_bigint(&dx) >= absolute_bigint(&dy);
    let first_start = grid_coordinate_to_bigint(if use_x { first.start.x } else { first.start.y });
    let first_end = grid_coordinate_to_bigint(if use_x { first.end.x } else { first.end.y });
    let second_start = grid_coordinate_to_bigint(if use_x {
        second.start.x
    } else {
        second.start.y
    });
    let second_end = grid_coordinate_to_bigint(if use_x { second.end.x } else { second.end.y });

    let overlapping_axis_length = minimum_bigint(
        &maximum_bigint(&first_start, &first_end),
        &maximum_bigint(&second_start, &second_end),
    ) - maximum_bigint(
        &minimum_bigint(&first_start, &first_end),
        &minimum_bigint(&second_start, &second_end),
    );
    Some(if overlapping_axis_length > BigInt::from(0) {
        overlapping_axis_length
    } else {
        BigInt::from(0)
    })
}

/// Sums exact overlap units for positive axis-aligned contacts between two
/// canonical grid paths.
///
/// TS source: `canonicalGridContact.ts:302-337`
/// (`measureCanonicalGridBoundaryOverlapAxisUnits`).
///
/// The Short Side cancellation hook: `checkpoint` is invoked once per
/// path-construction step inside [`canonical_grid_path_edges`] (for both
/// `first` and `second`), then once immediately before evaluating each
/// outer-loop (`first_edges`) edge and once immediately before each
/// inner-loop (`second_edges`) edge inside the edge-pair scan below — this
/// exact placement (never mid-computation, never skipped) is the "cancellation
/// hook" the task calls out as unique to this function in the whole cluster.
pub fn measure_canonical_grid_boundary_overlap_axis_units(
    first: &[CanonicalGridPoint],
    second: &[CanonicalGridPoint],
    checkpoint: Option<&mut dyn FnMut() -> bool>,
) -> CanonicalGridBoundaryOverlapAxisUnitsResult {
    let aborted = Cell::new(false);
    let mut checkpoint = checkpoint;
    let mut checked = || -> bool {
        match checkpoint.as_deref_mut() {
            None => true,
            Some(callback) => {
                if callback() {
                    true
                } else {
                    aborted.set(true);
                    false
                }
            }
        }
    };

    let Some(first_edges) = canonical_grid_path_edges(first, Some(&mut checked)) else {
        return if aborted.get() {
            CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted
        } else {
            CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable
        };
    };
    let Some(second_edges) = canonical_grid_path_edges(second, Some(&mut checked)) else {
        return if aborted.get() {
            CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted
        } else {
            CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable
        };
    };

    let mut total = BigInt::from(0);
    for first_edge in &first_edges {
        if !checked() {
            return CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted;
        }
        for second_edge in &second_edges {
            if !checked() {
                return CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted;
            }
            let Some(axis_units) =
                canonical_grid_collinear_overlap_axis_units(first_edge, second_edge)
            else {
                return CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable;
            };
            if axis_units > BigInt::from(0) {
                let dx = grid_coordinate_to_bigint(first_edge.end.x)
                    - grid_coordinate_to_bigint(first_edge.start.x);
                let dy = grid_coordinate_to_bigint(first_edge.end.y)
                    - grid_coordinate_to_bigint(first_edge.start.y);
                if dx != BigInt::from(0) && dy != BigInt::from(0) {
                    return CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable;
                }
            }
            total += axis_units;
        }
    }
    CanonicalGridBoundaryOverlapAxisUnitsResult::Measured { score: total }
}

/// TS source: `canonicalGridContact.ts:339-347` (`longestCanonicalGridEdgeLength`).
fn longest_canonical_grid_edge_length(edges: &[CanonicalGridEdge]) -> Option<f64> {
    let mut longest_edge_length_mm = 0.0;
    for edge in edges {
        let edge_length_mm = canonical_grid_edge_length_mm(edge)?;
        longest_edge_length_mm = js_math::max(longest_edge_length_mm, edge_length_mm);
    }
    if longest_edge_length_mm > 0.0 {
        Some(longest_edge_length_mm)
    } else {
        None
    }
}

/// TS source: `canonicalGridContact.ts:349-354` (`canonicalGridEdgeLengthMm`).
///
/// The semantic distance routes through [`js_math::hypot`] so production
/// geometry and scoring share one audited standard-library boundary.
/// `length_mm` feeds `ratio_signature_key`'s rounded ratio key inside
/// [`canonical_grid_structural_edge_descriptor`], then contributes to
/// structural-contact signatures, score tie-break fields, and serialized
/// metrics. Final legality, quality, and deterministic output are blocking;
/// any Node/V8 ULP difference is diagnostic.
fn canonical_grid_edge_length_mm(edge: &CanonicalGridEdge) -> Option<f64> {
    let dx = edge.end.x - edge.start.x;
    let dy = edge.end.y - edge.start.y;
    let length_mm = js_math::hypot(dx, dy) / 1_000.0;
    if length_mm.is_finite() && length_mm > 0.0 {
        Some(length_mm)
    } else {
        None
    }
}

/// TS source: `canonicalGridContact.ts:356-369` (`turnCosine`).
///
/// The semantic turn metric routes through [`js_math::hypot`] so canonical
/// geometry and scoring share one audited standard-library boundary. The
/// resulting `cosine` is rounded into `start_turn_key`/`end_turn_key` inside
/// [`canonical_grid_structural_edge_descriptor`] and contributes to the same
/// structural-contact signatures and serialized metrics. Final legality,
/// quality, and deterministic output are blocking; Node/V8 ULP differences
/// are diagnostic.
fn canonical_grid_turn_cosine(
    previous: CanonicalGridPoint,
    vertex: CanonicalGridPoint,
    next: CanonicalGridPoint,
) -> Option<f64> {
    let previous_x = previous.x - vertex.x;
    let previous_y = previous.y - vertex.y;
    let next_x = next.x - vertex.x;
    let next_y = next.y - vertex.y;
    let denominator = js_math::hypot(previous_x, previous_y) * js_math::hypot(next_x, next_y);
    if !denominator.is_finite() || denominator <= 0.0 {
        return None;
    }
    let cosine = (previous_x * next_x + previous_y * next_y) / denominator;
    if cosine.is_finite() {
        Some(js_math::max(-1.0, js_math::min(1.0, cosine)))
    } else {
        None
    }
}

/// TS source: `canonicalGridContact.ts:371-374` (`ratioSignatureKey`), also
/// reused verbatim by the convex counterpart below (TS declares it twice,
/// textually identical; kept as one function here since it depends on
/// nothing edge-type-specific).
fn ratio_signature_key(value: f64, longest_edge_mm: f64) -> Option<f64> {
    let key = js_math::round((value / longest_edge_mm) * STRUCTURAL_CONTACT_RATIO_SIGNATURE_SCALE);
    if is_safe_integer(key) {
        Some(key)
    } else {
        None
    }
}

// ===========================================================================
// convexPolygonContact.ts
// ===========================================================================

/// TS source: `convexPolygonContact.ts:6-11`
/// (`SharedConvexPolygonBoundaryContact`). Same field-typing convention as
/// [`CanonicalGridBoundaryContact`] above.
#[derive(Debug, Clone, PartialEq)]
pub struct SharedConvexPolygonBoundaryContact {
    pub length_mm: f64,
    pub normalized_units: f64,
    pub near_complete_structural_contact_count: f64,
    pub near_complete_structural_contact_signatures: Vec<String>,
}

/// TS source: `convexPolygonContact.ts:14-20`
/// (`SharedConvexPolygonBoundarySegment`). `first_edge_index`/
/// `second_edge_index` mirror the TS `number` index fields as `f64`, matching
/// `crate::domain::IrregularTransformCandidate::index`'s established
/// "every TS `number` field is `f64`" convention for a field that is
/// conceptually an array index.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SharedConvexPolygonBoundarySegment {
    pub first_edge_index: f64,
    pub second_edge_index: f64,
    pub start: IrregularPoint,
    pub end: IrregularPoint,
    pub length_mm: f64,
}

/// TS source: `convexPolygonContact.ts:242-246` (`PolygonEdge`).
#[derive(Debug, Clone, Copy)]
struct PolygonEdge {
    start: IrregularPoint,
    end: IrregularPoint,
    start_index: usize,
}

/// TS source: `convexPolygonContact.ts:28-36`
/// (`sharedConvexPolygonBoundaryLength`).
pub fn shared_convex_polygon_boundary_length(
    first: &IrregularPolygonWithBounds,
    second: &IrregularPolygonWithBounds,
) -> Option<f64> {
    let segments = shared_convex_polygon_boundary_segments(first, second)?;
    // R11: serial left-to-right float fold, matching `segments.reduce((sum,
    // segment) => sum + segment.lengthMm, 0)` (`convexPolygonContact.ts:34`).
    let total_length = segments
        .iter()
        .fold(0.0_f64, |sum, segment| sum + segment.length_mm);
    if total_length.is_finite() {
        Some(total_length)
    } else {
        None
    }
}

/// TS source: `convexPolygonContact.ts:39-60`
/// (`sharedConvexPolygonBoundarySegments`).
pub fn shared_convex_polygon_boundary_segments(
    first: &IrregularPolygonWithBounds,
    second: &IrregularPolygonWithBounds,
) -> Option<Vec<SharedConvexPolygonBoundarySegment>> {
    if are_disjoint(&first.bounds, &second.bounds) {
        return Some(Vec::new());
    }

    let mut segments = Vec::new();
    for first_edge in polygon_edges(&first.polygon.points) {
        for second_edge in polygon_edges(&second.polygon.points) {
            let overlap = collinear_overlap_segment(&first_edge, &second_edge)?;
            if overlap.length_mm > 0.0 {
                segments.push(SharedConvexPolygonBoundarySegment {
                    first_edge_index: first_edge.start_index as f64,
                    second_edge_index: second_edge.start_index as f64,
                    start: overlap.start,
                    end: overlap.end,
                    length_mm: overlap.length_mm,
                });
            }
        }
    }
    Some(segments)
}

/// TS source: `convexPolygonContact.ts:67-102`
/// (`measureSharedConvexPolygonBoundaryContact`).
pub fn measure_shared_convex_polygon_boundary_contact(
    first: &IrregularPolygonWithBounds,
    second: &IrregularPolygonWithBounds,
) -> Option<SharedConvexPolygonBoundaryContact> {
    let length_mm = shared_convex_polygon_boundary_length(first, second)?;
    if length_mm == 0.0 {
        return Some(SharedConvexPolygonBoundaryContact {
            length_mm: 0.0,
            normalized_units: 0.0,
            near_complete_structural_contact_count: 0.0,
            near_complete_structural_contact_signatures: Vec::new(),
        });
    }

    let first_longest_edge_mm = longest_polygon_edge_length(&first.polygon.points)?;
    let second_longest_edge_mm = longest_polygon_edge_length(&second.polygon.points)?;
    let normalization_length_mm = js_math::min(first_longest_edge_mm, second_longest_edge_mm);
    let normalized_units = length_mm / normalization_length_mm;
    if !normalized_units.is_finite() || normalized_units < 0.0 {
        return None;
    }

    let signatures = derive_near_complete_structural_contact_signatures_convex(
        &first.polygon.points,
        &second.polygon.points,
        first_longest_edge_mm,
        second_longest_edge_mm,
    )?;
    Some(SharedConvexPolygonBoundaryContact {
        length_mm,
        normalized_units,
        near_complete_structural_contact_count: signatures.len() as f64,
        near_complete_structural_contact_signatures: signatures,
    })
}

/// TS source: `convexPolygonContact.ts:104-139`
/// (`deriveNearCompleteStructuralContactSignatures`).
fn derive_near_complete_structural_contact_signatures_convex(
    first_points: &[IrregularPoint],
    second_points: &[IrregularPoint],
    first_longest_edge_mm: f64,
    second_longest_edge_mm: f64,
) -> Option<Vec<String>> {
    let mut signatures = Vec::new();
    for first_edge in polygon_edges(first_points) {
        let first_edge_length_mm = polygon_edge_length(&first_edge)?;
        if first_edge_length_mm < first_longest_edge_mm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO {
            continue;
        }
        for second_edge in polygon_edges(second_points) {
            let second_edge_length_mm = polygon_edge_length(&second_edge)?;
            if second_edge_length_mm < second_longest_edge_mm * MIN_STRUCTURAL_EDGE_LENGTH_RATIO {
                continue;
            }
            let overlap_length_mm = collinear_overlap_length(&first_edge, &second_edge)?;
            let shorter_edge_length_mm = js_math::min(first_edge_length_mm, second_edge_length_mm);
            if overlap_length_mm >= shorter_edge_length_mm * MIN_NEAR_COMPLETE_EDGE_OVERLAP_RATIO {
                let signature = convex_structural_contact_signature(
                    &first_edge,
                    &second_edge,
                    first_points,
                    second_points,
                    first_longest_edge_mm,
                    second_longest_edge_mm,
                )?;
                signatures.push(signature);
            }
        }
    }
    Some(signatures)
}

/// TS source: `convexPolygonContact.ts:141-164` (`structuralContactSignature`).
fn convex_structural_contact_signature(
    first_edge: &PolygonEdge,
    second_edge: &PolygonEdge,
    first_points: &[IrregularPoint],
    second_points: &[IrregularPoint],
    first_longest_edge_mm: f64,
    second_longest_edge_mm: f64,
) -> Option<String> {
    let first_descriptor =
        convex_structural_edge_descriptor(first_edge, first_points, first_longest_edge_mm)?;
    let second_descriptor =
        convex_structural_edge_descriptor(second_edge, second_points, second_longest_edge_mm)?;
    Some(
        if cmp_js_code_units(&first_descriptor, &second_descriptor) != Ordering::Greater {
            format!("{first_descriptor}|{second_descriptor}")
        } else {
            format!("{second_descriptor}|{first_descriptor}")
        },
    )
}

/// TS source: `convexPolygonContact.ts:166-212` (`structuralEdgeDescriptor`).
///
/// Note the `+2` (not `+1`) offset for `nextPoint`: `points` indexes
/// vertices, not edges, so the point after this edge's own end vertex is two
/// positions ahead of the edge's `startIndex` (`edge.end` is already
/// `points[startIndex+1]`) — deliberately different indexing from the
/// canonical-grid counterpart's `edges[(edge.startIndex + 1) %
/// edges.length]`, which indexes an edges array instead. Preserved exactly,
/// not "fixed" to match the other file.
fn convex_structural_edge_descriptor(
    edge: &PolygonEdge,
    points: &[IrregularPoint],
    longest_edge_mm: f64,
) -> Option<String> {
    let len = points.len();
    let previous_point = points[(edge.start_index + len - 1) % len];
    let next_point = points[(edge.start_index + 2) % len];
    let edge_length_mm = polygon_edge_length(edge)?;
    let previous_length_mm = point_distance(previous_point, edge.start)?;
    let next_length_mm = point_distance(edge.end, next_point)?;
    let start_turn_cosine = convex_turn_cosine(previous_point, edge.start, edge.end)?;
    let end_turn_cosine = convex_turn_cosine(edge.start, edge.end, next_point)?;

    let edge_ratio_key = ratio_signature_key(edge_length_mm, longest_edge_mm)?;
    let previous_ratio_key = ratio_signature_key(previous_length_mm, longest_edge_mm)?;
    let next_ratio_key = ratio_signature_key(next_length_mm, longest_edge_mm)?;
    let start_turn_key =
        js_math::round(start_turn_cosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE);
    let end_turn_key = js_math::round(end_turn_cosine * STRUCTURAL_CONTACT_TURN_SIGNATURE_SCALE);
    if !is_safe_integer(start_turn_key) || !is_safe_integer(end_turn_key) {
        return None;
    }

    let first_endpoint = format!(
        "{}:{}",
        number_to_js_string(previous_ratio_key),
        number_to_js_string(start_turn_key)
    );
    let second_endpoint = format!(
        "{}:{}",
        number_to_js_string(next_ratio_key),
        number_to_js_string(end_turn_key)
    );
    let endpoint_pair = if cmp_js_code_units(&first_endpoint, &second_endpoint) != Ordering::Greater
    {
        format!("{first_endpoint}:{second_endpoint}")
    } else {
        format!("{second_endpoint}:{first_endpoint}")
    };
    Some(format!(
        "{}:{}",
        number_to_js_string(edge_ratio_key),
        endpoint_pair
    ))
}

/// TS source: `convexPolygonContact.ts:248-257` (`polygonEdges`).
///
/// The TS `start === undefined || end === undefined` guard
/// (`convexPolygonContact.ts:253`) is unreachable dead code: both indices
/// (`index` and `(index + 1) % points.length`) are always in bounds whenever
/// the loop body runs at all. No equivalent guard is expressible (or needed)
/// against a Rust slice — same precedent as
/// `canonical_grid::math::canonical_grid_convex_hull`'s `build_half` closure.
fn polygon_edges(points: &[IrregularPoint]) -> Vec<PolygonEdge> {
    let len = points.len();
    let mut edges = Vec::with_capacity(len);
    for index in 0..len {
        let start = points[index];
        let end = points[(index + 1) % len];
        edges.push(PolygonEdge {
            start,
            end,
            start_index: index,
        });
    }
    edges
}

/// TS source: `convexPolygonContact.ts:259-267` (`longestPolygonEdgeLength`).
fn longest_polygon_edge_length(points: &[IrregularPoint]) -> Option<f64> {
    let mut longest_edge_length = 0.0;
    for edge in polygon_edges(points) {
        let edge_length = polygon_edge_length(&edge)?;
        longest_edge_length = js_math::max(longest_edge_length, edge_length);
    }
    if longest_edge_length > 0.0 {
        Some(longest_edge_length)
    } else {
        None
    }
}

/// TS source: `convexPolygonContact.ts:269-272` (`polygonEdgeLength`).
///
/// N2 audit: routed through [`js_math::hypot`] — `edge_length` feeds
/// `longest_polygon_edge_length` and [`convex_structural_edge_descriptor`],
/// which builds the structural-contact signature strings; see
/// [`collinear_overlap_segment`]'s doc comment for the full reachability
/// chain to `compare_local_scores`/serialized result DTOs.
fn polygon_edge_length(edge: &PolygonEdge) -> Option<f64> {
    let edge_length = js_math::hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y);
    if edge_length.is_finite() && edge_length > 0.0 {
        Some(edge_length)
    } else {
        None
    }
}

/// TS source: `convexPolygonContact.ts:219-222` (`pointDistance`).
///
/// N2 audit: routed through [`js_math::hypot`] — `distance` feeds
/// [`convex_structural_edge_descriptor`]'s `previous_length_mm`/
/// `next_length_mm`, part of the same signature-string chain
/// [`polygon_edge_length`]'s doc comment documents.
fn point_distance(first: IrregularPoint, second: IrregularPoint) -> Option<f64> {
    let distance = js_math::hypot(second.x - first.x, second.y - first.y);
    if distance.is_finite() && distance > 0.0 {
        Some(distance)
    } else {
        None
    }
}

/// TS source: `convexPolygonContact.ts:224-240` (`turnCosine`).
///
/// N2 audit: routed through [`js_math::hypot`] — `previous_length`/
/// `next_length` feed `cosine`, rounded into
/// [`convex_structural_edge_descriptor`]'s `start_turn_key`/`end_turn_key`,
/// part of the same signature-string chain [`polygon_edge_length`]'s doc
/// comment documents.
fn convex_turn_cosine(
    previous: IrregularPoint,
    vertex: IrregularPoint,
    next: IrregularPoint,
) -> Option<f64> {
    let previous_x = previous.x - vertex.x;
    let previous_y = previous.y - vertex.y;
    let next_x = next.x - vertex.x;
    let next_y = next.y - vertex.y;
    let previous_length = js_math::hypot(previous_x, previous_y);
    let next_length = js_math::hypot(next_x, next_y);
    let denominator = previous_length * next_length;
    if !denominator.is_finite() || denominator <= 0.0 {
        return None;
    }
    let cosine = (previous_x * next_x + previous_y * next_y) / denominator;
    if cosine.is_finite() {
        Some(js_math::max(-1.0, js_math::min(1.0, cosine)))
    } else {
        None
    }
}

struct CollinearOverlapSegment {
    start: IrregularPoint,
    end: IrregularPoint,
    length_mm: f64,
}

/// TS source: `convexPolygonContact.ts:274-276` (`collinearOverlapLength`).
fn collinear_overlap_length(first: &PolygonEdge, second: &PolygonEdge) -> Option<f64> {
    collinear_overlap_segment(first, second).map(|segment| segment.length_mm)
}

/// TS source: `convexPolygonContact.ts:278-319` (`collinearOverlapSegment`).
///
/// The **only** predicate-driven (not exact-BigInt) collinearity test in
/// this cluster: uses [`orientation`] (adaptive-precision `orient2d`) rather
/// than [`canonical_grid_cross_sign`] — this is the "source geometry" side of
/// the migration prompt's §8.3 division of responsibility, operating on
/// already-translated floating-mm convex polygons, never on canonical-grid
/// integers.
///
/// The `edge_length` value routes through [`js_math::hypot`] so shared
/// boundary metrics use the same audited standard-library boundary as the
/// rest of production geometry and scoring. The value feeds
/// `shared_convex_polygon_boundary_length` and the
/// `compare_local_scores` tie-break chain. Final legality, quality, and
/// deterministic output are blocking; Node/V8 ULP differences are
/// diagnostic.
fn collinear_overlap_segment(
    first: &PolygonEdge,
    second: &PolygonEdge,
) -> Option<CollinearOverlapSegment> {
    if orientation(
        first.start.x,
        first.start.y,
        first.end.x,
        first.end.y,
        second.start.x,
        second.start.y,
    ) != 0
        || orientation(
            first.start.x,
            first.start.y,
            first.end.x,
            first.end.y,
            second.end.x,
            second.end.y,
        ) != 0
    {
        return Some(CollinearOverlapSegment {
            start: first.start,
            end: first.start,
            length_mm: 0.0,
        });
    }

    let dx = first.end.x - first.start.x;
    let dy = first.end.y - first.start.y;
    let edge_length = js_math::hypot(dx, dy);
    if !edge_length.is_finite() || edge_length <= 0.0 {
        return None;
    }

    let use_x = dx.abs() >= dy.abs();
    let first_start = if use_x { first.start.x } else { first.start.y };
    let first_end = if use_x { first.end.x } else { first.end.y };
    let second_start = if use_x {
        second.start.x
    } else {
        second.start.y
    };
    let second_end = if use_x { second.end.x } else { second.end.y };
    let overlapping_axis_length = js_math::min(
        js_math::max(first_start, first_end),
        js_math::max(second_start, second_end),
    ) - js_math::max(
        js_math::min(first_start, first_end),
        js_math::min(second_start, second_end),
    );
    if !overlapping_axis_length.is_finite() || overlapping_axis_length <= 0.0 {
        return Some(CollinearOverlapSegment {
            start: first.start,
            end: first.start,
            length_mm: 0.0,
        });
    }

    let first_axis_length = (first_end - first_start).abs();
    if !first_axis_length.is_finite() || first_axis_length <= 0.0 {
        return None;
    }
    let overlap_length = (overlapping_axis_length * edge_length) / first_axis_length;
    if !overlap_length.is_finite() {
        return None;
    }

    let axis_value = |point: IrregularPoint| if use_x { point.x } else { point.y };
    let lower = js_math::max(
        js_math::min(first_start, first_end),
        js_math::min(second_start, second_end),
    );
    let upper = js_math::min(
        js_math::max(first_start, first_end),
        js_math::max(second_start, second_end),
    );
    let endpoints = [first.start, first.end, second.start, second.end];
    let start = endpoints
        .iter()
        .find(|point| axis_value(**point) == lower)
        .copied();
    let end = endpoints
        .iter()
        .find(|point| axis_value(**point) == upper)
        .copied();
    match (start, end) {
        (Some(start), Some(end)) => Some(CollinearOverlapSegment {
            start,
            end,
            length_mm: overlap_length,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(x: f64, y: f64) -> CanonicalGridPoint {
        CanonicalGridPoint::new(x, y)
    }

    #[test]
    fn has_positive_contact_detects_a_shared_edge() {
        let square_a = vec![
            grid(0.0, 0.0),
            grid(1_000.0, 0.0),
            grid(1_000.0, 1_000.0),
            grid(0.0, 1_000.0),
        ];
        let square_b = vec![
            grid(1_000.0, 0.0),
            grid(2_000.0, 0.0),
            grid(2_000.0, 1_000.0),
            grid(1_000.0, 1_000.0),
        ];
        assert_eq!(
            has_positive_canonical_grid_boundary_contact(&square_a, &square_b),
            Some(true)
        );
    }

    #[test]
    fn has_positive_contact_false_when_disjoint() {
        let square_a = vec![
            grid(0.0, 0.0),
            grid(1_000.0, 0.0),
            grid(1_000.0, 1_000.0),
            grid(0.0, 1_000.0),
        ];
        let square_b = vec![
            grid(5_000.0, 5_000.0),
            grid(6_000.0, 5_000.0),
            grid(6_000.0, 6_000.0),
            grid(5_000.0, 6_000.0),
        ];
        assert_eq!(
            has_positive_canonical_grid_boundary_contact(&square_a, &square_b),
            Some(false)
        );
    }

    #[test]
    fn measure_boundary_contact_zero_case_returns_fully_populated_sentinel() {
        let square_a = vec![
            grid(0.0, 0.0),
            grid(1_000.0, 0.0),
            grid(1_000.0, 1_000.0),
            grid(0.0, 1_000.0),
        ];
        let square_b = vec![
            grid(5_000.0, 5_000.0),
            grid(6_000.0, 5_000.0),
            grid(6_000.0, 6_000.0),
            grid(5_000.0, 6_000.0),
        ];
        let contact = measure_canonical_grid_boundary_contact(&square_a, &square_b)
            .expect("valid paths always produce a defined contact result");
        assert_eq!(
            contact,
            CanonicalGridBoundaryContact {
                length_mm: 0.0,
                normalized_units: 0.0,
                near_complete_structural_contact_count: 0.0,
                near_complete_structural_contact_signatures: Vec::new(),
            }
        );
    }

    #[test]
    fn measure_boundary_contact_matches_full_edge_overlap() {
        let square_a = vec![
            grid(0.0, 0.0),
            grid(1_000.0, 0.0),
            grid(1_000.0, 1_000.0),
            grid(0.0, 1_000.0),
        ];
        let square_b = vec![
            grid(1_000.0, 0.0),
            grid(2_000.0, 0.0),
            grid(2_000.0, 1_000.0),
            grid(1_000.0, 1_000.0),
        ];
        let contact = measure_canonical_grid_boundary_contact(&square_a, &square_b)
            .expect("touching squares produce a defined contact result");
        assert_eq!(contact.length_mm, 1.0);
        assert_eq!(contact.normalized_units, 1.0);
        assert_eq!(contact.near_complete_structural_contact_count, 1.0);
        assert_eq!(contact.near_complete_structural_contact_signatures.len(), 1);
    }

    #[test]
    fn axis_units_measures_axis_aligned_positive_contact_exactly() {
        // Mirrors `tests/unit/canonicalGridContact.test.ts`'s
        // "measures an axis-aligned positive contact exactly".
        let first = vec![grid(0.0, 0.0), grid(1_000.0, 0.0), grid(0.0, 1_000.0)];
        let second = vec![grid(1_000.0, 0.0), grid(0.0, 0.0), grid(1_000.0, -1_000.0)];
        let result = measure_canonical_grid_boundary_overlap_axis_units(&first, &second, None);
        assert_eq!(
            result,
            CanonicalGridBoundaryOverlapAxisUnitsResult::Measured {
                score: BigInt::from(1_000)
            }
        );
    }

    #[test]
    fn axis_units_is_undecidable_for_positive_diagonal_contact() {
        // Mirrors `tests/unit/canonicalGridContact.test.ts`'s
        // "preserves the historical caller decision for positive diagonal
        // contact".
        let first = vec![grid(0.0, 0.0), grid(800.0, 800.0), grid(0.0, 1_600.0)];
        let second = vec![grid(800.0, 800.0), grid(0.0, 0.0), grid(1_600.0, 0.0)];
        let result = measure_canonical_grid_boundary_overlap_axis_units(&first, &second, None);
        assert_eq!(
            result,
            CanonicalGridBoundaryOverlapAxisUnitsResult::Undecidable
        );
    }

    #[test]
    fn axis_units_aborts_when_checkpoint_expires_mid_scan() {
        let octagon_first: Vec<CanonicalGridPoint> = vec![
            grid(0.0, 0.0),
            grid(1_000.0, 0.0),
            grid(2_000.0, 1_000.0),
            grid(2_000.0, 2_000.0),
            grid(1_000.0, 3_000.0),
            grid(0.0, 3_000.0),
            grid(-1_000.0, 2_000.0),
            grid(-1_000.0, 1_000.0),
        ];
        let octagon_second: Vec<CanonicalGridPoint> = octagon_first
            .iter()
            .map(|point| grid(point.x + 10_000.0, point.y))
            .collect();
        let path_construction_checks = octagon_first.len() + octagon_second.len();
        let mut checks = 0usize;
        let mut checkpoint = move || {
            checks += 1;
            checks <= path_construction_checks + 5
        };
        let result = measure_canonical_grid_boundary_overlap_axis_units(
            &octagon_first,
            &octagon_second,
            Some(&mut checkpoint),
        );
        assert_eq!(result, CanonicalGridBoundaryOverlapAxisUnitsResult::Aborted);
    }

    fn poly_with_bounds(points: Vec<IrregularPoint>) -> IrregularPolygonWithBounds {
        let bounds = crate::geometry::convex::bounds_for_points(&points)
            .expect("finite points always produce bounds in these tests");
        IrregularPolygonWithBounds {
            polygon: crate::domain::IrregularPolygon::new(points),
            bounds,
        }
    }

    fn point(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    #[test]
    fn shared_convex_boundary_segments_empty_when_bounds_disjoint() {
        let a = poly_with_bounds(vec![
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 1.0),
            point(0.0, 1.0),
        ]);
        let b = poly_with_bounds(vec![
            point(10.0, 10.0),
            point(11.0, 10.0),
            point(11.0, 11.0),
            point(10.0, 11.0),
        ]);
        assert_eq!(
            shared_convex_polygon_boundary_segments(&a, &b),
            Some(Vec::new())
        );
    }

    #[test]
    fn shared_convex_boundary_length_matches_full_edge_overlap() {
        let a = poly_with_bounds(vec![
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 1.0),
            point(0.0, 1.0),
        ]);
        let b = poly_with_bounds(vec![
            point(1.0, 0.0),
            point(2.0, 0.0),
            point(2.0, 1.0),
            point(1.0, 1.0),
        ]);
        assert_eq!(shared_convex_polygon_boundary_length(&a, &b), Some(1.0));
        let contact = measure_shared_convex_polygon_boundary_contact(&a, &b)
            .expect("touching squares produce a defined contact result");
        assert_eq!(contact.length_mm, 1.0);
        assert_eq!(contact.normalized_units, 1.0);
        assert_eq!(contact.near_complete_structural_contact_count, 1.0);
    }

    #[test]
    fn measure_shared_convex_boundary_contact_zero_case_returns_fully_populated_sentinel() {
        let a = poly_with_bounds(vec![
            point(0.0, 0.0),
            point(1.0, 0.0),
            point(1.0, 1.0),
            point(0.0, 1.0),
        ]);
        let b = poly_with_bounds(vec![
            point(10.0, 10.0),
            point(11.0, 10.0),
            point(11.0, 11.0),
            point(10.0, 11.0),
        ]);
        let contact = measure_shared_convex_polygon_boundary_contact(&a, &b)
            .expect("disjoint polygons still produce a defined zero-contact result");
        assert_eq!(
            contact,
            SharedConvexPolygonBoundaryContact {
                length_mm: 0.0,
                normalized_units: 0.0,
                near_complete_structural_contact_count: 0.0,
                near_complete_structural_contact_signatures: Vec::new(),
            }
        );
    }
}
