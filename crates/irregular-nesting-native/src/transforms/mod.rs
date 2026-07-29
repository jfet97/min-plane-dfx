//! TS counterpart: src/workers/irregular/transformGenerator.ts (transform generation and adaptive Compact transform policy).
//!
//! Submodules owned by this task (transform enumeration/generation and its
//! adaptive Compact policy):
//! - [`generator`] — full port of `transformGenerator.ts`: finite
//!   orientation-candidate enumeration, the adaptive Compact edge/angle
//!   policy, near-angle deduplication, transform-cap selection, and the
//!   candidate output order.
//! - [`rotate`] — the pure rotation/mirror point-application math ported
//!   from `core/transformCollisionGeometryCore.ts`'s `transformPoint`/
//!   `normalizeRotationDegrees` (that TS file's full cache/key/resolver
//!   surface belongs to the `nfp_ifp` cluster per
//!   `docs/planning/rust-irregular-backend/semantic-mapping.md`'s
//!   `core::geometry::nfp_ifp::transform_collision_geometry_core` row — only
//!   this self-contained point-math primitive is ported here, so a future
//!   `nfp_ifp` port can reuse it instead of duplicating the trig).
//! - `boundary_check` (private) — a scoped, non-`pub` local port of
//!   `convexPolygonValidation.ts`'s `validateStrictBoundary`, needed as a
//!   precondition check by `generator::generate_transforms` itself. Full
//!   ownership of `ConvexPolygonValidation` belongs to the
//!   `validation-spatial` characterization cluster
//!   (`core::geometry::validate::convex_polygon_validation`, see
//!   `semantic-mapping.md`), which is expected to land its own
//!   crate-wide `crate::validation`/`crate::geometry::convex` port later;
//!   this module's copy is intentionally **not** `pub` outside
//!   `crate::transforms` so it cannot become a second competing public
//!   implementation. It also intentionally omits `convexPolygonValidation.ts`'s
//!   guarded "linear ring topology" fast path (`supportsLinearTopologyDecision`/
//!   `completesOneRevolution`) and always uses the reference `O(n^2)`
//!   non-adjacent-edge sweep (`hasSelfIntersection`) instead: the TS module's
//!   own documentation and its `convexPolygonValidationTopology.test.ts`
//!   oracle (>6,500 generated cases) establish that the fast path is a pure
//!   performance optimization that always agrees with the slow path within
//!   its guarded envelope, never a source of a different message or winding
//!   — so this is a behaviorally-exact, not just "close enough", simplification
//!   for the transform generator's typically-small (well under 100-vertex)
//!   convex collision polygons. Whoever ports the `validation-spatial`
//!   cluster should consolidate both copies rather than keep them
//!   independently maintained once that lands.
//!
//! `mod flattening` (curve-to-polyline sampling) is a **different** task's
//! file and is intentionally left untouched by this module doc/re-export
//! surface.

mod boundary_check;
pub mod generator;
pub mod rotate;

// `pub(crate)` per `flattening`'s own module doc ("Module visibility note"):
// this is the "later wiring task" that anticipated note describes — the
// `geometry::collision_builder` module (a different task, ported per
// `docs/planning/rust-irregular-backend/characterization/collision-prep.md`)
// is `flattenSourceGeometry`'s sole caller-equivalent and needs
// `arc::sample_points`/`arc::sample_bulge_points`/`ellipse::sample_points`
// directly, per this crate's "GREEN modules to reuse, never duplicate"
// convention. `pub(crate)` (not full `pub`) keeps this an internal-only
// reuse surface, matching every other cross-module dependency in this crate.
pub(crate) mod flattening;
