//! Capacity endpoint construction, canonical identity, cavity caching, and
//! the total capacity-objective comparator.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityEndpoint.ts`
//! (369 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-core.md`
//! before touching this file -- §5 documents the orientation tie-break sort,
//! §6 documents the full 11-key `compareIntrinsicCapacityObjectives` total
//! order (exact key order and exact sign per key), §8 documents the SHA-256
//! identity/hash contract, §9 documents the exact cavity-cache access
//! sequence, and §12 documents the `localeCompare` hazard on
//! `canonicalGeometryHash`/`sourceRole` (both handled here via
//! `checkpoints::canonical_json::locale_compare_keys`, ruling R8).
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `canonical_grid::layout::{assert_canonical_grid_legal_layout,
//!   canonical_collision_layout_identity, measure_canonical_enclosed_cavities,
//!   measure_canonical_layout_envelope}` -- the exact legality/identity/
//!   cavity/envelope authority this file's TS counterpart imports from
//!   `canonicalLayoutGeometry.ts`.
//! - `geometry::hash::sha256_hex` -- the same `createHash('sha256')
//!   .update(identity).digest('hex')` shape.
//! - `search::beam_state::{IrregularBeamState, IrregularQuarterTurnDegrees}`
//!   -- the Arc-wrapped immutable partial-layout state this file measures
//!   and re-orients; used directly (not a seam type), per this task's
//!   explicit GREEN-module list.
//! - `checkpoints::canonical_json::locale_compare_keys` -- ruling R8's
//!   collator-equivalent for every `String.prototype.localeCompare` call
//!   site in this file (the orientation tie-break's hash compare, the
//!   objective comparator's hash/`sourceRole` compares).
//!
//! # `selectedRotationDeg: 0 | 90` kept as `f64`
//!
//! TS's genuine two-value literal type is mirrored as a plain `f64` (never
//! any other value at runtime), matching this crate's established
//! "every JS `number` field is `f64`" convention (see
//! `domain::transform`'s doc comment on `IrregularTransformCandidate::index`
//! for the same reasoning) rather than introducing a narrower enum
//! inconsistent with every other rotation-degree field in this domain layer.

use std::collections::HashMap;
use std::sync::Arc;

use num_bigint::BigInt;
use serde::{Serialize, Serializer};

use crate::canonical_grid::layout::{
    assert_canonical_grid_legal_layout, canonical_collision_layout_identity,
    measure_canonical_enclosed_cavities, measure_canonical_layout_envelope,
};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::domain::{IrregularPlacedPiece, PieceId, SheetSpec};
use crate::geometry::hash::sha256_hex;
use crate::search::beam_state::{IrregularBeamState, IrregularQuarterTurnDegrees};

use super::material::doubled_grid2_to_mm2;

/// TS: `intrinsicCapacityEndpoint.ts:16`
/// `INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY = 'intrinsic-capacity-empty-layout-v1'`.
/// Constant identity for the honest all-unplaced capacity layout. Must be
/// reproduced byte-for-byte (including the `-v1` suffix), since it feeds
/// `canonical_geometry_identity` and (via SHA-256) `canonical_geometry_hash`
/// for every genuinely-empty capacity endpoint.
pub const INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY: &str = "intrinsic-capacity-empty-layout-v1";

/// TS: `intrinsicCapacityEndpoint.ts:18-32` `IntrinsicCapacityEndpointMetrics`.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityEndpointMetrics {
    pub placed_count: f64,
    /// Exact doubled unpadded material area over placed prepared pieces.
    pub placed_doubled_material_area_grid2: BigInt,
    pub placed_material_area_mm2: f64,
    pub enclosed_cavity_count: f64,
    pub total_enclosed_cavity_area_mm2: f64,
    pub total_enclosed_cavity_doubled_area_grid2: String,
    pub envelope_maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    pub envelope_maximum_side_grid: f64,
    pub envelope_area_grid2: String,
    pub envelope_span_grid: f64,
}

/// TS: `intrinsicCapacityEndpoint.ts:34-38` `IntrinsicCapacityEndpointOrigin`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicCapacityEndpointOrigin {
    ColdSearch,
    PrefixIncumbent,
    WarmPrefixContinuation,
}

impl IntrinsicCapacityEndpointOrigin {
    /// TS: `intrinsicCapacityEndpoint.ts:34-38` `IntrinsicCapacityEndpointOrigin`
    /// literal union. Any TS-facing string must use this, not `{:?}`.
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicCapacityEndpointOrigin::ColdSearch => "cold-search",
            IntrinsicCapacityEndpointOrigin::PrefixIncumbent => "prefix-incumbent",
            IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation => "warm-prefix-continuation",
        }
    }
}

impl Serialize for IntrinsicCapacityEndpointOrigin {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

/// TS: `intrinsicCapacityEndpoint.ts:40-54` `IntrinsicCapacityEndpoint`. One
/// exact partial capacity layout with a complete placed/unplaced partition.
#[derive(Clone, Debug, PartialEq)]
pub struct IntrinsicCapacityEndpoint {
    pub origin: IntrinsicCapacityEndpointOrigin,
    pub source_role: Option<String>,
    pub prefix_depth: Option<f64>,
    /// Placed prepared ids in placement order.
    pub placed_prepared_ids: Vec<PieceId>,
    /// Unplaced prepared ids in immutable prepared order.
    pub unplaced_prepared_ids: Vec<PieceId>,
    /// Genuinely only ever `0.0` or `90.0`; see this module's top doc.
    pub selected_rotation_deg: f64,
    pub canonical_geometry_identity: String,
    pub canonical_geometry_hash: String,
    /// Oriented, bottom-left anchored exact placed collision geometries.
    pub placed_collision_geometries: Vec<Arc<IrregularPlacedPiece>>,
    pub metrics: IntrinsicCapacityEndpointMetrics,
}

/// TS: `intrinsicCapacityEndpoint.ts:57-73` `IntrinsicCapacityObjective`.
/// Stable value projection shared by endpoint selection, traces, and gates.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityObjective {
    pub placed_count: f64,
    #[serde(serialize_with = "crate::capacity::serialize_bigint_decimal_string")]
    pub placed_doubled_material_area_grid2: BigInt,
    pub enclosed_cavity_count: f64,
    pub total_enclosed_cavity_area_mm2: f64,
    pub total_enclosed_cavity_doubled_area_grid2: String,
    pub envelope_maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    pub envelope_maximum_side_grid: f64,
    pub envelope_area_grid2: String,
    pub envelope_span_grid: f64,
    pub canonical_geometry_hash: String,
    pub origin: IntrinsicCapacityEndpointOrigin,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefix_depth: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_role: Option<String>,
}

/// TS: `intrinsicCapacityEndpoint.ts:75-79` `IntrinsicCapacityCavityMetrics`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityCavityMetrics {
    pub count: f64,
    pub total_area_mm2: f64,
    pub total_doubled_area_grid2: String,
}

/// TS: `intrinsicCapacityEndpoint.ts:82` `IntrinsicCapacityCavityCache`. Pure
/// cache, only ever `.get`/`.set` -- never iterated -- so a plain `HashMap`
/// reproduces JS `Map`'s observable behavior exactly here (`capacity-core.md`
/// §5, "Maps used purely as O(1) lookup/dedup").
pub type IntrinsicCapacityCavityCache = HashMap<String, IntrinsicCapacityCavityMetrics>;

/// TS: `intrinsicCapacityEndpoint.ts:89-109` `measureIntrinsicCapacityCavities`.
/// Measures exact enclosed cavities for one partial state, cached by the
/// translation-independent anchored occupied-union identity. Cavity
/// topology is invariant under exact canonical-grid translation and
/// quarter-turns. See this module's top doc, `capacity-core.md` §9, for the
/// exact access sequence this reproduces (fast path on empty placements,
/// then get-before-compute, invalid results never cached).
pub fn measure_intrinsic_capacity_cavities(
    state: &IrregularBeamState,
    cache: &mut IntrinsicCapacityCavityCache,
) -> Option<IntrinsicCapacityCavityMetrics> {
    if state.placed_collision_geometries.is_empty() {
        return Some(IntrinsicCapacityCavityMetrics {
            count: 0.0,
            total_area_mm2: 0.0,
            total_doubled_area_grid2: "0".to_string(),
        });
    }
    let occupied_key = state.bottom_left_anchored_canonical_occupied_geometry_key()?;
    if let Some(cached) = cache.get(&occupied_key) {
        return Some(cached.clone());
    }
    let owned_placed = to_owned_placed(&state.placed_collision_geometries);
    let measured = measure_canonical_enclosed_cavities(&owned_placed)?;
    let metrics = IntrinsicCapacityCavityMetrics {
        count: measured.count,
        total_area_mm2: measured.total_area_mm2,
        total_doubled_area_grid2: measured.total_doubled_area_grid2,
    };
    cache.insert(occupied_key, metrics.clone());
    Some(metrics)
}

/// TS: `intrinsicCapacityEndpoint.ts:111-114` `IntrinsicCapacityGridSpan`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicCapacityGridSpan {
    pub width_grid: f64,
    pub height_grid: f64,
}

/// TS: `intrinsicCapacityEndpoint.ts:117-130` `intrinsicCapacityStateGridSpan`.
/// Exact canonical-grid span of one partial layout at its current
/// translation.
pub fn intrinsic_capacity_state_grid_span(
    state: &IrregularBeamState,
) -> Option<IntrinsicCapacityGridSpan> {
    let bounds = state.translated_collision_bounds?;
    let min_x = crate::canonical_grid::to_grid_mm(bounds.min_x)?;
    let min_y = crate::canonical_grid::to_grid_mm(bounds.min_y)?;
    let max_x = crate::canonical_grid::to_grid_mm(bounds.max_x)?;
    let max_y = crate::canonical_grid::to_grid_mm(bounds.max_y)?;
    Some(IntrinsicCapacityGridSpan {
        width_grid: max_x - min_x,
        height_grid: max_y - min_y,
    })
}

/// TS: `intrinsicCapacityEndpoint.ts:132-142` `intrinsicCapacitySpanFitsSheet`.
/// Exact partial q0/q90 fit on grid spans; final legality re-runs at
/// endpoints.
pub fn intrinsic_capacity_span_fits_sheet(
    span: IntrinsicCapacityGridSpan,
    sheet_width_grid: f64,
    sheet_height_grid: f64,
) -> (bool, bool) {
    let q0 = span.width_grid <= sheet_width_grid && span.height_grid <= sheet_height_grid;
    let q90 = span.height_grid <= sheet_width_grid && span.width_grid <= sheet_height_grid;
    (q0, q90)
}

/// TS: `intrinsicCapacityEndpoint.ts:144-153`
/// `MaterializeIntrinsicCapacityEndpointInput`.
pub struct MaterializeIntrinsicCapacityEndpointInput<'a> {
    pub sheet: &'a SheetSpec,
    pub state: Arc<IrregularBeamState>,
    pub unplaced_prepared_ids: Vec<PieceId>,
    pub origin: IntrinsicCapacityEndpointOrigin,
    pub source_role: Option<String>,
    pub prefix_depth: Option<f64>,
    pub material_areas_by_piece_id: &'a HashMap<PieceId, BigInt>,
    pub cavity_cache: &'a mut IntrinsicCapacityCavityCache,
}

/// TS: `intrinsicCapacityEndpoint.ts:161-231` `materializeIntrinsicCapacityEndpoint`.
/// Converts one exact partial state into a capacity endpoint by selecting
/// the deterministic legal q0/q90 orientation and measuring exact metrics.
/// Returns `None` when neither rigid orientation is canonical-grid legal on
/// the requested sheet.
pub fn materialize_intrinsic_capacity_endpoint(
    input: MaterializeIntrinsicCapacityEndpointInput<'_>,
) -> Option<IntrinsicCapacityEndpoint> {
    let placed_prepared_ids = input.state.placement_order.clone();
    if placed_prepared_ids.is_empty() {
        return Some(make_empty_intrinsic_capacity_endpoint(
            input.unplaced_prepared_ids,
            input.origin,
            input.source_role,
            input.prefix_depth,
        ));
    }

    let cavities = measure_intrinsic_capacity_cavities(&input.state, input.cavity_cache)?;
    let placed_doubled_material_area_grid2 =
        sum_material_areas(&placed_prepared_ids, input.material_areas_by_piece_id)?;
    let placed_count = placed_prepared_ids.len() as f64;

    struct LegalOrientation {
        rotation_deg: f64,
        identity: String,
        hash: String,
        oriented: Arc<IrregularBeamState>,
    }

    let mut legal: Vec<LegalOrientation> = Vec::new();
    for (rotation_deg, quarter_turn) in [
        (0.0_f64, IrregularQuarterTurnDegrees::Zero),
        (90.0_f64, IrregularQuarterTurnDegrees::Ninety),
    ] {
        let Some(oriented) = Arc::clone(&input.state).with_quarter_turn_bottom_left(quarter_turn)
        else {
            continue;
        };
        let owned_placed = to_owned_placed(&oriented.placed_collision_geometries);
        if !assert_canonical_grid_legal_layout(input.sheet, &owned_placed) {
            continue;
        }
        let Some(identity) = canonical_collision_layout_identity(&owned_placed) else {
            continue;
        };
        legal.push(LegalOrientation {
            rotation_deg,
            hash: sha256_hex(&identity),
            identity,
            oriented,
        });
    }

    // TS: `legal.toSorted((first, second) => first.hash.localeCompare(second.hash)
    // || first.rotationDeg - second.rotationDeg)[0]` -- prefer whichever of
    // q0/q90 produces the lexicographically-smaller (locale order) canonical
    // hash; tie-break `0` before `90`. Stable sort over at most 2 elements.
    legal.sort_by(|first, second| {
        locale_compare_keys(&first.hash, &second.hash).then_with(|| {
            first
                .rotation_deg
                .partial_cmp(&second.rotation_deg)
                .unwrap()
        })
    });
    let selected = legal.into_iter().next()?;

    let owned_selected_placed = to_owned_placed(&selected.oriented.placed_collision_geometries);
    let envelope = measure_canonical_layout_envelope(&owned_selected_placed)?;

    Some(IntrinsicCapacityEndpoint {
        origin: input.origin,
        source_role: input.source_role,
        prefix_depth: input.prefix_depth,
        placed_prepared_ids,
        unplaced_prepared_ids: input.unplaced_prepared_ids,
        selected_rotation_deg: selected.rotation_deg,
        canonical_geometry_identity: selected.identity,
        canonical_geometry_hash: selected.hash,
        placed_collision_geometries: selected.oriented.placed_collision_geometries.clone(),
        metrics: IntrinsicCapacityEndpointMetrics {
            placed_count,
            placed_doubled_material_area_grid2: placed_doubled_material_area_grid2.clone(),
            placed_material_area_mm2: doubled_grid2_to_mm2(&placed_doubled_material_area_grid2),
            enclosed_cavity_count: cavities.count,
            total_enclosed_cavity_area_mm2: cavities.total_area_mm2,
            total_enclosed_cavity_doubled_area_grid2: cavities.total_doubled_area_grid2,
            envelope_maximum_side_mm: envelope.maximum_side_mm,
            envelope_area_mm2: envelope.area_mm2,
            envelope_span_mm: envelope.span_mm,
            envelope_maximum_side_grid: envelope.maximum_side_grid,
            envelope_area_grid2: envelope.envelope_area_grid2,
            envelope_span_grid: envelope.span_grid,
        },
    })
}

/// TS: `intrinsicCapacityEndpoint.ts:233-263` `makeEmptyIntrinsicCapacityEndpoint`.
fn make_empty_intrinsic_capacity_endpoint(
    unplaced_prepared_ids: Vec<PieceId>,
    origin: IntrinsicCapacityEndpointOrigin,
    source_role: Option<String>,
    prefix_depth: Option<f64>,
) -> IntrinsicCapacityEndpoint {
    IntrinsicCapacityEndpoint {
        origin,
        source_role,
        prefix_depth,
        placed_prepared_ids: Vec::new(),
        unplaced_prepared_ids,
        selected_rotation_deg: 0.0,
        canonical_geometry_identity: INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY.to_string(),
        canonical_geometry_hash: sha256_hex(INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY),
        placed_collision_geometries: Vec::new(),
        metrics: IntrinsicCapacityEndpointMetrics {
            placed_count: 0.0,
            placed_doubled_material_area_grid2: BigInt::from(0),
            placed_material_area_mm2: 0.0,
            enclosed_cavity_count: 0.0,
            total_enclosed_cavity_area_mm2: 0.0,
            total_enclosed_cavity_doubled_area_grid2: "0".to_string(),
            envelope_maximum_side_mm: 0.0,
            envelope_area_mm2: 0.0,
            envelope_span_mm: 0.0,
            envelope_maximum_side_grid: 0.0,
            envelope_area_grid2: "0".to_string(),
            envelope_span_grid: 0.0,
        },
    }
}

/// TS: `intrinsicCapacityEndpoint.ts:265-276` `sumMaterialAreas`.
fn sum_material_areas(
    piece_ids: &[PieceId],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
) -> Option<BigInt> {
    let mut sum = BigInt::from(0);
    for piece_id in piece_ids {
        let area = material_areas_by_piece_id.get(piece_id)?;
        sum += area;
    }
    Some(sum)
}

/// TS: `intrinsicCapacityEndpoint.ts:278-281` `compareBigintDescending`.
fn compare_bigint_descending(first: &BigInt, second: &BigInt) -> std::cmp::Ordering {
    second.cmp(first)
}

/// TS: `intrinsicCapacityEndpoint.ts:349-352` `compareBigintAscending`.
fn compare_bigint_ascending(first: &BigInt, second: &BigInt) -> std::cmp::Ordering {
    first.cmp(second)
}

/// TS: `intrinsicCapacityEndpoint.ts:289-297` `compareIntrinsicCapacityEndpoints`.
/// Total capacity objective: more placed pieces, more unpadded placed
/// material, fewer exact cavities, less exact cavity area, smaller intrinsic
/// maximum side, smaller intrinsic envelope area, smaller intrinsic span,
/// deterministic geometry identity.
pub fn compare_intrinsic_capacity_endpoints(
    first: &IntrinsicCapacityEndpoint,
    second: &IntrinsicCapacityEndpoint,
) -> std::cmp::Ordering {
    compare_intrinsic_capacity_objectives(
        &intrinsic_capacity_objective(first),
        &intrinsic_capacity_objective(second),
    )
}

/// TS: `intrinsicCapacityEndpoint.ts:300-321` `intrinsicCapacityObjective`.
/// Projects one endpoint into the complete versioned capacity objective.
pub fn intrinsic_capacity_objective(
    endpoint: &IntrinsicCapacityEndpoint,
) -> IntrinsicCapacityObjective {
    IntrinsicCapacityObjective {
        placed_count: endpoint.metrics.placed_count,
        placed_doubled_material_area_grid2: endpoint
            .metrics
            .placed_doubled_material_area_grid2
            .clone(),
        enclosed_cavity_count: endpoint.metrics.enclosed_cavity_count,
        total_enclosed_cavity_area_mm2: endpoint.metrics.total_enclosed_cavity_area_mm2,
        total_enclosed_cavity_doubled_area_grid2: endpoint
            .metrics
            .total_enclosed_cavity_doubled_area_grid2
            .clone(),
        envelope_maximum_side_mm: endpoint.metrics.envelope_maximum_side_mm,
        envelope_area_mm2: endpoint.metrics.envelope_area_mm2,
        envelope_span_mm: endpoint.metrics.envelope_span_mm,
        envelope_maximum_side_grid: endpoint.metrics.envelope_maximum_side_grid,
        envelope_area_grid2: endpoint.metrics.envelope_area_grid2.clone(),
        envelope_span_grid: endpoint.metrics.envelope_span_grid,
        canonical_geometry_hash: endpoint.canonical_geometry_hash.clone(),
        origin: endpoint.origin,
        prefix_depth: endpoint.prefix_depth,
        source_role: endpoint.source_role.clone(),
    }
}

/// TS: `intrinsicCapacityEndpoint.ts:324-347` `compareIntrinsicCapacityObjectives`.
/// The authoritative 11-key total order for all capacity endpoints. Exact
/// key order and exact sign per key -- see this module's top doc /
/// `capacity-core.md` §6 for the full contract; do not reorder or invert a
/// sign during any future edit.
pub fn compare_intrinsic_capacity_objectives(
    first: &IntrinsicCapacityObjective,
    second: &IntrinsicCapacityObjective,
) -> std::cmp::Ordering {
    // 1. descending placed_count.
    second
        .placed_count
        .partial_cmp(&first.placed_count)
        .unwrap()
        // 2. descending placed_doubled_material_area_grid2.
        .then_with(|| {
            compare_bigint_descending(
                &first.placed_doubled_material_area_grid2,
                &second.placed_doubled_material_area_grid2,
            )
        })
        // 3. ascending enclosed_cavity_count.
        .then_with(|| {
            first
                .enclosed_cavity_count
                .partial_cmp(&second.enclosed_cavity_count)
                .unwrap()
        })
        // 4. ascending total_enclosed_cavity_doubled_area_grid2 (string round trip).
        .then_with(|| {
            compare_bigint_ascending(
                &parse_bigint_field(&first.total_enclosed_cavity_doubled_area_grid2),
                &parse_bigint_field(&second.total_enclosed_cavity_doubled_area_grid2),
            )
        })
        // 5. ascending envelope_maximum_side_grid.
        .then_with(|| {
            first
                .envelope_maximum_side_grid
                .partial_cmp(&second.envelope_maximum_side_grid)
                .unwrap()
        })
        // 6. ascending envelope_area_grid2 (string round trip).
        .then_with(|| {
            compare_bigint_ascending(
                &parse_bigint_field(&first.envelope_area_grid2),
                &parse_bigint_field(&second.envelope_area_grid2),
            )
        })
        // 7. ascending envelope_span_grid.
        .then_with(|| {
            first
                .envelope_span_grid
                .partial_cmp(&second.envelope_span_grid)
                .unwrap()
        })
        // 8. ascending canonical_geometry_hash (locale compare).
        .then_with(|| {
            locale_compare_keys(
                &first.canonical_geometry_hash,
                &second.canonical_geometry_hash,
            )
        })
        // 9. ascending origin rank: cold-search (0) before prefix-incumbent/
        // warm-prefix-continuation (1).
        .then_with(|| {
            intrinsic_capacity_origin_rank(first.origin)
                .cmp(&intrinsic_capacity_origin_rank(second.origin))
        })
        // 10. ascending prefix_depth, missing treated as -1.
        .then_with(|| {
            first
                .prefix_depth
                .unwrap_or(-1.0)
                .partial_cmp(&second.prefix_depth.unwrap_or(-1.0))
                .unwrap()
        })
        // 11. ascending source_role (locale compare), missing treated as "".
        .then_with(|| {
            locale_compare_keys(
                first.source_role.as_deref().unwrap_or(""),
                second.source_role.as_deref().unwrap_or(""),
            )
        })
}

/// TS: `intrinsicCapacityEndpoint.ts:349-352`'s string-encoded-bigint round
/// trip (`BigInt(stringValue)`). Every string reaching this parser
/// originates from a prior `.to_string()` of a genuine non-negative bigint
/// (never external/untrusted input) -- see this module's top doc for the
/// "bigint-vs-string" hazard this reproduces byte-for-byte.
fn parse_bigint_field(value: &str) -> BigInt {
    value.parse::<BigInt>().unwrap_or_else(|err| {
        panic!("capacity objective bigint field {value:?} failed to parse: {err}")
    })
}

/// TS: `intrinsicCapacityEndpoint.ts:354-356` `intrinsicCapacityOriginRank`.
fn intrinsic_capacity_origin_rank(origin: IntrinsicCapacityEndpointOrigin) -> u8 {
    match origin {
        IntrinsicCapacityEndpointOrigin::ColdSearch => 0,
        IntrinsicCapacityEndpointOrigin::PrefixIncumbent
        | IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation => 1,
    }
}

/// TS: `intrinsicCapacityEndpoint.ts:358-368`
/// `intrinsicCapacityEndpointPartitionsRequest`. Verifies the exact
/// placed/unplaced partition of the prepared request.
pub fn intrinsic_capacity_endpoint_partitions_request(
    placed_prepared_ids: &[PieceId],
    unplaced_prepared_ids: &[PieceId],
    all_prepared_ids: &[PieceId],
) -> bool {
    let mut partition: Vec<&PieceId> = placed_prepared_ids.iter().collect();
    partition.extend(unplaced_prepared_ids.iter());
    if partition.len() != all_prepared_ids.len() {
        return false;
    }
    let unique: std::collections::HashSet<&PieceId> = partition.iter().copied().collect();
    if unique.len() != partition.len() {
        return false;
    }
    let all_ids: std::collections::HashSet<&PieceId> = all_prepared_ids.iter().collect();
    partition.iter().all(|piece_id| all_ids.contains(*piece_id))
}

/// Converts `Arc<IrregularPlacedPiece>` elements to an owned
/// `Vec<IrregularPlacedPiece>` for the `canonical_grid::layout` functions
/// this file calls, which take `&[IrregularPlacedPiece]` -- matching the
/// established clone-deref pattern (see `search::layout_scorer`'s
/// `compute_snapshot_with_parent_fallback` for the same conversion).
fn to_owned_placed(placed: &[Arc<IrregularPlacedPiece>]) -> Vec<IrregularPlacedPiece> {
    placed.iter().map(|entry| (**entry).clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        IrregularBounds, IrregularPlacement, IrregularPoint, IrregularPolygon,
        IrregularPreparedPiece, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, TransformedCollisionGeometry,
    };

    fn square(side: f64) -> IrregularPolygon {
        IrregularPolygon::new(vec![
            IrregularPoint::new(0.0, 0.0),
            IrregularPoint::new(side, 0.0),
            IrregularPoint::new(side, side),
            IrregularPoint::new(0.0, side),
        ])
    }

    fn prepared_piece(id: &str) -> Arc<IrregularPreparedPiece> {
        Arc::new(IrregularPreparedPiece {
            piece_id: Some(PieceId::new(id)),
            interchangeability_key: None,
            source: crate::domain::ImportedPiece {
                id: PieceId::new(id),
                source_file_id: crate::domain::SourceFileId::new(format!("source-{id}")),
                source_layer: None,
                label: id.to_string(),
                real_bounds: crate::domain::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                geometry: crate::domain::DxfGeometrySummary {
                    entity_type: crate::domain::DxfGeometryEntityType::PresetShape,
                    closed: true,
                    segments: vec![],
                },
                warnings: vec![],
            },
            allow_mirror: false,
            collision_geometry: crate::domain::CollisionGeometry {
                source_piece_id: PieceId::new(id),
                source_bounds: IrregularBounds::new(0.0, 0.0, 10.0, 10.0),
                sampled_points: square(10.0).points,
                convex_hull: square(10.0),
                collision_polygon: square(10.0),
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
        })
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
                bounds: IrregularBounds::new(x, y, x + 10.0, y + 10.0),
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

    #[test]
    fn empty_endpoint_uses_the_constant_identity_and_hash() {
        let empty = IrregularBeamState::empty(vec![prepared_piece("piece-1")]);
        let mut cache = IntrinsicCapacityCavityCache::new();
        let materials: HashMap<PieceId, BigInt> = HashMap::new();
        let sheet = sheet();
        let endpoint =
            materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
                sheet: &sheet,
                state: empty,
                unplaced_prepared_ids: vec![PieceId::new("piece-1")],
                origin: IntrinsicCapacityEndpointOrigin::ColdSearch,
                source_role: None,
                prefix_depth: None,
                material_areas_by_piece_id: &materials,
                cavity_cache: &mut cache,
            })
            .expect("empty endpoint materializes");
        assert_eq!(
            endpoint.canonical_geometry_identity,
            INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY
        );
        assert_eq!(
            endpoint.canonical_geometry_hash,
            sha256_hex(INTRINSIC_CAPACITY_EMPTY_LAYOUT_IDENTITY)
        );
        assert_eq!(endpoint.selected_rotation_deg, 0.0);
        assert_eq!(endpoint.metrics.placed_count, 0.0);
        assert_eq!(
            endpoint.metrics.placed_doubled_material_area_grid2,
            BigInt::from(0)
        );
    }

    #[test]
    fn materializes_one_placed_piece_and_computes_exact_material_area() {
        let prepared = prepared_piece("piece-1");
        let empty = IrregularBeamState::empty(vec![Arc::clone(&prepared)]);
        let placed_geometry = placed(0.0, 0.0, "piece-1");
        let with_placement = empty.with_placement(crate::search::beam_state::WithPlacementInput {
            remaining_prepared_pieces: vec![],
            placed_collision_geometry: placed_geometry,
            placement_order_piece_id: PieceId::new("piece-1"),
            on_phase_timings: None,
            timing_now: None,
        });

        let mut materials: HashMap<PieceId, BigInt> = HashMap::new();
        materials.insert(
            PieceId::new("piece-1"),
            BigInt::from(2) * BigInt::from(10_000) * BigInt::from(10_000),
        );
        let mut cache = IntrinsicCapacityCavityCache::new();
        let sheet = sheet();
        let endpoint =
            materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
                sheet: &sheet,
                state: with_placement,
                unplaced_prepared_ids: vec![],
                origin: IntrinsicCapacityEndpointOrigin::ColdSearch,
                source_role: None,
                prefix_depth: None,
                material_areas_by_piece_id: &materials,
                cavity_cache: &mut cache,
            })
            .expect("endpoint materializes");
        assert_eq!(endpoint.metrics.placed_count, 1.0);
        assert_eq!(
            endpoint.metrics.placed_doubled_material_area_grid2,
            BigInt::from(2) * BigInt::from(10_000) * BigInt::from(10_000)
        );
        assert_eq!(endpoint.placed_prepared_ids, vec![PieceId::new("piece-1")]);
    }

    fn objective(placed_count: f64, hash: &str) -> IntrinsicCapacityObjective {
        IntrinsicCapacityObjective {
            placed_count,
            placed_doubled_material_area_grid2: BigInt::from(0),
            enclosed_cavity_count: 0.0,
            total_enclosed_cavity_area_mm2: 0.0,
            total_enclosed_cavity_doubled_area_grid2: "0".to_string(),
            envelope_maximum_side_mm: 0.0,
            envelope_area_mm2: 0.0,
            envelope_span_mm: 0.0,
            envelope_maximum_side_grid: 0.0,
            envelope_area_grid2: "0".to_string(),
            envelope_span_grid: 0.0,
            canonical_geometry_hash: hash.to_string(),
            origin: IntrinsicCapacityEndpointOrigin::ColdSearch,
            prefix_depth: None,
            source_role: None,
        }
    }

    #[test]
    fn more_placed_pieces_wins_first() {
        let better = objective(5.0, "b");
        let worse = objective(4.0, "a");
        assert_eq!(
            compare_intrinsic_capacity_objectives(&better, &worse),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn hash_tie_break_is_ascending() {
        let first = objective(5.0, "aaa");
        let second = objective(5.0, "bbb");
        assert_eq!(
            compare_intrinsic_capacity_objectives(&first, &second),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn origin_rank_prefers_cold_search_on_a_full_tie() {
        let mut cold = objective(5.0, "same");
        cold.origin = IntrinsicCapacityEndpointOrigin::ColdSearch;
        let mut warm = objective(5.0, "same");
        warm.origin = IntrinsicCapacityEndpointOrigin::WarmPrefixContinuation;
        assert_eq!(
            compare_intrinsic_capacity_objectives(&cold, &warm),
            std::cmp::Ordering::Less
        );
    }

    #[test]
    fn partitions_request_rejects_a_duplicate_id() {
        let all_ids = vec![PieceId::new("a"), PieceId::new("b")];
        assert!(!intrinsic_capacity_endpoint_partitions_request(
            &[PieceId::new("a"), PieceId::new("a")],
            &[],
            &all_ids
        ));
    }

    #[test]
    fn partitions_request_accepts_an_exact_partition() {
        let all_ids = vec![PieceId::new("a"), PieceId::new("b")];
        assert!(intrinsic_capacity_endpoint_partitions_request(
            &[PieceId::new("a")],
            &[PieceId::new("b")],
            &all_ids
        ));
    }
}
