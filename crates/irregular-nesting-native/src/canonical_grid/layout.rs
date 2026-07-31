//! Canonical collision-layout geometry: the identity/legality/topology/
//! contact/envelope authority for a placed-piece layout on the 0.001 mm
//! grid.
//!
//! TS source ported here in full: `src/workers/irregular/
//! canonicalLayoutGeometry.ts` (888 lines).
//!
//! Grounding source: `docs/planning/rust-irregular-backend/characterization/
//! canonical-grid.md` (this cluster's Stage 0 characterization; §1-§2
//! document this file's production-liveness and exported-symbol call graph
//! in full — it is "the most widely depended-on file in the cluster") and
//! `docs/planning/rust-irregular-backend/stage0-rulings.md`.
//!
//! # Reused (GREEN) modules — never duplicated here
//!
//! - `super::{math}` re-exports (`canonical_grid_absolute_doubled_area`,
//!   `canonical_grid_convex_hull`, `canonical_grid_counter_clockwise`,
//!   `canonical_grid_signed_doubled_area`, `canonical_grid_compare_bigints`,
//!   `doubled_grid_area_to_mm2`) — the exact BigInt/Number dual-path
//!   primitives this file's TS counterpart imports from
//!   `canonicalGridMath.ts`.
//! - `super::{offset_policy}` re-exports (`to_grid_mm`, `from_grid`) — the
//!   TS counterpart's `clipper2OffsetPolicy.ts` import.
//! - `super::contact::{has_positive_canonical_grid_boundary_contact,
//!   measure_canonical_grid_boundary_contact}` — the TS counterpart's
//!   `canonicalGridContact.ts` import (this task's sibling assignment,
//!   [`crate::canonical_grid::contact`]).
//! - `crate::clipper::engine::{boolean_op_with_poly_tree, poly_tree_to_paths64,
//!   PolyTree64}` and `crate::clipper::core::{ClipType, FillRule, Path64,
//!   Paths64, Point64}` — the vendored Clipper2 port (ruling R10) this file's
//!   TS counterpart calls directly (`booleanOpWithPolyTree`, `ClipType`,
//!   `FillRule`, `Path64`, `PolyPath64`, `polyTreeToPaths64`, `PolyTree64`).
//! - `crate::checkpoints::canonical_json::locale_compare_keys` — the
//!   collator-equivalent ruling R8 requires for every `String.prototype
//!   .localeCompare` call site (`comparePiecePairs`,
//!   `measureCanonicalLayoutContacts`'s polygon-processing sort,
//!   `contactComponents`'s final tie-break).
//! - `crate::js_number::{cmp_js_code_units, fold_negative_zero, js_math,
//!   number_to_js_string}` — every raw `<`/default-`.toSorted()`/`Math.min`
//!   /`Math.max`/`Number.prototype.toString()` call site in this file routes
//!   through these per ruling R8/the JS-semantics audit.
//!
//! # `booleanOpWithPolyTree`'s TS `try`/`catch` has no Rust equivalent
//!
//! Every `try { booleanOpWithPolyTree(...) } catch { return <sentinel> }`
//! and `try { child = parent.child(index) } catch { return <sentinel> }` in
//! the TS source is dropped here with no `Result`/`catch_unwind` wrapper,
//! for exactly the reason `crate::geometry::free_material`'s module doc
//! already establishes for the same vendored engine call: `crate::clipper::
//! engine`'s own module doc proves "every exception TS could throw from
//! `executeInternal`/`buildPaths` in the reachable (closed-paths-only)
//! subset is unreachable dead code in this port," and `PolyTree64::child`'s
//! own doc proves its "index out of range" throw is unreachable given every
//! caller here (like every caller in the TS source) iterates
//! `0..count`/`0..parent.count`. This is not a new judgment call by this
//! file; it is the same simplification already established and reused
//! verbatim.
//!
//! # `canonicalCollisionLayoutIdentity` — the existential byte-exactness hazard
//!
//! [`canonical_collision_layout_identity`] produces the **direct UTF-8
//! preimage** of the production SHA-256 collision identity
//! (`intrinsicCapacityEndpoint.ts:190`: `createHash('sha256').update(identity)
//! .digest('hex')`, Node's default string-to-bytes encoding is `'utf8'`).
//! Every ordering/formatting rule below is directly load-bearing for that
//! hash:
//! - [`identity_at_quarter_turn`] computes one candidate identity string per
//!   quarter-turn rotation (`0/90/180/270`, exact integer rotation via
//!   [`rotate_grid_point`] — no floating trig), each internally winding-
//!   *and* ring-origin-normalized by [`canonical_ring`]/
//!   [`canonical_ring_direction`]'s `O(n²)` minimal-rotation search (raw
//!   code-unit `<`, not `localeCompare` — see `canonical-grid.md` §6), then
//!   piece-order-normalized by a **default** (code-unit) sort of the
//!   per-path ring keys, then encoded as a compact `JSON.stringify` array of
//!   strings (see [`json_stringify_string_array`]).
//! - [`canonical_collision_layout_identity`] itself picks the code-unit-
//!   lexicographically **smallest** of the 4 per-rotation strings — the
//!   quarter-turn equivalence rule.
//! - **Dead-code finding preserved by proof, not by re-deriving it inline**
//!   (`canonical-grid.md` §8/§15 item 3): TS's `identityAtQuarterTurn`
//!   declares `string | undefined` but every return path is a `string`
//!   (`'[]'` for the empty-input case, otherwise the `JSON.stringify`
//!   result), so `canonicalCollisionLayoutIdentity`'s `.some(id => id ===
//!   undefined)` guard can never be `true`. [`identity_at_quarter_turn`]
//!   therefore returns a plain `String` (not `Option<String>`), and
//!   [`canonical_collision_layout_identity`] omits the now-untypeable dead
//!   guard — cited here per the migration prompt's standard for omitting a
//!   *proven*-unreachable branch rather than silently deleting it.
//!
//! # The `-0` fold (`placedCollisionWorldGridPath`, TS `:100-101`)
//!
//! `x === 0 ? 0 : x` is reproduced via [`crate::js_number::fold_negative_zero`]
//! — that function's own doc comment names this exact TS call site.
//!
//! # `largestHullGapRegion`'s three-state return (R3 dead-code/tri-state note)
//!
//! Per `canonical-grid.md` §3: the internal producer has a genuine
//! **three-state** result (`found` / `not found` / `computation failed`),
//! collapsed to a two-state `Option<GapRegion>` only at
//! [`analyze_canonical_layout_structure`]'s boundary. Modeled here exactly
//! as that document recommends: `Option<Option<LargestHullGapRegion>>`,
//! outer `None` == TS `null` (failure), inner `None` == TS `undefined` (no
//! gap region found), `Some(Some(_))` == TS's object payload.
//!
//! # Serial left-to-right float folds (R11)
//!
//! Every plain `Number` (not BigInt) accumulation this file performs
//! (`measureCanonicalLayoutContacts`'s `sharedBoundaryLengthMm +=`/
//! `contactUnits +=`/`totalStructuralContacts +=`) is reproduced as a plain
//! mutable accumulator inside the *exact* nested-loop discovery order the TS
//! source uses (outer index ascending, inner index `< outer` ascending —
//! the "lower triangle, row-major" unordered-pair enumeration used
//! consistently across this whole cluster), never a `Vec::iter().sum()` or
//! any other order that could silently reassociate the float sum.
//!
//! This module's own differential vectors live in
//! `tests/vectors/canonical-layout.json` (generated by
//! `scripts/rust-parity/dump-canonical-layout.ts`), shared with
//! [`crate::canonical_grid::contact`] per that module's own doc comment.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use num_bigint::BigInt;
use serde::Serialize;

use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::clipper::core::{
    bigint_to_number, f64_to_bigint, ClipType, FillRule, Path64, Paths64, Point64,
};
use crate::clipper::engine::{boolean_op_with_poly_tree, poly_tree_to_paths64, PolyTree64};
use crate::domain::{IrregularPlacedPiece, IrregularPoint, PieceId, SheetSpec};
use crate::js_number::{cmp_js_code_units, fold_negative_zero, js_math, number_to_js_string};

use super::contact::{
    has_positive_canonical_grid_boundary_contact, measure_canonical_grid_boundary_contact,
};
use super::{
    canonical_grid_absolute_doubled_area, canonical_grid_compare_bigints,
    canonical_grid_convex_hull, canonical_grid_counter_clockwise,
    canonical_grid_signed_doubled_area, doubled_grid_area_to_mm2, from_grid, to_grid_mm,
    CanonicalGridPath, CanonicalGridPoint,
};

// ===========================================================================
// Clipper2 <-> canonical-grid point conversion.
//
// TS's `Path64`/`CanonicalGridPoint`/`CanonicalWorldGridPoint` are all
// structurally `{x:number,y:number}` and used interchangeably (see
// `crate::canonical_grid::contact`'s module doc for the same observation).
// This crate's `clipper::core::Point64` additionally carries a `z` field
// (always `0.0` for every path this file constructs), so every boundary
// crossing into/out of the vendored Clipper2 engine needs an explicit,
// otherwise-lossless conversion.
// ===========================================================================

fn to_clipper_path(path: &[CanonicalGridPoint]) -> Path64 {
    path.iter()
        .map(|point| Point64::new(point.x, point.y, 0.0))
        .collect()
}

fn to_canonical_grid_path(path: &[Point64]) -> CanonicalGridPath {
    path.iter()
        .map(|point| CanonicalGridPoint::new(point.x, point.y))
        .collect()
}

// ===========================================================================
// Output types (TS: `canonicalLayoutGeometry.ts:28-134`).
// ===========================================================================

/// TS source: `canonicalLayoutGeometry.ts:28-36` (`CanonicalLayoutTopology`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalLayoutTopology {
    pub enclosed_cavity_count: f64,
    pub largest_occupied_hull_gap_ratio: f64,
    pub occupied_envelope_aspect_ratio: f64,
    pub positive_contact_component_count: f64,
    pub isolated_piece_count: f64,
    pub largest_positive_contact_component_size: f64,
    pub largest_positive_contact_component_ratio: f64,
}

/// TS source: `canonicalLayoutGeometry.ts:39-47` (`CanonicalLayoutTopologyExact`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalLayoutTopologyExact {
    pub topology: CanonicalLayoutTopology,
    /// Rounded display/backward-compatibility projection; never use for exact ranking.
    pub hull_gap_doubled_area_grid2: f64,
    /// Rounded display/backward-compatibility projection; never use for exact ranking.
    pub hull_doubled_area_grid2: f64,
    pub exact_hull_gap_doubled_area_grid2: String,
    pub exact_hull_doubled_area_grid2: String,
}

/// TS source: `canonicalLayoutGeometry.ts:49-53` (`CanonicalEnclosedCavityMetrics`).
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalEnclosedCavityMetrics {
    pub count: f64,
    pub total_area_mm2: f64,
    pub total_doubled_area_grid2: String,
}

/// TS source: `canonicalLayoutGeometry.ts:55-60` (`CanonicalLayoutContactMetrics`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalLayoutContactMetrics {
    pub shared_boundary_length_mm: f64,
    pub contact_units: f64,
    pub total_structural_contacts: f64,
    pub dominant_structural_contacts: f64,
}

/// TS source: `canonicalLayoutGeometry.ts:62-72` (`CanonicalLayoutEnvelopeMetrics`).
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalLayoutEnvelopeMetrics {
    pub area_mm2: f64,
    pub maximum_side_mm: f64,
    pub span_mm: f64,
    pub occupied_hull_waste_ratio: f64,
    pub maximum_side_grid: f64,
    pub span_grid: f64,
    pub envelope_area_grid2: String,
    pub occupied_doubled_area_grid2: String,
    pub hull_doubled_area_grid2: String,
}

/// TS source: `canonicalLayoutGeometry.ts:74-77` (`CanonicalPlacedPolygon`, private).
#[derive(Debug, Clone, PartialEq)]
struct CanonicalPlacedPolygon {
    piece_id: PieceId,
    path: CanonicalGridPath,
}

/// TS source: `canonicalLayoutGeometry.ts:79-84` (`CanonicalGridAabb`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CanonicalGridAabb {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// TS source: `canonicalLayoutGeometry.ts:86-89` (`CanonicalWorldGridPoint`).
///
/// Structurally identical to [`CanonicalGridPoint`]; kept as a type alias
/// (not a duplicate struct) since TS itself treats the two interchangeably
/// (see this module's own doc comment on that pattern).
pub type CanonicalWorldGridPoint = CanonicalGridPoint;

/// TS source: `canonicalLayoutGeometry.ts:112-134`
/// (`CanonicalLayoutStructuralAnalysis`), plus its inline `pieces` element
/// type.
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalLayoutStructuralAnalysisPiece {
    pub piece_id: PieceId,
    pub aabb: CanonicalGridAabb,
    pub area_grid2: f64,
    pub doubled_area_grid2: String,
}

/// TS source: `canonicalLayoutGeometry.ts:128-132`
/// (`positiveAreaConflictMeasurements`'s inline element type).
#[derive(Debug, Clone, PartialEq)]
pub struct PositiveAreaConflictMeasurement {
    pub pair: (PieceId, PieceId),
    pub area_mm2: f64,
}

/// TS source: `canonicalLayoutGeometry.ts:121-127`
/// (`largestHullGap`'s inline object payload type). `path` is millimeter
/// (dequantized via [`from_grid`]) coordinates, matching TS's `InternalPoint`
/// — this crate's `IrregularPoint` (see [`super::contact`]'s module doc for
/// the same `InternalPoint == IrregularPoint` unification).
#[derive(Debug, Clone, PartialEq)]
pub struct LargestHullGapRegion {
    pub path: Vec<IrregularPoint>,
    pub area_mm2: f64,
    pub aabb: CanonicalGridAabb,
}

/// TS source: `canonicalLayoutGeometry.ts:112-134`
/// (`CanonicalLayoutStructuralAnalysis`).
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalLayoutStructuralAnalysis {
    pub pieces: Vec<CanonicalLayoutStructuralAnalysisPiece>,
    pub positive_contact_components: Vec<Vec<PieceId>>,
    pub positive_contact_pairs: Vec<(PieceId, PieceId)>,
    pub largest_hull_gap: Option<LargestHullGapRegion>,
    pub positive_area_conflicts: Vec<(PieceId, PieceId)>,
    pub positive_area_conflict_measurements: Vec<PositiveAreaConflictMeasurement>,
    pub wall_offenders: Vec<PieceId>,
}

/// TS source: `canonicalLayoutGeometry.ts:136` (`type QuarterTurn = 0 | 90 | 180 | 270`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuarterTurn {
    Zero,
    Ninety,
    OneEighty,
    TwoSeventy,
}

const QUARTER_TURNS: [QuarterTurn; 4] = [
    QuarterTurn::Zero,
    QuarterTurn::Ninety,
    QuarterTurn::OneEighty,
    QuarterTurn::TwoSeventy,
];

// ===========================================================================
// placedCollisionWorldGridPath / canonicalPlacedPolygons
// ===========================================================================

/// Authoritative collision path: add in millimetres, then round once to the grid.
///
/// TS source: `canonicalLayoutGeometry.ts:92-110`
/// (`placedCollisionWorldGridPath`).
pub fn placed_collision_world_grid_path(
    entry: &IrregularPlacedPiece,
) -> Option<Vec<CanonicalWorldGridPoint>> {
    let translate_x = entry.placement.transform.translate_x;
    let translate_y = entry.placement.transform.translate_y;
    let raw: Vec<(Option<f64>, Option<f64>)> = entry
        .collision_geometry
        .polygon
        .points
        .iter()
        .map(|point| {
            let x = to_grid_mm(point.x + translate_x).map(fold_negative_zero);
            let y = to_grid_mm(point.y + translate_y).map(fold_negative_zero);
            (x, y)
        })
        .collect();
    if raw.len() < 3 || raw.iter().any(|(x, y)| x.is_none() || y.is_none()) {
        return None;
    }
    Some(
        raw.into_iter()
            .filter_map(|(x, y)| match (x, y) {
                (Some(x), Some(y)) => Some(CanonicalGridPoint::new(x, y)),
                _ => None,
            })
            .collect(),
    )
}

/// TS source: `canonicalLayoutGeometry.ts:501-517` (`canonicalPlacedPolygons`).
fn canonical_placed_polygons(
    placed: &[IrregularPlacedPiece],
) -> Option<Vec<CanonicalPlacedPolygon>> {
    let mut result = Vec::with_capacity(placed.len());
    for entry in placed {
        let world_path = placed_collision_world_grid_path(entry)?;
        let path: CanonicalGridPath = world_path;
        let doubled_area = canonical_grid_signed_doubled_area(&path)?;
        if path.len() < 3 || doubled_area == BigInt::from(0) {
            return None;
        }
        let piece_id = entry
            .placement
            .piece_id
            .clone()
            .unwrap_or_else(|| entry.placement.source_piece_id.clone());
        result.push(CanonicalPlacedPolygon { piece_id, path });
    }
    Some(result)
}

// ===========================================================================
// canonicalCollisionLayoutIdentity
// ===========================================================================

/// Production collision-layout identity on the 0.001 mm grid.
///
/// TS source: `canonicalLayoutGeometry.ts:139-150`
/// (`canonicalCollisionLayoutIdentity`). See this module's doc comment for
/// the full byte-exactness contract.
pub fn canonical_collision_layout_identity(placed: &[IrregularPlacedPiece]) -> Option<String> {
    let polygons = canonical_placed_polygons(placed)?;
    let paths: Vec<CanonicalGridPath> = polygons
        .iter()
        .map(|polygon| polygon.path.clone())
        .collect();
    let mut identities: Vec<String> = QUARTER_TURNS
        .iter()
        .map(|&rotation_deg| identity_at_quarter_turn(&paths, rotation_deg))
        .collect();
    // TS: `identities.some((identity) => identity === undefined) ? undefined
    // : identities.filter(...).toSorted()[0]` — the `undefined` guard and
    // subsequent filter are both dead code here (`identity_at_quarter_turn`
    // never returns anything but a `String`, see this module's doc comment),
    // so this reduces to a plain default (code-unit) sort and take-first.
    identities.sort_by(|first, second| cmp_js_code_units(first, second));
    Some(
        identities
            .into_iter()
            .next()
            .expect("QUARTER_TURNS always yields exactly 4 identities"),
    )
}

/// TS source: `canonicalLayoutGeometry.ts:592-611` (`identityAtQuarterTurn`).
///
/// Never returns `undefined` in the TS source despite its declared
/// `string | undefined` return type — see this module's doc comment's
/// "dead-code finding" section.
fn identity_at_quarter_turn(paths: &[CanonicalGridPath], rotation_deg: QuarterTurn) -> String {
    let rotated: Vec<CanonicalGridPath> = paths
        .iter()
        .map(|path| {
            path.iter()
                .map(|&point| rotate_grid_point(point, rotation_deg))
                .collect()
        })
        .collect();
    let points: Vec<CanonicalGridPoint> = rotated.iter().flatten().copied().collect();
    let Some(first) = points.first().copied() else {
        return "[]".to_string();
    };
    let mut min_x = first.x;
    let mut min_y = first.y;
    for point in &points[1..] {
        min_x = js_math::min(min_x, point.x);
        min_y = js_math::min(min_y, point.y);
    }
    let mut ring_keys: Vec<String> = rotated
        .iter()
        .map(|path| {
            let translated: CanonicalGridPath = path
                .iter()
                .map(|point| CanonicalGridPoint::new(point.x - min_x, point.y - min_y))
                .collect();
            canonical_ring(&translated)
        })
        .collect();
    // TS: default (no comparator) `.toSorted()` — code-unit order (R8).
    ring_keys.sort_by(|first, second| cmp_js_code_units(first, second));
    json_stringify_string_array(&ring_keys)
}

/// `JSON.stringify(stringArray)` — compact form (no `space` argument), the
/// **only** `JSON.stringify` call site in this whole cluster
/// (`canonicalLayoutGeometry.ts:606-610`).
///
/// TS's own values here (`canonicalRing` keys: digits, `,`, `;`, optional
/// leading `-`) never require escaping, but this implements full ECMA-262
/// `QuoteJSONString` string escaping anyway per the migration prompt's
/// defensiveness requirement even for currently-unreachable inputs
/// (`canonical-grid.md` §8 makes this same point explicitly). Deliberately
/// hand-rolled here (not delegated to `serde_json`) rather than reusing
/// `checkpoints::canonical_json`'s private `json_string_literal`, which is
/// not `pub` from that module and belongs to a structurally different
/// "canonical JSON family" (ruling R5 keeps that family's four encoders
/// independent; this one-off compact string-array encoder is genuinely a
/// fifth, unrelated call site, not a member of that family).
fn json_stringify_string_array(values: &[String]) -> String {
    let mut out = String::with_capacity(values.iter().map(|v| v.len() + 3).sum::<usize>() + 2);
    out.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        for ch in value.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }
    out.push(']');
    out
}

/// TS source: `canonicalLayoutGeometry.ts:613-617` (`canonicalRing`). Both
/// the ring-origin *and* winding normalization in one step: tries both the
/// forward and reverse vertex order and keeps whichever minimal-rotation key
/// is code-unit-smaller.
fn canonical_ring(path: &[CanonicalGridPoint]) -> String {
    let forward = canonical_ring_direction(path);
    let reversed: CanonicalGridPath = path.iter().rev().copied().collect();
    let reverse = canonical_ring_direction(&reversed);
    if cmp_js_code_units(&forward, &reverse) == Ordering::Less {
        forward
    } else {
        reverse
    }
}

/// TS source: `canonicalLayoutGeometry.ts:619-630` (`canonicalRingDirection`).
/// The `O(n^2)` minimal-rotation search: every rotation offset produces a
/// semicolon-joined `"x,y"` key, and the code-unit-lexicographically
/// smallest one wins (raw `<`, not `localeCompare` — R8).
fn canonical_ring_direction(path: &[CanonicalGridPoint]) -> String {
    if path.is_empty() {
        return String::new();
    }
    let len = path.len();
    let mut best: Option<String> = None;
    for offset in 0..len {
        let key = (0..len)
            .map(|index| {
                let point = path[(index + offset) % len];
                format!(
                    "{},{}",
                    number_to_js_string(point.x),
                    number_to_js_string(point.y)
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        let better = match &best {
            None => true,
            Some(current) => cmp_js_code_units(&key, current) == Ordering::Less,
        };
        if better {
            best = Some(key);
        }
    }
    best.unwrap_or_default()
}

/// TS source: `canonicalLayoutGeometry.ts:632-643` (`rotateGridPoint`). Exact
/// integer negation/swap — no floating-point trig, so this step is exact by
/// construction (including reproducing JS unary-minus-zero's `-0` result
/// exactly, since Rust `-(0.0_f64)` is also `-0.0`).
fn rotate_grid_point(point: CanonicalGridPoint, rotation_deg: QuarterTurn) -> CanonicalGridPoint {
    match rotation_deg {
        QuarterTurn::Zero => point,
        QuarterTurn::Ninety => CanonicalGridPoint::new(-point.y, point.x),
        QuarterTurn::OneEighty => CanonicalGridPoint::new(-point.x, -point.y),
        QuarterTurn::TwoSeventy => CanonicalGridPoint::new(point.y, -point.x),
    }
}

// ===========================================================================
// measureCanonicalLayoutTopology(Exact)
// ===========================================================================

/// Sheet-free cavity and positive-contact topology from canonical collision polygons.
///
/// TS source: `canonicalLayoutGeometry.ts:153-157` (`measureCanonicalLayoutTopology`).
pub fn measure_canonical_layout_topology(
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalLayoutTopology> {
    measure_canonical_layout_topology_exact(placed).map(|exact| exact.topology)
}

/// Sheet-free topology with a hull-gap ratio preserved as exact grid-area terms.
///
/// TS source: `canonicalLayoutGeometry.ts:160-206`
/// (`measureCanonicalLayoutTopologyExact`).
pub fn measure_canonical_layout_topology_exact(
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalLayoutTopologyExact> {
    let polygons = canonical_placed_polygons(placed)?;
    let all_points: Vec<CanonicalGridPoint> = polygons
        .iter()
        .flat_map(|polygon| polygon.path.iter().copied())
        .collect();
    let hull = canonical_grid_convex_hull(&all_points)?;

    // TS evaluates all four of these unconditionally before checking any for
    // `undefined` (no early return between them); reproduced the same way —
    // eager compute, then one combined check — since none of these pure
    // functions has an observable side effect that early-return skipping
    // could change.
    let paths: Vec<CanonicalGridPath> = polygons
        .iter()
        .map(|polygon| polygon.path.clone())
        .collect();
    let hull_doubled_area = canonical_grid_absolute_doubled_area(&hull);
    let largest_gap_doubled_area = largest_hull_gap_doubled_area(&hull, &paths);
    let enclosed_cavity_count = count_enclosed_occupied_cavities(&paths);
    let occupied_envelope_aspect_ratio = envelope_aspect_ratio(&paths);
    let graph = measure_contact_graph(&paths);
    if hull_doubled_area.is_none()
        || largest_gap_doubled_area.is_none()
        || enclosed_cavity_count.is_none()
        || occupied_envelope_aspect_ratio.is_none()
        || graph.is_none()
    {
        return None;
    }
    let hull_doubled_area = hull_doubled_area.expect("checked above");
    let largest_gap_doubled_area = largest_gap_doubled_area.expect("checked above");
    let enclosed_cavity_count = enclosed_cavity_count.expect("checked above");
    let occupied_envelope_aspect_ratio = occupied_envelope_aspect_ratio.expect("checked above");
    let graph = graph.expect("checked above");

    let largest_occupied_hull_gap_ratio = if hull_doubled_area == BigInt::from(0) {
        0.0
    } else {
        bigint_to_number(&largest_gap_doubled_area) / bigint_to_number(&hull_doubled_area)
    };
    if !largest_occupied_hull_gap_ratio.is_finite() {
        return None;
    }
    let largest_positive_contact_component_ratio = if polygons.is_empty() {
        0.0
    } else {
        graph.largest_positive_contact_component_size / polygons.len() as f64
    };
    Some(CanonicalLayoutTopologyExact {
        topology: CanonicalLayoutTopology {
            enclosed_cavity_count,
            largest_occupied_hull_gap_ratio,
            occupied_envelope_aspect_ratio,
            positive_contact_component_count: graph.positive_contact_component_count,
            isolated_piece_count: graph.isolated_piece_count,
            largest_positive_contact_component_size: graph.largest_positive_contact_component_size,
            largest_positive_contact_component_ratio,
        },
        hull_gap_doubled_area_grid2: bigint_to_number(&largest_gap_doubled_area),
        hull_doubled_area_grid2: bigint_to_number(&hull_doubled_area),
        exact_hull_gap_doubled_area_grid2: largest_gap_doubled_area.to_string(),
        exact_hull_doubled_area_grid2: hull_doubled_area.to_string(),
    })
}

// ===========================================================================
// measureCanonicalEnclosedCavities
// ===========================================================================

/// Sheet-free enclosed-cavity count and area on the canonical collision grid.
///
/// TS source: `canonicalLayoutGeometry.ts:209-216` (`measureCanonicalEnclosedCavities`).
pub fn measure_canonical_enclosed_cavities(
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalEnclosedCavityMetrics> {
    let polygons = canonical_placed_polygons(placed)?;
    let paths: Vec<CanonicalGridPath> = polygons.into_iter().map(|polygon| polygon.path).collect();
    measure_enclosed_occupied_cavities(&paths)
}

// ===========================================================================
// measureCanonicalLayoutContacts
// ===========================================================================

/// Complete-layout contact metrics measured only after snapping world geometry to the grid.
///
/// TS source: `canonicalLayoutGeometry.ts:219-265` (`measureCanonicalLayoutContacts`).
pub fn measure_canonical_layout_contacts(
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalLayoutContactMetrics> {
    let mut polygons = canonical_placed_polygons(placed)?;
    polygons.sort_by(|first, second| {
        locale_compare_keys(first.piece_id.as_str(), second.piece_id.as_str())
    });

    let mut shared_boundary_length_mm = 0.0_f64;
    let mut contact_units = 0.0_f64;
    let mut total_structural_contacts = 0.0_f64;
    let mut signature_counts: HashMap<String, i64> = HashMap::new();
    for first_index in 0..polygons.len() {
        for second_index in 0..first_index {
            let contact = measure_canonical_grid_boundary_contact(
                &polygons[first_index].path,
                &polygons[second_index].path,
            )?;
            // R11: serial left-to-right float fold, matching
            // `sharedBoundaryLengthMm += contact.lengthMm` etc.
            // (`canonicalLayoutGeometry.ts:238-240`) in exact discovery order.
            shared_boundary_length_mm += contact.length_mm;
            contact_units += contact.normalized_units;
            total_structural_contacts += contact.near_complete_structural_contact_count;
            for signature in &contact.near_complete_structural_contact_signatures {
                let count = signature_counts.get(signature).copied().unwrap_or(0) + 1;
                if !crate::js_number::is_safe_integer(count as f64) {
                    return None;
                }
                signature_counts.insert(signature.clone(), count);
            }
        }
    }
    // TS: `Math.max` reduction over `Map.values()` — provably order-
    // independent (`canonical-grid.md` §4), so `HashMap` iteration order
    // here cannot affect the result.
    let mut dominant_structural_contacts: i64 = 0;
    for &count in signature_counts.values() {
        dominant_structural_contacts = dominant_structural_contacts.max(count);
    }
    let dominant_structural_contacts = dominant_structural_contacts as f64;

    let finite = [
        shared_boundary_length_mm,
        contact_units,
        total_structural_contacts,
        dominant_structural_contacts,
    ]
    .iter()
    .all(|value| value.is_finite());
    if finite {
        Some(CanonicalLayoutContactMetrics {
            shared_boundary_length_mm,
            contact_units,
            total_structural_contacts,
            dominant_structural_contacts,
        })
    } else {
        None
    }
}

// ===========================================================================
// measureCanonicalLayoutEnvelope
// ===========================================================================

/// Complete-layout envelope and hull metrics measured on canonical grid paths.
///
/// TS source: `canonicalLayoutGeometry.ts:268-340` (`measureCanonicalLayoutEnvelope`).
pub fn measure_canonical_layout_envelope(
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalLayoutEnvelopeMetrics> {
    let polygons = canonical_placed_polygons(placed)?;
    if polygons.is_empty() {
        return None;
    }
    let paths: Vec<CanonicalGridPath> = polygons
        .iter()
        .map(|polygon| polygon.path.clone())
        .collect();
    let points: Vec<CanonicalGridPoint> = paths.iter().flatten().copied().collect();
    // TS: `Math.min(...points.map(({x}) => x))` etc. — the all-args spread
    // form, matched exactly by `js_math::min_all`/`max_all` (see those
    // functions' own doc comments citing this exact idiom).
    let xs: Vec<f64> = points.iter().map(|point| point.x).collect();
    let ys: Vec<f64> = points.iter().map(|point| point.y).collect();
    let minimum_x = js_math::min_all(&xs);
    let minimum_y = js_math::min_all(&ys);
    let maximum_x = js_math::max_all(&xs);
    let maximum_y = js_math::max_all(&ys);
    let width_grid = maximum_x - minimum_x;
    let height_grid = maximum_y - minimum_y;

    let occupied_areas: Vec<Option<BigInt>> = paths
        .iter()
        .map(|path| canonical_grid_absolute_doubled_area(path))
        .collect();
    let hull = canonical_grid_convex_hull(&points);
    if occupied_areas.iter().any(|value| value.is_none()) || hull.is_none() {
        return None;
    }
    let hull = hull.expect("checked above");
    let occupied_doubled_area_grid2 = occupied_areas
        .into_iter()
        .flatten()
        .fold(BigInt::from(0), |sum, value| sum + value);
    let hull_doubled_area_grid2 = canonical_grid_absolute_doubled_area(&hull)?;
    if ![
        minimum_x,
        minimum_y,
        maximum_x,
        maximum_y,
        width_grid,
        height_grid,
    ]
    .iter()
    .all(|value| value.is_finite())
        || width_grid < 0.0
        || height_grid < 0.0
        || occupied_doubled_area_grid2 < BigInt::from(0)
        || hull_doubled_area_grid2 < occupied_doubled_area_grid2
    {
        return None;
    }

    let width_mm = from_grid(width_grid);
    let height_mm = from_grid(height_grid);
    let occupied_hull_waste_ratio = if hull_doubled_area_grid2 == BigInt::from(0) {
        0.0
    } else {
        bigint_to_number(&(&hull_doubled_area_grid2 - &occupied_doubled_area_grid2))
            / bigint_to_number(&hull_doubled_area_grid2)
    };
    let envelope_area_grid2 = f64_to_bigint(width_grid) * f64_to_bigint(height_grid);
    let area_mm2 = width_mm * height_mm;
    let maximum_side_mm = js_math::max(width_mm, height_mm);
    let span_mm = width_mm + height_mm;
    let maximum_side_grid = js_math::max(width_grid, height_grid);
    let span_grid = width_grid + height_grid;

    let finite = [
        area_mm2,
        maximum_side_mm,
        span_mm,
        occupied_hull_waste_ratio,
        maximum_side_grid,
        span_grid,
    ]
    .iter()
    .all(|value| value.is_finite());
    if !finite || !(0.0..=1.0).contains(&occupied_hull_waste_ratio) {
        return None;
    }
    Some(CanonicalLayoutEnvelopeMetrics {
        area_mm2,
        maximum_side_mm,
        span_mm,
        occupied_hull_waste_ratio,
        maximum_side_grid,
        span_grid,
        envelope_area_grid2: envelope_area_grid2.to_string(),
        occupied_doubled_area_grid2: occupied_doubled_area_grid2.to_string(),
        hull_doubled_area_grid2: hull_doubled_area_grid2.to_string(),
    })
}

// ===========================================================================
// assertCanonicalGridLegalLayout
// ===========================================================================

/// True only when every canonical-grid polygon fits and no pair has positive overlap.
///
/// TS source: `canonicalLayoutGeometry.ts:343-386` (`assertCanonicalGridLegalLayout`).
pub fn assert_canonical_grid_legal_layout(
    sheet: &SheetSpec,
    placed: &[IrregularPlacedPiece],
) -> bool {
    let Some(polygons) = canonical_placed_polygons(placed) else {
        return false;
    };
    let Some(sheet_width) = to_grid_mm(sheet.width) else {
        return false;
    };
    let Some(sheet_height) = to_grid_mm(sheet.height) else {
        return false;
    };
    for polygon in &polygons {
        if polygon.path.iter().any(|point| {
            point.x < 0.0 || point.y < 0.0 || point.x > sheet_width || point.y > sheet_height
        }) {
            return false;
        }
    }
    for first_index in 0..polygons.len() {
        for second_index in 0..first_index {
            let first = &polygons[first_index];
            let second = &polygons[second_index];
            let mut intersection = PolyTree64::new();
            let subject: Paths64 = vec![to_clipper_path(&first.path)];
            let clip: Paths64 = vec![to_clipper_path(&second.path)];
            boolean_op_with_poly_tree(
                ClipType::Intersection,
                Some(&subject),
                Some(&clip),
                &mut intersection,
                FillRule::NonZero,
            );
            let has_positive_or_invalid = poly_tree_to_paths64(&intersection).iter().any(|path| {
                let canonical_path = to_canonical_grid_path(path);
                match canonical_grid_absolute_doubled_area(&canonical_path) {
                    None => true,
                    Some(area) => area > BigInt::from(0),
                }
            });
            if has_positive_or_invalid {
                return false;
            }
        }
    }
    true
}

// ===========================================================================
// analyzeCanonicalLayoutStructure
// ===========================================================================

/// Exact canonical-grid structural facts without target or acceptance policy.
///
/// TS source: `canonicalLayoutGeometry.ts:389-499` (`analyzeCanonicalLayoutStructure`).
pub fn analyze_canonical_layout_structure(
    sheet: &SheetSpec,
    placed: &[IrregularPlacedPiece],
) -> Option<CanonicalLayoutStructuralAnalysis> {
    let polygons = canonical_placed_polygons(placed);
    let sheet_width = to_grid_mm(sheet.width);
    let sheet_height = to_grid_mm(sheet.height);
    let (Some(polygons), Some(sheet_width), Some(sheet_height)) =
        (polygons, sheet_width, sheet_height)
    else {
        return None;
    };
    let unique_ids: HashSet<&PieceId> = polygons.iter().map(|polygon| &polygon.piece_id).collect();
    if unique_ids.len() != polygons.len() {
        return None;
    }

    let mut neighbors: Vec<HashSet<usize>> = vec![HashSet::new(); polygons.len()];
    let mut positive_contact_pairs: Vec<(PieceId, PieceId)> = Vec::new();
    let mut positive_area_conflicts: Vec<(PieceId, PieceId)> = Vec::new();
    let mut positive_area_conflict_measurements: Vec<PositiveAreaConflictMeasurement> = Vec::new();
    for first_index in 0..polygons.len() {
        for second_index in 0..first_index {
            let first = &polygons[first_index];
            let second = &polygons[second_index];
            let has_positive_contact =
                has_positive_canonical_grid_boundary_contact(&first.path, &second.path)?;
            if has_positive_contact {
                neighbors[first_index].insert(second_index);
                neighbors[second_index].insert(first_index);
                positive_contact_pairs.push(ordered_piece_pair(&first.piece_id, &second.piece_id));
            }

            let mut intersection = PolyTree64::new();
            let subject: Paths64 = vec![to_clipper_path(&first.path)];
            let clip: Paths64 = vec![to_clipper_path(&second.path)];
            boolean_op_with_poly_tree(
                ClipType::Intersection,
                Some(&subject),
                Some(&clip),
                &mut intersection,
                FillRule::NonZero,
            );
            let mut intersection_doubled_area_grid2 = BigInt::from(0);
            for path in poly_tree_to_paths64(&intersection).iter() {
                let canonical_path = to_canonical_grid_path(path);
                let area = canonical_grid_absolute_doubled_area(&canonical_path)?;
                intersection_doubled_area_grid2 += area;
            }
            if intersection_doubled_area_grid2 > BigInt::from(0) {
                let pair = ordered_piece_pair(&first.piece_id, &second.piece_id);
                positive_area_conflicts.push(pair.clone());
                let area_mm2 = doubled_grid_area_to_mm2(&intersection_doubled_area_grid2)?;
                positive_area_conflict_measurements
                    .push(PositiveAreaConflictMeasurement { pair, area_mm2 });
            }
        }
    }

    let positive_contact_components = contact_components(&polygons, &neighbors)?;

    let all_points: Vec<CanonicalGridPoint> = polygons
        .iter()
        .flat_map(|polygon| polygon.path.iter().copied())
        .collect();
    let hull = canonical_grid_convex_hull(&all_points)?;
    let paths: Vec<CanonicalGridPath> = polygons
        .iter()
        .map(|polygon| polygon.path.clone())
        .collect();
    let largest_hull_gap = largest_hull_gap_region(&hull, &paths)?;

    let mut pieces_raw: Vec<Option<CanonicalLayoutStructuralAnalysisPiece>> =
        Vec::with_capacity(polygons.len());
    for polygon in &polygons {
        let aabb = grid_path_aabb(&polygon.path);
        let doubled_area_grid2 = canonical_grid_absolute_doubled_area(&polygon.path);
        let piece = match (aabb, doubled_area_grid2) {
            (Some(aabb), Some(doubled_area_grid2)) => {
                Some(CanonicalLayoutStructuralAnalysisPiece {
                    piece_id: polygon.piece_id.clone(),
                    aabb,
                    area_grid2: bigint_to_number(&doubled_area_grid2) / 2.0,
                    doubled_area_grid2: doubled_area_grid2.to_string(),
                })
            }
            _ => None,
        };
        pieces_raw.push(piece);
    }
    if pieces_raw.iter().any(|piece| piece.is_none()) {
        return None;
    }
    let pieces: Vec<CanonicalLayoutStructuralAnalysisPiece> =
        pieces_raw.into_iter().flatten().collect();

    let mut wall_offenders: Vec<PieceId> = polygons
        .iter()
        .filter(|polygon| {
            polygon.path.iter().any(|point| {
                point.x < 0.0 || point.y < 0.0 || point.x > sheet_width || point.y > sheet_height
            })
        })
        .map(|polygon| polygon.piece_id.clone())
        .collect();
    wall_offenders.sort_by(|first, second| cmp_js_code_units(first.as_str(), second.as_str()));

    positive_contact_pairs.sort_by(compare_piece_pairs);
    positive_area_conflicts.sort_by(compare_piece_pairs);
    positive_area_conflict_measurements
        .sort_by(|first, second| compare_piece_pairs(&first.pair, &second.pair));

    Some(CanonicalLayoutStructuralAnalysis {
        pieces,
        positive_contact_components,
        positive_contact_pairs,
        largest_hull_gap,
        positive_area_conflicts,
        positive_area_conflict_measurements,
        wall_offenders,
    })
}

/// TS source: `canonicalLayoutGeometry.ts:519-521` (`orderedPiecePair`). Raw
/// code-unit `<` (not `localeCompare`) — a genuine, verified inconsistency
/// with [`compare_piece_pairs`] (R8/`canonical-grid.md` §6).
fn ordered_piece_pair(first: &PieceId, second: &PieceId) -> (PieceId, PieceId) {
    if cmp_js_code_units(first.as_str(), second.as_str()) == Ordering::Less {
        (first.clone(), second.clone())
    } else {
        (second.clone(), first.clone())
    }
}

/// TS source: `canonicalLayoutGeometry.ts:523-528` (`comparePiecePairs`).
/// `localeCompare`, not code-unit (R8) — contrast with [`ordered_piece_pair`].
fn compare_piece_pairs(first: &(PieceId, PieceId), second: &(PieceId, PieceId)) -> Ordering {
    locale_compare_keys(first.0.as_str(), second.0.as_str())
        .then_with(|| locale_compare_keys(first.1.as_str(), second.1.as_str()))
}

/// TS source: `canonicalLayoutGeometry.ts:530-574` (`contactComponents`).
fn contact_components(
    polygons: &[CanonicalPlacedPolygon],
    neighbors: &[HashSet<usize>],
) -> Option<Vec<Vec<PieceId>>> {
    let mut visited: HashSet<usize> = HashSet::new();
    let mut components: Vec<Vec<PieceId>> = Vec::new();
    for start in 0..polygons.len() {
        if visited.contains(&start) {
            continue;
        }
        let mut pending = vec![start];
        let mut component: Vec<PieceId> = Vec::new();
        visited.insert(start);
        while let Some(current) = pending.pop() {
            let polygon = polygons.get(current)?;
            component.push(polygon.piece_id.clone());
            if let Some(neighbor_set) = neighbors.get(current) {
                for &neighbor in neighbor_set {
                    if visited.contains(&neighbor) {
                        continue;
                    }
                    visited.insert(neighbor);
                    pending.push(neighbor);
                }
            }
        }
        // TS: default (no comparator) `.toSorted()` on one component's
        // `PieceId[]` — code-unit order.
        component.sort_by(|first, second| cmp_js_code_units(first.as_str(), second.as_str()));
        components.push(component);
    }

    let mut area_entries: Vec<Option<(PieceId, BigInt)>> = Vec::with_capacity(polygons.len());
    for polygon in polygons {
        let doubled_area = canonical_grid_absolute_doubled_area(&polygon.path);
        area_entries.push(doubled_area.map(|area| (polygon.piece_id.clone(), area)));
    }
    if area_entries.iter().any(|entry| entry.is_none()) {
        return None;
    }
    // TS: `new Map(entries)` — last-insertion-wins on a duplicate key,
    // matching `HashMap`'s own `insert` semantics (`canonical-grid.md` §5).
    let area_by_id: HashMap<PieceId, BigInt> = area_entries.into_iter().flatten().collect();

    components.sort_by(|first, second| {
        let first_area = component_doubled_area(first, &area_by_id);
        let second_area = component_doubled_area(second, &area_by_id);
        // TS: `second.length - first.length` — descending component size.
        let length_order = second.len().cmp(&first.len());
        if length_order != Ordering::Equal {
            return length_order;
        }
        let area_order = match canonical_grid_compare_bigints(&second_area, &first_area) {
            value if value < 0 => Ordering::Less,
            0 => Ordering::Equal,
            _ => Ordering::Greater,
        };
        if area_order != Ordering::Equal {
            return area_order;
        }
        let first_joined = first
            .iter()
            .map(PieceId::as_str)
            .collect::<Vec<_>>()
            .join("|");
        let second_joined = second
            .iter()
            .map(PieceId::as_str)
            .collect::<Vec<_>>()
            .join("|");
        locale_compare_keys(&first_joined, &second_joined)
    });
    Some(components)
}

fn component_doubled_area(component: &[PieceId], area_by_id: &HashMap<PieceId, BigInt>) -> BigInt {
    component
        .iter()
        .map(|piece_id| {
            area_by_id
                .get(piece_id)
                .cloned()
                .unwrap_or_else(|| BigInt::from(0))
        })
        .fold(BigInt::from(0), |sum, value| sum + value)
}

/// TS source: `canonicalLayoutGeometry.ts:576-590` (`gridPathAabb`).
fn grid_path_aabb(path: &[CanonicalGridPoint]) -> Option<CanonicalGridAabb> {
    let first = *path.first()?;
    let mut min_x = first.x;
    let mut min_y = first.y;
    let mut max_x = first.x;
    let mut max_y = first.y;
    for point in &path[1..] {
        min_x = js_math::min(min_x, point.x);
        min_y = js_math::min(min_y, point.y);
        max_x = js_math::max(max_x, point.x);
        max_y = js_math::max(max_y, point.y);
    }
    Some(CanonicalGridAabb {
        min_x,
        min_y,
        max_x,
        max_y,
    })
}

// ===========================================================================
// Hull-gap region and topology tree walks
// ===========================================================================

/// TS source: `canonicalLayoutGeometry.ts:645-667` (`largestHullGapDoubledArea`).
fn largest_hull_gap_doubled_area(
    hull: &CanonicalGridPath,
    occupied: &[CanonicalGridPath],
) -> Option<BigInt> {
    if hull.len() < 3 {
        return Some(BigInt::from(0));
    }
    let oriented_hull = canonical_grid_counter_clockwise(hull)?;
    let occupied_paths: Paths64 = occupied.iter().map(|path| to_clipper_path(path)).collect();
    let mut occupied_tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Union,
        Some(&occupied_paths),
        None,
        &mut occupied_tree,
        FillRule::EvenOdd,
    );
    let occupied_union = poly_tree_to_paths64(&occupied_tree);
    let subject: Paths64 = vec![to_clipper_path(&oriented_hull)];
    let mut gap_tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Difference,
        Some(&subject),
        Some(&occupied_union),
        &mut gap_tree,
        FillRule::NonZero,
    );
    largest_net_region_doubled_area(&gap_tree)
}

/// TS source: `canonicalLayoutGeometry.ts:669-734` (`largestHullGapRegion`).
///
/// Three-state result per this module's doc comment: outer `None` == TS
/// `null` (computation failure), inner `None` == TS `undefined` (no gap
/// region found), `Some(Some(_))` == TS's object payload.
fn largest_hull_gap_region(
    hull: &CanonicalGridPath,
    occupied: &[CanonicalGridPath],
) -> Option<Option<LargestHullGapRegion>> {
    if hull.len() < 3 {
        return Some(None);
    }
    let oriented_hull = canonical_grid_counter_clockwise(hull)?;
    let occupied_paths: Paths64 = occupied.iter().map(|path| to_clipper_path(path)).collect();
    let mut occupied_tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Union,
        Some(&occupied_paths),
        None,
        &mut occupied_tree,
        FillRule::EvenOdd,
    );
    let occupied_union = poly_tree_to_paths64(&occupied_tree);
    let subject: Paths64 = vec![to_clipper_path(&oriented_hull)];
    let mut gap_tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Difference,
        Some(&subject),
        Some(&occupied_union),
        &mut gap_tree,
        FillRule::NonZero,
    );

    let mut selected_path: Option<CanonicalGridPath> = None;
    let mut selected_doubled_area = BigInt::from(0);
    let ok = visit_largest_hull_gap(
        &gap_tree,
        PolyTree64::ROOT,
        &mut selected_path,
        &mut selected_doubled_area,
    );
    if !ok {
        return None;
    }
    let Some(selected_path) = selected_path else {
        return Some(None);
    };
    let aabb = grid_path_aabb(&selected_path)?;
    let area_mm2 = doubled_grid_area_to_mm2(&selected_doubled_area)?;
    let path: Vec<IrregularPoint> = selected_path
        .iter()
        .map(|point| IrregularPoint::new(from_grid(point.x), from_grid(point.y)))
        .collect();
    Some(Some(LargestHullGapRegion {
        path,
        area_mm2,
        aabb,
    }))
}

fn visit_largest_hull_gap(
    tree: &PolyTree64,
    parent: usize,
    selected_path: &mut Option<CanonicalGridPath>,
    selected_doubled_area: &mut BigInt,
) -> bool {
    for index in 0..tree.count(parent) {
        let child = tree.child(parent, index);
        if !tree.is_hole(child) {
            if let Some(child_polygon) = tree.poly(child) {
                let child_path = to_canonical_grid_path(child_polygon);
                let Some(net_doubled_area) = net_solid_doubled_area(tree, child) else {
                    return false;
                };
                let key = canonical_ring(&child_path);
                let selected_key = selected_path.as_ref().map(|path| canonical_ring(path));
                let better = net_doubled_area > *selected_doubled_area
                    || (net_doubled_area == *selected_doubled_area
                        && cmp_js_code_units(&key, selected_key.as_deref().unwrap_or(&key))
                            == Ordering::Less);
                if better {
                    *selected_path = Some(child_path);
                    *selected_doubled_area = net_doubled_area;
                }
            }
        }
        if !visit_largest_hull_gap(tree, child, selected_path, selected_doubled_area) {
            return false;
        }
    }
    true
}

/// TS source: `canonicalLayoutGeometry.ts:736-738` (`countEnclosedOccupiedCavities`).
fn count_enclosed_occupied_cavities(occupied: &[CanonicalGridPath]) -> Option<f64> {
    measure_enclosed_occupied_cavities(occupied).map(|metrics| metrics.count)
}

/// TS source: `canonicalLayoutGeometry.ts:740-779` (`measureEnclosedOccupiedCavities`).
fn measure_enclosed_occupied_cavities(
    occupied: &[CanonicalGridPath],
) -> Option<CanonicalEnclosedCavityMetrics> {
    if occupied.is_empty() {
        return Some(CanonicalEnclosedCavityMetrics {
            count: 0.0,
            total_area_mm2: 0.0,
            total_doubled_area_grid2: "0".to_string(),
        });
    }
    let occupied_paths: Paths64 = occupied.iter().map(|path| to_clipper_path(path)).collect();
    let mut tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Union,
        Some(&occupied_paths),
        None,
        &mut tree,
        FillRule::EvenOdd,
    );

    let mut count: i64 = 0;
    let mut total_doubled_area_grid2 = BigInt::from(0);
    let ok = visit_enclosed_cavities(
        &tree,
        PolyTree64::ROOT,
        &mut count,
        &mut total_doubled_area_grid2,
    );
    if !ok {
        return None;
    }
    let total_area_mm2 = doubled_grid_area_to_mm2(&total_doubled_area_grid2)?;
    Some(CanonicalEnclosedCavityMetrics {
        count: count as f64,
        total_area_mm2,
        total_doubled_area_grid2: total_doubled_area_grid2.to_string(),
    })
}

fn visit_enclosed_cavities(
    tree: &PolyTree64,
    parent: usize,
    count: &mut i64,
    total_doubled_area_grid2: &mut BigInt,
) -> bool {
    for index in 0..tree.count(parent) {
        let child = tree.child(parent, index);
        if tree.is_hole(child) {
            let Some(child_polygon) = tree.poly(child) else {
                return false;
            };
            let child_path = to_canonical_grid_path(child_polygon);
            let Some(cavity_doubled_area) = canonical_grid_absolute_doubled_area(&child_path)
            else {
                return false;
            };
            *count += 1;
            *total_doubled_area_grid2 += cavity_doubled_area;
        }
        if !visit_enclosed_cavities(tree, child, count, total_doubled_area_grid2) {
            return false;
        }
    }
    true
}

/// TS source: `canonicalLayoutGeometry.ts:781-801` (`envelopeAspectRatio`).
fn envelope_aspect_ratio(paths: &[CanonicalGridPath]) -> Option<f64> {
    let points: Vec<CanonicalGridPoint> = paths.iter().flatten().copied().collect();
    let first = *points.first()?;
    let mut min_x = first.x;
    let mut max_x = first.x;
    let mut min_y = first.y;
    let mut max_y = first.y;
    for point in &points[1..] {
        min_x = js_math::min(min_x, point.x);
        max_x = js_math::max(max_x, point.x);
        min_y = js_math::min(min_y, point.y);
        max_y = js_math::max(max_y, point.y);
    }
    let width = max_x - min_x;
    let height = max_y - min_y;
    let short_side = js_math::min(width, height);
    let long_side = js_math::max(width, height);
    if short_side <= 0.0 || !short_side.is_finite() || !long_side.is_finite() {
        return None;
    }
    Some(long_side / short_side)
}

/// TS source: `canonicalLayoutGeometry.ts:803-821` (`netSolidDoubledArea`).
fn net_solid_doubled_area(tree: &PolyTree64, node: usize) -> Option<BigInt> {
    let polygon = tree.poly(node)?;
    let outer_path = to_canonical_grid_path(polygon);
    let outer_area = canonical_grid_absolute_doubled_area(&outer_path)?;
    let mut net_area = outer_area;
    for hole_index in 0..tree.count(node) {
        let hole = tree.child(node, hole_index);
        if !tree.is_hole(hole) || tree.poly(hole).is_none() {
            continue;
        }
        let hole_path = to_canonical_grid_path(tree.poly(hole).expect("checked above"));
        let hole_area = canonical_grid_absolute_doubled_area(&hole_path)?;
        net_area -= hole_area;
    }
    if net_area >= BigInt::from(0) {
        Some(net_area)
    } else {
        None
    }
}

/// TS source: `canonicalLayoutGeometry.ts:823-843` (`largestNetRegionDoubledArea`).
fn largest_net_region_doubled_area(tree: &PolyTree64) -> Option<BigInt> {
    let mut largest = BigInt::from(0);
    if visit_largest_net_region(tree, PolyTree64::ROOT, &mut largest) {
        Some(largest)
    } else {
        None
    }
}

fn visit_largest_net_region(tree: &PolyTree64, parent: usize, largest: &mut BigInt) -> bool {
    for index in 0..tree.count(parent) {
        let child = tree.child(parent, index);
        if !tree.is_hole(child) {
            let Some(net_area) = net_solid_doubled_area(tree, child) else {
                return false;
            };
            if net_area > *largest {
                *largest = net_area;
            }
        }
        if !visit_largest_net_region(tree, child, largest) {
            return false;
        }
    }
    true
}

/// TS source: `canonicalLayoutGeometry.ts:845-888` (`measureContactGraph`).
struct ContactGraphMetrics {
    positive_contact_component_count: f64,
    isolated_piece_count: f64,
    largest_positive_contact_component_size: f64,
}

fn measure_contact_graph(polygons: &[CanonicalGridPath]) -> Option<ContactGraphMetrics> {
    let mut neighbors: Vec<HashSet<usize>> = vec![HashSet::new(); polygons.len()];
    for first_index in 0..polygons.len() {
        for second_index in 0..first_index {
            let has_positive_contact = has_positive_canonical_grid_boundary_contact(
                &polygons[first_index],
                &polygons[second_index],
            )?;
            if has_positive_contact {
                neighbors[first_index].insert(second_index);
                neighbors[second_index].insert(first_index);
            }
        }
    }

    let mut visited: HashSet<usize> = HashSet::new();
    let mut positive_contact_component_count: i64 = 0;
    let mut largest_positive_contact_component_size: i64 = 0;
    for start in 0..polygons.len() {
        if visited.contains(&start) {
            continue;
        }
        positive_contact_component_count += 1;
        let mut size: i64 = 0;
        let mut pending = vec![start];
        visited.insert(start);
        while let Some(current) = pending.pop() {
            size += 1;
            for &neighbor in &neighbors[current] {
                if !visited.contains(&neighbor) {
                    visited.insert(neighbor);
                    pending.push(neighbor);
                }
            }
        }
        largest_positive_contact_component_size = largest_positive_contact_component_size.max(size);
    }
    let isolated_piece_count = neighbors
        .iter()
        .filter(|neighbor_set| neighbor_set.is_empty())
        .count() as i64;

    Some(ContactGraphMetrics {
        positive_contact_component_count: positive_contact_component_count as f64,
        isolated_piece_count: isolated_piece_count as f64,
        largest_positive_contact_component_size: largest_positive_contact_component_size as f64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        IrregularPlacement, IrregularPolygon, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, TransformedCollisionGeometry,
    };

    fn point(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn rectangle(width: f64, height: f64) -> Vec<IrregularPoint> {
        vec![
            point(0.0, 0.0),
            point(width, 0.0),
            point(width, height),
            point(0.0, height),
        ]
    }

    fn placed_piece(
        id: &str,
        points: Vec<IrregularPoint>,
        translate_x: f64,
        translate_y: f64,
    ) -> IrregularPlacedPiece {
        let piece_id = PieceId::new(id);
        let polygon = IrregularPolygon::new(points.clone());
        let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: piece_id.clone(),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: piece_id,
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Configured,
                },
                polygon,
                bounds: crate::domain::IrregularBounds::new(min_x, min_y, max_x, max_y),
            },
        }
    }

    fn sheet(width: f64, height: f64) -> SheetSpec {
        SheetSpec {
            width,
            height,
            label: "sheet".to_string(),
        }
    }

    #[test]
    fn placed_collision_world_grid_path_folds_negative_zero() {
        let piece = placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0);
        let path = placed_collision_world_grid_path(&piece).expect("valid path");
        assert_eq!(path[0].x.to_bits(), 0.0_f64.to_bits());
        assert_eq!(path[0].y.to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn placed_collision_world_grid_path_rejects_degenerate_input() {
        let piece = placed_piece("a", vec![point(0.0, 0.0), point(1.0, 0.0)], 0.0, 0.0);
        assert_eq!(placed_collision_world_grid_path(&piece), None);
    }

    #[test]
    fn canonical_collision_layout_identity_is_translation_invariant() {
        let placed_a = vec![placed_piece("a", rectangle(10.0, 20.0), 0.0, 0.0)];
        let placed_b = vec![placed_piece("a", rectangle(10.0, 20.0), 500.0, -300.0)];
        let identity_a = canonical_collision_layout_identity(&placed_a).expect("valid layout");
        let identity_b = canonical_collision_layout_identity(&placed_b).expect("valid layout");
        assert_eq!(identity_a, identity_b);
    }

    #[test]
    fn canonical_collision_layout_identity_is_quarter_turn_invariant() {
        let base = rectangle(10.0, 20.0);
        let rotated_90: Vec<IrregularPoint> = base.iter().map(|p| point(-p.y, p.x)).collect();
        let placed_a = vec![placed_piece("a", base, 0.0, 0.0)];
        let placed_b = vec![placed_piece("a", rotated_90, 0.0, 0.0)];
        let identity_a = canonical_collision_layout_identity(&placed_a).expect("valid layout");
        let identity_b = canonical_collision_layout_identity(&placed_b).expect("valid layout");
        assert_eq!(identity_a, identity_b);
    }

    #[test]
    fn canonical_collision_layout_identity_is_winding_invariant() {
        let forward = rectangle(10.0, 20.0);
        let mut reversed = forward.clone();
        reversed.reverse();
        let placed_a = vec![placed_piece("a", forward, 0.0, 0.0)];
        let placed_b = vec![placed_piece("a", reversed, 0.0, 0.0)];
        let identity_a = canonical_collision_layout_identity(&placed_a).expect("valid layout");
        let identity_b = canonical_collision_layout_identity(&placed_b).expect("valid layout");
        assert_eq!(identity_a, identity_b);
    }

    #[test]
    fn canonical_collision_layout_identity_is_ring_origin_invariant() {
        let base = rectangle(10.0, 20.0);
        let mut rotated_origin = base.clone();
        rotated_origin.rotate_left(1);
        let placed_a = vec![placed_piece("a", base, 0.0, 0.0)];
        let placed_b = vec![placed_piece("a", rotated_origin, 0.0, 0.0)];
        let identity_a = canonical_collision_layout_identity(&placed_a).expect("valid layout");
        let identity_b = canonical_collision_layout_identity(&placed_b).expect("valid layout");
        assert_eq!(identity_a, identity_b);
    }

    #[test]
    fn canonical_collision_layout_identity_is_placement_order_invariant() {
        let placed_forward = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(5.0, 5.0), 100.0, 100.0),
        ];
        let placed_reversed = vec![
            placed_piece("b", rectangle(5.0, 5.0), 100.0, 100.0),
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
        ];
        let identity_forward =
            canonical_collision_layout_identity(&placed_forward).expect("valid layout");
        let identity_reversed =
            canonical_collision_layout_identity(&placed_reversed).expect("valid layout");
        assert_eq!(identity_forward, identity_reversed);
    }

    #[test]
    fn assert_canonical_grid_legal_layout_rejects_overlap() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 5.0, 5.0),
        ];
        assert!(!assert_canonical_grid_legal_layout(
            &sheet(100.0, 100.0),
            &placed
        ));
    }

    #[test]
    fn assert_canonical_grid_legal_layout_accepts_touching_pieces() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 10.0, 0.0),
        ];
        assert!(assert_canonical_grid_legal_layout(
            &sheet(100.0, 100.0),
            &placed
        ));
    }

    #[test]
    fn assert_canonical_grid_legal_layout_rejects_wall_overrun() {
        let placed = vec![placed_piece("a", rectangle(10.0, 10.0), 95.0, 0.0)];
        assert!(!assert_canonical_grid_legal_layout(
            &sheet(100.0, 100.0),
            &placed
        ));
    }

    #[test]
    fn measure_canonical_layout_topology_reports_zero_cavities_for_disjoint_pieces() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 100.0, 100.0),
        ];
        let topology = measure_canonical_layout_topology(&placed).expect("valid topology");
        assert_eq!(topology.enclosed_cavity_count, 0.0);
        assert_eq!(topology.isolated_piece_count, 2.0);
        assert_eq!(topology.positive_contact_component_count, 2.0);
    }

    #[test]
    fn measure_canonical_enclosed_cavities_finds_a_frame_hole() {
        // A square picture-frame built from 4 non-overlapping bars, leaving
        // an interior 80x80 mm hole nothing else covers.
        let placed = vec![
            placed_piece(
                "bottom",
                vec![
                    point(0.0, 0.0),
                    point(100.0, 0.0),
                    point(100.0, 10.0),
                    point(0.0, 10.0),
                ],
                0.0,
                0.0,
            ),
            placed_piece(
                "top",
                vec![
                    point(0.0, 90.0),
                    point(100.0, 90.0),
                    point(100.0, 100.0),
                    point(0.0, 100.0),
                ],
                0.0,
                0.0,
            ),
            placed_piece(
                "left",
                vec![
                    point(0.0, 10.0),
                    point(10.0, 10.0),
                    point(10.0, 90.0),
                    point(0.0, 90.0),
                ],
                0.0,
                0.0,
            ),
            placed_piece(
                "right",
                vec![
                    point(90.0, 10.0),
                    point(100.0, 10.0),
                    point(100.0, 90.0),
                    point(90.0, 90.0),
                ],
                0.0,
                0.0,
            ),
        ];
        let cavities = measure_canonical_enclosed_cavities(&placed).expect("valid cavity metrics");
        assert_eq!(cavities.count, 1.0);
        assert_eq!(cavities.total_area_mm2, 6400.0);
    }

    #[test]
    fn measure_canonical_layout_contacts_matches_touching_edge() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 10.0, 0.0),
        ];
        let contacts = measure_canonical_layout_contacts(&placed).expect("valid contacts");
        assert_eq!(contacts.shared_boundary_length_mm, 10.0);
    }

    #[test]
    fn measure_canonical_layout_envelope_reports_bounding_box() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 90.0, 90.0),
        ];
        let envelope = measure_canonical_layout_envelope(&placed).expect("valid envelope");
        assert_eq!(envelope.area_mm2, 100.0 * 100.0);
        assert_eq!(envelope.occupied_doubled_area_grid2, "400000000");
    }

    #[test]
    fn analyze_canonical_layout_structure_reports_touching_pair() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 10.0, 0.0),
        ];
        let analysis = analyze_canonical_layout_structure(&sheet(100.0, 100.0), &placed)
            .expect("valid analysis");
        assert_eq!(analysis.positive_contact_pairs.len(), 1);
        assert_eq!(analysis.positive_area_conflicts.len(), 0);
        assert_eq!(analysis.wall_offenders.len(), 0);
        assert_eq!(analysis.largest_hull_gap, None);
    }

    #[test]
    fn analyze_canonical_layout_structure_reports_overlap_conflict() {
        let placed = vec![
            placed_piece("a", rectangle(10.0, 10.0), 0.0, 0.0),
            placed_piece("b", rectangle(10.0, 10.0), 5.0, 5.0),
        ];
        let analysis = analyze_canonical_layout_structure(&sheet(100.0, 100.0), &placed)
            .expect("valid analysis");
        assert_eq!(analysis.positive_area_conflicts.len(), 1);
        assert_eq!(analysis.positive_area_conflict_measurements.len(), 1);
        assert_eq!(
            analysis.positive_area_conflict_measurements[0].area_mm2,
            25.0
        );
    }
}
