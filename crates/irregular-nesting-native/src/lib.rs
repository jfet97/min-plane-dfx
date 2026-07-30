//! Native irregular-nesting backend for the Compact and Compact Short Side
//! profiles, exposed to Node/Electron through `napi-rs`.
//!
//! `lib.rs` stays thin per `docs/planning/rust-irregular-backend/architecture.md`
//! §4.1: the real job surface (`runIrregularJob`/`cancelIrregularJob`/
//! `getLastJobDiagnostics`) lives in [`boundary::job`] and is re-exported here
//! for discoverability only. See `boundary::mod`'s own doc for the full N-API
//! boundary module map (request/result DTOs, error mapping, event streaming,
//! diagnostics sidecar, and the plain N-API-free `boundary::run_job`).

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

use napi_derive::napi;

// Re-exported for discoverability -- see `boundary::mod`'s own doc,
// "Submodules: the real N-API boundary": every `#[napi]` export the real job
// surface needs is declared directly in `boundary::job` (napi-derive
// registration is item-based, not module-position-based), so this crate root
// only needs a `pub use` of the three names, plus the pre-existing
// `contain_panics`/`NativeError` panic-containment primitives every entry
// point (including `boundary::job`'s) is built on.
pub use boundary::job::{cancel_irregular_job, get_last_job_diagnostics, run_irregular_job};
pub use boundary::{contain_panics, NativeError};

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
    fn cancel_irregular_job_on_an_unknown_job_id_is_a_harmless_no_op() {
        assert!(!cancel_irregular_job("no-such-job".to_string()));
    }

    #[test]
    fn get_last_job_diagnostics_is_null_before_any_job_has_run_in_this_process() {
        // Only safe to assert loosely: other tests in this binary may have
        // already run a real job and populated the sidecar (it is one
        // process-global slot, per `boundary::diagnostics`'s own doc). This
        // just proves the export returns valid JSON either way.
        let json = get_last_job_diagnostics();
        let _: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    }
}
