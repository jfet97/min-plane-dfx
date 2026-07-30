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
        let dto: RequestDto = serde_json::from_str(json)
            .map_err(|err| BoundaryError::malformed_request_json(&err))?;
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

        require_finite("sheet.width", self.sheet.width)?;
        require_finite("sheet.height", self.sheet.height)?;
        require_positive("sheet.width", self.sheet.width)?;
        require_positive("sheet.height", self.sheet.height)?;

        require_finite("padding", self.padding)?;
        require_non_negative("padding", self.padding)?;

        if self.pieces.is_empty() {
            return Err(BoundaryError::revalidation_failed(
                "pieces must be a non-empty array",
            ));
        }
        for (index, piece) in self.pieces.iter().enumerate() {
            validate_prepared_piece(index, piece)?;
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

fn validate_prepared_piece(index: usize, piece: &PreparedPieceDto) -> Result<(), BoundaryError> {
    let prefix = format!("pieces[{index}]");
    if piece.id.trim().is_empty() {
        return Err(BoundaryError::revalidation_failed(format!(
            "{prefix}.id must be a non-empty string"
        )));
    }
    require_finite(&format!("{prefix}.padding"), piece.padding)?;
    require_non_negative(&format!("{prefix}.padding"), piece.padding)?;

    for (label, value) in [
        ("realBounds.x", piece.real_bounds.x),
        ("realBounds.y", piece.real_bounds.y),
        ("paddedBounds.x", piece.padded_bounds.x),
        ("paddedBounds.y", piece.padded_bounds.y),
    ] {
        require_finite(&format!("{prefix}.{label}"), value)?;
        require_non_negative(&format!("{prefix}.{label}"), value)?;
    }
    for (label, value) in [
        ("realBounds.width", piece.real_bounds.width),
        ("realBounds.height", piece.real_bounds.height),
        ("paddedBounds.width", piece.padded_bounds.width),
        ("paddedBounds.height", piece.padded_bounds.height),
        ("paddedBounds.longestEdge", piece.padded_bounds.longest_edge),
        ("paddedBounds.area", piece.padded_bounds.area),
    ] {
        require_finite(&format!("{prefix}.{label}"), value)?;
        require_positive(&format!("{prefix}.{label}"), value)?;
    }
    require_finite(
        &format!("{prefix}.paddedBounds.imbalance"),
        piece.padded_bounds.imbalance,
    )?;
    require_non_negative(
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
    if geometry.clearance_safety_margin_mm < geometry.flattening_sag_tolerance_mm {
        return Err(BoundaryError::revalidation_failed(
            "options.irregularSettings.geometry.clearanceSafetyMarginMm must be >= flatteningSagToleranceMm",
        ));
    }
    Ok(())
}

/// TS: `domain.ts:418-458` cross-field `.check()` filter, re-checked here
/// per native-boundary.md §13.1.
fn validate_optimizer_settings(
    optimizer: &crate::domain::IrregularOptimizerSettings,
) -> Result<(), BoundaryError> {
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
    fn rejects_non_positive_sheet_dimensions() {
        let mut json = sample_request_json();
        json["sheet"]["width"] = serde_json::json!(0.0);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
        assert_eq!(error.operation, "nativeBoundaryRevalidation");
    }

    // Not testable end-to-end via `decode_and_prepare`: `serde_json` itself
    // rejects every wire representation of a non-finite `f64` before this
    // module's own code ever runs -- `NaN`/`Infinity` have no JSON token at
    // all (RFC 8259), and an syntactically-valid-but-overflowing decimal
    // literal (e.g. `1e400`) is rejected by `serde_json`'s parser itself
    // ("number out of range"), confirmed empirically. `require_finite`
    // remains real defense-in-depth for the one documented case that *can*
    // reach it -- a test/script harness constructing a [`RequestDto`]
    // directly in Rust rather than through JSON (migration prompt §18.2) --
    // exercised directly here instead.
    #[test]
    fn require_finite_rejects_nan_and_infinite_values() {
        assert!(require_finite("x", f64::NAN).is_err());
        assert!(require_finite("x", f64::INFINITY).is_err());
        assert!(require_finite("x", f64::NEG_INFINITY).is_err());
        assert!(require_finite("x", 1.5).is_ok());
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
    fn rejects_negative_padding() {
        let mut json = sample_request_json();
        json["padding"] = serde_json::json!(-1.0);
        let error = RequestDto::decode_and_prepare(&json.to_string()).unwrap_err();
        assert_eq!(error.category, "irregular_geometry_invalid");
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
