//! Structured failure envelope crossing the N-API boundary, and the
//! `AppErrorCode` mapping table this crate's internal error types collapse
//! onto.
//!
//! TS counterpart: `src/shared/protocol/errors.ts` (`AppErrorCode`, the
//! full 19-member canonical list) and `src/workers/nesting.worker.ts:403-453`
//! (`toIrregularWorkerFailure`, the live TS mapping this module transcribes
//! for the archive-eligible path). Design source:
//! `docs/planning/rust-irregular-backend/native-boundary.md` §9 (the
//! `NativeIrregularFailure` shape and its §9.3 mapping table).
//!
//! # Wire convention
//!
//! Unlike native-boundary.md's `#[napi(object)]`-per-field design (Stage 1
//! aspiration, no production TS wiring exists to consume it yet), this
//! module follows the migration-prompt-authorized JSON-string convention
//! this crate's own placeholder boundary already established
//! (`lib.rs`'s pre-existing `run_irregular_job`/`encode_failure`): every
//! failure this module produces serializes to the same
//! `{"category","operation","message","context"}` shape, letting the whole
//! N-API surface stay `String`-in/`String`-out (`serde_json` on both ends)
//! rather than requiring hundreds of hand-declared `#[napi(object)]` structs
//! for every nested trace type. `category` carries the real `AppErrorCode`
//! string (e.g. `"irregular_geometry_invalid"`), not a placeholder.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::result::{
    irregular_compute_error_app_code, IrregularComputeErrorType, IrregularPortfolioErrorCategory,
};

use super::NativeError;

/// One structured failure crossing the N-API boundary. Mirrors
/// `native-boundary.md` §9.1's `NativeIrregularFailure`: `context` is
/// uniformly `String`-valued (a numeric context value, e.g.
/// `worker_protocol_error`'s `nativeApiVersion`, is rendered as its decimal
/// string form, per §9.1/§18 open question 6's documented convention).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundaryError {
    /// A real `AppErrorCode` string (`src/shared/protocol/errors.ts`), never
    /// this crate's own internal Rust variant name.
    pub category: String,
    pub operation: String,
    pub message: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub context: BTreeMap<String, String>,
}

impl BoundaryError {
    pub fn new(
        category: impl Into<String>,
        operation: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category: category.into(),
            operation: operation.into(),
            message: message.into(),
            context: BTreeMap::new(),
        }
    }

    pub fn with_context(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.context.insert(key.into(), value.into());
        self
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("BoundaryError always serializes")
    }

    // =======================================================================
    // §3.3 / §13.1: the load-time / call-time protocol-shape rejections.
    // =======================================================================

    /// TS wire JSON failed to parse at all -- not a validated `NestingRequest`
    /// shape, a fundamentally different (or absent) contract. Per
    /// native-boundary.md §3.3 step 4: "the addon itself must reject with
    /// `worker_protocol_error` ... rather than panicking or guessing."
    pub fn malformed_request_json(parse_error: &serde_json::Error) -> Self {
        BoundaryError::new(
            "worker_protocol_error",
            "decodeRequestJson",
            format!("request JSON did not decode as a NestingRequest: {parse_error}"),
        )
    }

    /// `NestingRequest.version !== 1`. §9.1/§18 open question 6: a numeric
    /// context value is rendered as its decimal string form.
    pub fn native_api_version_mismatch(actual: u32) -> Self {
        BoundaryError::new(
            "worker_protocol_error",
            "nativeApiVersion",
            format!("expected NestingRequest.version 1, received {actual}"),
        )
        .with_context("nativeApiVersion", "1")
        .with_context("receivedVersion", actual.to_string())
    }

    /// §13.1's safety-critical revalidation failures (finite numbers,
    /// positive sheet, non-empty pieces, cross-field settings invariants,
    /// ...). Mapped to `irregular_geometry_invalid` / operation
    /// `nativeBoundaryRevalidation`, the closest semantic match to Seam B's
    /// own `IrregularGeometryInputError` usage for analogous checks
    /// (native-boundary.md §13.1).
    pub fn revalidation_failed(message: impl Into<String>) -> Self {
        BoundaryError::new(
            "irregular_geometry_invalid",
            "nativeBoundaryRevalidation",
            message,
        )
    }

    /// §13.1's "load-bearing scope check": the request's optimizer settings
    /// are not `intrinsic_shared_archive_eligible`, i.e. this request would
    /// take TypeScript's legacy windowed-beam/GA path, which this crate does
    /// not port (`result::mod`'s own top doc). The TS integration layer must
    /// treat this exactly like an unavailable/version-mismatched addon: fall
    /// back to the TS backend, never surface it as an algorithm failure.
    pub fn archive_ineligible_routing(reason: &str) -> Self {
        BoundaryError::new(
            "not_implemented",
            "legacy-portfolio-unsupported",
            format!(
                "request settings are not intrinsic-shared-archive-eligible ({reason}); this backend only implements the Compact / Compact Short Side archive path and does not emulate TypeScript's legacy windowed-beam/GA path -- route this request to the TypeScript backend."
            ),
        )
        .with_context("service", "irregular-native")
        .with_context("operation", "legacy-portfolio-unsupported")
    }

    pub fn native_event_delivery_failed(status: impl Into<String>) -> Self {
        BoundaryError::new(
            "worker_protocol_error",
            "nativeEventDelivery",
            "native irregular event delivery failed",
        )
        .with_context("napiStatus", status)
    }

    // =======================================================================
    // §12: panic containment, sanitized per §12's explicit rule -- the raw
    // panic payload/backtrace never enters the default failure envelope.
    // =======================================================================

    pub fn from_panic(native_error: &NativeError) -> Self {
        BoundaryError::new(
            "unknown_error",
            native_error.operation.clone(),
            "native irregular nesting job failed unexpectedly",
        )
        .with_context("operation", native_error.operation.clone())
        .with_context("backend", "rust")
    }
}

/// TS: `nesting.worker.ts:403-453` `toIrregularWorkerFailure`, transcribed
/// exactly against `result::irregular_compute_error_app_code` (the single
/// authoritative code table this crate already carries -- reused here, not
/// re-derived) plus this variant's own context fields.
impl From<&IrregularComputeErrorType> for BoundaryError {
    fn from(error: &IrregularComputeErrorType) -> Self {
        let category = irregular_compute_error_app_code(error);
        match error {
            IrregularComputeErrorType::Compute(inner) => {
                BoundaryError::new(category, "computeIrregularNesting", inner.message.clone())
                    .with_context("preparedPieceId", inner.prepared_piece_id.as_str())
                    .with_context("sourcePieceId", inner.source_piece_id.as_str())
            }
            IrregularComputeErrorType::GeometryInput(inner) => {
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("operation", inner.operation.clone())
            }
            IrregularComputeErrorType::NfpIfpControlAbort(inner) => {
                let reason = match inner.reason {
                    crate::nfp_ifp::NfpIfpAbortReason::Cancelled => "cancelled",
                    crate::nfp_ifp::NfpIfpAbortReason::Deadline => "deadline",
                };
                BoundaryError::new(category, "computeIrregularNesting", inner.message.clone())
                    .with_context("reason", reason)
            }
            IrregularComputeErrorType::NoValidResult(inner) => {
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("operation", inner.operation.clone())
            }
            IrregularComputeErrorType::NotImplemented(inner) => {
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("service", inner.service.clone())
                    .with_context("operation", inner.operation.clone())
            }
            IrregularComputeErrorType::Portfolio(inner) => {
                let category_str = match inner.category {
                    IrregularPortfolioErrorCategory::Geometry => "geometry",
                    IrregularPortfolioErrorCategory::Scoring => "scoring",
                    IrregularPortfolioErrorCategory::Search => "search",
                };
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("operation", inner.operation.clone())
                    .with_context("category", category_str)
            }
            IrregularComputeErrorType::PlacementScoring(inner) => {
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("operation", inner.operation.clone())
            }
            IrregularComputeErrorType::LayoutScoring(inner) => {
                BoundaryError::new(category, inner.operation.clone(), inner.message.clone())
                    .with_context("operation", inner.operation.clone())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::PieceId;
    use crate::nfp_ifp::{NfpIfpAbortReason, NfpIfpControlAbortError};
    use crate::result::{IrregularComputeError, IrregularNoValidResultError};

    #[test]
    fn boundary_error_omits_empty_context() {
        let error = BoundaryError::new("unknown_error", "op", "message");
        assert_eq!(
            error.to_json(),
            r#"{"category":"unknown_error","operation":"op","message":"message"}"#
        );
    }

    #[test]
    fn boundary_error_includes_context_when_present() {
        let error = BoundaryError::new("irregular_geometry_invalid", "op", "message")
            .with_context("operation", "op");
        assert_eq!(
            error.to_json(),
            r#"{"category":"irregular_geometry_invalid","operation":"op","message":"message","context":{"operation":"op"}}"#
        );
    }

    #[test]
    fn native_api_version_mismatch_renders_decimal_string_context() {
        let error = BoundaryError::native_api_version_mismatch(2);
        assert_eq!(error.category, "worker_protocol_error");
        assert_eq!(error.context.get("nativeApiVersion").unwrap(), "1");
        assert_eq!(error.context.get("receivedVersion").unwrap(), "2");
    }

    #[test]
    fn archive_ineligible_routing_maps_to_not_implemented() {
        let error = BoundaryError::archive_ineligible_routing("archive disabled");
        assert_eq!(error.category, "not_implemented");
        assert_eq!(error.operation, "legacy-portfolio-unsupported");
        assert_eq!(error.context.get("service").unwrap(), "irregular-native");
    }

    #[test]
    fn native_event_delivery_failure_keeps_only_the_status_name() {
        let error = BoundaryError::native_event_delivery_failed("QueueFull");
        assert_eq!(error.category, "worker_protocol_error");
        assert_eq!(error.operation, "nativeEventDelivery");
        assert_eq!(error.message, "native irregular event delivery failed");
        assert_eq!(
            error.context.get("napiStatus"),
            Some(&"QueueFull".to_string())
        );
    }

    #[test]
    fn from_panic_sanitizes_message_and_never_leaks_raw_payload() {
        let native_error = NativeError::new("unknown", "runJob", "contained panic: secret state");
        let error = BoundaryError::from_panic(&native_error);
        assert_eq!(error.category, "unknown_error");
        assert_eq!(
            error.message,
            "native irregular nesting job failed unexpectedly"
        );
        assert!(!error.message.contains("secret state"));
        assert_eq!(error.context.get("backend").unwrap(), "rust");
        assert_eq!(error.context.get("operation").unwrap(), "runJob");
    }

    #[test]
    fn compute_error_maps_source_geometry_missing_with_exact_context() {
        let error = IrregularComputeErrorType::Compute(IrregularComputeError {
            prepared_piece_id: PieceId::new("prepared-1"),
            source_piece_id: PieceId::new("source-1"),
            message: "missing".to_string(),
        });
        let boundary: BoundaryError = (&error).into();
        assert_eq!(boundary.category, "irregular_source_geometry_missing");
        assert_eq!(
            boundary.context.get("preparedPieceId").unwrap(),
            "prepared-1"
        );
        assert_eq!(boundary.context.get("sourcePieceId").unwrap(), "source-1");
    }

    #[test]
    fn compute_error_maps_control_abort_reasons_to_distinct_codes() {
        let cancelled = IrregularComputeErrorType::NfpIfpControlAbort(NfpIfpControlAbortError {
            reason: NfpIfpAbortReason::Cancelled,
            message: "cancelled".to_string(),
        });
        let deadline = IrregularComputeErrorType::NfpIfpControlAbort(NfpIfpControlAbortError {
            reason: NfpIfpAbortReason::Deadline,
            message: "deadline".to_string(),
        });
        let cancelled_boundary: BoundaryError = (&cancelled).into();
        let deadline_boundary: BoundaryError = (&deadline).into();
        assert_eq!(cancelled_boundary.category, "worker_cancelled");
        assert_eq!(
            cancelled_boundary.context.get("reason").unwrap(),
            "cancelled"
        );
        assert_eq!(deadline_boundary.category, "worker_timeout");
        assert_eq!(deadline_boundary.context.get("reason").unwrap(), "deadline");
    }

    #[test]
    fn compute_error_maps_no_valid_result() {
        let error = IrregularComputeErrorType::NoValidResult(IrregularNoValidResultError {
            operation: "selectWinner".to_string(),
            message: "no winner".to_string(),
        });
        let boundary: BoundaryError = (&error).into();
        assert_eq!(boundary.category, "irregular_no_valid_result");
        assert_eq!(boundary.context.get("operation").unwrap(), "selectWinner");
    }
}
