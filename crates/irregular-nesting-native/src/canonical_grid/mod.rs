//! TS counterpart: src/workers/irregular/canonicalGridMath.ts and src/workers/irregular/canonicalGridContact.ts (exact canonical-grid arithmetic and contact terms).
//!
//! This module currently ports `canonicalGridMath.ts` in full (see [`math`])
//! plus the float<->grid quantization authority `toGridMm`/`fromGrid` from
//! `src/workers/irregular/clipper2OffsetPolicy.ts` (see [`offset_policy`]).
//! `canonicalGridContact.ts`'s contact-measurement functions are a separate
//! module's assignment and are not ported here.

pub mod contact;
mod js_local;
pub mod layout;
mod math;
mod offset_policy;

pub use math::{
    canonical_grid_absolute_doubled_area, canonical_grid_clockwise, canonical_grid_compare_bigints,
    canonical_grid_compare_ratios, canonical_grid_convex_hull, canonical_grid_counter_clockwise,
    canonical_grid_cross, canonical_grid_cross_sign, canonical_grid_point_on_segment,
    canonical_grid_signed_doubled_area, doubled_grid_area_to_mm2, CanonicalGridPath,
    CanonicalGridPoint, CANONICAL_GRID_EXACT_NUMBER_CROSS_LIMIT,
};
pub use offset_policy::{from_grid, to_grid_mm};
