//! Zero-evaluation "warm prefix" descriptor capture and terminalization.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicCapacityPrefixes.ts`
//! (158 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/capacity-search.md`
//! before touching this file -- §1/§2 establish this cluster's liveness and
//! entry points, §5 documents the role-major/depth-minor truncation order
//! this module's own `[...new Set(depths)]`/`.slice(0, 9)` combination
//! produces, and §11 confirms this file raises no errors at all
//! (`captureIntrinsicCapacityPrefixDescriptors`/
//! `terminalizeIntrinsicCapacityPrefixEndpoints` are both pure, total
//! functions).
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! - `capacity::endpoint::{compare_intrinsic_capacity_endpoints,
//!   materialize_intrinsic_capacity_endpoint, IntrinsicCapacityCavityCache,
//!   IntrinsicCapacityEndpoint, IntrinsicCapacityEndpointOrigin,
//!   MaterializeIntrinsicCapacityEndpointInput}` -- this file's sibling
//!   endpoint-materialization module.
//! - `capacity::material::intrinsic_capacity_prepared_piece_id` -- the same
//!   prepared-identity resolver this file's TS counterpart imports.
//! - `search::beam_state::IrregularBeamState` -- the Arc-wrapped immutable
//!   partial-layout state whose `.parent` lineage this file walks read-only.
//! - `js_number::js_math::floor` -- `Math.floor` for the quarter/half/
//!   three-quarter depth arithmetic.
//!
//! # `IntrinsicSharedArchiveDirectRole` -- reconciled onto `archive::shared`
//!
//! This file previously carried a provisional local copy of
//! `IntrinsicSharedArchiveDirectRole`/`INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`
//! (see `archive::shared`'s own top doc, "`IntrinsicSharedArchiveDirectRole`
//! -- this module is now authoritative", for the reconciliation this
//! anticipated). `intrinsicSharedArchivePortfolio.ts` is now ported as
//! `archive::shared`, so this module re-exports that module's definition
//! instead of maintaining a second copy -- both were byte-for-byte identical
//! (same three variants, same `as_str()` strings, same array-literal order)
//! for the entire time both existed, so this reconciliation changes no
//! behavior for any existing caller of either name.

use std::collections::HashMap;
use std::sync::Arc;

use num_bigint::BigInt;

use crate::domain::{IrregularPreparedPiece, PieceId, SheetSpec};
use crate::js_number::js_math;
use crate::search::beam_state::IrregularBeamState;

use super::endpoint::{
    compare_intrinsic_capacity_endpoints, materialize_intrinsic_capacity_endpoint,
    IntrinsicCapacityCavityCache, IntrinsicCapacityEndpoint, IntrinsicCapacityEndpointOrigin,
    MaterializeIntrinsicCapacityEndpointInput,
};
use super::material::intrinsic_capacity_prepared_piece_id;

/// TS: `intrinsicSharedArchivePortfolio.ts:49-50` `IntrinsicSharedArchiveDirectRole`.
/// See this module's top doc, "`IntrinsicSharedArchiveDirectRole` --
/// reconciled onto `archive::shared`": `archive::shared` is the authoritative
/// definition; this is a plain re-export, not a second copy.
pub use crate::archive::shared::{
    IntrinsicSharedArchiveDirectRole, INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES,
};

/// TS: `intrinsicCapacityPrefixes.ts:16`
/// `INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS = 9`. At most three
/// committed direct constructors times three depths.
pub const INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS: usize = 9;

/// TS: `intrinsicCapacityPrefixes.ts:19-26` `IntrinsicCapacityPrefixDescriptor`.
/// One committed direct-constructor prefix captured after construction
/// returned.
#[derive(Clone, Debug)]
pub struct IntrinsicCapacityPrefixDescriptor {
    pub role: IntrinsicSharedArchiveDirectRole,
    pub depth: f64,
    /// Immutable prefix state exactly as committed by the direct constructor.
    pub state: Arc<IrregularBeamState>,
    pub placed_prepared_ids: Vec<PieceId>,
    pub remaining_prepared_ids: Vec<PieceId>,
}

/// TS: `intrinsicCapacityPrefixes.ts:28-31` `IntrinsicCapacityPrefixSource`.
#[derive(Clone)]
pub struct IntrinsicCapacityPrefixSource {
    pub role: String,
    pub state: Arc<IrregularBeamState>,
}

/// TS: `intrinsicCapacityPrefixes.ts:34-41` `intrinsicCapacityPrefixDepths`.
/// Quarter, half, and three-quarter depths of the immutable prepared order,
/// deduplicated while preserving first-occurrence order (`[...new
/// Set(depths)]`, JS `Set` iteration order) and filtered to
/// `1 <= depth < pieceCount`.
pub fn intrinsic_capacity_prefix_depths(piece_count: f64) -> Vec<f64> {
    let raw = [
        js_math::floor(piece_count / 4.0),
        js_math::floor(piece_count / 2.0),
        js_math::floor(3.0 * piece_count / 4.0),
    ];
    let mut deduped: Vec<f64> = Vec::with_capacity(3);
    for value in raw {
        if !deduped.contains(&value) {
            deduped.push(value);
        }
    }
    deduped
        .into_iter()
        .filter(|depth| *depth >= 1.0 && *depth < piece_count)
        .collect()
}

/// TS: `intrinsicCapacityPrefixes.ts:49-83`
/// `captureIntrinsicCapacityPrefixDescriptors`.
///
/// Walks each committed direct constructor's parent lineage once, after
/// construction returned, and captures descriptors at the unique valid
/// depths. Capture is read-only: it copies no states, rebuilds no indexes,
/// and measures no geometry, so complete construction stays byte-identical.
///
/// Iteration order is role-major (fixed
/// [`INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES`] order), depth-minor (ascending,
/// per [`intrinsic_capacity_prefix_depths`]'s own order) -- load-bearing for
/// which descriptors survive the `.slice(0, 9)` truncation when more than 9
/// valid pairs exist (`capacity-search.md` §5).
pub fn capture_intrinsic_capacity_prefix_descriptors(
    prepared_pieces: &[Arc<IrregularPreparedPiece>],
    sources: &[IntrinsicCapacityPrefixSource],
) -> Vec<IntrinsicCapacityPrefixDescriptor> {
    let prepared_ids: Vec<PieceId> = prepared_pieces
        .iter()
        .map(|piece| intrinsic_capacity_prepared_piece_id(piece))
        .collect();
    let depths = intrinsic_capacity_prefix_depths(prepared_ids.len() as f64);
    if depths.is_empty() {
        return Vec::new();
    }

    let mut descriptors: Vec<IntrinsicCapacityPrefixDescriptor> = Vec::new();
    for role in INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES {
        let Some(source) = sources
            .iter()
            .find(|candidate| candidate.role == role.as_str())
        else {
            continue;
        };
        let mut states_by_processed_count: HashMap<u64, Arc<IrregularBeamState>> = HashMap::new();
        let mut lineage_state: Option<Arc<IrregularBeamState>> = Some(Arc::clone(&source.state));
        while let Some(state) = lineage_state {
            let processed_count =
                (state.placement_order.len() + state.unplaced_piece_ids.len()) as u64;
            states_by_processed_count
                .entry(processed_count)
                .or_insert_with(|| Arc::clone(&state));
            lineage_state = state.parent.clone();
        }
        for depth in &depths {
            let Some(state) = states_by_processed_count.get(&(*depth as u64)) else {
                continue;
            };
            if !is_exact_prepared_prefix(state, &prepared_ids, *depth) {
                continue;
            }
            descriptors.push(IntrinsicCapacityPrefixDescriptor {
                role,
                depth: *depth,
                state: Arc::clone(state),
                placed_prepared_ids: state.placement_order.clone(),
                remaining_prepared_ids: prepared_ids[(*depth as usize)..].to_vec(),
            });
        }
    }
    descriptors.truncate(INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS);
    descriptors
}

/// TS: `intrinsicCapacityPrefixes.ts:87-103` `isExactPreparedPrefix`. A
/// descriptor must be a skip-free processed prefix of the prepared order.
fn is_exact_prepared_prefix(
    state: &IrregularBeamState,
    prepared_ids: &[PieceId],
    depth: f64,
) -> bool {
    if !state.unplaced_piece_ids.is_empty() {
        return false;
    }
    let depth_usize = depth as usize;
    if state.placement_order.len() != depth_usize {
        return false;
    }
    for (index, placed_id) in state.placement_order.iter().enumerate().take(depth_usize) {
        if *placed_id != prepared_ids[index] {
            return false;
        }
    }
    let remaining: Vec<PieceId> = state
        .remaining_prepared_pieces
        .iter()
        .map(|piece| intrinsic_capacity_prepared_piece_id(piece))
        .collect();
    if remaining.len() != prepared_ids.len() - depth_usize {
        return false;
    }
    for (index, remaining_id) in remaining.iter().enumerate() {
        if *remaining_id != prepared_ids[depth_usize + index] {
            return false;
        }
    }
    true
}

/// TS: `intrinsicCapacityPrefixes.ts:105-114`
/// `IntrinsicCapacityPrefixTerminalization`.
#[derive(Clone, Debug)]
pub struct IntrinsicCapacityPrefixTerminalization {
    pub captured_count: f64,
    pub fitting_count: f64,
    pub rejected_count: f64,
    /// Exact fitting descriptors retained as independent warm-lane seeds.
    pub fitting_descriptors: Vec<IntrinsicCapacityPrefixDescriptor>,
    /// Deduplicated fitting prefix endpoints ranked by the capacity objective.
    pub endpoints: Vec<IntrinsicCapacityEndpoint>,
    pub incumbent: Option<IntrinsicCapacityEndpoint>,
}

/// TS: `intrinsicCapacityPrefixes.ts:121-158`
/// `terminalizeIntrinsicCapacityPrefixEndpoints`.
///
/// Exact-fits every descriptor against the requested sheet at partial
/// q0/q90, terminalizes the fitting ones into fully accounted partial
/// endpoints, and selects the initial incumbent. This performs zero
/// placement evaluations.
pub fn terminalize_intrinsic_capacity_prefix_endpoints(
    sheet: &SheetSpec,
    descriptors: &[IntrinsicCapacityPrefixDescriptor],
    material_areas_by_piece_id: &HashMap<PieceId, BigInt>,
    cavity_cache: &mut IntrinsicCapacityCavityCache,
) -> IntrinsicCapacityPrefixTerminalization {
    let mut endpoints_by_hash: HashMap<String, IntrinsicCapacityEndpoint> = HashMap::new();
    let mut fitting_descriptors: Vec<IntrinsicCapacityPrefixDescriptor> = Vec::new();
    let mut fitting_count: f64 = 0.0;
    for descriptor in descriptors {
        let endpoint =
            materialize_intrinsic_capacity_endpoint(MaterializeIntrinsicCapacityEndpointInput {
                sheet,
                state: Arc::clone(&descriptor.state),
                unplaced_prepared_ids: descriptor.remaining_prepared_ids.clone(),
                origin: IntrinsicCapacityEndpointOrigin::PrefixIncumbent,
                source_role: Some(descriptor.role.as_str().to_string()),
                prefix_depth: Some(descriptor.depth),
                material_areas_by_piece_id,
                cavity_cache,
            });
        let Some(endpoint) = endpoint else {
            continue;
        };
        fitting_descriptors.push(descriptor.clone());
        fitting_count += 1.0;
        let existing = endpoints_by_hash.get(&endpoint.canonical_geometry_hash);
        let should_replace = match existing {
            None => true,
            Some(existing) => {
                compare_intrinsic_capacity_endpoints(&endpoint, existing)
                    == std::cmp::Ordering::Less
            }
        };
        if should_replace {
            endpoints_by_hash.insert(endpoint.canonical_geometry_hash.clone(), endpoint);
        }
    }
    let mut endpoints: Vec<IntrinsicCapacityEndpoint> = endpoints_by_hash.into_values().collect();
    endpoints.sort_by(compare_intrinsic_capacity_endpoints);
    let incumbent = endpoints.first().cloned();
    IntrinsicCapacityPrefixTerminalization {
        captured_count: descriptors.len() as f64,
        fitting_count,
        rejected_count: descriptors.len() as f64 - fitting_count,
        fitting_descriptors,
        endpoints,
        incumbent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        CollisionGeometry, DxfGeometryEntityType, DxfGeometrySummary, ImportedPiece,
        IrregularBounds, IrregularPoint, IrregularPolygon, IrregularPreparedPiece, Rect,
        SourceFileId,
    };
    use crate::search::beam_state::WithPlacementInput;

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
            source: ImportedPiece {
                id: PieceId::new(id),
                source_file_id: SourceFileId::new(format!("source-{id}")),
                source_layer: None,
                label: id.to_string(),
                real_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
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
                sampled_points: square(10.0).points,
                convex_hull: square(10.0),
                collision_polygon: square(10.0),
                placement_reference: IrregularPoint::new(0.0, 0.0),
                diagnostics: vec![],
            },
            transforms: vec![],
            priority_order_key: None,
        })
    }

    fn placed_piece(id: &str, x: f64) -> Arc<crate::domain::IrregularPlacedPiece> {
        Arc::new(crate::domain::IrregularPlacedPiece {
            placement: crate::domain::IrregularPlacement {
                piece_id: Some(PieceId::new(id)),
                source_piece_id: PieceId::new(id),
                placement_reference: None,
                transform: crate::domain::IrregularTransform {
                    translate_x: x,
                    translate_y: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                },
            },
            collision_geometry: crate::domain::TransformedCollisionGeometry {
                source_piece_id: PieceId::new(id),
                transform: crate::domain::IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored: false,
                    reason: crate::domain::IrregularTransformReason::Orthogonal,
                },
                polygon: square(10.0),
                bounds: IrregularBounds::new(x, 0.0, x + 10.0, 10.0),
            },
        })
    }

    #[test]
    fn prefix_depths_deduplicate_preserving_first_occurrence_order() {
        // pieceCount = 3: quarter=0 (filtered out), half=1, three-quarter=2.
        assert_eq!(intrinsic_capacity_prefix_depths(3.0), vec![1.0, 2.0]);
        // pieceCount = 4: quarter=1, half=2, three-quarter=3.
        assert_eq!(intrinsic_capacity_prefix_depths(4.0), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn prefix_depths_are_empty_below_four_pieces_with_no_valid_depth() {
        assert_eq!(intrinsic_capacity_prefix_depths(0.0), Vec::<f64>::new());
    }

    #[test]
    fn captures_a_skip_free_prefix_at_the_unique_valid_depth() {
        let pieces: Vec<Arc<IrregularPreparedPiece>> = (0..4)
            .map(|index| prepared_piece(&format!("piece-{index}")))
            .collect();
        let empty = IrregularBeamState::empty(pieces.clone());
        let one = empty.with_placement(WithPlacementInput {
            remaining_prepared_pieces: pieces[1..].to_vec(),
            placed_collision_geometry: placed_piece("piece-0", 0.0),
            placement_order_piece_id: PieceId::new("piece-0"),
            on_phase_timings: None,
            timing_now: None,
        });
        let sources = vec![IntrinsicCapacityPrefixSource {
            role: "canonical-grid".to_string(),
            state: one,
        }];
        let descriptors = capture_intrinsic_capacity_prefix_descriptors(&pieces, &sources);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].depth, 1.0);
        assert_eq!(
            descriptors[0].role,
            IntrinsicSharedArchiveDirectRole::CanonicalGrid
        );
        assert_eq!(
            descriptors[0].placed_prepared_ids,
            vec![PieceId::new("piece-0")]
        );
    }

    #[test]
    fn rejects_a_lineage_that_skipped_a_piece_before_the_capture_depth() {
        let pieces: Vec<Arc<IrregularPreparedPiece>> = (0..4)
            .map(|index| prepared_piece(&format!("piece-{index}")))
            .collect();
        let empty = IrregularBeamState::empty(pieces.clone());
        let skipped =
            empty.with_unplaced_piece(crate::search::beam_state::WithUnplacedPieceInput {
                remaining_prepared_pieces: pieces[1..].to_vec(),
                unplaced_piece_id: PieceId::new("piece-0"),
            });
        let one = skipped.with_placement(WithPlacementInput {
            remaining_prepared_pieces: pieces[2..].to_vec(),
            placed_collision_geometry: placed_piece("piece-1", 0.0),
            placement_order_piece_id: PieceId::new("piece-1"),
            on_phase_timings: None,
            timing_now: None,
        });
        let sources = vec![IntrinsicCapacityPrefixSource {
            role: "canonical-grid".to_string(),
            state: one,
        }];
        // Processed count at `one` is 2 (1 placed + 1 skipped), so depth 1
        // never matches this lineage's own processed-count map (depth 2
        // would match by count but fails the skip-free/order check).
        let descriptors = capture_intrinsic_capacity_prefix_descriptors(&pieces, &sources);
        assert!(descriptors.iter().all(|descriptor| descriptor.depth != 1.0));
    }

    #[test]
    fn truncates_to_the_maximum_descriptor_count() {
        // 12 pieces produce three distinct depths (3, 6, 9); three roles
        // each contributing a full-lineage source yields 9 descriptors --
        // exactly at the cap, so this pins the truncation arithmetic without
        // needing more than 9 real (role, depth) pairs to exceed it.
        let pieces: Vec<Arc<IrregularPreparedPiece>> = (0..12)
            .map(|index| prepared_piece(&format!("piece-{index}")))
            .collect();
        assert_eq!(intrinsic_capacity_prefix_depths(12.0), vec![3.0, 6.0, 9.0]);
        let mut state = IrregularBeamState::empty(pieces.clone());
        for index in 0..9 {
            let remaining = pieces[(index + 1)..].to_vec();
            state = state.with_placement(WithPlacementInput {
                remaining_prepared_pieces: remaining,
                placed_collision_geometry: placed_piece(
                    &format!("piece-{index}"),
                    index as f64 * 20.0,
                ),
                placement_order_piece_id: PieceId::new(format!("piece-{index}")),
                on_phase_timings: None,
                timing_now: None,
            });
        }
        let sources: Vec<IntrinsicCapacityPrefixSource> = INTRINSIC_SHARED_ARCHIVE_DIRECT_ROLES
            .iter()
            .map(|role| IntrinsicCapacityPrefixSource {
                role: role.as_str().to_string(),
                state: Arc::clone(&state),
            })
            .collect();
        let descriptors = capture_intrinsic_capacity_prefix_descriptors(&pieces, &sources);
        assert_eq!(
            descriptors.len(),
            INTRINSIC_CAPACITY_MAXIMUM_PREFIX_DESCRIPTORS
        );
    }

    #[test]
    fn terminalizes_zero_descriptors_into_an_empty_result_without_evaluations() {
        let sheet = SheetSpec {
            width: 100.0,
            height: 100.0,
            label: "sheet".to_string(),
        };
        let materials: HashMap<PieceId, BigInt> = HashMap::new();
        let mut cache = IntrinsicCapacityCavityCache::new();
        let result =
            terminalize_intrinsic_capacity_prefix_endpoints(&sheet, &[], &materials, &mut cache);
        assert_eq!(result.captured_count, 0.0);
        assert_eq!(result.fitting_count, 0.0);
        assert!(result.endpoints.is_empty());
        assert!(result.incumbent.is_none());
    }
}
