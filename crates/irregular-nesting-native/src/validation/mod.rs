//! TS counterpart: src/workers/irregular/placementValidation.ts and src/workers/irregular/placedCollisionSpatialIndex.ts (robust legality checks and placed-collision spatial indexing).
//!
//! Submodules owned by this task:
//! - [`placement`] — full port of `placementValidation.ts`: the exact,
//!   epsilon-free translated-polygon legality assessment (`assessPlacement`
//!   and its `check`/`checkSheetless`/`validate` wrappers).
//! - [`spatial_index`] — full port of `placedCollisionSpatialIndex.ts`: the
//!   persistent uniform-grid broad-phase index over placed pieces'
//!   translated collision polygons.
//! - [`sat`] — full port of `convexSatPenetration.ts` (ported per explicit
//!   task instruction; see that module's doc comment for the liveness
//!   caveat carried over from
//!   `docs/planning/rust-irregular-backend/characterization/validation-spatial.md`
//!   §1/§15).
//!
//! Reuses, never duplicates: `geometry::predicates::orientation`,
//! `geometry::convex::{validate_strict_boundary, bounds_for_points,
//! translate_polygon_with_bounds, are_disjoint}`, `js_number::js_math`.

pub mod placement;
pub mod sat;
pub mod spatial_index;
