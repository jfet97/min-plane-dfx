//! Scores only derived state quality for one complete-or-partial irregular
//! beam state. Free material never accepts or rejects a placement; NFP/IFP
//! generation and direct validation own that decision.
//!
//! TS source: `src/workers/algorithm/irregular/irregularLayoutScorer.ts` (585
//! lines). Read together with
//! `docs/planning/rust-irregular-backend/characterization/search-scoring.md`
//! before touching this file -- in particular §1 ("headline finding"): on
//! the production Compact/Compact Short Side path this module's comparator
//! chains (`compare_scores`/`layout_score_order` and everything they
//! dispatch to) are **not** reachable; only [`score_state`]'s pure value
//! computation is live, called exactly once per completed production job
//! (`computeIrregularNesting.ts`'s four mutually-exclusive `materialize*`
//! call sites). The comparators are still ported here byte-exact per
//! `search-scoring.md` §15 item 1's recommendation -- see
//! `placement_scorer`'s matching top-doc note for the same reasoning.
//!
//! # Seam: `search::beam_state::IrregularBeamState`
//!
//! TS's `ScoreIrregularLayoutInput.state: IrregularBeamState` is a rich,
//! separately-ported type (`irregularBeamState.ts`, 986 lines) owned by a
//! concurrently-running task (`search::beam_state`, out of this task's
//! file-ownership scope -- this module must not edit it or block on it).
//! [`LayoutScorerBeamStateView`] below is a **provisional seam type**
//! carrying exactly the subset of `IrregularBeamState`'s fields TS's
//! `scoreState`/`computeSnapshotWithParentFallback`/`scoreDerivedState`/
//! `deriveRawOccupiedHullWasteRatio`/`getNewlyPlacedGeometry` read
//! (`irregularBeamState.ts:30-38,52-58` for the field shapes). Once
//! `search::beam_state::IrregularBeamState` exists, [`ScoreIrregularLayoutInput::state`]
//! should hold a reference/`Arc` to the real type instead and this struct
//! should be deleted -- every field name below already matches the real
//! type's corresponding field 1:1 to make that swap mechanical.
//!
//! `placed_collision_geometries` and `parent` are threaded through `Arc`
//! (matching `validation::placement`'s established convention for the same
//! JS-reference-identity requirement): TS's `getNewlyPlacedGeometry`
//! (`irregularLayoutScorer.ts:206-222`) relies on `!==` object-reference
//! inequality between specific `IrregularPlacedPiece` array elements across
//! two related state instances, which `Arc::ptr_eq` reproduces exactly
//! (never structural/value equality -- two value-equal-but-distinct pieces
//! must not satisfy this check, per `search-scoring.md` §12 item 8).
//!
//! # What this module does not port
//!
//! `IrregularLayoutScorer` is an `effect` `Context.Service` in TS with
//! `.Make`/`.Layer`/`.Live` static members implementing dependency injection
//! and a closure-captured `freeMaterialCache` (`irregularLayoutScorer.ts:119-154`).
//! Per this task's instructions ("port the pure computation"), this module
//! ports [`score_state`] and its full free-material-cache access sequence as
//! plain functions operating on an explicitly job-owned [`FreeMaterialCache`]
//! value, not a DI-resolved service object -- matching this crate's
//! established convention (see `placement_scorer`'s matching top-doc note).

use std::cmp::Ordering;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde::Serialize;

use crate::domain::{
    FreeMaterialSnapshot, IrregularNestingSettings, IrregularPlacedPiece, IrregularPoint,
    IrregularPolygon, PieceId, SheetSpec,
};
use crate::geometry::free_material::{
    compute_free_material, extend_free_material, ComputeFreeMaterialInput, ExtendFreeMaterialInput,
};
use crate::geometry::predicates;
use crate::js_number::{is_safe_integer, js_math, number_to_js_string};
use crate::transforms::generator::IrregularGeometryInputError;

use super::score_grid::{self, cmp_number};

/// TS: `irregularLayoutScorer.ts:22-25` `IrregularLayoutScoringError`. See
/// `placement_scorer::IrregularPlacementScoringError`'s doc comment for why
/// there is no `_tag`/Effect-error equivalent here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IrregularLayoutScoringError {
    pub operation: String,
    pub message: String,
}

/// TS: `irregularLayoutScorer.ts:101-104` `IrregularLayoutScorerError` union
/// (`IrregularLayoutScoringError | IrregularGeometryInputError |
/// IrregularNestingNotImplementedError`). The third arm is omitted: this
/// port's [`compute_free_material`]/[`extend_free_material`] (per
/// `geometry::free_material`'s own doc, "GREEN modules to reuse") never
/// return it -- their Rust signatures only ever produce
/// `IrregularGeometryInputError`, so that arm is unreachable here, exactly
/// as it already is for those two functions' own `Result` types.
#[derive(Clone, Debug, PartialEq)]
pub enum IrregularLayoutScorerError {
    Scoring(IrregularLayoutScoringError),
    GeometryInput(IrregularGeometryInputError),
}

/// TS: `irregularBeamState.ts:21-28` `IrregularCollisionBounds`. All fields
/// always finite together or the whole value is `None` (never partially
/// finite) -- enforced by whichever module derives
/// [`LayoutScorerBeamStateView::translated_collision_bounds`], not by this
/// type itself.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrregularCollisionBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub width: f64,
    pub height: f64,
}

/// See this module's top doc, "Seam: `search::beam_state::IrregularBeamState`".
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutScorerBeamStateView {
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub translated_collision_bounds: Option<IrregularCollisionBounds>,
    pub shared_collision_boundary_length_mm: Option<f64>,
    pub shared_collision_boundary_contact_units: Option<f64>,
    pub near_complete_structural_contact_count: Option<f64>,
    pub dominant_near_complete_structural_contact_count: Option<f64>,
    pub canonical_occupied_geometry_key: String,
    pub placement_order: Vec<PieceId>,
    pub unplaced_source_piece_ids: Vec<PieceId>,
    pub parent: Option<Arc<LayoutScorerBeamStateView>>,
}

/// TS: `irregularLayoutScorer.ts:27-30` `ScoreIrregularLayoutInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct ScoreIrregularLayoutInput {
    pub sheet: SheetSpec,
    pub state: LayoutScorerBeamStateView,
}

/// TS: `irregularLayoutScorer.ts:58-99` `IrregularLayoutScore`. One
/// lexicographically comparable score for a complete irregular beam state --
/// every field required, no optionals.
#[derive(Clone, Debug, PartialEq)]
pub struct IrregularLayoutScore {
    /// Fewer unplaced prepared ids always dominate every later criterion.
    pub unplaced_count: f64,
    /// Total exact boundary shared by translated padded collision polygons.
    pub shared_collision_boundary_length_mm: f64,
    /// Cumulative shared boundary normalized by each pair's structural edge
    /// scale.
    pub shared_collision_boundary_contact_units: f64,
    /// Whole normalized contact units retained before compactness breaks
    /// the tie.
    pub shared_collision_boundary_contact_band: f64,
    /// Number of near-complete overlaps between structural-scale collision
    /// edges.
    pub near_complete_structural_contact_count: f64,
    /// Largest frequency of one invariant local structural-contact pattern.
    pub dominant_near_complete_structural_contact_count: f64,
    /// Largest net boundary-minus-holes material region; larger is better.
    pub largest_net_free_material_region_area_mm2: f64,
    /// Number of disconnected material regions; smaller is better.
    pub free_material_region_count: f64,
    /// Total number of explicit interior holes across material regions.
    pub free_material_hole_count: f64,
    /// Sum of perimeter-squared divided by net area for every material
    /// region.
    pub free_material_sliver_metric: f64,
    /// Largest normalized axis consumption of the placed collision bounds.
    pub collision_bounds_worst_normalized_sheet_consumption: f64,
    /// Sum of normalized width and height of the placed collision bounds.
    pub collision_bounds_normalized_span_sum: f64,
    /// Area of the axis-aligned bounds around placed collision polygons.
    pub collision_bounds_area_mm2: f64,
    /// Width plus height of the placed collision-polygon bounds.
    pub collision_bounds_span_mm: f64,
    /// Empty fraction enclosed by the convex hull of the translated
    /// collision polygons.
    pub occupied_hull_waste_ratio: f64,
    /// Sheet-space lower edge of the occupied collision envelope.
    pub collision_bounds_bottom_mm: f64,
    /// Sheet-space left edge of the occupied collision envelope.
    pub collision_bounds_left_mm: f64,
    /// Clipper2-derived snapshot retained for diagnostics and later
    /// consumers.
    pub free_material_snapshot: FreeMaterialSnapshot,
    /// Stable prepared-id order of committed placements.
    pub placement_order: Vec<PieceId>,
    /// Stable prepared-id order of pieces recorded as unplaced.
    pub unplaced_source_piece_ids: Vec<PieceId>,
}

/// TS: `irregularLayoutScorer.ts:32` `MAX_FREE_MATERIAL_CACHE_ENTRIES = 256`.
pub const MAX_FREE_MATERIAL_CACHE_ENTRIES: usize = 256;
/// TS: `irregularLayoutScorer.ts:33` `FREE_MATERIAL_CACHE_VERSION =
/// 'irregular-free-material-v1'`.
const FREE_MATERIAL_CACHE_VERSION: &str = "irregular-free-material-v1";

/// Job-local free-material memoization cache. TS: `irregularLayoutScorer.ts`'s
/// closure-captured `freeMaterialCache: Map<string, FreeMaterialSnapshot>`
/// (line 126) -- one instance per `IrregularLayoutScorer.Make` construction,
/// i.e. per job (`search-scoring.md` §9.1/§13.2's "job-local ownership"
/// default). A plain `HashMap` cannot reproduce JS `Map`'s **insertion-order**
/// FIFO eviction (`freeMaterialCache.keys().next().value`, line 194), so this
/// pairs a `HashMap` for O(1) lookup with a `VecDeque<String>` tracking
/// insertion order explicitly -- per `search-scoring.md` §12 item 3
/// ("requires an ordered-map structure... not `std::collections::HashMap`";
/// this crate has no `indexmap` dependency to add, and editing `Cargo.toml`
/// is out of this task's file-ownership scope).
pub const FREE_MATERIAL_CACHE_CAP_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeMaterialCacheTelemetry {
    pub cap_bytes: u64,
    pub current_bytes: u64,
    pub peak_bytes: u64,
    pub entries: u64,
    pub admissions: u64,
    pub replacements: u64,
    pub evictions: u64,
    pub evicted_bytes: u64,
    pub oversized_rejections: u64,
    pub hits: u64,
    pub misses: u64,
}

/// The free-material cache retains TS insertion-order FIFO semantics. The
/// charged limit is additional safety only: cache hits never reorder keys.
pub struct FreeMaterialCache {
    entries: HashMap<String, (FreeMaterialSnapshot, u64)>,
    insertion_order: VecDeque<String>,
    byte_cap: u64,
    telemetry: FreeMaterialCacheTelemetry,
}

impl Default for FreeMaterialCache {
    fn default() -> Self {
        Self::new()
    }
}

impl FreeMaterialCache {
    /// Constructs the finite 8 MiB free-material cache budget for one job.
    pub fn new() -> Self {
        Self::with_byte_cap(FREE_MATERIAL_CACHE_CAP_BYTES)
    }

    #[cfg(test)]
    fn new_with_byte_cap_for_test(byte_cap: u64) -> Self {
        Self::with_byte_cap(byte_cap)
    }

    pub(crate) fn with_byte_cap(byte_cap: u64) -> Self {
        Self {
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
            byte_cap,
            telemetry: FreeMaterialCacheTelemetry {
                cap_bytes: byte_cap,
                ..FreeMaterialCacheTelemetry::default()
            },
        }
    }

    pub fn get(&mut self, key: &str) -> Option<&FreeMaterialSnapshot> {
        match self.entries.get(key) {
            Some((value, _)) => {
                self.telemetry.hits = self.telemetry.hits.saturating_add(1);
                Some(value)
            }
            None => {
                self.telemetry.misses = self.telemetry.misses.saturating_add(1);
                None
            }
        }
    }

    pub fn size(&self) -> usize {
        self.entries.len()
    }

    fn set(&mut self, key: String, value: FreeMaterialSnapshot) -> bool {
        let charge = free_material_entry_charge(&key, &value);
        if charge > self.byte_cap {
            self.telemetry.oversized_rejections =
                self.telemetry.oversized_rejections.saturating_add(1);
            return false;
        }

        let replacing = self.entries.contains_key(&key);
        let old_charge = self.entries.get(&key).map_or(0, |(_, charge)| *charge);
        let mut planned_bytes = self.telemetry.current_bytes.saturating_sub(old_charge);
        let mut planned_entries = self.entries.len();
        let mut planned_evictions = Vec::new();
        let mut ordered = self.insertion_order.iter();

        while planned_bytes.saturating_add(charge) > self.byte_cap
            || (!replacing && planned_entries >= MAX_FREE_MATERIAL_CACHE_ENTRIES)
        {
            let Some(oldest) = ordered.next() else {
                self.telemetry.oversized_rejections =
                    self.telemetry.oversized_rejections.saturating_add(1);
                return false;
            };
            if replacing && oldest == &key {
                self.telemetry.oversized_rejections =
                    self.telemetry.oversized_rejections.saturating_add(1);
                return false;
            }
            let Some((_, oldest_charge)) = self.entries.get(oldest) else {
                self.telemetry.oversized_rejections =
                    self.telemetry.oversized_rejections.saturating_add(1);
                return false;
            };
            planned_bytes = planned_bytes.saturating_sub(*oldest_charge);
            planned_entries = planned_entries.saturating_sub(1);
            planned_evictions.push(oldest.clone());
        }

        let evicted_any = !planned_evictions.is_empty();
        for expected_oldest in planned_evictions {
            let actual_oldest = self
                .insertion_order
                .pop_front()
                .expect("every planned FIFO eviction has an insertion-order entry");
            debug_assert_eq!(actual_oldest, expected_oldest);
            self.evict_key(actual_oldest);
        }

        if replacing {
            let (stored_value, stored_charge) = self
                .entries
                .get_mut(&key)
                .expect("a replacement cannot evict its own FIFO entry");
            self.telemetry.current_bytes = self
                .telemetry
                .current_bytes
                .saturating_sub(*stored_charge)
                .saturating_add(charge);
            *stored_value = value;
            *stored_charge = charge;
            self.telemetry.replacements = self.telemetry.replacements.saturating_add(1);
        } else {
            self.entries.insert(key.clone(), (value, charge));
            self.insertion_order.push_back(key);
            self.telemetry.current_bytes = self.telemetry.current_bytes.saturating_add(charge);
            self.telemetry.entries = self.telemetry.entries.saturating_add(1);
        }
        self.telemetry.peak_bytes = self.telemetry.peak_bytes.max(self.telemetry.current_bytes);
        self.telemetry.admissions = self.telemetry.admissions.saturating_add(1);
        if evicted_any {
            self.entries.shrink_to_fit();
            self.insertion_order.shrink_to_fit();
        }
        true
    }

    #[cfg(test)]
    fn evict_oldest(&mut self) {
        if let Some(oldest) = self.insertion_order.pop_front() {
            self.evict_key(oldest);
        }
    }

    fn evict_key(&mut self, key: String) {
        if let Some((_, charge)) = self.entries.remove(&key) {
            self.telemetry.current_bytes = self.telemetry.current_bytes.saturating_sub(charge);
            self.telemetry.entries = self.telemetry.entries.saturating_sub(1);
            self.telemetry.evictions = self.telemetry.evictions.saturating_add(1);
            self.telemetry.evicted_bytes = self.telemetry.evicted_bytes.saturating_add(charge);
        }
    }

    pub fn clear_and_shrink(&mut self) {
        self.entries.clear();
        self.entries.shrink_to_fit();
        self.insertion_order.clear();
        self.insertion_order.shrink_to_fit();
        self.telemetry.current_bytes = 0;
        self.telemetry.entries = 0;
    }

    pub fn telemetry(&self) -> &FreeMaterialCacheTelemetry {
        &self.telemetry
    }
}

/// TS: `irregularLayoutScorer.ts:36-55` `makeFreeMaterialCacheKey`. Builds a
/// cache key from every geometry input used by free-material calculation,
/// reproducing `JSON.stringify`'s literal source-declared key order (never
/// alphabetical -- `serde_json::Value`'s default `Map` is a `BTreeMap`, which
/// would silently reorder these keys, so this function hand-builds the JSON
/// text instead of going through `serde_json::to_string` on a `Value`).
/// Numbers use [`number_to_js_string`] (ECMA-262 `Number::toString`, not
/// Rust's default `f64` formatting); strings are escaped via
/// `serde_json::to_string` on the bare `&str` (correctly escaping, without
/// reordering anything, since a single string value has no keys to reorder).
/// This key is never persisted or exposed outside this module -- only used
/// for `FreeMaterialCache`'s in-process lookup -- so byte-exactness here only
/// matters for cache-hit-rate parity with the TS baseline, not for any
/// external contract (`search-scoring.md` §8.3).
fn make_free_material_cache_key(
    sheet: &SheetSpec,
    settings: &IrregularNestingSettings,
    state: &LayoutScorerBeamStateView,
) -> String {
    format!(
        r#"{{"version":{},"sheet":{{"width":{},"height":{},"label":{}}},"geometrySettings":{{"flatteningSagToleranceMm":{},"clearanceSafetyMarginMm":{},"geometryBackendId":{},"geometryBackendVersion":{}}},"placedGeometry":{}}}"#,
        json_string(FREE_MATERIAL_CACHE_VERSION),
        number_to_js_string(sheet.width),
        number_to_js_string(sheet.height),
        json_string(&sheet.label),
        number_to_js_string(settings.geometry.flattening_sag_tolerance_mm),
        number_to_js_string(settings.geometry.clearance_safety_margin_mm),
        json_string(&settings.geometry.geometry_backend_id),
        json_string(&settings.geometry.geometry_backend_version),
        json_string(&state.canonical_occupied_geometry_key),
    )
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("a plain &str always serializes to a JSON string")
}

fn free_material_entry_charge(key: &String, snapshot: &FreeMaterialSnapshot) -> u64 {
    let mut charge = (std::mem::size_of::<FreeMaterialSnapshot>() as u64).saturating_add(64);
    charge = charge.saturating_add(string_capacity_charge(key).saturating_mul(2));
    charge = charge.saturating_add(string_capacity_charge(&snapshot.sheet.label));
    charge = charge.saturating_add(capacity_charge::<crate::domain::FreeMaterialRegion>(
        snapshot.regions.capacity(),
    ));
    for region in &snapshot.regions {
        charge =
            charge.saturating_add(capacity_charge::<IrregularPolygon>(region.holes.capacity()));
        charge = charge.saturating_add(polygon_points_capacity_charge(&region.boundary));
        for hole in &region.holes {
            charge = charge.saturating_add(polygon_points_capacity_charge(hole));
        }
    }
    charge = charge.saturating_add(
        capacity_charge::<crate::domain::CollisionGeometryDiagnostic>(
            snapshot.diagnostics.capacity(),
        ),
    );
    for diagnostic in &snapshot.diagnostics {
        charge = charge.saturating_add(string_capacity_charge(&diagnostic.code));
        charge = charge.saturating_add(string_capacity_charge(&diagnostic.message));
        if let Some(piece_id) = &diagnostic.piece_id {
            charge = charge.saturating_add(string_capacity_charge(&piece_id.0));
        }
    }
    charge
}

fn polygon_points_capacity_charge(polygon: &IrregularPolygon) -> u64 {
    capacity_charge::<IrregularPoint>(polygon.points.capacity())
}

fn capacity_charge<T>(capacity: usize) -> u64 {
    u64::try_from(capacity)
        .unwrap_or(u64::MAX)
        .saturating_mul(std::mem::size_of::<T>() as u64)
}

fn string_capacity_charge(value: &String) -> u64 {
    u64::try_from(value.capacity()).unwrap_or(u64::MAX)
}

/// TS: `irregularLayoutScorer.ts:129-145` `scoreState` (the `.Make`
/// service body's `scoreState` field). See this module's top doc for why
/// `cache` is an explicit job-owned parameter rather than a captured
/// closure.
pub fn score_state(
    input: &ScoreIrregularLayoutInput,
    settings: &IrregularNestingSettings,
    cache: &mut FreeMaterialCache,
) -> Result<IrregularLayoutScore, IrregularLayoutScorerError> {
    let cache_key = make_free_material_cache_key(&input.sheet, settings, &input.state);
    let cached_snapshot = cache.get(&cache_key).cloned();
    let snapshot = match cached_snapshot {
        Some(snapshot) => snapshot,
        None => compute_snapshot_with_parent_fallback(input, settings, cache)
            .map_err(IrregularLayoutScorerError::GeometryInput)?,
    };

    score_derived_state(input, snapshot).map_err(IrregularLayoutScorerError::Scoring)
}

/// TS: `irregularLayoutScorer.ts:156-204` `computeSnapshotWithParentFallback`.
fn compute_snapshot_with_parent_fallback(
    input: &ScoreIrregularLayoutInput,
    settings: &IrregularNestingSettings,
    cache: &mut FreeMaterialCache,
) -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
    let parent = input.state.parent.clone();
    let newly_placed = get_newly_placed_geometry(&input.state);
    let parent_snapshot = parent.as_ref().and_then(|parent_state| {
        let parent_key = make_free_material_cache_key(&input.sheet, settings, parent_state);
        cache.get(&parent_key).cloned()
    });

    let full = || -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
        compute_free_material(
            &ComputeFreeMaterialInput {
                sheet: input.sheet.clone(),
                placed: input
                    .state
                    .placed_collision_geometries
                    .iter()
                    .map(|placed| (**placed).clone())
                    .collect(),
                settings: settings.geometry.clone(),
            },
            crate::geometry::free_material::FreeMaterialOperation::UnionThenDifference,
        )
    };

    let computed =
        if let (Some(parent_snapshot), Some(newly_placed)) = (parent_snapshot, newly_placed) {
            match extend_free_material(&ExtendFreeMaterialInput {
                parent: parent_snapshot,
                placed: (*newly_placed).clone(),
                settings: settings.geometry.clone(),
            }) {
                Ok(snapshot) => snapshot,
                // TS: `.pipe(Effect.catch(() => full()))` -- incremental failure
                // is silently absorbed and retried from scratch, never surfaced.
                Err(_) => full()?,
            }
        } else {
            full()?
        };

    let _admitted = cache.set(
        make_free_material_cache_key(&input.sheet, settings, &input.state),
        computed.clone(),
    );

    Ok(computed)
}

/// TS: `irregularLayoutScorer.ts:206-222` `getNewlyPlacedGeometry`. See this
/// module's top doc for why `Arc::ptr_eq` (not structural equality) is the
/// correct port of TS's `!==` reference check.
fn get_newly_placed_geometry(
    state: &LayoutScorerBeamStateView,
) -> Option<Arc<IrregularPlacedPiece>> {
    let parent = state.parent.as_ref()?;
    if state.placed_collision_geometries.len() != parent.placed_collision_geometries.len() + 1 {
        return None;
    }

    for index in 0..parent.placed_collision_geometries.len() {
        if !Arc::ptr_eq(
            &state.placed_collision_geometries[index],
            &parent.placed_collision_geometries[index],
        ) {
            return None;
        }
    }

    state
        .placed_collision_geometries
        .get(parent.placed_collision_geometries.len())
        .cloned()
}

/// TS: `irregularLayoutScorer.ts:224-326` `scoreDerivedState`.
fn score_derived_state(
    input: &ScoreIrregularLayoutInput,
    free_material_snapshot: FreeMaterialSnapshot,
) -> Result<IrregularLayoutScore, IrregularLayoutScoringError> {
    let material_metrics = derive_free_material_metrics(&free_material_snapshot)
        .ok_or_else(|| fail_scoring("free-material metrics must remain finite.".to_string()))?;

    let collision_bounds = input.state.translated_collision_bounds.ok_or_else(|| {
        fail_scoring("placed collision polygons must produce finite bounds.".to_string())
    })?;

    let canonical_width =
        score_grid::canonicalize_irregular_score_millimeters(collision_bounds.width);
    let canonical_height =
        score_grid::canonicalize_irregular_score_millimeters(collision_bounds.height);
    let canonical_min_x =
        score_grid::canonicalize_irregular_score_millimeters(collision_bounds.min_x);
    let canonical_min_y =
        score_grid::canonicalize_irregular_score_millimeters(collision_bounds.min_y);

    let (canonical_width, canonical_height, canonical_min_x, canonical_min_y) = match (
        canonical_width,
        canonical_height,
        canonical_min_x,
        canonical_min_y,
    ) {
        (Some(width), Some(height), Some(min_x), Some(min_y)) => (width, height, min_x, min_y),
        _ => {
            return Err(fail_scoring(
                "collision bounds must fit the deterministic score grid.".to_string(),
            ))
        }
    };

    // Translation-equivalent layouts can acquire different low-order bits
    // when large translated maxima and minima are subtracted. Canonicalizing
    // the derived bounds to the existing 0.001 mm collision-geometry
    // precision makes those layouts score identically without introducing
    // epsilon comparisons.
    let normalized_width = canonical_width / input.sheet.width;
    let normalized_height = canonical_height / input.sheet.height;
    let collision_bounds_worst_normalized_sheet_consumption =
        js_math::max(normalized_width, normalized_height);
    let collision_bounds_normalized_span_sum = normalized_width + normalized_height;
    let collision_bounds_area_mm2 = canonical_width * canonical_height;
    let collision_bounds_span_mm = canonical_width + canonical_height;
    let collision_bounds_bottom_mm = canonical_min_y;
    let collision_bounds_left_mm = canonical_min_x;
    let shared_collision_boundary_length_mm = score_grid::canonicalize_irregular_score_millimeters(
        input
            .state
            .shared_collision_boundary_length_mm
            .unwrap_or(f64::NAN),
    );
    let shared_collision_boundary_contact_units = score_grid::canonicalize_irregular_score_scalar(
        input
            .state
            .shared_collision_boundary_contact_units
            .unwrap_or(f64::NAN),
    );
    let shared_collision_boundary_contact_band =
        shared_collision_boundary_contact_units.map(js_math::floor);
    // TS reads `input.state.nearCompleteStructuralContactCount` directly
    // (`number | undefined`) rather than defaulting to `Number.NaN` first --
    // substituting `NaN` here is provably equivalent, since every subsequent
    // check on this value is `is_safe_integer`/`< 0`/a cross-field compare,
    // all of which are already `false` for `NaN` exactly like TS's separate
    // `=== undefined` checks would reject it.
    let near_complete_structural_contact_count = input
        .state
        .near_complete_structural_contact_count
        .unwrap_or(f64::NAN);
    let dominant_near_complete_structural_contact_count = input
        .state
        .dominant_near_complete_structural_contact_count
        .unwrap_or(f64::NAN);
    let occupied_hull_waste_ratio = score_grid::canonicalize_irregular_score_scalar(
        derive_raw_occupied_hull_waste_ratio(&input.state).unwrap_or(f64::NAN),
    );

    let invalid = !normalized_width.is_finite()
        || !normalized_height.is_finite()
        || !collision_bounds_worst_normalized_sheet_consumption.is_finite()
        || !collision_bounds_normalized_span_sum.is_finite()
        || !collision_bounds_area_mm2.is_finite()
        || !collision_bounds_span_mm.is_finite()
        || shared_collision_boundary_length_mm.is_none()
        || shared_collision_boundary_contact_units.is_none()
        || !shared_collision_boundary_contact_band.is_some_and(is_safe_integer)
        || !is_safe_integer(near_complete_structural_contact_count)
        || near_complete_structural_contact_count < 0.0
        || !is_safe_integer(dominant_near_complete_structural_contact_count)
        || dominant_near_complete_structural_contact_count < 0.0
        || dominant_near_complete_structural_contact_count > near_complete_structural_contact_count
        || occupied_hull_waste_ratio.is_none()
        || !collision_bounds_bottom_mm.is_finite()
        || !collision_bounds_left_mm.is_finite();

    if invalid {
        return Err(fail_scoring(
            "collision-bounds score arithmetic must remain finite.".to_string(),
        ));
    }

    Ok(IrregularLayoutScore {
        unplaced_count: input.state.unplaced_source_piece_ids.len() as f64,
        shared_collision_boundary_length_mm: shared_collision_boundary_length_mm
            .expect("checked above"),
        shared_collision_boundary_contact_units: shared_collision_boundary_contact_units
            .expect("checked above"),
        shared_collision_boundary_contact_band: shared_collision_boundary_contact_band
            .expect("checked above"),
        near_complete_structural_contact_count,
        dominant_near_complete_structural_contact_count,
        largest_net_free_material_region_area_mm2: material_metrics
            .largest_net_free_material_region_area_mm2,
        free_material_region_count: material_metrics.free_material_region_count,
        free_material_hole_count: material_metrics.free_material_hole_count,
        free_material_sliver_metric: material_metrics.free_material_sliver_metric,
        collision_bounds_worst_normalized_sheet_consumption,
        collision_bounds_normalized_span_sum,
        collision_bounds_area_mm2,
        collision_bounds_span_mm,
        occupied_hull_waste_ratio: occupied_hull_waste_ratio.expect("checked above"),
        collision_bounds_bottom_mm,
        collision_bounds_left_mm,
        free_material_snapshot,
        placement_order: input.state.placement_order.clone(),
        unplaced_source_piece_ids: input.state.unplaced_source_piece_ids.clone(),
    })
}

/// TS: `irregularLayoutScorer.ts:328-333` `FreeMaterialMetrics` interface.
struct FreeMaterialMetrics {
    largest_net_free_material_region_area_mm2: f64,
    free_material_region_count: f64,
    free_material_hole_count: f64,
    free_material_sliver_metric: f64,
}

/// TS: `irregularLayoutScorer.ts:340-388` `deriveFreeMaterialMetrics`. Uses
/// boundary and hole vertices from the real material snapshot. The sliver
/// metric is dimensionless: perimeter squared divided by net area is larger
/// for long, thin, or hole-heavy regions and smaller for compact ones.
fn derive_free_material_metrics(snapshot: &FreeMaterialSnapshot) -> Option<FreeMaterialMetrics> {
    let mut largest_net_free_material_region_area_mm2 = 0.0_f64;
    let mut free_material_hole_count = 0.0_f64;
    let mut free_material_sliver_metric = 0.0_f64;

    for region in &snapshot.regions {
        let boundary_area = polygon_area(&region.boundary);
        let boundary_perimeter = polygon_perimeter(&region.boundary);
        let mut hole_area = 0.0_f64;
        let mut perimeter = boundary_perimeter;

        for hole in &region.holes {
            hole_area += polygon_area(hole);
            perimeter += polygon_perimeter(hole);
            free_material_hole_count += 1.0;
        }

        let net_area = boundary_area - hole_area;
        largest_net_free_material_region_area_mm2 =
            js_math::max(largest_net_free_material_region_area_mm2, net_area);
        // Note this is `<= 0`, not `< 0`: a zero-net-area region is treated
        // as an error, not silently skipped or zero-weighted.
        if !boundary_area.is_finite()
            || !boundary_perimeter.is_finite()
            || !hole_area.is_finite()
            || !perimeter.is_finite()
            || !net_area.is_finite()
            || net_area <= 0.0
        {
            return None;
        }

        free_material_sliver_metric += (perimeter * perimeter) / net_area;
    }

    if !largest_net_free_material_region_area_mm2.is_finite()
        || !free_material_sliver_metric.is_finite()
    {
        return None;
    }

    Some(FreeMaterialMetrics {
        largest_net_free_material_region_area_mm2,
        free_material_region_count: snapshot.regions.len() as f64,
        free_material_hole_count,
        free_material_sliver_metric,
    })
}

/// TS: `irregularLayoutScorer.ts:390-399` `polygonArea`.
fn polygon_area(polygon: &IrregularPolygon) -> f64 {
    let len = polygon.points.len();
    let mut cross_sum = 0.0_f64;
    for index in 0..len {
        let first = polygon.points[index];
        let second = polygon.points[(index + 1) % len];
        cross_sum += first.x * second.y - second.x * first.y;
    }
    (cross_sum / 2.0).abs()
}

/// TS: `irregularLayoutScorer.ts:401-410` `polygonPerimeter`.
///
/// The perimeter routes through [`js_math::hypot`] so scoring shares one
/// audited standard-library boundary with production geometry. The summed
/// value feeds `derive_free_material_metrics`'s `free_material_sliver_metric`
/// (`perimeter * perimeter / net_area`) and is serialized onto
/// `IrregularLayoutScore`. Final legality, quality, and deterministic output
/// are blocking; Node/V8 ULP differences are diagnostic.
fn polygon_perimeter(polygon: &IrregularPolygon) -> f64 {
    let len = polygon.points.len();
    let mut perimeter = 0.0_f64;
    for index in 0..len {
        let first = polygon.points[index];
        let second = polygon.points[(index + 1) % len];
        perimeter += js_math::hypot(second.x - first.x, second.y - first.y);
    }
    perimeter
}

/// TS: `irregularLayoutScorer.ts:412-446` `deriveRawOccupiedHullWasteRatio`.
/// Returns the pre-grid hull ratio for diagnostics and protected legacy
/// comparisons. TS's `InternalPoint` and this crate's `domain::IrregularPoint`
/// are the same unified type (per `domain::mod`'s "`internalGeometry.ts`
/// unification" doc), so this function operates on `IrregularPoint` directly.
pub fn derive_raw_occupied_hull_waste_ratio(state: &LayoutScorerBeamStateView) -> Option<f64> {
    let mut occupied_points: Vec<IrregularPoint> = Vec::new();
    let mut occupied_area = 0.0_f64;

    for placed in &state.placed_collision_geometries {
        let translation = placed.placement.transform;
        let translated_points: Vec<IrregularPoint> = placed
            .collision_geometry
            .polygon
            .points
            .iter()
            .map(|point| {
                IrregularPoint::new(
                    point.x + translation.translate_x,
                    point.y + translation.translate_y,
                )
            })
            .collect();

        if translated_points
            .iter()
            .any(|point| !point.x.is_finite() || !point.y.is_finite())
        {
            return None;
        }

        occupied_points.extend(translated_points.iter().copied());
        let area = absolute_polygon_area(&translated_points);
        if !area.is_finite() {
            return None;
        }
        occupied_area += area;
    }

    if occupied_points.is_empty() {
        return Some(0.0);
    }

    let hull = convex_hull(&occupied_points);
    let hull_area = absolute_polygon_area(&hull);
    if !hull_area.is_finite() || !occupied_area.is_finite() {
        return None;
    }
    if hull_area == 0.0 {
        return Some(0.0);
    }

    let waste = (hull_area - occupied_area) / hull_area;
    if waste.is_finite() {
        Some(js_math::max(0.0, js_math::min(1.0, waste)))
    } else {
        None
    }
}

/// TS: `irregularLayoutScorer.ts:448-459` `absolutePolygonArea`.
fn absolute_polygon_area(points: &[IrregularPoint]) -> f64 {
    if points.len() < 3 {
        return 0.0;
    }
    let len = points.len();
    let mut cross_sum = 0.0_f64;
    for index in 0..len {
        let first = points[index];
        let second = points[(index + 1) % len];
        cross_sum += first.x * second.y - second.x * first.y;
    }
    (cross_sum / 2.0).abs()
}

/// TS: `irregularLayoutScorer.ts:461-500` `convexHull` (monotone chain,
/// using [`predicates::orientation`]'s left/counter-clockwise-positive
/// convention -- see that function's own doc for the sign inversion vs. the
/// underlying `robust`-crate primitive).
fn convex_hull(points: &[IrregularPoint]) -> Vec<IrregularPoint> {
    let mut sorted: Vec<IrregularPoint> = points.to_vec();
    // Stable sort required (matches JS's spec-guaranteed-stable `.sort()`);
    // `sort_by`, never `sort_unstable_by`.
    sorted.sort_by(compare_internal_points);

    let mut unique: Vec<IrregularPoint> = Vec::with_capacity(sorted.len());
    for point in sorted {
        let is_new = match unique.last() {
            None => true,
            Some(previous) => point.x != previous.x || point.y != previous.y,
        };
        if is_new {
            unique.push(point);
        }
    }

    if unique.len() <= 2 {
        return unique;
    }

    let mut lower: Vec<IrregularPoint> = Vec::new();
    for &point in &unique {
        while lower.len() >= 2 {
            let last = lower[lower.len() - 1];
            let before_last = lower[lower.len() - 2];
            if predicates::orientation(
                before_last.x,
                before_last.y,
                last.x,
                last.y,
                point.x,
                point.y,
            ) > 0
            {
                break;
            }
            lower.pop();
        }
        lower.push(point);
    }

    let mut upper: Vec<IrregularPoint> = Vec::new();
    for &point in unique.iter().rev() {
        while upper.len() >= 2 {
            let last = upper[upper.len() - 1];
            let before_last = upper[upper.len() - 2];
            if predicates::orientation(
                before_last.x,
                before_last.y,
                last.x,
                last.y,
                point.x,
                point.y,
            ) > 0
            {
                break;
            }
            upper.pop();
        }
        upper.push(point);
    }

    lower.truncate(lower.len().saturating_sub(1));
    let upper_keep = upper.len().saturating_sub(1);
    lower.extend_from_slice(&upper[..upper_keep]);
    lower
}

/// TS: `irregularLayoutScorer.ts:502-504` `compareInternalPoints`: `first.x -
/// second.x || first.y - second.y`, a raw arithmetic-subtraction comparator
/// (not `effect`'s `Order`). Safe to translate directly to a sign comparison
/// since every point reaching this comparator was already validated finite
/// by `derive_raw_occupied_hull_waste_ratio` above (so `dx`/`dy` can never be
/// `NaN` here).
fn compare_internal_points(a: &IrregularPoint, b: &IrregularPoint) -> Ordering {
    let dx = a.x - b.x;
    if dx != 0.0 {
        return if dx < 0.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let dy = a.y - b.y;
    if dy < 0.0 {
        Ordering::Less
    } else if dy > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// TS: `irregularLayoutScorer.ts:510-511` `STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT
/// = 20`. Small partial layouts keep exact contact ordering while repeated
/// motifs form.
pub const STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT: usize = 20;
/// TS: `irregularLayoutScorer.ts:513` `STRUCTURAL_CONTACT_COUNT_BAND_WIDTH =
/// 2`. Larger layouts compare total structural contacts in adjacent-pair
/// bands. Kept as `f64` (not `usize`) since it divides
/// `near_complete_structural_contact_count`, a `f64` per this domain's
/// number-fidelity convention.
pub const STRUCTURAL_CONTACT_COUNT_BAND_WIDTH: f64 = 2.0;

/// TS: `irregularLayoutScorer.ts:506-508` `compareScores`, the production
/// `.compare` method body -- **not reachable on the production
/// Compact/Compact Short Side path** (see this module's top doc).
pub fn compare_scores(first: &IrregularLayoutScore, second: &IrregularLayoutScore) -> Ordering {
    layout_score_order(first, second)
}

/// TS: `irregularLayoutScorer.ts:547-555` `layoutScoreOrder` dispatcher.
/// Falls back to [`strict_layout_score_order`] whenever depths differ **even
/// if both exceed the limit** -- the scale-aware banding is only applied to
/// same-depth comparisons.
fn layout_score_order(first: &IrregularLayoutScore, second: &IrregularLayoutScore) -> Ordering {
    let same_placement_depth = first.placement_order.len() == second.placement_order.len();
    let use_scale_aware_contact_bands = same_placement_depth
        && first.placement_order.len() > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT;
    if use_scale_aware_contact_bands {
        scale_aware_layout_score_order(first, second)
    } else {
        strict_layout_score_order(first, second)
    }
}

/// TS: `irregularLayoutScorer.ts:515-528` `strictLayoutScoreOrder` --
/// ascending 12-term chain. Used when `placementOrder.length <=
/// STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT` or the two states being
/// compared have different `placementOrder.length`.
fn strict_layout_score_order(
    first: &IrregularLayoutScore,
    second: &IrregularLayoutScore,
) -> Ordering {
    cmp_number(first.unplaced_count, second.unplaced_count)
        .then_with(|| {
            cmp_number(
                first.dominant_near_complete_structural_contact_count,
                second.dominant_near_complete_structural_contact_count,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.near_complete_structural_contact_count,
                second.near_complete_structural_contact_count,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                collision_bounds_max_side_mm(first),
                collision_bounds_max_side_mm(second),
            )
        })
        .then_with(|| {
            cmp_number(
                first.collision_bounds_area_mm2,
                second.collision_bounds_area_mm2,
            )
        })
        .then_with(|| {
            cmp_number(
                first.collision_bounds_span_mm,
                second.collision_bounds_span_mm,
            )
        })
        .then_with(|| {
            cmp_number(
                first.occupied_hull_waste_ratio,
                second.occupied_hull_waste_ratio,
            )
        })
        .then_with(|| {
            cmp_number(
                first.shared_collision_boundary_contact_band,
                second.shared_collision_boundary_contact_band,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.shared_collision_boundary_contact_units,
                second.shared_collision_boundary_contact_units,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.shared_collision_boundary_length_mm,
                second.shared_collision_boundary_length_mm,
            )
            .reverse()
        })
        .then_with(|| cmp_piece_id_array(&first.placement_order, &second.placement_order))
        .then_with(|| {
            cmp_piece_id_array(
                &first.unplaced_source_piece_ids,
                &second.unplaced_source_piece_ids,
            )
        })
}

/// TS: `irregularLayoutScorer.ts:530-545` `scaleAwareLayoutScoreOrder` --
/// ascending 12-term chain. Used when both states have
/// `placementOrder.length > STRICT_STRUCTURAL_CONTACT_PLACEMENT_LIMIT` **and**
/// equal `placementOrder.length`. Per `search-scoring.md` §6.2: compactness
/// criteria are promoted *before* structural-contact criteria here, the
/// opposite term order from [`strict_layout_score_order`] -- this term-order
/// swap, not merely different banding, is the whole point of the two-order
/// split; the two functions must stay independently declared, never
/// "simplified" into one parameterized order.
fn scale_aware_layout_score_order(
    first: &IrregularLayoutScore,
    second: &IrregularLayoutScore,
) -> Ordering {
    cmp_number(first.unplaced_count, second.unplaced_count)
        .then_with(|| {
            cmp_number(
                collision_bounds_max_side_mm(first),
                collision_bounds_max_side_mm(second),
            )
        })
        .then_with(|| {
            cmp_number(
                first.collision_bounds_area_mm2,
                second.collision_bounds_area_mm2,
            )
        })
        .then_with(|| {
            cmp_number(
                first.collision_bounds_span_mm,
                second.collision_bounds_span_mm,
            )
        })
        .then_with(|| {
            cmp_number(
                first.occupied_hull_waste_ratio,
                second.occupied_hull_waste_ratio,
            )
        })
        .then_with(|| {
            cmp_number(
                first.dominant_near_complete_structural_contact_count,
                second.dominant_near_complete_structural_contact_count,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                js_math::floor(
                    first.near_complete_structural_contact_count
                        / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH,
                ),
                js_math::floor(
                    second.near_complete_structural_contact_count
                        / STRUCTURAL_CONTACT_COUNT_BAND_WIDTH,
                ),
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.near_complete_structural_contact_count,
                second.near_complete_structural_contact_count,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.shared_collision_boundary_contact_units,
                second.shared_collision_boundary_contact_units,
            )
            .reverse()
        })
        .then_with(|| {
            cmp_number(
                first.shared_collision_boundary_length_mm,
                second.shared_collision_boundary_length_mm,
            )
            .reverse()
        })
        .then_with(|| cmp_piece_id_array(&first.placement_order, &second.placement_order))
        .then_with(|| {
            cmp_piece_id_array(
                &first.unplaced_source_piece_ids,
                &second.unplaced_source_piece_ids,
            )
        })
}

/// TS: `irregularLayoutScorer.ts:557-564` `collisionBoundsMaxSideMm`. Derives
/// `max(width, height)` from `spanMm = width + height` and `areaMm2 = width *
/// height` alone by solving the quadratic `t^2 - spanMm*t + areaMm2 = 0` for
/// its larger root. `Math.max(0, ...)` guards against floating rounding
/// making the discriminant slightly negative when `width === height` exactly.
fn collision_bounds_max_side_mm(score: &IrregularLayoutScore) -> f64 {
    let discriminant = js_math::max(
        0.0,
        score.collision_bounds_span_mm * score.collision_bounds_span_mm
            - 4.0 * score.collision_bounds_area_mm2,
    );
    (score.collision_bounds_span_mm + discriminant.sqrt()) / 2.0
}

/// `effect`'s `Order.Array(Order.String)` applied to `PieceId` sequences
/// (`placementOrder`/`unplacedSourcePieceIds`): elementwise via
/// `cmp_js_code_units`, first non-zero wins; if every compared element ties,
/// the shorter array sorts first.
fn cmp_piece_id_array(first: &[PieceId], second: &[PieceId]) -> Ordering {
    for (a, b) in first.iter().zip(second.iter()) {
        let ordering = crate::js_number::cmp_js_code_units(a.as_str(), b.as_str());
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    first.len().cmp(&second.len())
}

/// TS: `irregularLayoutScorer.ts:578-585` `failScoring`. Every error from
/// this file uses the same hardcoded `operation: 'scoreState'` string
/// regardless of which specific check failed -- only `message` differentiates.
fn fail_scoring(message: String) -> IrregularLayoutScoringError {
    IrregularLayoutScoringError {
        operation: "scoreState".to_string(),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CollisionGeometryDiagnostic, FreeMaterialRegion, IntrinsicObjectiveProfileId,
        IrregularBounds, IrregularGeometrySettings, IrregularOptimizerSettings, IrregularPlacement,
        IrregularTransform, IrregularTransformCandidate, IrregularTransformReason,
        TransformedCollisionGeometry,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn placed(x: f64, y: f64, id: &str) -> Arc<IrregularPlacedPiece> {
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: Some(PieceId::new(id)),
                source_piece_id: PieceId::new(id),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x: x,
                    translate_y: y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new(id),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon: square(10.0),
                bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
            },
        })
    }

    fn sheet() -> SheetSpec {
        SheetSpec {
            width: 1000.0,
            height: 800.0,
            label: "test".to_string(),
        }
    }

    fn settings() -> IrregularNestingSettings {
        IrregularNestingSettings {
            geometry: IrregularGeometrySettings {
                flattening_sag_tolerance_mm: 0.25,
                clearance_safety_margin_mm: 0.25,
                geometry_backend_id: "irregular-convex-v2-default".to_string(),
                geometry_backend_version: "0".to_string(),
            },
            optimizer: IrregularOptimizerSettings {
                order_window: 4.0,
                beam_width: 8.0,
                local_candidate_fanout: 4.0,
                local_repair_budget: 0.0,
                intrinsic_shared_archive_enabled: true,
                intrinsic_objective_profile_id: IntrinsicObjectiveProfileId::Compact,
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
                placement_policy_id: crate::domain::IrregularPlacementPolicyId::BalancedCompactness,
                placement_policy_ids: crate::domain::default_irregular_placement_policy_ids(),
            },
        }
    }

    fn state_with_one_piece() -> LayoutScorerBeamStateView {
        LayoutScorerBeamStateView {
            placed_collision_geometries: vec![placed(0.0, 0.0, "piece-1")],
            translated_collision_bounds: Some(IrregularCollisionBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 10.0,
                max_y: 10.0,
                width: 10.0,
                height: 10.0,
            }),
            shared_collision_boundary_length_mm: Some(0.0),
            shared_collision_boundary_contact_units: Some(0.0),
            near_complete_structural_contact_count: Some(0.0),
            dominant_near_complete_structural_contact_count: Some(0.0),
            canonical_occupied_geometry_key: "key-1".to_string(),
            placement_order: vec![PieceId::new("piece-1")],
            unplaced_source_piece_ids: vec![],
            parent: None,
        }
    }

    fn empty_snapshot(sheet: &SheetSpec) -> FreeMaterialSnapshot {
        FreeMaterialSnapshot {
            sheet: sheet.clone(),
            regions: vec![FreeMaterialRegion {
                boundary: square(1000.0),
                holes: vec![],
            }],
            diagnostics: vec![],
        }
    }

    #[test]
    fn free_material_cache_rejects_oversized_snapshot_without_evicting_fifo_entry() {
        let sheet = sheet();
        let retained = empty_snapshot(&sheet);
        let retained_charge = free_material_entry_charge(&"retained".to_string(), &retained);
        let mut cache = FreeMaterialCache::new_with_byte_cap_for_test(retained_charge);
        assert!(cache.set("retained".to_string(), retained));
        assert!(!cache.set("oversized".to_string(), empty_snapshot(&sheet)));
        assert!(cache.get("retained").is_some());
        assert_eq!(cache.telemetry().entries, 1);
        assert_eq!(cache.telemetry().oversized_rejections, 1);
        assert_eq!(cache.telemetry().evictions, 0);
    }

    #[test]
    fn free_material_clear_releases_current_bytes_and_retains_peak_counters() {
        let sheet = sheet();
        let snapshot = empty_snapshot(&sheet);
        let mut cache = FreeMaterialCache::new();
        assert_eq!(cache.telemetry().cap_bytes, 8 * 1024 * 1024);
        assert!(cache.set("snapshot".to_string(), snapshot));
        let peak_bytes = cache.telemetry().peak_bytes;

        cache.clear_and_shrink();

        assert_eq!(cache.telemetry().current_bytes, 0);
        assert_eq!(cache.telemetry().entries, 0);
        assert_eq!(cache.telemetry().peak_bytes, peak_bytes);
        assert_eq!(cache.telemetry().admissions, 1);
        assert!(cache.entries.is_empty());
        assert!(cache.insertion_order.is_empty());
    }

    #[test]
    fn successful_replacement_updates_bytes_and_counters_without_reordering() {
        let sheet = sheet();
        let small = empty_snapshot(&sheet);
        let mut larger = small.clone();
        larger.regions[0].boundary = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0); 64]);
        let large_charge = free_material_entry_charge(&"first".to_string(), &larger);
        let mut cache = FreeMaterialCache::new_with_byte_cap_for_test(large_charge * 2);

        assert!(cache.set("first".to_string(), small));
        assert!(cache.set("other".to_string(), empty_snapshot(&sheet)));
        assert!(cache.set("first".to_string(), larger));

        assert_eq!(
            cache.insertion_order,
            VecDeque::from(["first".to_string(), "other".to_string()])
        );
        assert_eq!(cache.telemetry().entries, 2);
        assert_eq!(cache.telemetry().replacements, 1);
        assert_eq!(cache.telemetry().admissions, 3);
        assert_eq!(cache.telemetry().evictions, 0);
        assert!(cache.telemetry().current_bytes <= cache.telemetry().cap_bytes);
        assert!(cache.telemetry().peak_bytes >= cache.telemetry().current_bytes);
    }

    #[test]
    fn charged_replacement_rejects_before_evicting_its_own_fifo_record() {
        let sheet = sheet();
        let small = empty_snapshot(&sheet);
        let mut larger = small.clone();
        larger.regions[0].boundary = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0); 64]);
        let small_charge = free_material_entry_charge(&"first".to_string(), &small);
        let large_charge = free_material_entry_charge(&"first".to_string(), &larger);
        let mut cache = FreeMaterialCache::new_with_byte_cap_for_test(
            small_charge.saturating_add(large_charge).saturating_sub(1),
        );

        assert!(cache.set("first".to_string(), small.clone()));
        assert!(cache.set("other".to_string(), small.clone()));
        assert!(!cache.set("first".to_string(), larger));
        assert_eq!(
            cache.insertion_order,
            VecDeque::from(["first".to_string(), "other".to_string()])
        );
        assert_eq!(cache.get("first"), Some(&small));
        assert_eq!(cache.get("other"), Some(&small));
        assert_eq!(cache.telemetry().replacements, 0);
        assert_eq!(cache.telemetry().evictions, 0);
    }

    #[test]
    fn free_material_charge_counts_inline_polygon_storage_once() {
        let sheet = sheet();
        let mut snapshot = empty_snapshot(&sheet);
        snapshot.regions[0]
            .holes
            .push(IrregularPolygon::new(Vec::with_capacity(7)));
        let key = "charge-key".to_string();

        let region = &snapshot.regions[0];
        let expected = (std::mem::size_of::<FreeMaterialSnapshot>() as u64)
            .saturating_add(64)
            .saturating_add(string_capacity_charge(&key).saturating_mul(2))
            .saturating_add(string_capacity_charge(&snapshot.sheet.label))
            .saturating_add(capacity_charge::<FreeMaterialRegion>(
                snapshot.regions.capacity(),
            ))
            .saturating_add(capacity_charge::<IrregularPolygon>(region.holes.capacity()))
            .saturating_add(capacity_charge::<IrregularPoint>(
                region.boundary.points.capacity(),
            ))
            .saturating_add(capacity_charge::<IrregularPoint>(
                region.holes[0].points.capacity(),
            ))
            .saturating_add(capacity_charge::<CollisionGeometryDiagnostic>(
                snapshot.diagnostics.capacity(),
            ));

        assert_eq!(free_material_entry_charge(&key, &snapshot), expected);
    }

    #[test]
    fn free_material_multi_eviction_shrinks_retained_container_capacity() {
        let sheet = sheet();
        let mut cache = FreeMaterialCache::new_with_byte_cap_for_test(64 * 1024);
        for index in 0..100 {
            assert!(cache.set(format!("small-{index}"), empty_snapshot(&sheet)));
        }
        let entries_capacity_before = cache.entries.capacity();
        let order_capacity_before = cache.insertion_order.capacity();
        let mut large = empty_snapshot(&sheet);
        large.regions[0].boundary =
            IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0); 2_500]);

        assert!(cache.set("large".to_string(), large));
        assert!(cache.telemetry().evictions > 1);
        assert!(cache.entries.capacity() < entries_capacity_before);
        assert!(cache.insertion_order.capacity() < order_capacity_before);
    }

    #[test]
    fn free_material_charge_includes_diagnostic_string_and_piece_id_capacities() {
        let sheet = sheet();
        let plain = empty_snapshot(&sheet);
        let plain_charge = free_material_entry_charge(&"same-key".to_string(), &plain);
        let mut diagnostic_snapshot = plain.clone();
        let mut code = String::with_capacity(1024);
        code.push('c');
        let mut message = String::with_capacity(2048);
        message.push('m');
        let mut piece_id = String::with_capacity(4096);
        piece_id.push('p');
        diagnostic_snapshot
            .diagnostics
            .push(CollisionGeometryDiagnostic {
                code,
                message,
                piece_id: Some(PieceId::new(piece_id)),
            });

        let diagnostic_charge =
            free_material_entry_charge(&"same-key".to_string(), &diagnostic_snapshot);
        assert!(diagnostic_charge >= plain_charge + 1024 + 2048 + 4096);
    }

    #[test]
    fn score_derived_state_computes_finite_score() {
        let sheet = sheet();
        let state = state_with_one_piece();
        let input = ScoreIrregularLayoutInput {
            sheet: sheet.clone(),
            state,
        };
        let snapshot = empty_snapshot(&sheet);
        let score = score_derived_state(&input, snapshot).expect("finite score");
        assert_eq!(score.unplaced_count, 0.0);
        assert_eq!(score.collision_bounds_area_mm2, 100.0);
        assert_eq!(score.collision_bounds_span_mm, 20.0);
    }

    #[test]
    fn score_derived_state_rejects_undefined_collision_bounds() {
        let sheet = sheet();
        let mut state = state_with_one_piece();
        state.translated_collision_bounds = None;
        let input = ScoreIrregularLayoutInput {
            sheet: sheet.clone(),
            state,
        };
        let snapshot = empty_snapshot(&sheet);
        let error = score_derived_state(&input, snapshot).unwrap_err();
        assert_eq!(error.operation, "scoreState");
    }

    #[test]
    fn free_material_cache_evicts_oldest_key_at_capacity_without_reordering_on_overwrite() {
        let mut cache = FreeMaterialCache::new();
        let snapshot = FreeMaterialSnapshot {
            sheet: sheet(),
            regions: vec![],
            diagnostics: vec![],
        };
        for index in 0..MAX_FREE_MATERIAL_CACHE_ENTRIES {
            cache.set(format!("key-{index}"), snapshot.clone());
        }
        assert_eq!(cache.size(), MAX_FREE_MATERIAL_CACHE_ENTRIES);
        // Overwriting an existing key must not move it to the back of the
        // insertion order (matches JS `Map.set`'s semantics).
        cache.set("key-0".to_string(), snapshot.clone());
        assert_eq!(cache.size(), MAX_FREE_MATERIAL_CACHE_ENTRIES);
        if cache.size() >= MAX_FREE_MATERIAL_CACHE_ENTRIES {
            cache.evict_oldest();
        }
        assert!(cache.get("key-0").is_none());
        assert!(cache.get("key-1").is_some());
    }

    #[test]
    fn get_newly_placed_geometry_requires_exact_reference_identity() {
        let shared_piece = placed(0.0, 0.0, "piece-1");
        let parent = Arc::new(LayoutScorerBeamStateView {
            placed_collision_geometries: vec![shared_piece.clone()],
            translated_collision_bounds: None,
            shared_collision_boundary_length_mm: None,
            shared_collision_boundary_contact_units: None,
            near_complete_structural_contact_count: None,
            dominant_near_complete_structural_contact_count: None,
            canonical_occupied_geometry_key: "parent".to_string(),
            placement_order: vec![PieceId::new("piece-1")],
            unplaced_source_piece_ids: vec![],
            parent: None,
        });
        let newly_placed = placed(20.0, 0.0, "piece-2");
        let child = LayoutScorerBeamStateView {
            placed_collision_geometries: vec![shared_piece, newly_placed.clone()],
            translated_collision_bounds: None,
            shared_collision_boundary_length_mm: None,
            shared_collision_boundary_contact_units: None,
            near_complete_structural_contact_count: None,
            dominant_near_complete_structural_contact_count: None,
            canonical_occupied_geometry_key: "child".to_string(),
            placement_order: vec![PieceId::new("piece-1"), PieceId::new("piece-2")],
            unplaced_source_piece_ids: vec![],
            parent: Some(parent.clone()),
        };
        let result = get_newly_placed_geometry(&child).expect("newly placed geometry found");
        assert!(Arc::ptr_eq(&result, &newly_placed));

        // A value-equal but distinct (non-Arc-shared) first element must not
        // satisfy the reference-identity check.
        let mismatched_child = LayoutScorerBeamStateView {
            placed_collision_geometries: vec![placed(0.0, 0.0, "piece-1"), newly_placed],
            ..child
        };
        assert!(get_newly_placed_geometry(&mismatched_child).is_none());
    }

    #[test]
    fn layout_score_order_dominance_of_unplaced_count() {
        let mut better = state_with_one_piece();
        better.unplaced_source_piece_ids = vec![];
        let mut worse = state_with_one_piece();
        worse.unplaced_source_piece_ids = vec![PieceId::new("unplaced-1")];

        let sheet = sheet();
        let better_score = score_derived_state(
            &ScoreIrregularLayoutInput {
                sheet: sheet.clone(),
                state: better,
            },
            empty_snapshot(&sheet),
        )
        .expect("finite score");
        let worse_score = score_derived_state(
            &ScoreIrregularLayoutInput {
                sheet: sheet.clone(),
                state: worse,
            },
            empty_snapshot(&sheet),
        )
        .expect("finite score");

        assert_eq!(compare_scores(&better_score, &worse_score), Ordering::Less);
    }

    #[test]
    fn make_free_material_cache_key_is_stable_for_identical_inputs_and_varies_by_geometry_key() {
        let sheet = sheet();
        let settings = settings();
        let mut state = state_with_one_piece();
        let first_key = make_free_material_cache_key(&sheet, &settings, &state);
        let second_key = make_free_material_cache_key(&sheet, &settings, &state);
        assert_eq!(first_key, second_key);

        state.canonical_occupied_geometry_key = "different-key".to_string();
        let third_key = make_free_material_cache_key(&sheet, &settings, &state);
        assert_ne!(first_key, third_key);
    }
}
