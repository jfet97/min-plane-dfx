//! Persistent (functional/immutable) uniform-grid broad-phase index over
//! already-placed pieces' translated collision polygons.
//!
//! TS source: `src/workers/irregular/placedCollisionSpatialIndex.ts` (261
//! lines). Read in full together with
//! `docs/planning/rust-irregular-backend/characterization/validation-spatial.md`
//! before writing this module.
//!
//! # Structural sharing vs. plain clone
//!
//! Per `validation-spatial.md` §4, `add()` in TS is a factory that builds a
//! *shallow* copy of `buckets` (`new Map(this.buckets)`, an O(bucket-key
//! count) copy that shares unmodified per-cell array *references* with the
//! parent) and a *full* copy of `entries` (`[...this.entries, entry]`,
//! always O(n)). This module reproduces both costs exactly: `buckets` values
//! are `Arc<Vec<_>>` so `self.buckets.clone()` is a shallow `HashMap` copy
//! that shares untouched per-cell `Arc`s with the parent, while `entries`
//! and `fallback_entries` are plain `Vec` clones (always a full copy),
//! matching the TS asymptotic cost note verbatim ("`add`-ing to a
//! beam-search state with many already-placed pieces re-copies the entire
//! `entries` array and the entire `buckets` `Map`'s key set every time").
//!
//! # Reference-identity `matches()`
//!
//! Per §12 hazard 2: TS's `matches()` compares `entry.placed !==
//! placedPiece` -- JS reference/pointer identity, not structural equality.
//! This module reproduces that exactly by requiring callers to thread
//! `Arc<IrregularPlacedPiece>` through unchanged from wherever a placed
//! piece is constructed once, and comparing via `Arc::ptr_eq` -- the
//! recommended Rust equivalent named explicitly in the characterization
//! document, since a `Vec`/owned-struct representation has no native notion
//! of "the same instance" to check at all.
//!
//! # `HashMap` for `buckets`/`selected`, not a sorted map
//!
//! Per §5 item 4 / §12 hazard 6: `query()`'s output order is never derived
//! from `Map`/`Set` iteration order in TS -- it only tests membership, then
//! filters the ordinal-ordered `entries` array. `std::collections::HashMap`/
//! `HashSet` are therefore safe (and match the source's own indifference to
//! bucket iteration order) for `buckets`/`selected` here; only
//! `continuation_identity()` needs an explicit total order, which it applies
//! itself (see that method's doc comment).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;

use crate::domain::{IrregularBounds, IrregularPlacedPiece, IrregularPoint};
use crate::geometry::convex::{
    are_disjoint, translate_polygon_with_bounds, validate_strict_boundary, ConvexPolygonWinding,
    IrregularPolygonWithBounds, StrictConvexBoundaryValidation,
};
use crate::js_number::js_math;

/// TS source: `placedCollisionSpatialIndex.ts:9`
/// (`DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM`).
pub const DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM: f64 = 64.0;

/// TS source: `placedCollisionSpatialIndex.ts:11-12`
/// (`MAX_GRID_CELLS_PER_ENTRY`, `MAX_GRID_CELLS_PER_QUERY`).
const MAX_GRID_CELLS_PER_ENTRY: i64 = 4096;
const MAX_GRID_CELLS_PER_QUERY: i64 = 4096;

/// `Number.MAX_SAFE_INTEGER` (`2^53 - 1`). Per `validation-spatial.md` §7/§12
/// hazard 4: this is a strictly narrower bound than "fits in an `i64`"
/// (`i64::MAX ~= 9.22e18` vs. this bound `~= 9.007e15`); a Rust port must use
/// this exact literal threshold, never a native integer-width overflow
/// check.
const JS_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// TS source: `placedCollisionSpatialIndex.ts:14-16`
/// (`IndexedPlacedCollisionPolygon`).
#[derive(Clone, Debug, PartialEq)]
pub struct IndexedPlacedCollisionPolygon {
    pub polygon_with_bounds: IrregularPolygonWithBounds,
    pub winding: ConvexPolygonWinding,
}

/// TS source: `placedCollisionSpatialIndex.ts:18-24`
/// (`PlacedCollisionSpatialEntry`)'s `translated`/`validationMessage`/
/// `indexedBounds` three-way-coupled optional group.
///
/// Per `validation-spatial.md` §3: "exactly one of (`translated` defined,
/// `validationMessage` undefined, `indexedBounds` defined) or (`translated`
/// undefined, `validationMessage` defined, `indexedBounds` undefined) ever
/// occurs... A Rust port should model this as a single
/// `Result<ValidEntry, String>`-shaped enum, not three `Option<T>` fields,
/// to make the coupling structurally enforced rather than a convention" --
/// this enum is exactly that recommended shape. Because the coupling is now
/// structurally enforced, the TS `entry.translated === undefined` (`message`
/// absent) defensive branch in `placementValidation.ts:95-100` -- itself
/// documented there as "should be structurally impossible... but checked
/// defensively" -- has no Rust counterpart to preserve: this enum's type
/// alone rules it out.
#[derive(Clone, Debug, PartialEq)]
pub enum PlacedCollisionValidation {
    Valid(IndexedPlacedCollisionPolygon),
    Invalid { message: String },
}

impl PlacedCollisionValidation {
    fn bounds(&self) -> Option<&IrregularBounds> {
        match self {
            PlacedCollisionValidation::Valid(valid) => Some(&valid.polygon_with_bounds.bounds),
            PlacedCollisionValidation::Invalid { .. } => None,
        }
    }
}

/// TS source: `placedCollisionSpatialIndex.ts:18-24`
/// (`PlacedCollisionSpatialEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct PlacedCollisionSpatialEntry {
    pub placed: Arc<IrregularPlacedPiece>,
    pub validation: PlacedCollisionValidation,
    pub ordinal: usize,
}

/// TS source: `placedCollisionSpatialIndex.ts:26-34`
/// (`PlacedCollisionSpatialIndex` interface) /
/// `placedCollisionSpatialIndex.ts:56-157`
/// (`UniformPlacedCollisionSpatialIndex`, the sole implementation).
#[derive(Clone, Debug)]
pub struct PlacedCollisionSpatialIndex {
    cell_size_mm: f64,
    entries: Vec<PlacedCollisionSpatialEntry>,
    buckets: HashMap<String, Arc<Vec<PlacedCollisionSpatialEntry>>>,
    fallback_entries: Vec<PlacedCollisionSpatialEntry>,
}

/// TS source: `placedCollisionSpatialIndex.ts:36-45`
/// (`makeEmptyPlacedCollisionSpatialIndex`).
pub fn make_empty_placed_collision_spatial_index(
    cell_size_mm: Option<f64>,
) -> PlacedCollisionSpatialIndex {
    PlacedCollisionSpatialIndex {
        cell_size_mm: valid_cell_size(
            cell_size_mm.unwrap_or(DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM),
        ),
        entries: Vec::new(),
        buckets: HashMap::new(),
        fallback_entries: Vec::new(),
    }
}

/// TS source: `placedCollisionSpatialIndex.ts:47-54`
/// (`makePlacedCollisionSpatialIndex`).
///
/// A literal left-fold over `placed`, matching the TS source's own
/// documented `O(n^2)`-worst-case bulk-construction cost (§4): each
/// sequential `add()` call copies an `entries` array whose length grows from
/// `0` to `n`.
pub fn make_placed_collision_spatial_index(
    placed: &[Arc<IrregularPlacedPiece>],
    cell_size_mm: Option<f64>,
) -> PlacedCollisionSpatialIndex {
    let mut index = make_empty_placed_collision_spatial_index(cell_size_mm);
    for placed_piece in placed {
        index = index.add(Arc::clone(placed_piece));
    }
    index
}

impl PlacedCollisionSpatialIndex {
    /// TS: `size` (`entries.length`).
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// TS: `cellSizeMm`.
    pub fn cell_size_mm(&self) -> f64 {
        self.cell_size_mm
    }

    /// TS: `entries`, in strict append/ordinal order (§5 item 6).
    pub fn entries(&self) -> &[PlacedCollisionSpatialEntry] {
        &self.entries
    }

    /// TS source: `placedCollisionSpatialIndex.ts:77-104` (`add`).
    ///
    /// Returns a brand-new index; `self` is never mutated (see this module's
    /// doc comment for the structural-sharing cost model this reproduces).
    pub fn add(&self, placed: Arc<IrregularPlacedPiece>) -> PlacedCollisionSpatialIndex {
        let entry = make_entry(placed, self.entries.len());

        let mut entries = self.entries.clone();
        entries.push(entry.clone());

        let mut buckets = self.buckets.clone();
        let mut fallback_entries = self.fallback_entries.clone();

        let cell_range = entry.validation.bounds().and_then(|bounds| {
            grid_cell_range(bounds, self.cell_size_mm, MAX_GRID_CELLS_PER_ENTRY)
        });

        match cell_range {
            None => fallback_entries.push(entry),
            Some(range) => {
                for cell_x in range.min_x..=range.max_x {
                    for cell_y in range.min_y..=range.max_y {
                        let key = cell_key(cell_x, cell_y);
                        let mut bucket: Vec<PlacedCollisionSpatialEntry> = buckets
                            .get(&key)
                            .map(|existing| existing.as_ref().clone())
                            .unwrap_or_default();
                        bucket.push(entry.clone());
                        buckets.insert(key, Arc::new(bucket));
                    }
                }
            }
        }

        PlacedCollisionSpatialIndex {
            cell_size_mm: self.cell_size_mm,
            entries,
            buckets,
            fallback_entries,
        }
    }

    /// TS source: `placedCollisionSpatialIndex.ts:106-116` (`matches`).
    ///
    /// Reference-identity comparison (`Arc::ptr_eq`), not structural
    /// equality -- see this module's doc comment.
    pub fn matches(&self, placed: &[Arc<IrregularPlacedPiece>]) -> bool {
        if placed.len() != self.entries.len() {
            return false;
        }
        for (placed_piece, entry) in placed.iter().zip(self.entries.iter()) {
            if !Arc::ptr_eq(placed_piece, &entry.placed) {
                return false;
            }
        }
        true
    }

    /// TS source: `placedCollisionSpatialIndex.ts:118-127`
    /// (`continuationIdentity`).
    ///
    /// Per `validation-spatial.md` §8/§12 hazard 1: the TS source re-sorts
    /// its `buckets` entries by `String.prototype.localeCompare` on the
    /// cell-key string with **no locale argument**, whose exact order is
    /// empirically not plain byte/codepoint order and is not guaranteed
    /// stable across Node/ICU builds. The document's own recommendation
    /// (§12 hazard 1, "if not [crossing a checkpoint/persistence boundary]
    /// ... implement the Rust equivalent with a plain, fully-specified,
    /// locale-independent ordering (e.g. `(i64, i64)` tuple ordering by
    /// parsed `(cellX, cellY)`") is applied here: this Rust
    /// `continuation_identity()` sorts bucket entries by parsed
    /// `(cell_x, cell_y)` integer-tuple order, not by any locale-collation
    /// equivalent. §8 also establishes this string's only current consumers
    /// compare it same-process/same-language to another same-runtime
    /// invocation, so exact byte-for-byte reproduction of the TS string is
    /// not required for behavioral correctness -- this Rust string is used
    /// only for Rust-internal, Rust-to-Rust self-consistency checks by
    /// future callers (not yet ported), so a distinct but equally
    /// deterministic/injective total order is the correct choice here, not a
    /// bug.
    pub fn continuation_identity(&self) -> String {
        let mut bucket_rows: Vec<(i64, i64, String, Vec<usize>)> = self
            .buckets
            .iter()
            .map(|(key, entries)| {
                let (cell_x, cell_y) = parse_cell_key(key);
                let ordinals = entries.iter().map(|entry| entry.ordinal).collect();
                (cell_x, cell_y, key.clone(), ordinals)
            })
            .collect();
        bucket_rows.sort_by_key(|(cell_x, cell_y, _, _)| (*cell_x, *cell_y));

        #[derive(Serialize)]
        struct Identity {
            #[serde(rename = "cellSizeMm")]
            cell_size_mm: f64,
            #[serde(rename = "entryOrdinals")]
            entry_ordinals: Vec<usize>,
            buckets: Vec<(String, Vec<usize>)>,
            #[serde(rename = "fallbackOrdinals")]
            fallback_ordinals: Vec<usize>,
        }

        let identity = Identity {
            cell_size_mm: self.cell_size_mm,
            entry_ordinals: self.entries.iter().map(|entry| entry.ordinal).collect(),
            buckets: bucket_rows
                .into_iter()
                .map(|(_, _, key, ordinals)| (key, ordinals))
                .collect(),
            fallback_ordinals: self
                .fallback_entries
                .iter()
                .map(|entry| entry.ordinal)
                .collect(),
        };

        serde_json::to_string(&identity).expect("continuation identity always serializes")
    }

    /// TS source: `placedCollisionSpatialIndex.ts:129-156` (`query`).
    ///
    /// Broad-phase bucket lookup: seeds `selected` with every fallback
    /// entry, computes a bounded grid-cell range for `bounds` (falling back
    /// to "select every entry" when `bounds` is absent or the range would
    /// exceed `MAX_GRID_CELLS_PER_QUERY`), then filters `self.entries`
    /// (ordinal order, §5 item 6 -- the authoritative output order) by
    /// `selected` membership plus, for valid entries only, a precise
    /// `!areDisjoint` re-check against `bounds`.
    pub fn query(&self, bounds: Option<&IrregularBounds>) -> Vec<PlacedCollisionSpatialEntry> {
        let mut selected: HashSet<usize> = self
            .fallback_entries
            .iter()
            .map(|entry| entry.ordinal)
            .collect();

        let cell_range =
            bounds.and_then(|b| grid_cell_range(b, self.cell_size_mm, MAX_GRID_CELLS_PER_QUERY));

        match (bounds, cell_range) {
            (None, _) | (Some(_), None) => {
                for entry in &self.entries {
                    selected.insert(entry.ordinal);
                }
            }
            (Some(_), Some(range)) => {
                for cell_x in range.min_x..=range.max_x {
                    for cell_y in range.min_y..=range.max_y {
                        if let Some(bucket) = self.buckets.get(&cell_key(cell_x, cell_y)) {
                            for entry in bucket.iter() {
                                selected.insert(entry.ordinal);
                            }
                        }
                    }
                }
            }
        }

        self.entries
            .iter()
            .filter(|entry| match &entry.validation {
                PlacedCollisionValidation::Invalid { .. } => selected.contains(&entry.ordinal),
                PlacedCollisionValidation::Valid(valid) => {
                    selected.contains(&entry.ordinal)
                        && bounds
                            .map(|b| !are_disjoint(&valid.polygon_with_bounds.bounds, b))
                            .unwrap_or(true)
                }
            })
            .cloned()
            .collect()
    }
}

/// TS source: `placedCollisionSpatialIndex.ts:159-195` (`makeEntry`).
fn make_entry(placed: Arc<IrregularPlacedPiece>, ordinal: usize) -> PlacedCollisionSpatialEntry {
    let translation = IrregularPoint::new(
        placed.placement.transform.translate_x,
        placed.placement.transform.translate_y,
    );

    let translated =
        match translate_polygon_with_bounds(&placed.collision_geometry.polygon, translation) {
            None => {
                return PlacedCollisionSpatialEntry {
                    placed,
                    validation: PlacedCollisionValidation::Invalid {
                        message: "placed translation must produce finite polygon coordinates."
                            .to_string(),
                    },
                    ordinal,
                };
            }
            Some(translated) => translated,
        };

    match validate_strict_boundary(&translated.polygon.points) {
        StrictConvexBoundaryValidation::Invalid { message } => PlacedCollisionSpatialEntry {
            placed,
            validation: PlacedCollisionValidation::Invalid { message },
            ordinal,
        },
        StrictConvexBoundaryValidation::Valid { winding } => PlacedCollisionSpatialEntry {
            placed,
            validation: PlacedCollisionValidation::Valid(IndexedPlacedCollisionPolygon {
                polygon_with_bounds: translated,
                winding,
            }),
            ordinal,
        },
    }
}

struct GridCellRange {
    min_x: i64,
    min_y: i64,
    max_x: i64,
    max_y: i64,
}

/// TS source: `placedCollisionSpatialIndex.ts:204-242` (`gridCellRange`).
///
/// Per `validation-spatial.md` §7/§12 hazard 3: `Math.floor` rounds toward
/// negative infinity, unlike Rust's truncating `as` cast on a raw `f64`
/// quotient. The correct translation calls `.floor()` on the `f64` quotient
/// (via `js_math::floor`) *before* ever casting to an integer type -- this
/// function never casts the raw division result directly.
///
/// `width`/`height`/`cell_count` are computed as `f64` arithmetic on the
/// already-floored `f64` values (not integer arithmetic), and each of
/// `min_x`/`min_y`/`max_x`/`max_y`/`width`/`height`/`cell_count` is
/// independently checked against `Number.isSafeInteger`'s exact `2^53 - 1`
/// bound (via [`is_js_safe_integer`]) before the final `i64` cast, mirroring
/// the TS source's own order of operations and guard placement exactly
/// (including the possibility, in principle, that safe-integer `min_x`/
/// `max_x` combine into a `width` that is itself not a safe integer, which
/// this ports faithfully rather than only checking the inputs).
fn grid_cell_range(
    bounds: &IrregularBounds,
    cell_size_mm: f64,
    maximum_cell_count: i64,
) -> Option<GridCellRange> {
    if !bounds.min_x.is_finite()
        || !bounds.min_y.is_finite()
        || !bounds.max_x.is_finite()
        || !bounds.max_y.is_finite()
        || bounds.min_x > bounds.max_x
        || bounds.min_y > bounds.max_y
    {
        return None;
    }

    let min_x = js_math::floor(bounds.min_x / cell_size_mm);
    let min_y = js_math::floor(bounds.min_y / cell_size_mm);
    let max_x = js_math::floor(bounds.max_x / cell_size_mm);
    let max_y = js_math::floor(bounds.max_y / cell_size_mm);
    let width = max_x - min_x + 1.0;
    let height = max_y - min_y + 1.0;
    let cell_count = width * height;

    if !is_js_safe_integer(min_x)
        || !is_js_safe_integer(min_y)
        || !is_js_safe_integer(max_x)
        || !is_js_safe_integer(max_y)
        || !is_js_safe_integer(width)
        || !is_js_safe_integer(height)
        || !is_js_safe_integer(cell_count)
        || cell_count < 1.0
        || cell_count > maximum_cell_count as f64
    {
        return None;
    }

    Some(GridCellRange {
        min_x: min_x as i64,
        min_y: min_y as i64,
        max_x: max_x as i64,
        max_y: max_y as i64,
    })
}

/// `Number.isSafeInteger(value)` -- finite, integral, and `|value| <= 2^53 -
/// 1`. See `JS_MAX_SAFE_INTEGER`'s doc comment for why this must use the
/// exact literal bound rather than a native integer-width check.
fn is_js_safe_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value.abs() <= JS_MAX_SAFE_INTEGER
}

/// TS source: `placedCollisionSpatialIndex.ts:244-246` (`cellKey`).
fn cell_key(cell_x: i64, cell_y: i64) -> String {
    format!("{cell_x}:{cell_y}")
}

/// Parses a `cellKey`-shaped string (`"{cellX}:{cellY}"`) back into its
/// integer pair, for [`PlacedCollisionSpatialIndex::continuation_identity`]'s
/// locale-independent bucket ordering. Every key passed here was itself
/// produced by [`cell_key`], so the split/parse never fails in practice; a
/// malformed key defensively falls back to `(0, 0)` rather than panicking
/// (this has no TS counterpart -- `continuation_identity`'s ordering is a
/// Rust-side design choice, not a ported function; see that method's doc
/// comment).
fn parse_cell_key(key: &str) -> (i64, i64) {
    let mut parts = key.splitn(2, ':');
    let cell_x = parts
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let cell_y = parts
        .next()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    (cell_x, cell_y)
}

/// TS source: `placedCollisionSpatialIndex.ts:248-252` (`validCellSize`).
fn valid_cell_size(cell_size_mm: f64) -> f64 {
    if cell_size_mm.is_finite() && cell_size_mm > 0.0 {
        cell_size_mm
    } else {
        DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        IrregularPlacement, IrregularPolygon, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, PieceId, TransformedCollisionGeometry,
    };

    fn square_piece(translate_x: f64, translate_y: f64, side: f64) -> Arc<IrregularPlacedPiece> {
        let polygon = IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ]);
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new("piece"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("piece"),
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

    fn invalid_piece() -> Arc<IrregularPlacedPiece> {
        // A single-point "polygon" fails `validate_strict_boundary`'s
        // minimum-vertex-count check, landing this entry in
        // `fallback_entries`.
        let polygon = IrregularPolygon::new(vec![IrregularPoint::new(0.0, 0.0)]);
        Arc::new(IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new("invalid-piece"),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x: 0.0,
                    translate_y: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new("invalid-piece"),
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
    fn empty_index_has_zero_size_and_default_cell_size() {
        let index = make_empty_placed_collision_spatial_index(None);
        assert_eq!(index.size(), 0);
        assert_eq!(
            index.cell_size_mm(),
            DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
        );
        assert!(index.entries().is_empty());
    }

    #[test]
    fn invalid_cell_size_falls_back_to_default() {
        assert_eq!(
            make_empty_placed_collision_spatial_index(Some(-1.0)).cell_size_mm(),
            DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
        );
        assert_eq!(
            make_empty_placed_collision_spatial_index(Some(f64::NAN)).cell_size_mm(),
            DEFAULT_PLACED_COLLISION_GRID_CELL_SIZE_MM
        );
        assert_eq!(
            make_empty_placed_collision_spatial_index(Some(4.0)).cell_size_mm(),
            4.0
        );
    }

    #[test]
    fn add_does_not_mutate_parent_and_preserves_ordinal_order() {
        let base = make_empty_placed_collision_spatial_index(Some(4.0));
        let piece_a = square_piece(0.0, 0.0, 2.0);
        let piece_b = square_piece(10.0, 10.0, 2.0);

        let with_a = base.add(Arc::clone(&piece_a));
        assert_eq!(base.size(), 0, "parent index must remain empty");
        assert_eq!(with_a.size(), 1);

        let with_ab = with_a.add(Arc::clone(&piece_b));
        assert_eq!(
            with_a.size(),
            1,
            "adding to with_a's child must not mutate with_a"
        );
        assert_eq!(with_ab.size(), 2);
        assert_eq!(with_ab.entries()[0].ordinal, 0);
        assert_eq!(with_ab.entries()[1].ordinal, 1);
        assert!(Arc::ptr_eq(&with_ab.entries()[0].placed, &piece_a));
        assert!(Arc::ptr_eq(&with_ab.entries()[1].placed, &piece_b));
    }

    #[test]
    fn matches_uses_reference_identity_not_structural_equality() {
        let piece_a = square_piece(0.0, 0.0, 2.0);
        let piece_a_structural_copy = Arc::new((*piece_a).clone());
        let index = make_empty_placed_collision_spatial_index(Some(4.0)).add(Arc::clone(&piece_a));

        assert!(index.matches(&[Arc::clone(&piece_a)]));
        assert!(
            !index.matches(&[piece_a_structural_copy]),
            "a structurally-identical but distinct Arc must not match"
        );
    }

    #[test]
    fn matches_false_on_length_mismatch() {
        let piece_a = square_piece(0.0, 0.0, 2.0);
        let index = make_empty_placed_collision_spatial_index(Some(4.0)).add(Arc::clone(&piece_a));
        assert!(!index.matches(&[]));
        assert!(!index.matches(&[Arc::clone(&piece_a), square_piece(1.0, 1.0, 1.0)]));
    }

    #[test]
    fn query_without_bounds_returns_every_entry_in_ordinal_order() {
        let pieces: Vec<Arc<IrregularPlacedPiece>> = (0..5)
            .map(|i| square_piece(i as f64 * 100.0, 0.0, 2.0))
            .collect();
        let index = make_placed_collision_spatial_index(&pieces, Some(4.0));
        let result = index.query(None);
        assert_eq!(result.len(), 5);
        for (ordinal, entry) in result.iter().enumerate() {
            assert_eq!(entry.ordinal, ordinal);
        }
    }

    #[test]
    fn query_with_bounds_prunes_far_entries_but_keeps_touching_ones() {
        let near = square_piece(0.0, 0.0, 4.0);
        let touching = square_piece(4.0, 0.0, 4.0); // touches [0,4]x[0,4] at x=4
        let far = square_piece(1000.0, 1000.0, 4.0);
        let index = make_placed_collision_spatial_index(
            &[Arc::clone(&near), Arc::clone(&touching), Arc::clone(&far)],
            Some(4.0),
        );

        let query_bounds = IrregularBounds::new(0.0, 0.0, 4.0, 4.0);
        let result = index.query(Some(&query_bounds));
        let ordinals: Vec<usize> = result.iter().map(|e| e.ordinal).collect();
        assert!(ordinals.contains(&0), "near entry must survive");
        assert!(
            ordinals.contains(&1),
            "exactly-touching entry must survive (areDisjoint uses strict <)"
        );
        assert!(!ordinals.contains(&2), "far entry must be pruned");
    }

    #[test]
    fn invalid_entries_land_in_fallback_and_are_returned_unconditionally_by_query() {
        let invalid = invalid_piece();
        let valid = square_piece(0.0, 0.0, 4.0);
        let index = make_placed_collision_spatial_index(
            &[Arc::clone(&invalid), Arc::clone(&valid)],
            Some(4.0),
        );

        assert!(matches!(
            index.entries()[0].validation,
            PlacedCollisionValidation::Invalid { .. }
        ));

        // A query far away from both pieces must still surface the invalid
        // fallback entry unconditionally.
        let far_bounds = IrregularBounds::new(10_000.0, 10_000.0, 10_001.0, 10_001.0);
        let result = index.query(Some(&far_bounds));
        let ordinals: Vec<usize> = result.iter().map(|e| e.ordinal).collect();
        assert!(ordinals.contains(&0), "invalid entry must always surface");
        assert!(!ordinals.contains(&1), "valid far entry must be pruned");
    }

    #[test]
    fn query_and_add_never_mutate_self() {
        let pieces: Vec<Arc<IrregularPlacedPiece>> = (0..3)
            .map(|i| square_piece(i as f64 * 10.0, 0.0, 4.0))
            .collect();
        let index = make_placed_collision_spatial_index(&pieces, Some(4.0));
        let size_before = index.size();
        let _ = index.query(None);
        let _ = index.add(square_piece(500.0, 500.0, 1.0));
        assert_eq!(index.size(), size_before);
    }

    #[test]
    fn continuation_identity_is_deterministic_and_content_sensitive() {
        let pieces: Vec<Arc<IrregularPlacedPiece>> = (0..4)
            .map(|i| square_piece(i as f64 * 10.0, 0.0, 4.0))
            .collect();
        let index_a = make_placed_collision_spatial_index(&pieces, Some(4.0));
        let index_b = make_placed_collision_spatial_index(&pieces, Some(4.0));
        assert_eq!(
            index_a.continuation_identity(),
            index_b.continuation_identity()
        );

        let mut more_pieces = pieces.clone();
        more_pieces.push(square_piece(999.0, 999.0, 1.0));
        let index_c = make_placed_collision_spatial_index(&more_pieces, Some(4.0));
        assert_ne!(
            index_a.continuation_identity(),
            index_c.continuation_identity()
        );
    }

    #[test]
    fn grid_cell_range_rejects_non_finite_and_inverted_bounds() {
        assert!(
            grid_cell_range(&IrregularBounds::new(f64::NAN, 0.0, 1.0, 1.0), 4.0, 4096).is_none()
        );
        assert!(grid_cell_range(&IrregularBounds::new(5.0, 0.0, 1.0, 1.0), 4.0, 4096).is_none());
    }

    #[test]
    fn grid_cell_range_floors_toward_negative_infinity_for_negative_bounds() {
        // bounds [-1, 1] with cellSize 4: floor(-1/4) = floor(-0.25) = -1;
        // floor(1/4) = 0. Verified against Math.floor's documented
        // round-toward-negative-infinity semantics.
        let range =
            grid_cell_range(&IrregularBounds::new(-1.0, -1.0, 1.0, 1.0), 4.0, 4096).unwrap();
        assert_eq!(range.min_x, -1);
        assert_eq!(range.min_y, -1);
        assert_eq!(range.max_x, 0);
        assert_eq!(range.max_y, 0);
    }

    #[test]
    fn grid_cell_range_rejects_cell_count_above_maximum() {
        // A huge bounds box relative to a tiny cell size blows past the
        // 4096-cell cap.
        let range = grid_cell_range(
            &IrregularBounds::new(0.0, 0.0, 1_000_000.0, 1_000_000.0),
            1.0,
            4096,
        );
        assert!(range.is_none());
    }

    #[test]
    fn is_js_safe_integer_matches_number_is_safe_integer_bound() {
        assert!(is_js_safe_integer(JS_MAX_SAFE_INTEGER));
        assert!(!is_js_safe_integer(JS_MAX_SAFE_INTEGER + 2.0));
        assert!(!is_js_safe_integer(f64::NAN));
        assert!(!is_js_safe_integer(f64::INFINITY));
        assert!(!is_js_safe_integer(1.5));
    }

    #[test]
    fn cell_key_format_matches_ts_template_literal() {
        assert_eq!(cell_key(-3, 5), "-3:5");
        assert_eq!(cell_key(0, 0), "0:0");
        assert_eq!(parse_cell_key("-3:5"), (-3, 5));
    }
}
