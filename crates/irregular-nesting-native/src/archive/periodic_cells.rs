//! Periodic base-cell enumeration: repeated-collision-family discovery, P1
//! (single-member) and P2 (two-member) lattice-cell derivation, finite-crop
//! enumeration, and crop/Pareto seed selection.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicPeriodicCells.ts`
//! (2365 lines), ported in full per
//! `docs/planning/rust-irregular-backend/characterization/periodic.md` (this
//! module's primary governing source; every section is load-bearing).
//!
//! # Reused (GREEN) modules — never duplicated here
//!
//! - `search::strict_family::group_intrinsic_collision_families` — the TS
//!   counterpart's `intrinsicStrictFamilyPortfolio.js` import.
//! - `canonical_grid::{to_grid_mm, from_grid}` — the TS counterpart's
//!   `clipper2OffsetPolicy.js` import.
//! - `canonical_grid::layout::{canonical_collision_layout_identity,
//!   measure_canonical_layout_envelope, measure_canonical_layout_topology}`
//!   — the TS counterpart's `canonicalLayoutGeometry.js` import.
//! - `canonical_grid::contact::{shared_convex_polygon_boundary_length,
//!   shared_convex_polygon_boundary_segments}` — the TS counterpart's
//!   `convexPolygonContact.js` import.
//! - `geometry::convex::{bounds_for_points, translate_polygon_with_bounds,
//!   IrregularPolygonWithBounds}` — the TS counterpart's `convexBounds.js`
//!   import.
//! - `caches::{resolve_transformed_collision_geometry,
//!   TransformCollisionGeometryKeyInput, GeometryCacheStore}` — the TS
//!   counterpart's `GeometryKernel.transformCollisionGeometry`
//!   (`geometryKernel.ts:179-190`).
//! - `nfp_ifp::{compute_nfp, nfp_checkpoint, NfpIfpControl,
//!   NfpIfpControlAbortError, NfpIfpCheckpointPhase}` — the TS counterpart's
//!   `NfpIfpService.computeNfp` and `IrregularNfpIfpControl.checkpoint`.
//! - `validation::placement::{assess_placement, AssessPlacementInput}` — the
//!   TS counterpart's `PlacementValidation.checkSheetless`. This cluster
//!   never builds or threads a spatial index (characterization doc §9: "each
//!   call independently builds its own `placed` accumulator — no shared
//!   spatial index state persists"), so every call here passes
//!   `placed_collision_index: None`.
//! - `checkpoints::canonical_json::locale_compare_keys` — every
//!   `.localeCompare()` call site (characterization doc §6/§12 hazard 1).
//! - `js_number::{cmp_js_code_units, js_math, number_to_js_string}` — every
//!   bare (default-comparator) `.toSorted()` and `Math.min`/`Math.max` call
//!   site (characterization doc §5 item 10, §12 hazard 3).
//! - `clipper::core`/`clipper::engine` — the vendored Clipper2 port (ruling
//!   R10), used only inside [`union_forbidden_boundaries`], matching the TS
//!   source's own single call site for direct Boolean geometry
//!   (characterization doc §2, "Clipper2").
//!
//! # BigInt exact arithmetic (ruling R6)
//!
//! Every exact grid quantity in this file (`GridPoint`, `Rational`,
//! determinant/area/far-neighbor-certificate arithmetic) uses
//! `num_bigint::BigInt`, never a fixed-width integer — per ruling R6 and
//! characterization doc §7/§15 item 7, no proven bound on the magnitude of
//! cross-multiplied/squared products reachable through
//! [`far_neighbor_certificate`] and the axis-basis rational arithmetic was
//! derived in this pass, so a fixed-width type would be an unverified
//! assumption.
//!
//! # `PolyTree64` traversal order is tie-break-observable
//!
//! [`union_forbidden_boundaries`]/[`collect_forbidden_tree`] preserve the
//! vendored Clipper2 port's own `PolyTree64::child` traversal order exactly
//! (`0..count(node)`, depth-first) — characterization doc §5 item 7 documents
//! this as directly observable in which exact axis-basis candidate is chosen
//! when multiple are geometrically valid.
//!
//! # Two independently-declared `compareBigInt`s collapsed into one
//!
//! The TS source has two near-identical `compareBigInt`s
//! (`canonicalGridMath.compareBigInts`, imported, vs. a locally-declared
//! `compareBigInt` used everywhere else in `CELLS`) that the characterization
//! doc (§7/§12 hazard 2) confirms compute the *same* sign-of-difference for
//! every input — this port uses plain `BigInt: Ord` (`.cmp()`) throughout for
//! both, a verified-safe consolidation, not an assumption from the names.
//!
//! # Number-or-object `options` overload not ported
//!
//! TS's `enumerateIntrinsicPeriodicCells(pieces, options: number |
//! IntrinsicPeriodicCatalogOptions = {})` accepts a bare number as shorthand
//! for `{ maximumRuntimeMs: number }`. No production caller
//! (`intrinsicPeriodicFamilyPortfolio.ts:247-255`) ever uses that shorthand
//! — production always passes the full options object. This port's
//! [`enumerate_intrinsic_periodic_cells`] therefore takes only the resolved
//! [`IntrinsicPeriodicCatalogOptions`] struct (with a `Default` impl
//! reproducing TS's own per-field defaults, `CELLS:356-363`); the bare-number
//! convenience overload is not reproduced, a documented, deliberate scope
//! reduction of a test/diagnostic-only convenience surface, not of any
//! production-reachable behavior.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;

use num_bigint::BigInt;
use serde::{Deserialize, Serialize};

use crate::caches::{
    resolve_transformed_collision_geometry, GeometryCacheStore, TransformCollisionGeometryKeyInput,
    DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
};
use crate::canonical_grid::contact::{
    shared_convex_polygon_boundary_length, shared_convex_polygon_boundary_segments,
};
use crate::canonical_grid::layout::{
    canonical_collision_layout_identity, measure_canonical_layout_envelope,
    measure_canonical_layout_topology,
};
use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::clipper::core::{
    area, bigint_to_number, f64_to_bigint, is_safe_integer, ClipType, FillRule, Path64, Paths64,
    Point64,
};
use crate::clipper::engine::{boolean_op_with_poly_tree, PolyTree64};
use crate::domain::{
    IrregularNestingSettings, IrregularPlacedPiece, IrregularPlacement,
    IrregularPlacementCandidate, IrregularPoint, IrregularPreparedPiece, IrregularTransform,
    IrregularTransformCandidate, TransformedCollisionGeometry,
};
use crate::geometry::convex::{bounds_for_points, translate_polygon_with_bounds};
use crate::js_number::{cmp_js_code_units, js_math, number_to_js_string};
use crate::nfp_ifp::{
    compute_nfp, nfp_checkpoint, ComputeNfpInput, NfpIfpCheckpointPhase, NfpIfpControl,
    NfpIfpControlAbortError,
};
use crate::search::strict_family::group_intrinsic_collision_families;
use crate::validation::placement::{
    assess_placement, AssessPlacementInput, IrregularGeometryInputError,
};

// ===========================================================================
// Constants (`CELLS:55-58`).
// ===========================================================================

pub const MAXIMUM_NFP_BOUNDARY_VERTEX_BASIS_CANDIDATES: usize = 64;
pub const MAXIMUM_EDGE_CONTACT_RELATIONS_PER_DERIVATION: usize = 64;
pub const MAXIMUM_EDGE_CONTACT_BASIS_CANDIDATES_PER_DERIVATION: usize = 64;
pub const MAXIMUM_EDGE_CONTACT_PAIR_VALIDATION_ATTEMPTS_PER_DERIVATION: usize = 256;

// ===========================================================================
// Error taxonomy.
// ===========================================================================

/// The `enumerateIntrinsicPeriodicCells`/`deriveCells` Effect error channel,
/// `IrregularNestingNotImplementedError | IrregularGeometryInputError |
/// IrregularNfpIfpControlAbortError` (`CELLS:277-279`), minus the DI-only
/// first arm — see `search::strict_decoder`'s own module doc for the
/// established convention this follows.
#[derive(Clone, Debug, PartialEq)]
pub enum IntrinsicPeriodicError {
    Geometry(IrregularGeometryInputError),
    Abort(NfpIfpControlAbortError),
}

impl From<IrregularGeometryInputError> for IntrinsicPeriodicError {
    fn from(value: IrregularGeometryInputError) -> Self {
        IntrinsicPeriodicError::Geometry(value)
    }
}

impl From<NfpIfpControlAbortError> for IntrinsicPeriodicError {
    fn from(value: NfpIfpControlAbortError) -> Self {
        IntrinsicPeriodicError::Abort(value)
    }
}

// ===========================================================================
// Public output types (`CELLS:60-249`).
// ===========================================================================

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct IntrinsicPeriodicVector {
    pub x: f64,
    pub y: f64,
}

/// TS: `CELLS:117` `role: 'P1' | 'P2'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IntrinsicPeriodicRole {
    P1,
    P2,
}

impl IntrinsicPeriodicRole {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicPeriodicRole::P1 => "P1",
            IntrinsicPeriodicRole::P2 => "P2",
        }
    }
}

/// TS: `CELLS:68` `sourceKind: 'axis-union' | 'nfp-boundary-vertex-pair' |
/// 'edge-contact-pair'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntrinsicPeriodicBasisSourceKind {
    AxisUnion,
    NfpBoundaryVertexPair,
    EdgeContactPair,
}

impl IntrinsicPeriodicBasisSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicPeriodicBasisSourceKind::AxisUnion => "axis-union",
            IntrinsicPeriodicBasisSourceKind::NfpBoundaryVertexPair => "nfp-boundary-vertex-pair",
            IntrinsicPeriodicBasisSourceKind::EdgeContactPair => "edge-contact-pair",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntrinsicPeriodicAxis {
    X,
    Y,
}

impl IntrinsicPeriodicAxis {
    pub fn as_str(self) -> &'static str {
        match self {
            IntrinsicPeriodicAxis::X => "x",
            IntrinsicPeriodicAxis::Y => "y",
        }
    }
}

/// TS: `CELLS:96-99` `IntrinsicPeriodicRationalPoint`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IntrinsicPeriodicRationalPoint {
    pub x: String,
    pub y: String,
}

/// TS: `CELLS:82-93` `IntrinsicPeriodicEdgeContactProvenance`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicEdgeContactProvenance {
    pub vector: IntrinsicPeriodicVector,
    pub fixed_member_index: f64,
    pub fixed_piece_id: String,
    pub fixed_edge_index: f64,
    pub moving_member_index: f64,
    pub moving_piece_id: String,
    pub moving_edge_index: f64,
    pub segment_start: IrregularPoint,
    pub segment_end: IrregularPoint,
    pub length_mm: f64,
}

/// TS: `CELLS:102-108` `IntrinsicPeriodicMemberTransform`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicMemberTransform {
    pub member_index: f64,
    pub piece_id: String,
    pub transform_index: f64,
    pub rotation_deg: f64,
    pub mirrored: bool,
}

/// TS: `CELLS:66-79` `IntrinsicPeriodicBasisProvenance`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicBasisProvenance {
    pub source_key: String,
    pub source_kind: IntrinsicPeriodicBasisSourceKind,
    pub source_points: [IntrinsicPeriodicRationalPoint; 2],
    /// Present only for `sourceKind === 'axis-union'` (`CELLS:1194`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axis: Option<IntrinsicPeriodicAxis>,
    pub selected_basis: [IntrinsicPeriodicVector; 2],
    pub selected_residual_grid: [IntrinsicPeriodicRationalPoint; 2],
    pub canonical_basis: [IntrinsicPeriodicVector; 2],
    pub member_transforms: Vec<IntrinsicPeriodicMemberTransform>,
    /// Present only for `sourceKind === 'edge-contact-pair'` (`CELLS:1208-1210`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact_relations: Option<(
        IntrinsicPeriodicEdgeContactProvenance,
        IntrinsicPeriodicEdgeContactProvenance,
    )>,
}

/// TS: `CELLS:110-114` `IntrinsicPeriodicBaseMember`.
///
/// `piece` is `Arc`-wrapped (not TS-mandated -- TS objects are reference-
/// counted implicitly by the JS engine, so passing `piece` around never
/// deep-copies there): production families place `derive_cells` inside a
/// P2 pair/candidate-point double loop that can visit thousands of
/// candidate points for real, non-trivial fixture geometry (each candidate
/// constructs two `IntrinsicPeriodicBaseMember`s, and every constructed
/// `IntrinsicPeriodicCell` is cloned again during `periodic_cell_front`'s
/// dedup/rank/cap pass), and `IrregularPreparedPiece` carries the full
/// source geometry plus every transform candidate. By-value cloning at that
/// call volume measured as an 18-24s wall-clock blowup for a single 7-piece
/// differential case (`docs/planning/rust-irregular-backend/evidence/differential-e2e-report.md`),
/// entirely inside `Vec::clone`/struct-literal copies of otherwise-identical
/// piece data -- never in TS, which only ever copies a reference. `Arc`
/// restores that same "cheap reference, not a deep copy" semantics.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicBaseMember {
    pub piece: Arc<IrregularPreparedPiece>,
    pub geometry: TransformedCollisionGeometry,
    pub point: IrregularPoint,
}

/// TS: `CELLS:116-137` `IntrinsicPeriodicCell`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicCell {
    pub role: IntrinsicPeriodicRole,
    pub family_key: String,
    pub members: Vec<IntrinsicPeriodicBaseMember>,
    pub v1: IntrinsicPeriodicVector,
    pub v2: IntrinsicPeriodicVector,
    pub determinant_grid2: String,
    pub member_doubled_area_grid2: String,
    /// Derived float diagnostic only; never load-bearing in any comparator.
    pub density: f64,
    pub envelope_maximum_side_mm: f64,
    pub hull_waste_ratio: f64,
    pub shared_boundary_length_mm: f64,
    pub infinite_far_proof: bool,
    pub three_by_three_lattice_legal: bool,
    pub three_by_three_centre_contact_complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis_provenance: Option<IntrinsicPeriodicBasisProvenance>,
    pub canonical_key: String,
}

/// TS: `CELLS:139-148` `IntrinsicPeriodicCatalog`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicCatalog {
    pub family_coverage_complete: bool,
    pub runtime_coverage_complete: bool,
    pub families: Vec<IntrinsicPeriodicFamilyCatalog>,
    pub selected_family_key: Option<String>,
    pub unique_transform_count: f64,
    pub enumerated_pair_count: f64,
    pub cells: Vec<IntrinsicPeriodicCell>,
    pub rejected: Vec<(String, f64)>,
}

/// TS: `CELLS:150-159` `IntrinsicPeriodicCatalogOptions`, already resolved
/// (`CELLS:341-364` `ResolvedIntrinsicPeriodicCatalogOptions`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicCatalogOptions {
    pub maximum_runtime_ms: f64,
    pub maximum_family_count: usize,
    pub maximum_transforms_per_family: usize,
    pub maximum_pairs_per_family: usize,
    pub maximum_cells_per_family_role: usize,
    pub capture_source_survival_audit: bool,
}

impl Default for IntrinsicPeriodicCatalogOptions {
    fn default() -> Self {
        Self {
            maximum_runtime_ms: 15_000.0,
            maximum_family_count: 8,
            maximum_transforms_per_family: 16,
            maximum_pairs_per_family: 120,
            maximum_cells_per_family_role: 4,
            capture_source_survival_audit: false,
        }
    }
}

/// TS: `CELLS:161-165` `IntrinsicPeriodicTransformReservation`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicTransformReservation {
    pub key: String,
    pub available_count: f64,
    pub retained_count: f64,
}

/// TS: `CELLS:169-174` rejection `stage` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntrinsicPeriodicCellRejectionStage {
    AxisBasisUnavailable,
    DegenerateBasis,
    /// Declared by the TS union but never constructed by any `reject(...)`
    /// call site in `deriveCells` (verified by reading the whole function) —
    /// preserved for type-shape fidelity, never emitted by this port either.
    FarNeighborRejected,
    /// Same as [`Self::FarNeighborRejected`]: declared, never constructed.
    ThreeByThreeLatticeRejected,
    BaseShapeRejected,
}

/// TS: `CELLS:167-178` `IntrinsicPeriodicCellRejection`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicCellRejection {
    pub role: IntrinsicPeriodicRole,
    pub stage: IntrinsicPeriodicCellRejectionStage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v1: Option<IntrinsicPeriodicVector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub v2: Option<IntrinsicPeriodicVector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub determinant_grid2: Option<String>,
}

/// TS: `CELLS:202-212` `IntrinsicPeriodicEdgeContactDiagnostics`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicEdgeContactDiagnostics {
    pub generated_relation_count: f64,
    pub retained_relation_count: f64,
    pub non_collinear_pair_count: f64,
    pub area_feasible_pair_count: f64,
    pub validation_attempt_count: f64,
    pub validation_coverage_complete: bool,
    pub lattice_rejected_count: f64,
    pub contact_incomplete_count: f64,
    pub admitted_basis_count: f64,
}

fn empty_edge_contact_diagnostics() -> IntrinsicPeriodicEdgeContactDiagnostics {
    IntrinsicPeriodicEdgeContactDiagnostics {
        generated_relation_count: 0.0,
        retained_relation_count: 0.0,
        non_collinear_pair_count: 0.0,
        area_feasible_pair_count: 0.0,
        validation_attempt_count: 0.0,
        validation_coverage_complete: true,
        lattice_rejected_count: 0.0,
        contact_incomplete_count: 0.0,
        admitted_basis_count: 0.0,
    }
}

fn merge_edge_contact_diagnostics(
    first: IntrinsicPeriodicEdgeContactDiagnostics,
    second: IntrinsicPeriodicEdgeContactDiagnostics,
) -> IntrinsicPeriodicEdgeContactDiagnostics {
    IntrinsicPeriodicEdgeContactDiagnostics {
        generated_relation_count: first.generated_relation_count + second.generated_relation_count,
        retained_relation_count: first.retained_relation_count + second.retained_relation_count,
        non_collinear_pair_count: first.non_collinear_pair_count + second.non_collinear_pair_count,
        area_feasible_pair_count: first.area_feasible_pair_count + second.area_feasible_pair_count,
        validation_attempt_count: first.validation_attempt_count + second.validation_attempt_count,
        validation_coverage_complete: first.validation_coverage_complete
            && second.validation_coverage_complete,
        lattice_rejected_count: first.lattice_rejected_count + second.lattice_rejected_count,
        contact_incomplete_count: first.contact_incomplete_count + second.contact_incomplete_count,
        admitted_basis_count: first.admitted_basis_count + second.admitted_basis_count,
    }
}

/// TS: `CELLS:215-221` `IntrinsicPeriodicSourceCellSurvival`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSourceCellSurvival {
    pub role: IntrinsicPeriodicRole,
    pub source_key: String,
    pub source_kind: IntrinsicPeriodicBasisSourceKind,
    pub cells_before_front: f64,
    pub cells_retained: f64,
}

/// TS: `CELLS:180-199` `IntrinsicPeriodicFamilyCatalog`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicFamilyCatalog {
    pub family_key: String,
    pub member_count: f64,
    pub collision_area_mm2: f64,
    pub unique_transform_count: f64,
    pub retained_transform_count: f64,
    pub transform_coverage_complete: bool,
    pub transform_reservations: Vec<IntrinsicPeriodicTransformReservation>,
    pub enumerated_pair_count: f64,
    pub pair_coverage_complete: bool,
    pub cell_coverage_complete: bool,
    pub edge_contact_diagnostics: IntrinsicPeriodicEdgeContactDiagnostics,
    pub source_survival: Vec<IntrinsicPeriodicSourceCellSurvival>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_audit_cells: Option<Vec<IntrinsicPeriodicCell>>,
    pub cells: Vec<IntrinsicPeriodicCell>,
    pub rejected: Vec<(String, f64)>,
    pub rejected_samples: Vec<IntrinsicPeriodicCellRejection>,
}

/// TS: `CELLS:244-249` `IntrinsicPeriodicCropProvenance`.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntrinsicPeriodicCropTraversal {
    Row,
    Column,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicCropProvenance {
    pub rows: f64,
    pub columns: f64,
    pub traversal: IntrinsicPeriodicCropTraversal,
    pub corner: u8,
}

/// TS: `CELLS:234-238` the inline `exactEnvelope` object type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicExactEnvelope {
    pub maximum_side_grid: f64,
    pub area_grid2: String,
    pub span_grid: f64,
}

/// TS: `CELLS:223-241` `IntrinsicPeriodicSeed`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntrinsicPeriodicSeed {
    pub role: IntrinsicPeriodicRole,
    pub cell_key: String,
    pub placements: Vec<IrregularPlacedPiece>,
    pub remaining_family_members: Vec<IrregularPreparedPiece>,
    pub component_count: f64,
    pub isolated_piece_count: f64,
    pub largest_component_size: f64,
    pub maximum_side_mm: f64,
    pub envelope_area_mm2: f64,
    pub envelope_span_mm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_envelope: Option<IntrinsicPeriodicExactEnvelope>,
    pub crop: IntrinsicPeriodicCropProvenance,
    pub canonical_key: String,
}

// ===========================================================================
// Compute context (Rust seam replacing the TS `Effect` dependency layer:
// `GeometryKernel | GeometrySettings | NfpIfpService`).
// ===========================================================================

/// Bundles the mutable geometry cache, the (immutable) nesting settings, and
/// the optional cooperative-cancellation control this whole cluster threads
/// through every call. Mirrors the `Effect` context TS resolves via `yield*`
/// (`CELLS:285-287`); Rust has no ambient DI layer, so callers construct and
/// own this explicitly, the same pattern `search::strict_decoder`'s own
/// module doc establishes.
pub struct PeriodicRunContext<'a> {
    pub settings: &'a IrregularNestingSettings,
    pub geometry_cache: &'a mut GeometryCacheStore,
    pub control: Option<&'a mut dyn NfpIfpControl>,
}

fn checkpoint(control: &mut Option<&mut dyn NfpIfpControl>) -> Result<(), IntrinsicPeriodicError> {
    nfp_checkpoint(control, NfpIfpCheckpointPhase::CandidatePoints, None)
        .map_err(IntrinsicPeriodicError::from)
}

// A process-relative monotonic clock mirroring `performance.now()`. This
// file has no `timingNow` injection seam in TS (unlike `strict_decoder`), so
// a single process-wide clock is sufficient.
static PROCESS_START: std::sync::LazyLock<std::time::Instant> =
    std::sync::LazyLock::new(std::time::Instant::now);

fn now_ms() -> f64 {
    PROCESS_START.elapsed().as_secs_f64() * 1000.0
}

// ===========================================================================
// Small ordering helpers (characterization doc §12 hazards 1/3/4).
// ===========================================================================

/// JS `a - b || c - d || ...` chain idiom: `0`/`-0`/`NaN` are all falsy in
/// JS, so a zero or `NaN` difference falls through to the next comparator
/// term exactly like `Ordering::Equal` does under `.then_with(...)`.
fn diff_ord(diff: f64) -> Ordering {
    if diff.is_nan() || diff == 0.0 {
        Ordering::Equal
    } else if diff < 0.0 {
        Ordering::Less
    } else {
        Ordering::Greater
    }
}

/// `effect`'s `Order.Number`: `NaN` sorts less than every non-`NaN` value and
/// equals another `NaN` (distinct from [`diff_ord`]'s falsy-chain idiom —
/// only [`transform_order`] uses this).
fn js_order_number(a: f64, b: f64) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.partial_cmp(&b).unwrap_or(Ordering::Equal),
    }
}

/// TS: `transformOrder` (`CELLS:48-52`).
fn transform_order(
    first: &IrregularTransformCandidate,
    second: &IrregularTransformCandidate,
) -> Ordering {
    js_order_number(first.index, second.index)
        .then_with(|| js_order_number(first.rotation_deg, second.rotation_deg))
        .then_with(|| first.mirrored.cmp(&second.mirrored))
}

/// Bare `.toSorted()` over `[key, count]` reason-map entries
/// (characterization doc §5 item 10): JS stringifies each tuple via
/// `Array.prototype.toString` (`` `${key},${count}` ``) and compares those
/// strings by UTF-16 code-unit order, not by `key` alone.
fn sort_rejected_entries(mut entries: Vec<(String, f64)>) -> Vec<(String, f64)> {
    entries.sort_by(|(first_key, first_count), (second_key, second_count)| {
        let first = format!("{first_key},{}", number_to_js_string(*first_count));
        let second = format!("{second_key},{}", number_to_js_string(*second_count));
        cmp_js_code_units(&first, &second)
    });
    entries
}

// ===========================================================================
// A minimal insertion-order-preserving map mirroring JS `Map` semantics
// (characterization doc §12 hazard 4): `set` on an existing key updates the
// value in place without moving its position.
// ===========================================================================

struct OrderedMap<T> {
    order: Vec<String>,
    index: HashMap<String, usize>,
    values: Vec<T>,
}

impl<T> OrderedMap<T> {
    fn new() -> Self {
        Self {
            order: Vec::new(),
            index: HashMap::new(),
            values: Vec::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&T> {
        self.index.get(key).map(|&index| &self.values[index])
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        match self.index.get(key) {
            Some(&index) => Some(&mut self.values[index]),
            None => None,
        }
    }

    fn set(&mut self, key: String, value: T) {
        if let Some(&index) = self.index.get(&key) {
            self.values[index] = value;
        } else {
            self.index.insert(key.clone(), self.values.len());
            self.order.push(key);
            self.values.push(value);
        }
    }

    fn set_if_absent(&mut self, key: String, value: T) {
        if !self.index.contains_key(&key) {
            self.set(key, value);
        }
    }

    /// Amortized O(1) per call (a single `HashMap` lookup plus, on miss, one
    /// insert) -- unlike `get(key).cloned().unwrap_or_default()` followed by
    /// a `set()`, which deep-clones the *entire* existing value on every
    /// call and turns a tight accumulation loop quadratic. See
    /// `periodic_cell_front`'s own doc for the real-fixture measurement this
    /// method exists to fix.
    fn get_or_insert_with(&mut self, key: &str, make: impl FnOnce() -> T) -> &mut T {
        if !self.index.contains_key(key) {
            self.set(key.to_string(), make());
        }
        self.get_mut(key).expect("just inserted")
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn into_values(self) -> Vec<T> {
        self.values
    }
}

impl<T: Clone> OrderedMap<T> {
    fn entries(&self) -> Vec<(String, T)> {
        self.order
            .iter()
            .map(|key| (key.clone(), self.get(key).expect("key present").clone()))
            .collect()
    }
}

fn increment_rejected(map: &mut OrderedMap<f64>, key: &str) {
    let current = map.get(key).copied().unwrap_or(0.0);
    map.set(key.to_string(), current + 1.0);
}

fn merge_rejections(rejections: Vec<Vec<(String, f64)>>) -> Vec<(String, f64)> {
    let mut map = OrderedMap::<f64>::new();
    for rejected in rejections {
        for (key, count) in rejected {
            let current = map.get(&key).copied().unwrap_or(0.0);
            map.set(key, current + count);
        }
    }
    sort_rejected_entries(map.entries())
}

// ===========================================================================
// Exact grid primitives (`CELLS:251-269,1831-1919,2341-2365`).
// ===========================================================================

#[derive(Clone, Debug, PartialEq, Eq)]
struct GridPoint {
    x: BigInt,
    y: BigInt,
}

#[derive(Clone, Debug, PartialEq)]
struct Rational {
    numerator: BigInt,
    denominator: BigInt,
}

#[derive(Clone, Debug, PartialEq)]
struct RationalPoint {
    x: Rational,
    y: Rational,
}

#[derive(Clone, Debug, PartialEq)]
struct ForbiddenBoundary {
    points: Vec<GridPoint>,
    is_hole: Option<bool>,
}

fn grid_point(point: IrregularPoint) -> Option<GridPoint> {
    let x = to_grid_mm(point.x)?;
    let y = to_grid_mm(point.y)?;
    Some(GridPoint {
        x: f64_to_bigint(x),
        y: f64_to_bigint(y),
    })
}

fn from_grid_point(point: &GridPoint) -> IrregularPoint {
    IrregularPoint::new(
        from_grid(bigint_to_number(&point.x)),
        from_grid(bigint_to_number(&point.y)),
    )
}

fn compare_grid_points(first: &GridPoint, second: &GridPoint) -> Ordering {
    first.x.cmp(&second.x).then_with(|| first.y.cmp(&second.y))
}

fn cross_grid(first: &GridPoint, second: &GridPoint) -> BigInt {
    &first.x * &second.y - &first.y * &second.x
}

fn abs_bigint(value: &BigInt) -> BigInt {
    if *value < BigInt::from(0) {
        -value
    } else {
        value.clone()
    }
}

fn subtract_grid_points(first: &GridPoint, second: &GridPoint) -> GridPoint {
    GridPoint {
        x: &first.x - &second.x,
        y: &first.y - &second.y,
    }
}

fn dot_grid(first: &GridPoint, second: &GridPoint) -> BigInt {
    &first.x * &second.x + &first.y * &second.y
}

fn squared_grid_length(vector: &GridPoint) -> BigInt {
    &vector.x * &vector.x + &vector.y * &vector.y
}

fn is_canonical_positive_vector(vector: &GridPoint) -> bool {
    vector.y > BigInt::from(0) || (vector.y == BigInt::from(0) && vector.x > BigInt::from(0))
}

// ===========================================================================
// Exact rational arithmetic (`CELLS:1831-1897`).
// ===========================================================================

fn rational(value: BigInt) -> Rational {
    Rational {
        numerator: value,
        denominator: BigInt::from(1),
    }
}

fn greatest_common_divisor(first: &BigInt, second: &BigInt) -> BigInt {
    let mut a = first.clone();
    let mut b = second.clone();
    let zero = BigInt::from(0);
    while b != zero {
        let remainder = &a % &b;
        a = b;
        b = remainder;
    }
    if a == zero {
        BigInt::from(1)
    } else {
        a
    }
}

fn make_rational(numerator: &BigInt, denominator: &BigInt) -> Rational {
    let zero = BigInt::from(0);
    if *denominator == zero {
        return rational(zero);
    }
    let sign = if *denominator < zero {
        BigInt::from(-1)
    } else {
        BigInt::from(1)
    };
    let normalized_numerator = numerator * &sign;
    let normalized_denominator = denominator * &sign;
    let divisor =
        greatest_common_divisor(&abs_bigint(&normalized_numerator), &normalized_denominator);
    Rational {
        numerator: &normalized_numerator / &divisor,
        denominator: &normalized_denominator / &divisor,
    }
}

fn add_rational(first: &Rational, second: &Rational) -> Rational {
    make_rational(
        &(&first.numerator * &second.denominator + &second.numerator * &first.denominator),
        &(&first.denominator * &second.denominator),
    )
}

fn subtract_rational(first: &Rational, second: &Rational) -> Rational {
    make_rational(
        &(&first.numerator * &second.denominator - &second.numerator * &first.denominator),
        &(&first.denominator * &second.denominator),
    )
}

fn subtract_rational_points(first: &RationalPoint, second: &RationalPoint) -> RationalPoint {
    RationalPoint {
        x: subtract_rational(&first.x, &second.x),
        y: subtract_rational(&first.y, &second.y),
    }
}

fn serialize_rational_point(point: &RationalPoint) -> IntrinsicPeriodicRationalPoint {
    IntrinsicPeriodicRationalPoint {
        x: format!("{}/{}", point.x.numerator, point.x.denominator),
        y: format!("{}/{}", point.y.numerator, point.y.denominator),
    }
}

fn compare_rational(first: &Rational, second: &Rational) -> Ordering {
    (&first.numerator * &second.denominator).cmp(&(&second.numerator * &first.denominator))
}

fn round_rational(value: &Rational) -> BigInt {
    let quotient = &value.numerator / &value.denominator;
    let remainder = &value.numerator % &value.denominator;
    let zero = BigInt::from(0);
    if remainder == zero {
        return quotient;
    }
    let direction = if value.numerator < zero {
        BigInt::from(-1)
    } else {
        BigInt::from(1)
    };
    if abs_bigint(&remainder) * BigInt::from(2) >= value.denominator {
        quotient + direction
    } else {
        quotient
    }
}

fn canonical_grid_alternatives(value: &Rational) -> Vec<BigInt> {
    let quotient = &value.numerator / &value.denominator;
    let remainder = &value.numerator % &value.denominator;
    let zero = BigInt::from(0);
    let floor = if remainder < zero {
        &quotient - 1
    } else {
        quotient.clone()
    };
    let ceil = if remainder > zero {
        &quotient + 1
    } else {
        quotient.clone()
    };
    let rounded = round_rational(value);
    let mut unique: Vec<BigInt> = Vec::with_capacity(3);
    for candidate in [rounded, floor, ceil] {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique.sort();
    unique
}

fn rational_point_key(point: &RationalPoint) -> String {
    format!(
        "{}/{},{}/{}",
        point.x.numerator, point.x.denominator, point.y.numerator, point.y.denominator
    )
}

// ===========================================================================
// Source-control seams (`CELLS:1680-2243`), exported for parity tests.
// ===========================================================================

/// TS: `derivePeriodicAxisBasisControl` (`CELLS:1680-1689`).
pub fn derive_periodic_axis_basis_control(
    boundaries: &[Vec<(f64, f64)>],
    swap_axes: bool,
) -> Option<(IntrinsicPeriodicVector, IntrinsicPeriodicVector)> {
    let converted: Vec<ForbiddenBoundary> = boundaries
        .iter()
        .map(|points| ForbiddenBoundary {
            points: points
                .iter()
                .map(|&(x, y)| GridPoint {
                    x: f64_to_bigint(x),
                    y: f64_to_bigint(y),
                })
                .collect(),
            is_hole: None,
        })
        .collect();
    derive_axis_basis(&converted, swap_axes).map(|(first, second)| {
        (
            vector_from_grid(&from_grid_point(&first)),
            vector_from_grid(&from_grid_point(&second)),
        )
    })
}

/// TS: `derivePeriodicAxisBasisCandidatesControl` (`CELLS:1692-1703`).
pub fn derive_periodic_axis_basis_candidates_control(
    boundaries: &[Vec<(f64, f64)>],
    swap_axes: bool,
) -> Vec<(IntrinsicPeriodicVector, IntrinsicPeriodicVector)> {
    let converted: Vec<ForbiddenBoundary> = boundaries
        .iter()
        .map(|points| ForbiddenBoundary {
            points: points
                .iter()
                .map(|&(x, y)| GridPoint {
                    x: f64_to_bigint(x),
                    y: f64_to_bigint(y),
                })
                .collect(),
            is_hole: None,
        })
        .collect();
    derive_axis_basis_candidates(&converted, swap_axes)
        .into_iter()
        .map(|candidate| {
            (
                vector_from_grid(&from_grid_point(&candidate.basis.0)),
                vector_from_grid(&from_grid_point(&candidate.basis.1)),
            )
        })
        .collect()
}

fn vector_from_grid(point: &IrregularPoint) -> IntrinsicPeriodicVector {
    IntrinsicPeriodicVector {
        x: point.x,
        y: point.y,
    }
}

/// TS: `shiftOrderedPairForbiddenBoundaryControl` (`CELLS:1706-1714`).
pub fn shift_ordered_pair_forbidden_boundary_control(
    boundary: &[(f64, f64)],
    moving_base_point: (f64, f64),
) -> Vec<(f64, f64)> {
    boundary
        .iter()
        .map(|&(x, y)| (x - moving_base_point.0, y - moving_base_point.1))
        .collect()
}

fn shift_ordered_pair_forbidden_boundary(
    boundary: &[GridPoint],
    moving_base_point: &GridPoint,
) -> Vec<GridPoint> {
    boundary
        .iter()
        .map(|point| GridPoint {
            x: &point.x - &moving_base_point.x,
            y: &point.y - &moving_base_point.y,
        })
        .collect()
}

/// TS: `exactAxisIntersectionsControl` (`CELLS:1770-1783`).
pub fn exact_axis_intersections_control(
    boundary: &[(f64, f64)],
    axis_is_y: bool,
    value: f64,
) -> Vec<(String, String)> {
    let points: Vec<GridPoint> = boundary
        .iter()
        .map(|&(x, y)| GridPoint {
            x: f64_to_bigint(x),
            y: f64_to_bigint(y),
        })
        .collect();
    boundary_line_intersections(
        &[ForbiddenBoundary {
            points,
            is_hole: None,
        }],
        axis_is_y,
        &f64_to_bigint(value),
    )
    .iter()
    .map(|point| {
        (
            format!("{}/{}", point.x.numerator, point.x.denominator),
            format!("{}/{}", point.y.numerator, point.y.denominator),
        )
    })
    .collect()
}

/// TS: `canonicalPeriodicCellIdentityControl` (`CELLS:2204-2215`).
pub fn canonical_periodic_cell_identity_control(
    role: IntrinsicPeriodicRole,
    members: &[IntrinsicPeriodicBaseMember],
    v1: IntrinsicPeriodicVector,
    v2: IntrinsicPeriodicVector,
) -> Option<String> {
    let first = grid_point(IrregularPoint::new(v1.x, v1.y))?;
    let second = grid_point(IrregularPoint::new(v2.x, v2.y))?;
    Some(canonical_cell_key(role, members, &(first, second)))
}

/// TS: `periodicMemberDoubledAreaControl` (`CELLS:2241-2243`).
pub fn periodic_member_doubled_area_control(member: &IntrinsicPeriodicBaseMember) -> String {
    polygon_area_grid2(&member.geometry, member.point).to_string()
}

/// TS: `validatePeriodicContactLatticeControl` (`CELLS:2039-2050`).
pub fn validate_periodic_contact_lattice_control(
    members: &[IntrinsicPeriodicBaseMember],
    v1: IntrinsicPeriodicVector,
    v2: IntrinsicPeriodicVector,
) -> Result<bool, IrregularGeometryInputError> {
    let first = grid_point(IrregularPoint::new(v1.x, v1.y));
    let second = grid_point(IrregularPoint::new(v2.x, v2.y));
    let (first, second) = match (first, second) {
        (Some(first), Some(second)) => (first, second),
        _ => return Ok(false),
    };
    let diagnostic = diagnose_lattice(members, &(first, second))?;
    Ok(diagnostic.legal && diagnostic.centre_contact_complete)
}

/// TS: `farNeighborCertificate` (`CELLS:1922-1947`).
pub fn far_neighbor_certificate(
    members: &[IntrinsicPeriodicBaseMember],
    basis: (IntrinsicPeriodicVector, IntrinsicPeriodicVector),
) -> bool {
    let basis_grid = (
        grid_point(IrregularPoint::new(basis.0.x, basis.0.y)),
        grid_point(IrregularPoint::new(basis.1.x, basis.1.y)),
    );
    let (first, second) = match basis_grid {
        (Some(first), Some(second)) => (first, second),
        _ => return false,
    };
    far_neighbor_certificate_grid(members, &(first, second))
}

fn far_neighbor_certificate_grid(
    members: &[IntrinsicPeriodicBaseMember],
    basis: &(GridPoint, GridPoint),
) -> bool {
    let mut vertices: Vec<GridPoint> = Vec::new();
    for member in members {
        let translation = match grid_point(member.point) {
            Some(value) => value,
            None => continue,
        };
        for vertex in &member.geometry.polygon.points {
            if let Some(local) = grid_point(*vertex) {
                vertices.push(GridPoint {
                    x: &local.x + &translation.x,
                    y: &local.y + &translation.y,
                });
            }
        }
    }
    if vertices.is_empty() {
        return false;
    }
    let mut maximum_distance_squared = BigInt::from(0);
    for first in &vertices {
        for second in &vertices {
            let dx = &first.x - &second.x;
            let dy = &first.y - &second.y;
            let distance = &dx * &dx + &dy * &dy;
            if distance > maximum_distance_squared {
                maximum_distance_squared = distance;
            }
        }
    }
    let determinant = abs_bigint(&cross_grid(&basis.0, &basis.1));
    let f2 = &basis.0.x * &basis.0.x
        + &basis.0.y * &basis.0.y
        + &basis.1.x * &basis.1.x
        + &basis.1.y * &basis.1.y;
    &(&BigInt::from(4) * &determinant) * &determinant > &maximum_distance_squared * &f2
}

// ===========================================================================
// `enumerateIntrinsicPeriodicCells` (`CELLS:272-338`).
// ===========================================================================

pub fn enumerate_intrinsic_periodic_cells(
    pieces: &[IrregularPreparedPiece],
    options: &IntrinsicPeriodicCatalogOptions,
    ctx: &mut PeriodicRunContext<'_>,
) -> Result<IntrinsicPeriodicCatalog, IntrinsicPeriodicError> {
    let started_at = now_ms();
    let mut eligible_families: Vec<_> = group_intrinsic_collision_families(pieces)
        .into_iter()
        .filter(|family| family.members.len() >= 2)
        .collect();
    eligible_families.sort_by(|first, second| {
        diff_ord(second.members.len() as f64 - first.members.len() as f64)
            .then_with(|| {
                diff_ord(
                    second.members.len() as f64 * second.collision_area_mm2
                        - first.members.len() as f64 * first.collision_area_mm2,
                )
            })
            .then_with(|| locale_compare_keys(&first.key, &second.key))
    });
    let selected_count = options.maximum_family_count.min(eligible_families.len());
    let family_coverage_complete = selected_count == eligible_families.len();
    if selected_count == 0 {
        return Ok(IntrinsicPeriodicCatalog {
            family_coverage_complete,
            runtime_coverage_complete: true,
            families: Vec::new(),
            selected_family_key: None,
            unique_transform_count: 0.0,
            enumerated_pair_count: 0.0,
            cells: Vec::new(),
            rejected: Vec::new(),
        });
    }
    let mut families: Vec<IntrinsicPeriodicFamilyCatalog> = Vec::new();
    let mut global_cells = OrderedMap::<IntrinsicPeriodicCell>::new();
    for family in &eligible_families[..selected_count] {
        checkpoint(&mut ctx.control)?;
        if now_ms() - started_at >= options.maximum_runtime_ms {
            break;
        }
        let catalog = enumerate_intrinsic_periodic_family(family, started_at, options, ctx)?;
        for cell in &catalog.cells {
            global_cells.set(cell.canonical_key.clone(), cell.clone());
        }
        families.push(catalog);
    }
    let first = families.first();
    Ok(IntrinsicPeriodicCatalog {
        family_coverage_complete,
        runtime_coverage_complete: now_ms() - started_at < options.maximum_runtime_ms,
        selected_family_key: first.map(|family| family.family_key.clone()),
        unique_transform_count: first
            .map(|family| family.retained_transform_count)
            .unwrap_or(0.0),
        enumerated_pair_count: first
            .map(|family| family.enumerated_pair_count)
            .unwrap_or(0.0),
        cells: rank_intrinsic_periodic_cells(global_cells.into_values()),
        rejected: merge_rejections(
            families
                .iter()
                .map(|family| family.rejected.clone())
                .collect(),
        ),
        families,
    })
}

// ===========================================================================
// `enumerateIntrinsicPeriodicFamily` (`CELLS:366-535`).
// ===========================================================================

struct TransformedRepresentative {
    geometry: TransformedCollisionGeometry,
    transform: IrregularTransformCandidate,
}

impl Clone for TransformedRepresentative {
    fn clone(&self) -> Self {
        Self {
            geometry: self.geometry.clone(),
            transform: self.transform,
        }
    }
}

fn empty_intrinsic_periodic_family_catalog(
    family_key: String,
    member_count: f64,
    collision_area_mm2: f64,
    rejected: Vec<(String, f64)>,
) -> IntrinsicPeriodicFamilyCatalog {
    IntrinsicPeriodicFamilyCatalog {
        family_key,
        member_count,
        collision_area_mm2,
        unique_transform_count: 0.0,
        retained_transform_count: 0.0,
        transform_coverage_complete: true,
        transform_reservations: Vec::new(),
        enumerated_pair_count: 0.0,
        pair_coverage_complete: true,
        cell_coverage_complete: true,
        edge_contact_diagnostics: empty_edge_contact_diagnostics(),
        source_survival: Vec::new(),
        source_audit_cells: None,
        cells: Vec::new(),
        rejected,
        rejected_samples: Vec::new(),
    }
}

fn enumerate_intrinsic_periodic_family(
    family: &crate::search::strict_family::IntrinsicCollisionFamily,
    started_at: f64,
    options: &IntrinsicPeriodicCatalogOptions,
    ctx: &mut PeriodicRunContext<'_>,
) -> Result<IntrinsicPeriodicFamilyCatalog, IntrinsicPeriodicError> {
    let representative = match family.members.first() {
        Some(value) => value.clone(),
        None => {
            let rejected = vec![("missingRepresentative".to_string(), 1.0)];
            return Ok(empty_intrinsic_periodic_family_catalog(
                family.key.clone(),
                family.members.len() as f64,
                family.collision_area_mm2,
                rejected,
            ));
        }
    };
    // Hoisted once per family (not per candidate) -- see `IntrinsicPeriodicBaseMember`'s
    // own doc for why: the P1/P2 loops below construct many thousands of
    // `IntrinsicPeriodicBaseMember`s from these same two underlying pieces
    // for real production geometry, and an `Arc` clone here is O(1) instead
    // of a deep `IrregularPreparedPiece` clone.
    let representative_arc: Arc<IrregularPreparedPiece> = Arc::new(representative.clone());
    let second_member_arc: Arc<IrregularPreparedPiece> = family
        .members
        .get(1)
        .map(|member| Arc::new(member.clone()))
        .unwrap_or_else(|| Arc::clone(&representative_arc));

    let mut transformed_by_canonical_key = OrderedMap::<TransformedRepresentative>::new();
    let mut runtime_coverage_complete = true;
    let mut sorted_transforms = representative.transforms.clone();
    sorted_transforms.sort_by(transform_order);
    for transform in &sorted_transforms {
        checkpoint(&mut ctx.control)?;
        if now_ms() - started_at >= options.maximum_runtime_ms {
            runtime_coverage_complete = false;
            break;
        }
        let key_input = TransformCollisionGeometryKeyInput {
            geometry: &representative.collision_geometry,
            transform,
        };
        let geometry = resolve_transformed_collision_geometry(
            &key_input,
            &ctx.settings.geometry,
            ctx.geometry_cache,
            |computed| computed,
        )
        .map_err(|message| IrregularGeometryInputError {
            operation: "transformCollisionGeometry".to_string(),
            message,
        })?
        .value;
        let key = canonical_transformed_polygon_key(&geometry);
        transformed_by_canonical_key.set_if_absent(
            key,
            TransformedRepresentative {
                geometry,
                transform: *transform,
            },
        );
    }

    let all_transformed: Vec<TransformedRepresentative> = transformed_by_canonical_key
        .order
        .iter()
        .map(|key| {
            transformed_by_canonical_key
                .get(key)
                .expect("present")
                .clone()
        })
        .collect();
    let transformed = select_periodic_transform_representatives(
        &all_transformed,
        options.maximum_transforms_per_family,
    );
    let transform_coverage_complete =
        runtime_coverage_complete && transformed.len() == transformed_by_canonical_key.len();

    let mut rejected = OrderedMap::<f64>::new();
    let mut rejected_samples: Vec<IntrinsicPeriodicCellRejection> = Vec::new();
    let mut p1: Vec<IntrinsicPeriodicCell> = Vec::new();
    let mut p2: Vec<IntrinsicPeriodicCell> = Vec::new();
    let mut edge_contact_diagnostics = empty_edge_contact_diagnostics();

    for representative_transform in &transformed {
        checkpoint(&mut ctx.control)?;
        if now_ms() - started_at >= options.maximum_runtime_ms {
            runtime_coverage_complete = false;
            break;
        }
        let point = anchor_point(&representative_transform.geometry);
        let derivation = derive_cells(
            IntrinsicPeriodicRole::P1,
            &family.key,
            &[IntrinsicPeriodicBaseMember {
                piece: Arc::clone(&representative_arc),
                geometry: representative_transform.geometry.clone(),
                point,
            }],
            ctx,
        )?;
        if derivation.cells.is_empty() {
            increment_rejected(&mut rejected, "noP1Basis");
        }
        p1.extend(derivation.cells);
        edge_contact_diagnostics = merge_edge_contact_diagnostics(
            edge_contact_diagnostics,
            derivation.edge_contact_diagnostics,
        );
        for (key, count) in derivation.rejected {
            let current = rejected.get(&key).copied().unwrap_or(0.0);
            rejected.set(key, current + count);
        }
        append_rejected_samples(&mut rejected_samples, derivation.rejected_samples);
    }

    let mut enumerated_pair_count: f64 = 0.0;
    let mut pair_coverage_complete = true;
    'outer: for first_index in 0..transformed.len() {
        for second_index in (first_index + 1)..transformed.len() {
            checkpoint(&mut ctx.control)?;
            if enumerated_pair_count as usize >= options.maximum_pairs_per_family {
                pair_coverage_complete = false;
                break;
            }
            if now_ms() - started_at >= options.maximum_runtime_ms {
                runtime_coverage_complete = false;
                pair_coverage_complete = false;
                break;
            }
            enumerated_pair_count += 1.0;
            let first = &transformed[first_index].geometry;
            let second = &transformed[second_index].geometry;
            let first_point = anchor_point(first);
            let fixed = make_placed(&representative, first, first_point);
            let pair_nfp = compute_nfp(
                &ComputeNfpInput {
                    fixed: &fixed,
                    moving: second,
                    settings: &ctx.settings.geometry,
                },
                ctx.geometry_cache,
                DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
            )?;
            let offsets = boundary_candidate_points(&pair_nfp.boundary.points, second);
            for point in offsets {
                checkpoint(&mut ctx.control)?;
                if now_ms() - started_at >= options.maximum_runtime_ms {
                    runtime_coverage_complete = false;
                    pair_coverage_complete = false;
                    break;
                }
                let candidate = make_candidate(second, point);
                let legal = check_sheetless(std::slice::from_ref(&fixed), second, point)?;
                if !legal || !combined_bounds_nonnegative(&[first, second], &[first_point, point]) {
                    let _ = &candidate;
                    continue;
                }
                let derivation = derive_cells(
                    IntrinsicPeriodicRole::P2,
                    &family.key,
                    &[
                        IntrinsicPeriodicBaseMember {
                            piece: Arc::clone(&representative_arc),
                            geometry: first.clone(),
                            point: first_point,
                        },
                        IntrinsicPeriodicBaseMember {
                            piece: Arc::clone(&second_member_arc),
                            geometry: second.clone(),
                            point,
                        },
                    ],
                    ctx,
                )?;
                if derivation.cells.is_empty() {
                    increment_rejected(&mut rejected, "noP2Basis");
                }
                p2.extend(derivation.cells);
                edge_contact_diagnostics = merge_edge_contact_diagnostics(
                    edge_contact_diagnostics,
                    derivation.edge_contact_diagnostics,
                );
                for (key, count) in derivation.rejected {
                    let current = rejected.get(&key).copied().unwrap_or(0.0);
                    rejected.set(key, current + count);
                }
                append_rejected_samples(&mut rejected_samples, derivation.rejected_samples);
            }
        }
        if !pair_coverage_complete {
            break 'outer;
        }
    }

    let p1_front = periodic_cell_front(p1.clone(), options.maximum_cells_per_family_role);
    let p2_front = periodic_cell_front(p2.clone(), options.maximum_cells_per_family_role);
    let mut cells = p1_front.cells.clone();
    cells.extend(p2_front.cells.clone());
    let source_audit_cells = if options.capture_source_survival_audit {
        let mut all_cells = p1;
        all_cells.extend(p2);
        Some(rank_intrinsic_periodic_cells(all_cells))
    } else {
        None
    };
    if !p1_front.coverage_complete {
        rejected.set("p1FrontierTruncated".to_string(), 1.0);
    }
    if !p2_front.coverage_complete {
        rejected.set("p2FrontierTruncated".to_string(), 1.0);
    }

    Ok(IntrinsicPeriodicFamilyCatalog {
        family_key: family.key.clone(),
        member_count: family.members.len() as f64,
        collision_area_mm2: family.collision_area_mm2,
        unique_transform_count: transformed_by_canonical_key.len() as f64,
        retained_transform_count: transformed.len() as f64,
        transform_coverage_complete,
        transform_reservations: measure_transform_reservations(&all_transformed, &transformed),
        enumerated_pair_count,
        pair_coverage_complete,
        edge_contact_diagnostics,
        cell_coverage_complete: runtime_coverage_complete
            && pair_coverage_complete
            && p1_front.coverage_complete
            && p2_front.coverage_complete,
        source_survival: summarize_periodic_cell_source_survival(
            &p1_front.pre_front,
            &p1_front.cells,
            &p2_front.pre_front,
            &p2_front.cells,
        ),
        source_audit_cells,
        cells: rank_intrinsic_periodic_cells(cells),
        rejected: sort_rejected_entries(rejected.entries()),
        rejected_samples,
    })
}

fn summarize_periodic_cell_source_survival(
    p1_before: &[IntrinsicPeriodicCell],
    p1_after: &[IntrinsicPeriodicCell],
    p2_before: &[IntrinsicPeriodicCell],
    p2_after: &[IntrinsicPeriodicCell],
) -> Vec<IntrinsicPeriodicSourceCellSurvival> {
    let mut counts = OrderedMap::<IntrinsicPeriodicSourceCellSurvival>::new();
    let count = |cells: &[IntrinsicPeriodicCell],
                 retained: bool,
                 counts: &mut OrderedMap<IntrinsicPeriodicSourceCellSurvival>| {
        for cell in cells {
            let provenance = match &cell.basis_provenance {
                Some(value) => value,
                None => continue,
            };
            let key = format!("{}:{}", cell.role.as_str(), provenance.source_key);
            let mut current =
                counts
                    .get(&key)
                    .cloned()
                    .unwrap_or(IntrinsicPeriodicSourceCellSurvival {
                        role: cell.role,
                        source_key: provenance.source_key.clone(),
                        source_kind: provenance.source_kind,
                        cells_before_front: 0.0,
                        cells_retained: 0.0,
                    });
            if retained {
                current.cells_retained += 1.0;
            } else {
                current.cells_before_front += 1.0;
            }
            counts.set(key, current);
        }
    };
    count(p1_before, false, &mut counts);
    count(p2_before, false, &mut counts);
    count(p1_after, true, &mut counts);
    count(p2_after, true, &mut counts);
    let mut result = counts.into_values();
    result.sort_by(|first, second| {
        locale_compare_keys(first.role.as_str(), second.role.as_str())
            .then_with(|| locale_compare_keys(&first.source_key, &second.source_key))
    });
    result
}

fn select_periodic_transform_representatives(
    transformed: &[TransformedRepresentative],
    maximum_transforms: usize,
) -> Vec<TransformedRepresentative> {
    let mut ordered: Vec<&TransformedRepresentative> = transformed.iter().collect();
    ordered.sort_by(|first, second| transform_order(&first.transform, &second.transform));
    let mut reserved = OrderedMap::<usize>::new();
    for (index, candidate) in ordered.iter().enumerate() {
        let key = periodic_transform_reservation_key(&candidate.transform);
        reserved.set_if_absent(key, index);
    }
    let mut result_indices: Vec<usize> = reserved.into_values();
    for (index, candidate) in ordered.iter().enumerate() {
        if result_indices.len() >= maximum_transforms {
            break;
        }
        let _ = candidate;
        if !result_indices.contains(&index) {
            result_indices.push(index);
        }
    }
    result_indices.truncate(maximum_transforms);
    result_indices
        .into_iter()
        .map(|index| ordered[index].clone())
        .collect()
}

fn periodic_transform_reservation_key(transform: &IrregularTransformCandidate) -> String {
    let normalized = ((transform.rotation_deg % 360.0) + 360.0) % 360.0;
    let rotation_family = if matches!(
        transform.reason,
        crate::domain::IrregularTransformReason::Orthogonal
    ) {
        format!(
            "q{}",
            (js_math::round(normalized / 90.0) as i64).rem_euclid(4)
        )
    } else {
        transform_reason_str(transform.reason).to_string()
    };
    format!(
        "{}:{}",
        if transform.mirrored {
            "mirror"
        } else {
            "direct"
        },
        rotation_family
    )
}

fn transform_reason_str(reason: crate::domain::IrregularTransformReason) -> &'static str {
    match reason {
        crate::domain::IrregularTransformReason::Orthogonal => "orthogonal",
        crate::domain::IrregularTransformReason::EdgeAlignment => "edge_alignment",
        crate::domain::IrregularTransformReason::Configured => "configured",
    }
}

fn measure_transform_reservations(
    all: &[TransformedRepresentative],
    retained: &[TransformedRepresentative],
) -> Vec<IntrinsicPeriodicTransformReservation> {
    let mut counts = OrderedMap::<(f64, f64)>::new();
    for candidate in all {
        let key = periodic_transform_reservation_key(&candidate.transform);
        let value = counts.get(&key).copied().unwrap_or((0.0, 0.0));
        counts.set(key, (value.0 + 1.0, value.1));
    }
    for candidate in retained {
        let key = periodic_transform_reservation_key(&candidate.transform);
        let value = counts.get(&key).copied().unwrap_or((0.0, 0.0));
        counts.set(key, (value.0, value.1 + 1.0));
    }
    let mut result: Vec<IntrinsicPeriodicTransformReservation> = counts
        .entries()
        .into_iter()
        .map(
            |(key, (available, retained))| IntrinsicPeriodicTransformReservation {
                key,
                available_count: available,
                retained_count: retained,
            },
        )
        .collect();
    result.sort_by(|first, second| locale_compare_keys(&first.key, &second.key));
    result
}

struct PeriodicCellFrontResult {
    cells: Vec<IntrinsicPeriodicCell>,
    pre_front: Vec<IntrinsicPeriodicCell>,
    coverage_complete: bool,
}

fn periodic_cell_front(
    cells: Vec<IntrinsicPeriodicCell>,
    maximum_cells: usize,
) -> PeriodicCellFrontResult {
    let pre_front = cells.clone();
    let mut unique = OrderedMap::<IntrinsicPeriodicCell>::new();
    for cell in cells {
        unique.set(cell.canonical_key.clone(), cell);
    }
    let mut by_source_kind = OrderedMap::<Vec<IntrinsicPeriodicCell>>::new();
    for cell in unique.into_values() {
        let source_kind = cell
            .basis_provenance
            .as_ref()
            .map(|provenance| provenance.source_kind.as_str())
            .unwrap_or("legacy")
            .to_string();
        by_source_kind
            .get_or_insert_with(&source_kind, Vec::new)
            .push(cell);
    }
    let mut retained: Vec<(String, IntrinsicPeriodicCell)> = Vec::new();
    let mut coverage_complete = true;
    for (source_kind, group) in by_source_kind.entries() {
        if group.len() > maximum_cells {
            coverage_complete = false;
        }
        let ranked = rank_intrinsic_periodic_cells(group);
        for cell in ranked.into_iter().take(maximum_cells) {
            retained.push((source_kind.clone(), cell));
        }
    }
    retained.sort_by(|(first_kind, first_cell), (second_kind, second_cell)| {
        locale_compare_keys(first_kind, second_kind)
            .then_with(|| compare_cells(first_cell, second_cell))
    });
    PeriodicCellFrontResult {
        cells: retained.into_iter().map(|(_, cell)| cell).collect(),
        pre_front,
        coverage_complete,
    }
}

// ===========================================================================
// `expandIntrinsicPeriodicCell` / `enumerateIntrinsicPeriodicCellCrops`
// (`CELLS:692-831`).
// ===========================================================================

/// TS: `expandIntrinsicPeriodicCell` (`CELLS:693-704`). Not called in
/// production (§2 of the characterization doc); ported for public-API parity.
pub fn expand_intrinsic_periodic_cell(
    cell: &IntrinsicPeriodicCell,
    family_members: &[IrregularPreparedPiece],
    maximum_crops: usize,
    control: &mut Option<&mut dyn NfpIfpControl>,
) -> Result<Vec<IntrinsicPeriodicSeed>, IntrinsicPeriodicError> {
    let candidates =
        enumerate_intrinsic_periodic_cell_crops(cell, family_members, &mut || {}, control)?;
    Ok(select_intrinsic_periodic_seed_front(
        candidates,
        maximum_crops,
    ))
}

struct CropCoordinate {
    row: i64,
    column: i64,
}

fn crop_coordinates(
    rows: i64,
    columns: i64,
    count: i64,
    traversal: IntrinsicPeriodicCropTraversal,
    corner: u8,
) -> Vec<CropCoordinate> {
    let mut coordinates: Vec<CropCoordinate> = Vec::new();
    for row in 0..rows {
        for column in 0..columns {
            coordinates.push(CropCoordinate { row, column });
        }
    }
    coordinates.sort_by(|first, second| match traversal {
        IntrinsicPeriodicCropTraversal::Row => diff_ord((first.row - second.row) as f64)
            .then_with(|| diff_ord((first.column - second.column) as f64)),
        IntrinsicPeriodicCropTraversal::Column => diff_ord((first.column - second.column) as f64)
            .then_with(|| diff_ord((first.row - second.row) as f64)),
    });
    coordinates
        .into_iter()
        .take(count.max(0) as usize)
        .map(|coordinate| CropCoordinate {
            row: if corner == 1 || corner == 2 {
                rows - 1 - coordinate.row
            } else {
                coordinate.row
            },
            column: if corner == 2 || corner == 3 {
                columns - 1 - coordinate.column
            } else {
                coordinate.column
            },
        })
        .collect()
}

/// TS: `enumerateIntrinsicPeriodicCellCrops` (`CELLS:707-809`).
pub fn enumerate_intrinsic_periodic_cell_crops(
    cell: &IntrinsicPeriodicCell,
    family_members: &[IrregularPreparedPiece],
    on_crop_attempt: &mut dyn FnMut(),
    control: &mut Option<&mut dyn NfpIfpControl>,
) -> Result<Vec<IntrinsicPeriodicSeed>, IntrinsicPeriodicError> {
    checkpoint(control)?;
    let v1 = match grid_point(IrregularPoint::new(cell.v1.x, cell.v1.y)) {
        Some(value) => value,
        None => return Ok(Vec::new()),
    };
    let v2 = match grid_point(IrregularPoint::new(cell.v2.x, cell.v2.y)) {
        Some(value) => value,
        None => return Ok(Vec::new()),
    };
    let member_count = cell.members.len();
    if member_count == 0 {
        return Ok(Vec::new());
    }
    let q = (family_members.len() / member_count) as i64;
    if q < 1 {
        return Ok(Vec::new());
    }
    let mut candidates: Vec<IntrinsicPeriodicSeed> = Vec::new();
    let mut identities: std::collections::HashSet<String> = std::collections::HashSet::new();
    for rows in 1..=q {
        checkpoint(control)?;
        let columns = (q + rows - 1) / rows;
        for traversal in [
            IntrinsicPeriodicCropTraversal::Row,
            IntrinsicPeriodicCropTraversal::Column,
        ] {
            for corner in 0..4u8 {
                checkpoint(control)?;
                on_crop_attempt();
                let coordinates = crop_coordinates(rows, columns, q, traversal, corner);
                let mut placed: Vec<IrregularPlacedPiece> = Vec::new();
                let mut source_index: usize = 0;
                let mut legal = true;
                'coord: for coordinate in &coordinates {
                    checkpoint(control)?;
                    for base in &cell.members {
                        let piece = match family_members.get(source_index) {
                            Some(value) => value,
                            None => break,
                        };
                        let base_point = match grid_point(base.point) {
                            Some(value) => value,
                            None => {
                                legal = false;
                                break;
                            }
                        };
                        let point = from_grid_point(&GridPoint {
                            x: &base_point.x
                                + &(BigInt::from(coordinate.row) * &v1.x)
                                + &(BigInt::from(coordinate.column) * &v2.x),
                            y: &base_point.y
                                + &(BigInt::from(coordinate.row) * &v1.y)
                                + &(BigInt::from(coordinate.column) * &v2.y),
                        });
                        let actual_geometry = geometry_for_piece(&base.geometry, piece);
                        if !check_sheetless(&placed, &actual_geometry, point)? {
                            legal = false;
                            break;
                        }
                        placed.push(make_placed(piece, &actual_geometry, point));
                        source_index += 1;
                    }
                    if !legal || source_index >= (q as usize) * member_count {
                        break 'coord;
                    }
                }
                if !legal || placed.len() != (q as usize) * member_count {
                    continue;
                }
                let normalized = normalize_placed_bottom_left(&placed);
                let identity = canonical_collision_layout_identity(&normalized);
                let topology = measure_canonical_layout_topology(&normalized);
                let envelope = measure_canonical_layout_envelope(&normalized);
                let bounds = placed_bounds(&normalized);
                let (identity, topology, envelope, bounds) =
                    match (identity, topology, envelope, bounds) {
                        (Some(identity), Some(topology), Some(envelope), Some(bounds)) => {
                            (identity, topology, envelope, bounds)
                        }
                        _ => continue,
                    };
                if identities.contains(&identity) {
                    continue;
                }
                identities.insert(identity.clone());
                candidates.push(IntrinsicPeriodicSeed {
                    role: cell.role,
                    cell_key: cell.canonical_key.clone(),
                    placements: normalized,
                    remaining_family_members: family_members
                        [((q as usize) * member_count).min(family_members.len())..]
                        .to_vec(),
                    component_count: topology.positive_contact_component_count,
                    isolated_piece_count: topology.isolated_piece_count,
                    largest_component_size: topology.largest_positive_contact_component_size,
                    maximum_side_mm: js_math::max(bounds.width, bounds.height),
                    envelope_area_mm2: bounds.width * bounds.height,
                    envelope_span_mm: bounds.width + bounds.height,
                    exact_envelope: Some(IntrinsicPeriodicExactEnvelope {
                        maximum_side_grid: envelope.maximum_side_grid,
                        area_grid2: envelope.envelope_area_grid2,
                        span_grid: envelope.span_grid,
                    }),
                    crop: IntrinsicPeriodicCropProvenance {
                        rows: rows as f64,
                        columns: columns as f64,
                        traversal,
                        corner,
                    },
                    canonical_key: identity,
                });
            }
        }
    }
    Ok(candidates)
}

struct PlacedBounds {
    min_x: f64,
    min_y: f64,
    width: f64,
    height: f64,
}

fn placed_bounds(placed: &[IrregularPlacedPiece]) -> Option<PlacedBounds> {
    let points: Vec<IrregularPoint> = placed
        .iter()
        .flat_map(|entry| {
            entry
                .collision_geometry
                .polygon
                .points
                .iter()
                .map(move |point| {
                    IrregularPoint::new(
                        point.x + entry.placement.transform.translate_x,
                        point.y + entry.placement.transform.translate_y,
                    )
                })
        })
        .collect();
    let bounds = bounds_for_points(&points)?;
    Some(PlacedBounds {
        min_x: bounds.min_x,
        min_y: bounds.min_y,
        width: bounds.max_x - bounds.min_x,
        height: bounds.max_y - bounds.min_y,
    })
}

fn normalize_placed_bottom_left(placed: &[IrregularPlacedPiece]) -> Vec<IrregularPlacedPiece> {
    let bounds = match placed_bounds(placed) {
        Some(value) => value,
        None => return Vec::new(),
    };
    placed
        .iter()
        .map(|entry| IrregularPlacedPiece {
            placement: IrregularPlacement {
                transform: IrregularTransform {
                    translate_x: entry.placement.transform.translate_x - bounds.min_x,
                    translate_y: entry.placement.transform.translate_y - bounds.min_y,
                    ..entry.placement.transform
                },
                ..entry.placement.clone()
            },
            collision_geometry: entry.collision_geometry.clone(),
        })
        .collect()
}

// ===========================================================================
// Seed comparators and Pareto selection (`CELLS:833-976`).
// ===========================================================================

fn compare_seeds(first: &IntrinsicPeriodicSeed, second: &IntrinsicPeriodicSeed) -> Ordering {
    diff_ord(first.component_count - second.component_count)
        .then_with(|| diff_ord(first.isolated_piece_count - second.isolated_piece_count))
        .then_with(|| diff_ord(second.largest_component_size - first.largest_component_size))
        .then_with(|| compare_intrinsic_periodic_seed_envelope(first, second))
        .then_with(|| locale_compare_keys(&first.canonical_key, &second.canonical_key))
}

fn exact_envelope_for_seed(seed: &IntrinsicPeriodicSeed) -> Option<IntrinsicPeriodicExactEnvelope> {
    if let Some(envelope) = &seed.exact_envelope {
        return Some(envelope.clone());
    }
    let envelope = measure_canonical_layout_envelope(&seed.placements)?;
    Some(IntrinsicPeriodicExactEnvelope {
        maximum_side_grid: envelope.maximum_side_grid,
        area_grid2: envelope.envelope_area_grid2,
        span_grid: envelope.span_grid,
    })
}

fn parse_area_bigint(value: &str) -> BigInt {
    value.parse::<BigInt>().unwrap_or_else(|_| BigInt::from(0))
}

/// TS: `compareIntrinsicPeriodicSeedEnvelope` (`CELLS:864-884`).
pub fn compare_intrinsic_periodic_seed_envelope(
    first: &IntrinsicPeriodicSeed,
    second: &IntrinsicPeriodicSeed,
) -> Ordering {
    let first_envelope = exact_envelope_for_seed(first);
    let second_envelope = exact_envelope_for_seed(second);
    match (first_envelope, second_envelope) {
        (None, None) => diff_ord(first.maximum_side_mm - second.maximum_side_mm)
            .then_with(|| diff_ord(first.envelope_area_mm2 - second.envelope_area_mm2))
            .then_with(|| diff_ord(first.envelope_span_mm - second.envelope_span_mm)),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(first_envelope), Some(second_envelope)) => {
            diff_ord(first_envelope.maximum_side_grid - second_envelope.maximum_side_grid)
                .then_with(|| {
                    parse_area_bigint(&first_envelope.area_grid2)
                        .cmp(&parse_area_bigint(&second_envelope.area_grid2))
                })
                .then_with(|| diff_ord(first_envelope.span_grid - second_envelope.span_grid))
        }
    }
}

/// TS: `compareIntrinsicPeriodicSeedEnvelopeAreaFirst` (`CELLS:887-907`).
pub fn compare_intrinsic_periodic_seed_envelope_area_first(
    first: &IntrinsicPeriodicSeed,
    second: &IntrinsicPeriodicSeed,
) -> Ordering {
    let first_envelope = exact_envelope_for_seed(first);
    let second_envelope = exact_envelope_for_seed(second);
    match (first_envelope, second_envelope) {
        (None, None) => diff_ord(first.envelope_area_mm2 - second.envelope_area_mm2)
            .then_with(|| diff_ord(first.maximum_side_mm - second.maximum_side_mm))
            .then_with(|| diff_ord(first.envelope_span_mm - second.envelope_span_mm)),
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(first_envelope), Some(second_envelope)) => {
            parse_area_bigint(&first_envelope.area_grid2)
                .cmp(&parse_area_bigint(&second_envelope.area_grid2))
                .then_with(|| {
                    diff_ord(first_envelope.maximum_side_grid - second_envelope.maximum_side_grid)
                })
                .then_with(|| diff_ord(first_envelope.span_grid - second_envelope.span_grid))
        }
    }
}

/// TS: `rankIntrinsicPeriodicSeeds` (`CELLS:910-914`).
pub fn rank_intrinsic_periodic_seeds(
    mut seeds: Vec<IntrinsicPeriodicSeed>,
) -> Vec<IntrinsicPeriodicSeed> {
    seeds.sort_by(compare_seeds);
    seeds
}

/// TS: `selectIntrinsicPeriodicSeedFront` (`CELLS:917-922`).
pub fn select_intrinsic_periodic_seed_front(
    seeds: Vec<IntrinsicPeriodicSeed>,
    maximum_crops: usize,
) -> Vec<IntrinsicPeriodicSeed> {
    let mut ranked = rank_intrinsic_periodic_seeds(non_dominated_intrinsic_periodic_seeds(seeds));
    ranked.truncate(maximum_crops);
    ranked
}

/// TS: `nonDominatedIntrinsicPeriodicSeeds` (`CELLS:925-931`).
pub fn non_dominated_intrinsic_periodic_seeds(
    seeds: Vec<IntrinsicPeriodicSeed>,
) -> Vec<IntrinsicPeriodicSeed> {
    seeds
        .iter()
        .enumerate()
        .filter(|(index, candidate)| {
            !seeds.iter().enumerate().any(|(other_index, other)| {
                other_index != *index && periodic_seed_dominates(other, candidate)
            })
        })
        .map(|(_, candidate)| candidate.clone())
        .collect()
}

fn periodic_seed_dominates(first: &IntrinsicPeriodicSeed, second: &IntrinsicPeriodicSeed) -> bool {
    let first_envelope = exact_envelope_for_seed(first);
    let second_envelope = exact_envelope_for_seed(second);
    match (first_envelope, second_envelope) {
        (None, None) => {
            let no_worse = first.component_count <= second.component_count
                && first.isolated_piece_count <= second.isolated_piece_count
                && first.largest_component_size >= second.largest_component_size
                && first.maximum_side_mm <= second.maximum_side_mm
                && first.envelope_area_mm2 <= second.envelope_area_mm2
                && first.envelope_span_mm <= second.envelope_span_mm;
            let strict = first.component_count < second.component_count
                || first.isolated_piece_count < second.isolated_piece_count
                || first.largest_component_size > second.largest_component_size
                || first.maximum_side_mm < second.maximum_side_mm
                || first.envelope_area_mm2 < second.envelope_area_mm2
                || first.envelope_span_mm < second.envelope_span_mm;
            no_worse && strict
        }
        (None, Some(_)) | (Some(_), None) => false,
        (Some(first_envelope), Some(second_envelope)) => {
            let maximum_side_comparison =
                first_envelope.maximum_side_grid - second_envelope.maximum_side_grid;
            let area_comparison = parse_area_bigint(&first_envelope.area_grid2)
                .cmp(&parse_area_bigint(&second_envelope.area_grid2));
            let span_comparison = first_envelope.span_grid - second_envelope.span_grid;
            let no_worse = first.component_count <= second.component_count
                && first.isolated_piece_count <= second.isolated_piece_count
                && first.largest_component_size >= second.largest_component_size
                && maximum_side_comparison <= 0.0
                && area_comparison != Ordering::Greater
                && span_comparison <= 0.0;
            let strict = first.component_count < second.component_count
                || first.isolated_piece_count < second.isolated_piece_count
                || first.largest_component_size > second.largest_component_size
                || maximum_side_comparison < 0.0
                || area_comparison == Ordering::Less
                || span_comparison < 0.0;
            no_worse && strict
        }
    }
}

// ===========================================================================
// `deriveCells` (`CELLS:1021-1148`).
// ===========================================================================

struct IntrinsicPeriodicCellDerivation {
    cells: Vec<IntrinsicPeriodicCell>,
    edge_contact_diagnostics: IntrinsicPeriodicEdgeContactDiagnostics,
    rejected: Vec<(String, f64)>,
    rejected_samples: Vec<IntrinsicPeriodicCellRejection>,
}

fn append_rejected_samples(
    target: &mut Vec<IntrinsicPeriodicCellRejection>,
    incoming: Vec<IntrinsicPeriodicCellRejection>,
) {
    for sample in incoming {
        if target.len() >= 32 {
            return;
        }
        let duplicate = target.iter().any(|existing| {
            existing.role == sample.role
                && existing.stage == sample.stage
                && existing.v1.map(|v| (v.x, v.y)) == sample.v1.map(|v| (v.x, v.y))
                && existing.v2.map(|v| (v.x, v.y)) == sample.v2.map(|v| (v.x, v.y))
        });
        if !duplicate {
            target.push(sample);
        }
    }
}

struct IntrinsicPeriodicBasisCandidate {
    basis: (GridPoint, GridPoint),
    source_key: String,
    source_kind: IntrinsicPeriodicBasisSourceKind,
    source_points: (RationalPoint, RationalPoint),
    axis: Option<IntrinsicPeriodicAxis>,
    selected_residual_grid: (RationalPoint, RationalPoint),
    contact_relations: Option<(
        IntrinsicPeriodicEdgeContactProvenance,
        IntrinsicPeriodicEdgeContactProvenance,
    )>,
}

fn derive_cells(
    role: IntrinsicPeriodicRole,
    family_key: &str,
    members: &[IntrinsicPeriodicBaseMember],
    ctx: &mut PeriodicRunContext<'_>,
) -> Result<IntrinsicPeriodicCellDerivation, IntrinsicPeriodicError> {
    let mut forbidden: Vec<ForbiddenBoundary> = Vec::new();
    for fixed_member in members {
        for moving_member in members {
            checkpoint(&mut ctx.control)?;
            let fixed_placed = make_placed(
                &fixed_member.piece,
                &fixed_member.geometry,
                fixed_member.point,
            );
            let boundary = compute_nfp(
                &ComputeNfpInput {
                    fixed: &fixed_placed,
                    moving: &moving_member.geometry,
                    settings: &ctx.settings.geometry,
                },
                ctx.geometry_cache,
                DEFAULT_NFP_CONSTRUCTION_ALGORITHM,
            )?;
            let moving_grid = match grid_point(moving_member.point) {
                Some(value) => value,
                None => {
                    return Ok(IntrinsicPeriodicCellDerivation {
                        cells: Vec::new(),
                        edge_contact_diagnostics: empty_edge_contact_diagnostics(),
                        rejected: vec![("invalidMovingGrid".to_string(), 1.0)],
                        rejected_samples: Vec::new(),
                    })
                }
            };
            let converted: Vec<Option<GridPoint>> = boundary
                .boundary
                .points
                .iter()
                .map(|point| grid_point(*point))
                .collect();
            if converted.iter().any(|point| point.is_none()) {
                return Ok(IntrinsicPeriodicCellDerivation {
                    cells: Vec::new(),
                    edge_contact_diagnostics: empty_edge_contact_diagnostics(),
                    rejected: vec![("invalidForbiddenGrid".to_string(), 1.0)],
                    rejected_samples: Vec::new(),
                });
            }
            let points: Vec<GridPoint> = converted.into_iter().flatten().collect();
            let shifted_points = shift_ordered_pair_forbidden_boundary(&points, &moving_grid);
            forbidden.push(ForbiddenBoundary {
                points: shifted_points,
                is_hole: None,
            });
        }
    }

    let contact = derive_edge_contact_basis_candidates(members)?;
    let mut bases: Vec<IntrinsicPeriodicBasisCandidate> = Vec::new();
    bases.extend(derive_axis_basis_candidates(&forbidden, false));
    bases.extend(derive_axis_basis_candidates(&forbidden, true));
    bases.extend(derive_nfp_boundary_vertex_basis_candidates(
        &forbidden,
        MAXIMUM_NFP_BOUNDARY_VERTEX_BASIS_CANDIDATES,
    ));
    bases.extend(contact.candidates);

    let mut result: Vec<IntrinsicPeriodicCell> = Vec::new();
    let mut rejected = OrderedMap::<f64>::new();
    let mut rejected_samples: Vec<IntrinsicPeriodicCellRejection> = Vec::new();
    let reject = |rejected: &mut OrderedMap<f64>,
                  rejected_samples: &mut Vec<IntrinsicPeriodicCellRejection>,
                  stage: IntrinsicPeriodicCellRejectionStage,
                  basis: Option<&(GridPoint, GridPoint)>| {
        let key = match stage {
            IntrinsicPeriodicCellRejectionStage::AxisBasisUnavailable => "axisBasisUnavailable",
            IntrinsicPeriodicCellRejectionStage::DegenerateBasis => "degenerateBasis",
            IntrinsicPeriodicCellRejectionStage::FarNeighborRejected => "farNeighborRejected",
            IntrinsicPeriodicCellRejectionStage::ThreeByThreeLatticeRejected => {
                "threeByThreeLatticeRejected"
            }
            IntrinsicPeriodicCellRejectionStage::BaseShapeRejected => "baseShapeRejected",
        };
        increment_rejected(rejected, key);
        if rejected_samples.len() >= 8 {
            return;
        }
        rejected_samples.push(IntrinsicPeriodicCellRejection {
            role,
            stage,
            v1: basis.map(|(first, _)| vector_from_grid(&from_grid_point(first))),
            v2: basis.map(|(_, second)| vector_from_grid(&from_grid_point(second))),
            determinant_grid2: basis
                .map(|(first, second)| abs_bigint(&cross_grid(first, second)).to_string()),
        });
    };
    if bases.is_empty() {
        reject(
            &mut rejected,
            &mut rejected_samples,
            IntrinsicPeriodicCellRejectionStage::AxisBasisUnavailable,
            None,
        );
    }
    for candidate in bases {
        let (raw_v1, raw_v2) = (candidate.basis.0.clone(), candidate.basis.1.clone());
        let canonical = match canonicalize_basis(&raw_v1, &raw_v2) {
            Some(value) => value,
            None => {
                reject(
                    &mut rejected,
                    &mut rejected_samples,
                    IntrinsicPeriodicCellRejectionStage::DegenerateBasis,
                    Some(&(raw_v1, raw_v2)),
                );
                continue;
            }
        };
        let infinite_far_proof = far_neighbor_certificate_grid(members, &canonical);
        let lattice = diagnose_lattice(members, &canonical)?;
        let determinant_grid2 = abs_bigint(&cross_grid(&canonical.0, &canonical.1));
        let member_doubled_area_grid2 = members.iter().fold(BigInt::from(0), |sum, member| {
            sum + polygon_area_grid2(&member.geometry, member.point)
        });
        let shape = match measure_base_cell_shape(members) {
            Some(value) => value,
            None => {
                reject(
                    &mut rejected,
                    &mut rejected_samples,
                    IntrinsicPeriodicCellRejectionStage::BaseShapeRejected,
                    Some(&canonical),
                );
                continue;
            }
        };
        let canonical_key = canonical_cell_key(role, members, &canonical);
        result.push(IntrinsicPeriodicCell {
            role,
            family_key: family_key.to_string(),
            members: members.to_vec(),
            v1: vector_from_grid(&from_grid_point(&canonical.0)),
            v2: vector_from_grid(&from_grid_point(&canonical.1)),
            determinant_grid2: determinant_grid2.to_string(),
            member_doubled_area_grid2: member_doubled_area_grid2.to_string(),
            density: bigint_to_number(&member_doubled_area_grid2)
                / (2.0 * bigint_to_number(&determinant_grid2)),
            envelope_maximum_side_mm: shape.0,
            hull_waste_ratio: shape.1,
            shared_boundary_length_mm: lattice.shared_boundary_length_mm,
            infinite_far_proof,
            three_by_three_lattice_legal: lattice.legal,
            three_by_three_centre_contact_complete: lattice.centre_contact_complete,
            basis_provenance: Some(make_basis_provenance(&candidate, &canonical, members)),
            canonical_key,
        });
    }
    Ok(IntrinsicPeriodicCellDerivation {
        cells: result,
        edge_contact_diagnostics: contact.diagnostics,
        rejected: sort_rejected_entries(rejected.entries()),
        rejected_samples,
    })
}

fn make_basis_provenance(
    candidate: &IntrinsicPeriodicBasisCandidate,
    canonical: &(GridPoint, GridPoint),
    members: &[IntrinsicPeriodicBaseMember],
) -> IntrinsicPeriodicBasisProvenance {
    IntrinsicPeriodicBasisProvenance {
        source_key: candidate.source_key.clone(),
        source_kind: candidate.source_kind,
        source_points: [
            serialize_rational_point(&candidate.source_points.0),
            serialize_rational_point(&candidate.source_points.1),
        ],
        axis: candidate.axis,
        selected_basis: [
            vector_from_grid(&from_grid_point(&candidate.basis.0)),
            vector_from_grid(&from_grid_point(&candidate.basis.1)),
        ],
        selected_residual_grid: [
            serialize_rational_point(&candidate.selected_residual_grid.0),
            serialize_rational_point(&candidate.selected_residual_grid.1),
        ],
        canonical_basis: [
            vector_from_grid(&from_grid_point(&canonical.0)),
            vector_from_grid(&from_grid_point(&canonical.1)),
        ],
        member_transforms: members
            .iter()
            .enumerate()
            .map(|(index, member)| IntrinsicPeriodicMemberTransform {
                member_index: index as f64,
                piece_id: prepared_piece_id(&member.piece),
                transform_index: member.geometry.transform.index,
                rotation_deg: member.geometry.transform.rotation_deg,
                mirrored: member.geometry.transform.mirrored,
            })
            .collect(),
        contact_relations: candidate.contact_relations.clone(),
    }
}

fn prepared_piece_id(piece: &IrregularPreparedPiece) -> String {
    piece
        .piece_id
        .clone()
        .map(|id| id.as_str().to_string())
        .unwrap_or_else(|| piece.source.id.as_str().to_string())
}

// ===========================================================================
// Edge-contact basis derivation (`CELLS:1234-1556`).
// ===========================================================================

struct EdgeContactRelation {
    vector: GridPoint,
    provenance: IntrinsicPeriodicEdgeContactProvenance,
}

impl Clone for EdgeContactRelation {
    fn clone(&self) -> Self {
        Self {
            vector: self.vector.clone(),
            provenance: self.provenance.clone(),
        }
    }
}

struct GridEdge {
    start: GridPoint,
    end: GridPoint,
    index: usize,
}

fn grid_edges(points: &[IrregularPoint]) -> Vec<GridEdge> {
    let converted: Vec<Option<GridPoint>> = points.iter().map(|point| grid_point(*point)).collect();
    if converted.iter().any(|point| point.is_none()) {
        return Vec::new();
    }
    let converted: Vec<GridPoint> = converted.into_iter().flatten().collect();
    (0..converted.len())
        .map(|index| GridEdge {
            start: converted[index].clone(),
            end: converted[(index + 1) % converted.len()].clone(),
            index,
        })
        .collect()
}

fn translated_grid_edges(points: &[IrregularPoint], translation: &GridPoint) -> Vec<GridEdge> {
    grid_edges(points)
        .into_iter()
        .map(|edge| GridEdge {
            start: GridPoint {
                x: &edge.start.x + &translation.x,
                y: &edge.start.y + &translation.y,
            },
            end: GridPoint {
                x: &edge.end.x + &translation.x,
                y: &edge.end.y + &translation.y,
            },
            index: edge.index,
        })
        .collect()
}

fn edge_contact_provenance_key(provenance: &IntrinsicPeriodicEdgeContactProvenance) -> String {
    format!(
        "{},{}:{}/{}>{}/{}",
        number_to_js_string(provenance.vector.x),
        number_to_js_string(provenance.vector.y),
        number_to_js_string(provenance.fixed_member_index),
        number_to_js_string(provenance.fixed_edge_index),
        number_to_js_string(provenance.moving_member_index),
        number_to_js_string(provenance.moving_edge_index),
    )
}

fn compare_edge_contact_relations(
    first: &EdgeContactRelation,
    second: &EdgeContactRelation,
) -> Ordering {
    diff_ord(second.provenance.length_mm - first.provenance.length_mm)
        .then_with(|| squared_grid_length(&first.vector).cmp(&squared_grid_length(&second.vector)))
        .then_with(|| {
            locale_compare_keys(
                &edge_contact_provenance_key(&first.provenance),
                &edge_contact_provenance_key(&second.provenance),
            )
        })
}

struct EdgeContactDerivation {
    candidates: Vec<IntrinsicPeriodicBasisCandidate>,
    diagnostics: IntrinsicPeriodicEdgeContactDiagnostics,
}

fn derive_edge_contact_basis_candidates(
    members: &[IntrinsicPeriodicBaseMember],
) -> Result<EdgeContactDerivation, IrregularGeometryInputError> {
    let mut relations = OrderedMap::<EdgeContactRelation>::new();
    for fixed_member_index in 0..members.len() {
        let fixed_member = &members[fixed_member_index];
        let fixed_point = grid_point(fixed_member.point);
        let fixed_edges = match &fixed_point {
            Some(point) => translated_grid_edges(&fixed_member.geometry.polygon.points, point),
            None => Vec::new(),
        };
        for moving_member_index in 0..members.len() {
            let moving_member = &members[moving_member_index];
            let moving_point = match grid_point(moving_member.point) {
                Some(value) => value,
                None => continue,
            };
            let moving_edges = grid_edges(&moving_member.geometry.polygon.points);
            for fixed_edge in &fixed_edges {
                let fixed_direction = subtract_grid_points(&fixed_edge.end, &fixed_edge.start);
                for moving_edge in &moving_edges {
                    let moving_direction =
                        subtract_grid_points(&moving_edge.end, &moving_edge.start);
                    if cross_grid(&fixed_direction, &moving_direction) != BigInt::from(0)
                        || dot_grid(&fixed_direction, &moving_direction) >= BigInt::from(0)
                    {
                        continue;
                    }
                    let candidate_points = [
                        subtract_grid_points(&fixed_edge.start, &moving_edge.end),
                        subtract_grid_points(&fixed_edge.end, &moving_edge.start),
                    ];
                    for candidate_point in candidate_points {
                        let vector = subtract_grid_points(&candidate_point, &moving_point);
                        if !is_canonical_positive_vector(&vector) {
                            continue;
                        }
                        let relation = validate_edge_contact_relation(
                            members,
                            &vector,
                            fixed_member_index,
                            fixed_edge.index,
                            moving_member_index,
                            moving_edge.index,
                        )?;
                        let relation = match relation {
                            Some(value) => value,
                            None => continue,
                        };
                        let key = format!("{},{}", vector.x, vector.y);
                        let replace = match relations.get(&key) {
                            None => true,
                            Some(current) => {
                                relation.provenance.length_mm > current.provenance.length_mm
                                    || (relation.provenance.length_mm
                                        == current.provenance.length_mm
                                        && edge_contact_provenance_key(&relation.provenance)
                                            < edge_contact_provenance_key(&current.provenance))
                            }
                        };
                        if replace {
                            relations.set(key, relation);
                        }
                    }
                }
            }
        }
    }

    let generated_relation_count = relations.len() as f64;
    let mut retained_relations: Vec<EdgeContactRelation> = relations.into_values();
    retained_relations.sort_by(compare_edge_contact_relations);
    retained_relations.truncate(MAXIMUM_EDGE_CONTACT_RELATIONS_PER_DERIVATION);

    let member_doubled_area_grid2 = members.iter().fold(BigInt::from(0), |sum, member| {
        sum + polygon_area_grid2(&member.geometry, member.point)
    });

    struct RawCandidate {
        determinant: BigInt,
        squared_span: BigInt,
        contact_length_mm: f64,
        candidate: IntrinsicPeriodicBasisCandidate,
    }

    let mut candidates: Vec<RawCandidate> = Vec::new();
    let mut non_collinear_pair_count: f64 = 0.0;
    let mut area_feasible_pair_count: f64 = 0.0;
    for first_index in 0..retained_relations.len() {
        for second_index in (first_index + 1)..retained_relations.len() {
            let first = &retained_relations[first_index];
            let second = &retained_relations[second_index];
            let determinant = abs_bigint(&cross_grid(&first.vector, &second.vector));
            if determinant == BigInt::from(0) {
                continue;
            }
            non_collinear_pair_count += 1.0;
            if BigInt::from(2) * &determinant < member_doubled_area_grid2 {
                continue;
            }
            area_feasible_pair_count += 1.0;
            let source_points = (
                RationalPoint {
                    x: rational(first.vector.x.clone()),
                    y: rational(first.vector.y.clone()),
                },
                RationalPoint {
                    x: rational(second.vector.x.clone()),
                    y: rational(second.vector.y.clone()),
                },
            );
            let source_key = format!(
                "edge-contact:{};{}",
                edge_contact_provenance_key(&first.provenance),
                edge_contact_provenance_key(&second.provenance)
            );
            candidates.push(RawCandidate {
                determinant,
                squared_span: squared_grid_length(&first.vector)
                    + squared_grid_length(&second.vector),
                contact_length_mm: first.provenance.length_mm + second.provenance.length_mm,
                candidate: IntrinsicPeriodicBasisCandidate {
                    basis: (first.vector.clone(), second.vector.clone()),
                    source_key,
                    source_kind: IntrinsicPeriodicBasisSourceKind::EdgeContactPair,
                    source_points,
                    axis: None,
                    selected_residual_grid: (
                        RationalPoint {
                            x: rational(BigInt::from(0)),
                            y: rational(BigInt::from(0)),
                        },
                        RationalPoint {
                            x: rational(BigInt::from(0)),
                            y: rational(BigInt::from(0)),
                        },
                    ),
                    contact_relations: Some((first.provenance.clone(), second.provenance.clone())),
                },
            });
        }
    }
    candidates.sort_by(|first, second| {
        first
            .determinant
            .cmp(&second.determinant)
            .then_with(|| first.squared_span.cmp(&second.squared_span))
            .then_with(|| diff_ord(second.contact_length_mm - first.contact_length_mm))
            .then_with(|| {
                locale_compare_keys(&first.candidate.source_key, &second.candidate.source_key)
            })
    });

    let mut admitted: Vec<IntrinsicPeriodicBasisCandidate> = Vec::new();
    let mut lattice_rejected_count: f64 = 0.0;
    let mut contact_incomplete_count: f64 = 0.0;
    let ordered_candidate_count = candidates.len();
    let attempted_count =
        ordered_candidate_count.min(MAXIMUM_EDGE_CONTACT_PAIR_VALIDATION_ATTEMPTS_PER_DERIVATION);
    for raw in candidates.into_iter().take(attempted_count) {
        let candidate = raw.candidate;
        let canonical = match canonicalize_basis(&candidate.basis.0, &candidate.basis.1) {
            Some(value) => value,
            None => continue,
        };
        let diagnostic = diagnose_lattice(members, &canonical)?;
        if !diagnostic.legal {
            lattice_rejected_count += 1.0;
            continue;
        }
        if !diagnostic.centre_contact_complete || diagnostic.shared_boundary_length_mm <= 0.0 {
            contact_incomplete_count += 1.0;
            continue;
        }
        admitted.push(candidate);
        if admitted.len() >= MAXIMUM_EDGE_CONTACT_BASIS_CANDIDATES_PER_DERIVATION {
            break;
        }
    }
    let admitted_len = admitted.len() as f64;
    Ok(EdgeContactDerivation {
        candidates: admitted,
        diagnostics: IntrinsicPeriodicEdgeContactDiagnostics {
            generated_relation_count,
            retained_relation_count: retained_relations.len() as f64,
            non_collinear_pair_count,
            area_feasible_pair_count,
            validation_attempt_count: attempted_count as f64,
            validation_coverage_complete: attempted_count == ordered_candidate_count,
            lattice_rejected_count,
            contact_incomplete_count,
            admitted_basis_count: admitted_len,
        },
    })
}

/// TS: `validateEdgeContactRelation` (`CELLS:1441-1502`).
fn validate_edge_contact_relation(
    members: &[IntrinsicPeriodicBaseMember],
    vector: &GridPoint,
    fixed_member_index: usize,
    fixed_edge_index: usize,
    moving_member_index: usize,
    moving_edge_index: usize,
) -> Result<Option<EdgeContactRelation>, IrregularGeometryInputError> {
    let mut placed: Vec<IrregularPlacedPiece> = Vec::new();
    for member in members {
        let base_point = match grid_point(member.point) {
            Some(value) => value,
            None => return Ok(None),
        };
        let point = from_grid_point(&GridPoint {
            x: &base_point.x + &vector.x,
            y: &base_point.y + &vector.y,
        });
        if !check_sheetless(&placed, &member.geometry, point)? {
            return Ok(None);
        }
        placed.push(make_placed(&member.piece, &member.geometry, point));
    }

    let fixed_member = &members[fixed_member_index];
    let moving_member = &members[moving_member_index];
    let moving_base_point = match grid_point(moving_member.point) {
        Some(value) => value,
        None => return Ok(None),
    };
    let fixed_polygon =
        translate_polygon_with_bounds(&fixed_member.geometry.polygon, fixed_member.point);
    let moving_point = from_grid_point(&GridPoint {
        x: &moving_base_point.x + &vector.x,
        y: &moving_base_point.y + &vector.y,
    });
    let moving_polygon =
        translate_polygon_with_bounds(&moving_member.geometry.polygon, moving_point);
    let (fixed_polygon, moving_polygon) = match (fixed_polygon, moving_polygon) {
        (Some(fixed), Some(moving)) => (fixed, moving),
        _ => return Ok(None),
    };
    let segments = match shared_convex_polygon_boundary_segments(&fixed_polygon, &moving_polygon) {
        Some(value) => value,
        None => return Ok(None),
    };
    let mut matching: Vec<_> = segments
        .into_iter()
        .filter(|segment| {
            segment.first_edge_index as usize == fixed_edge_index
                && segment.second_edge_index as usize == moving_edge_index
        })
        .collect();
    matching.sort_by(|first, second| diff_ord(second.length_mm - first.length_mm));
    let segment = match matching.into_iter().next() {
        Some(value) if value.length_mm > 0.0 => value,
        _ => return Ok(None),
    };
    Ok(Some(EdgeContactRelation {
        vector: vector.clone(),
        provenance: IntrinsicPeriodicEdgeContactProvenance {
            vector: vector_from_grid(&from_grid_point(vector)),
            fixed_member_index: fixed_member_index as f64,
            fixed_piece_id: prepared_piece_id(&fixed_member.piece),
            fixed_edge_index: fixed_edge_index as f64,
            moving_member_index: moving_member_index as f64,
            moving_piece_id: prepared_piece_id(&moving_member.piece),
            moving_edge_index: moving_edge_index as f64,
            segment_start: segment.start,
            segment_end: segment.end,
            length_mm: segment.length_mm,
        },
    }))
}

// ===========================================================================
// Axis-union and NFP-boundary-vertex-pair basis derivation (`CELLS:1558-1677`).
// ===========================================================================

fn derive_axis_basis(
    boundaries: &[ForbiddenBoundary],
    swap_axes: bool,
) -> Option<(GridPoint, GridPoint)> {
    derive_axis_basis_candidates(boundaries, swap_axes)
        .into_iter()
        .next()
        .map(|candidate| candidate.basis)
}

/// TS: `deriveAxisBasisCandidates` (`CELLS:1558-1631`).
fn derive_axis_basis_candidates(
    boundaries: &[ForbiddenBoundary],
    swap_axes: bool,
) -> Vec<IntrinsicPeriodicBasisCandidate> {
    let oriented_raw: Vec<ForbiddenBoundary> = boundaries
        .iter()
        .map(|boundary| ForbiddenBoundary {
            points: boundary
                .points
                .iter()
                .map(|point| {
                    if swap_axes {
                        GridPoint {
                            x: point.y.clone(),
                            y: point.x.clone(),
                        }
                    } else {
                        point.clone()
                    }
                })
                .collect(),
            is_hole: boundary.is_hole,
        })
        .collect();
    let oriented = match union_forbidden_boundaries(&oriented_raw) {
        Some(value) => value,
        None => return Vec::new(),
    };
    let mut axis_candidates = boundary_line_intersections(&oriented, true, &BigInt::from(0));
    axis_candidates.retain(|point| {
        compare_rational(&point.x, &rational(BigInt::from(0))) == Ordering::Greater
    });
    axis_candidates.sort_by(|first, second| compare_rational(&first.x, &second.x));
    let axis_intersection = match axis_candidates.into_iter().next() {
        Some(value) => value,
        None => return Vec::new(),
    };
    let unswap = |point: &GridPoint| -> GridPoint {
        if swap_axes {
            GridPoint {
                x: point.y.clone(),
                y: point.x.clone(),
            }
        } else {
            point.clone()
        }
    };
    let mut result = OrderedMap::<IntrinsicPeriodicBasisCandidate>::new();
    for axis_x in canonical_grid_alternatives(&axis_intersection.x)
        .into_iter()
        .filter(|value| *value > BigInt::from(0))
    {
        let axis = GridPoint {
            x: axis_x.clone(),
            y: BigInt::from(0),
        };
        let mut shifted_input = oriented.clone();
        shifted_input.extend(oriented.iter().map(|boundary| {
            ForbiddenBoundary {
                points: boundary
                    .points
                    .iter()
                    .map(|point| GridPoint {
                        x: &point.x + &axis.x,
                        y: point.y.clone(),
                    })
                    .collect(),
                is_hole: boundary.is_hole,
            }
        }));
        let shifted = match union_forbidden_boundaries(&shifted_input) {
            Some(value) => value,
            None => continue,
        };
        let mut constrained: Vec<RationalPoint> = shifted
            .iter()
            .flat_map(|boundary| {
                boundary.points.iter().map(|point| RationalPoint {
                    x: rational(point.x.clone()),
                    y: rational(point.y.clone()),
                })
            })
            .collect();
        constrained.extend(boundary_line_intersections(
            &shifted,
            false,
            &BigInt::from(0),
        ));
        constrained.extend(boundary_line_intersections(&shifted, false, &axis.x));
        constrained.retain(|point| {
            compare_rational(&point.y, &rational(BigInt::from(0))) == Ordering::Greater
                && compare_rational(&point.x, &rational(BigInt::from(0))) != Ordering::Less
                && compare_rational(
                    &point.x,
                    &Rational {
                        numerator: axis.x.clone(),
                        denominator: BigInt::from(1),
                    },
                ) == Ordering::Less
        });
        constrained.sort_by(|first, second| {
            compare_rational(&first.y, &second.y)
                .then_with(|| compare_rational(&first.x, &second.x))
        });
        let second_rational = match constrained.into_iter().next() {
            Some(value) => value,
            None => continue,
        };
        for second_x in canonical_grid_alternatives(&second_rational.x) {
            for second_y in canonical_grid_alternatives(&second_rational.y) {
                if second_y <= BigInt::from(0) || second_x < BigInt::from(0) || second_x >= axis.x {
                    continue;
                }
                let basis = (
                    unswap(&axis),
                    unswap(&GridPoint {
                        x: second_x.clone(),
                        y: second_y.clone(),
                    }),
                );
                let selected_rational = (
                    RationalPoint {
                        x: rational(axis_x.clone()),
                        y: rational(BigInt::from(0)),
                    },
                    RationalPoint {
                        x: rational(second_x.clone()),
                        y: rational(second_y.clone()),
                    },
                );
                let original_rational = (
                    RationalPoint {
                        x: axis_intersection.x.clone(),
                        y: rational(BigInt::from(0)),
                    },
                    second_rational.clone(),
                );
                let source_key = format!(
                    "{}:{};{}",
                    if swap_axes { "y" } else { "x" },
                    rational_point_key(&original_rational.0),
                    rational_point_key(&original_rational.1)
                );
                let key = format!("{},{};{},{}", basis.0.x, basis.0.y, basis.1.x, basis.1.y);
                result.set(
                    key,
                    IntrinsicPeriodicBasisCandidate {
                        basis,
                        source_key,
                        source_kind: IntrinsicPeriodicBasisSourceKind::AxisUnion,
                        source_points: original_rational.clone(),
                        axis: Some(if swap_axes {
                            IntrinsicPeriodicAxis::Y
                        } else {
                            IntrinsicPeriodicAxis::X
                        }),
                        selected_residual_grid: (
                            subtract_rational_points(&selected_rational.0, &original_rational.0),
                            subtract_rational_points(&selected_rational.1, &original_rational.1),
                        ),
                        contact_relations: None,
                    },
                );
            }
        }
    }
    result.into_values()
}

/// TS: `deriveNfpBoundaryVertexBasisCandidates` (`CELLS:1634-1677`).
fn derive_nfp_boundary_vertex_basis_candidates(
    boundaries: &[ForbiddenBoundary],
    maximum_candidates: usize,
) -> Vec<IntrinsicPeriodicBasisCandidate> {
    let mut vector_map = OrderedMap::<GridPoint>::new();
    for boundary in boundaries {
        for point in &boundary.points {
            if point.y > BigInt::from(0)
                || (point.y == BigInt::from(0) && point.x > BigInt::from(0))
            {
                vector_map.set(format!("{},{}", point.x, point.y), point.clone());
            }
        }
    }
    let mut vectors: Vec<GridPoint> = vector_map.into_values();
    vectors.sort_by(|first, second| {
        let first_length = &first.x * &first.x + &first.y * &first.y;
        let second_length = &second.x * &second.x + &second.y * &second.y;
        first_length
            .cmp(&second_length)
            .then_with(|| compare_grid_points(first, second))
    });
    let mut result = OrderedMap::<IntrinsicPeriodicBasisCandidate>::new();
    for first_index in 0..vectors.len() {
        for second_index in (first_index + 1)..vectors.len() {
            let first = &vectors[first_index];
            let second = &vectors[second_index];
            if cross_grid(first, second) == BigInt::from(0) {
                continue;
            }
            let basis = (first.clone(), second.clone());
            let source_points = (
                RationalPoint {
                    x: rational(first.x.clone()),
                    y: rational(first.y.clone()),
                },
                RationalPoint {
                    x: rational(second.x.clone()),
                    y: rational(second.y.clone()),
                },
            );
            let source_key = format!(
                "nfp-edge:{};{}",
                rational_point_key(&source_points.0),
                rational_point_key(&source_points.1)
            );
            result.set(
                format!("{},{};{},{}", first.x, first.y, second.x, second.y),
                IntrinsicPeriodicBasisCandidate {
                    basis,
                    source_key,
                    source_kind: IntrinsicPeriodicBasisSourceKind::NfpBoundaryVertexPair,
                    source_points,
                    axis: None,
                    selected_residual_grid: (
                        RationalPoint {
                            x: rational(BigInt::from(0)),
                            y: rational(BigInt::from(0)),
                        },
                        RationalPoint {
                            x: rational(BigInt::from(0)),
                            y: rational(BigInt::from(0)),
                        },
                    ),
                    contact_relations: None,
                },
            );
            if result.len() >= maximum_candidates {
                return result.into_values();
            }
        }
    }
    result.into_values()
}

/// TS: `boundaryLineIntersections` (`CELLS:1726-1767`). `axis_is_y` selects
/// `axis: 'y'` (`true`) vs. `'x'` (`false`).
fn boundary_line_intersections(
    boundaries: &[ForbiddenBoundary],
    axis_is_y: bool,
    value: &BigInt,
) -> Vec<RationalPoint> {
    let mut result = OrderedMap::<RationalPoint>::new();
    for boundary in &boundaries.to_vec() {
        let points = &boundary.points;
        for index in 0..points.len() {
            let first = &points[index];
            let second = &points[(index + 1) % points.len()];
            let (first_value, second_value) = if axis_is_y {
                (&first.y, &second.y)
            } else {
                (&first.x, &second.x)
            };
            if (value < first_value && value < second_value)
                || (value > first_value && value > second_value)
            {
                continue;
            }
            if first_value == second_value {
                if first_value == value {
                    let first_point = RationalPoint {
                        x: rational(first.x.clone()),
                        y: rational(first.y.clone()),
                    };
                    let second_point = RationalPoint {
                        x: rational(second.x.clone()),
                        y: rational(second.y.clone()),
                    };
                    result.set(rational_point_key(&first_point), first_point);
                    result.set(rational_point_key(&second_point), second_point);
                }
                continue;
            }
            let numerator = value - first_value;
            let denominator = second_value - first_value;
            let (first_other, second_other) = if axis_is_y {
                (&first.x, &second.x)
            } else {
                (&first.y, &second.y)
            };
            let other = add_rational(
                &rational(first_other.clone()),
                &make_rational(&((second_other - first_other) * &numerator), &denominator),
            );
            let point = if axis_is_y {
                RationalPoint {
                    x: other,
                    y: rational(value.clone()),
                }
            } else {
                RationalPoint {
                    x: rational(value.clone()),
                    y: other,
                }
            };
            result.set(rational_point_key(&point), point);
        }
    }
    result.into_values()
}

/// TS: `unionForbiddenBoundaries` (`CELLS:1785-1810`).
fn union_forbidden_boundaries(boundaries: &[ForbiddenBoundary]) -> Option<Vec<ForbiddenBoundary>> {
    let mut paths: Paths64 = Vec::new();
    for boundary in boundaries {
        let mut path: Path64 = Vec::with_capacity(boundary.points.len());
        for point in &boundary.points {
            let x = bigint_to_number(&point.x);
            let y = bigint_to_number(&point.y);
            if !is_safe_integer(x) || !is_safe_integer(y) {
                return None;
            }
            path.push(Point64::new(x, y, 0.0));
        }
        if path.len() >= 3 {
            let positive = if area(&path) >= 0.0 {
                path
            } else {
                path.into_iter().rev().collect()
            };
            let oriented = if boundary.is_hole == Some(true) {
                positive.into_iter().rev().collect()
            } else {
                positive
            };
            paths.push(oriented);
        }
    }
    let mut tree = PolyTree64::new();
    boolean_op_with_poly_tree(
        ClipType::Union,
        Some(&paths),
        None,
        &mut tree,
        FillRule::NonZero,
    );
    let mut result = Vec::new();
    collect_forbidden_tree(&tree, PolyTree64::ROOT, &mut result);
    Some(result)
}

fn collect_forbidden_tree(tree: &PolyTree64, node: usize, result: &mut Vec<ForbiddenBoundary>) {
    for index in 0..tree.count(node) {
        let child = tree.child(node, index);
        if let Some(polygon) = tree.poly(child) {
            result.push(ForbiddenBoundary {
                points: polygon
                    .iter()
                    .map(|point| GridPoint {
                        x: f64_to_bigint(point.x),
                        y: f64_to_bigint(point.y),
                    })
                    .collect(),
                is_hole: Some(tree.is_hole(child)),
            });
        }
        collect_forbidden_tree(tree, child, result);
    }
}

fn canonicalize_basis(first: &GridPoint, second: &GridPoint) -> Option<(GridPoint, GridPoint)> {
    let determinant = cross_grid(first, second);
    if determinant == BigInt::from(0) {
        return None;
    }
    if determinant > BigInt::from(0) {
        Some((first.clone(), second.clone()))
    } else {
        Some((second.clone(), first.clone()))
    }
}

// ===========================================================================
// 3x3 lattice diagnostic (`CELLS:1955-2036`).
// ===========================================================================

struct PeriodicLatticeDiagnostic {
    legal: bool,
    centre_contact_complete: bool,
    shared_boundary_length_mm: f64,
}

fn illegal_lattice_diagnostic() -> PeriodicLatticeDiagnostic {
    PeriodicLatticeDiagnostic {
        legal: false,
        centre_contact_complete: false,
        shared_boundary_length_mm: 0.0,
    }
}

/// TS: `diagnoseLattice` (`CELLS:1955-2023`).
fn diagnose_lattice(
    members: &[IntrinsicPeriodicBaseMember],
    basis: &(GridPoint, GridPoint),
) -> Result<PeriodicLatticeDiagnostic, IrregularGeometryInputError> {
    let mut placed: Vec<IrregularPlacedPiece> = Vec::new();
    let mut center: Vec<usize> = Vec::new();
    for n in -1i64..=1 {
        for m in -1i64..=1 {
            for member in members {
                let base_point = match grid_point(member.point) {
                    Some(value) => value,
                    None => return Ok(illegal_lattice_diagnostic()),
                };
                let point = from_grid_point(&GridPoint {
                    x: &base_point.x
                        + &(BigInt::from(n) * &basis.0.x)
                        + &(BigInt::from(m) * &basis.1.x),
                    y: &base_point.y
                        + &(BigInt::from(n) * &basis.0.y)
                        + &(BigInt::from(m) * &basis.1.y),
                });
                let legal = check_sheetless(&placed, &member.geometry, point)?;
                if !legal {
                    return Ok(illegal_lattice_diagnostic());
                }
                if n == 0 && m == 0 {
                    center.push(placed.len());
                }
                placed.push(make_placed(&member.piece, &member.geometry, point));
            }
        }
    }
    let mut shared_boundary_length_mm = 0.0_f64;
    let mut contacted_center: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for &center_index in &center {
        let first = &placed[center_index];
        let first_polygon = match translate_polygon_with_bounds(
            &first.collision_geometry.polygon,
            IrregularPoint::new(
                first.placement.transform.translate_x,
                first.placement.transform.translate_y,
            ),
        ) {
            Some(value) => value,
            None => return Ok(illegal_lattice_diagnostic()),
        };
        for (other_index, other) in placed.iter().enumerate() {
            if center.contains(&other_index) {
                continue;
            }
            let other_polygon = match translate_polygon_with_bounds(
                &other.collision_geometry.polygon,
                IrregularPoint::new(
                    other.placement.transform.translate_x,
                    other.placement.transform.translate_y,
                ),
            ) {
                Some(value) => value,
                None => return Ok(illegal_lattice_diagnostic()),
            };
            let contact =
                match shared_convex_polygon_boundary_length(&first_polygon, &other_polygon) {
                    Some(value) => value,
                    None => return Ok(illegal_lattice_diagnostic()),
                };
            if contact > 0.0 {
                contacted_center.insert(center_index);
                shared_boundary_length_mm += contact;
            }
        }
    }
    Ok(PeriodicLatticeDiagnostic {
        legal: true,
        centre_contact_complete: contacted_center.len() == center.len(),
        shared_boundary_length_mm,
    })
}

// ===========================================================================
// P2 candidate-point derivation (`CELLS:2052-2092`).
// ===========================================================================

/// TS: `boundaryCandidatePoints` (`CELLS:2052-2078`).
fn boundary_candidate_points(
    points: &[IrregularPoint],
    moving: &TransformedCollisionGeometry,
) -> Vec<IrregularPoint> {
    let boundary_points: Vec<GridPoint> = points
        .iter()
        .filter_map(|point| grid_point(*point))
        .collect();
    let boundaries = [ForbiddenBoundary {
        points: boundary_points.clone(),
        is_hole: None,
    }];
    let x_value = to_grid_mm(-moving.bounds.min_x);
    let y_value = to_grid_mm(-moving.bounds.min_y);
    let mut candidates = OrderedMap::<GridPoint>::new();
    for point in &boundary_points {
        candidates.set(format!("{},{}", point.x, point.y), point.clone());
    }
    if let Some(x_value) = x_value {
        for point in boundary_line_intersections(&boundaries, false, &f64_to_bigint(x_value)) {
            let grid = GridPoint {
                x: round_rational(&point.x),
                y: round_rational(&point.y),
            };
            candidates.set(format!("{},{}", grid.x, grid.y), grid);
        }
    }
    if let Some(y_value) = y_value {
        for point in boundary_line_intersections(&boundaries, true, &f64_to_bigint(y_value)) {
            let grid = GridPoint {
                x: round_rational(&point.x),
                y: round_rational(&point.y),
            };
            candidates.set(format!("{},{}", grid.x, grid.y), grid);
        }
    }
    let mut ordered = candidates.into_values();
    ordered.sort_by(compare_grid_points);
    ordered.iter().map(from_grid_point).collect()
}

/// TS: `combinedBoundsNonnegative` (`CELLS:2080-2092`).
fn combined_bounds_nonnegative(
    geometries: &[&TransformedCollisionGeometry],
    points: &[IrregularPoint],
) -> bool {
    geometries
        .iter()
        .enumerate()
        .all(|(index, geometry)| match points.get(index) {
            Some(point) => {
                geometry.bounds.min_x + point.x >= 0.0 && geometry.bounds.min_y + point.y >= 0.0
            }
            None => false,
        })
}

// ===========================================================================
// Placement helpers (`CELLS:2094-2143`).
// ===========================================================================

fn make_placed(
    piece: &IrregularPreparedPiece,
    geometry: &TransformedCollisionGeometry,
    point: IrregularPoint,
) -> IrregularPlacedPiece {
    IrregularPlacedPiece {
        placement: IrregularPlacement {
            piece_id: Some(
                piece
                    .piece_id
                    .clone()
                    .unwrap_or_else(|| piece.source.id.clone()),
            ),
            source_piece_id: piece.source.id.clone(),
            placement_reference: Some(piece.collision_geometry.placement_reference),
            transform: IrregularTransform {
                translate_x: point.x,
                translate_y: point.y,
                rotation_deg: geometry.transform.rotation_deg,
                mirrored: geometry.transform.mirrored,
            },
        },
        collision_geometry: geometry.clone(),
    }
}

fn geometry_for_piece(
    geometry: &TransformedCollisionGeometry,
    piece: &IrregularPreparedPiece,
) -> TransformedCollisionGeometry {
    TransformedCollisionGeometry {
        source_piece_id: piece.source.id.clone(),
        transform: geometry.transform,
        polygon: geometry.polygon.clone(),
        bounds: geometry.bounds,
    }
}

fn make_candidate(
    geometry: &TransformedCollisionGeometry,
    point: IrregularPoint,
) -> IrregularPlacementCandidate {
    IrregularPlacementCandidate {
        piece_id: geometry.source_piece_id.clone(),
        transform: geometry.transform,
        point,
        diagnostics: Vec::new(),
    }
}

fn anchor_point(geometry: &TransformedCollisionGeometry) -> IrregularPoint {
    let x = to_grid_mm(-geometry.bounds.min_x).unwrap_or(0.0);
    let y = to_grid_mm(-geometry.bounds.min_y).unwrap_or(0.0);
    IrregularPoint::new(from_grid(x), from_grid(y))
}

/// Legality check with no spatial index (this cluster never builds one;
/// characterization doc §9). Wraps `assess_placement`'s `Arc`-slice
/// requirement transiently since no index means `Arc::ptr_eq` identity is
/// never consulted.
fn check_sheetless(
    placed: &[IrregularPlacedPiece],
    moving: &TransformedCollisionGeometry,
    candidate_point: IrregularPoint,
) -> Result<bool, IrregularGeometryInputError> {
    let arcs: Vec<std::sync::Arc<IrregularPlacedPiece>> =
        placed.iter().cloned().map(std::sync::Arc::new).collect();
    let input = AssessPlacementInput {
        sheet: None,
        placed: &arcs,
        placed_collision_index: None,
        moving,
        candidate_point,
    };
    match assess_placement(&input, false) {
        crate::validation::placement::AssessPlacementOutcome::Assessment(assessment) => {
            Ok(assessment.legal)
        }
        crate::validation::placement::AssessPlacementOutcome::Failure(err) => Err(err),
    }
}

// ===========================================================================
// Canonical identity keys (`CELLS:2145-2226`).
// ===========================================================================

fn canonical_transformed_polygon_key(geometry: &TransformedCollisionGeometry) -> String {
    let points: Vec<Option<GridPoint>> = geometry
        .polygon
        .points
        .iter()
        .map(|point| grid_point(*point))
        .collect();
    if points.iter().any(|point| point.is_none()) {
        return "invalid".to_string();
    }
    let valid: Vec<GridPoint> = points.into_iter().flatten().collect();
    let min_x = valid
        .iter()
        .map(|point| &point.x)
        .min()
        .cloned()
        .unwrap_or_else(|| BigInt::from(0));
    let min_y = valid
        .iter()
        .map(|point| &point.y)
        .min()
        .cloned()
        .unwrap_or_else(|| BigInt::from(0));
    let shifted: Vec<GridPoint> = valid
        .iter()
        .map(|point| GridPoint {
            x: &point.x - &min_x,
            y: &point.y - &min_y,
        })
        .collect();
    canonical_cycle(&shifted)
}

/// TS: `canonicalCellKey` (`CELLS:2154-2201`).
fn canonical_cell_key(
    role: IntrinsicPeriodicRole,
    members: &[IntrinsicPeriodicBaseMember],
    basis: &(GridPoint, GridPoint),
) -> String {
    let world_polygons: Vec<Vec<GridPoint>> = members
        .iter()
        .map(|member| match grid_point(member.point) {
            None => Vec::new(),
            Some(translation) => member
                .geometry
                .polygon
                .points
                .iter()
                .filter_map(|vertex| {
                    grid_point(*vertex).map(|local| GridPoint {
                        x: &local.x + &translation.x,
                        y: &local.y + &translation.y,
                    })
                })
                .collect(),
        })
        .collect();

    let rotate = |point: &GridPoint, turn: u8| -> GridPoint {
        match turn {
            1 => GridPoint {
                x: -&point.y,
                y: point.x.clone(),
            },
            2 => GridPoint {
                x: -&point.x,
                y: -&point.y,
            },
            3 => GridPoint {
                x: point.y.clone(),
                y: -&point.x,
            },
            _ => point.clone(),
        }
    };

    let mut variants: Vec<String> = Vec::new();
    for turn in 0..4u8 {
        let first = rotate(&basis.0, turn);
        let second = rotate(&basis.1, turn);
        let rotated_polygons: Vec<Vec<GridPoint>> = world_polygons
            .iter()
            .map(|polygon| polygon.iter().map(|point| rotate(point, turn)).collect())
            .collect();
        let all: Vec<&GridPoint> = rotated_polygons.iter().flatten().collect();
        let min_x = all
            .iter()
            .map(|point| &point.x)
            .min()
            .cloned()
            .unwrap_or_else(|| BigInt::from(0));
        let min_y = all
            .iter()
            .map(|point| &point.y)
            .min()
            .cloned()
            .unwrap_or_else(|| BigInt::from(0));
        let mut member_keys: Vec<String> = rotated_polygons
            .iter()
            .map(|polygon| {
                let shifted: Vec<GridPoint> = polygon
                    .iter()
                    .map(|point| GridPoint {
                        x: &point.x - &min_x,
                        y: &point.y - &min_y,
                    })
                    .collect();
                canonical_cycle(&shifted)
            })
            .collect();
        member_keys.sort_by(|first, second| cmp_js_code_units(first, second));
        let member_key = member_keys.join("|");
        variants.push(format!(
            "{}:{},{};{},{}",
            member_key, first.x, first.y, second.x, second.y
        ));
        variants.push(format!(
            "{}:{},{};{},{}",
            member_key, second.x, second.y, first.x, first.y
        ));
    }
    variants.sort_by(|first, second| cmp_js_code_units(first, second));
    format!(
        "{}:{}",
        role.as_str(),
        variants.into_iter().next().unwrap_or_default()
    )
}

/// TS: `canonicalCycle` (`CELLS:2217-2226`).
fn canonical_cycle(points: &[GridPoint]) -> String {
    let mut variants: Vec<String> = Vec::new();
    let reversed: Vec<GridPoint> = points.iter().rev().cloned().collect();
    for sequence in [points.to_vec(), reversed] {
        let length = sequence.len();
        for offset in 0..length {
            let mut rendered: Vec<String> = Vec::with_capacity(length);
            for k in 0..length {
                let point = &sequence[(offset + k) % length];
                rendered.push(format!("{},{}", point.x, point.y));
            }
            variants.push(rendered.join(";"));
        }
    }
    variants.sort_by(|first, second| cmp_js_code_units(first, second));
    variants.into_iter().next().unwrap_or_default()
}

fn polygon_area_grid2(geometry: &TransformedCollisionGeometry, point: IrregularPoint) -> BigInt {
    let translated: Vec<IrregularPoint> = geometry
        .polygon
        .points
        .iter()
        .map(|vertex| IrregularPoint::new(vertex.x + point.x, vertex.y + point.y))
        .collect();
    if translated.is_empty() {
        return BigInt::from(0);
    }
    let mut doubled = BigInt::from(0);
    for index in 0..translated.len() {
        let first = grid_point(translated[index]);
        let second = grid_point(translated[(index + 1) % translated.len()]);
        match (first, second) {
            (Some(first), Some(second)) => doubled += &first.x * &second.y - &second.x * &first.y,
            _ => return BigInt::from(0),
        }
    }
    abs_bigint(&doubled)
}

/// TS: `measureBaseCellShape` (`CELLS:2245-2271`). Returns
/// `(maximum_side_mm, hull_waste_ratio)`.
fn measure_base_cell_shape(members: &[IntrinsicPeriodicBaseMember]) -> Option<(f64, f64)> {
    let points: Vec<IrregularPoint> = members
        .iter()
        .flat_map(|member| {
            member.geometry.polygon.points.iter().map(move |point| {
                IrregularPoint::new(point.x + member.point.x, point.y + member.point.y)
            })
        })
        .collect();
    let bounds = bounds_for_points(&points)?;
    let grid_points: Vec<GridPoint> = points
        .iter()
        .filter_map(|point| grid_point(*point))
        .collect();
    let hull = convex_hull_grid(&grid_points);
    if hull.len() < 3 {
        return None;
    }
    let hull_doubled_area_grid2 = polygon_grid_area(&hull);
    let member_doubled_area_grid2 = members.iter().fold(BigInt::from(0), |sum, member| {
        sum + polygon_area_grid2(&member.geometry, member.point)
    });
    if hull_doubled_area_grid2 <= BigInt::from(0)
        || member_doubled_area_grid2 > hull_doubled_area_grid2
    {
        return None;
    }
    let maximum_side_mm = js_math::max(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y);
    let hull_waste_ratio =
        bigint_to_number(&(&hull_doubled_area_grid2 - &member_doubled_area_grid2))
            / bigint_to_number(&hull_doubled_area_grid2);
    Some((maximum_side_mm, hull_waste_ratio))
}

fn convex_hull_grid(points: &[GridPoint]) -> Vec<GridPoint> {
    let mut unique_map = OrderedMap::<GridPoint>::new();
    for point in points {
        unique_map.set(format!("{},{}", point.x, point.y), point.clone());
    }
    let mut unique: Vec<GridPoint> = unique_map.into_values();
    unique.sort_by(compare_grid_points);
    if unique.len() <= 1 {
        return unique;
    }
    let zero = BigInt::from(0);
    let build = |ordered: &[GridPoint]| -> Vec<GridPoint> {
        let mut half: Vec<GridPoint> = Vec::new();
        for point in ordered {
            while half.len() >= 2 {
                let origin = half[half.len() - 2].clone();
                let first = half[half.len() - 1].clone();
                if orientation_cross(&origin, &first, point) <= zero {
                    half.pop();
                } else {
                    break;
                }
            }
            half.push(point.clone());
        }
        half
    };
    let lower = build(&unique);
    let reversed: Vec<GridPoint> = unique.iter().rev().cloned().collect();
    let upper = build(&reversed);
    let mut result =
        Vec::with_capacity(lower.len().saturating_sub(1) + upper.len().saturating_sub(1));
    result.extend_from_slice(&lower[..lower.len().saturating_sub(1)]);
    result.extend_from_slice(&upper[..upper.len().saturating_sub(1)]);
    result
}

fn orientation_cross(origin: &GridPoint, first: &GridPoint, second: &GridPoint) -> BigInt {
    (&first.x - &origin.x) * (&second.y - &origin.y)
        - (&first.y - &origin.y) * (&second.x - &origin.x)
}

fn polygon_grid_area(points: &[GridPoint]) -> BigInt {
    if points.is_empty() {
        return BigInt::from(0);
    }
    let mut doubled = BigInt::from(0);
    for index in 0..points.len() {
        let first = &points[index];
        let second = &points[(index + 1) % points.len()];
        doubled += &first.x * &second.y - &second.x * &first.y;
    }
    abs_bigint(&doubled)
}

// ===========================================================================
// Cell ranking (`CELLS:2313-2339`).
// ===========================================================================

fn finite_crop_diagnostic_priority(cell: &IntrinsicPeriodicCell) -> i32 {
    if cell.three_by_three_lattice_legal && cell.three_by_three_centre_contact_complete {
        0
    } else if cell.three_by_three_lattice_legal {
        1
    } else {
        2
    }
}

fn compare_cells(first: &IntrinsicPeriodicCell, second: &IntrinsicPeriodicCell) -> Ordering {
    let density_order = (parse_area_bigint(&second.member_doubled_area_grid2)
        * parse_area_bigint(&first.determinant_grid2))
    .cmp(
        &(parse_area_bigint(&first.member_doubled_area_grid2)
            * parse_area_bigint(&second.determinant_grid2)),
    );
    diff_ord(
        (finite_crop_diagnostic_priority(first) - finite_crop_diagnostic_priority(second)) as f64,
    )
    .then(density_order)
    .then_with(|| diff_ord(first.envelope_maximum_side_mm - second.envelope_maximum_side_mm))
    .then_with(|| diff_ord(first.hull_waste_ratio - second.hull_waste_ratio))
    .then_with(|| diff_ord(second.shared_boundary_length_mm - first.shared_boundary_length_mm))
    .then_with(|| locale_compare_keys(&first.canonical_key, &second.canonical_key))
}

/// TS: `rankIntrinsicPeriodicCells` (`CELLS:2334-2339`).
pub fn rank_intrinsic_periodic_cells(
    mut cells: Vec<IntrinsicPeriodicCell>,
) -> Vec<IntrinsicPeriodicCell> {
    cells.sort_by(compare_cells);
    cells
}
