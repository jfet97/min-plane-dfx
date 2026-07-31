//! Geometry preparation and optimizer settings for one irregular nesting job.
//!
//! TS source: `src/shared/irregular/domain.ts:44-99,275-498`.
//!
//! Every field below is modeled as a *required*, already-resolved value —
//! not `Option<T>` — even though several of the corresponding TS schema
//! fields are individually declared `Schema.optionalKey` +
//! `Schema.withConstructorDefault(...)` + `Schema.withDecodingDefaultKey(...)`
//! (e.g. `localCandidateFanout`, `gaEnabled`, `placementPolicyId`). That is a
//! deliberate distinction from `piece.rs`'s `Option`-typed fields
//! (`IrregularPreparedPiece::piece_id` etc.), which come from plain
//! `Schema.optional(...)` with **no** default and a hand-written
//! `hasOwnProperty`-gated constructor. `Schema.Class`'s own generated
//! constructor/decoder for `optionalKey` + `withConstructorDefault`/
//! `withDecodingDefaultKey` fields *always* assigns a concrete value to the
//! resulting instance — by direct construction it applies the constructor
//! default, and by decode it applies the decoding default — so a real
//! `IrregularOptimizerSettings`/`IrregularGeometrySettings`/
//! `IrregularNestingSettings` instance (the *trusted* carrier this module
//! ports) never has one of these fields genuinely absent. The "optional at
//! the wire" defaulting is this settings layer's own concern (owned by
//! whichever TS/N-API boundary code decodes the incoming request), not this
//! trusted domain type's.
//!
//! For `serde`'s test-vector-IO deserialization only (never for
//! construction: a Rust struct literal always requires every field
//! regardless of `#[serde(default = ...)]`), the `optionalKey` +
//! `withDecodingDefaultKey` fields below carry a `#[serde(default = ...)]`
//! attribute mirroring the exact TS decode default named in each field's own
//! doc comment. This exists because genuine production wire payloads (e.g.
//! `tests/fixtures/irregularSheetInvariance/mixed61-request.json`'s
//! `options.irregularSettings.optimizer`) omit these keys when the caller
//! accepted the default, and this module's fixture round-trip test
//! deserializes that exact wire JSON. Every such default function reproduces
//! the same literal value the corresponding
//! `Schema.withDecodingDefaultKey(Effect.succeed(...))` call uses in
//! `domain.ts` (cited per field below) — it does not reimplement Effect's
//! decode algorithm, only its constant result.

use serde::{Deserialize, Serialize};

/// TS: `domain.ts:45-52` `IrregularPlacementPolicyId` —
/// `Schema.Literals(['balanced-compactness', 'short-side-fill', 'edge-contact-then-balanced-compactness'])`.
/// Explicit local policies used to rank already-legal placement candidates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IrregularPlacementPolicyId {
    BalancedCompactness,
    ShortSideFill,
    EdgeContactThenBalancedCompactness,
}

/// TS: `domain.ts:55-58` `IntrinsicObjectiveProfileId` —
/// `Schema.Literals(['compact', 'short-side'])`. Selects the terminal
/// objective applied after protected Compact construction settles.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntrinsicObjectiveProfileId {
    Compact,
    ShortSide,
}

/// TS: `domain.ts:61-62` `DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID`. Stable
/// default local policy retained for the deterministic beam baseline.
pub const DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID: IrregularPlacementPolicyId =
    IrregularPlacementPolicyId::BalancedCompactness;

/// TS: `domain.ts:96` `DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT = 4`. Default
/// local candidate fanout for the first deterministic irregular result.
pub const DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT: f64 = 4.0;

/// TS: `domain.ts:99` `DEFAULT_IRREGULAR_GA_GENERATION_BUDGET = 2`. Default
/// number of GA generations for an explicitly enabled experiment.
pub const DEFAULT_IRREGULAR_GA_GENERATION_BUDGET: f64 = 2.0;

/// TS: `domain.ts:102` `DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET = 24`. Default
/// deterministic GA evaluation cap for an explicitly enabled experiment.
pub const DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET: f64 = 24.0;

/// TS: `domain.ts:64-69` `DEFAULT_IRREGULAR_PLACEMENT_POLICY_IDS`. Stable
/// policy choices available to the irregular portfolio by default.
pub fn default_irregular_placement_policy_ids() -> Vec<IrregularPlacementPolicyId> {
    vec![
        IrregularPlacementPolicyId::BalancedCompactness,
        IrregularPlacementPolicyId::ShortSideFill,
        IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness,
    ]
}

/// TS: `domain.ts:280-299` `class IrregularGeometrySettings`. Geometry
/// backend and conservative curve-flattening settings.
///
/// Cross-field invariant checked by the TS schema at decode time
/// (`domain.ts:285-294`, not re-checked by this trusted carrier):
/// `clearanceSafetyMarginMm >= flatteningSagToleranceMm`, so inward
/// curve-flattening sag is always covered by the collision offset.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularGeometrySettings {
    /// TS: `domain.ts:281` `PositiveFiniteMillimeters` (`> 0`).
    pub flattening_sag_tolerance_mm: f64,
    /// TS: `domain.ts:282` `NonNegativeFiniteMillimeters` (`>= 0`), and
    /// `>= flattening_sag_tolerance_mm` (see cross-field invariant above).
    pub clearance_safety_margin_mm: f64,
    /// TS: `domain.ts:283` `Schema.NonEmptyString`.
    pub geometry_backend_id: String,
    /// TS: `domain.ts:284` `Schema.NonEmptyString`.
    pub geometry_backend_version: String,
}

// Deserialization-only default helpers for `IrregularOptimizerSettings`'s
// `optionalKey` + `withDecodingDefaultKey` fields; see the module doc.

fn decode_default_zero() -> f64 {
    0.0
}

fn decode_default_false() -> bool {
    false
}

fn decode_default_true() -> bool {
    true
}

/// TS: `domain.ts:307-311` decode default [`DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT`].
fn decode_default_local_candidate_fanout() -> f64 {
    DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT
}

/// TS: `domain.ts:371-375` decode default [`DEFAULT_IRREGULAR_GA_GENERATION_BUDGET`].
fn decode_default_ga_generation_budget() -> f64 {
    DEFAULT_IRREGULAR_GA_GENERATION_BUDGET
}

/// TS: `domain.ts:377-381` decode default [`DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET`].
fn decode_default_ga_evaluation_budget() -> f64 {
    DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET
}

/// TS: `domain.ts:333-335` decode default `1`.
fn decode_default_transform_minimum_edge_length_mm() -> f64 {
    1.0
}

/// TS: `domain.ts:337-339` decode default `0.01`.
fn decode_default_transform_angle_deduplication_tolerance_deg() -> f64 {
    0.01
}

/// TS: `domain.ts:353-355` decode default `[]`.
fn decode_default_configured_rotation_deg() -> Vec<f64> {
    Vec::new()
}

/// TS: `domain.ts:325-329` decode default `'compact'`.
fn decode_default_intrinsic_objective_profile_id() -> IntrinsicObjectiveProfileId {
    IntrinsicObjectiveProfileId::Compact
}

/// TS: `domain.ts:405-409` decode default `'balanced-compactness'`.
fn decode_default_placement_policy_id() -> IrregularPlacementPolicyId {
    DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
}

/// TS: `domain.ts:411-417` decode default: the 3-element production list.
fn decode_default_placement_policy_ids() -> Vec<IrregularPlacementPolicyId> {
    default_irregular_placement_policy_ids()
}

/// TS: `domain.ts:301-466` `class IrregularOptimizerSettings`. Positive
/// integer limits, finite-transform controls, and reproducibility settings
/// for irregular search — 25 fields, in TS declaration order.
///
/// Cross-field `.check()` filter (`domain.ts:418-458`, not re-checked by
/// this trusted carrier):
/// 1. `placementPolicyId` must be a member of `placementPolicyIds`.
/// 2. `placementPolicyIds` must not contain duplicates.
/// 3. If `intrinsicObjectiveProfileId == 'short-side'`, then
///    `intrinsicSharedArchiveEnabled` must be `true` **and** GA must be
///    fully disabled (`gaEnabled == false || baselineOnly == true ||
///    gaTimeBudgetMs == 0 || gaGenerationBudget == 0 || gaEvaluationBudget
///    == 0`), and `placementPolicyId` must not be `'short-side-fill'`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrregularOptimizerSettings {
    /// TS: `domain.ts:303` — number of queued pieces each beam state may
    /// reorder at one decision point. `PositiveFiniteInteger`.
    pub order_window: f64,
    /// TS: `domain.ts:305` — maximum whole-layout states retained after
    /// every beam expansion. `PositiveFiniteInteger`.
    pub beam_width: f64,
    /// TS: `domain.ts:307-311` — maximum legal local placements retained
    /// per eligible piece before beam scoring. `PositiveFiniteInteger`,
    /// default [`DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT`].
    #[serde(default = "decode_default_local_candidate_fanout")]
    pub local_candidate_fanout: f64,
    /// TS: `domain.ts:313-317` — bounded terminal remove-and-reinsert
    /// iterations; zero disables local repair. `NonNegativeFiniteInteger`,
    /// default `0`.
    #[serde(default = "decode_default_zero")]
    pub local_repair_budget: f64,
    /// TS: `domain.ts:319-323` — runs the sheet-independent direct and
    /// periodic constructors under one exact archive. Default `false`.
    #[serde(default = "decode_default_false")]
    pub intrinsic_shared_archive_enabled: bool,
    /// TS: `domain.ts:325-329` — keeps ordinary Compact or applies the
    /// bounded Short Side terminal profile after it settles. Default
    /// `'compact'`.
    #[serde(default = "decode_default_intrinsic_objective_profile_id")]
    pub intrinsic_objective_profile_id: IntrinsicObjectiveProfileId,
    /// TS: `domain.ts:331` — maximum orientation candidates emitted for one
    /// prepared collision polygon. `PositiveFiniteInteger`.
    pub transform_cap: f64,
    /// TS: `domain.ts:333-335` — ordinary-path edge threshold; Compact
    /// derives a scale-aware value per collision polygon.
    /// `NonNegativeFiniteMillimeters`, decode default `1`.
    #[serde(default = "decode_default_transform_minimum_edge_length_mm")]
    pub transform_minimum_edge_length_mm: f64,
    /// TS: `domain.ts:337-339` — ordinary-path angle tolerance; Compact
    /// derives a sag-bounded value per collision polygon.
    /// `PositiveFiniteDegrees`, decode default `0.01`.
    #[serde(default = "decode_default_transform_angle_deduplication_tolerance_deg")]
    pub transform_angle_deduplication_tolerance_deg: f64,
    /// TS: `domain.ts:341-345` — enables the explicit angles in
    /// `configuredRotationDeg` without disabling derived angles. Default
    /// `true`.
    #[serde(default = "decode_default_true")]
    pub configured_rotation_enabled: bool,
    /// TS: `domain.ts:347-351` — enables geometry-derived edge-alignment
    /// angles. Default `true`.
    #[serde(default = "decode_default_true")]
    pub edge_alignment_enabled: bool,
    /// TS: `domain.ts:353-355` — explicit finite rotation angles to add to
    /// the orthogonal and edge-derived choices. `Schema.Array(FiniteDegrees)`,
    /// decode default `[]`.
    #[serde(default = "decode_default_configured_rotation_deg")]
    pub configured_rotation_deg: Vec<f64>,
    /// TS: `domain.ts:357-361` — enables seeded GA portfolio evaluations
    /// after the deterministic beam baseline. Default `false`.
    #[serde(default = "decode_default_false")]
    pub ga_enabled: bool,
    /// TS: `domain.ts:363-367` — keeps only the deterministic beam baseline
    /// regardless of other GA limits. Default `true`.
    #[serde(default = "decode_default_true")]
    pub baseline_only: bool,
    /// TS: `domain.ts:369` — number of chromosomes evaluated in every GA
    /// generation. `PositiveFiniteInteger`.
    pub ga_population: f64,
    /// TS: `domain.ts:371-375` — maximum number of generated GA
    /// populations; zero disables GA evaluation.
    /// `NonNegativeFiniteInteger`, default [`DEFAULT_IRREGULAR_GA_GENERATION_BUDGET`].
    #[serde(default = "decode_default_ga_generation_budget")]
    pub ga_generation_budget: f64,
    /// TS: `domain.ts:377-381` — maximum chromosome evaluations across all
    /// generations; zero disables GA evaluation. `NonNegativeFiniteInteger`,
    /// default [`DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET`].
    #[serde(default = "decode_default_ga_evaluation_budget")]
    pub ga_evaluation_budget: f64,
    /// TS: `domain.ts:383` — wall-clock budget in milliseconds for GA
    /// evaluation; zero disables GA evaluation. `NonNegativeFiniteInteger`.
    pub ga_time_budget_ms: f64,
    /// TS: `domain.ts:385` — stable seed used for deterministic chromosome
    /// initialization and mutation. `Schema.NonEmptyString`.
    pub ga_seed: String,
    /// TS: `domain.ts:387-391` — lets GA mutate the prepared-piece priority
    /// order gene. Default `true`.
    #[serde(default = "decode_default_true")]
    pub priority_order_mutation_enabled: bool,
    /// TS: `domain.ts:393-397` — lets GA mutate the preferred transform
    /// index for each prepared piece. Default `true`.
    #[serde(default = "decode_default_true")]
    pub transform_preference_mutation_enabled: bool,
    /// TS: `domain.ts:399-403` — lets GA mutate the local candidate-scoring
    /// policy gene. Default `true`.
    #[serde(default = "decode_default_true")]
    pub placement_policy_mutation_enabled: bool,
    /// TS: `domain.ts:405-409` — local policy used by the deterministic
    /// baseline and when the policy gene is disabled. Default
    /// [`DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID`].
    #[serde(default = "decode_default_placement_policy_id")]
    pub placement_policy_id: IrregularPlacementPolicyId,
    /// TS: `domain.ts:411-417` — distinct local policies available to the
    /// baseline and GA policy gene. Non-empty
    /// `Schema.Array(IrregularPlacementPolicyId)`, default
    /// [`default_irregular_placement_policy_ids`].
    #[serde(default = "decode_default_placement_policy_ids")]
    pub placement_policy_ids: Vec<IrregularPlacementPolicyId>,
}

/// TS: `domain.ts:493-498` `class IrregularNestingSettings`. Complete
/// geometry and optimizer configuration for one irregular run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IrregularNestingSettings {
    pub geometry: IrregularGeometrySettings,
    pub optimizer: IrregularOptimizerSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_optimizer_settings() -> IrregularOptimizerSettings {
        IrregularOptimizerSettings {
            order_window: 4.0,
            beam_width: 8.0,
            local_candidate_fanout: 4.0,
            local_repair_budget: 0.0,
            intrinsic_shared_archive_enabled: true,
            intrinsic_objective_profile_id: IntrinsicObjectiveProfileId::Compact,
            transform_cap: 8.0,
            transform_minimum_edge_length_mm: 1.2,
            transform_angle_deduplication_tolerance_deg: 0.051,
            configured_rotation_enabled: true,
            edge_alignment_enabled: true,
            configured_rotation_deg: vec![],
            ga_enabled: false,
            baseline_only: true,
            ga_population: 12.0,
            ga_generation_budget: 2.0,
            ga_evaluation_budget: 24.0,
            ga_time_budget_ms: 15000.0,
            ga_seed: "default".to_string(),
            priority_order_mutation_enabled: true,
            transform_preference_mutation_enabled: true,
            placement_policy_mutation_enabled: true,
            placement_policy_id: IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness,
            placement_policy_ids: default_irregular_placement_policy_ids(),
        }
    }

    #[test]
    fn default_placement_policy_id_is_a_member_of_the_default_policy_ids() {
        assert!(default_irregular_placement_policy_ids()
            .contains(&DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID));
    }

    #[test]
    fn irregular_nesting_settings_round_trips_through_json() {
        let settings = IrregularNestingSettings {
            geometry: IrregularGeometrySettings {
                flattening_sag_tolerance_mm: 0.25,
                clearance_safety_margin_mm: 0.25,
                geometry_backend_id: "irregular-convex-v2-default".to_string(),
                geometry_backend_version: "0".to_string(),
            },
            optimizer: sample_optimizer_settings(),
        };
        let json = serde_json::to_string(&settings).expect("settings serialize");
        let decoded: IrregularNestingSettings =
            serde_json::from_str(&json).expect("settings deserialize");
        assert_eq!(decoded, settings);
    }

    #[test]
    fn optimizer_settings_deserialize_applies_ts_decode_defaults_for_omitted_wire_fields() {
        // Every `optionalKey` + `withDecodingDefaultKey` field omitted, plus
        // every required field present -- mirrors what a real wire payload
        // looks like when the caller accepted every default (the fixture
        // payload below omits `intrinsicObjectiveProfileId` for exactly this
        // reason).
        let json = r#"{
            "orderWindow": 4,
            "beamWidth": 8,
            "transformCap": 8,
            "gaPopulation": 12,
            "gaTimeBudgetMs": 15000,
            "gaSeed": "default"
        }"#;
        let settings: IrregularOptimizerSettings =
            serde_json::from_str(json).expect("minimal optimizer settings decode with defaults");
        assert_eq!(
            settings.local_candidate_fanout,
            DEFAULT_IRREGULAR_LOCAL_CANDIDATE_FANOUT
        );
        assert_eq!(settings.local_repair_budget, 0.0);
        assert!(!settings.intrinsic_shared_archive_enabled);
        assert_eq!(
            settings.intrinsic_objective_profile_id,
            IntrinsicObjectiveProfileId::Compact
        );
        assert_eq!(settings.transform_minimum_edge_length_mm, 1.0);
        assert_eq!(settings.transform_angle_deduplication_tolerance_deg, 0.01);
        assert!(settings.configured_rotation_enabled);
        assert!(settings.edge_alignment_enabled);
        assert_eq!(settings.configured_rotation_deg, Vec::<f64>::new());
        assert!(!settings.ga_enabled);
        assert!(settings.baseline_only);
        assert_eq!(
            settings.ga_generation_budget,
            DEFAULT_IRREGULAR_GA_GENERATION_BUDGET
        );
        assert_eq!(
            settings.ga_evaluation_budget,
            DEFAULT_IRREGULAR_GA_EVALUATION_BUDGET
        );
        assert!(settings.priority_order_mutation_enabled);
        assert!(settings.transform_preference_mutation_enabled);
        assert!(settings.placement_policy_mutation_enabled);
        assert_eq!(
            settings.placement_policy_id,
            DEFAULT_IRREGULAR_PLACEMENT_POLICY_ID
        );
        assert_eq!(
            settings.placement_policy_ids,
            default_irregular_placement_policy_ids()
        );
    }

    /// Parses the real `irregularSettings` object embedded in
    /// `tests/fixtures/irregularSheetInvariance/mixed61-request.json`'s
    /// `options` field, proving the field names/types/enum spellings this
    /// module declares match a genuine production payload byte-for-byte
    /// (not just a hand-written sample).
    #[test]
    fn irregular_nesting_settings_deserializes_the_mixed61_fixture_payload() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/irregularSheetInvariance/mixed61-request.json");
        let raw = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|err| panic!("failed to read {fixture_path:?}: {err}"));
        let request: serde_json::Value =
            serde_json::from_str(&raw).expect("fixture parses as JSON");
        let irregular_settings = request
            .get("options")
            .and_then(|options| options.get("irregularSettings"))
            .expect("fixture has options.irregularSettings");
        let settings: IrregularNestingSettings = serde_json::from_value(irregular_settings.clone())
            .expect("fixture irregularSettings decodes as IrregularNestingSettings");

        assert_eq!(settings.geometry.flattening_sag_tolerance_mm, 0.25);
        assert_eq!(settings.geometry.clearance_safety_margin_mm, 0.25);
        assert_eq!(settings.optimizer.order_window, 4.0);
        assert_eq!(settings.optimizer.beam_width, 8.0);
        assert_eq!(settings.optimizer.transform_cap, 8.0);
        assert_eq!(settings.optimizer.ga_seed, "default");
        assert_eq!(
            settings.optimizer.placement_policy_id,
            IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness
        );
        assert_eq!(
            settings.optimizer.placement_policy_ids,
            default_irregular_placement_policy_ids()
        );

        // Round trip back to JSON and re-decode to prove no information is
        // lost through this module's own encode side too.
        let re_encoded = serde_json::to_string(&settings).expect("settings re-serialize");
        let round_tripped: IrregularNestingSettings =
            serde_json::from_str(&re_encoded).expect("settings re-deserialize");
        assert_eq!(round_tripped, settings);
    }
}
