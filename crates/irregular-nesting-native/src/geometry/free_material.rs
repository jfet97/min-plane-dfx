//! Sheet-space free-material diagnostics: derives the remaining sheet
//! material (boundaries and interior holes) after subtracting placed
//! collision geometry, using Clipper2's `PolyTree64` output to classify
//! boundary/hole nesting.
//!
//! TS source (ported in full): `src/workers/irregular/freeMaterialService.ts`
//! (501 lines). Per the migration prompt §2, the TS behavior below —
//! including anything that looks unusual, redundant, or imprecise — is the
//! contract for this port; nothing here is a recommendation to change
//! behavior.
//!
//! # Liveness (per `docs/planning/rust-irregular-backend/characterization/
//! canonical-grid.md` §"`freeMaterialService.ts` — live, but only reached at
//! most twice per completed job")
//!
//! - [`compute_free_material`]/[`compute_free_material_live`] (TS:
//!   `deriveFreeMaterial`/`FreeMaterialServiceLive.computeFreeMaterial`) is
//!   the **only** production entry point, invoked at most twice per
//!   completed Compact Short Side job (once for the settled Compact result,
//!   once for the final Short Side directional result) and once for a plain
//!   Compact job — never once-per-search-candidate. This is a
//!   once-or-twice-per-job diagnostic/scoring snapshot, not a hot loop; no
//!   part of this module is a target for Stage 3/4 parallelism work.
//! - [`extend_free_material`] (TS: `deriveExtendedFreeMaterial`) and
//!   `createFreeMaterialService('direct-difference')` (here,
//!   [`FreeMaterialOperation::DirectDifference`]) are **confirmed
//!   unreachable from any current production job** — verified by direct
//!   read of every `IrregularBeamState` construction site in
//!   `computeIrregularNesting.ts`, none of which ever populates the
//!   `parent` field `extendFreeMaterial`'s only caller
//!   (`computeSnapshotWithParentFallback`) requires, and the `'direct-difference'`
//!   operation literal is never passed to `createFreeMaterialService` outside
//!   its own differential test. Per ruling R3, both are still ported with
//!   full correctness (not stubbed), because `tests/unit/freeMaterialService.test.ts`
//!   exercises them directly and the migration prompt's §3 test-immutability
//!   rule forbids weakening or deleting existing tests — but neither is a
//!   Stage 3/4 performance target.
//!
//! # Reused (GREEN) modules — never duplicated here
//!
//! - `crate::clipper::core`/`crate::clipper::engine`/`crate::clipper::offset`
//!   (ruling R10): `ClipType`/`FillRule`/`Point64`/`Path64`/`Paths64`/`area`,
//!   `PolyTree64`/`boolean_op_with_poly_tree`/`poly_tree_to_paths64`,
//!   `ClipperOffset::strip_duplicates`.
//! - `crate::canonical_grid::offset_policy::{to_grid_mm, from_grid}` (TS:
//!   `clipper2OffsetPolicy.ts`'s grid/mm conversion functions).
//! - `crate::geometry::convex::validate_strict_boundary` (TS:
//!   `ConvexPolygonValidation.validateStrictBoundary`).
//! - `crate::js_number::{fold_negative_zero, is_safe_integer, number_to_js_string}`
//!   — `fold_negative_zero`'s own doc comment explicitly names
//!   `freeMaterialService.ts:488` (`normalizeNegativeZero`) as one of its
//!   confirmed TS call sites.
//! - `crate::checkpoints::canonical_json::locale_compare_keys` — the
//!   collator-equivalent ruling R8 requires for every `String.prototype
//!   .localeCompare` call site; used here for `comparePolygons`'s
//!   `polygonKey(...).localeCompare(...)` fallback (TS:
//!   `freeMaterialService.ts:466`).
//! - `crate::transforms::generator::IrregularGeometryInputError` — the one
//!   typed-error carrier this file's public boundary constructs (TS:
//!   `services.ts:42-44`), reused rather than re-declared per this crate's
//!   convention of one Rust type per TS type.
//!
//! # Internal error shape
//!
//! Per this file's own `GeometryFailure`/`PathResult`/`OccupiedClipResult`/
//! `MaterialPathsResult` doc note in the governing characterization
//! (`canonical-grid.md`): "every helper returns either `{ readonly
//! <payload-key>: T }` or `{ readonly message: string }` ... A Rust port
//! should model this as an internal `Result<T, String>`-equivalent that gets
//! mapped to the typed error type exactly once at the boundary, not as a
//! typed error propagated through every internal helper." This module
//! follows that guidance literally: every private helper below returns
//! `Result<T, String>`, and only [`compute_free_material`]/
//! [`extend_free_material`] convert a `String` into an
//! [`IrregularGeometryInputError`], exactly once each, at the point TS's
//! `failInvalidGeometry` is called.
//!
//! # `booleanOpWithPolyTree`'s TS `try`/`catch` has no Rust equivalent
//!
//! TS: `freeMaterialService.ts:106-116` (`deriveSnapshotFromDifference`) and
//! `:152-157` (`prepareOccupiedClip`) each wrap `booleanOpWithPolyTree` in a
//! `try`/`catch`, converting a thrown error to a message via
//! `clipperFailureMessage`. `crate::clipper::engine`'s own module doc
//! (`Clipper64::execute_paths`/`execute_poly_tree`) establishes that "every
//! exception TS could throw from `executeInternal`/`buildPaths` in the
//! reachable (closed-paths-only) subset is unreachable dead code in this
//! port ... nothing throws on any input this API can construct" — i.e. the
//! ported `boolean_op_with_poly_tree` is infallible for any `Paths64` this
//! file can build (all of which pass this file's own coordinate-guard and
//! path-structure validation before ever reaching Clipper2). This module
//! therefore calls `boolean_op_with_poly_tree` directly, with no `Result`
//! wrapper around it, matching the same simplification `crate::clipper::engine`
//! itself already establishes as behavior-preserving (not a new judgment
//! call by this file). One consequence: `tests/unit/freeMaterialService.test.ts`'s
//! "converts an occupied-union failure into a typed error" case relies on a
//! `vi.mock` that force-throws directly at the `booleanOpWithPolyTree` call
//! site — a test-harness-only fault injection with no reachable Rust
//! equivalent (there is no seam to inject a failure into the vendored,
//! provably-infallible engine call without `catch_unwind`, which
//! `crate::clipper::engine`'s own doc comment already rules out as "silently
//! papering over a genuine port bug"). This is a known, deliberate parity
//! gap for that one mocked test case, not a behavior divergence for any
//! real input.

use std::collections::HashSet;

use crate::canonical_grid::{from_grid, to_grid_mm};
use crate::checkpoints::canonical_json::locale_compare_keys;
use crate::clipper::core::{area, ClipType, FillRule, Path64, Paths64, Point64};
use crate::clipper::engine::{boolean_op_with_poly_tree, poly_tree_to_paths64, PolyTree64};
use crate::clipper::offset::ClipperOffset;
use crate::domain::{
    FreeMaterialRegion, FreeMaterialSnapshot, IrregularGeometrySettings, IrregularPlacedPiece,
    IrregularPoint, IrregularPolygon, SheetSpec,
};
use crate::geometry::convex::validate_strict_boundary;
use crate::js_number::{fold_negative_zero, is_safe_integer, number_to_js_string};
use crate::transforms::generator::IrregularGeometryInputError;

/// TS: `freeMaterialService.ts:31` `export type FreeMaterialOperation =
/// 'union-then-difference' | 'direct-difference'`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FreeMaterialOperation {
    UnionThenDifference,
    DirectDifference,
}

/// TS: `services.ts:223-227` `ComputeFreeMaterialInput`. `settings` is part
/// of the TS interface's declared shape but is never read anywhere in
/// `freeMaterialService.ts`'s own logic (verified: no
/// `input.settings`/`input.geometrySettings` reference anywhere in that
/// file) — kept here for input-shape parity with the TS boundary, unused by
/// this module's algorithm.
#[derive(Clone, Debug, PartialEq)]
pub struct ComputeFreeMaterialInput {
    pub sheet: SheetSpec,
    pub placed: Vec<IrregularPlacedPiece>,
    pub settings: IrregularGeometrySettings,
}

/// TS: `services.ts:229-234` `ExtendFreeMaterialInput`. See
/// [`ComputeFreeMaterialInput`]'s doc comment for why `settings` is unused by
/// this module's algorithm despite being part of the input shape.
#[derive(Clone, Debug, PartialEq)]
pub struct ExtendFreeMaterialInput {
    pub parent: FreeMaterialSnapshot,
    pub placed: IrregularPlacedPiece,
    pub settings: IrregularGeometrySettings,
}

/// TS: `clipper2OffsetPolicy.ts:21` `CLIPPER2_OFFSET_POLICY.maxScaledCoordinate`.
/// Not re-exported by `crate::canonical_grid::offset_policy` (out of that
/// module's assigned scope per its own doc comment), so this file declares
/// its own copy, matching `freeMaterialService.ts`'s own direct import of the
/// same constant.
const MAX_SCALED_COORDINATE: f64 = 1_000_000_000.0;

// ---------------------------------------------------------------------------
// Public entry points.
//
// TS's `createFreeMaterialService(operation)` returns a closure-capturing
// service object; this port exposes the same two operations as plain
// functions instead (matching this crate's existing convention, e.g.
// `transforms::generator::generate_transforms`), with `operation` as an
// explicit parameter on `compute_free_material` (the only one of the two
// that ever branches on it — `extendFreeMaterial` never reads `operation` in
// TS either, see `deriveExtendedFreeMaterial`).
// ---------------------------------------------------------------------------

/// TS: `FreeMaterialServiceLive = Layer.succeed(FreeMaterialService,
/// createFreeMaterialService('union-then-difference'))` (`freeMaterialService.ts:34-37`).
/// The production entry point (see this module's liveness doc section).
pub fn compute_free_material_live(
    input: &ComputeFreeMaterialInput,
) -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
    compute_free_material(input, FreeMaterialOperation::UnionThenDifference)
}

/// TS: `deriveFreeMaterial` (`freeMaterialService.ts:47-76`), the body behind
/// `createFreeMaterialService(operation).computeFreeMaterial`.
pub fn compute_free_material(
    input: &ComputeFreeMaterialInput,
    operation: FreeMaterialOperation,
) -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
    let sheet_path =
        to_sheet_path(&input.sheet).map_err(|message| fail("computeFreeMaterial", message))?;

    let mut occupied_paths: Paths64 = Vec::with_capacity(input.placed.len());
    for (index, placed) in input.placed.iter().enumerate() {
        let path = to_placed_path(placed, index)
            .map_err(|message| fail("computeFreeMaterial", message))?;
        occupied_paths.push(path);
    }

    let occupied_clip = prepare_occupied_clip(operation, occupied_paths)
        .map_err(|message| fail("computeFreeMaterial", message))?;

    let subject_paths: Paths64 = vec![sheet_path];
    derive_snapshot_from_difference(
        &input.sheet,
        &subject_paths,
        occupied_clip.as_ref(),
        "computeFreeMaterial",
    )
}

/// TS: `deriveExtendedFreeMaterial` (`freeMaterialService.ts:78-97`). See
/// this module's liveness doc section: confirmed unreachable from production,
/// ported for `tests/unit/freeMaterialService.test.ts` parity (ruling R3).
pub fn extend_free_material(
    input: &ExtendFreeMaterialInput,
) -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
    // TS: `freeMaterialService.ts:81-82` — `sheetPath` is computed and its
    // failure propagated purely for its validation side effect; the actual
    // subject paths below come from `toMaterialPaths(input.parent)`, not
    // from `sheetPath` itself (a genuine TS oddity, preserved verbatim).
    let _sheet_path = to_sheet_path(&input.parent.sheet)
        .map_err(|message| fail("extendFreeMaterial", message))?;

    let material_paths =
        to_material_paths(&input.parent).map_err(|message| fail("extendFreeMaterial", message))?;

    let placed_path =
        to_placed_path(&input.placed, 0).map_err(|message| fail("extendFreeMaterial", message))?;

    let clip_paths: Paths64 = vec![placed_path];
    derive_snapshot_from_difference(
        &input.parent.sheet,
        &material_paths,
        Some(&clip_paths),
        "extendFreeMaterial",
    )
}

fn fail(operation: &str, message: String) -> IrregularGeometryInputError {
    IrregularGeometryInputError {
        operation: operation.to_string(),
        message,
    }
}

// ---------------------------------------------------------------------------
// `deriveSnapshotFromDifference` (freeMaterialService.ts:99-135).
// ---------------------------------------------------------------------------

fn derive_snapshot_from_difference(
    sheet: &SheetSpec,
    subject_paths: &Paths64,
    clip_paths: Option<&Paths64>,
    operation: &str,
) -> Result<FreeMaterialSnapshot, IrregularGeometryInputError> {
    let mut tree = PolyTree64::new();
    // See this module's doc comment "`booleanOpWithPolyTree`'s TS `try`/`catch`
    // has no Rust equivalent" for why no error handling wraps this call.
    boolean_op_with_poly_tree(
        ClipType::Difference,
        Some(subject_paths),
        clip_paths,
        &mut tree,
        FillRule::NonZero,
    );

    let regions = regions_from_tree(&tree).map_err(|message| fail(operation, message))?;

    let mut ordered_regions = regions;
    ordered_regions.sort_by(compare_regions);

    let regions = ordered_regions
        .into_iter()
        .map(|region| {
            let mut holes = region.holes;
            holes.sort_by(compare_polygons_ref);
            FreeMaterialRegion {
                boundary: region.boundary,
                holes,
            }
        })
        .collect();

    Ok(FreeMaterialSnapshot {
        sheet: sheet.clone(),
        regions,
        diagnostics: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// `prepareOccupiedClip` (freeMaterialService.ts:137-173).
// ---------------------------------------------------------------------------

fn prepare_occupied_clip(
    operation: FreeMaterialOperation,
    occupied_paths: Paths64,
) -> Result<Option<Paths64>, String> {
    if occupied_paths.is_empty() {
        return Ok(None);
    }
    if operation == FreeMaterialOperation::DirectDifference {
        return Ok(Some(occupied_paths));
    }

    let mut occupied_tree = PolyTree64::new();
    // See this module's doc comment "`booleanOpWithPolyTree`'s TS `try`/`catch`
    // has no Rust equivalent" for why no error handling wraps this call.
    boolean_op_with_poly_tree(
        ClipType::Union,
        Some(&occupied_paths),
        None,
        &mut occupied_tree,
        FillRule::NonZero,
    );

    let occupied_union = poly_tree_to_paths64(&occupied_tree);
    if occupied_union.is_empty() {
        return Err(
            "Clipper2 union returned no occupied geometry for non-empty input.".to_string(),
        );
    }

    for (index, union_path) in occupied_union.iter().enumerate() {
        validate_coordinate_guard(union_path)?;
        validate_clipper_output_path(union_path, &format!("Clipper2 union path {index}"))?;
    }

    Ok(Some(occupied_union))
}

// ---------------------------------------------------------------------------
// `toSheetPath` (freeMaterialService.ts:183-202).
// ---------------------------------------------------------------------------

fn to_sheet_path(sheet: &SheetSpec) -> Result<Path64, String> {
    let (width, height) = match (to_grid_mm(sheet.width), to_grid_mm(sheet.height)) {
        (Some(width), Some(height)) => (width, height),
        _ => {
            return Err(
                "sheet dimensions cannot be represented by the Clipper2 integer grid.".to_string(),
            );
        }
    };

    let path: Path64 = vec![
        Point64::new(0.0, 0.0, 0.0),
        Point64::new(width, 0.0, 0.0),
        Point64::new(width, height, 0.0),
        Point64::new(0.0, height, 0.0),
    ];
    validate_coordinate_guard(&path)?;
    validate_path(&path, "sheet path")?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// `toMaterialPaths`/`toMaterialPath` (freeMaterialService.ts:204-256).
// ---------------------------------------------------------------------------

fn to_material_paths(snapshot: &FreeMaterialSnapshot) -> Result<Paths64, String> {
    let mut paths: Paths64 = Vec::new();
    for (region_index, region) in snapshot.regions.iter().enumerate() {
        let boundary_label = format!("free-material boundary {region_index}");
        let boundary = to_material_path(&region.boundary, &boundary_label, true)?;
        paths.push(boundary);

        for (hole_index, hole) in region.holes.iter().enumerate() {
            let hole_label = format!("free-material hole {region_index}:{hole_index}");
            let hole_path = to_material_path(hole, &hole_label, false)?;
            paths.push(hole_path);
        }
    }
    Ok(paths)
}

fn to_material_path(
    polygon: &IrregularPolygon,
    label: &str,
    counter_clockwise: bool,
) -> Result<Path64, String> {
    let mut path: Path64 = Vec::with_capacity(polygon.points.len());
    for point in &polygon.points {
        let (x, y) = match (to_grid_mm(point.x), to_grid_mm(point.y)) {
            (Some(x), Some(y)) => (x, y),
            _ => {
                return Err(format!(
                    "{label} cannot be represented by the Clipper2 grid."
                ))
            }
        };
        path.push(Point64::new(
            fold_negative_zero(x),
            fold_negative_zero(y),
            0.0,
        ));
    }

    let normalized_path = ClipperOffset::strip_duplicates(&path, true);
    validate_coordinate_guard(&normalized_path).map_err(|guard| format!("{label}: {guard}"))?;
    validate_clipper_output_path(&normalized_path, label)?;

    Ok(canonicalize_winding(normalized_path, counter_clockwise))
}

// ---------------------------------------------------------------------------
// `toPlacedPath` (freeMaterialService.ts:258-298).
// ---------------------------------------------------------------------------

fn to_placed_path(placed: &IrregularPlacedPiece, index: usize) -> Result<Path64, String> {
    let boundary_validation = validate_strict_boundary(&placed.collision_geometry.polygon.points);
    if let Some(message) = boundary_validation.message() {
        return Err(format!("placed collision polygon {index} {message}"));
    }

    let mut path: Path64 = Vec::with_capacity(placed.collision_geometry.polygon.points.len());
    for point in &placed.collision_geometry.polygon.points {
        let translated_x = point.x + placed.placement.transform.translate_x;
        let translated_y = point.y + placed.placement.transform.translate_y;
        if !translated_x.is_finite() || !translated_y.is_finite() {
            return Err(format!(
                "placed collision polygon {index} translation is not finite."
            ));
        }

        let (x, y) = match (to_grid_mm(translated_x), to_grid_mm(translated_y)) {
            (Some(x), Some(y)) => (x, y),
            _ => {
                return Err(format!(
                    "placed collision polygon {index} cannot be represented by the Clipper2 grid."
                ));
            }
        };
        path.push(Point64::new(
            fold_negative_zero(x),
            fold_negative_zero(y),
            0.0,
        ));
    }

    validate_coordinate_guard(&path)?;
    validate_path(&path, &format!("placed collision polygon {index}"))?;
    Ok(canonicalize_counter_clockwise(path))
}

/// TS: `canonicalizeCounterClockwise` (`freeMaterialService.ts:305-307`).
///
/// `NonZero` treats opposite windings as subtraction. Every occupied input
/// must therefore use the same counter-clockwise winding before the union,
/// including paths produced by mirrored transforms.
fn canonicalize_counter_clockwise(path: Path64) -> Path64 {
    canonicalize_winding(path, true)
}

/// TS: `canonicalizeWinding` (`freeMaterialService.ts:309-312`).
fn canonicalize_winding(path: Path64, counter_clockwise: bool) -> Path64 {
    let is_counter_clockwise = area(&path) > 0.0;
    if is_counter_clockwise == counter_clockwise {
        path
    } else {
        let mut reversed = path;
        reversed.reverse();
        reversed
    }
}

// ---------------------------------------------------------------------------
// Validation helpers (freeMaterialService.ts:314-368).
// ---------------------------------------------------------------------------

fn validate_coordinate_guard(path: &Path64) -> Result<(), String> {
    for point in path {
        if !is_safe_integer(point.x)
            || !is_safe_integer(point.y)
            || point.x.abs() > MAX_SCALED_COORDINATE
            || point.y.abs() > MAX_SCALED_COORDINATE
        {
            return Err("coordinates exceed the Clipper2 scaled coordinate guard.".to_string());
        }
    }
    Ok(())
}

/// TS: `validatePath` (`freeMaterialService.ts:329-331`).
fn validate_path(path: &Path64, label: &str) -> Result<(), String> {
    validate_path_structure(path, label, true)
}

/// TS: `validateClipperOutputPath` (`freeMaterialService.ts:333-340`).
///
/// Validates a computed Clipper2 boundary without rejecting a non-adjacent
/// repeated point created when material regions meet at one exact point.
/// Winding retains the correct net area of that diagnostic-only topology.
fn validate_clipper_output_path(path: &Path64, label: &str) -> Result<(), String> {
    validate_path_structure(path, label, false)
}

/// TS: `validatePathStructure` (`freeMaterialService.ts:342-368`).
fn validate_path_structure(
    path: &Path64,
    label: &str,
    require_unique_vertices: bool,
) -> Result<(), String> {
    if path.len() < 3 {
        return Err(format!("{label} must contain at least three vertices."));
    }

    let mut unique_points: HashSet<String> = HashSet::new();
    for point in path {
        if !is_safe_integer(point.x) || !is_safe_integer(point.y) {
            return Err(format!("{label} contains an unsafe integer coordinate."));
        }

        let key = format!(
            "{}:{}",
            number_to_js_string(point.x),
            number_to_js_string(point.y)
        );
        if require_unique_vertices && unique_points.contains(&key) {
            return Err(format!("{label} must contain unique vertices."));
        }
        unique_points.insert(key);
    }

    let signed_area = area(path);
    if !signed_area.is_finite() || signed_area == 0.0 {
        return Err(format!("{label} must have finite non-zero area."));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// `regionsFromTree`/`collectTreeChildren` (freeMaterialService.ts:370-426).
// ---------------------------------------------------------------------------

struct MaterialRegionArtifact {
    boundary: IrregularPolygon,
    holes: Vec<IrregularPolygon>,
}

fn regions_from_tree(tree: &PolyTree64) -> Result<Vec<MaterialRegionArtifact>, String> {
    let mut regions: Vec<MaterialRegionArtifact> = Vec::new();
    collect_tree_children(tree, PolyTree64::ROOT, &mut regions)?;
    Ok(regions)
}

fn collect_tree_children(
    tree: &PolyTree64,
    parent: usize,
    regions: &mut Vec<MaterialRegionArtifact>,
) -> Result<(), String> {
    // TS: `parent.child(index)` throwing (`freeMaterialService.ts:392-396`) has
    // no reachable Rust equivalent here: this loop always iterates
    // `0..tree.count(parent)`, so `tree.child(parent, index)` is always
    // in-range (see `PolyTree64::child`'s own doc comment for the same
    // established convention elsewhere in this crate).
    for index in 0..tree.count(parent) {
        let child = tree.child(parent, index);

        let child_polygon = tree
            .poly(child)
            .ok_or_else(|| "Clipper2 returned a polygon node without a path.".to_string())?;

        if !tree.is_hole(child) {
            let boundary = polygon_from_path(child_polygon, "free-material boundary")?;

            let mut holes: Vec<IrregularPolygon> = Vec::new();
            for hole_index in 0..tree.count(child) {
                let hole = tree.child(child, hole_index);
                if !tree.is_hole(hole) {
                    continue;
                }
                let hole_path = tree
                    .poly(hole)
                    .ok_or_else(|| "Clipper2 returned a hole node without a path.".to_string())?;
                let hole_polygon = polygon_from_path(hole_path, "free-material hole")?;
                holes.push(hole_polygon);
            }
            regions.push(MaterialRegionArtifact { boundary, holes });
        }

        collect_tree_children(tree, child, regions)?;
    }

    Ok(())
}

/// TS: `polygonFromPath` (`freeMaterialService.ts:432-443`).
fn polygon_from_path(path: &Path64, label: &str) -> Result<IrregularPolygon, String> {
    let normalized_path = normalize_clipper_output_path(path);
    validate_coordinate_guard(&normalized_path).map_err(|guard| format!("{label}: {guard}"))?;
    validate_clipper_output_path(&normalized_path, label)?;

    let points: Vec<IrregularPoint> = normalized_path
        .iter()
        .map(|point| IrregularPoint::new(from_grid(point.x), from_grid(point.y)))
        .collect();
    Ok(IrregularPolygon::new(rotate_to_stable_start(points)))
}

/// TS: `normalizeClipperOutputPath` (`freeMaterialService.ts:445-453`).
///
/// Normalizes redundant consecutive and closing vertices emitted by
/// Clipper2. A non-adjacent repeated point is preserved because it can
/// encode a valid point contact in the diagnostic material boundary; source
/// input remains subject to strict unique-vertex validation before boolean
/// operations.
fn normalize_clipper_output_path(path: &Path64) -> Path64 {
    ClipperOffset::strip_duplicates(path, true)
}

// ---------------------------------------------------------------------------
// Ordering (freeMaterialService.ts:455-471).
// ---------------------------------------------------------------------------

fn compare_regions(
    first: &MaterialRegionArtifact,
    second: &MaterialRegionArtifact,
) -> std::cmp::Ordering {
    compare_polygons(&first.boundary, &second.boundary)
}

fn compare_polygons_ref(first: &IrregularPolygon, second: &IrregularPolygon) -> std::cmp::Ordering {
    compare_polygons(first, second)
}

/// TS: `comparePolygons` (`freeMaterialService.ts:459-467`).
///
/// `firstPoint.y - secondPoint.y`/`firstPoint.x - secondPoint.x` are plain
/// `Number` subtraction of already-`fromGrid`-dequantized mm coordinates
/// used only for their sign as a sort-comparator return value; direct
/// less-than/greater-than comparison on the same (guaranteed-finite,
/// already-`!==`-gated) operands yields the identical `Ordering` without
/// depending on subtraction's sign matching `<`/`>` (which it does for every
/// finite non-equal `f64` pair, but this is more direct).
fn compare_polygons(first: &IrregularPolygon, second: &IrregularPolygon) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    match (first.points.first(), second.points.first()) {
        (Some(first_point), Some(second_point)) => {
            if first_point.y != second_point.y {
                return if first_point.y < second_point.y {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            if first_point.x != second_point.x {
                return if first_point.x < second_point.x {
                    Ordering::Less
                } else {
                    Ordering::Greater
                };
            }
            locale_compare_keys(&polygon_key(first), &polygon_key(second))
        }
        _ => first.points.len().cmp(&second.points.len()),
    }
}

/// TS: `polygonKey` (`freeMaterialService.ts:469-471`).
fn polygon_key(polygon: &IrregularPolygon) -> String {
    polygon
        .points
        .iter()
        .map(|point| {
            format!(
                "{}:{}",
                number_to_js_string(point.x),
                number_to_js_string(point.y)
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// TS: `rotateToStableStart` (`freeMaterialService.ts:473-485`).
fn rotate_to_stable_start(points: Vec<IrregularPoint>) -> Vec<IrregularPoint> {
    let mut start_index = 0usize;
    for index in 1..points.len() {
        let candidate = points[index];
        let current = points[start_index];
        if candidate.y < current.y || (candidate.y == current.y && candidate.x < current.x) {
            start_index = index;
        }
    }

    let mut rotated = Vec::with_capacity(points.len());
    rotated.extend_from_slice(&points[start_index..]);
    rotated.extend_from_slice(&points[..start_index]);
    rotated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        IrregularBounds, IrregularPlacement, IrregularTransform, IrregularTransformCandidate,
        IrregularTransformReason, PieceId, TransformedCollisionGeometry,
    };

    fn point(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    fn bounds(points: &[IrregularPoint]) -> IrregularBounds {
        let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        IrregularBounds::new(min_x, min_y, max_x, max_y)
    }

    fn placed_piece(
        piece_id: &str,
        points: Vec<IrregularPoint>,
        translate_x: f64,
        translate_y: f64,
        mirrored: bool,
    ) -> IrregularPlacedPiece {
        let piece_bounds = bounds(&points);
        let polygon = IrregularPolygon::new(points);
        IrregularPlacedPiece {
            placement: IrregularPlacement {
                piece_id: None,
                source_piece_id: PieceId::new(piece_id),
                placement_reference: None,
                transform: IrregularTransform {
                    translate_x,
                    translate_y,
                    rotation_deg: 0.0,
                    mirrored,
                },
            },
            collision_geometry: TransformedCollisionGeometry {
                source_piece_id: PieceId::new(piece_id),
                transform: IrregularTransformCandidate {
                    index: 0.0,
                    rotation_deg: 0.0,
                    mirrored,
                    reason: IrregularTransformReason::Configured,
                },
                polygon,
                bounds: piece_bounds,
            },
        }
    }

    fn rectangle(
        piece_id: &str,
        width: f64,
        height: f64,
        translate_x: f64,
        translate_y: f64,
    ) -> IrregularPlacedPiece {
        placed_piece(
            piece_id,
            vec![
                point(0.0, 0.0),
                point(width, 0.0),
                point(width, height),
                point(0.0, height),
            ],
            translate_x,
            translate_y,
            false,
        )
    }

    fn geometry_settings() -> IrregularGeometrySettings {
        IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "test".to_string(),
            geometry_backend_version: "0".to_string(),
        }
    }

    fn compute_input(placed: Vec<IrregularPlacedPiece>) -> ComputeFreeMaterialInput {
        ComputeFreeMaterialInput {
            sheet: SheetSpec {
                width: 10.0,
                height: 8.0,
                label: "test sheet".to_string(),
            },
            placed,
            settings: geometry_settings(),
        }
    }

    #[test]
    fn returns_the_whole_sheet_with_no_holes_when_there_are_no_placements() {
        let snapshot = compute_free_material_live(&compute_input(vec![])).expect("succeeds");
        assert_eq!(snapshot.regions.len(), 1);
        assert_eq!(
            snapshot.regions[0].boundary.points,
            vec![
                point(0.0, 0.0),
                point(10.0, 0.0),
                point(10.0, 8.0),
                point(0.0, 8.0),
            ]
        );
        assert!(snapshot.regions[0].holes.is_empty());
        assert!(snapshot.diagnostics.is_empty());
    }

    #[test]
    fn represents_one_interior_placement_as_one_region_with_one_hole() {
        let snapshot = compute_free_material_live(&compute_input(vec![rectangle(
            "interior", 2.0, 2.0, 4.0, 3.0,
        )]))
        .expect("succeeds");
        assert_eq!(snapshot.regions.len(), 1);
        assert_eq!(snapshot.regions[0].boundary.points[0], point(0.0, 0.0));
        assert_eq!(snapshot.regions[0].holes.len(), 1);
        assert_eq!(snapshot.regions[0].holes[0].points[0], point(4.0, 3.0));
    }

    #[test]
    fn does_not_create_a_hole_for_border_touching_geometry() {
        let snapshot = compute_free_material_live(&compute_input(vec![rectangle(
            "border-touch",
            4.0,
            2.0,
            0.0,
            3.0,
        )]))
        .expect("succeeds");
        assert_eq!(snapshot.regions.len(), 1);
        assert!(snapshot.regions[0].holes.is_empty());
    }

    #[test]
    fn accepts_occupied_polygons_that_meet_at_one_exact_point() {
        let snapshot = compute_free_material_live(&compute_input(vec![
            rectangle("lower", 2.0, 2.0, 1.0, 1.0),
            rectangle("upper", 2.0, 2.0, 3.0, 3.0),
        ]))
        .expect("succeeds");
        assert_eq!(snapshot.regions.len(), 1);
        assert_eq!(snapshot.regions[0].holes.len(), 2);
    }

    #[test]
    fn orders_holes_deterministically_by_stable_lowest_y_then_lowest_x() {
        let snapshot = compute_free_material_live(&compute_input(vec![
            rectangle("first-hole", 2.0, 2.0, 1.0, 1.0),
            rectangle("second-hole", 2.0, 2.0, 6.0, 3.0),
        ]))
        .expect("succeeds");
        let holes = &snapshot.regions[0].holes;
        assert_eq!(holes.len(), 2);
        assert_eq!(holes[0].points[0], point(1.0, 1.0));
        assert_eq!(holes[1].points[0], point(6.0, 3.0));
    }

    #[test]
    fn canonicalizes_mixed_mirrored_windings_before_the_nonzero_occupied_union() {
        let clockwise_square = vec![
            point(0.0, 2.0),
            point(2.0, 2.0),
            point(2.0, 0.0),
            point(0.0, 0.0),
        ];
        let snapshot = compute_free_material_live(&compute_input(vec![
            rectangle("unmirrored", 2.0, 2.0, 2.0, 2.0),
            placed_piece("mirrored-clockwise", clockwise_square, 3.0, 2.0, true),
            rectangle("touching", 2.0, 2.0, 5.0, 2.0),
        ]))
        .expect("succeeds");
        assert_eq!(snapshot.regions.len(), 1);
        assert_eq!(snapshot.regions[0].holes.len(), 1);
        assert_eq!(snapshot.regions[0].holes[0].points[0], point(2.0, 2.0));
    }

    #[test]
    fn returns_no_regions_when_the_placed_geometry_covers_the_whole_sheet() {
        let snapshot = compute_free_material_live(&compute_input(vec![rectangle(
            "full-sheet",
            10.0,
            8.0,
            0.0,
            0.0,
        )]))
        .expect("succeeds");
        assert!(snapshot.regions.is_empty());
    }

    #[test]
    fn rejects_malformed_non_convex_collision_geometry_with_a_typed_error() {
        let invalid = placed_piece(
            "invalid",
            vec![
                point(0.0, 0.0),
                point(4.0, 0.0),
                point(2.0, 1.0),
                point(4.0, 4.0),
                point(0.0, 4.0),
            ],
            0.0,
            0.0,
            false,
        );
        let failure = compute_free_material_live(&compute_input(vec![invalid]))
            .expect_err("non-convex geometry must fail");
        assert_eq!(failure.operation, "computeFreeMaterial");
    }

    #[test]
    fn direct_difference_matches_union_then_difference_for_disjoint_placements() {
        let input = compute_input(vec![
            rectangle("disjoint-left", 2.0, 2.0, 1.0, 1.0),
            rectangle("disjoint-right", 2.0, 2.0, 6.0, 3.0),
        ]);
        let union_then_difference =
            compute_free_material(&input, FreeMaterialOperation::UnionThenDifference)
                .expect("succeeds");
        let direct_difference =
            compute_free_material(&input, FreeMaterialOperation::DirectDifference)
                .expect("succeeds");
        assert_eq!(
            canonical_regions(&union_then_difference),
            canonical_regions(&direct_difference)
        );
    }

    #[test]
    fn extend_free_material_matches_full_recomputation_after_each_addition() {
        let pieces = vec![
            rectangle("sheet-wall", 2.0, 8.0, 4.0, 0.0),
            rectangle("left-hole", 2.0, 2.0, 1.0, 1.0),
            rectangle("right-hole", 2.0, 2.0, 7.0, 4.0),
        ];
        let sheet = SheetSpec {
            width: 10.0,
            height: 8.0,
            label: "test sheet".to_string(),
        };

        let mut incremental_snapshot =
            compute_free_material_live(&compute_input(vec![])).expect("empty succeeds");
        let mut placed: Vec<IrregularPlacedPiece> = Vec::new();

        for next_placed in pieces {
            placed.push(next_placed.clone());
            incremental_snapshot = extend_free_material(&ExtendFreeMaterialInput {
                parent: incremental_snapshot,
                placed: next_placed,
                settings: geometry_settings(),
            })
            .expect("extend succeeds");

            let full_snapshot = compute_free_material_live(&ComputeFreeMaterialInput {
                sheet: sheet.clone(),
                placed: placed.clone(),
                settings: geometry_settings(),
            })
            .expect("full recompute succeeds");

            assert_eq!(
                canonical_regions(&incremental_snapshot),
                canonical_regions(&full_snapshot)
            );
            assert_eq!(incremental_snapshot.sheet, full_snapshot.sheet);
            assert_eq!(incremental_snapshot.diagnostics, full_snapshot.diagnostics);
        }
    }

    type CanonicalRegion = (Vec<(f64, f64)>, Vec<Vec<(f64, f64)>>);

    fn canonical_regions(snapshot: &FreeMaterialSnapshot) -> Vec<CanonicalRegion> {
        snapshot
            .regions
            .iter()
            .map(|region| {
                (
                    region.boundary.points.iter().map(|p| (p.x, p.y)).collect(),
                    region
                        .holes
                        .iter()
                        .map(|hole| hole.points.iter().map(|p| (p.x, p.y)).collect())
                        .collect(),
                )
            })
            .collect()
    }
}
