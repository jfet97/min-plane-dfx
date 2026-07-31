//! Immutable partial-layout search state and its canonical dedup keys.
//!
//! TS source: `src/workers/algorithm/irregular/irregularBeamState.ts` (986
//! lines). Read together with
//! `docs/planning/rust-irregular-backend/characterization/search-scoring.md`
//! (beam-state sections: §1-§9, §12-§13) and
//! `docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
//! before touching this file.
//!
//! Per `search-scoring.md` §1.2: `IrregularBeamState` is **live, heavily
//! used** production code (unlike this cluster's dead-for-production score
//! comparators) -- it is the state-dedup backbone of the intrinsic capacity
//! search and strict decoder. Its canonical-key machinery
//! (`canonicalCollisionPolygonKey`/`canonicalRingKey`/`canonicalPointKey`,
//! feeding `canonicalOccupiedGeometryKey`) is called once per placed piece
//! per candidate, on the hot path (12.9% of CPU per the migration prompt's
//! profiling).
//!
//! # Reused, never duplicated
//!
//! - `checkpoints::canonical_json::{canonical_token, canonical_number,
//!   canonical_record, canonical_entry_list_key}` -- Encoder D, already a
//!   byte-exact port of `canonicalToken`/`canonicalNumber`/`canonicalRecord`/
//!   `canonicalEntryListKey` (`irregularBeamState.ts:829-864`); see that
//!   module's own doc comment, which explicitly names this module as its
//!   intended importer.
//! - `js_number::cmp_js_code_units` -- already a byte-exact port of
//!   `compareCanonicalKeys` (`irregularBeamState.ts:867-871`); see that
//!   function's own doc comment, which names `compareCanonicalKeys` as a
//!   confirmed call site.
//! - `checkpoints::canonical_json::locale_compare_keys` -- this crate's
//!   empirically-validated `localeCompare` equivalent for ASCII keys, used
//!   by `IrregularBeamState::contact_signature_continuation_identity` to
//!   reproduce `contactSignatureContinuationIdentity`'s
//!   `first.localeCompare(second)` sort (`irregularBeamState.ts:166-168`)
//!   byte-exactly; see ruling R22.
//! - `js_number::{fold_negative_zero, is_safe_integer}`,
//!   `js_number::js_math::{min, max, floor, sign}` -- the JS-`Number`/`Math`
//!   semantics primitives this file's arithmetic depends on.
//! - `search::score_grid::canonicalize_irregular_score_millimeter_units` --
//!   already a byte-exact port of `irregularScoreGrid.ts`'s
//!   `canonicalizeIrregularScoreMillimeterUnits`, which
//!   `normalizeCanonicalCoordinate` (`irregularBeamState.ts:852-857`) calls
//!   directly. Per `search-scoring.md` §7.2: "the score-canonicalization
//!   grid and the canonical-key coordinate grid are the same module and the
//!   same constant" even though `irregularScoreGrid.ts` frames itself as
//!   being about scoring.
//! - `validation::spatial_index::{PlacedCollisionSpatialIndex,
//!   PlacedCollisionSpatialEntry, PlacedCollisionValidation,
//!   make_placed_collision_spatial_index}` -- already a byte-exact,
//!   reference-identity-preserving port of `placedCollisionSpatialIndex.ts`,
//!   including the `Arc<IrregularPlacedPiece>`/`Arc::ptr_eq` convention this
//!   file's `matches()` reuse guard (`irregularBeamState.ts:119-124`) and
//!   `sharedBoundaryWithEntries`'s `existingIndex.query(...)` call depend on.
//! - `canonical_grid::contact::measure_shared_convex_polygon_boundary_contact`
//!   -- already a byte-exact port of `convexPolygonContact.ts`'s
//!   `measureSharedConvexPolygonBoundaryContact`.
//!
//! # `Arc<IrregularBeamState>` as the standard container
//!
//! TS's `parent: IrregularBeamState | undefined` field is a bare object
//! reference to a previously-constructed, still-live `IrregularBeamState`
//! instance -- `withPlacement`/`withUnplacedPiece` always set `parent: this`
//! (`irregularBeamState.ts:218,265`), and later cluster files (not ported
//! here) reconstruct winning histories by walking `.parent` chains. Rust has
//! no bare-reference equivalent for a value a *child* state must keep alive
//! after its constructing call returns, so every public API in this module
//! that needs to capture "the exact instance currently being extended" as a
//! surviving `parent` (`with_placement`, `with_unplaced_piece`,
//! `with_bottom_left_anchored`, `with_quarter_turn_bottom_left` -- the two
//! rotation/anchor methods need it only to return `self` unchanged by the
//! same reference when they short-circuit, `irregularBeamState.ts:289,383`)
//! takes `self: Arc<Self>` (one of Rust's built-in supported receiver types,
//! stable, no `arbitrary_self_types` feature needed) and returns
//! `Arc<IrregularBeamState>`. [`IrregularBeamState::empty`] and
//! [`IrregularBeamState::from_input`] (the raw-construction entry point
//! mirroring TS's public `new IrregularBeamState({...})`, used by other
//! cluster files that reconstruct a state from a flat placed-geometry array,
//! `search-scoring.md` §2.2) both return `Arc<IrregularBeamState>` for the
//! same reason: every downstream call needs an `Arc` handle to chain from.
//!
//! # `unplacedPieceIds`/`unplacedSourcePieceIds`: kept as two fields
//!
//! Per `search-scoring.md` §3.2: the TS constructor resolves
//! `input.unplacedPieceIds ?? input.unplacedSourcePieceIds ?? []` once, then
//! populates **both** `this.unplacedPieceIds` and
//! `this.unplacedSourcePieceIds` with that same resolved array -- they are
//! never independently distinct after construction. This module keeps both
//! fields (rather than collapsing to one) for call-site fidelity with other
//! cluster files that read `unplacedSourcePieceIds` by name (not ported
//! here).
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use crate::canonical_grid::contact::measure_shared_convex_polygon_boundary_contact;
use crate::checkpoints::canonical_json::{
    canonical_entry_list_key, canonical_number, canonical_record, json_number_token,
    locale_compare_keys, write_canonical_token, write_indexed_canonical_token,
};
#[cfg(test)]
use crate::domain::IrregularPlacement;
use crate::domain::{
    IrregularBounds, IrregularPlacedPiece, IrregularPoint, IrregularPolygon,
    IrregularPreparedPiece, IrregularTransform, IrregularTransformCandidate, PieceId,
    TransformedCollisionGeometry,
};
use crate::js_number::{cmp_js_code_units, fold_negative_zero, is_safe_integer, js_math};
use crate::validation::spatial_index::{
    make_placed_collision_spatial_index, PlacedCollisionSpatialEntry, PlacedCollisionSpatialIndex,
    PlacedCollisionValidation,
};

use super::score_grid::canonicalize_irregular_score_millimeter_units;

// ===========================================================================
// Small value types (`irregularBeamState.ts:21-28,60-67,71`)
// ===========================================================================

/// TS: `irregularBeamState.ts:21-28` `IrregularCollisionBounds`. A separate
/// shape from [`crate::domain::IrregularBounds`] -- it additionally carries
/// `width`/`height`, matching the TS interface exactly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrregularCollisionBounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
    pub width: f64,
    pub height: f64,
}

/// TS: `irregularBeamState.ts:60-67` `IrregularBeamStatePlacementPhaseTimings`.
/// Diagnostic-only (`search-scoring.md` §10): never fed back into any
/// canonical key, comparator, or persisted result.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IrregularBeamStatePlacementPhaseTimings {
    pub canonical_entry_key_ms: f64,
    pub spatial_index_ms: f64,
    pub contact_measurement_ms: f64,
    pub state_assembly_ms: f64,
    pub bookkeeping_ms: f64,
    pub total_ms: f64,
}

/// TS: `irregularBeamState.ts:71` `type IrregularQuarterTurnDegrees = 0 | 90
/// | 180 | 270`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IrregularQuarterTurnDegrees {
    Zero,
    Ninety,
    OneEighty,
    TwoSeventy,
}

impl IrregularQuarterTurnDegrees {
    fn as_degrees(self) -> f64 {
        match self {
            IrregularQuarterTurnDegrees::Zero => 0.0,
            IrregularQuarterTurnDegrees::Ninety => 90.0,
            IrregularQuarterTurnDegrees::OneEighty => 180.0,
            IrregularQuarterTurnDegrees::TwoSeventy => 270.0,
        }
    }
}

// ===========================================================================
// The `timingNow` injectable clock seam (`irregularBeamState.ts:179`)
// ===========================================================================

/// TS: `input.timingNow ?? performance.now.bind(performance)`
/// (`irregularBeamState.ts:179`). A borrowed closure so callers (future
/// search-loop code, not this module) can inject a deterministic or
/// mock clock for tests exactly like the TS seam allows.
pub type TimingNowFn = dyn Fn() -> f64;

static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Default `timingNow`: milliseconds elapsed since this process's first call
/// into this function -- monotonic and self-consistent within one process,
/// exactly like `performance.now()`'s own contract (relative to
/// `performance.timeOrigin`, never an absolute wall-clock epoch). This value
/// is diagnostic-only (see [`IrregularBeamStatePlacementPhaseTimings`]'s
/// doc), so process-relative monotonicity is all its contract requires.
fn default_timing_now() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// Constructor input shapes
// ===========================================================================

/// TS: `irregularBeamState.ts:30-38` `IrregularBeamStateInput` -- the
/// logical constructor input before TS's private `[derivedMetadata]` symbol
/// key (this module's private [`DerivedMetadata`]/[`IrregularBeamState::from_derived_metadata`]
/// fast path below). Public so other cluster modules (not ported here) can
/// reconstruct a fresh state from a flat placed-geometry array, mirroring
/// every direct `new IrregularBeamState({...})` call site
/// `search-scoring.md` §2.2 inventories.
pub struct IrregularBeamStateInput {
    pub remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub unplaced_piece_ids: Option<Vec<PieceId>>,
    pub unplaced_source_piece_ids: Option<Vec<PieceId>>,
    pub placement_order: Vec<PieceId>,
    pub parent: Option<Arc<IrregularBeamState>>,
    pub placed_collision_index: Option<PlacedCollisionSpatialIndex>,
}

/// TS: `irregularBeamState.ts:172-178`'s inline input object type for
/// `withPlacement`.
pub struct WithPlacementInput<'a> {
    pub remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    pub placed_collision_geometry: Arc<IrregularPlacedPiece>,
    pub placement_order_piece_id: PieceId,
    pub on_phase_timings: Option<&'a mut dyn FnMut(IrregularBeamStatePlacementPhaseTimings)>,
    pub timing_now: Option<&'a TimingNowFn>,
}

/// TS: `irregularBeamState.ts:255-258`'s inline input object type for
/// `withUnplacedPiece`.
pub struct WithUnplacedPieceInput {
    pub remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    pub unplaced_piece_id: PieceId,
}

// ===========================================================================
// Derived metadata (TS's private `Symbol('derivedMetadata')`-keyed fast path)
// ===========================================================================

/// TS: `irregularBeamState.ts:40-50` `DerivedIrregularBeamStateMetadata`,
/// carried through TS's private `[derivedMetadata]` construction-input key
/// (`irregularBeamState.ts:69,73-75`). Every incremental transition
/// (`withPlacement`, `withUnplacedPiece`, `withBottomLeftAnchored`,
/// `withQuarterTurnBottomLeft`) computes one of these directly instead of
/// re-deriving from scratch; only a raw external construction
/// ([`IrregularBeamState::from_input`]/[`IrregularBeamState::empty`]) always
/// triggers a fresh [`derive_metadata`] call.
struct DerivedMetadata {
    canonical_entry_keys: Vec<String>,
    canonical_occupied_geometry_key: String,
    translated_collision_bounds: Option<IrregularCollisionBounds>,
    shared_collision_boundary_length_mm: Option<f64>,
    shared_collision_boundary_contact_units: Option<f64>,
    near_complete_structural_contact_count: Option<f64>,
    dominant_near_complete_structural_contact_count: Option<f64>,
    near_complete_structural_contact_signature_counts: Option<HashMap<String, f64>>,
    placed_collision_index: PlacedCollisionSpatialIndex,
}

// ===========================================================================
// `IrregularBeamState` (`irregularBeamState.ts:78-473`)
// ===========================================================================

/// TS: `irregularBeamState.ts:78-473` `class IrregularBeamState`. The
/// algorithm-owned partial irregular layout retained by a beam.
///
/// Immutable: every "transition" (`with_placement`, `with_unplaced_piece`,
/// `with_bottom_left_anchored`, `with_quarter_turn_bottom_left`) constructs
/// a brand-new instance from an existing one, never mutates in place --
/// matching `search-scoring.md` §4's "no in-place mutation of an existing
/// instance anywhere in this cluster."
#[derive(Debug)]
pub struct IrregularBeamState {
    /// Prepared pieces that have not yet been attempted by this state.
    pub remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    /// Collision geometries committed to this state, in placement order.
    /// `Arc`-wrapped (not a plain `Vec<IrregularPlacedPiece>`) so this
    /// array's elements and [`Self::placed_collision_index`]'s entries can
    /// share the exact same underlying allocation -- required for
    /// [`PlacedCollisionSpatialIndex::matches`]'s reference-identity check
    /// (`irregularBeamState.ts:122`) to be meaningful at all.
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    /// Prepared ids consumed without a committed legal placement.
    pub unplaced_piece_ids: Vec<PieceId>,
    /// Legacy name retained for existing scorer callers (see this module's
    /// top doc: identical content to `unplaced_piece_ids`, kept as a
    /// separate field for call-site fidelity).
    pub unplaced_source_piece_ids: Vec<PieceId>,
    /// Prepared ids of committed placements, retained as a deterministic
    /// history.
    pub placement_order: Vec<PieceId>,
    /// Previous state on this branch, retained only while reconstructing
    /// winning history.
    pub parent: Option<Arc<IrregularBeamState>>,
    /// Exact occupancy identity independent of placement-array order.
    pub canonical_occupied_geometry_key: String,
    /// Bounds around translated collision polygons retained for derived
    /// scoring.
    pub translated_collision_bounds: Option<IrregularCollisionBounds>,
    /// Exact cumulative boundary shared by translated collision polygons.
    pub shared_collision_boundary_length_mm: Option<f64>,
    /// Shared boundary measured in fractions of the smaller polygon's
    /// longest edge.
    pub shared_collision_boundary_contact_units: Option<f64>,
    /// Near-complete overlaps between collision edges at structural polygon
    /// scale.
    pub near_complete_structural_contact_count: Option<f64>,
    /// Largest repeated local structural-contact pattern frequency.
    pub dominant_near_complete_structural_contact_count: Option<f64>,
    /// Persistent conservative index for translated placed collision
    /// bounds.
    pub placed_collision_index: PlacedCollisionSpatialIndex,

    canonical_entry_keys: Vec<String>,
    near_complete_structural_contact_signature_counts: Option<HashMap<String, f64>>,
}

impl IrregularBeamState {
    /// TS: `irregularBeamState.ts:111-136` the constructor body, minus the
    /// `input[derivedMetadata]` lookup itself (that's this function's
    /// `metadata` parameter: `None` mirrors the symbol key being absent,
    /// triggering [`derive_metadata`], `irregularBeamState.ts:119`).
    fn construct(
        input: IrregularBeamStateInput,
        metadata: Option<DerivedMetadata>,
    ) -> IrregularBeamState {
        let remaining_prepared_pieces = input.remaining_prepared_pieces;
        let placed_collision_geometries = input.placed_collision_geometries;
        // TS: `input.unplacedPieceIds ?? input.unplacedSourcePieceIds ?? []`
        // (`irregularBeamState.ts:114`).
        let resolved_unplaced_piece_ids = input
            .unplaced_piece_ids
            .or(input.unplaced_source_piece_ids)
            .unwrap_or_default();
        let placement_order = input.placement_order;
        let parent = input.parent;

        let DerivedMetadata {
            canonical_entry_keys,
            canonical_occupied_geometry_key,
            translated_collision_bounds,
            shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units,
            near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count,
            near_complete_structural_contact_signature_counts,
            placed_collision_index: metadata_placed_collision_index,
        } = metadata.unwrap_or_else(|| derive_metadata(&placed_collision_geometries));

        // TS: `irregularBeamState.ts:120-124` -- prefer the caller-supplied
        // index, fall back to the metadata's, but only ever trust either one
        // after `.matches(...)` confirms it actually corresponds to this
        // exact `placedCollisionGeometries` array by reference identity.
        let placed_collision_index = match input.placed_collision_index {
            Some(candidate) => candidate,
            None => metadata_placed_collision_index,
        };
        let placed_collision_index = if placed_collision_index.matches(&placed_collision_geometries)
        {
            placed_collision_index
        } else {
            make_placed_collision_spatial_index(&placed_collision_geometries, None)
        };

        IrregularBeamState {
            remaining_prepared_pieces,
            placed_collision_geometries,
            unplaced_piece_ids: resolved_unplaced_piece_ids.clone(),
            unplaced_source_piece_ids: resolved_unplaced_piece_ids,
            placement_order,
            parent,
            canonical_occupied_geometry_key,
            translated_collision_bounds,
            shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units,
            near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count,
            placed_collision_index,
            canonical_entry_keys,
            near_complete_structural_contact_signature_counts,
        }
    }

    /// TS: `irregularBeamState.ts:467-472` `static fromDerivedMetadata`
    /// (private).
    fn from_derived_metadata(
        input: IrregularBeamStateInput,
        metadata: DerivedMetadata,
    ) -> IrregularBeamState {
        IrregularBeamState::construct(input, Some(metadata))
    }

    /// TS: `irregularBeamState.ts:139-146` `static empty`. Creates the empty
    /// layout state without inventing any geometry or result.
    pub fn empty(
        remaining_prepared_pieces: Vec<Arc<IrregularPreparedPiece>>,
    ) -> Arc<IrregularBeamState> {
        Arc::new(IrregularBeamState::construct(
            IrregularBeamStateInput {
                remaining_prepared_pieces,
                placed_collision_geometries: Vec::new(),
                unplaced_piece_ids: None,
                unplaced_source_piece_ids: Some(Vec::new()),
                placement_order: Vec::new(),
                parent: None,
                placed_collision_index: None,
            },
            None,
        ))
    }

    /// TS: the public `new IrregularBeamState({...})` raw-construction path
    /// used by other cluster files (not ported here) to reconstruct a state
    /// from a flat `placedCollisionGeometries` array -- always triggers a
    /// fresh [`derive_metadata`] call (`search-scoring.md` §2.2/§4.3), unlike
    /// the incremental transitions below.
    pub fn from_input(input: IrregularBeamStateInput) -> Arc<IrregularBeamState> {
        Arc::new(IrregularBeamState::construct(input, None))
    }

    /// TS: `irregularBeamState.ts:149-156` `continuationMetadataIdentity`.
    ///
    /// Embeds [`Self::canonical_entry_continuation_identity`],
    /// [`Self::contact_signature_continuation_identity`], and
    /// [`PlacedCollisionSpatialIndex::continuation_identity`] as three
    /// **string** property values (each already independently
    /// JSON-serialized) inside one more `JSON.stringify` call -- verified
    /// empirically against Node v24 that this double-encodes each inner
    /// string (quoting and escaping it again), and that a `None`
    /// [`Self::contact_signature_continuation_identity`] causes the
    /// `nearCompleteStructuralContactSignatureCounts` key to be **omitted**
    /// from the output entirely (`JSON.stringify` drops `undefined`-valued
    /// object properties rather than emitting `null`) -- reproduced here via
    /// `#[serde(skip_serializing_if = "Option::is_none")]`, not a
    /// `null`-valued field.
    pub fn continuation_metadata_identity(&self) -> String {
        #[derive(serde::Serialize)]
        struct ContinuationMetadataIdentity {
            #[serde(rename = "canonicalEntryKeys")]
            canonical_entry_keys: String,
            #[serde(
                rename = "nearCompleteStructuralContactSignatureCounts",
                skip_serializing_if = "Option::is_none"
            )]
            near_complete_structural_contact_signature_counts: Option<String>,
            #[serde(rename = "placedCollisionIndex")]
            placed_collision_index: String,
        }

        let identity = ContinuationMetadataIdentity {
            canonical_entry_keys: self.canonical_entry_continuation_identity(),
            near_complete_structural_contact_signature_counts: self
                .contact_signature_continuation_identity(),
            placed_collision_index: self.placed_collision_index.continuation_identity(),
        };
        serde_json::to_string(&identity).expect("continuation metadata identity always serializes")
    }

    /// TS: `irregularBeamState.ts:158-160` `canonicalEntryContinuationIdentity`.
    pub fn canonical_entry_continuation_identity(&self) -> String {
        serde_json::to_string(&self.canonical_entry_keys)
            .expect("canonical entry keys always serialize")
    }

    /// TS: `irregularBeamState.ts:162-170` `contactSignatureContinuationIdentity`.
    ///
    /// Returns `None` exactly when the TS original's
    /// `JSON.stringify(undefined)` call evaluates to the JS runtime value
    /// `undefined` -- **not** the string `"undefined"` -- despite the TS
    /// method's own `string` return-type annotation (verified empirically
    /// against Node v24; see [`Self::continuation_metadata_identity`]'s doc
    /// for why the distinction is load-bearing one level up).
    ///
    /// # Sort order: byte-exact `localeCompare` parity
    ///
    /// TS sorts `[...map.entries()]` by `first.localeCompare(second)`
    /// (`irregularBeamState.ts:166-168`), the ICU-backed default-locale
    /// collator, before serializing. This function previously sorted by
    /// [`cmp_js_code_units`] (plain UTF-16 code-unit order) instead, on the
    /// premise that this value's only confirmed consumer
    /// (`intrinsicCapacitySearch.ts:1393-1394`, not ported here) was a
    /// same-process, same-language equality check (a staleness assertion),
    /// never a cross-language byte comparison -- see
    /// `docs/planning/rust-irregular-backend/stage0-rulings.md` R22. That
    /// premise was revoked 2026-07-30: this string is embedded (via
    /// [`Self::continuation_metadata_identity`]) in both
    /// `search::strict_decoder`'s and `capacity::search`'s
    /// cross-language, parity-gated checkpoint `integrityHash` preimages.
    /// This function now sorts by
    /// [`locale_compare_keys`](crate::checkpoints::canonical_json::locale_compare_keys),
    /// this crate's empirically-validated `localeCompare` equivalent for
    /// ASCII keys (every structural-contact-signature string is ASCII
    /// digits/colons/hyphens), matching Encoders B/C's own key-sort in
    /// `checkpoints::canonical_json` exactly.
    ///
    /// # Count rendering: `json_number_token`, not `serde_json`'s `f64` default
    ///
    /// `count` is stored as `f64` (every JS `number` is), always a
    /// non-negative integer by construction. Rendering the `(String, f64)`
    /// pair list through a single `serde_json::to_string` call (as this
    /// function previously did) would print a whole-valued count like `1.0`
    /// with a trailing `.0`, exactly the hazard
    /// [`json_number_token`](crate::checkpoints::canonical_json::json_number_token)
    /// exists to avoid -- JS `JSON.stringify` prints `1`, never `1.0`. This
    /// function therefore builds the `[[signature,count],...]` JSON string
    /// by hand, routing `count` through `json_number_token` the same way
    /// [`PlacedCollisionSpatialIndex::continuation_identity`] routes
    /// `cellSizeMm`.
    pub fn contact_signature_continuation_identity(&self) -> Option<String> {
        let counts = self
            .near_complete_structural_contact_signature_counts
            .as_ref()?;
        let mut entries: Vec<(&String, &f64)> = counts.iter().collect();
        entries.sort_by(|(first, _), (second, _)| locale_compare_keys(first, second));
        let pairs_json = entries
            .into_iter()
            .map(|(signature, count)| {
                format!(
                    "[{},{}]",
                    serde_json::to_string(signature).expect("signature always serializes"),
                    json_number_token(*count),
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        Some(format!("[{pairs_json}]"))
    }

    /// TS: `irregularBeamState.ts:172-253` `withPlacement` -- the hot-path
    /// transition. Called once per committed placement decision.
    pub fn with_placement(
        self: Arc<Self>,
        mut input: WithPlacementInput<'_>,
    ) -> Arc<IrregularBeamState> {
        let default_timing_now_ref: &TimingNowFn = &default_timing_now;
        let timing_now: &TimingNowFn = input.timing_now.unwrap_or(default_timing_now_ref);
        let has_phase_timings = input.on_phase_timings.is_some();

        let started_at = if has_phase_timings { timing_now() } else { 0.0 };

        // TS: `irregularBeamState.ts:181-184`.
        let mut placed_collision_geometries = self.placed_collision_geometries.clone();
        placed_collision_geometries.push(Arc::clone(&input.placed_collision_geometry));

        // TS: `irregularBeamState.ts:185-191` -- sorted-insertion, not
        // append-then-sort (see [`insert_canonical_entry_key`]'s doc).
        let canonical_entry_started_at = if has_phase_timings { timing_now() } else { 0.0 };
        let canonical_entry_keys = insert_canonical_entry_key(
            &self.canonical_entry_keys,
            canonical_placed_geometry_key(&input.placed_collision_geometry),
        );
        let canonical_entry_key_ms = if has_phase_timings {
            timing_now() - canonical_entry_started_at
        } else {
            0.0
        };

        // TS: `irregularBeamState.ts:192-196`.
        let spatial_index_started_at = if has_phase_timings { timing_now() } else { 0.0 };
        let placed_collision_index = self
            .placed_collision_index
            .add(Arc::clone(&input.placed_collision_geometry));
        let added_entry = placed_collision_index.entries().last();
        let spatial_index_ms = if has_phase_timings {
            timing_now() - spatial_index_started_at
        } else {
            0.0
        };

        // TS: `irregularBeamState.ts:197-210` -- measured against
        // `this.placedCollisionIndex`, the OLD pre-add index, not the new
        // local `placedCollisionIndex` above (`search-scoring.md` §4.1 step
        // 4/§13.1).
        let contact_started_at = if has_phase_timings { timing_now() } else { 0.0 };
        let current = CurrentSharedCollisionBoundaryMetrics {
            length_mm: self.shared_collision_boundary_length_mm,
            normalized_units: self.shared_collision_boundary_contact_units,
            near_complete_structural_contact_count: self.near_complete_structural_contact_count,
            near_complete_structural_contact_signature_counts: self
                .near_complete_structural_contact_signature_counts
                .as_ref(),
        };
        let shared_boundary_metrics = extend_shared_collision_boundary_metrics(
            &current,
            &self.placed_collision_index,
            added_entry,
        );
        let contact_measurement_ms = if has_phase_timings {
            timing_now() - contact_started_at
        } else {
            0.0
        };

        // TS: `irregularBeamState.ts:211-237`.
        let state_assembly_started_at = if has_phase_timings { timing_now() } else { 0.0 };

        let translated_collision_bounds = if self.placed_collision_geometries.is_empty() {
            derive_placed_collision_bounds(&input.placed_collision_geometry)
        } else {
            extend_collision_bounds(
                self.translated_collision_bounds.as_ref(),
                &input.placed_collision_geometry,
            )
        };

        let metadata = DerivedMetadata {
            canonical_occupied_geometry_key: canonical_entry_list_key(&canonical_entry_keys),
            translated_collision_bounds,
            shared_collision_boundary_length_mm: shared_boundary_metrics
                .as_ref()
                .map(|m| m.length_mm),
            shared_collision_boundary_contact_units: shared_boundary_metrics
                .as_ref()
                .map(|m| m.normalized_units),
            near_complete_structural_contact_count: shared_boundary_metrics
                .as_ref()
                .map(|m| m.near_complete_structural_contact_count),
            dominant_near_complete_structural_contact_count: shared_boundary_metrics
                .as_ref()
                .map(|m| m.dominant_near_complete_structural_contact_count),
            near_complete_structural_contact_signature_counts: shared_boundary_metrics
                .map(|m| m.near_complete_structural_contact_signature_counts),
            canonical_entry_keys,
            placed_collision_index,
        };

        let mut placement_order = self.placement_order.clone();
        placement_order.push(input.placement_order_piece_id);
        let unplaced_piece_ids = self.unplaced_piece_ids.clone();

        let result = IrregularBeamState::from_derived_metadata(
            IrregularBeamStateInput {
                remaining_prepared_pieces: input.remaining_prepared_pieces,
                placed_collision_geometries,
                unplaced_piece_ids: Some(unplaced_piece_ids),
                unplaced_source_piece_ids: None,
                placement_order,
                parent: Some(Arc::clone(&self)),
                placed_collision_index: None,
            },
            metadata,
        );

        // TS: `irregularBeamState.ts:238-251`.
        if let Some(callback) = input.on_phase_timings.take() {
            let state_assembly_ms = timing_now() - state_assembly_started_at;
            let total_ms = timing_now() - started_at;
            let measured_ms = canonical_entry_key_ms
                + spatial_index_ms
                + contact_measurement_ms
                + state_assembly_ms;
            callback(IrregularBeamStatePlacementPhaseTimings {
                canonical_entry_key_ms,
                spatial_index_ms,
                contact_measurement_ms,
                state_assembly_ms,
                bookkeeping_ms: js_math::max(0.0, total_ms - measured_ms),
                total_ms,
            });
        }

        Arc::new(result)
    }

    /// TS: `irregularBeamState.ts:255-281` `withUnplacedPiece`.
    pub fn with_unplaced_piece(
        self: Arc<Self>,
        input: WithUnplacedPieceInput,
    ) -> Arc<IrregularBeamState> {
        let mut unplaced_piece_ids = self.unplaced_piece_ids.clone();
        unplaced_piece_ids.push(input.unplaced_piece_id);

        let metadata = DerivedMetadata {
            canonical_entry_keys: self.canonical_entry_keys.clone(),
            canonical_occupied_geometry_key: self.canonical_occupied_geometry_key.clone(),
            translated_collision_bounds: self.translated_collision_bounds,
            shared_collision_boundary_length_mm: self.shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units: self.shared_collision_boundary_contact_units,
            near_complete_structural_contact_count: self.near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count: self
                .dominant_near_complete_structural_contact_count,
            near_complete_structural_contact_signature_counts: self
                .near_complete_structural_contact_signature_counts
                .clone(),
            placed_collision_index: self.placed_collision_index.clone(),
        };

        let placement_order = self.placement_order.clone();
        let placed_collision_geometries = self.placed_collision_geometries.clone();

        Arc::new(IrregularBeamState::from_derived_metadata(
            IrregularBeamStateInput {
                remaining_prepared_pieces: input.remaining_prepared_pieces,
                placed_collision_geometries,
                unplaced_piece_ids: Some(unplaced_piece_ids),
                unplaced_source_piece_ids: None,
                placement_order,
                parent: Some(Arc::clone(&self)),
                placed_collision_index: None,
            },
            metadata,
        ))
    }

    /// TS: `irregularBeamState.ts:287-351` `withBottomLeftAnchored`. Rigidly
    /// translates the layout to the sheet bottom-left while preserving
    /// translation-invariant contact metadata derived before the coordinate
    /// shift.
    ///
    /// Returns `self` unchanged (same `Arc`, no new allocation) when bounds
    /// are absent or already anchored at `(0, 0)`
    /// (`irregularBeamState.ts:289`), and `None` if any translated
    /// coordinate becomes non-finite (`irregularBeamState.ts:297`).
    pub fn with_bottom_left_anchored(self: Arc<Self>) -> Option<Arc<IrregularBeamState>> {
        // TS: `bounds === undefined || (bounds.minX === 0 && bounds.minY ===
        // 0)) return this` (`irregularBeamState.ts:289`) -- an absent
        // `translatedCollisionBounds` is a no-op short-circuit that returns
        // the current instance unchanged, exactly like the already-anchored
        // case below. It must NOT be conflated with this method's own
        // `undefined`-on-non-finite-coordinate failure mode
        // (`irregularBeamState.ts:297`), which only applies once a `bounds`
        // value is actually in hand.
        let bounds = match self.translated_collision_bounds {
            Some(bounds) => bounds,
            None => return Some(self),
        };
        if bounds.min_x == 0.0 && bounds.min_y == 0.0 {
            return Some(self);
        }

        let translate_x = -bounds.min_x;
        let translate_y = -bounds.min_y;
        let mut placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>> =
            Vec::with_capacity(self.placed_collision_geometries.len());
        for placed in &self.placed_collision_geometries {
            let next_translate_x = placed.placement.transform.translate_x + translate_x;
            let next_translate_y = placed.placement.transform.translate_y + translate_y;
            if !next_translate_x.is_finite() || !next_translate_y.is_finite() {
                return None;
            }
            let mut placement = placed.placement.clone();
            placement.transform.translate_x = next_translate_x;
            placement.transform.translate_y = next_translate_y;
            placed_collision_geometries.push(Arc::new(IrregularPlacedPiece {
                placement,
                collision_geometry: placed.collision_geometry.clone(),
            }));
        }

        let mut canonical_entry_keys: Vec<String> = placed_collision_geometries
            .iter()
            .map(|placed| canonical_placed_geometry_key(placed))
            .collect();
        canonical_entry_keys.sort_by(|first, second| cmp_js_code_units(first, second));
        let placed_collision_index =
            make_placed_collision_spatial_index(&placed_collision_geometries, None);

        let metadata = DerivedMetadata {
            canonical_occupied_geometry_key: canonical_entry_list_key(&canonical_entry_keys),
            translated_collision_bounds: Some(IrregularCollisionBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: bounds.width,
                max_y: bounds.height,
                width: bounds.width,
                height: bounds.height,
            }),
            shared_collision_boundary_length_mm: self.shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units: self.shared_collision_boundary_contact_units,
            near_complete_structural_contact_count: self.near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count: self
                .dominant_near_complete_structural_contact_count,
            near_complete_structural_contact_signature_counts: self
                .near_complete_structural_contact_signature_counts
                .clone(),
            canonical_entry_keys,
            placed_collision_index: placed_collision_index.clone(),
        };

        Some(Arc::new(IrregularBeamState::from_derived_metadata(
            IrregularBeamStateInput {
                remaining_prepared_pieces: self.remaining_prepared_pieces.clone(),
                placed_collision_geometries,
                unplaced_piece_ids: Some(self.unplaced_piece_ids.clone()),
                unplaced_source_piece_ids: None,
                placement_order: self.placement_order.clone(),
                parent: self.parent.clone(),
                placed_collision_index: Some(placed_collision_index),
            },
            metadata,
        )))
    }

    /// TS: `irregularBeamState.ts:357-376`
    /// `bottomLeftAnchoredCanonicalOccupiedGeometryKey`. Computes the exact
    /// occupied-geometry identity [`Self::with_bottom_left_anchored`] would
    /// produce, without rebuilding placements or the spatial index -- used
    /// as a fast dedup probe. Per `search-scoring.md` §4.4, this must stay
    /// textually parallel to [`Self::with_bottom_left_anchored`]'s own key
    /// derivation.
    pub fn bottom_left_anchored_canonical_occupied_geometry_key(&self) -> Option<String> {
        // TS: `bounds === undefined || (bounds.minX === 0 && bounds.minY ===
        // 0)) { return this.canonicalOccupiedGeometryKey }`
        // (`irregularBeamState.ts:359-361`) -- see the matching comment in
        // `with_bottom_left_anchored` above: an absent bounds value is a
        // defined-key short-circuit here too, not a failure.
        let bounds = match self.translated_collision_bounds {
            Some(bounds) => bounds,
            None => return Some(self.canonical_occupied_geometry_key.clone()),
        };
        if bounds.min_x == 0.0 && bounds.min_y == 0.0 {
            return Some(self.canonical_occupied_geometry_key.clone());
        }

        let translate_x = -bounds.min_x;
        let translate_y = -bounds.min_y;
        let mut canonical_entry_keys: Vec<String> =
            Vec::with_capacity(self.placed_collision_geometries.len());
        for placed in &self.placed_collision_geometries {
            let next_translate_x = placed.placement.transform.translate_x + translate_x;
            let next_translate_y = placed.placement.transform.translate_y + translate_y;
            if !next_translate_x.is_finite() || !next_translate_y.is_finite() {
                return None;
            }
            canonical_entry_keys.push(canonical_placed_geometry_key_at_translation(
                placed,
                next_translate_x,
                next_translate_y,
            ));
        }
        canonical_entry_keys.sort_by(|first, second| cmp_js_code_units(first, second));
        Some(canonical_entry_list_key(&canonical_entry_keys))
    }

    /// TS: `irregularBeamState.ts:379-465` `withQuarterTurnBottomLeft`.
    /// Rigidly rotates the complete layout, then anchors its occupied
    /// bounds bottom-left.
    pub fn with_quarter_turn_bottom_left(
        self: Arc<Self>,
        rotation_deg: IrregularQuarterTurnDegrees,
    ) -> Option<Arc<IrregularBeamState>> {
        if rotation_deg == IrregularQuarterTurnDegrees::Zero {
            return self.with_bottom_left_anchored();
        }
        if self.placed_collision_geometries.is_empty() {
            return Some(self);
        }

        let mut placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>> =
            Vec::with_capacity(self.placed_collision_geometries.len());
        for placed in &self.placed_collision_geometries {
            let rotated_translation = rotate_quarter_turn_point(
                IrregularPoint::new(
                    placed.placement.transform.translate_x,
                    placed.placement.transform.translate_y,
                ),
                rotation_deg,
            );
            let rotated_points: Vec<IrregularPoint> = placed
                .collision_geometry
                .polygon
                .points
                .iter()
                .map(|point| rotate_quarter_turn_point(*point, rotation_deg))
                .collect();
            let rotated_bounds = bounds_for_points_unchecked(&rotated_points)?;

            let rotated_transform = IrregularTransformCandidate {
                index: placed.collision_geometry.transform.index,
                rotation_deg: normalize_rotation_degrees(
                    placed.collision_geometry.transform.rotation_deg + rotation_deg.as_degrees(),
                ),
                mirrored: placed.collision_geometry.transform.mirrored,
                reason: placed.collision_geometry.transform.reason,
            };

            let mut placement = placed.placement.clone();
            placement.transform = IrregularTransform {
                translate_x: rotated_translation.x,
                translate_y: rotated_translation.y,
                rotation_deg: normalize_rotation_degrees(
                    placed.placement.transform.rotation_deg + rotation_deg.as_degrees(),
                ),
                mirrored: placed.placement.transform.mirrored,
            };

            placed_collision_geometries.push(Arc::new(IrregularPlacedPiece {
                placement,
                collision_geometry: TransformedCollisionGeometry {
                    source_piece_id: placed.collision_geometry.source_piece_id.clone(),
                    transform: rotated_transform,
                    polygon: IrregularPolygon::new(rotated_points),
                    bounds: rotated_bounds,
                },
            }));
        }

        let mut canonical_entry_keys: Vec<String> = placed_collision_geometries
            .iter()
            .map(|placed| canonical_placed_geometry_key(placed))
            .collect();
        canonical_entry_keys.sort_by(|first, second| cmp_js_code_units(first, second));
        let placed_collision_index =
            make_placed_collision_spatial_index(&placed_collision_geometries, None);

        let metadata = DerivedMetadata {
            canonical_occupied_geometry_key: canonical_entry_list_key(&canonical_entry_keys),
            translated_collision_bounds: derive_collision_bounds(&placed_collision_geometries),
            shared_collision_boundary_length_mm: self.shared_collision_boundary_length_mm,
            shared_collision_boundary_contact_units: self.shared_collision_boundary_contact_units,
            near_complete_structural_contact_count: self.near_complete_structural_contact_count,
            dominant_near_complete_structural_contact_count: self
                .dominant_near_complete_structural_contact_count,
            near_complete_structural_contact_signature_counts: self
                .near_complete_structural_contact_signature_counts
                .clone(),
            canonical_entry_keys,
            placed_collision_index: placed_collision_index.clone(),
        };

        let rotated_state = Arc::new(IrregularBeamState::from_derived_metadata(
            IrregularBeamStateInput {
                remaining_prepared_pieces: self.remaining_prepared_pieces.clone(),
                placed_collision_geometries,
                unplaced_piece_ids: Some(self.unplaced_piece_ids.clone()),
                unplaced_source_piece_ids: None,
                placement_order: self.placement_order.clone(),
                parent: self.parent.clone(),
                placed_collision_index: Some(placed_collision_index),
            },
            metadata,
        ));
        rotated_state.with_bottom_left_anchored()
    }
}

// ===========================================================================
// `sharedBoundaryWithEntries`/`extendSharedCollisionBoundaryMetrics`/
// `deriveSharedCollisionBoundaryMetrics` (`irregularBeamState.ts:541-712`)
// ===========================================================================

/// Internal counterpart of TS's `SharedCollisionBoundaryMetrics`
/// (`irregularBeamState.ts:52-58`), returned by the three functions below.
struct SharedCollisionBoundaryMetricsInternal {
    length_mm: f64,
    normalized_units: f64,
    near_complete_structural_contact_count: f64,
    dominant_near_complete_structural_contact_count: f64,
    near_complete_structural_contact_signature_counts: HashMap<String, f64>,
}

/// Mirrors `extendSharedCollisionBoundaryMetrics`'s anonymous `current`
/// parameter object literal (`irregularBeamState.ts:583-590`).
struct CurrentSharedCollisionBoundaryMetrics<'a> {
    length_mm: Option<f64>,
    normalized_units: Option<f64>,
    near_complete_structural_contact_count: Option<f64>,
    near_complete_structural_contact_signature_counts: Option<&'a HashMap<String, f64>>,
}

/// TS: `irregularBeamState.ts:541-580` `deriveSharedCollisionBoundaryMetrics`.
/// Used by fresh/from-scratch derivation ([`derive_metadata`]).
///
/// Per `search-scoring.md` §7.4: the exact nested summation order is outer
/// `j` from `0` to `N-1` (entry ordinal), inner `i` from `0` to `j-1` (prior
/// entry ordinal by ordinal, **not** filtered by spatial-index query) --
/// each inner sum left-to-right, each outer accumulation left-to-right. Do
/// not "optimize" this into [`extend_shared_collision_boundary_metrics`]'s
/// spatial-index-query-pruned strategy: the two are only guaranteed
/// bit-identical because bbox-disjoint pairs contribute a literal exact
/// `0.0`, a fact proved by `canonical_grid::contact`, not by this function.
fn derive_shared_collision_boundary_metrics(
    placed_collision_geometries: &[Arc<IrregularPlacedPiece>],
) -> Option<SharedCollisionBoundaryMetricsInternal> {
    let index = make_placed_collision_spatial_index(placed_collision_geometries, None);
    let mut total_length_mm = 0.0_f64;
    let mut total_normalized_units = 0.0_f64;
    let mut near_complete_structural_contact_count = 0.0_f64;
    let mut signature_counts: HashMap<String, f64> = HashMap::new();

    for entry in index.entries() {
        let prior_entries = &index.entries()[0..entry.ordinal];
        let additional = shared_boundary_with_entries(entry, prior_entries)?;
        total_length_mm += additional.length_mm;
        total_normalized_units += additional.normalized_units;
        near_complete_structural_contact_count += additional.near_complete_structural_contact_count;
        if !merge_structural_contact_signature_counts(
            &mut signature_counts,
            &additional.near_complete_structural_contact_signature_counts,
        ) {
            return None;
        }
        if !total_length_mm.is_finite()
            || !total_normalized_units.is_finite()
            || !is_safe_integer(near_complete_structural_contact_count)
        {
            return None;
        }
    }

    Some(SharedCollisionBoundaryMetricsInternal {
        length_mm: total_length_mm,
        normalized_units: total_normalized_units,
        near_complete_structural_contact_count,
        dominant_near_complete_structural_contact_count: dominant_signature_count(
            &signature_counts,
        ),
        near_complete_structural_contact_signature_counts: signature_counts,
    })
}

/// TS: `irregularBeamState.ts:582-636` `extendSharedCollisionBoundaryMetrics`.
/// Used by the incremental [`IrregularBeamState::with_placement`] path:
/// queries `existing_index` (bbox-pruned), not a full ordinal slice.
fn extend_shared_collision_boundary_metrics(
    current: &CurrentSharedCollisionBoundaryMetrics<'_>,
    existing_index: &PlacedCollisionSpatialIndex,
    added_entry: Option<&PlacedCollisionSpatialEntry>,
) -> Option<SharedCollisionBoundaryMetricsInternal> {
    let length_mm = current.length_mm?;
    let normalized_units = current.normalized_units?;
    let count = current.near_complete_structural_contact_count?;
    let signature_counts = current.near_complete_structural_contact_signature_counts?;
    let added_entry = added_entry?;
    let added_translated = match &added_entry.validation {
        PlacedCollisionValidation::Valid(valid) => &valid.polygon_with_bounds,
        PlacedCollisionValidation::Invalid { .. } => return None,
    };

    let query_result = existing_index.query(Some(&added_translated.bounds));
    let additional = shared_boundary_with_entries(added_entry, &query_result)?;

    let new_length_mm = length_mm + additional.length_mm;
    let new_normalized_units = normalized_units + additional.normalized_units;
    let new_count = count + additional.near_complete_structural_contact_count;
    let mut new_signature_counts = signature_counts.clone();
    if !merge_structural_contact_signature_counts(
        &mut new_signature_counts,
        &additional.near_complete_structural_contact_signature_counts,
    ) {
        return None;
    }

    if new_length_mm.is_finite() && new_normalized_units.is_finite() && is_safe_integer(new_count) {
        Some(SharedCollisionBoundaryMetricsInternal {
            length_mm: new_length_mm,
            normalized_units: new_normalized_units,
            near_complete_structural_contact_count: new_count,
            dominant_near_complete_structural_contact_count: dominant_signature_count(
                &new_signature_counts,
            ),
            near_complete_structural_contact_signature_counts: new_signature_counts,
        })
    } else {
        None
    }
}

/// TS: `irregularBeamState.ts:638-682` `sharedBoundaryWithEntries`.
fn shared_boundary_with_entries(
    added_entry: &PlacedCollisionSpatialEntry,
    existing_entries: &[PlacedCollisionSpatialEntry],
) -> Option<SharedCollisionBoundaryMetricsInternal> {
    let added_translated = match &added_entry.validation {
        PlacedCollisionValidation::Valid(valid) => &valid.polygon_with_bounds,
        PlacedCollisionValidation::Invalid { .. } => return None,
    };

    let mut total_length_mm = 0.0_f64;
    let mut total_normalized_units = 0.0_f64;
    let mut near_complete_structural_contact_count = 0.0_f64;
    let mut signature_counts: HashMap<String, f64> = HashMap::new();

    for existing_entry in existing_entries {
        let existing_translated = match &existing_entry.validation {
            PlacedCollisionValidation::Valid(valid) => &valid.polygon_with_bounds,
            PlacedCollisionValidation::Invalid { .. } => return None,
        };
        let contact =
            measure_shared_convex_polygon_boundary_contact(added_translated, existing_translated)?;
        total_length_mm += contact.length_mm;
        total_normalized_units += contact.normalized_units;
        near_complete_structural_contact_count += contact.near_complete_structural_contact_count;
        if !add_structural_contact_signatures(
            &mut signature_counts,
            &contact.near_complete_structural_contact_signatures,
        ) {
            return None;
        }
        if !total_length_mm.is_finite()
            || !total_normalized_units.is_finite()
            || !is_safe_integer(near_complete_structural_contact_count)
        {
            return None;
        }
    }

    Some(SharedCollisionBoundaryMetricsInternal {
        length_mm: total_length_mm,
        normalized_units: total_normalized_units,
        near_complete_structural_contact_count,
        dominant_near_complete_structural_contact_count: dominant_signature_count(
            &signature_counts,
        ),
        near_complete_structural_contact_signature_counts: signature_counts,
    })
}

/// TS: `irregularBeamState.ts:684-694` `addStructuralContactSignatures`.
fn add_structural_contact_signatures(
    counts: &mut HashMap<String, f64>,
    signatures: &[String],
) -> bool {
    for signature in signatures {
        let next_count = counts.get(signature).copied().unwrap_or(0.0) + 1.0;
        if !is_safe_integer(next_count) {
            return false;
        }
        counts.insert(signature.clone(), next_count);
    }
    true
}

/// TS: `irregularBeamState.ts:696-706` `mergeStructuralContactSignatureCounts`.
fn merge_structural_contact_signature_counts(
    target: &mut HashMap<String, f64>,
    source: &HashMap<String, f64>,
) -> bool {
    for (signature, count) in source {
        let next_count = target.get(signature).copied().unwrap_or(0.0) + count;
        if !is_safe_integer(next_count) {
            return false;
        }
        target.insert(signature.clone(), next_count);
    }
    true
}

/// TS: `irregularBeamState.ts:708-712` `dominantSignatureCount`. Iterates
/// `.values()` only, taking a running `Math.max` -- order-independent.
fn dominant_signature_count(counts: &HashMap<String, f64>) -> f64 {
    let mut dominant_count = 0.0_f64;
    for count in counts.values() {
        dominant_count = js_math::max(dominant_count, *count);
    }
    dominant_count
}

// ===========================================================================
// Canonical keys (`irregularBeamState.ts:714-888`) -- the hot path
// ===========================================================================

/// TS: `irregularBeamState.ts:714-720` `canonicalPlacedGeometryKey`.
fn canonical_placed_geometry_key(placed: &IrregularPlacedPiece) -> String {
    canonical_placed_geometry_key_at_translation(
        placed,
        placed.placement.transform.translate_x,
        placed.placement.transform.translate_y,
    )
}

/// TS: `irregularBeamState.ts:722-732` `canonicalPlacedGeometryKeyAtTranslation`.
fn canonical_placed_geometry_key_at_translation(
    placed: &IrregularPlacedPiece,
    translate_x: f64,
    translate_y: f64,
) -> String {
    canonical_collision_polygon_key(
        &placed.collision_geometry.polygon.points,
        translate_x,
        translate_y,
    )
}

/// TS: `irregularBeamState.ts:744-752` `canonicalCollisionPolygonKey`
/// (exported). Per `search-scoring.md` §1.2: the exported TS function itself
/// is dead-for-production (its only external importer,
/// `intrinsicExactProjection.ts`, is unreachable from production), but the
/// identical logic is live via [`canonical_placed_geometry_key`] ->
/// [`canonical_placed_geometry_key_at_translation`] -> this function; ported
/// `pub` for completeness of the file, matching the TS export.
///
/// Rewritten (2026-07-30, migration prompt §21 optimization discipline) to
/// write directly into one buffer via [`write_canonical_token`] instead of
/// routing a single-row `Vec<Vec<String>>` through [`canonical_record`]:
/// `canonical_record(&[vec!["polygon-ring".to_string(), ring_key]])` is, for
/// exactly this one-row shape, *defined* to equal
/// `canonicalToken("polygon-ring") + canonicalToken(ring_key)` (`canonical_record`'s
/// own doc: no separator between or within rows) — this function now
/// produces that same two-token concatenation directly, without allocating
/// the intermediate `Vec`/row/`"polygon-ring".to_string()`. Byte-for-byte
/// identical output, still exercised by this file's own vector suite
/// (`tests/beam_state_vectors.rs`) and `canonical_record`'s own oracle test.
pub fn canonical_collision_polygon_key(
    points: &[IrregularPoint],
    translate_x: f64,
    translate_y: f64,
) -> String {
    let ring_key = canonical_ring_key(points, translate_x, translate_y);
    let mut buf = String::with_capacity(24 + ring_key.len());
    write_canonical_token(&mut buf, "polygon-ring");
    write_canonical_token(&mut buf, &ring_key);
    buf
}

/// TS: `irregularBeamState.ts:754` `EMPTY_RING_KEY` -- computed once at
/// module load, reused by reference.
static EMPTY_RING_KEY: LazyLock<String> =
    LazyLock::new(|| canonical_record(&[vec!["point-count".to_string(), "0".to_string()]]));

/// TS: `irregularBeamState.ts:765-818` `canonicalRingKey`. Canonicalizes one
/// absolute collision ring independently of start vertex and winding.
///
/// Per `search-scoring.md` §5.4: the single most important algorithm in
/// this cluster to port byte-exact -- it feeds every canonical key used for
/// state dedup throughout the live production search.
fn canonical_ring_key(points: &[IrregularPoint], translate_x: f64, translate_y: f64) -> String {
    let point_count = points.len();
    if point_count == 0 {
        return EMPTY_RING_KEY.clone();
    }

    let mut point_keys: Vec<String> = Vec::with_capacity(point_count);
    let mut xs: Vec<f64> = Vec::with_capacity(point_count);
    let mut ys: Vec<f64> = Vec::with_capacity(point_count);
    for point in points {
        let x = normalize_canonical_coordinate(point.x + translate_x);
        let y = normalize_canonical_coordinate(point.y + translate_y);
        xs.push(x);
        ys.push(y);
        point_keys.push(canonical_point_key(x, y));
    }

    // TS: `irregularBeamState.ts:787-797` -- lexicographically-smallest
    // `(y, x)` start vertex, first strict improvement wins.
    let mut start_index = 0usize;
    for index in 1..point_count {
        let candidate_y = ys[index];
        let current_y = ys[start_index];
        if candidate_y < current_y || (candidate_y == current_y && xs[index] < xs[start_index]) {
            start_index = index;
        }
    }

    // TS: `irregularBeamState.ts:799-807` -- both directions start on the
    // same vertex; the first offset that differs decides the winding.
    // `forwardWins` stays `true` (its initial value) if every offset ties.
    let mut forward_wins = true;
    for offset in 1..point_count {
        let forward_key = &point_keys[(start_index + offset) % point_count];
        let reverse_key = &point_keys[(start_index + point_count * 2 - offset) % point_count];
        if forward_key == reverse_key {
            continue;
        }
        forward_wins = cmp_js_code_units(forward_key, reverse_key) == Ordering::Less;
        break;
    }

    // R21 allocation reduction (2026-07-30): the header + per-offset loop
    // below used to build several short-lived `String`s per token via
    // `format!`/`canonical_token` (including a fresh `format!("point-{offset}")`
    // label every iteration) and `push_str` the result. It now writes every
    // token directly into one pre-reserved `ring_key` buffer via
    // [`write_canonical_token`]/[`write_indexed_canonical_token`], producing
    // byte-for-byte the same sequence of tokens (`point-count` token, its
    // count-value token, then `point-{offset}` token + the chosen point's
    // key token for each of `point_count` offsets, in the same forward/
    // reverse-`point_index` order already resolved above) with far fewer
    // heap allocations -- see `search::beam_state`'s module doc for why this
    // function is this cluster's single hottest allocation site.
    let point_count_str = canonical_number(point_count as f64);
    let mut ring_key = String::with_capacity(
        24 + point_count_str.len() + point_keys.iter().map(|key| key.len() + 24).sum::<usize>(),
    );
    write_canonical_token(&mut ring_key, "point-count");
    write_canonical_token(&mut ring_key, &point_count_str);
    for offset in 0..point_count {
        let point_index = if forward_wins {
            (start_index + offset) % point_count
        } else {
            (start_index + point_count * 2 - offset) % point_count
        };
        write_indexed_canonical_token(&mut ring_key, "point-", offset);
        write_canonical_token(&mut ring_key, &point_keys[point_index]);
    }
    ring_key
}

/// TS: `irregularBeamState.ts:820-827` `canonicalPointKey`.
///
/// R21 allocation reduction (2026-07-30): writes its four tokens directly
/// into one pre-reserved buffer instead of `format!`-concatenating four
/// separately-allocated [`canonical_token`](crate::checkpoints::canonical_json::canonical_token)
/// results; byte-for-byte identical output (`x` token, `canonical_number(x)`
/// token, `y` token, `canonical_number(y)` token, in that order, no
/// separator -- exactly the old `format!("{}{}{}{}", ...)` sequence).
fn canonical_point_key(x: f64, y: f64) -> String {
    let x_str = canonical_number(x);
    let y_str = canonical_number(y);
    let mut buf = String::with_capacity(10 + x_str.len() + y_str.len() + 10);
    write_canonical_token(&mut buf, "x");
    write_canonical_token(&mut buf, &x_str);
    write_canonical_token(&mut buf, "y");
    write_canonical_token(&mut buf, &y_str);
    buf
}

/// TS: `irregularBeamState.ts:852-857` `normalizeCanonicalCoordinate`:
/// `canonicalizeIrregularScoreMillimeterUnits(value) ?? (Object.is(value,
/// -0) ? 0 : value)`. Returns the integer grid-unit count (coordinates
/// scaled by 1000, the 0.001mm canonical grid) for any finite, safe-integer
/// coordinate; falls back to the raw (possibly `-0`-folded) millimeter value
/// only for the pathological non-finite/overflow case
/// (`search-scoring.md` §7.2).
fn normalize_canonical_coordinate(value: f64) -> f64 {
    canonicalize_irregular_score_millimeter_units(value)
        .unwrap_or_else(|| fold_negative_zero(value))
}

/// TS: `irregularBeamState.ts:873-888` `insertCanonicalEntryKey`. A linear
/// scan insertion sort: finds the first existing key that sorts *after* the
/// new key, splices the new key in there (or appends at the end if none
/// found) -- keeps `canonicalEntryKeys` sorted ascending by
/// [`cmp_js_code_units`] at all times, `O(n)` per insertion
/// (`search-scoring.md` §5.2).
fn insert_canonical_entry_key(entry_keys: &[String], entry_key: String) -> Vec<String> {
    let mut next_entry_keys = entry_keys.to_vec();
    let mut insertion_index = next_entry_keys.len();
    for (index, existing_entry_key) in next_entry_keys.iter().enumerate() {
        if cmp_js_code_units(&entry_key, existing_entry_key) == Ordering::Less {
            insertion_index = index;
            break;
        }
    }
    next_entry_keys.insert(insertion_index, entry_key);
    next_entry_keys
}

// ===========================================================================
// Rotation/bounds helpers (`irregularBeamState.ts:475-539,890-986`)
// ===========================================================================

/// TS: `irregularBeamState.ts:475-489` `rotateQuarterTurnPoint`.
fn rotate_quarter_turn_point(
    point: IrregularPoint,
    rotation_deg: IrregularQuarterTurnDegrees,
) -> IrregularPoint {
    match rotation_deg {
        IrregularQuarterTurnDegrees::Zero => {
            IrregularPoint::new(fold_negative_zero(point.x), fold_negative_zero(point.y))
        }
        IrregularQuarterTurnDegrees::Ninety => {
            IrregularPoint::new(fold_negative_zero(-point.y), fold_negative_zero(point.x))
        }
        IrregularQuarterTurnDegrees::OneEighty => {
            IrregularPoint::new(fold_negative_zero(-point.x), fold_negative_zero(-point.y))
        }
        IrregularQuarterTurnDegrees::TwoSeventy => {
            IrregularPoint::new(fold_negative_zero(point.y), fold_negative_zero(-point.x))
        }
    }
}

/// TS: `irregularBeamState.ts:491-494` `normalizeRotationDegrees`. JS `%`
/// can return a negative remainder for a negative dividend (unlike a true
/// mathematical modulo); Rust's `%` for `f64` has the identical
/// same-sign-as-dividend behavior, so this is a direct translation with no
/// extra correction needed beyond the explicit `< 0` branch TS itself uses.
fn normalize_rotation_degrees(rotation_deg: f64) -> f64 {
    let remainder = rotation_deg % 360.0;
    if remainder < 0.0 {
        remainder + 360.0
    } else {
        remainder
    }
}

/// TS: `irregularBeamState.ts:500-517`'s private, file-local `boundsForPoints`
/// helper.
///
/// **Not** the same function as the already-ported
/// `geometry::convex::bounds_for_points` (`convexBounds.ts:8-32`), which
/// this file never imports: that function additionally rejects non-finite
/// coordinates and an inverted `minX > maxX`/`minY > maxY` result. This
/// local variant has no such guard -- it folds `Math.min`/`Math.max` over
/// every point unconditionally via [`js_math::min`]/[`js_math::max`] and
/// returns `None` only when `points` is empty
/// (`irregularBeamState.ts:503-504`). The result populates
/// [`crate::domain::IrregularBounds`] directly (that type's own constructor
/// performs no validation either, matching this function's TS counterpart's
/// return shape `{ minX, minY, maxX, maxY }` with no `width`/`height`).
fn bounds_for_points_unchecked(points: &[IrregularPoint]) -> Option<IrregularBounds> {
    let first = points.first()?;
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
    Some(IrregularBounds::new(min_x, min_y, max_x, max_y))
}

/// TS: `irregularBeamState.ts:519-539` `deriveMetadata`. Always a
/// from-scratch derivation, triggered whenever no incremental metadata was
/// supplied (`search-scoring.md` §4.3).
fn derive_metadata(placed_collision_geometries: &[Arc<IrregularPlacedPiece>]) -> DerivedMetadata {
    let mut canonical_entry_keys: Vec<String> = placed_collision_geometries
        .iter()
        .map(|placed| canonical_placed_geometry_key(placed))
        .collect();
    canonical_entry_keys.sort_by(|first, second| cmp_js_code_units(first, second));

    let shared = derive_shared_collision_boundary_metrics(placed_collision_geometries);

    DerivedMetadata {
        canonical_occupied_geometry_key: canonical_entry_list_key(&canonical_entry_keys),
        translated_collision_bounds: derive_collision_bounds(placed_collision_geometries),
        shared_collision_boundary_length_mm: shared.as_ref().map(|metrics| metrics.length_mm),
        shared_collision_boundary_contact_units: shared
            .as_ref()
            .map(|metrics| metrics.normalized_units),
        near_complete_structural_contact_count: shared
            .as_ref()
            .map(|metrics| metrics.near_complete_structural_contact_count),
        dominant_near_complete_structural_contact_count: shared
            .as_ref()
            .map(|metrics| metrics.dominant_near_complete_structural_contact_count),
        near_complete_structural_contact_signature_counts: shared
            .map(|metrics| metrics.near_complete_structural_contact_signature_counts),
        canonical_entry_keys,
        placed_collision_index: make_placed_collision_spatial_index(
            placed_collision_geometries,
            None,
        ),
    }
}

/// TS: `irregularBeamState.ts:890-905` `deriveCollisionBounds`.
fn derive_collision_bounds(
    placed_collision_geometries: &[Arc<IrregularPlacedPiece>],
) -> Option<IrregularCollisionBounds> {
    if placed_collision_geometries.is_empty() {
        return Some(empty_collision_bounds());
    }

    let mut collision_bounds: Option<IrregularCollisionBounds> = None;
    for placed in placed_collision_geometries {
        let placed_bounds = derive_placed_collision_bounds(placed)?;
        collision_bounds = Some(match collision_bounds {
            None => placed_bounds,
            Some(current) => union_collision_bounds(&current, &placed_bounds)?,
        });
    }
    collision_bounds
}

/// TS: `irregularBeamState.ts:907-916` `extendCollisionBounds`.
fn extend_collision_bounds(
    current: Option<&IrregularCollisionBounds>,
    placed: &IrregularPlacedPiece,
) -> Option<IrregularCollisionBounds> {
    let current = current?;
    let placed_bounds = derive_placed_collision_bounds(placed)?;
    union_collision_bounds(current, &placed_bounds)
}

/// TS: `irregularBeamState.ts:918-959` `derivePlacedCollisionBounds`.
fn derive_placed_collision_bounds(
    placed: &IrregularPlacedPiece,
) -> Option<IrregularCollisionBounds> {
    let translation = &placed.placement.transform;
    let points = &placed.collision_geometry.polygon.points;
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for point in points {
        let translated_x = point.x + translation.translate_x;
        let translated_y = point.y + translation.translate_y;
        if !translated_x.is_finite() || !translated_y.is_finite() {
            return None;
        }
        min_x = js_math::min(min_x, translated_x);
        min_y = js_math::min(min_y, translated_y);
        max_x = js_math::max(max_x, translated_x);
        max_y = js_math::max(max_y, translated_y);
    }

    let width = max_x - min_x;
    let height = max_y - min_y;
    if !min_x.is_finite()
        || !min_y.is_finite()
        || !max_x.is_finite()
        || !max_y.is_finite()
        || !width.is_finite()
        || !height.is_finite()
    {
        return None;
    }
    Some(IrregularCollisionBounds {
        min_x,
        min_y,
        max_x,
        max_y,
        width,
        height,
    })
}

/// TS: `irregularBeamState.ts:961-982` `unionCollisionBounds`.
fn union_collision_bounds(
    first: &IrregularCollisionBounds,
    second: &IrregularCollisionBounds,
) -> Option<IrregularCollisionBounds> {
    let min_x = js_math::min(first.min_x, second.min_x);
    let min_y = js_math::min(first.min_y, second.min_y);
    let max_x = js_math::max(first.max_x, second.max_x);
    let max_y = js_math::max(first.max_y, second.max_y);
    let width = max_x - min_x;
    let height = max_y - min_y;
    if !min_x.is_finite()
        || !min_y.is_finite()
        || !max_x.is_finite()
        || !max_y.is_finite()
        || !width.is_finite()
        || !height.is_finite()
    {
        return None;
    }
    Some(IrregularCollisionBounds {
        min_x,
        min_y,
        max_x,
        max_y,
        width,
        height,
    })
}

/// TS: `irregularBeamState.ts:984-986` `emptyCollisionBounds`.
fn empty_collision_bounds() -> IrregularCollisionBounds {
    IrregularCollisionBounds {
        min_x: 0.0,
        min_y: 0.0,
        max_x: 0.0,
        max_y: 0.0,
        width: 0.0,
        height: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{IrregularTransformReason, SourceFileId};

    fn square_piece(
        source_piece_id: &str,
        translate_x: f64,
        translate_y: f64,
        side: f64,
    ) -> Arc<IrregularPlacedPiece> {
        let polygon = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ]);
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new(source_piece_id),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new(source_piece_id),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon,
                bounds: IrregularBounds::new(0.0, 0.0, side, side),
            },
        })
    }

    #[test]
    fn empty_state_has_empty_canonical_key_and_zero_bounds() {
        let state = IrregularBeamState::empty(Vec::new());
        assert_eq!(state.placed_collision_geometries.len(), 0);
        assert_eq!(
            state.translated_collision_bounds,
            Some(empty_collision_bounds())
        );
        assert_eq!(state.unplaced_piece_ids, state.unplaced_source_piece_ids);
        assert!(state.unplaced_piece_ids.is_empty());
        // Round-trips through the exact Encoder D shape regardless of empty
        // content.
        assert_eq!(
            state.canonical_occupied_geometry_key,
            canonical_entry_list_key(&[])
        );
    }

    #[test]
    fn with_placement_appends_sorted_canonical_entry_key() {
        let state = IrregularBeamState::empty(Vec::new());
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let next = state.with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: Arc::clone(&piece),
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        assert_eq!(next.placed_collision_geometries.len(), 1);
        assert!(Arc::ptr_eq(&next.placed_collision_geometries[0], &piece));
        assert_eq!(next.placement_order, vec![PieceId::new("piece-a")]);
        assert!(next.parent.is_some());
        assert_eq!(
            next.translated_collision_bounds,
            Some(IrregularCollisionBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 4.0,
                max_y: 4.0,
                width: 4.0,
                height: 4.0
            })
        );
    }

    #[test]
    fn ring_key_is_invariant_to_start_vertex_and_winding() {
        let square = [
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(4.0, 0.0),
            IrregularPoint::new(4.0, 4.0),
            IrregularPoint::new(0.0, 4.0),
        ];
        let rotated_start = [
            IrregularPoint::new(4.0, 4.0),
            IrregularPoint::new(0.0, 4.0),
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(4.0, 0.0),
        ];
        let reversed_winding = [
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(0.0, 4.0),
            IrregularPoint::new(4.0, 4.0),
            IrregularPoint::new(4.0, 0.0),
        ];
        let key_a = canonical_collision_polygon_key(&square, 0.0, 0.0);
        let key_b = canonical_collision_polygon_key(&rotated_start, 0.0, 0.0);
        let key_c = canonical_collision_polygon_key(&reversed_winding, 0.0, 0.0);
        assert_eq!(key_a, key_b);
        assert_eq!(key_a, key_c);
    }

    #[test]
    fn ring_key_translation_folds_negative_zero() {
        let points = [
            IrregularPoint::new(1.0, 1.0),
            IrregularPoint::new(-1.0, 1.0),
        ];
        let key_at_zero = canonical_collision_polygon_key(&points, 0.0, 0.0);
        let translated = [
            IrregularPoint::new(0.0, 1.0),
            IrregularPoint::new(-2.0, 1.0),
        ];
        let key_translated = canonical_collision_polygon_key(&points, -1.0, 0.0);
        let key_manual = canonical_collision_polygon_key(&translated, 0.0, 0.0);
        assert_eq!(key_translated, key_manual);
        assert_ne!(key_at_zero, key_translated);
    }

    #[test]
    fn canonical_entry_list_key_matches_checkpoint_encoder_directly() {
        let keys = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            canonical_entry_list_key(&keys),
            crate::checkpoints::canonical_json::canonical_entry_list_key(&keys)
        );
    }

    #[test]
    fn with_unplaced_piece_carries_bounds_and_index_through_unchanged() {
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        let bounds_before = state.translated_collision_bounds;
        let next = state.with_unplaced_piece(WithUnplacedPieceInput {
            remaining_prepared_pieces: Vec::new(),
            unplaced_piece_id: PieceId::new("skipped"),
        });
        assert_eq!(next.translated_collision_bounds, bounds_before);
        assert_eq!(next.unplaced_piece_ids, vec![PieceId::new("skipped")]);
        assert_eq!(next.placed_collision_geometries.len(), 1);
    }

    #[test]
    fn with_bottom_left_anchored_is_a_noop_when_bounds_are_absent() {
        // TS: `bounds === undefined ... return this`
        // (`irregularBeamState.ts:289`) -- a state whose
        // `translatedCollisionBounds` failed to derive (here: a placement
        // with a non-finite translation) must still short-circuit to the
        // SAME instance, not `undefined`/`None`.
        let piece = square_piece("piece-a", f64::INFINITY, 0.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        assert_eq!(state.translated_collision_bounds, None);
        let state_ptr = Arc::as_ptr(&state);
        let anchored = state.with_bottom_left_anchored().unwrap();
        assert_eq!(Arc::as_ptr(&anchored), state_ptr);
    }

    #[test]
    fn bottom_left_anchored_projection_key_is_defined_when_bounds_are_absent() {
        // TS: `bounds === undefined ... return this.canonicalOccupiedGeometryKey`
        // (`irregularBeamState.ts:359-361`) -- same short-circuit as above,
        // for the read-only projection.
        let piece = square_piece("piece-a", f64::INFINITY, 0.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        assert_eq!(state.translated_collision_bounds, None);
        assert_eq!(
            state.bottom_left_anchored_canonical_occupied_geometry_key(),
            Some(state.canonical_occupied_geometry_key.clone())
        );
    }

    #[test]
    fn with_bottom_left_anchored_is_a_noop_when_already_anchored() {
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        let state_ptr = Arc::as_ptr(&state);
        let anchored = state.with_bottom_left_anchored().unwrap();
        assert_eq!(Arc::as_ptr(&anchored), state_ptr);
    }

    #[test]
    fn with_bottom_left_anchored_translates_to_origin() {
        let piece = square_piece("piece-a", 5.0, 3.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        let anchored = state.with_bottom_left_anchored().unwrap();
        assert_eq!(
            anchored.translated_collision_bounds,
            Some(IrregularCollisionBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 4.0,
                max_y: 4.0,
                width: 4.0,
                height: 4.0
            })
        );
        assert_eq!(
            anchored.placed_collision_geometries[0]
                .placement
                .transform
                .translate_x,
            0.0
        );
        assert_eq!(
            anchored.placed_collision_geometries[0]
                .placement
                .transform
                .translate_y,
            0.0
        );
    }

    #[test]
    fn bottom_left_anchored_projection_matches_full_anchor_key() {
        let piece_a = square_piece("piece-a", 5.0, 3.0, 4.0);
        let piece_b = square_piece("piece-b", 12.0, 8.0, 2.0);
        let state = IrregularBeamState::empty(Vec::new())
            .with_placement(WithPlacementInput {
                remaining_prepared_pieces: Vec::new(),
                placed_collision_geometry: piece_a,
                placement_order_piece_id: PieceId::new("piece-a"),
                on_phase_timings: None,
                timing_now: None,
            })
            .with_placement(WithPlacementInput {
                remaining_prepared_pieces: Vec::new(),
                placed_collision_geometry: piece_b,
                placement_order_piece_id: PieceId::new("piece-b"),
                on_phase_timings: None,
                timing_now: None,
            });
        let projected_key = state.bottom_left_anchored_canonical_occupied_geometry_key();
        let anchored = state.with_bottom_left_anchored().unwrap();
        assert_eq!(
            projected_key,
            Some(anchored.canonical_occupied_geometry_key.clone())
        );
    }

    #[test]
    fn with_quarter_turn_bottom_left_zero_degrees_delegates_to_anchor() {
        let piece = square_piece("piece-a", 5.0, 3.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        let anchored = Arc::clone(&state).with_bottom_left_anchored().unwrap();
        let rotated_zero = state
            .with_quarter_turn_bottom_left(IrregularQuarterTurnDegrees::Zero)
            .unwrap();
        assert_eq!(
            rotated_zero.canonical_occupied_geometry_key,
            anchored.canonical_occupied_geometry_key
        );
    }

    #[test]
    fn with_quarter_turn_bottom_left_90_rotates_and_anchors() {
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        let rotated = state
            .with_quarter_turn_bottom_left(IrregularQuarterTurnDegrees::Ninety)
            .unwrap();
        assert_eq!(
            rotated.placed_collision_geometries[0]
                .collision_geometry
                .transform
                .rotation_deg,
            90.0
        );
        assert_eq!(
            rotated.translated_collision_bounds,
            Some(IrregularCollisionBounds {
                min_x: 0.0,
                min_y: 0.0,
                max_x: 4.0,
                max_y: 4.0,
                width: 4.0,
                height: 4.0
            })
        );
    }

    #[test]
    fn normalize_canonical_coordinate_preserves_negative_zero_via_the_primary_grid_path() {
        // `canonicalizeIrregularScoreMillimeterUnits(-0)` *succeeds* -- it
        // returns the literal grid value `-0` (`irregularScoreGrid.ts:21-30`'s
        // own `Math.sign(-0) === -0` behavior, ported by
        // `search::score_grid`), so `normalizeCanonicalCoordinate`'s raw-value
        // `-0`-folding fallback (`irregularBeamState.ts:855`,
        // `Object.is(value, -0) ? 0 : value`) is **never reached** for an
        // ordinary `-0` coordinate -- only `canonicalNumber`, called later by
        // `canonicalPointKey`, folds it to the string `"0"`. `+0` and `-0`
        // must therefore round-trip through this function as *different*
        // `f64` bit patterns.
        assert_eq!(
            normalize_canonical_coordinate(-0.0).to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            normalize_canonical_coordinate(0.0).to_bits(),
            0.0_f64.to_bits()
        );
    }

    #[test]
    fn normalize_canonical_coordinate_falls_back_to_the_raw_value_when_non_finite() {
        // The `?? (Object.is(value, -0) ? 0 : value)` fallback only fires
        // when `canonicalizeIrregularScoreMillimeterUnits` returns `None`
        // (non-finite input, or scaled-magnitude overflow) --
        // `search-scoring.md` §7.2.
        assert!(normalize_canonical_coordinate(f64::NAN).is_nan());
        assert_eq!(normalize_canonical_coordinate(f64::INFINITY), f64::INFINITY);
        assert_eq!(
            normalize_canonical_coordinate(f64::NEG_INFINITY),
            f64::NEG_INFINITY
        );
    }

    #[test]
    fn insert_canonical_entry_key_keeps_ascending_order_and_stable_ties() {
        let mut keys: Vec<String> = Vec::new();
        keys = insert_canonical_entry_key(&keys, "b".to_string());
        keys = insert_canonical_entry_key(&keys, "a".to_string());
        keys = insert_canonical_entry_key(&keys, "c".to_string());
        assert_eq!(
            keys,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );

        // Duplicate keys insert after all existing equal keys (`< 0`, not
        // `<= 0`).
        let mut duplicate_keys: Vec<String> = vec!["a".to_string(), "a".to_string()];
        duplicate_keys = insert_canonical_entry_key(&duplicate_keys, "a".to_string());
        assert_eq!(
            duplicate_keys,
            vec!["a".to_string(), "a".to_string(), "a".to_string()]
        );
    }

    #[test]
    fn contact_signature_continuation_identity_is_some_empty_array_for_the_empty_state() {
        // TS: `deriveSharedCollisionBoundaryMetrics([])`
        // (`irregularBeamState.ts:541-580`) returns a **defined**
        // `SharedCollisionBoundaryMetrics` with an empty
        // `nearCompleteStructuralContactSignatureCounts` `Map` (the `for`
        // loop over zero spatial-index entries simply never runs, it does
        // not short-circuit to `undefined`) -- so the truly empty state's
        // `contactSignatureContinuationIdentity()` is `Some("[]")`, not
        // `None`. `None` is reached only when a per-pair contact
        // measurement itself fails (see the sibling test below).
        let state = IrregularBeamState::empty(Vec::new());
        assert_eq!(
            state.contact_signature_continuation_identity(),
            Some("[]".to_string())
        );
        assert!(state
            .continuation_metadata_identity()
            .contains("nearCompleteStructuralContactSignatureCounts"));
    }

    /// A single-point "polygon" fails `validate_strict_boundary`'s
    /// minimum-vertex-count check, landing this entry in the spatial
    /// index's `fallback_entries` as `PlacedCollisionValidation::Invalid` --
    /// mirrors `validation::spatial_index`'s own `invalid_piece()` test
    /// helper.
    fn invalid_piece(source_piece_id: &str) -> Arc<IrregularPlacedPiece> {
        let polygon = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0)]);
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new(source_piece_id),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x: 0.0,
                    translate_y: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new(source_piece_id),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: IrregularTransformReason::Orthogonal,
                },
                polygon,
                bounds: IrregularBounds::new(0.0, 0.0, 0.0, 0.0),
            },
        })
    }

    #[test]
    fn contact_signature_continuation_identity_is_none_when_a_placed_piece_fails_validation() {
        // TS: `sharedBoundaryWithEntries`'s own `addedEntry.translated ===
        // undefined` guard (`irregularBeamState.ts:642`) fires
        // unconditionally, even against zero prior entries -- a single
        // structurally-invalid placed piece is enough to make the whole
        // state's shared-boundary metrics (and thus this identity) `None`.
        let state = IrregularBeamState::empty(Vec::new()).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: invalid_piece("invalid"),
            placement_order_piece_id: PieceId::new("invalid"),
            on_phase_timings: None,
            timing_now: None,
        });
        assert_eq!(state.contact_signature_continuation_identity(), None);
        assert!(!state
            .continuation_metadata_identity()
            .contains("nearCompleteStructuralContactSignatureCounts"));
    }

    #[test]
    fn continuation_metadata_identity_changes_when_canonical_entry_keys_change() {
        let state = IrregularBeamState::empty(Vec::new());
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let next = Arc::clone(&state).with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: None,
            timing_now: None,
        });
        assert_ne!(
            state.continuation_metadata_identity(),
            next.continuation_metadata_identity()
        );
        // Self-consistency: recomputing on the SAME state must be stable.
        assert_eq!(
            next.continuation_metadata_identity(),
            next.continuation_metadata_identity()
        );
    }

    #[test]
    fn with_placement_phase_timings_callback_reports_a_total() {
        let state = IrregularBeamState::empty(Vec::new());
        let piece = square_piece("piece-a", 0.0, 0.0, 4.0);
        let mut observed: Option<IrregularBeamStatePlacementPhaseTimings> = None;
        let _next = state.with_placement(WithPlacementInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometry: piece,
            placement_order_piece_id: PieceId::new("piece-a"),
            on_phase_timings: Some(&mut |timings| observed = Some(timings)),
            timing_now: Some(&|| 0.0),
        });
        let timings = observed.expect("callback must be invoked when supplied");
        assert!(timings.total_ms >= 0.0);
        assert!(timings.bookkeeping_ms >= 0.0);
    }

    #[test]
    fn spatial_index_reuse_guard_rejects_mismatched_index() {
        // A `placedCollisionIndex` supplied via `from_input` that does not
        // correspond (by reference identity) to `placedCollisionGeometries`
        // must be silently rebuilt, not trusted (`irregularBeamState.ts:120-124`).
        let piece_a = square_piece("piece-a", 0.0, 0.0, 4.0);
        let piece_b = square_piece("piece-b", 10.0, 10.0, 2.0);
        let stale_index = make_placed_collision_spatial_index(&[Arc::clone(&piece_a)], None);
        let state = IrregularBeamState::from_input(IrregularBeamStateInput {
            remaining_prepared_pieces: Vec::new(),
            placed_collision_geometries: vec![piece_a, piece_b],
            unplaced_piece_ids: None,
            unplaced_source_piece_ids: None,
            placement_order: Vec::new(),
            parent: None,
            placed_collision_index: Some(stale_index),
        });
        assert_eq!(state.placed_collision_index.size(), 2);
    }

    #[test]
    fn source_file_id_import_is_unused_placeholder_guard() {
        // Keeps the `SourceFileId` import intentional if a future edit adds
        // a fixture needing it; harmless no-op assertion.
        let _ = SourceFileId::new("unused");
    }
}
