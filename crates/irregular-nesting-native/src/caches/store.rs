//! The one physical backing store shared by cache namespaces 1.1–1.3
//! (`pairwise-nfp-relative-v3`, `transform-collision-v1`, `sheet-ifp-v1`) —
//! ported from `src/workers/irregular/core/geometryCacheStore.ts` (key
//! shape + `serializeGeometryCacheKey`) and
//! `src/workers/irregular/geometryCacheStoreLive.ts` (`makeGeometryCacheStore`,
//! the `Map`-backed implementation).
//!
//! # Key type reuse
//!
//! TS declares two independently-declared, structurally identical key
//! shapes (`core/geometryCacheStore.ts`'s plain `GeometryCacheKey` interface
//! and `domain.ts`'s `IrregularGeometryCacheKey` class) that flow into each
//! other's call sites for free under structural typing.
//! `crate::domain::IrregularGeometryCacheKey`'s own doc comment
//! already resolves this for the Rust port ("the unify branch... any later
//! cache-store module must reuse it directly rather than declaring a second,
//! structurally-identical type") — this module follows that instruction and
//! re-exports it locally as [`GeometryCacheKey`] rather than declaring a new
//! struct.
//!
//! # Storage representation
//!
//! `docs/planning/rust-irregular-backend/cache-concurrency-design.md` §1
//! confirms this store's backing structure is never iterated in production
//! (`Map.get`/`.set`/`.delete` only). A `HashMap` owns the values under the
//! exact `serializeGeometryCacheKey` string. One coordinator-owned linked
//! recency node per admitted entry provides deterministic LRU eviction and
//! constant-time hot-key touches without making map iteration observable.
//!
//! # Type-erased values
//!
//! TS's `Map<string, unknown>` stores heterogeneous values across
//! namespaces (`get<A>`/`set<A>` are call-site-trusted casts with **no**
//! runtime shape check — `geometry-caches.md` §3 confirms namespaces 1.1/1.3
//! store plain objects while 1.2 stores a materialized domain-class
//! instance). `Box<dyn Any + Send>` plus `downcast_ref` is this crate's equivalent:
//! like the TS `as A | undefined` cast, a namespace/type mismatch is a
//! caller bug this store does not detect at runtime; unlike TS, an actual
//! type mismatch here fails the `downcast_ref` cleanly (returns `None`,
//! reported as an ordinary cache miss) rather than returning a
//! value-shaped-wrong `A`, which is a strictly safer failure mode than TS's
//! silent structural mismatch, not a divergence load-bearing for parity
//! (a namespace's stored type is always consistent by construction — the
//! key's `namespace` string is 1:1 with a single Rust type at every call
//! site in this crate).

use std::any::Any;
use std::collections::HashMap;

use crate::domain::IrregularGeometryCacheKey;

use super::telemetry::CacheTelemetrySnapshot;

/// TS: `core/geometryCacheStore.ts:1-4` `interface GeometryCacheKey`. See
/// this module's top-level doc for why this is a type alias onto the
/// already-unified [`crate::domain::IrregularGeometryCacheKey`]
/// rather than a second declaration.
pub type GeometryCacheKey = IrregularGeometryCacheKey;

/// Outcome of the coordinator-only typed validity probe used by the NFP prepass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeometryCacheProbe {
    HotValid,
    Cold,
    StaleRemoved,
}

/// TS: `core/geometryCacheStore.ts:13-15` (`serializeGeometryCacheKey`).
///
/// `JSON.stringify([key.namespace, key.parts])` — the entire serialization
/// contract for this cluster's cache keys: a 2-element JSON array
/// `[namespace_string, [part_string, ...]]`. This is the literal `Map<string,
/// unknown>` key TS uses; `geometry-caches.md` §8 pins concrete golden byte
/// strings for three namespaces (reproduced verbatim by this module's own
/// tests below) that any reimplementation must match exactly.
///
/// Hand-rolled string escaping (not `serde_json::to_string`) for the same
/// reason `checkpoints::canonical_json`'s private `json_string_literal`
/// helper is hand-rolled rather than delegated: this pins the exact ECMA-262
/// `QuoteJSONString` algorithm independent of `serde_json`'s own escaping
/// choices, which are not a contractually-guaranteed match. `parts` is
/// always a flat array of strings for this cluster (never nested further),
/// so unlike the four checkpoint encoders this needs no recursive `JsValue`
/// shape — a direct two-level array encode is sufficient.
///
/// **Lone-surrogate hazard (documented, not fixed):** `geometry-caches.md`
/// §8 notes `JSON.stringify` passes lone/unpaired UTF-16 surrogates through
/// **unescaped**, producing technically-invalid-but-V8-consistent JSON text.
/// A Rust `&str`/`String` cannot represent an unpaired surrogate at all (it
/// would not be valid UTF-8), so this hazard cannot even arise on the Rust
/// side of the N-API boundary — any string reaching this function already
/// went through a valid-UTF-8 conversion when it crossed from JS into Rust.
/// This is a structural non-issue for this port, not a gap silently left
/// unhandled.
pub fn serialize_geometry_cache_key(key: &GeometryCacheKey) -> String {
    let mut out = String::with_capacity(32 + key.namespace.len());
    out.push('[');
    push_json_string(&mut out, &key.namespace);
    out.push_str(",[");
    for (index, part) in key.parts.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json_string(&mut out, part);
    }
    out.push_str("]]");
    out
}

/// `JSON.stringify(value)` for a single string, returned as an owned
/// `String` rather than appended to a caller-owned buffer. This is the one
/// seam `legal_candidate_memo` (a different cache-key shape that builds its
/// own flat `JSON.stringify([...])` array rather than addressing this
/// module's `GeometryCacheKey`/`serialize_geometry_cache_key` contract)
/// reuses instead of reimplementing ECMA-262 `QuoteJSONString` a third time
/// in this crate (`checkpoints::canonical_json` has the first copy, private
/// to that module; [`push_json_string`] below is this module's copy).
pub(crate) fn json_string_for_array_element(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    push_json_string(&mut out, value);
    out
}

/// `JSON.stringify(value)` for one `string` — ECMA-262 `QuoteJSONString`:
/// escapes `"`, `\`, and every control character `U+0000..=U+001F` (using
/// the six named short escapes `\b \f \n \r \t` plus `\"`/`\\` where
/// applicable, and lowercase `\u00xx` for every other control character),
/// and passes every other code point — including all non-ASCII text —
/// through unescaped. Mirrors `checkpoints::canonical_json`'s private
/// `json_string_literal` algorithm (that helper is not `pub`, so this
/// module carries its own copy rather than reaching into another task's
/// file — see this file's top-level doc).
fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// TS: `geometryCacheStoreLive.ts:6-30` (`GeometryCacheStore`,
/// `makeGeometryCacheStore`).
///
/// One job-local backing store for cache namespaces 1.1-1.3. It is constructed
/// once per job, mutated only by the coordinator, and bounded by a deterministic
/// charged LRU. Production explicitly clears and shrinks retained storage after
/// the job completes, before publishing the diagnostics snapshot. Normal Rust
/// ownership remains the unwind cleanup path if execution panics.
const GEOMETRY_CACHE_DEFAULT_CAP_BYTES: u64 = 56 * 1024 * 1024;
const HASHMAP_ENTRY_OVERHEAD_BYTES: u64 = 64;

struct GeometryCacheEntry {
    value: Box<dyn Any + Send>,
    charge_bytes: u64,
    namespace: String,
    recency_node: usize,
}

struct RecencyNode {
    key: String,
    previous: Option<usize>,
    next: Option<usize>,
}

/// One job-local geometry backing store. The coordinator owns every mutation,
/// lookup touch, eviction, and publication. Rayon workers only receive pure
/// geometry inputs and return pure computed values for serial publication.
pub struct GeometryCacheStore {
    entries: HashMap<String, GeometryCacheEntry>,
    recency_nodes: Vec<Option<RecencyNode>>,
    recency_head: Option<usize>,
    recency_tail: Option<usize>,
    free_recency_nodes: Vec<usize>,
    byte_cap: u64,
    telemetry: CacheTelemetrySnapshot,
}

impl Default for GeometryCacheStore {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryCacheStore {
    /// Constructs the finite 56 MiB geometry cache budget for one job.
    pub fn new() -> Self {
        Self::with_byte_cap(GEOMETRY_CACHE_DEFAULT_CAP_BYTES)
    }

    #[cfg(test)]
    fn new_with_byte_cap_for_test(byte_cap: u64) -> Self {
        Self::with_byte_cap(byte_cap)
    }

    pub(crate) fn with_byte_cap(byte_cap: u64) -> Self {
        let telemetry = CacheTelemetrySnapshot {
            cache_instances: 1,
            cap_bytes: byte_cap,
            ..CacheTelemetrySnapshot::default()
        };
        Self {
            entries: HashMap::new(),
            recency_nodes: Vec::new(),
            recency_head: None,
            recency_tail: None,
            free_recency_nodes: Vec::new(),
            byte_cap,
            telemetry,
        }
    }

    /// Invokes `inspect` with a typed borrowed value without cloning it. The
    /// callback cannot retain the borrow, allowing this store to update LRU
    /// recency after inspection on the coordinator thread.
    fn probe<A: 'static, R>(
        &mut self,
        key: &GeometryCacheKey,
        inspect: impl FnOnce(Option<&A>) -> R,
    ) -> R {
        let serialized = serialize_geometry_cache_key(key);
        let present = self
            .entries
            .get(&serialized)
            .and_then(|entry| entry.value.downcast_ref::<A>());
        let result = inspect(present);
        let counters = self.telemetry.namespace_mut(&key.namespace);
        counters.lookups = counters.lookups.saturating_add(1);
        if present.is_some() {
            self.touch(&serialized);
        } else {
            counters.misses = counters.misses.saturating_add(1);
        }
        result
    }

    /// Checks a typed cached value without cloning it. Invalid values are
    /// removed immediately so a later resolver observes a true miss.
    pub fn probe_valid<A: 'static>(
        &mut self,
        key: &GeometryCacheKey,
        is_valid: impl FnOnce(&A) -> bool,
    ) -> GeometryCacheProbe {
        match self.probe(key, |value: Option<&A>| value.map(is_valid)) {
            Some(true) => GeometryCacheProbe::HotValid,
            Some(false) => {
                self.record_stale_detection(&key.namespace);
                self.remove(key);
                GeometryCacheProbe::StaleRemoved
            }
            None => GeometryCacheProbe::Cold,
        }
    }

    /// The real resolvers use this cloning lookup only when they need the
    /// candidate value. Prepasses use [`Self::probe_valid`] instead.
    pub fn get<A: Clone + 'static>(&mut self, key: &GeometryCacheKey) -> Option<A> {
        let value = self.probe(key, |cached: Option<&A>| cached.cloned());
        if value.is_some() {
            let counters = self.telemetry.namespace_mut(&key.namespace);
            counters.cloning_hits = counters.cloning_hits.saturating_add(1);
        }
        value
    }

    /// Publishes a value with a caller-supplied conservative retained-value
    /// charge. The store adds serialized-key capacity and metadata/container
    /// overhead, then deterministically evicts least-recent entries as needed.
    /// A single oversized value is rejected without changing unrelated entries.
    pub fn set<A: 'static + Send>(
        &mut self,
        key: &GeometryCacheKey,
        value: A,
        value_charge: u64,
    ) -> bool {
        let serialized = serialize_geometry_cache_key(key);
        let entry_charge =
            conservative_entry_charge(&serialized, key.namespace.capacity(), value_charge);
        if entry_charge > self.byte_cap {
            self.record_oversized_rejection(&key.namespace);
            return false;
        }

        let replacing = self.entries.contains_key(&serialized);
        let previous = self.entries.remove(&serialized);
        if let Some(previous) = previous {
            self.remove_recency_node(previous.recency_node);
            self.subtract_current(&previous.namespace, previous.charge_bytes, false);
        }

        let mut evicted_any = false;
        while self.telemetry.current_bytes.saturating_add(entry_charge) > self.byte_cap {
            let Some(oldest) = self.recency_head else {
                break;
            };
            let oldest_key = self
                .recency_nodes
                .get(oldest)
                .and_then(Option::as_ref)
                .expect("the LRU head must reference a live node")
                .key
                .clone();
            self.remove_recency_node(oldest);
            let Some(evicted) = self.entries.remove(&oldest_key) else {
                continue;
            };
            self.subtract_current(&evicted.namespace, evicted.charge_bytes, true);
            evicted_any = true;
        }

        let namespace = key.namespace.clone();
        let recency_node = self.insert_recency_node(serialized.clone());
        self.entries.insert(
            serialized,
            GeometryCacheEntry {
                value: Box::new(value),
                charge_bytes: entry_charge,
                namespace: namespace.clone(),
                recency_node,
            },
        );
        self.add_current(&namespace, entry_charge);
        {
            let counters = self.telemetry.namespace_mut(&namespace);
            counters.stores = counters.stores.saturating_add(1);
            if replacing {
                counters.replacements = counters.replacements.saturating_add(1);
            } else {
                counters.entries = counters.entries.saturating_add(1);
            }
            counters.admissions = counters.admissions.saturating_add(1);
        }
        if replacing {
            self.telemetry.replacements = self.telemetry.replacements.saturating_add(1);
        }
        self.telemetry.admissions = self.telemetry.admissions.saturating_add(1);
        if evicted_any {
            self.compact_retained_storage();
        }
        true
    }

    /// Removes a stale value before recomputation and releases its complete
    /// charged record. The stale counter remains paired with the caller's
    /// explicit stale-detection record.
    pub fn remove(&mut self, key: &GeometryCacheKey) {
        let serialized = serialize_geometry_cache_key(key);
        let removed = self.entries.remove(&serialized);
        let counters = self.telemetry.namespace_mut(&key.namespace);
        counters.stale_removals = counters.stale_removals.saturating_add(1);
        if let Some(removed) = removed {
            self.remove_recency_node(removed.recency_node);
            self.subtract_current(&removed.namespace, removed.charge_bytes, false);
            let counters = self.telemetry.namespace_mut(&removed.namespace);
            counters.entries = counters.entries.saturating_sub(1);
            self.compact_retained_storage();
        }
    }

    /// Releases all retained allocation capacity after producing the diagnostic
    /// snapshot. Counters and peak values remain available for that snapshot.
    pub fn clear_and_shrink(&mut self) {
        self.entries.clear();
        self.entries.shrink_to_fit();
        self.recency_nodes.clear();
        self.recency_nodes.shrink_to_fit();
        self.recency_head = None;
        self.recency_tail = None;
        self.free_recency_nodes.clear();
        self.free_recency_nodes.shrink_to_fit();
        self.telemetry.current_bytes = 0;
        for counters in self.telemetry.namespaces.values_mut() {
            counters.entries = 0;
            counters.approx_bytes = 0;
        }
    }

    pub fn clear(&mut self) {
        self.clear_and_shrink();
    }

    pub fn record_hit(&mut self, namespace: &str) {
        let counters = self.telemetry.namespace_mut(namespace);
        counters.hits = counters.hits.saturating_add(1);
        counters.backing_cache_hits = counters.backing_cache_hits.saturating_add(1);
    }

    pub fn record_stale_detection(&mut self, namespace: &str) {
        let counters = self.telemetry.namespace_mut(namespace);
        counters.stale_detections = counters.stale_detections.saturating_add(1);
    }

    pub fn telemetry(&self) -> &CacheTelemetrySnapshot {
        &self.telemetry
    }

    fn touch(&mut self, serialized: &str) {
        let Some(recency_node) = self.entries.get(serialized).map(|entry| entry.recency_node)
        else {
            return;
        };
        if self.recency_tail == Some(recency_node) {
            return;
        }
        self.detach_recency_node(recency_node);
        self.append_recency_node(recency_node);
    }

    fn insert_recency_node(&mut self, key: String) -> usize {
        let node = RecencyNode {
            key,
            previous: None,
            next: None,
        };
        let recency_node = match self.free_recency_nodes.pop() {
            Some(index) => {
                self.recency_nodes[index] = Some(node);
                index
            }
            None => {
                self.recency_nodes.push(Some(node));
                self.recency_nodes.len() - 1
            }
        };
        self.append_recency_node(recency_node);
        recency_node
    }

    fn remove_recency_node(&mut self, recency_node: usize) {
        self.detach_recency_node(recency_node);
        self.recency_nodes[recency_node] = None;
        self.free_recency_nodes.push(recency_node);
    }

    fn detach_recency_node(&mut self, recency_node: usize) {
        let (previous, next) = {
            let node = self.recency_nodes[recency_node]
                .as_ref()
                .expect("every entry must retain one live LRU node");
            (node.previous, node.next)
        };

        if let Some(previous) = previous {
            self.recency_nodes[previous]
                .as_mut()
                .expect("LRU predecessor must be live")
                .next = next;
        } else {
            self.recency_head = next;
        }
        if let Some(next) = next {
            self.recency_nodes[next]
                .as_mut()
                .expect("LRU successor must be live")
                .previous = previous;
        } else {
            self.recency_tail = previous;
        }
        let node = self.recency_nodes[recency_node]
            .as_mut()
            .expect("every entry must retain one live LRU node");
        node.previous = None;
        node.next = None;
    }

    fn append_recency_node(&mut self, recency_node: usize) {
        let previous_tail = self.recency_tail;
        {
            let node = self.recency_nodes[recency_node]
                .as_mut()
                .expect("every entry must retain one live LRU node");
            node.previous = previous_tail;
            node.next = None;
        }
        if let Some(previous_tail) = previous_tail {
            self.recency_nodes[previous_tail]
                .as_mut()
                .expect("LRU tail must be live")
                .next = Some(recency_node);
        } else {
            self.recency_head = Some(recency_node);
        }
        self.recency_tail = Some(recency_node);
    }

    fn compact_retained_storage(&mut self) {
        let mut ordered_keys = Vec::with_capacity(self.entries.len());
        let mut cursor = self.recency_head;
        while let Some(index) = cursor {
            let node = self.recency_nodes[index]
                .as_ref()
                .expect("the LRU chain must contain only live nodes");
            ordered_keys.push(node.key.clone());
            cursor = node.next;
        }

        let entry_count = ordered_keys.len();
        let mut compacted = Vec::with_capacity(entry_count);
        for (index, key) in ordered_keys.into_iter().enumerate() {
            let previous = index.checked_sub(1);
            let next = (index + 1 < entry_count).then_some(index + 1);
            self.entries
                .get_mut(&key)
                .expect("every LRU key must identify a live cache entry")
                .recency_node = index;
            compacted.push(Some(RecencyNode {
                key,
                previous,
                next,
            }));
        }
        self.recency_nodes = compacted;
        self.recency_nodes.shrink_to_fit();
        self.recency_head = (entry_count > 0).then_some(0);
        self.recency_tail = entry_count.checked_sub(1);
        self.free_recency_nodes.clear();
        self.free_recency_nodes.shrink_to_fit();
        self.entries.shrink_to_fit();
    }

    fn add_current(&mut self, namespace: &str, charge_bytes: u64) {
        self.telemetry.current_bytes = self.telemetry.current_bytes.saturating_add(charge_bytes);
        self.telemetry.peak_bytes = self.telemetry.peak_bytes.max(self.telemetry.current_bytes);
        let counters = self.telemetry.namespace_mut(namespace);
        counters.cap_bytes = self.byte_cap;
        counters.approx_bytes = counters.approx_bytes.saturating_add(charge_bytes);
        counters.peak_bytes = counters.peak_bytes.max(counters.approx_bytes);
    }

    fn subtract_current(&mut self, namespace: &str, charge_bytes: u64, evicted: bool) {
        self.telemetry.current_bytes = self.telemetry.current_bytes.saturating_sub(charge_bytes);
        let counters = self.telemetry.namespace_mut(namespace);
        counters.approx_bytes = counters.approx_bytes.saturating_sub(charge_bytes);
        if evicted {
            counters.entries = counters.entries.saturating_sub(1);
            counters.evictions = counters.evictions.saturating_add(1);
            counters.evicted_bytes = counters.evicted_bytes.saturating_add(charge_bytes);
            self.telemetry.evictions = self.telemetry.evictions.saturating_add(1);
            self.telemetry.evicted_bytes =
                self.telemetry.evicted_bytes.saturating_add(charge_bytes);
        }
    }

    fn record_oversized_rejection(&mut self, namespace: &str) {
        let counters = self.telemetry.namespace_mut(namespace);
        counters.cap_bytes = self.byte_cap;
        counters.oversized_rejections = counters.oversized_rejections.saturating_add(1);
        self.telemetry.oversized_rejections = self.telemetry.oversized_rejections.saturating_add(1);
    }
}

fn conservative_entry_charge(
    serialized_key: &String,
    namespace_capacity: usize,
    retained_value_charge: u64,
) -> u64 {
    let key_capacity = u64::try_from(serialized_key.capacity()).unwrap_or(u64::MAX);
    let namespace_capacity = u64::try_from(namespace_capacity).unwrap_or(u64::MAX);
    retained_value_charge
        .checked_add(key_capacity)
        .and_then(|charge| charge.checked_add(key_capacity))
        .and_then(|charge| charge.checked_add(namespace_capacity))
        .and_then(|charge| charge.checked_add(HASHMAP_ENTRY_OVERHEAD_BYTES))
        .and_then(|charge| charge.checked_add(std::mem::size_of::<GeometryCacheEntry>() as u64))
        .and_then(|charge| charge.checked_add(std::mem::size_of::<RecencyNode>() as u64))
        .unwrap_or(u64::MAX)
}

/// Conservative retained-value charge for a relative NFP polygon.
pub fn charge_nfp_polygon(value: &crate::domain::IrregularPolygon) -> u64 {
    charge_value_with_vec_capacity::<crate::domain::IrregularPolygon, crate::domain::IrregularPoint>(
        value.points.capacity(),
    )
}

/// Conservative retained-value charge for a cached rectangular IFP bounds value.
pub fn charge_ifp_bounds(value: &crate::domain::IrregularIfpBounds) -> u64 {
    charge_sum(&[
        std::mem::size_of::<crate::domain::IrregularIfpBounds>() as u64,
        string_owned_capacity_charge(&value.sheet.label),
        string_owned_capacity_charge(&value.moving_piece_id.0),
    ])
}

/// Conservative retained-value charge for transformed collision geometry.
pub fn charge_transformed_collision_geometry<T>(value: &T) -> u64
where
    T: crate::caches::TransformedCollisionGeometryLike,
{
    charge_sum(&[
        std::mem::size_of::<T>() as u64,
        string_owned_capacity_charge(&value.source_piece_id().0),
        capacity_charge::<crate::domain::IrregularPoint>(value.polygon().points.capacity()),
    ])
}

fn charge_value_with_vec_capacity<T, U>(capacity: usize) -> u64 {
    charge_sum(&[
        std::mem::size_of::<T>() as u64,
        capacity_charge::<U>(capacity),
    ])
}

pub(crate) fn capacity_charge<T>(capacity: usize) -> u64 {
    u64::try_from(capacity)
        .ok()
        .and_then(|capacity| capacity.checked_mul(std::mem::size_of::<T>() as u64))
        .unwrap_or(u64::MAX)
}

pub(crate) fn string_owned_capacity_charge(value: &String) -> u64 {
    u64::try_from(value.capacity()).unwrap_or(u64::MAX)
}

fn charge_sum(parts: &[u64]) -> u64 {
    parts
        .iter()
        .try_fold(0u64, |total, part| total.checked_add(*part))
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(namespace: &str, parts: &[&str]) -> GeometryCacheKey {
        GeometryCacheKey::new(
            namespace,
            parts.iter().map(|part| part.to_string()).collect(),
        )
    }

    // -----------------------------------------------------------------
    // serialize_geometry_cache_key: golden byte strings pinned by
    // geometry-caches.md §8 / tests/unit/nfpBoundaryCore.test.ts:38-53 /
    // tests/unit/pureIfpTransformContract.test.ts:184-189.
    // -----------------------------------------------------------------

    #[test]
    fn serialize_matches_the_pairwise_nfp_golden_bytes() {
        let cache_key = key(
            "pairwise-nfp-relative-v3",
            &[
                "fixed-polygon=0,0;0,4;4,4;4,0",
                "moving-polygon=0,0;0,2;2,2;2,0",
                "fixed-transform=index=0,rotation=0,mirrored=0,reason=configured",
                "moving-transform=index=0,rotation=0,mirrored=0,reason=configured",
                "flattening-sag=0.05",
                "clearance-margin=0.05",
                "backend=clipper2-ts",
                "backend-version=2.0.1-18",
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000",
                "nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3",
                "nfp-construction=vertex-pair-hull",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["pairwise-nfp-relative-v3",["fixed-polygon=0,0;0,4;4,4;4,0","moving-polygon=0,0;0,2;2,2;2,0","fixed-transform=index=0,rotation=0,mirrored=0,reason=configured","moving-transform=index=0,rotation=0,mirrored=0,reason=configured","flattening-sag=0.05","clearance-margin=0.05","backend=clipper2-ts","backend-version=2.0.1-18","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","nfp-algorithm=convex-fixed-plus-negated-moving-relative-v3","nfp-construction=vertex-pair-hull"]]"#
        );
    }

    #[test]
    fn serialize_matches_the_transform_collision_golden_bytes() {
        let cache_key = key(
            "transform-collision-v1",
            &[
                "source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3",
                "index=7,rotation=90,mirrored=1,reason=configured",
                "flattening-sag=0.25",
                "clearance-margin=0.25",
                "backend=irregular-convex-v2-default",
                "backend-version=0",
                "offset-policy=clipper2-offset-v3-sharp-miter-scale-1000",
                "placement-reference=local-lower-left",
                "transform-operation=mirror-y-then-ccw-rotate",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["transform-collision-v1",["source=key-piece;source-bounds=0,0,4,3;placement-reference=0,0;hull=0,0;4,0;4,3;0,3;collision=0,0;4,0;4,3;0,3","index=7,rotation=90,mirrored=1,reason=configured","flattening-sag=0.25","clearance-margin=0.25","backend=irregular-convex-v2-default","backend-version=0","offset-policy=clipper2-offset-v3-sharp-miter-scale-1000","placement-reference=local-lower-left","transform-operation=mirror-y-then-ccw-rotate"]]"#
        );
    }

    #[test]
    fn serialize_matches_the_sheet_ifp_golden_bytes() {
        let cache_key = key(
            "sheet-ifp-v1",
            &[
                "sheet=20,15,key sheet",
                "moving-piece=key-piece",
                "moving-transform=index=7,rotation=90,mirrored=1,reason=configured",
                "moving-polygon=0,0;4,0;4,3;0,3",
                "ifp-operation=rectangular-sheet-vertex-bounds",
            ],
        );
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["sheet-ifp-v1",["sheet=20,15,key sheet","moving-piece=key-piece","moving-transform=index=7,rotation=90,mirrored=1,reason=configured","moving-polygon=0,0;4,0;4,3;0,3","ifp-operation=rectangular-sheet-vertex-bounds"]]"#
        );
    }

    #[test]
    fn serialize_escapes_quotes_backslashes_and_control_characters() {
        let cache_key = key("ns", &["has \"quotes\" and \\backslash\\ and \t tab"]);
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            r#"["ns",["has \"quotes\" and \\backslash\\ and \t tab"]]"#
        );
    }

    #[test]
    fn serialize_passes_non_ascii_text_through_unescaped() {
        let cache_key = key("ns", &["pièce-日本語"]);
        assert_eq!(
            serialize_geometry_cache_key(&cache_key),
            "[\"ns\",[\"pièce-日本語\"]]"
        );
    }

    // -----------------------------------------------------------------
    // GeometryCacheStore behavior + telemetry wiring.
    // -----------------------------------------------------------------

    #[test]
    fn new_records_exactly_one_cache_instance_and_the_documented_byte_cap() {
        let store = GeometryCacheStore::new();
        assert_eq!(store.telemetry().cache_instances, 1);
        assert_eq!(
            store.telemetry().cap_bytes,
            56 * 1024 * 1024,
            "the job-local geometry cache budget remains finite"
        );
    }

    #[test]
    fn get_on_an_empty_store_is_a_miss_and_records_lookup_and_miss() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("transform-collision-v1", &["a"]);
        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
        let counters = store.telemetry().namespace("transform-collision-v1");
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 1);
        assert_eq!(counters.hits, 0);
    }

    #[test]
    fn set_then_get_round_trips_the_value_and_records_a_store_and_new_entry() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("sheet-ifp-v1", &["a"]);
        assert!(store.set(&cache_key, 42u32, 0));
        let counters = store.telemetry().namespace("sheet-ifp-v1");
        assert_eq!(counters.stores, 1);
        assert_eq!(counters.entries, 1);

        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, Some(42));
        // A present entry does not by itself record a hit or a miss -- the
        // store cannot determine validity; see record_hit's doc comment.
        let counters = store.telemetry().namespace("sheet-ifp-v1");
        assert_eq!(counters.lookups, 1);
        assert_eq!(counters.misses, 0);
        assert_eq!(counters.hits, 0);
    }

    #[test]
    fn record_hit_increments_hits_and_backing_cache_hits() {
        let mut store = GeometryCacheStore::new();
        store.record_hit("pairwise-nfp-relative-v3");
        let counters = store.telemetry().namespace("pairwise-nfp-relative-v3");
        assert_eq!(counters.hits, 1);
        assert_eq!(counters.backing_cache_hits, 1);
    }

    #[test]
    fn remove_records_a_stale_removal_and_decrements_entries() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("transform-collision-v1", &["a"]);
        assert!(store.set(&cache_key, 7u32, 0));
        store.record_stale_detection("transform-collision-v1");
        store.remove(&cache_key);

        let counters = store.telemetry().namespace("transform-collision-v1");
        assert_eq!(counters.stale_detections, 1);
        assert_eq!(counters.stale_removals, 1);
        assert_eq!(counters.entries, 0);

        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
    }

    #[test]
    fn downcast_mismatch_is_reported_as_a_miss_not_a_panic() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("ns", &["a"]);
        assert!(store.set(&cache_key, 1u32, 0));
        let result: Option<String> = store.get(&cache_key);
        assert_eq!(result, None);
    }

    #[test]
    fn clear_empties_the_store_and_zeroes_entry_counts_but_not_other_counters() {
        let mut store = GeometryCacheStore::new();
        let cache_key = key("ns", &["a"]);
        assert!(store.set(&cache_key, 1u32, 0));
        let peak_bytes = store.telemetry().peak_bytes;
        store.clear();
        let result: Option<u32> = store.get(&cache_key);
        assert_eq!(result, None);
        let counters = store.telemetry().namespace("ns");
        assert_eq!(store.telemetry().current_bytes, 0);
        assert_eq!(store.telemetry().peak_bytes, peak_bytes);
        assert_eq!(counters.entries, 0);
        assert_eq!(counters.approx_bytes, 0);
        // clear() does not touch setCalls/getCalls-equivalent counters,
        // matching TS's clear() having no NfpIfpTelemetry call at all.
        assert_eq!(counters.stores, 1);
    }

    #[test]
    fn valid_probe_borrows_a_hot_value_without_cloning_and_stale_probe_removes_it() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        #[derive(Debug)]
        struct CloneCounted(Arc<AtomicUsize>);

        impl Clone for CloneCounted {
            fn clone(&self) -> Self {
                self.0.fetch_add(1, Ordering::SeqCst);
                Self(Arc::clone(&self.0))
            }
        }

        let clones = Arc::new(AtomicUsize::new(0));
        let cache_key = key("nfp", &["probe"]);
        let mut store = GeometryCacheStore::new();
        assert!(store.set(&cache_key, CloneCounted(Arc::clone(&clones)), 0));

        assert_eq!(
            store.probe_valid::<CloneCounted>(&cache_key, |_| true),
            GeometryCacheProbe::HotValid
        );
        assert_eq!(clones.load(Ordering::SeqCst), 0);
        assert!(store.get::<CloneCounted>(&cache_key).is_some());
        assert_eq!(clones.load(Ordering::SeqCst), 1);

        assert_eq!(
            store.probe_valid::<CloneCounted>(&cache_key, |_| false),
            GeometryCacheProbe::StaleRemoved
        );
        assert!(store.get::<CloneCounted>(&cache_key).is_none());
        let counters = store.telemetry().namespace("nfp");
        assert_eq!(counters.stale_detections, 1);
        assert_eq!(counters.stale_removals, 1);
    }

    #[test]
    fn entry_charge_includes_the_retained_namespace_copy() {
        let cache_key = key("namespace-with-owned-capacity", &["part"]);
        let serialized = serialize_geometry_cache_key(&cache_key);
        let expected = (serialized.capacity() as u64)
            .saturating_mul(2)
            .saturating_add(cache_key.namespace.capacity() as u64)
            .saturating_add(HASHMAP_ENTRY_OVERHEAD_BYTES)
            .saturating_add(std::mem::size_of::<GeometryCacheEntry>() as u64)
            .saturating_add(std::mem::size_of::<RecencyNode>() as u64);

        assert_eq!(
            conservative_entry_charge(&serialized, cache_key.namespace.capacity(), 0),
            expected
        );
    }

    #[test]
    fn replacement_updates_bytes_and_counters_without_counting_an_eviction() {
        let cache_key = key("nfp", &["replace"]);
        let serialized = serialize_geometry_cache_key(&cache_key);
        let large_charge =
            conservative_entry_charge(&serialized, cache_key.namespace.capacity(), 80);
        let mut store = GeometryCacheStore::new_with_byte_cap_for_test(large_charge);

        assert!(store.set(&cache_key, 1u32, 20));
        assert!(store.set(&cache_key, 2u32, 80));

        assert_eq!(store.get::<u32>(&cache_key), Some(2));
        assert_eq!(store.telemetry().current_bytes, large_charge);
        assert_eq!(store.telemetry().peak_bytes, large_charge);
        assert_eq!(store.telemetry().replacements, 1);
        assert_eq!(store.telemetry().evictions, 0);
        let counters = store.telemetry().namespace("nfp");
        assert_eq!(counters.entries, 1);
        assert_eq!(counters.approx_bytes, large_charge);
        assert_eq!(counters.replacements, 1);
        assert_eq!(counters.admissions, 2);
    }

    #[test]
    fn charged_lru_evicts_the_least_recently_used_entry_at_a_tiny_cap() {
        let first = key("nfp", &["one"]);
        let second = key("nfp", &["two"]);
        let third = key("nfp", &["tri"]);
        let entry_charge = conservative_entry_charge(
            &serialize_geometry_cache_key(&first),
            first.namespace.capacity(),
            40,
        );
        let mut store = GeometryCacheStore::new_with_byte_cap_for_test(entry_charge * 2);

        assert!(store.set(&first, 1u32, 40));
        assert!(store.set(&second, 2u32, 40));
        assert_eq!(store.get::<u32>(&first), Some(1));
        assert!(store.set(&third, 3u32, 40));

        assert_eq!(store.get::<u32>(&second), None);
        assert_eq!(store.get::<u32>(&first), Some(1));
        assert_eq!(store.get::<u32>(&third), Some(3));
        let counters = store.telemetry().namespace("nfp");
        assert_eq!(counters.cap_bytes, entry_charge * 2);
        assert_eq!(counters.approx_bytes, entry_charge * 2);
        assert_eq!(counters.peak_bytes, entry_charge * 2);
        assert_eq!(counters.evictions, 1);
        assert_eq!(counters.evicted_bytes, entry_charge);
        assert_eq!(counters.admissions, 3);
        assert_eq!(
            store.recency_nodes.iter().flatten().count(),
            store.entries.len(),
            "every admitted entry must retain exactly one LRU node"
        );
    }

    #[test]
    fn repeated_stale_removal_compacts_retained_recency_and_hash_capacity() {
        let mut store = GeometryCacheStore::new_with_byte_cap_for_test(20_000);
        let keys: Vec<_> = (0..64)
            .map(|index| key("nfp", &[&format!("stale-{index}")]))
            .collect();
        for (index, cache_key) in keys.iter().enumerate() {
            assert!(store.set(cache_key, index, 0));
        }
        let entries_capacity_before = store.entries.capacity();

        for cache_key in keys.iter().take(44) {
            store.record_stale_detection("nfp");
            store.remove(cache_key);
        }

        assert_eq!(store.recency_nodes.len(), store.entries.len());
        assert!(store.free_recency_nodes.is_empty());
        assert!(store.entries.capacity() < entries_capacity_before);
    }

    #[test]
    fn multi_eviction_compacts_retained_recency_and_hash_capacity() {
        let mut store = GeometryCacheStore::new_with_byte_cap_for_test(20_000);
        for index in 0..64 {
            let cache_key = key("nfp", &[&format!("small-{index}")]);
            assert!(store.set(&cache_key, index, 0));
        }
        let entries_capacity_before = store.entries.capacity();
        let large = key("nfp", &["large"]);

        assert!(store.set(&large, 999u32, 15_000));
        assert!(store.telemetry().evictions > 1);
        assert_eq!(store.recency_nodes.len(), store.entries.len());
        assert!(store.free_recency_nodes.is_empty());
        assert!(store.entries.capacity() < entries_capacity_before);
    }

    #[test]
    fn charged_lru_rejects_an_oversized_entry_without_evicting_a_hot_entry() {
        let retained = key("nfp", &["retained"]);
        let oversized = key("nfp", &["oversized"]);
        let retained_charge = conservative_entry_charge(
            &serialize_geometry_cache_key(&retained),
            retained.namespace.capacity(),
            60,
        );
        let mut store = GeometryCacheStore::new_with_byte_cap_for_test(retained_charge);
        assert!(store.set(&retained, 7u32, 60));

        assert!(!store.set(&oversized, 9u32, retained_charge));
        assert_eq!(store.get::<u32>(&retained), Some(7));
        assert_eq!(store.get::<u32>(&oversized), None);
        let counters = store.telemetry().namespace("nfp");
        assert_eq!(counters.entries, 1);
        assert_eq!(counters.approx_bytes, retained_charge);
        assert_eq!(counters.oversized_rejections, 1);
        assert_eq!(counters.evictions, 0);
    }
}
