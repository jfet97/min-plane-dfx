//! Trusted request DTO: `serde::Deserialize` of the exact wire JSON
//! `nesting.worker.ts` passes for an irregular (`irregular-convex-v2`) job,
//! plus the Rust-side safety-critical revalidation the new JS<->native trust
//! boundary requires (migration prompt §7; native-boundary.md §7, §13.1).
//!
//! TS source of the wire shape: `src/shared/domain/nesting.ts:97-152`
//! (`NestingOptions`, `PreparedPiece`, `NestingRequest`), `src/shared/domain/geometry.ts:29-49`
//! (`Rect`/`RectWith`, flattened -- `RectWith extends Rect.extend`).
//!
//! # Reuse, not a second copy
//!
//! Every nested shape this crate has already ported with a matching wire
//! encoding (`crate::domain::{SheetSpec, Rect, ImportedPiece,
//! IrregularNestingSettings}`) is decoded directly via its own existing
//! `serde::Deserialize` impl -- this module declares new DTO structs only
//! for the handful of shapes that either have no `crate::domain` counterpart
//! yet (`PreparedPiece`/`RectWith`/`CutRowRef` are a `search::sort_pieces`-owned
//! provisional mirror, per that module's own top doc) or that belong to this
//! boundary layer specifically (`version`/`jobId`/`strategyRunId`, per
//! `result::mod`'s own "out of this module's scope" note).
//!
//! # Presence/omission semantics
//!
//! Matches `nesting.ts`'s own `Schema.optional`/`withDecodingDefaultKey`
//! declarations field-for-field:
//! - `sourcePieces`: absent -> `[]` (`#[serde(default)]`) -- TS resolves the
//!   same way at the one call site that reads it
//!   (`computeIrregularNesting.ts:381`), so there is no behavioral
//!   difference, only a representation choice (native-boundary.md §7.1).
//! - `strategyRunId`: genuinely presence-sensitive, `Option<String>`.
//! - `allowGlobalMirror`/piece `allowMirror`: `withConstructorDefault`/
//!   `withDecodingDefaultKey(true)` -- `#[serde(default = "default_true")]`.
//! - `interchangeabilityKey`/`cutRowRef`: plain `Schema.optional`, no
//!   default -- `Option<T>` with no `#[serde(default)]` (absent is an error
//!   only if the field is *required*; these two are genuinely optional on
//!   the wire, so `Option` alone is correct and `serde` already treats a
//!   missing `Option` field as `None` without an explicit default).
//! - `options.irregularSettings`: native-boundary.md §7.4 requires
//!   TypeScript to have already resolved this to a concrete value
//!   (`GeometrySettings.Make` when the request omits it) before constructing
//!   the request this boundary receives -- so this DTO declares it
//!   `required`. An omitted key is a revalidation failure here (§13.1: "a
//!   future TypeScript regression that stops validating before calling
//!   Rust"), not a second copy of the TS-side default.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::domain::{
    ImportedPiece, IntrinsicObjectiveProfileId, IrregularNestingSettings,
    IrregularPlacementPolicyId, Rect, SheetSpec,
};
use crate::result::{
    intrinsic_shared_archive_eligibility, HistoryMode, IntrinsicSharedArchiveEligibility,
    IntrinsicSharedArchiveIneligibilityReason, NestingOptions, NestingRequest,
};
use crate::search::sort_pieces::{CutRowRef, PreparedPiece, RectWith};

use super::error::BoundaryError;

// ===========================================================================
// Wire DTOs
// ===========================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDto {
    pub version: u32,
    pub job_id: String,
    pub sheet: SheetSpec,
    pub padding: f64,
    pub pieces: Vec<PreparedPieceDto>,
    #[serde(default)]
    pub source_pieces: Vec<ImportedPiece>,
    pub options: NestingOptionsDto,
    pub strategy_run_id: Option<String>,
}

/// TS: `geometry.ts:29-49`'s `RectWith` flattened wire shape
/// (`x,y,width,height,longestEdge,area,imbalance`), matching
/// `native-boundary.md` §7.3's `NativeRectWith`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectWithDto {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub longest_edge: f64,
    pub area: f64,
    pub imbalance: f64,
}

impl From<RectWithDto> for RectWith {
    fn from(dto: RectWithDto) -> Self {
        RectWith {
            rect: Rect {
                x: dto.x,
                y: dto.y,
                width: dto.width,
                height: dto.height,
            },
            longest_edge: dto.longest_edge,
            area: dto.area,
            imbalance: dto.imbalance,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutRowRefDto {
    pub reference: String,
    pub customer_name: String,
    pub csv_row_id: String,
}

impl From<CutRowRefDto> for CutRowRef {
    fn from(dto: CutRowRefDto) -> Self {
        CutRowRef {
            reference: dto.reference,
            customer_name: dto.customer_name,
            csv_row_id: dto.csv_row_id,
        }
    }
}

fn default_true() -> bool {
    true
}

/// TS: `nesting.ts:120-141` `PreparedPiece`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPieceDto {
    pub id: String,
    pub source_piece_id: String,
    pub interchangeability_key: Option<String>,
    pub real_bounds: Rect,
    pub padded_bounds: RectWithDto,
    pub padding: f64,
    pub allow_rotation: bool,
    #[serde(default = "default_true")]
    pub allow_mirror: bool,
    pub cut_row_ref: Option<CutRowRefDto>,
}

impl From<PreparedPieceDto> for PreparedPiece {
    fn from(dto: PreparedPieceDto) -> Self {
        PreparedPiece {
            id: dto.id.into(),
            source_piece_id: dto.source_piece_id.into(),
            interchangeability_key: dto.interchangeability_key,
            real_bounds: dto.real_bounds,
            padded_bounds: dto.padded_bounds.into(),
            padding: dto.padding,
            allow_rotation: dto.allow_rotation,
            allow_mirror: dto.allow_mirror,
            cut_row_ref: dto.cut_row_ref.map(CutRowRef::from),
        }
    }
}

/// TS: `nesting.ts:97-118` `NestingOptions`, limited to the fields
/// `result::coordinator`'s ported cluster reads -- see `result::mod`'s own
/// top doc, "Deliberately not ported", for the fields this DTO does not
/// declare (`historyScope`, `strategySelectionMode`, `strategyIds`,
/// `layoutSelectionStrategyId`, `finalSelectionMode`, `topN`,
/// `maxHistoryEvents`). `serde` ignores unrecognized wire keys by default,
/// so TypeScript may keep sending them without a decode error here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NestingOptionsDto {
    pub allow_global_rotation: bool,
    #[serde(default = "default_true")]
    pub allow_global_mirror: bool,
    pub timeout_ms: f64,
    pub worker_mode: String,
    pub history_mode: String,
    pub irregular_settings: IrregularNestingSettings,
}

// ===========================================================================
// Prepared (post-revalidation) request.
// ===========================================================================

/// The result of decoding + revalidating a [`RequestDto`]: everything
/// `boundary::job` needs to execute one job, split into the boundary-owned
/// identity fields (`job_id`/`strategy_run_id`) and the
/// `result::coordinator`-shaped `request`/`settings` pair
/// `compute_irregular_nesting` takes directly.
#[derive(Debug)]
pub struct PreparedRequest {
    pub job_id: String,
    pub strategy_run_id: Option<String>,
    pub history_mode: HistoryMode,
    pub settings: IrregularNestingSettings,
    pub request: NestingRequest,
}

impl RequestDto {
    /// Decodes `json` and revalidates every safety-critical invariant
    /// native-boundary.md §13.1 lists, in the order listed there. Never
    /// assumes the TypeScript caller already validated -- this is a new,
    /// genuine JS<->native trust boundary (migration prompt §7).
    pub fn decode_and_prepare(json: &str) -> Result<PreparedRequest, BoundaryError> {
        let dto: RequestDto = serde_json::from_str(json).map_err(|err| {
            if err.to_string().contains("number out of range") {
                BoundaryError::revalidation_failed(format!(
                    "request numeric field must be finite and within binary64 range: {err}"
                ))
            } else {
                BoundaryError::malformed_request_json(&err)
            }
        })?;
        dto.prepare()
    }

    fn prepare(self) -> Result<PreparedRequest, BoundaryError> {
        if self.version != 1 {
            return Err(BoundaryError::native_api_version_mismatch(self.version));
        }
        if self.job_id.trim().is_empty() {
            return Err(BoundaryError::revalidation_failed(
                "jobId must be a non-empty string",
            ));
        }
        if let Some(strategy_run_id) = &self.strategy_run_id {
            require_non_empty_string("strategyRunId", strategy_run_id)?;
        }
        if self.options.worker_mode != "irregular-convex-v2" {
            return Err(BoundaryError::revalidation_failed(format!(
                "options.workerMode must be 'irregular-convex-v2', received {:?}",
                self.options.worker_mode
            )));
        }
        require_finite("options.timeoutMs", self.options.timeout_ms)?;
        require_positive("options.timeoutMs", self.options.timeout_ms)?;

        require_positive_finite_integer("sheet.width", self.sheet.width)?;
        require_positive_finite_integer("sheet.height", self.sheet.height)?;

        require_non_negative_finite_integer("padding", self.padding)?;

        if self.pieces.is_empty() {
            return Err(BoundaryError::revalidation_failed(
                "pieces must be a non-empty array",
            ));
        }
        let mut piece_ids = BTreeMap::new();
        for (index, piece) in self.pieces.iter().enumerate() {
            validate_prepared_piece(index, piece)?;
            if let Some(first_index) = piece_ids.insert(piece.id.as_str(), index) {
                return Err(BoundaryError::revalidation_failed(format!(
                    "pieces[{index}].id is a duplicate piece id {:?}; first used at pieces[{first_index}].id",
                    piece.id
                )));
            }
        }

        validate_geometry_settings(&self.options.irregular_settings)?;
        validate_optimizer_settings(&self.options.irregular_settings.optimizer)?;

        let history_mode = match self.options.history_mode.as_str() {
            "stream" => HistoryMode::Stream,
            "final" => HistoryMode::Final,
            "off" => HistoryMode::Off,
            other => {
                let message = format!(
                    "options.historyMode must be one of 'stream' | 'final' | 'off', received {other:?}"
                );
                return Err(BoundaryError::revalidation_failed(message));
            }
        };

        let settings = self.options.irregular_settings.clone();
        let pieces: Vec<PreparedPiece> = self.pieces.into_iter().map(PreparedPiece::from).collect();
        let request = NestingRequest {
            sheet: self.sheet,
            padding: self.padding,
            pieces,
            source_pieces: self.source_pieces,
            options: NestingOptions {
                allow_global_rotation: self.options.allow_global_rotation,
                allow_global_mirror: Some(self.options.allow_global_mirror),
                history_mode,
                irregular_settings: Some(settings.clone()),
            },
        };

        Ok(PreparedRequest {
            job_id: self.job_id,
            strategy_run_id: self.strategy_run_id,
            history_mode,
            settings,
            request,
        })
    }
}

fn require_finite(name: &str, value: f64) -> Result<(), BoundaryError> {
    if !value.is_finite() {
        return Err(BoundaryError::revalidation_failed(format!(
            "{name} must be a finite number, received {value}"
        )));
    }
    Ok(())
}

fn require_positive(name: &str, value: f64) -> Result<(), BoundaryError> {
    // Not `!(value > 0.0)`: NaN would slip through that negation (`NaN > 0.0`
    // is `false`, so `!false` is `true`, correctly rejecting -- but clippy's
    // `neg_cmp_op_on_partial_ord` flags the pattern generally). Every call
    // site already runs `require_finite` first, but this check does not rely
    // on that ordering: `value.is_nan()` rejects NaN explicitly regardless of
    // caller order.
    if value.is_nan() || value <= 0.0 {
        return Err(BoundaryError::revalidation_failed(format!(
            "{name} must be > 0, received {value}"
        )));
    }
    Ok(())
}

fn require_non_negative(name: &str, value: f64) -> Result<(), BoundaryError> {
    if value.is_nan() || value < 0.0 {
        return Err(BoundaryError::revalidation_failed(format!(
            "{name} must be >= 0, received {value}"
        )));
    }
    Ok(())
}

fn require_integer(name: &str, value: f64) -> Result<(), BoundaryError> {
    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

    if value.fract() != 0.0 || value.abs() > MAX_SAFE_INTEGER {
        return Err(BoundaryError::revalidation_failed(format!(
            "{name} must be a safe integer, received {value}"
        )));
    }
    Ok(())
}

fn require_positive_finite_integer(name: &str, value: f64) -> Result<(), BoundaryError> {
    require_finite(name, value)?;
    require_positive(name, value)?;
    require_integer(name, value)
}

fn require_non_negative_finite_integer(name: &str, value: f64) -> Result<(), BoundaryError> {
    require_finite(name, value)?;
    require_non_negative(name, value)?;
    require_integer(name, value)
}

fn require_non_empty_string(name: &str, value: &str) -> Result<(), BoundaryError> {
    if value.is_empty() {
        return Err(BoundaryError::revalidation_failed(format!(
            "{name} must be a non-empty string"
        )));
    }
    Ok(())
}

fn validate_prepared_piece(index: usize, piece: &PreparedPieceDto) -> Result<(), BoundaryError> {
    let prefix = format!("pieces[{index}]");
    if piece.id.trim().is_empty() {
        return Err(BoundaryError::revalidation_failed(format!(
            "{prefix}.id must be a non-empty string"
        )));
    }
    require_non_empty_string(&format!("{prefix}.sourcePieceId"), &piece.source_piece_id)?;
    if let Some(interchangeability_key) = &piece.interchangeability_key {
        require_non_empty_string(
            &format!("{prefix}.interchangeabilityKey"),
            interchangeability_key,
        )?;
    }
    require_non_negative_finite_integer(&format!("{prefix}.padding"), piece.padding)?;

    for (label, value) in [
        ("realBounds.x", piece.real_bounds.x),
        ("realBounds.y", piece.real_bounds.y),
        ("paddedBounds.x", piece.padded_bounds.x),
        ("paddedBounds.y", piece.padded_bounds.y),
    ] {
        require_non_negative_finite_integer(&format!("{prefix}.{label}"), value)?;
    }
    for (label, value) in [
        ("realBounds.width", piece.real_bounds.width),
        ("realBounds.height", piece.real_bounds.height),
        ("paddedBounds.width", piece.padded_bounds.width),
        ("paddedBounds.height", piece.padded_bounds.height),
        ("paddedBounds.longestEdge", piece.padded_bounds.longest_edge),
        ("paddedBounds.area", piece.padded_bounds.area),
    ] {
        require_positive_finite_integer(&format!("{prefix}.{label}"), value)?;
    }
    require_non_negative_finite_integer(
        &format!("{prefix}.paddedBounds.imbalance"),
        piece.padded_bounds.imbalance,
    )?;
    Ok(())
}

/// TS: `domain.ts:285-294` cross-field check, re-checked here per
/// native-boundary.md §13.1 (Seam A's own check is not trusted blindly).
fn validate_geometry_settings(settings: &IrregularNestingSettings) -> Result<(), BoundaryError> {
    let geometry = &settings.geometry;
    require_finite(
        "options.irregularSettings.geometry.flatteningSagToleranceMm",
        geometry.flattening_sag_tolerance_mm,
    )?;
    require_positive(
        "options.irregularSettings.geometry.flatteningSagToleranceMm",
        geometry.flattening_sag_tolerance_mm,
    )?;
    require_finite(
        "options.irregularSettings.geometry.clearanceSafetyMarginMm",
        geometry.clearance_safety_margin_mm,
    )?;
    require_non_negative(
        "options.irregularSettings.geometry.clearanceSafetyMarginMm",
        geometry.clearance_safety_margin_mm,
    )?;
    require_non_empty_string(
        "options.irregularSettings.geometry.geometryBackendId",
        &geometry.geometry_backend_id,
    )?;
    require_non_empty_string(
        "options.irregularSettings.geometry.geometryBackendVersion",
        &geometry.geometry_backend_version,
    )?;
    if geometry.clearance_safety_margin_mm < geometry.flattening_sag_tolerance_mm {
        return Err(BoundaryError::revalidation_failed(
            "options.irregularSettings.geometry.clearanceSafetyMarginMm must be >= flatteningSagToleranceMm",
        ));
    }
    Ok(())
}

/// TS: `domain.ts:301-458` scalar refinements and cross-field `.check()`
/// filter, re-checked here per native-boundary.md §13.1.
fn validate_optimizer_settings(
    optimizer: &crate::domain::IrregularOptimizerSettings,
) -> Result<(), BoundaryError> {
    const PREFIX: &str = "options.irregularSettings.optimizer";

    require_positive_finite_integer(&format!("{PREFIX}.orderWindow"), optimizer.order_window)?;
    require_positive_finite_integer(&format!("{PREFIX}.beamWidth"), optimizer.beam_width)?;
    require_positive_finite_integer(
        &format!("{PREFIX}.localCandidateFanout"),
        optimizer.local_candidate_fanout,
    )?;
    require_non_negative_finite_integer(
        &format!("{PREFIX}.localRepairBudget"),
        optimizer.local_repair_budget,
    )?;
    require_positive_finite_integer(&format!("{PREFIX}.transformCap"), optimizer.transform_cap)?;
    require_finite(
        &format!("{PREFIX}.transformMinimumEdgeLengthMm"),
        optimizer.transform_minimum_edge_length_mm,
    )?;
    require_non_negative(
        &format!("{PREFIX}.transformMinimumEdgeLengthMm"),
        optimizer.transform_minimum_edge_length_mm,
    )?;
    require_finite(
        &format!("{PREFIX}.transformAngleDeduplicationToleranceDeg"),
        optimizer.transform_angle_deduplication_tolerance_deg,
    )?;
    require_positive(
        &format!("{PREFIX}.transformAngleDeduplicationToleranceDeg"),
        optimizer.transform_angle_deduplication_tolerance_deg,
    )?;
    for (index, rotation_deg) in optimizer.configured_rotation_deg.iter().enumerate() {
        require_finite(
            &format!("{PREFIX}.configuredRotationDeg[{index}]"),
            *rotation_deg,
        )?;
    }
    require_positive_finite_integer(&format!("{PREFIX}.gaPopulation"), optimizer.ga_population)?;
    require_non_negative_finite_integer(
        &format!("{PREFIX}.gaGenerationBudget"),
        optimizer.ga_generation_budget,
    )?;
    require_non_negative_finite_integer(
        &format!("{PREFIX}.gaEvaluationBudget"),
        optimizer.ga_evaluation_budget,
    )?;
    require_non_negative_finite_integer(
        &format!("{PREFIX}.gaTimeBudgetMs"),
        optimizer.ga_time_budget_ms,
    )?;
    require_non_empty_string(&format!("{PREFIX}.gaSeed"), &optimizer.ga_seed)?;

    if optimizer.placement_policy_ids.is_empty() {
        return Err(BoundaryError::revalidation_failed(
            "options.irregularSettings.optimizer.placementPolicyIds must be non-empty",
        ));
    }
    if !optimizer
        .placement_policy_ids
        .contains(&optimizer.placement_policy_id)
    {
        return Err(BoundaryError::revalidation_failed(
            "options.irregularSettings.optimizer.placementPolicyId must be a member of placementPolicyIds",
        ));
    }
    let mut seen: BTreeMap<&'static str, ()> = BTreeMap::new();
    for policy in &optimizer.placement_policy_ids {
        let key = placement_policy_key(*policy);
        if seen.insert(key, ()).is_some() {
            return Err(BoundaryError::revalidation_failed(
                "options.irregularSettings.optimizer.placementPolicyIds must not contain duplicates",
            ));
        }
    }

    if optimizer.intrinsic_objective_profile_id == IntrinsicObjectiveProfileId::ShortSide {
        let ga_disabled = !optimizer.ga_enabled
            || optimizer.baseline_only
            || optimizer.ga_time_budget_ms == 0.0
            || optimizer.ga_generation_budget == 0.0
            || optimizer.ga_evaluation_budget == 0.0;
        if !optimizer.intrinsic_shared_archive_enabled
            || !ga_disabled
            || optimizer.placement_policy_id == IrregularPlacementPolicyId::ShortSideFill
        {
            return Err(BoundaryError::revalidation_failed(
                "short-side profile requires intrinsicSharedArchiveEnabled=true, GA fully disabled, and placementPolicyId != 'short-side-fill'",
            ));
        }
    }
    Ok(())
}

fn placement_policy_key(policy: IrregularPlacementPolicyId) -> &'static str {
    match policy {
        IrregularPlacementPolicyId::BalancedCompactness => "balanced-compactness",
        IrregularPlacementPolicyId::ShortSideFill => "short-side-fill",
        IrregularPlacementPolicyId::EdgeContactThenBalancedCompactness => {
            "edge-contact-then-balanced-compactness"
        }
    }
}

/// §13.1's "load-bearing scope check": non-eligible requests must be
/// rejected with a typed routing error, never silently executed or emulated.
pub fn require_archive_eligible(settings: &IrregularNestingSettings) -> Result<(), BoundaryError> {
    match intrinsic_shared_archive_eligibility(&settings.optimizer) {
        IntrinsicSharedArchiveEligibility::Eligible => Ok(()),
        IntrinsicSharedArchiveEligibility::Ineligible(reason) => {
            let reason_str = match reason {
                IntrinsicSharedArchiveIneligibilityReason::ArchiveDisabled => {
                    "intrinsicSharedArchiveEnabled is false"
                }
                IntrinsicSharedArchiveIneligibilityReason::GaActive => "GA is active",
                IntrinsicSharedArchiveIneligibilityReason::ShortSideFill => {
                    "placementPolicyId is 'short-side-fill'"
                }
            };
            Err(BoundaryError::archive_ineligible_routing(reason_str))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request_json() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "jobId": "job-1",
            "sheet": {"width": 1000.0, "height": 500.0, "label": "sheet-1"},
            "padding": 2.0,
            "pieces": [
                {
                    "id": "piece-1",
                    "sourcePieceId": "source-1",
                    "realBounds": {"x": 0.0, "y": 0.0, "width": 100.0, "height": 60.0},
                    "paddedBounds": {
                        "x": 0.0, "y": 0.0, "width": 104.0, "height": 64.0,
                        "longestEdge": 104.0, "area": 6656.0, "imbalance": 40.0
                    },
                    "padding": 2.0,
                    "allowRotation": true
                }
            ],
            "sourcePieces": [],
            "options": {
                "allowGlobalRotation": true,
                "timeoutMs": 60000.0,
                "workerMode": "irregular-convex-v2",
                "historyMode": "off",
                "irregularSettings": {
                    "geometry": {
                        "flatteningSagToleranceMm": 0.25,
                        "clearanceSafetyMarginMm": 0.25,
                        "geometryBackendId": "clipper2-rs-vendor",
                        "geometryBackendVersion": "0"
                    },
                    "optimizer": {
                        "orderWindow": 4,
                        "beamWidth": 8,
                        "transformCap": 8,
                        "gaPopulation": 12,
                        "gaTimeBudgetMs": 15000,
                        "gaSeed": "default",
                        "intrinsicSharedArchiveEnabled": true
                    }
                }
            }
        })
    }

    #[test]
    fn decodes_and_prepares_a_minimal_valid_request() {
        let json = sample_request_json().to_string();
        let prepared = RequestDto::decode_and_prepare(&json).expect("request prepares");
        assert_eq!(prepared.job_id, "job-1");
        assert_eq!(prepared.request.pieces.len(), 1);
        assert_eq!(prepared.request.sheet.width, 1000.0);
        assert!(require_archive_eligible(&prepared.settings).is_ok());
    }

    #[test]
    fn rejects_malformed_json() {
        let error = RequestDto::decode_and_prepare("{not json").unwrap_err();
        assert_eq!(error.category, "worker_protocol_error");
        assert_eq!(error.operation, "decodeRequestJson");
    }

    #[test]
    fn rejects_version_mismatch() {
        let mut json = sample_request_json();
        json["version"] = serde_json::json!(2);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "worker_protocol_error");
        assert_eq!(error.context.get("nativeApiVersion").unwrap(), "1");
    }

    #[test]
    fn rejects_non_irregular_worker_mode() {
        let mut json = sample_request_json();
        json["options"]["workerMode"] = serde_json::json!("maxrects-beam-search");
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert_eq!(error.operation, "nativeBoundaryRevalidation");
        assert!(error.message.contains("workerMode"));
    }

    #[test]
    fn rejects_non_positive_sheet_dimensions() {
        let mut json = sample_request_json();
        json["sheet"]["width"] = serde_json::json!(0.0);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert_eq!(error.operation, "nativeBoundaryRevalidation");
    }

    #[test]
    fn maps_overflowing_json_numbers_to_native_revalidation_failure() {
        let json =
            sample_request_json()
                .to_string()
                .replacen("\"width\":1000.0", "\"width\":1e400", 1);
        let error = RequestDto::decode_and_prepare(&json).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert_eq!(error.operation, "nativeBoundaryRevalidation");
        assert!(error.message.contains("number out of range"));
    }

    /*
     * JSON cannot spell NaN or infinity directly. The overflowing-number test
     * above covers the valid JSON form that Node parses to infinity, while
     * this helper-level test retains defense-in-depth for Rust callers that
     * construct RequestDto values without JSON.
     */
    #[test]
    fn require_finite_rejects_nan_and_infinite_values() {
        assert!(require_finite("x", f64::NAN).is_err());
        assert!(require_finite("x", f64::INFINITY).is_err());
        assert!(require_finite("x", f64::NEG_INFINITY).is_err());
        assert!(require_finite("x", 1.5).is_ok());
    }

    #[test]
    fn rejects_non_positive_timeout() {
        for timeout_ms in [0.0, -1.0] {
            let mut json = sample_request_json();
            json["options"]["timeoutMs"] = serde_json::json!(timeout_ms);
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(error.message.contains("timeoutMs"));
        }
    }

    #[test]
    fn rejects_empty_source_piece_and_strategy_run_ids() {
        let mut source_piece_id_request = sample_request_json();
        source_piece_id_request["pieces"][0]["sourcePieceId"] = serde_json::json!("");

        let mut strategy_run_id_request = sample_request_json();
        strategy_run_id_request["strategyRunId"] = serde_json::json!("");

        for json in [source_piece_id_request, strategy_run_id_request] {
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
        }
    }

    #[test]
    fn rejects_duplicate_piece_ids() {
        let mut json = sample_request_json();
        let duplicate = json["pieces"][0].clone();
        json["pieces"]
            .as_array_mut()
            .expect("pieces is an array")
            .push(duplicate);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert!(error.message.contains("duplicate piece id"));
    }

    #[test]
    fn rejects_empty_pieces() {
        let mut json = sample_request_json();
        json["pieces"] = serde_json::json!([]);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert!(error.message.contains("pieces"));
    }

    #[test]
    fn rejects_empty_interchangeability_key() {
        let mut json = sample_request_json();
        json["pieces"][0]["interchangeabilityKey"] = serde_json::json!("");
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert!(error.message.contains("interchangeabilityKey"));
    }

    #[test]
    fn rejects_negative_padding() {
        let mut json = sample_request_json();
        json["padding"] = serde_json::json!(-1.0);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
    }

    #[test]
    fn rejects_fractional_integer_millimeter_fields_through_request_decode() {
        let cases = [
            ("/sheet/width", "sheet.width"),
            ("/sheet/height", "sheet.height"),
            ("/padding", "padding"),
            ("/pieces/0/padding", "pieces[0].padding"),
            ("/pieces/0/realBounds/x", "pieces[0].realBounds.x"),
            ("/pieces/0/realBounds/y", "pieces[0].realBounds.y"),
            ("/pieces/0/realBounds/width", "pieces[0].realBounds.width"),
            ("/pieces/0/realBounds/height", "pieces[0].realBounds.height"),
            ("/pieces/0/paddedBounds/x", "pieces[0].paddedBounds.x"),
            ("/pieces/0/paddedBounds/y", "pieces[0].paddedBounds.y"),
            (
                "/pieces/0/paddedBounds/width",
                "pieces[0].paddedBounds.width",
            ),
            (
                "/pieces/0/paddedBounds/height",
                "pieces[0].paddedBounds.height",
            ),
            (
                "/pieces/0/paddedBounds/longestEdge",
                "pieces[0].paddedBounds.longestEdge",
            ),
            ("/pieces/0/paddedBounds/area", "pieces[0].paddedBounds.area"),
            (
                "/pieces/0/paddedBounds/imbalance",
                "pieces[0].paddedBounds.imbalance",
            ),
        ];

        for (pointer, expected_message) in cases {
            let mut json = sample_request_json();
            *json.pointer_mut(pointer).expect("test field exists") = serde_json::json!(1.5);
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(expected_message),
                "expected {expected_message:?} in {message:?}",
                message = error.message
            );
        }
    }

    #[test]
    fn rejects_unsafe_integer_values_through_request_decode() {
        const UNSAFE_INTEGER: f64 = 9_007_199_254_740_992.0;
        let cases = [
            ("/sheet/width", "sheet.width"),
            ("/padding", "padding"),
            ("/pieces/0/padding", "pieces[0].padding"),
            ("/pieces/0/paddedBounds/area", "pieces[0].paddedBounds.area"),
            (
                "/options/irregularSettings/optimizer/orderWindow",
                "orderWindow",
            ),
            (
                "/options/irregularSettings/optimizer/gaTimeBudgetMs",
                "gaTimeBudgetMs",
            ),
        ];

        for (pointer, expected_message) in cases {
            let mut json = sample_request_json();
            *json.pointer_mut(pointer).expect("test field exists") =
                serde_json::json!(UNSAFE_INTEGER);
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(expected_message),
                "expected {expected_message:?} in {message:?}",
                message = error.message
            );
        }
    }

    #[test]
    fn rejects_fractional_optimizer_integers_through_request_decode() {
        let cases = [
            ("orderWindow", "orderWindow"),
            ("beamWidth", "beamWidth"),
            ("localCandidateFanout", "localCandidateFanout"),
            ("localRepairBudget", "localRepairBudget"),
            ("transformCap", "transformCap"),
            ("gaPopulation", "gaPopulation"),
            ("gaGenerationBudget", "gaGenerationBudget"),
            ("gaEvaluationBudget", "gaEvaluationBudget"),
            ("gaTimeBudgetMs", "gaTimeBudgetMs"),
        ];

        for (field, expected_message) in cases {
            let mut json = sample_request_json();
            json["options"]["irregularSettings"]["optimizer"][field] = serde_json::json!(1.5);
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(expected_message),
                "expected {expected_message:?} in {message:?}",
                message = error.message
            );
        }
    }

    #[test]
    fn rejects_geometry_settings_cross_field_violation() {
        let mut json = sample_request_json();
        json["options"]["irregularSettings"]["geometry"]["clearanceSafetyMarginMm"] =
            serde_json::json!(0.1);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert!(error.message.contains("clearanceSafetyMarginMm"));
    }

    #[test]
    fn rejects_scalar_and_identity_refinements_through_request_decode() {
        let optimizer_cases = [
            ("transformMinimumEdgeLengthMm", serde_json::json!(-1)),
            (
                "transformAngleDeduplicationToleranceDeg",
                serde_json::json!(0),
            ),
            ("gaSeed", serde_json::json!("")),
        ];
        for (field, value) in optimizer_cases {
            let mut json = sample_request_json();
            json["options"]["irregularSettings"]["optimizer"][field] = value;
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(field),
                "expected {field:?} in {message:?}",
                message = error.message
            );
        }

        for field in ["geometryBackendId", "geometryBackendVersion"] {
            let mut json = sample_request_json();
            json["options"]["irregularSettings"]["geometry"][field] = serde_json::json!("");
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(field),
                "expected {field:?} in {message:?}",
                message = error.message
            );
        }
    }

    #[test]
    fn rejects_policy_list_invariants_through_request_decode() {
        let cases = [
            (
                serde_json::json!([]),
                "placementPolicyIds must be non-empty",
            ),
            (
                serde_json::json!(["short-side-fill"]),
                "placementPolicyId must be a member",
            ),
            (
                serde_json::json!(["balanced-compactness", "balanced-compactness"]),
                "placementPolicyIds must not contain duplicates",
            ),
        ];

        for (policy_ids, expected_message) in cases {
            let mut json = sample_request_json();
            json["options"]["irregularSettings"]["optimizer"]["placementPolicyIds"] = policy_ids;
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(
                error.message.contains(expected_message),
                "expected {expected_message:?} in {message:?}",
                message = error.message
            );
        }
    }

    #[test]
    fn rejects_short_side_cross_field_violations_through_request_decode() {
        let cases = [
            ("intrinsicSharedArchiveEnabled", serde_json::json!(false)),
            ("gaEnabled", serde_json::json!(true)),
            ("placementPolicyId", serde_json::json!("short-side-fill")),
        ];

        for (field, value) in cases {
            let mut json = sample_request_json();
            let optimizer = &mut json["options"]["irregularSettings"]["optimizer"];
            optimizer["intrinsicObjectiveProfileId"] = serde_json::json!("short-side");
            optimizer["intrinsicSharedArchiveEnabled"] = serde_json::json!(true);
            optimizer["baselineOnly"] = serde_json::json!(false);
            optimizer["gaEnabled"] = serde_json::json!(false);
            optimizer["gaTimeBudgetMs"] = serde_json::json!(1);
            optimizer["gaGenerationBudget"] = serde_json::json!(1);
            optimizer["gaEvaluationBudget"] = serde_json::json!(1);
            optimizer[field] = value;
            if field == "placementPolicyId" {
                optimizer["placementPolicyIds"] = serde_json::json!([
                    "balanced-compactness",
                    "short-side-fill",
                    "edge-contact-then-balanced-compactness"
                ]);
            }
            let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
            assert_eq!(error.category, "irregular_geometry_invalid");
            assert!(error.message.contains("short-side profile requires"));
        }
    }

    #[test]
    fn rejects_placement_policy_id_not_a_member_of_ids() {
        let mut json = sample_request_json();
        json["options"]["irregularSettings"]["optimizer"]["placementPolicyId"] =
            serde_json::json!("short-side-fill");
        json["options"]["irregularSettings"]["optimizer"]["placementPolicyIds"] =
            serde_json::json!(["balanced-compactness"]);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert!(error.message.contains("placementPolicyId"));
    }

    fn sample_optimizer_settings() -> crate::domain::IrregularOptimizerSettings {
        RequestDto::decode_and_prepare(&sample_request_json().to_string())
            .expect("sample request prepares")
            .settings
            .optimizer
    }

    fn sample_settings() -> IrregularNestingSettings {
        RequestDto::decode_and_prepare(&sample_request_json().to_string())
            .expect("sample request prepares")
            .settings
    }

    fn assert_revalidation_failure(result: Result<(), BoundaryError>, expected_message: &str) {
        let error = result.expect_err("revalidation rejects invalid settings");
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert_eq!(error.operation, "nativeBoundaryRevalidation");
        assert!(
            error.message.contains(expected_message),
            "expected {expected_message:?} in {message:?}",
            message = error.message
        );
    }

    #[derive(Clone, Copy)]
    enum PositiveIntegerField {
        OrderWindow,
        BeamWidth,
        LocalCandidateFanout,
        TransformCap,
        GaPopulation,
    }

    impl PositiveIntegerField {
        fn name(self) -> &'static str {
            match self {
                Self::OrderWindow => "orderWindow",
                Self::BeamWidth => "beamWidth",
                Self::LocalCandidateFanout => "localCandidateFanout",
                Self::TransformCap => "transformCap",
                Self::GaPopulation => "gaPopulation",
            }
        }

        fn set(self, optimizer: &mut crate::domain::IrregularOptimizerSettings, value: f64) {
            match self {
                Self::OrderWindow => optimizer.order_window = value,
                Self::BeamWidth => optimizer.beam_width = value,
                Self::LocalCandidateFanout => optimizer.local_candidate_fanout = value,
                Self::TransformCap => optimizer.transform_cap = value,
                Self::GaPopulation => optimizer.ga_population = value,
            }
        }
    }

    #[test]
    fn revalidates_positive_finite_optimizer_integer_fields() {
        let cases = [
            (PositiveIntegerField::OrderWindow, 0.0),
            (PositiveIntegerField::OrderWindow, 1.5),
            (PositiveIntegerField::OrderWindow, f64::NAN),
            (PositiveIntegerField::BeamWidth, 0.0),
            (PositiveIntegerField::BeamWidth, 1.5),
            (PositiveIntegerField::BeamWidth, f64::NAN),
            (PositiveIntegerField::LocalCandidateFanout, 0.0),
            (PositiveIntegerField::LocalCandidateFanout, 1.5),
            (PositiveIntegerField::LocalCandidateFanout, f64::NAN),
            (PositiveIntegerField::TransformCap, 0.0),
            (PositiveIntegerField::TransformCap, 1.5),
            (PositiveIntegerField::TransformCap, f64::NAN),
            (PositiveIntegerField::GaPopulation, 0.0),
            (PositiveIntegerField::GaPopulation, 1.5),
            (PositiveIntegerField::GaPopulation, f64::NAN),
        ];

        for (field, value) in cases {
            let mut optimizer = sample_optimizer_settings();
            field.set(&mut optimizer, value);
            assert_revalidation_failure(validate_optimizer_settings(&optimizer), field.name());
        }
    }

    #[derive(Clone, Copy)]
    enum NonNegativeIntegerField {
        LocalRepairBudget,
        GaGenerationBudget,
        GaEvaluationBudget,
        GaTimeBudgetMs,
    }

    impl NonNegativeIntegerField {
        fn name(self) -> &'static str {
            match self {
                Self::LocalRepairBudget => "localRepairBudget",
                Self::GaGenerationBudget => "gaGenerationBudget",
                Self::GaEvaluationBudget => "gaEvaluationBudget",
                Self::GaTimeBudgetMs => "gaTimeBudgetMs",
            }
        }

        fn set(self, optimizer: &mut crate::domain::IrregularOptimizerSettings, value: f64) {
            match self {
                Self::LocalRepairBudget => optimizer.local_repair_budget = value,
                Self::GaGenerationBudget => optimizer.ga_generation_budget = value,
                Self::GaEvaluationBudget => optimizer.ga_evaluation_budget = value,
                Self::GaTimeBudgetMs => optimizer.ga_time_budget_ms = value,
            }
        }
    }

    #[test]
    fn revalidates_non_negative_finite_optimizer_integer_fields() {
        let cases = [
            (NonNegativeIntegerField::LocalRepairBudget, -1.0),
            (NonNegativeIntegerField::LocalRepairBudget, 0.5),
            (NonNegativeIntegerField::LocalRepairBudget, f64::NAN),
            (NonNegativeIntegerField::GaGenerationBudget, -1.0),
            (NonNegativeIntegerField::GaGenerationBudget, 0.5),
            (NonNegativeIntegerField::GaGenerationBudget, f64::NAN),
            (NonNegativeIntegerField::GaEvaluationBudget, -1.0),
            (NonNegativeIntegerField::GaEvaluationBudget, 0.5),
            (NonNegativeIntegerField::GaEvaluationBudget, f64::NAN),
            (NonNegativeIntegerField::GaTimeBudgetMs, -1.0),
            (NonNegativeIntegerField::GaTimeBudgetMs, 0.5),
            (NonNegativeIntegerField::GaTimeBudgetMs, f64::NAN),
        ];

        for (field, value) in cases {
            let mut optimizer = sample_optimizer_settings();
            field.set(&mut optimizer, value);
            assert_revalidation_failure(validate_optimizer_settings(&optimizer), field.name());
        }
    }

    enum ScalarSettingsMutation {
        TransformMinimumEdgeLengthMm(f64),
        TransformAngleDeduplicationToleranceDeg(f64),
        ConfiguredRotationDeg(Vec<f64>),
        GaSeed(String),
        GeometryBackendId(String),
        GeometryBackendVersion(String),
    }

    impl ScalarSettingsMutation {
        fn apply(self, settings: &mut IrregularNestingSettings) {
            match self {
                Self::TransformMinimumEdgeLengthMm(value) => {
                    settings.optimizer.transform_minimum_edge_length_mm = value;
                }
                Self::TransformAngleDeduplicationToleranceDeg(value) => {
                    settings
                        .optimizer
                        .transform_angle_deduplication_tolerance_deg = value;
                }
                Self::ConfiguredRotationDeg(values) => {
                    settings.optimizer.configured_rotation_deg = values;
                }
                Self::GaSeed(value) => settings.optimizer.ga_seed = value,
                Self::GeometryBackendId(value) => settings.geometry.geometry_backend_id = value,
                Self::GeometryBackendVersion(value) => {
                    settings.geometry.geometry_backend_version = value;
                }
            }
        }
    }

    #[test]
    fn revalidates_optimizer_scalar_refinements_and_geometry_identity() {
        let cases = vec![
            (
                "transformMinimumEdgeLengthMm",
                ScalarSettingsMutation::TransformMinimumEdgeLengthMm(-1.0),
            ),
            (
                "transformMinimumEdgeLengthMm",
                ScalarSettingsMutation::TransformMinimumEdgeLengthMm(f64::NAN),
            ),
            (
                "transformAngleDeduplicationToleranceDeg",
                ScalarSettingsMutation::TransformAngleDeduplicationToleranceDeg(0.0),
            ),
            (
                "transformAngleDeduplicationToleranceDeg",
                ScalarSettingsMutation::TransformAngleDeduplicationToleranceDeg(f64::NAN),
            ),
            (
                "configuredRotationDeg[1]",
                ScalarSettingsMutation::ConfiguredRotationDeg(vec![0.0, f64::NAN]),
            ),
            ("gaSeed", ScalarSettingsMutation::GaSeed(String::new())),
            (
                "geometryBackendId",
                ScalarSettingsMutation::GeometryBackendId(String::new()),
            ),
            (
                "geometryBackendVersion",
                ScalarSettingsMutation::GeometryBackendVersion(String::new()),
            ),
        ];

        for (expected_message, mutation) in cases {
            let mut settings = sample_settings();
            mutation.apply(&mut settings);
            assert_revalidation_failure(
                validate_geometry_settings(&settings)
                    .and_then(|()| validate_optimizer_settings(&settings.optimizer)),
                expected_message,
            );
        }
    }

    enum PolicyIdsMutation {
        Empty,
        ExcludesSelected,
        Duplicate,
    }

    impl PolicyIdsMutation {
        fn apply(self, optimizer: &mut crate::domain::IrregularOptimizerSettings) {
            use crate::domain::IrregularPlacementPolicyId;

            optimizer.placement_policy_ids = match self {
                Self::Empty => vec![],
                Self::ExcludesSelected => vec![IrregularPlacementPolicyId::ShortSideFill],
                Self::Duplicate => vec![
                    IrregularPlacementPolicyId::BalancedCompactness,
                    IrregularPlacementPolicyId::BalancedCompactness,
                ],
            };
        }
    }

    #[test]
    fn revalidates_placement_policy_ids_non_empty_membership_and_uniqueness() {
        let cases = [
            (
                PolicyIdsMutation::Empty,
                "placementPolicyIds must be non-empty",
            ),
            (
                PolicyIdsMutation::ExcludesSelected,
                "placementPolicyId must be a member",
            ),
            (
                PolicyIdsMutation::Duplicate,
                "placementPolicyIds must not contain duplicates",
            ),
        ];

        for (mutation, expected_message) in cases {
            let mut optimizer = sample_optimizer_settings();
            mutation.apply(&mut optimizer);
            assert_revalidation_failure(validate_optimizer_settings(&optimizer), expected_message);
        }
    }

    enum ShortSideViolation {
        ArchiveDisabled,
        GaActive,
        LegacyBeamPolicy,
    }

    impl ShortSideViolation {
        fn apply(self, optimizer: &mut crate::domain::IrregularOptimizerSettings) {
            use crate::domain::{IntrinsicObjectiveProfileId, IrregularPlacementPolicyId};

            optimizer.intrinsic_objective_profile_id = IntrinsicObjectiveProfileId::ShortSide;
            match self {
                Self::ArchiveDisabled => optimizer.intrinsic_shared_archive_enabled = false,
                Self::GaActive => {
                    optimizer.ga_enabled = true;
                    optimizer.baseline_only = false;
                    optimizer.ga_time_budget_ms = 1.0;
                    optimizer.ga_generation_budget = 1.0;
                    optimizer.ga_evaluation_budget = 1.0;
                }
                Self::LegacyBeamPolicy => {
                    optimizer.placement_policy_id = IrregularPlacementPolicyId::ShortSideFill;
                }
            }
        }
    }

    #[test]
    fn revalidates_short_side_archive_and_ga_cross_field_rules() {
        let cases = [
            ShortSideViolation::ArchiveDisabled,
            ShortSideViolation::GaActive,
            ShortSideViolation::LegacyBeamPolicy,
        ];

        for violation in cases {
            let mut optimizer = sample_optimizer_settings();
            violation.apply(&mut optimizer);
            assert_revalidation_failure(
                validate_optimizer_settings(&optimizer),
                "short-side profile requires",
            );
        }
    }

    #[test]
    fn allow_mirror_defaults_true_when_omitted() {
        let json = sample_request_json();
        let prepared = RequestDto::decode_and_prepare(&json.to_string()).expect("prepares");
        assert!(prepared.request.pieces[0].allow_mirror);
        assert_eq!(prepared.request.options.allow_global_mirror, Some(true));
    }

    #[test]
    fn require_archive_eligible_rejects_archive_disabled_settings() {
        let mut json = sample_request_json();
        json["options"]["irregularSettings"]["optimizer"]["intrinsicSharedArchiveEnabled"] =
            serde_json::json!(false);
        let prepared = RequestDto::decode_and_prepare(&json.to_string()).expect("prepares");
        let error = require_archive_eligible(&prepared.settings).unwrap_err();
        assert_eq!(error.category, "not_implemented");
        assert_eq!(error.operation, "legacy-portfolio-unsupported");
    }
}
