//! Compact Short Side directional construction cluster.
//!
//! TS counterparts (each ported in full into its own same-named submodule
//! below): `src/workers/algorithm/irregular/intrinsicShortSideAxes.ts`,
//! `intrinsicShortSideObserver.ts`, `intrinsicShortSidePairFoldObserver.ts`,
//! and `intrinsicShortSideContactStrip.ts`.
//!
//! Read `docs/planning/rust-irregular-backend/characterization/short-side.md`
//! and migration prompt §12 before touching any file in this directory.
//!
//! # The non-negotiable contract (prompt §12, characterization §1)
//!
//! Short Side is a **directional construction**, never a different scoring
//! view over Compact geometry:
//!
//! 1. Compact (out of this cluster's scope) first selects the exact placed
//!    and unplaced piece-ID partition.
//! 2. [`observer::observe_intrinsic_short_side_orientations`] receives that
//!    settled partition's *ranked archive* (only for evidence -- see its
//!    own module doc, Finding 1) and independently constructs directional
//!    geometry.
//! 3. [`pair_fold::observe_intrinsic_short_side_pair_fold`] is the **sole
//!    authoritative** terminal constructor: it always constructs new
//!    directional geometry for exactly the Compact-selected placed IDs,
//!    reports exactly the same unplaced IDs, and never returns Compact
//!    geometry as a fallback.
//! 4. If no valid directional construction exists for the complete target
//!    set, the caller (out of this cluster's scope, `computeIrregularNesting.ts`)
//!    raises `IrregularNoValidResultError` -> `irregular_no_valid_result`.
//!
//! # Portfolio order (prompt §12, preserved exactly by `pair_fold`)
//!
//! 1. exact pair-fold and multi-row shelf
//! 2. protected prepared-order depth-first contact strip
//! 3. capped contact-first strip with resumable depth-first decisions
//! 4. bounded reverse-depth and canonical-ID continuations for eligible
//!    small partitions (`<= 8` pieces) after prepared-order failure
//!
//! # Physical axes (prompt §12, `axes` module)
//!
//! Square sheets deterministically use physical Y as the short axis and
//! physical X as the long axis; see [`axes::intrinsic_short_side_axes`]'s
//! own doc for the exact mechanism.
//!
//! # The exact contact tuple (prompt §12, `contact_strip` module)
//!
//! Diagonal and axis-aligned contacts both contribute to positive-contact
//! count; only axis-aligned overlap contributes to projected-length
//! tie-breaking, via
//! `canonical_grid::contact::measure_canonical_grid_boundary_overlap_axis_units`
//! (the cancellation hook is preserved verbatim in that GREEN module).

pub mod axes;
pub mod contact_strip;
pub(crate) mod json;
pub mod observer;
pub mod pair_fold;

pub use axes::{
    intrinsic_short_side_axes, intrinsic_short_side_span, IntrinsicShortSideAxes,
    ShortSideAxisDimension, ShortSideDimensions, ShortSideRotationDeg,
};
pub use contact_strip::{
    construct_intrinsic_short_side_contact_strip, ConstructIntrinsicShortSideContactStripInput,
    IntrinsicShortSideContactStripOrderPolicy, IntrinsicShortSideContactStripOutcome,
    IntrinsicShortSideContactStripRuntimeControl, IntrinsicShortSideContactStripSelectionPolicy,
    IntrinsicShortSideContactStripStatus, IntrinsicShortSideContactStripTieEvidence,
    IntrinsicShortSideContactStripTrace, INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_BACKTRACKS,
    INTRINSIC_SHORT_SIDE_CONTACT_FIRST_MAX_CANDIDATE_EVALUATIONS,
    INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RSS_DELTA_BYTES,
    INTRINSIC_SHORT_SIDE_CONTACT_STRIP_MAX_RUNTIME_MS, INTRINSIC_SHORT_SIDE_CONTACT_STRIP_VERSION,
};
pub use observer::{
    intrinsic_short_side_envelope_area_cost_within_production_bound,
    observe_intrinsic_short_side_orientations, ComparisonTupleEntry,
    IntrinsicSharedArchiveEndpoint, IntrinsicShortSideDirectionalAdmissionTerms,
    IntrinsicShortSideEndpointObservation, IntrinsicShortSideObserverStatus,
    IntrinsicShortSideObserverTrace, IntrinsicShortSideOrientationObservation,
    ObserveIntrinsicShortSideOrientationsInput, ShortSideOutputInfluence,
    INTRINSIC_SHORT_SIDE_OBSERVER_MAX_RUNTIME_MS, INTRINSIC_SHORT_SIDE_OBSERVER_MAX_TRACE_BYTES,
    INTRINSIC_SHORT_SIDE_OBSERVER_VERSION,
};
pub use pair_fold::{
    observe_intrinsic_short_side_pair_fold, IntrinsicShortSideConstructionKind,
    IntrinsicShortSideConstructionSummary, IntrinsicShortSideContactStripPromotion,
    IntrinsicShortSideEnvelopeAreaCostVeto, IntrinsicShortSideInterlockingMetrics,
    IntrinsicShortSidePairFoldAdmission, IntrinsicShortSidePairFoldInput,
    IntrinsicShortSidePairFoldOutcome, IntrinsicShortSidePairFoldRuntimeControl,
    IntrinsicShortSidePairFoldStatus, IntrinsicShortSidePairFoldTrace,
    INTRINSIC_SHORT_SIDE_ORDER_CONTINUATION_MAX_PIECES,
    INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RSS_DELTA_BYTES,
    INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_RUNTIME_MS, INTRINSIC_SHORT_SIDE_PAIR_FOLD_MAX_TRACE_BYTES,
    INTRINSIC_SHORT_SIDE_PAIR_FOLD_OBSERVER_VERSION,
};
