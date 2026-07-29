//! Native irregular-nesting backend for the Compact and Compact Short Side
//! profiles, exposed to Node/Electron through `napi-rs`.
//!
//! Stage 1 scaffolding only (see
//! `docs/prompts/fable5-rust-irregular-nesting-implementation.md`, section 6):
//! this crate currently proves the N-API load path and the panic-containment
//! boundary. No algorithm code lives here yet; every domain module below is an
//! empty stub reserved for later stages.

pub mod archive;
pub mod boundary;
pub mod caches;
pub mod canonical_grid;
pub mod capacity;
pub mod checkpoints;
pub mod clipper;
pub mod domain;
pub mod geometry;
pub mod js_number;
pub mod nfp_ifp;
pub mod result;
pub mod search;
pub mod short_side;
pub mod trace;
pub mod transforms;
pub mod validation;

use boundary::{contain_panics, NativeError};
use napi_derive::napi;
use serde::Serialize;

/// Native backend capability and version descriptor returned to the TypeScript
/// worker boundary.
///
/// Non-semantic: per the migration prompt (section 7), this belongs only to the
/// out-of-band diagnostic channel. It must never be persisted, hashed, or
/// compared as part of nesting-result parity.
#[napi(object)]
pub struct Capability {
    pub api_version: u32,
    pub crate_version: String,
    pub target_triple: String,
    pub profiles: Vec<String>,
}

/// Reports the native backend's N-API contract version, crate version, compiled
/// target triple, and supported irregular-nesting profiles.
#[napi]
pub fn native_capability() -> Capability {
    Capability {
        api_version: 1,
        crate_version: env!("CARGO_PKG_VERSION").to_string(),
        // Set by build.rs from Cargo's `TARGET` env var at compile time.
        target_triple: env!("IRREGULAR_NATIVE_TARGET").to_string(),
        profiles: vec!["compact".to_string(), "compact-short-side".to_string()],
    }
}

/// Coarse-grained irregular nesting job entry point.
///
/// This is a Stage 1 placeholder that proves the N-API load path and the
/// panic-containment boundary only. It always returns a structured
/// `{"ok":false,"error":{...}}` JSON payload; the typed request/response DTO
/// layer described in the migration prompt (section 7) arrives in a later
/// stage. `request_json` is intentionally unused until that layer exists.
#[napi]
pub fn run_irregular_job(request_json: String) -> napi::Result<String> {
    let _ = request_json;
    let outcome: Result<String, NativeError> =
        contain_panics("run_irregular_job", not_implemented_response);
    let json = match outcome {
        Ok(json) => json,
        // A panic inside the (currently trivial) placeholder body is not expected, but
        // the boundary contract requires every entry point to route panics through
        // `contain_panics` and report them with the stable `unknown` category rather
        // than letting them unwind across N-API.
        Err(err) => error_response(&err),
    };
    Ok(json)
}

#[derive(Serialize)]
struct JobFailureEnvelope<'a> {
    ok: bool,
    error: JobFailure<'a>,
}

#[derive(Serialize)]
struct JobFailure<'a> {
    category: &'a str,
    operation: &'a str,
    message: &'a str,
}

fn not_implemented_response() -> Result<String, NativeError> {
    Ok(encode_failure(
        "not_implemented",
        "run_irregular_job",
        "native backend not yet implemented",
    ))
}

fn error_response(err: &NativeError) -> String {
    encode_failure(&err.category, &err.operation, &err.message)
}

fn encode_failure(category: &str, operation: &str, message: &str) -> String {
    let envelope = JobFailureEnvelope {
        ok: false,
        error: JobFailure {
            category,
            operation,
            message,
        },
    };
    // `JobFailureEnvelope`/`JobFailure` field order is declaration order, which serde_json
    // preserves, so this always matches the documented placeholder response byte-for-byte.
    serde_json::to_string(&envelope).expect("JobFailureEnvelope always serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_capability_reports_expected_shape() {
        let capability = native_capability();
        assert_eq!(capability.api_version, 1);
        assert_eq!(capability.crate_version, env!("CARGO_PKG_VERSION"));
        assert!(!capability.target_triple.is_empty());
        assert_eq!(capability.profiles, vec!["compact", "compact-short-side"]);
    }

    #[test]
    fn run_irregular_job_returns_structured_not_implemented_error() {
        let result = run_irregular_job("{}".to_string()).expect("placeholder never returns Err");
        assert_eq!(
            result,
            r#"{"ok":false,"error":{"category":"not_implemented","operation":"run_irregular_job","message":"native backend not yet implemented"}}"#
        );
    }
}
