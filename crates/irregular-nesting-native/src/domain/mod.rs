//! Shared trusted domain-type layer for the irregular nesting algorithm.
//!
//! TS counterparts (read in full to build this module): `src/shared/irregular/domain.ts`
//! (the trusted plain classes constructed *after* TS Effect-Schema
//! validation — migration prompt §4.1: "trusted request conversion after
//! TypeScript schema validation" is in scope for this port, the *validation*
//! itself is not), `src/workers/irregular/internalGeometry.ts` (the
//! `Internal*` structural-typing vocabulary the pure `core/*` TS modules are
//! typed against), plus the handful of `src/shared/domain/*.ts` shapes those
//! two files depend on (`ids.ts`, `dxf.ts`, `geometry.ts`'s `Rect`,
//! `nesting.ts`'s `SheetSpec`). Per
//! `docs/planning/rust-irregular-backend/semantic-mapping.md`, this module is
//! the `core::domain` row for `domain.ts`/`ids.ts`/the relevant `dxf.ts`/
//! `nesting.ts`/`geometry.ts` subset.
//!
//! # Serde is for test-vector IO only
//!
//! Every type here derives `serde::{Serialize, Deserialize}` so unit and
//! vector tests can round-trip fixture/generated JSON. **This is not the
//! crate's semantic/canonical encoding.** Hash-preimage and cache-key
//! encoding stay owned by `checkpoints::canonical_json`'s four independently
//! declared encoders (ruling R5) and any future module-specific encoder —
//! none of those may be replaced by `#[derive(Serialize)]` output, whose
//! field order, number formatting, and omission behavior are only
//! coincidentally close enough for human-readable test fixtures, not
//! guaranteed byte-identical to any of the four canonical encoders' contract.
//!
//! # Number fidelity
//!
//! Every TS `number` field in this layer — including ones the TS schema
//! additionally constrains with `Schema.Int`/non-negative/positive checks —
//! is mirrored as a plain `f64`, never a narrower Rust integer type. This
//! continues the convention `canonical_grid::CanonicalGridPoint` already
//! established ("Both fields are plain `f64` (TS `number`), mirroring the TS
//! type exactly"): those refinements are enforced only at the TS decode
//! boundary, which stays TS-side; a narrower Rust type here could silently
//! diverge on out-of-range input instead of mirroring JS's actual runtime
//! representation. See `transform::IrregularTransformCandidate`'s doc
//! comment for the canonical statement of this rule.
//!
//! # Optionality: two distinct patterns, ported distinctly
//!
//! `domain.ts` uses two independent mechanisms that both look like "optional
//! field" in TypeScript but decode to different Rust shapes here:
//!
//! - **Hand-written classes with `hasOwnProperty`-gated constructor fields**
//!   (`IrregularPreparedPiece.pieceId`, `IrregularPlacement.pieceId`, etc.):
//!   a genuinely absent own-property, never `undefined`-valued presence.
//!   Ported as `Option<T>` + `#[serde(skip_serializing_if = "Option::is_none")]`
//!   — this crate's **[UNDEFINED-OMIT]** convention, see
//!   `docs/planning/rust-irregular-backend/semantic-mapping.md` §2.3.
//! - **`Schema.Class`-generated fields with `Schema.optionalKey` +
//!   `Schema.withConstructorDefault`/`Schema.withDecodingDefaultKey`**
//!   (most of `IrregularOptimizerSettings`'s fields): the generated
//!   constructor/decoder always assigns a concrete value (the default, if
//!   the caller/wire omitted the field), so the *trusted* instance this
//!   module ports never has the field genuinely absent. Ported as a
//!   required, non-`Option` field. See `settings.rs`'s module doc for the
//!   full reasoning.
//!
//! # Scope: what this module ports vs. what it defers
//!
//! This module ports the geometry, transform, source-shape, piece,
//! placement, settings, cache-key, and score-summary trusted carriers that
//! feed the algorithm's hot loop. It deliberately does **not** port
//! `domain.ts`'s result/export/history/progress classes
//! (`IrregularLayout`, `IrregularExport*`, `IrregularHistoryFrame`,
//! `IrregularPortfolio{Progress,HistoryState,Result}`) or its
//! phase/status/reason string-literal unions
//! (`IrregularWorkerMode`, `IrregularPortfolioPhase`, `IrregularSearchSource`,
//! `IrregularPortfolioStatus`, `IrregularPortfolioTerminationReason`) — those
//! are coordinator/protocol/trace-reporting concerns owned by this crate's
//! `result`/`trace` modules (per `semantic-mapping.md`'s `core::coordinator`/
//! `core::protocol` rows), not by the shared domain-type layer. Adding them
//! here would create the exact duplicate-type hazard `effect-boundary.md` §14
//! item 3 warns about for `IrregularGeometryCacheKey`/`GeometryCacheKey` —
//! whichever module owns those shapes should import this module's types,
//! not redeclare structurally-identical ones.
//!
//! # `internalGeometry.ts` unification
//!
//! `characterization/effect-boundary.md` §14 item 4: TypeScript's structural
//! typing lets a real `IrregularPoint`/`CollisionGeometry`/etc. instance
//! satisfy the separately declared `Internal*` interface vocabulary
//! (`InternalPoint`, `InternalBounds`, `InternalPolygon`,
//! `InternalTransformCandidate`, `InternalGeometrySettings`,
//! `InternalSheetSpec`, `InternalCollisionGeometry`,
//! `InternalTransformedCollisionGeometry`, `InternalIfpBounds`) purely by
//! having matching field names/types — no `impl` anywhere. Rust has no
//! structural-typing equivalent, so this module takes the "one unified type"
//! simplification the same doc item calls "legitimate": `IrregularPoint`,
//! `IrregularBounds`, `IrregularPolygon`, `IrregularTransformCandidate`,
//! `IrregularGeometrySettings`, `SheetSpec`, `CollisionGeometry`,
//! `TransformedCollisionGeometry`, and `IrregularIfpBounds` below are each
//! the *single* Rust type serving both the `domain.ts` role and the
//! `internalGeometry.ts` structural role — no separate `Internal*` structs
//! are declared. Every field the `Internal*` interfaces read
//! (`internalGeometry.ts:1-69`) is present, under the same name (after
//! `snake_case` conversion), on the corresponding type below; no field the
//! `Internal*` interfaces declare is missing, and none of these types add
//! extra fields the `Internal*` vocabulary doesn't already imply — matching
//! `effect-boundary.md` §14 item 4's requirement to preserve "exactly which
//! fields participate (no more, no fewer)".

mod cache;
mod collision;
mod geometry;
mod ids;
mod piece;
mod score;
mod settings;
mod sheet;
mod source;
mod transform;

pub use cache::IrregularGeometryCacheKey;
pub use collision::{
    CollisionGeometry, CollisionGeometryDiagnostic, FlattenedGeometry, TransformedCollisionGeometry,
};
pub use geometry::{IrregularBounds, IrregularPoint, IrregularPolygon};
pub use ids::{JobId, PieceId, SourceFileId};
pub use piece::{
    IrregularPlacedPiece, IrregularPlacement, IrregularPlacementCandidate, IrregularPreparedPiece,
    IrregularPriorityOrderKey,
};
pub use score::IrregularLayoutScoreSummary;
pub use settings::{
    default_irregular_placement_policy_ids, IntrinsicObjectiveProfileId, IrregularGeometrySettings,
    IrregularNestingSettings, IrregularOptimizerSettings, IrregularPlacementPolicyId,
    DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET, DEFAULT_IRREGULAR_GA_GENERATION_BUDGET,
    DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT, DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID,
};
pub use sheet::{
    FreeMaterialRegion, FreeMaterialSnapshot, IrregularIfpBounds, IrregularNfp, SheetSpec,
};
pub use source::{
    DxfArcSegment, DxfEllipseSource, DxfEllipseSourceKind, DxfEntityHandle, DxfGeometryEntityType,
    DxfGeometrySegment, DxfGeometrySummary, DxfLineSegment, ImportWarning, ImportedPiece, Rect,
};
pub use transform::{IrregularTransform, IrregularTransformCandidate, IrregularTransformReason};

#[cfg(test)]
mod tests {
    use super::*;

    /// Loads `sourcePieces[0]` from the real 61-piece fixture request and
    /// proves it decodes as an [`ImportedPiece`], then round-trips back to
    /// JSON and re-decodes without loss — the fixture round-trip this
    /// module's task explicitly requires, using
    /// `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
    /// (repo-root-relative; read-only).
    #[test]
    fn imported_piece_round_trips_from_the_mixed61_fixture() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/irregularSheetInvariance/mixed61-request.json");
        let raw = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|err| panic!("failed to read {fixture_path:?}: {err}"));
        let request: serde_json::Value =
            serde_json::from_str(&raw).expect("fixture parses as JSON");
        let source_pieces = request
            .get("sourcePieces")
            .and_then(|value| value.as_array())
            .expect("fixture has a sourcePieces array");
        assert_eq!(
            source_pieces.len(),
            61,
            "mixed61 fixture should carry 61 source pieces"
        );

        for raw_piece in source_pieces {
            let piece: ImportedPiece = serde_json::from_value(raw_piece.clone())
                .unwrap_or_else(|err| panic!("failed to decode ImportedPiece: {err}\n{raw_piece}"));

            // Round trip: re-encode and re-decode, then compare the typed
            // values (not raw JSON text, since key order/whitespace are not
            // semantically meaningful for this trusted carrier).
            let re_encoded = serde_json::to_string(&piece).expect("piece re-serializes");
            let round_tripped: ImportedPiece =
                serde_json::from_str(&re_encoded).expect("piece re-deserializes");
            assert_eq!(round_tripped, piece);
        }

        // Spot-check the first piece's concrete shape against the known
        // fixture content (see the crate task's own investigation of this
        // fixture): a closed PRESET_SHAPE trapezoid with 4 line segments.
        let first: ImportedPiece =
            serde_json::from_value(source_pieces[0].clone()).expect("first source piece decodes");
        assert_eq!(first.label, "trapezoid #1");
        assert_eq!(
            first.geometry.entity_type,
            DxfGeometryEntityType::PresetShape
        );
        assert!(first.geometry.closed);
        assert_eq!(first.geometry.segments.len(), 4);
        for segment in &first.geometry.segments {
            assert!(matches!(segment, DxfGeometrySegment::Line(_)));
        }
        assert!(first.source_layer.is_some());
        assert!(first.warnings.is_empty());
    }
}
