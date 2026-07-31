/*!
Non-semantic diagnostic sidecar for the geometry-cache cluster (prompt §13.7
and §17). Control flow never reads these values, and they are not part of the
job result DTO. They are returned only through the diagnostic channel defined
by `architecture.md` §4.5.

The coordinator owns and mutates the job-local geometry cache. Rayon workers
perform pure geometry computation and do not update cache state or telemetry,
so plain `u64` counters are sufficient. The backing store uses a deterministic
charged LRU with a finite cap. Its diagnostics include current and peak charged
bytes, admissions, replacements, size evictions, evicted bytes, oversized-entry
rejections, and cloning hits. Explicit normal-completion cleanup clears and
shrinks retained cache storage before the final snapshot; cumulative and peak
counters remain available while current bytes and entries become zero.

The TypeScript counterpart is
`src/workers/irregular/nfpIfpTelemetry.ts`. The Rust shape is intentionally
richer and is not a byte-parity target. Differential tests compare semantic
output, while these counters provide implementation and performance evidence.
See `store.rs` for the exact access, charging, eviction, and cleanup contract.
*/

use std::collections::BTreeMap;

use serde::Serialize;

/// One namespace's counters. `namespace` is a stable string identifier
/// matching the TS namespace constants verbatim (e.g. "pairwise-nfp-relative-v3")
/// so evidence can be cross-referenced against the TS baseline by name.
///
/// `Serialize` (added for `boundary::diagnostics`'s opt-in
/// `getLastJobDiagnostics` sidecar, `architecture.md` §4.5): purely a
/// diagnostic-channel convenience, not a parity/canonical encoding -- see
/// this module's top doc, "not a byte-parity target."
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheNamespaceTelemetry {
    /// Every `get` call, hit or miss (TS: `getCalls`).
    pub lookups: u64,
    /// Lookups that resolved to a valid published value. Rust separates the
    /// TypeScript `getPresent` count into valid `hits` and
    /// `stale_detections`.
    pub hits: u64,
    /// Lookups that found no usable entry and require fresh computation.
    pub misses: u64,
    /// Successful publications (TS: `setCalls`).
    pub stores: u64,
    /// Lookups whose cached value failed re-validation (TS: `getPresent`
    /// entries that are stale, i.e. `isValidCached*` returned false).
    pub stale_detections: u64,
    /// Evictions performed as a direct result of a stale detection (TS:
    /// `removeCalls`; equals `stale_detections` in a correct implementation,
    /// tracked separately to catch a design bug if they ever diverge).
    pub stale_removals: u64,
    /// Reserved diagnostic from the evaluated concurrent-cache designs.
    /// Always `0` under coordinator-only cache mutation.
    pub duplicate_computations: u64,
    /// Reserved single-flight diagnostic. Always `0` because the implemented
    /// cache has no in-flight markers or waiters.
    pub single_flight_waits: u64,
    /// Reserved shard-lock timing. Always `0` because the implemented cache
    /// has no shard locks.
    pub shard_lock_wait_nanos: u64,
    /// Reserved shard-lock contention count. Always `0`.
    pub shard_lock_contended_acquisitions: u64,
    /// Reserved front-cache count. Always `0` because no front cache exists.
    pub front_cache_hits: u64,
    /// Hits served by the coordinator-owned geometry backing store.
    pub backing_cache_hits: u64,
    /// Typed cache hits where the normal resolver cloned the value to supply
    /// its candidate. The NFP prepass must leave this counter unchanged.
    pub cloning_hits: u64,
    /// Finite charged-byte capacity for this namespace's backing store.
    pub cap_bytes: u64,
    /// Entries admitted after their retained charge fit the finite budget.
    pub admissions: u64,
    /// Successful publications that replaced an existing key.
    pub replacements: u64,
    /// Entries evicted for a reason other than staleness (size-based
    /// eviction, §5).
    pub evictions: u64,
    /// Charged bytes released by size-based evictions.
    pub evicted_bytes: u64,
    /// Publications rejected because one entry alone exceeds the finite cap.
    pub oversized_rejections: u64,
    /// Current entry count for this namespace at the moment of snapshot.
    pub entries: u64,
    /// Current conservatively charged bytes for this namespace.
    pub approx_bytes: u64,
    /// Peak conservatively charged bytes for this namespace observed at any
    /// point during the job. It never decreases within one job's lifetime.
    pub peak_bytes: u64,
    /// Reserved pure-compute timing in nanoseconds. Currently `0`: cache
    /// callers do not clock resolver work into this sidecar.
    pub computation_time_nanos: u64,
}

/// One job's complete cache telemetry snapshot. Namespace keys are stable
/// strings matching the TS namespace constants; `BTreeMap` (not `HashMap`)
/// is used only so a printed/serialized snapshot has deterministic key
/// order for human review — this ordering is diagnostic convenience, not a
/// parity requirement (contrast with prompt §9's ordering rules, which
/// govern canonical/semantic output, not this sidecar).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheTelemetrySnapshot {
    pub namespaces: BTreeMap<String, CacheNamespaceTelemetry>,
    /// Finite charged-byte cap for the shared geometry backing store.
    pub cap_bytes: u64,
    /// Current charged bytes across every geometry namespace.
    pub current_bytes: u64,
    /// Highest charged-byte total reached during this job.
    pub peak_bytes: u64,
    /// Cumulative cache publications admitted into the backing store.
    pub admissions: u64,
    /// Cumulative publications that replaced an existing key.
    pub replacements: u64,
    /// Cumulative size-based evictions across all namespaces.
    pub evictions: u64,
    /// Cumulative charged bytes released by size-based evictions.
    pub evicted_bytes: u64,
    /// Cumulative single-entry rejections for exceeding the cap.
    pub oversized_rejections: u64,
    /// Number of distinct `GeometryCacheStore`-equivalent instances
    /// constructed during this process's lifetime that this snapshot
    /// aggregates over. In production this is always 1 per job (design doc
    /// §2); a value other than 1 in a differential/stress-test harness is
    /// itself a testable invariant, mirroring TS's `cacheInstances` counter
    /// (`nfpIfpTelemetry.ts`, asserted `=== 1` per job by
    /// `irregularGeometryCache.test.ts:199,276`).
    pub cache_instances: u64,
}

impl CacheTelemetrySnapshot {
    /// Returns a mutable handle to `namespace`'s counters, creating a
    /// zeroed entry on first access — mirrors
    /// `nfpIfpTelemetry.ts`'s `namespaceCounters` helper
    /// (`get-or-create`, never a hard `KeyError`).
    pub fn namespace_mut(&mut self, namespace: &str) -> &mut CacheNamespaceTelemetry {
        self.namespaces.entry(namespace.to_string()).or_default()
    }

    /// Read-only accessor for `namespace`'s counters, or a shared zeroed
    /// value if the namespace has never been touched (never creates an
    /// entry, unlike [`Self::namespace_mut`]).
    pub fn namespace(&self, namespace: &str) -> CacheNamespaceTelemetry {
        self.namespaces.get(namespace).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespace_mut_creates_a_zeroed_entry_on_first_access() {
        let mut snapshot = CacheTelemetrySnapshot::default();
        assert!(snapshot.namespaces.is_empty());
        let counters = snapshot.namespace_mut("transform-collision-v1");
        assert_eq!(*counters, CacheNamespaceTelemetry::default());
        assert_eq!(snapshot.namespaces.len(), 1);
    }

    #[test]
    fn namespace_read_accessor_does_not_create_an_entry() {
        let snapshot = CacheTelemetrySnapshot::default();
        assert_eq!(
            snapshot.namespace("sheet-ifp-v1"),
            CacheNamespaceTelemetry::default()
        );
        assert!(snapshot.namespaces.is_empty());
    }

    #[test]
    fn namespaces_are_reported_in_sorted_key_order() {
        let mut snapshot = CacheTelemetrySnapshot::default();
        snapshot.namespace_mut("sheet-ifp-v1").lookups = 1;
        snapshot.namespace_mut("pairwise-nfp-relative-v3").lookups = 2;
        snapshot.namespace_mut("transform-collision-v1").lookups = 3;
        let keys: Vec<&String> = snapshot.namespaces.keys().collect();
        assert_eq!(
            keys,
            vec![
                "pairwise-nfp-relative-v3",
                "sheet-ifp-v1",
                "transform-collision-v1"
            ]
        );
    }
}
