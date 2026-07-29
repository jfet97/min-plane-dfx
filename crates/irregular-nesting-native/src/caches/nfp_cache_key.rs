//! Pairwise relative-NFP cache identity — ported from
//! `src/workers/irregular/core/nfpCacheKey.ts`.
//!
//! Namespace `pairwise-nfp-relative-v3` (design doc §1.1). The reusable
//! centerpiece here is [`canonical_polygon_digest`] — the **rotation- and
//! winding-invariant ordered-coordinate fingerprint** this task names
//! explicitly: it is why geometrically identical but differently-labelled
//! placed pieces share one cache entry (`nfpCacheKey.ts:59-74`,
//! design doc §1.1, `nfp-ifp.md` §9.A).

use crate::domain::{IrregularGeometrySettings, IrregularPoint, IrregularTransformCandidate};
use crate::js_number::{cmp_js_code_units, fold_negative_zero_key};

use super::geometry_cache_identity::transform_reason_str;
use super::store::GeometryCacheKey;

/// TS: `nfpCacheKey.ts:4` `NFP_GEOMETRY_CACHE_NAMESPACE`.
pub const NFP_GEOMETRY_CACHE_NAMESPACE: &str = "pairwise-nfp-relative-v3";

/// TS: `nfpCacheKey.ts:5` `NFP_CONSTRUCTION_ALGORITHMS`.
pub const NFP_CONSTRUCTION_ALGORITHMS: [NfpConstructionAlgorithm; 2] = [
    NfpConstructionAlgorithm::LinearEdgeMerge,
    NfpConstructionAlgorithm::VertexPairHull,
];

/// TS: `nfpCacheKey.ts:6` `NfpConstructionAlgorithm` —
/// `('linear-edge-merge' | 'vertex-pair-hull')`.
///
/// Both variants are real, tested, differential-oracle code
/// (`semantic-mapping.md`'s `nfpIfpService.ts` row); production always
/// selects [`NfpConstructionAlgorithm::VertexPairHull`]
/// ([`DEFAULT_NFP_CONSTRUCTION_ALGORITHM`]) at both production wiring
/// sites — the other variant must still round-trip through this key builder
/// exactly, since a Rust port of the NFP construction algorithms themselves
/// (out of this module's scope; belongs to `nfp_ifp`) needs a matching key
/// for its own differential/unit tests regardless of which variant is
/// selected in production.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NfpConstructionAlgorithm {
    LinearEdgeMerge,
    VertexPairHull,
}

impl NfpConstructionAlgorithm {
    /// The exact TS string literal this variant renders as inside a cache
    /// key (`` `nfp-construction=${constructionAlgorithm}` ``,
    /// `nfpCacheKey.ts:44`).
    pub fn as_str(self) -> &'static str {
        match self {
            NfpConstructionAlgorithm::LinearEdgeMerge => "linear-edge-merge",
            NfpConstructionAlgorithm::VertexPairHull => "vertex-pair-hull",
        }
    }
}

/// TS: `nfpCacheKey.ts:7` `DEFAULT_NFP_CONSTRUCTION_ALGORITHM = 'vertex-pair-hull'`.
pub const DEFAULT_NFP_CONSTRUCTION_ALGORITHM: NfpConstructionAlgorithm =
    NfpConstructionAlgorithm::VertexPairHull;

/// TS: `nfpCacheKey.ts:23-29` `PairwiseNfpKeyInput`.
///
/// TS's `CoreTransformCandidate`/`CoreGeometrySettings` input shapes are
/// structurally identical to `domain::IrregularTransformCandidate`/
/// `domain::IrregularGeometrySettings` (same field names, same types) — this
/// port reuses those trusted domain carriers directly rather than declaring
/// a second, structurally-identical pair of structs (this crate's
/// established convention, see `domain::cache::IrregularGeometryCacheKey`'s
/// doc comment for the same reasoning applied to the cache-key shape).
pub struct PairwiseNfpKeyInput<'a> {
    pub fixed_polygon: &'a [IrregularPoint],
    pub moving_polygon: &'a [IrregularPoint],
    pub fixed_transform: &'a IrregularTransformCandidate,
    pub moving_transform: &'a IrregularTransformCandidate,
    pub settings: &'a IrregularGeometrySettings,
}

/// TS: `nfpCacheKey.ts:31-47` (`makePairwiseNfpCacheKey`).
pub fn make_pairwise_nfp_cache_key(
    input: &PairwiseNfpKeyInput<'_>,
    construction_algorithm: NfpConstructionAlgorithm,
) -> GeometryCacheKey {
    let mut parts = Vec::with_capacity(8);
    parts.push(format!(
        "fixed-polygon={}",
        canonical_polygon_digest(input.fixed_polygon)
    ));
    parts.push(format!(
        "moving-polygon={}",
        canonical_polygon_digest(input.moving_polygon)
    ));
    parts.push(format!(
        "fixed-transform={}",
        transform_digest(input.fixed_transform)
    ));
    parts.push(format!(
        "moving-transform={}",
        transform_digest(input.moving_transform)
    ));
    parts.extend(geometry_settings_parts(input.settings));
    parts.push("nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3".to_string());
    parts.push(format!(
        "nfp-construction={}",
        construction_algorithm.as_str()
    ));
    GeometryCacheKey::new(NFP_GEOMETRY_CACHE_NAMESPACE, parts)
}

/// TS: `nfpCacheKey.ts:49-57` (`geometrySettingsParts`). Duplicated
/// verbatim across three TS files (`nfpCacheKey.ts`, `geometryCacheIdentity.ts`,
/// `geometryCacheKeys.ts`) per the design doc's §1.6 cross-namespace hazard
/// note; this port keeps one shared implementation reused by every key
/// builder in this crate's `caches` module rather than reproducing the TS
/// triplication, since — unlike `numberKey`'s independently-hand-written
/// copies, which the audit tracks as three call sites of one *already-ported*
/// primitive ([`fold_negative_zero_key`]) — this is genuinely one function
/// body copy-pasted three times in TS with no behavioral divergence to
/// preserve.
pub(super) fn geometry_settings_parts(settings: &IrregularGeometrySettings) -> Vec<String> {
    vec![
        format!(
            "flattening-sag={}",
            fold_negative_zero_key(settings.flattening_sag_tolerance_mm)
        ),
        format!(
            "clearance-margin={}",
            fold_negative_zero_key(settings.clearance_safety_margin_mm)
        ),
        format!("backend={}", settings.geometry_backend_id),
        format!("backend-version={}", settings.geometry_backend_version),
        "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000".to_string(),
    ]
}

/// TS: `nfpCacheKey.ts:59-74` (`canonicalPolygonDigest`).
///
/// **Rotation- and winding-invariant ordered-coordinate fingerprint.** Picks
/// the lexicographically-smallest-`(x,y)` start vertex, builds both
/// traversal directions' cyclic digest via [`cyclic_polygon_digest`], and
/// keeps whichever plain-string comparison (JS `<`, i.e. UTF-16 code-unit
/// order — [`cmp_js_code_units`]) is smaller. Returns the empty string for
/// an empty polygon, matching TS's early `if (points.length === 0) return
/// ''` exactly.
pub fn canonical_polygon_digest(points: &[IrregularPoint]) -> String {
    if points.is_empty() {
        return String::new();
    }

    let mut start_index = 0usize;
    for index in 1..points.len() {
        let candidate = points[index];
        let current = points[start_index];
        if candidate.x < current.x || (candidate.x == current.x && candidate.y < current.y) {
            start_index = index;
        }
    }

    let forward = cyclic_polygon_digest(points, start_index, 1);
    let reverse = cyclic_polygon_digest(points, start_index, -1);
    if cmp_js_code_units(&forward, &reverse) == std::cmp::Ordering::Less {
        forward
    } else {
        reverse
    }
}

/// TS: `nfpCacheKey.ts:76-89` (`cyclicPolygonDigest`).
///
/// `direction` is `1` (forward) or `-1` (backward). TS indexes with
/// `(startIndex + direction * offset + points.length * 2) % points.length`
/// to keep the intermediate value non-negative before `%`; this port uses
/// `i64` arithmetic to reproduce that same non-negative-before-modulo shape
/// exactly rather than relying on Rust's differently-signed `%` semantics
/// for negative operands.
fn cyclic_polygon_digest(points: &[IrregularPoint], start_index: usize, direction: i64) -> String {
    let len = points.len() as i64;
    let mut point_keys: Vec<String> = Vec::with_capacity(points.len());
    for offset in 0..points.len() as i64 {
        let index = (start_index as i64 + direction * offset + len * 2) % len;
        let point = points[index as usize];
        point_keys.push(point_digest(point));
    }
    point_keys.join(";")
}

/// TS: `nfpCacheKey.ts:91-98` (`transformDigest`).
fn transform_digest(transform: &IrregularTransformCandidate) -> String {
    format!(
        "index={},rotation={},mirrored={},reason={}",
        fold_negative_zero_key(transform.index),
        fold_negative_zero_key(transform.rotation_deg),
        u8::from(transform.mirrored),
        transform_reason_str(transform.reason)
    )
}

/// TS: `nfpCacheKey.ts:100-102` (`pointDigest`).
pub(super) fn point_digest(point: IrregularPoint) -> String {
    format!(
        "{},{}",
        fold_negative_zero_key(point.x),
        fold_negative_zero_key(point.y)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::IrregularTransformReason;

    fn p(x: f64, y: f64) -> IrregularPoint {
        IrregularPoint::new(x, y)
    }

    #[test]
    fn canonical_polygon_digest_is_empty_for_an_empty_polygon() {
        assert_eq!(canonical_polygon_digest(&[]), "");
    }

    #[test]
    fn canonical_polygon_digest_is_invariant_under_rotation_of_the_start_vertex() {
        let square_a = [p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)];
        // Same ring, rotated to start at a different vertex, same winding.
        let square_b = [p(4.0, 4.0), p(0.0, 4.0), p(0.0, 0.0), p(4.0, 0.0)];
        assert_eq!(
            canonical_polygon_digest(&square_a),
            canonical_polygon_digest(&square_b)
        );
    }

    #[test]
    fn canonical_polygon_digest_is_invariant_under_winding_reversal() {
        let ccw = [p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)];
        let cw = [p(0.0, 0.0), p(0.0, 4.0), p(4.0, 4.0), p(4.0, 0.0)];
        assert_eq!(
            canonical_polygon_digest(&ccw),
            canonical_polygon_digest(&cw)
        );
    }

    #[test]
    fn canonical_polygon_digest_folds_negative_zero_in_point_keys() {
        let ring = [p(-0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0)];
        let digest = canonical_polygon_digest(&ring);
        assert!(
            !digest.contains('-'),
            "digest should not contain a literal -0: {digest}"
        );
    }

    #[test]
    fn transform_digest_renders_mirrored_as_0_or_1_and_reason_as_the_bare_literal() {
        let transform = IrregularTransformCandidate {
            index: 0.0,
            rotation_deg: 0.0,
            mirrored: false,
            reason: IrregularTransformReason::Configured,
        };
        assert_eq!(
            transform_digest(&transform),
            "index=0,rotation=0,mirrored=0,reason=configured"
        );
        let mirrored = IrregularTransformCandidate {
            mirrored: true,
            ..transform
        };
        assert_eq!(
            transform_digest(&mirrored),
            "index=0,rotation=0,mirrored=1,reason=configured"
        );
    }

    #[test]
    fn make_pairwise_nfp_cache_key_matches_the_golden_bytes_from_geometry_caches_md() {
        let settings = IrregularGeometrySettings {
            flattening_sag_tolerance_mm: 0.05,
            clearance_safety_margin_mm: 0.05,
            geometry_backend_id: "clipper2-ts".to_string(),
            geometry_backend_version: "2.0.1-18".to_string(),
        };
        let transform = IrregularTransformCandidate {
            index: 0.0,
            rotation_deg: 0.0,
            mirrored: false,
            reason: IrregularTransformReason::Configured,
        };
        let fixed_polygon = [p(0.0, 0.0), p(0.0, 4.0), p(4.0, 4.0), p(4.0, 0.0)];
        let moving_polygon = [p(0.0, 0.0), p(0.0, 2.0), p(2.0, 2.0), p(2.0, 0.0)];
        let input = PairwiseNfpKeyInput {
            fixed_polygon: &fixed_polygon,
            moving_polygon: &moving_polygon,
            fixed_transform: &transform,
            moving_transform: &transform,
            settings: &settings,
        };
        let key = make_pairwise_nfp_cache_key(&input, NfpConstructionAlgorithm::VertexPairHull);
        assert_eq!(key.namespace, NFP_GEOMETRY_CACHE_NAMESPACE);
        assert_eq!(
            key.parts,
            vec![
                "fixed-polygon=0,0;0,4;4,4;4,0".to_string(),
                "moving-polygon=0,0;0,2;2,2;2,0".to_string(),
                "fixed-transform=index=0,rotation=0,mirrored=0,reason=configured".to_string(),
                "moving-transform=index=0,rotation=0,mirrored=0,reason=configured".to_string(),
                "flattening-sag=0.05".to_string(),
                "clearance-margin=0.05".to_string(),
                "backend=clipper2-ts".to_string(),
                "backend-version=2.0.1-18".to_string(),
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000".to_string(),
                "nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3".to_string(),
                "nfp-construction=vertex-pair-hull".to_string(),
            ]
        );
    }
}
