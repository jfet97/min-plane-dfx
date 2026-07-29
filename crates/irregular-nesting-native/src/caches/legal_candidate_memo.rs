//! Legal-placement-candidate memo key — ported from
//! `src/workers/irregular/geometryCacheKeys.ts:76-106`
//! (`legalPlacementCandidateMemoKey`).
//!
//! **Structurally different from namespaces 1.1–1.3** (design doc §1.4):
//! this key does not address `store::GeometryCacheStore`'s backing map at
//! all. In production it addresses a separate
//! `WeakMap<IrregularNfpIfpCandidateMemoScope, Map<string,
//! CachedLegalCandidateEntry>>` (`nfpIfpService.ts:611-614`) that is
//! **per-search-invocation**, not job-local — design doc §2: "a fresh
//! `IrregularNfpIfpCandidateMemoScope` per `runIntrinsicCapacityColdSearch`
//! call, per decoder invocation, etc.", "in Rust this is naturally an owned
//! `HashMap<String, CachedLegalCandidateEntry>>` ... local to the calling
//! function's stack frame". This module ports only the **key constructor**
//! (`legalPlacementCandidateMemoKey` itself) plus this namespace's constant
//! and pruning-mode enum, per this task's explicit scope (`caches/` owns
//! cache *key* construction for every namespace; the memo's own
//! per-invocation `HashMap` table, hit/miss/provenance-miss resolution
//! sequence, and `CachedLegalCandidateEntry` value shape belong to whichever
//! module ports `nfpIfpService.ts`'s `makeGeneratePlacementCandidates` — the
//! `nfp_ifp` cluster, out of this module's scope).

use crate::domain::{IrregularBounds, IrregularGeometrySettings, IrregularPoint};

use super::nfp_cache_key::geometry_settings_parts;

/// TS: `geometryCacheKeys.ts:44` `LEGAL_CANDIDATE_MEMO_NAMESPACE`.
pub const LEGAL_CANDIDATE_MEMO_NAMESPACE: &str = "legal-placement-candidates-v1";

/// TS: `geometryCacheKeys.ts:40` `NfpCandidatePruningMode` —
/// `('indexed' | 'reference')`. Selects the live indexed candidate path
/// (production default) or the differential-test reference path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NfpCandidatePruningMode {
    Indexed,
    Reference,
}

impl NfpCandidatePruningMode {
    pub fn as_str(self) -> &'static str {
        match self {
            NfpCandidatePruningMode::Indexed => "indexed",
            NfpCandidatePruningMode::Reference => "reference",
        }
    }
}

/// TS: `services.ts:184` `readonly candidateDomain?: 'sheet' | 'contact-only'
/// | 'sheetless-nfp'` (confirmed by direct read; this key's own use site is
/// `geometryCacheKeys.ts:83,104`), optional at the TS call site
/// (`input.candidateDomain ?? 'sheet'`, `geometryCacheKeys.ts:104`).
/// Modeled here as a plain enum with an explicit [`Default`] impl (`Sheet`)
/// rather than `Option<CandidateDomain>`, since the TS `??` fallback always
/// resolves to a concrete domain before this key is built — there is no
/// "genuinely absent" state this key construction step itself observes.
///
/// **`ContactOnly` is a real, reachable third variant, not a theoretical
/// one**: `nfp-ifp.md` §79 confirms `'contact-only'` is a genuine candidate
/// domain (`nfpIfpService.ts:357,376`) whose sheet identity falls through to
/// the same `sheet=<w>,<h>` branch as `'sheet'` (only `'sheetless-nfp'` gets
/// the `sheet=deferred` special case, `geometryCacheKeys.ts:83`) but whose
/// final `candidate-domain=` key component renders the literal
/// `"contact-only"`, distinguishing its memo entries from `'sheet'`'s. A
/// two-variant enum here would make `'contact-only'` unrepresentable and
/// silently collapse its memo key onto `'sheet'`'s.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CandidateDomain {
    #[default]
    Sheet,
    ContactOnly,
    SheetlessNfp,
}

impl CandidateDomain {
    pub fn as_str(self) -> &'static str {
        match self {
            CandidateDomain::Sheet => "sheet",
            CandidateDomain::ContactOnly => "contact-only",
            CandidateDomain::SheetlessNfp => "sheetless-nfp",
        }
    }
}

/// One placed piece's contribution to the memo key
/// (`` `${polygonDigest}@${translationDigest}` ``, `geometryCacheKeys.ts:89-92`).
pub struct PlacedPieceKeyInput<'a> {
    pub collision_polygon_points: &'a [IrregularPoint],
    pub translate_x: f64,
    pub translate_y: f64,
}

/// TS: `geometryCacheKeys.ts:76-106` `GeneratePlacementCandidatesInput`,
/// concretized to plain geometry (no `ComputeNfpInput`/service-layer types —
/// out of this module's scope, see this file's top-level doc).
pub struct LegalPlacementCandidateMemoKeyInput<'a> {
    /// `None` mirrors `candidateDomain === 'sheetless-nfp'`: sheet identity
    /// collapses to the literal `sheet=deferred` regardless of any sheet
    /// dimensions the caller might otherwise have on hand.
    pub sheet: Option<SheetDimensions>,
    pub placed: &'a [PlacedPieceKeyInput<'a>],
    pub moving_polygon_points: &'a [IrregularPoint],
    pub moving_bounds: &'a IrregularBounds,
    pub settings: &'a IrregularGeometrySettings,
    pub candidate_domain: CandidateDomain,
}

/// `width`/`height` only — deliberately **not** `SheetSpec` (which also
/// carries `label`). See [`legal_placement_candidate_memo_key`]'s doc
/// comment for the sheet-label omission this type shape encodes structurally
/// (there is no `label` field to accidentally include).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SheetDimensions {
    pub width: f64,
    pub height: f64,
}

/// TS: `geometryCacheKeys.ts:77-106` (`legalPlacementCandidateMemoKey`).
///
/// Returns the raw `JSON.stringify([...])` byte string directly (TS: `string`
/// return type, not a `{namespace, parts}` pair) — this namespace's key is
/// never routed through `serializeGeometryCacheKey`
/// (`core/geometryCacheStore.ts:13-15`); it builds its own flat
/// `JSON.stringify` array with the namespace literal as its first element,
/// matching the exact shape this function's TS body constructs.
///
/// **Sheet-label omission oddity** (`nfp-ifp.md` §15 item 5, explicitly
/// named by this task): the sheet identity here is `` `sheet=${w},${h}` ``
/// — **`width`/`height` only, no `label`** — unlike
/// `geometry_cache_identity::make_inner_fit_bounds_cache_key`'s sheet
/// identity, which does include `label`. Two sheets with identical
/// dimensions but different labels share one legal-candidate memo entry but
/// not one IFP-bounds cache entry. This is preserved verbatim per the
/// migration prompt's "do not clean up observable behavior into consistency"
/// rule — `nfp-ifp.md` §15 item 5 judges this "very likely intentional and
/// harmless" (candidate legality math genuinely does not depend on `label`)
/// but explicitly directs a Rust port not to "fix" it.
///
/// This key also intentionally omits `moving.sourcePieceId`/`moving.transform`
/// (`nfp-ifp.md` §9's "two-layer sharing" note) — candidate *points* are
/// pure geometry and do not depend on which piece/transform index produced
/// them; this port's [`LegalPlacementCandidateMemoKeyInput`] shape has no
/// piece-id/transform fields at all, so there is nothing to accidentally
/// include.
pub fn legal_placement_candidate_memo_key(
    input: &LegalPlacementCandidateMemoKeyInput<'_>,
    construction_algorithm: super::nfp_cache_key::NfpConstructionAlgorithm,
    candidate_pruning_mode: NfpCandidatePruningMode,
) -> String {
    let sheet_identity = match input.sheet {
        None => "sheet=deferred".to_string(),
        Some(dimensions) => format!(
            "sheet={},{}",
            crate::js_number::fold_negative_zero_key(dimensions.width),
            crate::js_number::fold_negative_zero_key(dimensions.height)
        ),
    };

    let placed_parts: Vec<String> = input
        .placed
        .iter()
        .map(|placed| {
            format!(
                "{}@{}",
                exact_ordered_polygon_digest(placed.collision_polygon_points),
                point_translation_digest(placed.translate_x, placed.translate_y)
            )
        })
        .collect();

    let mut array_elements: Vec<String> = Vec::with_capacity(9);
    array_elements.push(json_string(LEGAL_CANDIDATE_MEMO_NAMESPACE));
    array_elements.push(json_string(&sheet_identity));
    array_elements.push(json_string(&format!("placed={}", placed_parts.join("|"))));
    array_elements.push(json_string(&format!(
        "moving={}",
        exact_ordered_polygon_digest(input.moving_polygon_points)
    )));
    array_elements.push(json_string(&format!(
        "moving-bounds={}",
        bounds_digest(input.moving_bounds)
    )));
    for part in geometry_settings_parts(input.settings) {
        array_elements.push(json_string(&part));
    }
    array_elements.push(json_string(&format!(
        "nfp-construction={}",
        construction_algorithm.as_str()
    )));
    array_elements.push(json_string(&format!(
        "candidate-pruning={}",
        candidate_pruning_mode.as_str()
    )));
    array_elements.push(json_string(&format!(
        "candidate-domain={}",
        input.candidate_domain.as_str()
    )));

    format!("[{}]", array_elements.join(","))
}

/// TS: `geometryCacheKeys.ts:141-143` (`polygonDigest`, this file's local
/// copy — **not** `nfp_cache_key::canonical_polygon_digest`). This digest is
/// an **exact ordered** `x,y;x,y;...` join with no rotation/winding
/// canonicalization at all (`nfp-ifp.md` §9's "cache C requires exact
/// point-array equality... not canonicalized equality"), unlike namespace
/// 1.1's fingerprint. Named distinctly from that function to make this
/// distinction impossible to miss at the call site.
fn exact_ordered_polygon_digest(points: &[IrregularPoint]) -> String {
    points
        .iter()
        .map(|point| super::nfp_cache_key::point_digest(*point))
        .collect::<Vec<_>>()
        .join(";")
}

/// TS: `geometryCacheKeys.ts:145-147` (`pointDigest`), applied to the placed
/// piece's translation (`geometryCacheKeys.ts:88-92`:
/// `pointDigest({ x: translation.translateX, y: translation.translateY })`).
fn point_translation_digest(translate_x: f64, translate_y: f64) -> String {
    super::nfp_cache_key::point_digest(IrregularPoint::new(translate_x, translate_y))
}

/// TS: `geometryCacheKeys.ts:149-156` (`boundsDigest`).
fn bounds_digest(bounds: &IrregularBounds) -> String {
    [bounds.min_x, bounds.min_y, bounds.max_x, bounds.max_y]
        .into_iter()
        .map(crate::js_number::fold_negative_zero_key)
        .collect::<Vec<_>>()
        .join(",")
}

/// `JSON.stringify` for one string element of the outer array, reusing this
/// module's sibling `store::` string-escaping algorithm rather than
/// reimplementing ECMA-262 `QuoteJSONString` a third time in this crate.
fn json_string(value: &str) -> String {
    // `push_json_string` is private to `store`; reproduce its call shape via
    // the one `pub(crate)` seam that module exposes for this purpose.
    super::store::json_string_for_array_element(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caches::nfp_cache_key::NfpConstructionAlgorithm;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    #[test]
    fn sheetless_nfp_domain_uses_the_deferred_sheet_identity() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        };
        let bounds = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let moving = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let input = LegalPlacementCandidateMemoKeyInput {
            sheet: None,
            placed: &[],
            moving_polygon_points: &moving,
            moving_bounds: &bounds,
            settings: &settings,
            candidate_domain: CandidateDomain::SheetlessNfp,
        };
        let key = legal_placement_candidate_memo_key(
            &input,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
        );
        assert!(key.starts_with(r#"["legal-placement-candidates-v1","sheet=deferred","placed=","#));
        assert!(key.contains(r#""candidate-domain=sheetless-nfp""#));
    }

    #[test]
    fn contact_only_domain_uses_the_sheet_dimensions_identity_but_renders_its_own_domain_literal() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        };
        let bounds = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let moving = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let input = LegalPlacementCandidateMemoKeyInput {
            sheet: Some(SheetDimensions {
                width: 20.0,
                height: 15.0,
            }),
            placed: &[],
            moving_polygon_points: &moving,
            moving_bounds: &bounds,
            settings: &settings,
            candidate_domain: CandidateDomain::ContactOnly,
        };
        let key = legal_placement_candidate_memo_key(
            &input,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
        );
        // Sheet identity falls through to the same `sheet=<w>,<h>` branch as
        // `'sheet'` -- only `'sheetless-nfp'` gets `sheet=deferred`.
        assert!(key.contains(r#""sheet=20,15""#));
        assert!(key.contains(r#""candidate-domain=contact-only""#));
    }

    #[test]
    fn sheet_domain_omits_the_label_even_when_a_caller_might_otherwise_have_one() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        };
        let bounds = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let moving = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let input = LegalPlacementCandidateMemoKeyInput {
            sheet: Some(SheetDimensions {
                width: 20.0,
                height: 15.0,
            }),
            placed: &[],
            moving_polygon_points: &moving,
            moving_bounds: &bounds,
            settings: &settings,
            candidate_domain: CandidateDomain::Sheet,
        };
        let key = legal_placement_candidate_memo_key(
            &input,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
        );
        // `SheetDimensions` structurally has no `label` field, so there is
        // nothing to include even by mistake; this assertion confirms the
        // rendered sheet identity is exactly `sheet=20,15` (two components).
        assert!(key.contains(r#""sheet=20,15""#));
    }

    #[test]
    fn placed_pieces_are_joined_in_input_order_not_sorted() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.25,
            clearance_safety_margin_mm: 0.25,
            geometry_backend_id: "irregular-convex-v2-default".to_string(),
            geometry_backend_version: "0".to_string(),
        };
        let bounds = IrregularBounds::new(0.0, 0.0, 1.0, 1.0);
        let square = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let placed_b = PlacedPieceKeyInput {
            collision_polygon_points: &square,
            translate_x: 5.0,
            translate_y: 0.0,
        };
        let placed_a = PlacedPieceKeyInput {
            collision_polygon_points: &square,
            translate_x: 0.0,
            translate_y: 0.0,
        };
        let placed = [placed_b, placed_a];
        let input = LegalPlacementCandidateMemoKeyInput {
            sheet: None,
            placed: &placed,
            moving_polygon_points: &square,
            moving_bounds: &bounds,
            settings: &settings,
            candidate_domain: CandidateDomain::SheetlessNfp,
        };
        let key = legal_placement_candidate_memo_key(
            &input,
            NfpConstructionAlgorithm::VertexPairHull,
            NfpCandidatePruningMode::Indexed,
        );
        // translate_x=5 piece's digest must appear before translate_x=0's,
        // matching `input.placed` array order (never sorted).
        let five_index = key.find("@5,0").expect("translate 5,0 present");
        let zero_index = key.find("@0,0").expect("translate 0,0 present");
        assert!(five_index < zero_index);
        // Sanity: both placed entries reuse the identical polygon digest
        // (same square) so the only thing distinguishing them is the
        // translation suffix and their relative order.
        assert_eq!(key.matches("0,0;1,0;1,1;0,1").count(), 3);
    }
}
