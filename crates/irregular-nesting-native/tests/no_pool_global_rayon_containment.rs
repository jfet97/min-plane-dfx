//! No-pool global-Rayon containment proof.
//!
//! Contract (`cache-concurrency-design.md` §7, `boundary::parallel`'s top
//! doc): every production parallel site must execute Rayon work only inside
//! the job-owned installed pool, and must degrade to ordinary serial
//! iteration when no pool is installed. Executing a `par_iter()` inside
//! `with_job_pool`'s inline no-pool fallback does NOT satisfy that contract:
//! the closure body runs on the calling thread, but the parallel iterator
//! inside it dispatches to Rayon's ambient global registry, lazily creating
//! a process-wide default pool this crate never owns.
//!
//! This file exploits exactly that laziness as its observable: it runs a
//! complete no-pool job through `compute_irregular_nesting` (covering the
//! piece-preparation site in `result::coordinator` and the NFP-precompute
//! site in `nfp_ifp::boundary_core`, plus the strict-decoder scoring site's
//! already-gated serial branch), then attempts to build the global pool
//! itself. If any site leaked work into the ambient registry, the registry
//! already exists and `build_global` fails.
//!
//! IMPORTANT: this must remain the ONLY `#[test]` in this file. The probe is
//! process-wide, and Cargo gives each integration-test file its own process;
//! a second test in this file (or any Rayon use before the probe) would race
//! or contaminate the observation.

use irregular_nesting_native::caches::GeometryCacheStore;
use irregular_nesting_native::domain::{
    default_irregular_placement_policy_ids, DxfGeometryEntityType, DxfGeometrySegment,
    DxfGeometrySummary, DxfLineSegment, ImportedPiece, IntrinsicObjectiveProfileId,
    IrregularGeometrySettings, IrregularNestingSettings, IrregularOptimizerSettings,
    IrregularPlacementPolicyId, PieceId, Rect, SheetSpec, SourceFileId,
};
use irregular_nesting_native::result::coordinator::{
    compute_irregular_nesting, ComputeIrregularNestingOptions,
};
use irregular_nesting_native::result::{HistoryMode, NestingOptions, NestingRequest};
use irregular_nesting_native::search::layout_scorer::FreeMaterialCache;
use irregular_nesting_native::search::sort_pieces::{PreparedPiece, RectWith};

fn line(x1: f64, y1: f64, x2: f64, y2: f64) -> DxfGeometrySegment {
    DxfGeometrySegment::Line(DxfLineSegment {
        x1,
        y1,
        x2,
        y2,
        bulge: None,
        source_curve: None,
    })
}

fn square_source_piece(id: &str, x: f64, y: f64, side: f64) -> ImportedPiece {
    ImportedPiece {
        id: PieceId::new(id),
        source_file_id: SourceFileId::new("test-source"),
        source_layer: None,
        label: format!("square {id}"),
        real_bounds: Rect {
            x,
            y,
            width: side,
            height: side,
        },
        geometry: DxfGeometrySummary {
            entity_type: DxfGeometryEntityType::Lwpolyline,
            closed: true,
            segments: vec![
                line(x, y, x + side, y),
                line(x + side, y, x + side, y + side),
                line(x + side, y + side, x, y + side),
                line(x, y + side, x, y),
            ],
        },
        warnings: Vec::new(),
    }
}

fn square_prepared_piece(id: &str, side: f64) -> PreparedPiece {
    let rect = Rect {
        x: 0.0,
        y: 0.0,
        width: side,
        height: side,
    };
    PreparedPiece {
        id: PieceId::new(id),
        source_piece_id: PieceId::new(id),
        interchangeability_key: None,
        real_bounds: rect,
        padded_bounds: RectWith {
            rect,
            longest_edge: side,
            area: side * side,
            imbalance: 0.0,
        },
        padding: 0.0,
        allow_rotation: true,
        allow_mirror: true,
        cut_row_ref: None,
    }
}

fn compact_settings() -> IrregularNestingSettings {
    IrregularNestingSettings {
        geometry: IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "test".to_string(),
            geometry_backend_version: "0".to_string(),
        },
        optimizer: IrregularOptimizerSettings {
            order_window: 8.0,
            beam_width: 8.0,
            local_candidate_fanout: 4.0,
            local_repair_budget: 0.0,
            intrinsic_shared_archive_enabled: true,
            intrinsic_objective_profile_id: IntrinsicObjectiveProfileId::Compact,
            transform_cap: 24.0,
            transform_minimum_edge_length_mm: 1.0,
            transform_angle_deduplication_tolerance_deg: 0.01,
            configured_rotation_enabled: true,
            edge_alignment_enabled: true,
            configured_rotation_deg: Vec::new(),
            ga_enabled: false,
            baseline_only: true,
            ga_population: 16.0,
            ga_generation_budget: 2.0,
            ga_evaluation_budget: 24.0,
            ga_time_budget_ms: 0.0,
            ga_seed: "seed".to_string(),
            priority_order_mutation_enabled: true,
            transform_preference_mutation_enabled: true,
            placement_policy_mutation_enabled: true,
            placement_policy_id: IrregularPlacementPolicyId::BalancedCompactness,
            placement_policy_ids: default_irregular_placement_policy_ids(),
        },
    }
}

#[test]
fn no_pool_execution_never_initializes_rayons_global_registry() {
    let settings = compact_settings();
    let request = NestingRequest {
        sheet: SheetSpec {
            width: 2000.0,
            height: 2000.0,
            label: "test-sheet".to_string(),
        },
        padding: 0.0,
        pieces: vec![
            square_prepared_piece("piece-1", 100.0),
            square_prepared_piece("piece-2", 100.0),
        ],
        source_pieces: vec![
            square_source_piece("piece-1", 0.0, 0.0, 100.0),
            square_source_piece("piece-2", 0.0, 0.0, 100.0),
        ],
        options: NestingOptions {
            allow_global_rotation: true,
            allow_global_mirror: Some(true),
            history_mode: HistoryMode::Off,
            irregular_settings: None,
        },
    };

    let mut options = ComputeIrregularNestingOptions::default();
    let mut geometry_cache = GeometryCacheStore::new();
    let mut free_material_cache = FreeMaterialCache::new();

    // Deliberately NO JobPool construction and NO install() here: this is
    // the exact shape every direct-call unit/integration test and any
    // future pool-less helper caller produces.
    let result = compute_irregular_nesting(
        &request,
        &settings,
        &mut options,
        &mut geometry_cache,
        &mut free_material_cache,
    );

    // Guard against a vacuous pass: the job must actually run the pipeline
    // (piece preparation + placement search, which exercises both audited
    // parallel sites), not fail before reaching them.
    let result = result.expect("the two-square compact job must succeed without a job pool");
    assert!(
        !result.placed_collision_geometries.is_empty(),
        "the two-square compact job must place at least one piece; an empty layout means \
         the pipeline never reached the audited parallel sites"
    );

    // The probe: if any site above dispatched onto Rayon's ambient global
    // registry, that registry now exists and claiming it here fails.
    let probe = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build_global();
    assert!(
        probe.is_ok(),
        "a no-pool code path initialized Rayon's ambient global registry ({probe:?}): some \
         parallel site executed a Rayon iterator without an installed job-owned pool instead \
         of degrading to ordinary serial iteration"
    );
}
