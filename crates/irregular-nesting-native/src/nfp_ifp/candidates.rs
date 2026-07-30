//! Candidate point generation and legality filtering — the hot path.
//!
//! TS source: `src/workers/irregular/nfpIfpService.ts` (1299 lines), read in
//! full: `generatePlacementCandidatesUncached`
//! (`nfpIfpService.ts:267-560`), `canonicalPlacementPointAlternatives`
//! (`:569-593`), `compareCanonicalCandidatePoints` (`:595-604`), `pointKey`
//! (`:1230-1232`), `addPoint` (`:1201-1228`), `BoundsIndex` (`:737-769`),
//! `addBoundaryIntersections`/`intersectSegments`/`addAntiparallelEdgeSupportPoints`.
//! Ordering and comparator rules are traced in
//! `docs/planning/rust-irregular-backend/characterization/nfp-ifp.md` §5-§6,
//! cancellation observation points in §10.
//!
//! # Reuse
//!
//! `resolveNfpBoundary`/`resolveIfpBounds` come from this cluster's sibling
//! modules ([`super::boundary_core`], [`super::ifp_bounds`]).
//! `assessPlacement` is owned by `validation` (imported, never
//! re-implemented): [`crate::validation::placement::assess_placement`].
//! `PlacedCollisionSpatialIndex` is owned by `validation` as well
//! ([`crate::validation::spatial_index::PlacedCollisionSpatialIndex`]).
//! Cache key/store plumbing is owned by `caches` (imported, never
//! re-implemented).
//!
//! # `onCandidateProvenance` callback → return value
//!
//! TS threads an optional `(provenance) => void` callback through the whole
//! call, invoked exactly once at the very end
//! (`emitCandidateProvenance`/`nfpIfpService.ts:944-981`) only when both a
//! provenance accumulator exists *and* the caller supplied the callback.
//! Provenance is explicitly documented as **observer-only** (`services.ts:157-160`)
//! and never alters admission or the returned `candidates` array. This port
//! replaces the callback with a plain `want_provenance: bool` input flag and
//! an `Option<NfpIfpCandidateProvenance>` field on the returned outcome:
//! since the callback fires exactly once, at the very end, with content that
//! never depends on anything the callback itself could do, returning the
//! same content as a value rather than invoking a callback preserves the
//! exact content and timing ("emitted once, after the whole computation")
//! without changing any control-flow-observable behavior — a legitimate
//! ergonomic simplification, not a semantic change.
//!
//! # `HashMap`/`HashSet` for point/grid-key dedup
//!
//! Per `nfp-ifp.md` §12 point 4: every place `Map`/`Set` iteration order
//! could leak into an externally observable value is explicitly re-sorted
//! before use in this cluster, so `HashMap`/`HashSet` are safe substitutes
//! throughout this module as long as those same explicit re-sorts are
//! preserved (see [`build_provenance_snapshot`]'s two explicit sorts, and
//! the top-level `sorted_points` sort in
//! [`generate_placement_candidates_uncached`]). `pointKey`'s TS `` `${x}:${y}` ``
//! string is replaced by an `(u64, u64)` bit-pattern tuple
//! (`point.x.to_bits(), point.y.to_bits()`) here: every point reaching this
//! key is already folded through [`fold_negative_zero`] first (matching TS's
//! `normalizeNegativeZero` call immediately before `pointKey` at every call
//! site), so the bit pattern is exactly as injective for finite `f64`s as
//! the decimal-string key TS builds, without the string allocation.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::caches::{
    CandidateDomain, GeometryCacheStore, NfpCandidatePruningMode, NfpConstructionAlgorithm,
};
use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::domain::{
    IrregularBounds, IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacementCandidate,
    IrregularPoint, IrregularPolygon, SheetSpec, TransformedCollisionGeometry,
};
use crate::geometry::convex::{
    are_disjoint, bounds_for_points, validate_strict_boundary, ConvexPolygonWinding,
    StrictConvexBoundaryValidation,
};
use crate::geometry::predicates;
use crate::js_number::{fold_negative_zero, is_safe_integer, js_math};
use crate::validation::placement::{
    assess_placement, AssessPlacementInput, AssessPlacementOutcome,
};
use crate::validation::spatial_index::PlacedCollisionSpatialIndex;

use super::boundary_core::{resolve_nfp_boundary, CoreNfpInput};
use super::ifp_bounds::{resolve_ifp_bounds, CoreIfpBoundsFailureKind};
use super::service::{invalid_geometry, nfp_checkpoint, NfpIfpControl, NfpIfpError};
use super::telemetry::{NfpIfpCheckpointPhase, NfpIfpTelemetry};
use crate::caches::InnerFitBoundsKeyInput;

const ORIGIN: IrregularPoint = IrregularPoint { x: 0.0, y: 0.0 };

// ---------------------------------------------------------------------------
// Public input/output shapes.
// ---------------------------------------------------------------------------

/// TS: `services.ts:177-189` (`GeneratePlacementCandidatesInput`),
/// concretized to this crate's trusted domain carriers.
///
/// `placed` is `&[Arc<IrregularPlacedPiece>]` (not a plain slice of owned
/// values), matching `validation::placement::AssessPlacementInput`'s own
/// convention: `placed_collision_index.matches(placed)` needs JS
/// reference-identity semantics, reproduced via `Arc::ptr_eq` — callers must
/// thread the same `Arc`s into both this input and the index.
pub struct GeneratePlacementCandidatesInput<'a> {
    pub sheet: &'a SheetSpec,
    pub placed: &'a [Arc<IrregularPlacedPiece>],
    pub placed_collision_index: Option<&'a PlacedCollisionSpatialIndex>,
    pub moving: &'a TransformedCollisionGeometry,
    pub settings: &'a IrregularNestingSettings,
    /// `services.ts:184`'s optional field; absence is `CandidateDomain::Sheet`
    /// (this crate's non-`Option` default, matching TS's `?? 'sheet'`
    /// fallback used everywhere this field's effective value is read).
    pub candidate_domain: CandidateDomain,
    /// Replaces TS's `onCandidateProvenance?: (provenance) => void` — see
    /// this module's top-level doc for why a `bool` input flag plus a
    /// returned `Option` is an exact-content, exact-timing equivalent.
    pub want_provenance: bool,
}

/// TS: `services.ts:161-175` (`NfpIfpCandidateProvenance`).
#[derive(Clone, Debug, PartialEq)]
pub struct NfpIfpCandidateProvenance {
    pub raw_by_source: RawBySource,
    pub unique_by_source_mask: Vec<SourceMaskCount>,
    pub outside_ifp: u32,
    pub nfp_interior_rejected: u32,
    pub live_convex_rejected: u32,
    pub live_convex_legal: u32,
    /// TS: `phaseIncompatible: number | 'not-evaluated'`, hardcoded to the
    /// literal by this cluster (`nfpIfpService.ts:973-977`) — this cluster
    /// never computes a number for it.
    pub phase_incompatible: ProvenanceEvaluation,
    pub canonical_checked: ProvenanceEvaluation,
    pub canonical_legal: ProvenanceEvaluation,
    pub legal_candidate_sources: Vec<NfpIfpLegalCandidateSource>,
}

/// TS: `services.ts:171-173`'s `number | 'not-evaluated'` union, narrowed to
/// the one literal this cluster ever produces (see
/// [`NfpIfpCandidateProvenance::phase_incompatible`]'s doc comment). Kept as
/// an honest single-variant enum rather than silently dropping the field's
/// declared union shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvenanceEvaluation {
    NotEvaluated,
}

/// TS: `services.ts:140-146` (`NFP_IFP_CANDIDATE_SOURCE_MASK`); this enum is
/// `NfpIfpCandidateSource` (`services.ts:148`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NfpIfpCandidateSource {
    IfpCorner,
    NfpVertex,
    AntiparallelEdgeSupport,
    IfpNfpIntersection,
    NfpNfpIntersection,
}

impl NfpIfpCandidateSource {
    pub fn mask(self) -> u32 {
        match self {
            NfpIfpCandidateSource::IfpCorner => 1,
            NfpIfpCandidateSource::NfpVertex => 2,
            NfpIfpCandidateSource::AntiparallelEdgeSupport => 4,
            NfpIfpCandidateSource::IfpNfpIntersection => 8,
            NfpIfpCandidateSource::NfpNfpIntersection => 16,
        }
    }
}

/// TS: `makeCandidateProvenance`'s `rawBySource` object literal
/// (`nfpIfpService.ts:930-936`). A plain named-field struct reproduces the
/// TS object's fixed declaration-order key enumeration without needing to
/// think about it (`nfp-ifp.md` §12 point 6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RawBySource {
    pub ifp_corner: u32,
    pub nfp_vertex: u32,
    pub antiparallel_edge_support: u32,
    pub ifp_nfp_intersection: u32,
    pub nfp_nfp_intersection: u32,
}

impl RawBySource {
    fn increment(&mut self, source: NfpIfpCandidateSource) {
        match source {
            NfpIfpCandidateSource::IfpCorner => self.ifp_corner += 1,
            NfpIfpCandidateSource::NfpVertex => self.nfp_vertex += 1,
            NfpIfpCandidateSource::AntiparallelEdgeSupport => self.antiparallel_edge_support += 1,
            NfpIfpCandidateSource::IfpNfpIntersection => self.ifp_nfp_intersection += 1,
            NfpIfpCandidateSource::NfpNfpIntersection => self.nfp_nfp_intersection += 1,
        }
    }
}

/// TS: `services.ts:163-166` (`uniqueBySourceMask` entry shape).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceMaskCount {
    pub source_mask: u32,
    pub count: u32,
}

/// TS: `services.ts:151-155` (`NfpIfpLegalCandidateSource`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NfpIfpLegalCandidateSource {
    pub grid_x: i64,
    pub grid_y: i64,
    pub source_mask: u32,
}

/// Return shape of [`generate_placement_candidates_uncached`]; see this
/// module's top-level doc for why `provenance` is a return field rather than
/// a callback invocation.
#[derive(Clone, Debug, PartialEq)]
pub struct GeneratePlacementCandidatesOutcome {
    pub candidates: Vec<IrregularPlacementCandidate>,
    pub provenance: Option<NfpIfpCandidateProvenance>,
}

// ---------------------------------------------------------------------------
// Candidate-grid-alternative generation and ordering (contractual).
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:562-566` (`CanonicalCandidatePoint`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CanonicalCandidatePoint {
    pub x: f64,
    pub y: f64,
    pub squared_distance: f64,
    pub grid_x: i64,
    pub grid_y: i64,
}

/// TS: `nfpIfpService.ts:569-593` (`canonicalPlacementPointAlternatives`).
/// Canonicalizes one raw candidate translation into up to nine
/// canonical-grid-snapped alternatives, ordered by
/// [`compare_canonical_candidate_points`] — **this order is contractual**:
/// it determines which alternative is tried first for legality admission
/// (`nfp-ifp.md` §6 item under "Legality tie rule for candidate
/// acceptance").
pub fn canonical_placement_point_alternatives(
    raw_point: IrregularPoint,
) -> Vec<CanonicalCandidatePoint> {
    let (Some(center_x), Some(center_y)) = (to_grid_mm(raw_point.x), to_grid_mm(raw_point.y))
    else {
        return Vec::new();
    };

    let mut alternatives = Vec::with_capacity(9);
    for delta_x in -1..=1 {
        for delta_y in -1..=1 {
            let grid_x = center_x + delta_x as f64;
            let grid_y = center_y + delta_y as f64;
            if !is_safe_integer(grid_x) || !is_safe_integer(grid_y) {
                continue;
            }
            let x = from_grid(grid_x);
            let y = from_grid(grid_y);
            let squared_distance =
                (x - raw_point.x) * (x - raw_point.x) + (y - raw_point.y) * (y - raw_point.y);
            alternatives.push(CanonicalCandidatePoint {
                x,
                y,
                squared_distance,
                grid_x: grid_x as i64,
                grid_y: grid_y as i64,
            });
        }
    }
    alternatives.sort_by(compare_canonical_candidate_points);
    alternatives
}

/// TS: `nfpIfpService.ts:595-604` (`compareCanonicalCandidatePoints`).
fn compare_canonical_candidate_points(
    first: &CanonicalCandidatePoint,
    second: &CanonicalCandidatePoint,
) -> std::cmp::Ordering {
    first
        .squared_distance
        .partial_cmp(&second.squared_distance)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| first.grid_x.cmp(&second.grid_x))
        .then_with(|| first.grid_y.cmp(&second.grid_y))
}

/// TS: `nfpIfpService.ts:1234-1237` (`comparePoints`). Ascending `y`, then
/// ascending `x`. Provably tie-free on the deduplicated point set this
/// sorts (`nfp-ifp.md` §5).
fn compare_points(first: &IrregularPoint, second: &IrregularPoint) -> std::cmp::Ordering {
    first
        .y
        .partial_cmp(&second.y)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            first
                .x
                .partial_cmp(&second.x)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
}

// ---------------------------------------------------------------------------
// Canonical point set (dedup + source-mask accumulation).
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:1230-1232` (`pointKey`). See this module's
/// top-level doc for why this returns a bit-pattern tuple rather than a
/// decimal string.
fn point_key(point: IrregularPoint) -> (u64, u64) {
    (point.x.to_bits(), point.y.to_bits())
}

/// TS: `nfpIfpService.ts:914-918` (`CanonicalPointSet`).
struct CanonicalPointSet {
    keys: HashSet<(u64, u64)>,
    points: Vec<IrregularPoint>,
    source_masks: HashMap<(u64, u64), u32>,
}

impl CanonicalPointSet {
    fn new() -> Self {
        Self {
            keys: HashSet::new(),
            points: Vec::new(),
            source_masks: HashMap::new(),
        }
    }
}

/// TS: `nfpIfpService.ts:920-926` (`MutableCandidateProvenance`).
#[derive(Default)]
struct MutableCandidateProvenance {
    raw_by_source: RawBySource,
    outside_ifp: u32,
    nfp_interior_rejected: u32,
    live_convex_rejected: u32,
    live_convex_legal: u32,
}

/// TS: `nfpIfpService.ts:1201-1228` (`addPoint`).
fn add_point(
    points: &mut CanonicalPointSet,
    point: IrregularPoint,
    candidate_bounds: Option<&IrregularBounds>,
    source: NfpIfpCandidateSource,
    mut provenance: Option<&mut MutableCandidateProvenance>,
) {
    if let Some(provenance) = provenance.as_deref_mut() {
        provenance.raw_by_source.increment(source);
    }
    let canonical_point =
        IrregularPoint::new(fold_negative_zero(point.x), fold_negative_zero(point.y));
    if let Some(candidate_bounds) = candidate_bounds {
        if !is_inside_bounds(canonical_point, candidate_bounds) {
            // Last use of `provenance` on this path (the function returns
            // right after), so no further reborrow is needed here.
            if let Some(provenance) = provenance {
                provenance.outside_ifp += 1;
            }
            return;
        }
    }
    let key = point_key(canonical_point);
    let source_mask = source.mask();
    if points.keys.contains(&key) {
        *points.source_masks.entry(key).or_insert(0) |= source_mask;
        return;
    }
    points.keys.insert(key);
    points.source_masks.insert(key, source_mask);
    points.points.push(canonical_point);
}

/// TS: `nfpIfpService.ts:944-981` (`emitCandidateProvenance`), minus the
/// callback-invocation guard (handled by [`generate_placement_candidates_uncached`]'s
/// `want_provenance` flag before this is ever called).
fn build_provenance_snapshot(
    accum: &MutableCandidateProvenance,
    points: Option<&CanonicalPointSet>,
    legal_candidate_source_masks: &HashMap<(i64, i64), u32>,
) -> NfpIfpCandidateProvenance {
    let mut unique_counts: HashMap<u32, u32> = HashMap::new();
    if let Some(points) = points {
        for &source_mask in points.source_masks.values() {
            *unique_counts.entry(source_mask).or_insert(0) += 1;
        }
    }
    let mut unique_by_source_mask: Vec<SourceMaskCount> = unique_counts
        .into_iter()
        .map(|(source_mask, count)| SourceMaskCount { source_mask, count })
        .collect();
    unique_by_source_mask.sort_by_key(|entry| entry.source_mask);

    let mut legal_candidate_sources: Vec<NfpIfpLegalCandidateSource> = legal_candidate_source_masks
        .iter()
        .map(
            |(&(grid_x, grid_y), &source_mask)| NfpIfpLegalCandidateSource {
                grid_x,
                grid_y,
                source_mask,
            },
        )
        .collect();
    legal_candidate_sources.sort_by(|first, second| {
        first
            .grid_y
            .cmp(&second.grid_y)
            .then_with(|| first.grid_x.cmp(&second.grid_x))
    });

    NfpIfpCandidateProvenance {
        raw_by_source: accum.raw_by_source,
        unique_by_source_mask,
        outside_ifp: accum.outside_ifp,
        nfp_interior_rejected: accum.nfp_interior_rejected,
        live_convex_rejected: accum.live_convex_rejected,
        live_convex_legal: accum.live_convex_legal,
        phase_incompatible: ProvenanceEvaluation::NotEvaluated,
        canonical_checked: ProvenanceEvaluation::NotEvaluated,
        canonical_legal: ProvenanceEvaluation::NotEvaluated,
        legal_candidate_sources,
    }
}

// ---------------------------------------------------------------------------
// BoundsIndex (nfpIfpService.ts:731-819).
// ---------------------------------------------------------------------------

struct BoundsIndexEntry<T> {
    value: T,
    bounds: IrregularBounds,
}

struct SortedBoundsIndexEntry<T> {
    value: T,
    bounds: IrregularBounds,
    source_index: usize,
}

/// TS: `nfpIfpService.ts:737-769` (`BoundsIndex`). Indexes inclusive
/// axis-aligned bounds without dropping boundary contacts.
struct BoundsIndex<T> {
    entries: Vec<SortedBoundsIndexEntry<T>>,
    prefix_max_x: Vec<f64>,
}

impl<T: Clone> BoundsIndex<T> {
    fn new(entries: Vec<BoundsIndexEntry<T>>) -> Self {
        let mut sorted: Vec<SortedBoundsIndexEntry<T>> = entries
            .into_iter()
            .enumerate()
            .map(|(source_index, entry)| SortedBoundsIndexEntry {
                value: entry.value,
                bounds: entry.bounds,
                source_index,
            })
            .collect();
        sorted.sort_by(compare_bounds_index_entries);

        let mut prefix_max_x = Vec::with_capacity(sorted.len());
        let mut current_max_x = f64::NEG_INFINITY;
        for entry in &sorted {
            current_max_x = js_math::max(current_max_x, entry.bounds.max_x);
            prefix_max_x.push(current_max_x);
        }

        Self {
            entries: sorted,
            prefix_max_x,
        }
    }

    fn query(&self, bounds: &IrregularBounds) -> Vec<T> {
        let first_index = lower_bound_at_least(&self.prefix_max_x, bounds.min_x);
        let end_index = upper_bound_min_x(&self.entries, bounds.max_x);
        let mut matches = Vec::new();
        for entry in &self.entries[first_index..end_index] {
            if !are_disjoint(&entry.bounds, bounds) {
                matches.push(entry.value.clone());
            }
        }
        matches
    }
}

/// TS: `nfpIfpService.ts:775-792` (`compareBoundsIndexEntries`).
fn compare_bounds_index_entries<T>(
    first: &SortedBoundsIndexEntry<T>,
    second: &SortedBoundsIndexEntry<T>,
) -> std::cmp::Ordering {
    first
        .bounds
        .min_x
        .partial_cmp(&second.bounds.min_x)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| {
            first
                .bounds
                .max_x
                .partial_cmp(&second.bounds.max_x)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            first
                .bounds
                .min_y
                .partial_cmp(&second.bounds.min_y)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| {
            first
                .bounds
                .max_y
                .partial_cmp(&second.bounds.max_y)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .then_with(|| first.source_index.cmp(&second.source_index))
}

/// TS: `nfpIfpService.ts:794-804` (`lowerBoundAtLeast`).
fn lower_bound_at_least(values: &[f64], target: f64) -> usize {
    let mut start = 0usize;
    let mut end = values.len();
    while start < end {
        let middle = start + (end - start) / 2;
        if values[middle] < target {
            start = middle + 1;
        } else {
            end = middle;
        }
    }
    start
}

/// TS: `nfpIfpService.ts:806-819` (`upperBoundMinX`).
fn upper_bound_min_x<T>(entries: &[SortedBoundsIndexEntry<T>], target: f64) -> usize {
    let mut start = 0usize;
    let mut end = entries.len();
    while start < end {
        let middle = start + (end - start) / 2;
        if entries[middle].bounds.min_x <= target {
            start = middle + 1;
        } else {
            end = middle;
        }
    }
    start
}

// ---------------------------------------------------------------------------
// Segments and intersections.
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:821-825` (`Segment`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Segment {
    start: IrregularPoint,
    end: IrregularPoint,
    bounds: IrregularBounds,
}

/// TS: `nfpIfpService.ts:827-836` (`NfpBoundary`).
struct NfpBoundary {
    index: usize,
    fixed: Arc<IrregularPlacedPiece>,
    boundary: IrregularPolygon,
    winding: ConvexPolygonWinding,
    bounds: IrregularBounds,
    segments: Vec<Segment>,
    segment_index: BoundsIndex<Segment>,
}

/// TS: `nfpIfpService.ts:994-1001` (`rectangleCorners`).
fn rectangle_corners(bounds: &IrregularBounds) -> [IrregularPoint; 4] {
    [
        IrregularPoint::new(bounds.min_x, bounds.min_y),
        IrregularPoint::new(bounds.max_x, bounds.min_y),
        IrregularPoint::new(bounds.max_x, bounds.max_y),
        IrregularPoint::new(bounds.min_x, bounds.max_y),
    ]
}

/// TS: `nfpIfpService.ts:1003-1006` (`rectangleSegments`).
fn rectangle_segments(bounds: &IrregularBounds) -> Vec<Segment> {
    polygon_segments(&rectangle_corners(bounds))
}

/// TS: `nfpIfpService.ts:1008-1018` (`polygonSegments`).
fn polygon_segments(points: &[IrregularPoint]) -> Vec<Segment> {
    let len = points.len();
    let mut segments = Vec::with_capacity(len);
    for index in 0..len {
        let start = points[index];
        let end = points[(index + 1) % len];
        segments.push(Segment {
            start,
            end,
            bounds: segment_bounds(start, end),
        });
    }
    segments
}

/// TS: `nfpIfpService.ts:1020-1027` (`segmentBounds`).
fn segment_bounds(first: IrregularPoint, second: IrregularPoint) -> IrregularBounds {
    IrregularBounds::new(
        js_math::min(first.x, second.x),
        js_math::min(first.y, second.y),
        js_math::max(first.x, second.x),
        js_math::max(first.y, second.y),
    )
}

struct SegmentIntersection {
    points: Vec<IrregularPoint>,
}

/// TS: `nfpIfpService.ts:1086-1186` (`intersectSegments`). Preserves the
/// exact three-stage numeric strategy documented in `nfp-ifp.md` §7 item
/// "Segment-intersection numeric strategy": (1) exact-predicate proper-crossing
/// classification; (2) primary Cramer's-rule solve when the floating
/// denominator is nonzero; (3) a bounded signed-area-ratio fallback,
/// requiring strictly opposite signs and an interior `(0, 1)` parameter, for
/// the case where exact predicates prove a crossing but the floating
/// denominator rounds to exactly zero.
fn intersect_segments(first: &Segment, second: &Segment) -> Result<SegmentIntersection, String> {
    let first_start_turn = orientation_of(first.start, first.end, second.start);
    let first_end_turn = orientation_of(first.start, first.end, second.end);
    let second_start_turn = orientation_of(second.start, second.end, first.start);
    let second_end_turn = orientation_of(second.start, second.end, first.end);

    if first_start_turn != 0
        && first_end_turn != 0
        && second_start_turn != 0
        && second_end_turn != 0
        && first_start_turn != first_end_turn
        && second_start_turn != second_end_turn
    {
        let first_direction_x = first.end.x - first.start.x;
        let first_direction_y = first.end.y - first.start.y;
        let second_direction_x = second.end.x - second.start.x;
        let second_direction_y = second.end.y - second.start.y;
        let denominator =
            first_direction_x * second_direction_y - first_direction_y * second_direction_x;
        let offset_x = second.start.x - first.start.x;
        let offset_y = second.start.y - first.start.y;
        let numerator = offset_x * second_direction_y - offset_y * second_direction_x;
        if !first_direction_x.is_finite()
            || !first_direction_y.is_finite()
            || !second_direction_x.is_finite()
            || !second_direction_y.is_finite()
            || !denominator.is_finite()
            || !offset_x.is_finite()
            || !offset_y.is_finite()
            || !numerator.is_finite()
        {
            return Err(
                "segment intersection arithmetic must produce finite coordinates.".to_string(),
            );
        }

        if denominator != 0.0 {
            let parameter = numerator / denominator;
            let x = first.start.x + parameter * first_direction_x;
            let y = first.start.y + parameter * first_direction_y;
            if !parameter.is_finite() || !x.is_finite() || !y.is_finite() {
                return Err(
                    "segment intersection arithmetic must produce finite coordinates.".to_string(),
                );
            }
            return Ok(SegmentIntersection {
                points: vec![IrregularPoint::new(x, y)],
            });
        }

        let second_end_offset_x = second.end.x - first.start.x;
        let second_end_offset_y = second.end.y - first.start.y;
        let start_area = first_direction_x * offset_y - first_direction_y * offset_x;
        let end_area =
            first_direction_x * second_end_offset_y - first_direction_y * second_end_offset_x;
        if !second_end_offset_x.is_finite()
            || !second_end_offset_y.is_finite()
            || !start_area.is_finite()
            || !end_area.is_finite()
        {
            return Err(
                "segment intersection arithmetic must produce finite coordinates.".to_string(),
            );
        }

        let opposite_signs =
            (start_area > 0.0 && end_area < 0.0) || (start_area < 0.0 && end_area > 0.0);
        let fallback_parameter = start_area / (start_area - end_area);
        let fallback_x = second.start.x + fallback_parameter * second_direction_x;
        let fallback_y = second.start.y + fallback_parameter * second_direction_y;
        if !opposite_signs
            || !fallback_parameter.is_finite()
            || fallback_parameter <= 0.0
            || fallback_parameter >= 1.0
            || !fallback_x.is_finite()
            || !fallback_y.is_finite()
        {
            return Ok(SegmentIntersection { points: vec![] });
        }
        let fallback_point = IrregularPoint::new(fallback_x, fallback_y);
        if !point_is_within_segment_bounds(fallback_point, first)
            || !point_is_within_segment_bounds(fallback_point, second)
        {
            return Ok(SegmentIntersection { points: vec![] });
        }
        return Ok(SegmentIntersection {
            points: vec![fallback_point],
        });
    }

    let mut points = Vec::new();
    if first_start_turn == 0 && point_is_within_segment_bounds(second.start, first) {
        points.push(second.start);
    }
    if first_end_turn == 0 && point_is_within_segment_bounds(second.end, first) {
        points.push(second.end);
    }
    if second_start_turn == 0 && point_is_within_segment_bounds(first.start, second) {
        points.push(first.start);
    }
    if second_end_turn == 0 && point_is_within_segment_bounds(first.end, second) {
        points.push(first.end);
    }
    Ok(SegmentIntersection { points })
}

/// TS: `nfpIfpService.ts:1188-1195` (`pointIsWithinSegmentBounds`).
fn point_is_within_segment_bounds(point: IrregularPoint, segment: &Segment) -> bool {
    point.x >= js_math::min(segment.start.x, segment.end.x)
        && point.x <= js_math::max(segment.start.x, segment.end.x)
        && point.y >= js_math::min(segment.start.y, segment.end.y)
        && point.y <= js_math::max(segment.start.y, segment.end.y)
}

/// TS: `nfpIfpService.ts:1029-1068` (`addBoundaryIntersections`). Checkpoints
/// every 32 candidate second-segments examined (`pairIndex % 32 === 0`,
/// counted regardless of whether a candidate is pruned by `areDisjoint`).
#[allow(clippy::too_many_arguments)]
fn add_boundary_intersections(
    points: &mut CanonicalPointSet,
    first_segments: &[Segment],
    second_segments: &[Segment],
    second_segment_index: Option<&BoundsIndex<Segment>>,
    candidate_bounds: Option<&IrregularBounds>,
    // `&mut Option<&mut dyn NfpIfpControl>` (double indirection), not
    // `Option<&mut dyn NfpIfpControl>` by value -- see `nfp_checkpoint`'s doc
    // comment for why repeatedly reborrowing a `dyn Trait` reference across
    // loop iterations needs this shape to satisfy the borrow checker.
    control: &mut Option<&mut dyn NfpIfpControl>,
    mut telemetry: Option<&mut NfpIfpTelemetry>,
    phase: NfpIfpCheckpointPhase,
    source: NfpIfpCandidateSource,
    mut provenance: Option<&mut MutableCandidateProvenance>,
) -> Result<Option<String>, super::service::NfpIfpControlAbortError> {
    for first in first_segments {
        let first_query_bounds = match candidate_bounds {
            None => Some(first.bounds),
            Some(candidate_bounds) => intersection_bounds(&first.bounds, candidate_bounds),
        };
        let Some(first_query_bounds) = first_query_bounds else {
            continue;
        };

        let possible_second_segments: Vec<Segment> = match second_segment_index {
            None => second_segments.to_vec(),
            Some(index) => index.query(&first_query_bounds),
        };

        for (pair_index, second) in possible_second_segments.iter().enumerate() {
            if pair_index % 32 == 0 {
                nfp_checkpoint(control, phase, telemetry.as_deref_mut())?;
            }
            if let Some(candidate_bounds) = candidate_bounds {
                if are_disjoint(&second.bounds, candidate_bounds) {
                    continue;
                }
            }
            match intersect_segments(first, second) {
                Err(message) => return Ok(Some(message)),
                Ok(intersection) => {
                    for point in intersection.points {
                        add_point(
                            points,
                            point,
                            candidate_bounds,
                            source,
                            provenance.as_deref_mut(),
                        );
                    }
                }
            }
        }
    }
    Ok(None)
}

/// TS: `nfpIfpService.ts:1243-1253` (`intersectionBounds`).
fn intersection_bounds(
    first: &IrregularBounds,
    second: &IrregularBounds,
) -> Option<IrregularBounds> {
    let min_x = js_math::max(first.min_x, second.min_x);
    let min_y = js_math::max(first.min_y, second.min_y);
    let max_x = js_math::min(first.max_x, second.max_x);
    let max_y = js_math::min(first.max_y, second.max_y);
    if min_x > max_x || min_y > max_y {
        None
    } else {
        Some(IrregularBounds::new(min_x, min_y, max_x, max_y))
    }
}

// ---------------------------------------------------------------------------
// Antiparallel edge support points.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct PolygonEdge {
    start: IrregularPoint,
    end: IrregularPoint,
}

/// TS: `nfpIfpService.ts:899-908` (`polygonEdgesFromPoints`).
fn polygon_edges_from_points(points: &[IrregularPoint]) -> Vec<PolygonEdge> {
    let len = points.len();
    let mut edges = Vec::with_capacity(len);
    for index in 0..len {
        edges.push(PolygonEdge {
            start: points[index],
            end: points[(index + 1) % len],
        });
    }
    edges
}

fn is_finite_point(point: IrregularPoint) -> bool {
    point.x.is_finite() && point.y.is_finite()
}

/// TS: `nfpIfpService.ts:846-892` (`addAntiparallelEdgeSupportPoints`). Adds
/// endpoint alignments for antiparallel fixed and moving edges. No
/// checkpoint exists inside this `O(edges_fixed × edges_moving)` nested loop
/// (`nfp-ifp.md` §10's closing paragraph — matches the current
/// specification's exact granularity, must not be added).
fn add_antiparallel_edge_support_points(
    points: &mut CanonicalPointSet,
    fixed: &IrregularPlacedPiece,
    moving: &TransformedCollisionGeometry,
    candidate_bounds: Option<&IrregularBounds>,
    mut provenance: Option<&mut MutableCandidateProvenance>,
) -> Option<String> {
    let fixed_translation = &fixed.placement.transform;
    let fixed_points: Vec<IrregularPoint> = fixed
        .collision_geometry
        .polygon
        .points
        .iter()
        .map(|point| {
            IrregularPoint::new(
                point.x + fixed_translation.translate_x,
                point.y + fixed_translation.translate_y,
            )
        })
        .collect();
    let moving_points = &moving.polygon.points;

    for fixed_edge in polygon_edges_from_points(&fixed_points) {
        let fixed_direction = IrregularPoint::new(
            fixed_edge.end.x - fixed_edge.start.x,
            fixed_edge.end.y - fixed_edge.start.y,
        );
        for moving_edge in polygon_edges_from_points(moving_points) {
            let moving_direction = IrregularPoint::new(
                moving_edge.end.x - moving_edge.start.x,
                moving_edge.end.y - moving_edge.start.y,
            );
            if orientation_of(ORIGIN, fixed_direction, moving_direction) != 0 {
                continue;
            }

            let direction_dot_product =
                fixed_direction.x * moving_direction.x + fixed_direction.y * moving_direction.y;
            if !direction_dot_product.is_finite() || direction_dot_product >= 0.0 {
                continue;
            }

            let first_support_point = IrregularPoint::new(
                fixed_edge.start.x - moving_edge.end.x,
                fixed_edge.start.y - moving_edge.end.y,
            );
            let second_support_point = IrregularPoint::new(
                fixed_edge.end.x - moving_edge.start.x,
                fixed_edge.end.y - moving_edge.start.y,
            );
            if !is_finite_point(first_support_point) || !is_finite_point(second_support_point) {
                return Some(
                    "antiparallel edge support arithmetic must produce finite coordinates."
                        .to_string(),
                );
            }
            add_point(
                points,
                first_support_point,
                candidate_bounds,
                NfpIfpCandidateSource::AntiparallelEdgeSupport,
                provenance.as_deref_mut(),
            );
            add_point(
                points,
                second_support_point,
                candidate_bounds,
                NfpIfpCandidateSource::AntiparallelEdgeSupport,
                provenance.as_deref_mut(),
            );
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Small geometric predicates local to this module.
// ---------------------------------------------------------------------------

fn is_inside_bounds(point: IrregularPoint, bounds: &IrregularBounds) -> bool {
    point.x >= bounds.min_x
        && point.x <= bounds.max_x
        && point.y >= bounds.min_y
        && point.y <= bounds.max_y
}

/// TS: `nfpIfpService.ts:1264-1277` (`isStrictlyInside`).
fn is_strictly_inside(
    point: IrregularPoint,
    polygon: &IrregularPolygon,
    winding: ConvexPolygonWinding,
) -> bool {
    let len = polygon.points.len();
    for index in 0..len {
        let start = polygon.points[index];
        let end = polygon.points[(index + 1) % len];
        let turn = orientation_of(start, end, point);
        if turn == 0 || turn != winding {
            return false;
        }
    }
    true
}

fn point_bounds(point: IrregularPoint) -> IrregularBounds {
    IrregularBounds::new(point.x, point.y, point.x, point.y)
}

fn orientation_of(origin: IrregularPoint, first: IrregularPoint, second: IrregularPoint) -> i32 {
    predicates::orientation(origin.x, origin.y, first.x, first.y, second.x, second.y)
}

// ---------------------------------------------------------------------------
// The main entry point.
// ---------------------------------------------------------------------------

/// TS: `nfpIfpService.ts:267-560` (`generatePlacementCandidatesUncached`).
/// Builds deterministic IFP/NFP contact candidates and filters illegal
/// results. See `nfp-ifp.md` §6/§10 for the exact ordering/cancellation
/// contract this preserves.
pub fn generate_placement_candidates_uncached(
    input: &GeneratePlacementCandidatesInput<'_>,
    geometry_cache: &mut GeometryCacheStore,
    construction_algorithm: NfpConstructionAlgorithm,
    candidate_pruning_mode: NfpCandidatePruningMode,
    mut control: Option<&mut dyn NfpIfpControl>,
    mut telemetry: Option<&mut NfpIfpTelemetry>,
) -> Result<GeneratePlacementCandidatesOutcome, NfpIfpError> {
    let mut provenance = if input.want_provenance {
        Some(MutableCandidateProvenance::default())
    } else {
        None
    };
    let sheetless_nfp = input.candidate_domain == CandidateDomain::SheetlessNfp;

    nfp_checkpoint(
        &mut control,
        NfpIfpCheckpointPhase::Ifp,
        telemetry.as_deref_mut(),
    )
    .map_err(NfpIfpError::Abort)?;

    let ifp: Option<IrregularBounds> = if sheetless_nfp {
        None
    } else {
        let key_input = InnerFitBoundsKeyInput {
            sheet: input.sheet,
            moving: input.moving,
        };
        match resolve_ifp_bounds(&key_input, geometry_cache) {
            Ok(success) => Some(success.value.bounds),
            Err(failure) => {
                if matches!(failure.kind, CoreIfpBoundsFailureKind::Invalid) {
                    return Err(NfpIfpError::Geometry(invalid_geometry(
                        "computeIfpBounds",
                        failure.message,
                    )));
                }
                None
            }
        }
    };

    if !sheetless_nfp && ifp.is_none() {
        let snapshot = provenance
            .as_ref()
            .map(|accum| build_provenance_snapshot(accum, None, &HashMap::new()));
        return Ok(GeneratePlacementCandidatesOutcome {
            candidates: Vec::new(),
            provenance: snapshot,
        });
    }

    nfp_checkpoint(
        &mut control,
        NfpIfpCheckpointPhase::Ifp,
        telemetry.as_deref_mut(),
    )
    .map_err(NfpIfpError::Abort)?;

    let placed_collision_index = input
        .placed_collision_index
        .filter(|index| index.matches(input.placed));

    // PAR-CACHE-01 / PAR-NFP-01 (parallelism-inventory.md §3.2-3.3): warm
    // `geometry_cache` with every distinct relative-NFP boundary the loop
    // below will need, computed in parallel across this job's Rayon pool.
    // The loop itself is completely unmodified beneath this call -- see
    // `super::boundary_core::precompute_missing_relative_nfp_boundaries`'s
    // doc for the exact compute-then-publish contract this satisfies (no
    // cache mutation from worker threads; no new cancellation-observation
    // point; a precompute failure is silently discarded and re-derived,
    // in original order, by the loop's own unmodified `resolve_nfp_boundary`
    // call).
    super::boundary_core::precompute_missing_relative_nfp_boundaries(
        input.placed,
        input.moving,
        &input.settings.geometry,
        geometry_cache,
        construction_algorithm,
    );

    let mut nfp_boundaries: Vec<NfpBoundary> = Vec::new();
    for placed in input.placed {
        nfp_checkpoint(
            &mut control,
            NfpIfpCheckpointPhase::PlacedNfp,
            telemetry.as_deref_mut(),
        )
        .map_err(NfpIfpError::Abort)?;

        let core_input = CoreNfpInput {
            fixed: placed.as_ref(),
            moving: input.moving,
            settings: &input.settings.geometry,
        };
        let boundary =
            match resolve_nfp_boundary(&core_input, geometry_cache, construction_algorithm) {
                Ok(success) => success.boundary,
                Err(message) => {
                    return Err(NfpIfpError::Geometry(invalid_geometry(
                        "computeNfp",
                        message,
                    )));
                }
            };

        nfp_checkpoint(
            &mut control,
            NfpIfpCheckpointPhase::PlacedNfp,
            telemetry.as_deref_mut(),
        )
        .map_err(NfpIfpError::Abort)?;

        let winding = match validate_strict_boundary(&boundary.points) {
            StrictConvexBoundaryValidation::Invalid { message } => {
                return Err(NfpIfpError::Geometry(invalid_geometry(
                    "generatePlacementCandidates",
                    message,
                )));
            }
            StrictConvexBoundaryValidation::Valid { winding } => winding,
        };
        let bounds = bounds_for_points(&boundary.points).ok_or_else(|| {
            NfpIfpError::Geometry(invalid_geometry(
                "generatePlacementCandidates",
                "NFP boundary bounds must be finite.".to_string(),
            ))
        })?;
        let segments = polygon_segments(&boundary.points);
        let segment_index = BoundsIndex::new(
            segments
                .iter()
                .map(|segment| BoundsIndexEntry {
                    value: *segment,
                    bounds: segment.bounds,
                })
                .collect(),
        );
        nfp_boundaries.push(NfpBoundary {
            index: nfp_boundaries.len(),
            fixed: Arc::clone(placed),
            boundary,
            winding,
            bounds,
            segments,
            segment_index,
        });
    }

    nfp_checkpoint(
        &mut control,
        NfpIfpCheckpointPhase::Ifp,
        telemetry.as_deref_mut(),
    )
    .map_err(NfpIfpError::Abort)?;

    let ifp_bounds = ifp;
    let ifp_segments: Vec<Segment> = match &ifp_bounds {
        Some(bounds) => rectangle_segments(bounds),
        None => Vec::new(),
    };
    let contact_only = input.candidate_domain != CandidateDomain::Sheet;
    let mut points = CanonicalPointSet::new();

    let all_nfp_index = BoundsIndex::new(
        nfp_boundaries
            .iter()
            .map(|boundary| BoundsIndexEntry {
                value: boundary.index,
                bounds: boundary.bounds,
            })
            .collect(),
    );

    let candidate_nfp_boundary_indices: Vec<usize> =
        if sheetless_nfp || candidate_pruning_mode != NfpCandidatePruningMode::Indexed {
            (0..nfp_boundaries.len()).collect()
        } else {
            match &ifp_bounds {
                None => Vec::new(),
                Some(bounds) => all_nfp_index.query(bounds),
            }
        };
    let candidate_nfp_index = BoundsIndex::new(
        candidate_nfp_boundary_indices
            .iter()
            .map(|&index| BoundsIndexEntry {
                value: index,
                bounds: nfp_boundaries[index].bounds,
            })
            .collect(),
    );
    let candidate_bounds: Option<IrregularBounds> =
        if !sheetless_nfp && candidate_pruning_mode == NfpCandidatePruningMode::Indexed {
            ifp_bounds
        } else {
            None
        };

    if input.placed.is_empty() && input.candidate_domain == CandidateDomain::ContactOnly {
        if let Some(bounds) = &ifp_bounds {
            add_point(
                &mut points,
                IrregularPoint::new(bounds.min_x, bounds.min_y),
                candidate_bounds.as_ref(),
                NfpIfpCandidateSource::IfpCorner,
                provenance.as_mut(),
            );
        }
    } else if !contact_only {
        if let Some(bounds) = &ifp_bounds {
            for corner in rectangle_corners(bounds) {
                add_point(
                    &mut points,
                    corner,
                    candidate_bounds.as_ref(),
                    NfpIfpCandidateSource::IfpCorner,
                    provenance.as_mut(),
                );
            }
        }
    }

    for &boundary_index in &candidate_nfp_boundary_indices {
        let boundary_points = nfp_boundaries[boundary_index].boundary.points.clone();
        for point in boundary_points {
            add_point(
                &mut points,
                point,
                candidate_bounds.as_ref(),
                NfpIfpCandidateSource::NfpVertex,
                provenance.as_mut(),
            );
        }
        let support_message = {
            let boundary = &nfp_boundaries[boundary_index];
            add_antiparallel_edge_support_points(
                &mut points,
                boundary.fixed.as_ref(),
                input.moving,
                candidate_bounds.as_ref(),
                provenance.as_mut(),
            )
        };
        if let Some(message) = support_message {
            return Err(NfpIfpError::Geometry(invalid_geometry(
                "generatePlacementCandidates",
                message,
            )));
        }
    }

    if !contact_only {
        for &boundary_index in &candidate_nfp_boundary_indices {
            nfp_checkpoint(
                &mut control,
                NfpIfpCheckpointPhase::IfpBoundaryIntersection,
                telemetry.as_deref_mut(),
            )
            .map_err(NfpIfpError::Abort)?;

            let message = {
                let boundary = &nfp_boundaries[boundary_index];
                let segment_index_ref =
                    if candidate_pruning_mode == NfpCandidatePruningMode::Indexed {
                        Some(&boundary.segment_index)
                    } else {
                        None
                    };
                add_boundary_intersections(
                    &mut points,
                    &ifp_segments,
                    &boundary.segments,
                    segment_index_ref,
                    candidate_bounds.as_ref(),
                    &mut control,
                    telemetry.as_deref_mut(),
                    NfpIfpCheckpointPhase::IfpBoundaryIntersection,
                    NfpIfpCandidateSource::IfpNfpIntersection,
                    provenance.as_mut(),
                )
            }
            .map_err(NfpIfpError::Abort)?;
            if let Some(message) = message {
                return Err(NfpIfpError::Geometry(invalid_geometry(
                    "generatePlacementCandidates",
                    message,
                )));
            }
        }
    }

    if candidate_pruning_mode == NfpCandidatePruningMode::Indexed {
        for &first_index in &candidate_nfp_boundary_indices {
            nfp_checkpoint(
                &mut control,
                NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection,
                telemetry.as_deref_mut(),
            )
            .map_err(NfpIfpError::Abort)?;
            let first_bounds = nfp_boundaries[first_index].bounds;
            let second_indices = candidate_nfp_index.query(&first_bounds);
            for second_index in second_indices {
                if second_index <= first_index {
                    continue;
                }
                nfp_checkpoint(
                    &mut control,
                    NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection,
                    telemetry.as_deref_mut(),
                )
                .map_err(NfpIfpError::Abort)?;

                let message = {
                    let first = &nfp_boundaries[first_index];
                    let second = &nfp_boundaries[second_index];
                    add_boundary_intersections(
                        &mut points,
                        &first.segments,
                        &second.segments,
                        Some(&second.segment_index),
                        candidate_bounds.as_ref(),
                        &mut control,
                        telemetry.as_deref_mut(),
                        NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection,
                        NfpIfpCandidateSource::NfpNfpIntersection,
                        provenance.as_mut(),
                    )
                }
                .map_err(NfpIfpError::Abort)?;
                if let Some(message) = message {
                    return Err(NfpIfpError::Geometry(invalid_geometry(
                        "generatePlacementCandidates",
                        message,
                    )));
                }
            }
        }
    } else {
        for first_index in 0..nfp_boundaries.len() {
            for second_index in (first_index + 1)..nfp_boundaries.len() {
                nfp_checkpoint(
                    &mut control,
                    NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection,
                    telemetry.as_deref_mut(),
                )
                .map_err(NfpIfpError::Abort)?;
                if are_disjoint(
                    &nfp_boundaries[first_index].bounds,
                    &nfp_boundaries[second_index].bounds,
                ) {
                    continue;
                }
                let message = {
                    let first = &nfp_boundaries[first_index];
                    let second = &nfp_boundaries[second_index];
                    add_boundary_intersections(
                        &mut points,
                        &first.segments,
                        &second.segments,
                        None,
                        None,
                        &mut control,
                        telemetry.as_deref_mut(),
                        NfpIfpCheckpointPhase::PairwiseNfpBoundaryIntersection,
                        NfpIfpCandidateSource::NfpNfpIntersection,
                        provenance.as_mut(),
                    )
                }
                .map_err(NfpIfpError::Abort)?;
                if let Some(message) = message {
                    return Err(NfpIfpError::Geometry(invalid_geometry(
                        "generatePlacementCandidates",
                        message,
                    )));
                }
            }
        }
    }

    let mut sorted_points: Vec<IrregularPoint> = points.points.clone();
    sorted_points.sort_by(compare_points);

    let mut accepted_grid_keys: HashSet<(i64, i64)> = HashSet::new();
    let mut legal_candidate_source_masks: HashMap<(i64, i64), u32> = HashMap::new();
    let mut candidates: Vec<IrregularPlacementCandidate> = Vec::new();

    for (point_index, raw_point) in sorted_points.iter().enumerate() {
        if point_index % 32 == 0 {
            nfp_checkpoint(
                &mut control,
                NfpIfpCheckpointPhase::CandidatePoints,
                telemetry.as_deref_mut(),
            )
            .map_err(NfpIfpError::Abort)?;
        }
        let source_mask = points
            .source_masks
            .get(&point_key(*raw_point))
            .copied()
            .unwrap_or(0);

        for candidate in canonical_placement_point_alternatives(*raw_point) {
            let candidate_point = IrregularPoint::new(candidate.x, candidate.y);
            if !sheetless_nfp {
                match &ifp_bounds {
                    None => continue,
                    Some(bounds) => {
                        if !is_inside_bounds(candidate_point, bounds) {
                            continue;
                        }
                    }
                }
            }

            let strictly_inside_any = if candidate_pruning_mode == NfpCandidatePruningMode::Indexed
            {
                candidate_nfp_index
                    .query(&point_bounds(candidate_point))
                    .into_iter()
                    .any(|index| {
                        let boundary = &nfp_boundaries[index];
                        is_inside_bounds(candidate_point, &boundary.bounds)
                            && is_strictly_inside(
                                candidate_point,
                                &boundary.boundary,
                                boundary.winding,
                            )
                    })
            } else {
                nfp_boundaries.iter().any(|boundary| {
                    is_inside_bounds(candidate_point, &boundary.bounds)
                        && is_strictly_inside(candidate_point, &boundary.boundary, boundary.winding)
                })
            };
            if strictly_inside_any {
                if let Some(provenance) = provenance.as_mut() {
                    provenance.nfp_interior_rejected += 1;
                }
                continue;
            }

            let assess_input = AssessPlacementInput {
                sheet: if sheetless_nfp {
                    None
                } else {
                    Some(input.sheet)
                },
                placed: input.placed,
                placed_collision_index,
                moving: input.moving,
                candidate_point,
            };
            // Assessed synchronously (`nfpIfpService.ts:530-531`'s own
            // comment: "this runs once per candidate point... an Effect per
            // point was pure overhead"); this Rust port has no suspension
            // mechanism to reproduce there in the first place.
            let legal = match assess_placement(&assess_input, !sheetless_nfp) {
                AssessPlacementOutcome::Failure(err) => return Err(NfpIfpError::Geometry(err)),
                AssessPlacementOutcome::Assessment(assessment) => assessment.legal,
            };
            if !legal {
                if let Some(provenance) = provenance.as_mut() {
                    provenance.live_convex_rejected += 1;
                }
                continue;
            }
            if let Some(provenance) = provenance.as_mut() {
                provenance.live_convex_legal += 1;
            }

            let grid_key = (candidate.grid_x, candidate.grid_y);
            *legal_candidate_source_masks.entry(grid_key).or_insert(0) |= source_mask;

            if !accepted_grid_keys.contains(&grid_key) {
                accepted_grid_keys.insert(grid_key);
                candidates.push(IrregularPlacementCandidate {
                    piece_id: input.moving.source_piece_id.clone(),
                    transform: input.moving.transform,
                    point: candidate_point,
                    diagnostics: Vec::new(),
                });
            }
            break;
        }
    }

    // Last use of `telemetry` in this function, so it is passed by value
    // rather than reborrowed.
    nfp_checkpoint(
        &mut control,
        NfpIfpCheckpointPhase::CandidatePoints,
        telemetry,
    )
    .map_err(NfpIfpError::Abort)?;

    let final_provenance = provenance.as_ref().map(|accum| {
        build_provenance_snapshot(accum, Some(&points), &legal_candidate_source_masks)
    });

    Ok(GeneratePlacementCandidatesOutcome {
        candidates,
        provenance: final_provenance,
    })
}
