//! Panic containment and structured native-error boundary shared by every N-API
//! entry point in this crate.
//!
//! TS counterpart: the external `AppErrorCode` protocol in
//! `src/shared/protocol/errors.ts`, which every `NativeError` here is eventually
//! mapped into by the worker boundary (see the migration prompt, section 16).
//!
//! # Submodules: the real N-API boundary
//!
//! Per `docs/planning/rust-irregular-backend/native-boundary.md` (design) and
//! `architecture.md` §4.1 (`lib.rs` stays thin, `boundary::run_job` owns
//! execution):
//! - [`request`] -- trusted request DTO decode + §13.1 revalidation.
//! - [`result`] -- result DTO projection (§8), undefined-omission-exact.
//! - [`error`] -- the `AppErrorCode` mapping table (§9).
//! - [`events`] -- `ThreadsafeFunction`-backed portfolio-progress/state-
//!   snapshot event forwarding (§10-§11).
//! - [`diagnostics`] -- the non-semantic diagnostics sidecar (§14).
//! - [`parallel`] -- the job-owned Rayon thread pool (Stage 4,
//!   `cache-concurrency-design.md` §7).
//! - [`run_job`] -- the plain, N-API-free job execution function
//!   (architecture.md §4.1).
//! - [`job`] -- `AsyncTask`/`ThreadsafeFunction` glue and the cooperative-
//!   cancellation job registry (§6); the actual `#[napi]` exports.

pub mod diagnostics;
pub mod error;
pub mod events;
pub mod job;
pub mod parallel;
pub mod request;
pub mod result;
pub mod run_job;

use std::fmt;
use std::panic::{self, UnwindSafe};

/// A structured, sanitized error crossing the N-API boundary.
///
/// Mirrors the category/operation/message shape the TypeScript worker boundary
/// expects so it can map this into the existing `AppErrorCode` protocol without
/// re-deriving provenance from a raw Rust panic message or an ad hoc string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeError {
    pub category: String,
    pub operation: String,
    pub message: String,
}

impl NativeError {
    pub fn new(
        category: impl Into<String>,
        operation: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category: category.into(),
            operation: operation.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for NativeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "[{}] {}: {}",
            self.category, self.operation, self.message
        )
    }
}

impl std::error::Error for NativeError {}

/// Runs `f`, converting any Rust panic that unwinds out of it into a sanitized
/// [`NativeError`] instead of letting the panic cross the N-API boundary.
///
/// Per the migration prompt (sections 7 and 16): every panic must be contained
/// before it reaches N-API, and the reported failure must use the stable
/// `unknown_error` category with sanitized context, never a raw backtrace.
///
/// The payload text is included only when the panic used the two payload shapes
/// `std::panic!` produces for ordinary string-formatted panics (`&'static str` or
/// `String`); any other payload type is reported only as `"non-string panic
/// payload"`, never by its (potentially arbitrary, non-`Display`) contents. This
/// function does not itself decide what is safe to show a caller across the N-API
/// boundary — the caller (typically `run_irregular_job`) is responsible for any
/// further redaction, logging, or truncation policy before the message leaves the
/// process.
pub fn contain_panics<T>(
    op: &str,
    f: impl FnOnce() -> Result<T, NativeError> + UnwindSafe,
) -> Result<T, NativeError> {
    match panic::catch_unwind(f) {
        Ok(result) => result,
        Err(payload) => Err(NativeError::new(
            "unknown",
            op.to_string(),
            format!(
                "contained panic: {}",
                sanitize_panic_payload(payload.as_ref())
            ),
        )),
    }
}

/// Extracts a safe-to-report string from a caught panic payload.
///
/// Only the two payload shapes produced by ordinary `panic!("...")` /
/// `panic!("{}", owned_string)` calls are surfaced verbatim. Everything else
/// (arbitrary `panic_any` payloads, non-`Display` types) collapses to a fixed,
/// non-leaking placeholder.
fn sanitize_panic_payload(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_ok_result_unchanged() {
        let result = contain_panics("test_op", || Ok::<_, NativeError>(7));
        assert_eq!(result, Ok(7));
    }

    #[test]
    fn passes_through_explicit_err_without_panicking() {
        let result: Result<(), NativeError> = contain_panics("test_op", || {
            Err(NativeError::new("validation", "test_op", "bad input"))
        });
        let err = result.expect_err("explicit Err must propagate unchanged");
        assert_eq!(err.category, "validation");
        assert_eq!(err.operation, "test_op");
        assert_eq!(err.message, "bad input");
    }

    #[test]
    fn contains_static_str_panic_and_reports_operation() {
        let result: Result<(), NativeError> = contain_panics("test_op", || {
            panic!("boom");
        });
        let err = result.expect_err("a panic must be converted into an error, not propagate");
        assert_eq!(err.category, "unknown");
        assert_eq!(err.operation, "test_op");
        assert_eq!(err.message, "contained panic: boom");
    }

    #[test]
    fn contains_owned_string_panic_payload() {
        let result: Result<(), NativeError> = contain_panics("test_op", || {
            panic!("{}", String::from("dynamic boom"));
        });
        let err = result.expect_err("a panic must be converted into an error, not propagate");
        assert_eq!(err.message, "contained panic: dynamic boom");
    }

    #[test]
    fn contains_non_string_panic_payload_without_leaking_it() {
        let result: Result<(), NativeError> = contain_panics("test_op", || {
            panic::panic_any(42i32);
        });
        let err = result.expect_err("a panic must be converted into an error, not propagate");
        // The payload (42i32) must never appear verbatim: only the fixed placeholder may.
        assert_eq!(err.message, "contained panic: non-string panic payload");
    }
}
