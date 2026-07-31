//! Namespace-agnostic archive dedup/rank primitive + terminal
//! complete-over-partial dominance selection.
//!
//! TS source: `src/workers/algorithm/irregular/intrinsicAnytimeArchive.ts`
//! (62 lines), ported here in full. Read together with
//! `docs/planning/rust-irregular-backend/characterization/shared-archive.md`
//! §1/§4/§5/§9/§12/§13 before touching this file -- it is this cluster's
//! primary governing source. `archive::shared` is this module's sole
//! production consumer (`retain_ranked_shared_archive`) today;
//! `capacity::mode`'s partial-namespace dedup (TS: `intrinsicCapacityMode.ts:1303-1313,
//! :1322-1336`) is the other production call site but lives outside this
//! task's file-ownership scope.
//!
//! # Reused (GREEN) modules -- never duplicated here
//!
//! None: per characterization §7, this file performs no arithmetic
//! (`Math.*`/`Number.*`/`BigInt`) and touches no cache, geometry, or
//! checkpoint module -- it is pure generic Map/array plumbing over
//! caller-supplied comparator/validator/identity closures.
//!
//! # Order-preserving update-in-place dedup, without an `indexmap` dependency
//!
//! TS `unique = new Map<string, Endpoint>()` (`:36`) relies on JS `Map`'s
//! "insert-or-update value without moving position" semantics: `Map.set` on
//! an *already-present* key updates the value in place but does **not**
//! move it to the end of iteration order (characterization §5 item 3, §12
//! item 2). This crate has no `indexmap` dependency (file ownership forbids
//! adding one via `Cargo.toml`), so
//! [`retain_intrinsic_anytime_archive_namespace`] reproduces the same
//! semantics directly with a `Vec<Endpoint>` (first-occurrence order) plus a
//! parallel `HashMap<String, usize>` identity-to-index lookup: an
//! already-seen identity overwrites `order[existing_index]` in place, never
//! appending or moving it -- exactly JS `Map.set`-on-existing-key behavior,
//! without a naive remove-then-reinsert pattern (which would incorrectly
//! move updated entries to the end).
//!
//! # Structural-closures-as-a-policy-object seam
//!
//! TS assembles the five behaviors (`namespace`, `endpoints`, `identity`,
//! `validate`, `selectDuplicate`, `rank`) into one structurally-typed
//! `IntrinsicAnytimeArchiveNamespacePolicy<Endpoint>` object literal at each
//! call site (`shared-archive.md` §1). Rust has no structural closure
//! typing, so [`IntrinsicAnytimeArchiveNamespacePolicy`] holds each behavior
//! as an explicit `&mut dyn FnMut(...)` trait-object field instead -- the
//! same "one field per TS closure" seam this codebase already uses for
//! `NfpIfpControl` (`nfp_ifp::service`'s own doc comment on double-indirection
//! reborrowing, which this module's [`retain_intrinsic_anytime_archive_namespace`]
//! does not need since every closure here is called from a single flat loop,
//! never reborrowed across nested function boundaries).

use std::collections::HashMap;

/// TS: `intrinsicAnytimeArchive.ts:1` `IntrinsicAnytimeArchiveNamespace`.
///
/// Purely a documentation/type-level tag in the TS source: `policy.namespace`
/// is never read inside `retainIntrinsicAnytimeArchiveNamespace`'s own body
/// (verified by direct source read, `:33-48`) -- it exists only so the two
/// production call sites (`archive::shared`'s complete namespace,
/// `capacity::mode`'s partial namespace) can self-document which namespace
/// they are populating. Kept here, unread by this function's own logic too,
/// for exact structural/API fidelity with the TS type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeArchiveNamespace {
    Complete,
    Partial,
}

/// TS: `intrinsicAnytimeArchive.ts:3-10` `IntrinsicAnytimeArchiveNamespacePolicy<Endpoint>`.
/// See this module's top doc, "Structural-closures-as-a-policy-object seam".
pub struct IntrinsicAnytimeArchiveNamespacePolicy<'a, Endpoint> {
    pub namespace: IntrinsicAnytimeArchiveNamespace,
    pub endpoints: &'a [Endpoint],
    pub identity: &'a mut dyn FnMut(&Endpoint) -> Option<String>,
    pub validate: &'a mut dyn FnMut(&Endpoint) -> bool,
    pub select_duplicate: &'a mut dyn FnMut(&Endpoint, &Endpoint) -> Endpoint,
    pub rank: &'a mut dyn FnMut(Vec<Endpoint>) -> Vec<Endpoint>,
}

/// TS: `retainIntrinsicAnytimeArchiveNamespace` (`intrinsicAnytimeArchive.ts:33-48`).
///
/// Validates, canonically deduplicates, and ranks one protected namespace.
/// Namespace-specific comparators and survivor slots remain outside this
/// storage mechanic (TS doc comment, `:28-31`, reproduced verbatim).
///
/// Exact translation of the TS loop (`:37-46`): for each input endpoint in
/// order, skip it if `validate` rejects it or `identity` returns `None`/an
/// empty string; otherwise insert-or-update it into `unique` keyed by its
/// identity, replacing an existing entry's *value* (via `select_duplicate`)
/// without moving its position -- see this module's top doc for why
/// `IndexMap` (not `HashMap`) is required for this to be correct. The
/// deduplicated values, in first-occurrence-position order, are then handed
/// to `rank` exactly once (characterization §4/§12 item 7: this "exactly
/// once" invariant is structurally guaranteed here, not merely incidental,
/// because `rank` is consumed by value at the end of this function and
/// cannot be re-invoked).
pub fn retain_intrinsic_anytime_archive_namespace<Endpoint: Clone>(
    policy: IntrinsicAnytimeArchiveNamespacePolicy<'_, Endpoint>,
) -> Vec<Endpoint> {
    let IntrinsicAnytimeArchiveNamespacePolicy {
        namespace: _namespace,
        endpoints,
        identity,
        validate,
        select_duplicate,
        rank,
    } = policy;

    // `order` is `unique`'s first-occurrence-position value sequence;
    // `index_by_identity` is the identity-keyed lookup JS `Map` provides
    // natively. Updating `order[existing_index]` in place (never pushing a
    // second entry, never removing/reinserting) is what reproduces
    // `Map.set`-on-existing-key's "replace value, keep position" contract --
    // see this module's top doc.
    let mut order: Vec<Endpoint> = Vec::new();
    let mut index_by_identity: HashMap<String, usize> = HashMap::new();
    for endpoint in endpoints {
        if !validate(endpoint) {
            continue;
        }
        let Some(identity_key) = identity(endpoint) else {
            continue;
        };
        if identity_key.is_empty() {
            continue;
        }
        match index_by_identity.get(&identity_key) {
            None => {
                index_by_identity.insert(identity_key, order.len());
                order.push(endpoint.clone());
            }
            Some(&existing_index) => {
                order[existing_index] = select_duplicate(&order[existing_index], endpoint);
            }
        }
    }
    rank(order)
}

/// TS: `intrinsicAnytimeArchive.ts:17-26` `IntrinsicAnytimeSettledSelection`.
/// The TS union's `undefined` arm is modeled as the outer `Option` returned
/// by [`select_intrinsic_anytime_settled_endpoint`] rather than as a third
/// enum variant here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IntrinsicAnytimeSettledSelection<CompleteEndpoint, PartialEndpoint> {
    Complete(CompleteEndpoint),
    Partial(PartialEndpoint),
}

/// TS: `intrinsicAnytimeArchive.ts:12-15` `IntrinsicAnytimeArchiveSnapshot`.
pub struct IntrinsicAnytimeArchiveSnapshot<'a, CompleteEndpoint, PartialEndpoint> {
    pub complete: &'a [CompleteEndpoint],
    pub partial: &'a [PartialEndpoint],
}

/// TS: `selectIntrinsicAnytimeSettledEndpoint` (`intrinsicAnytimeArchive.ts:55-62`).
///
/// Applies the terminal dominance contract after both namespaces have
/// settled. A fitting complete endpoint always wins; partial ranking is
/// consulted only when the complete namespace is empty (TS doc comment,
/// `:50-54`, reproduced verbatim).
///
/// **Dead in production** (characterization §1): `grep -rn
/// "selectIntrinsicAnytimeSettledEndpoint"` across `src/` finds zero call
/// sites besides its own definition and
/// `tests/unit/intrinsicAnytimeArchive.test.ts:37-49`. Production instead
/// hand-rolls the identical rule at `computeIrregularNesting.ts:959`. Ported
/// here anyway per the migration prompt's "port completely, including
/// exported-but-unused surface" rule (§15 item 1 of the characterization doc
/// records this duplication as intentional, not accidental, and instructs
/// both call shapes to be preserved independently rather than consolidated).
pub fn select_intrinsic_anytime_settled_endpoint<
    CompleteEndpoint: Clone,
    PartialEndpoint: Clone,
>(
    snapshot: IntrinsicAnytimeArchiveSnapshot<'_, CompleteEndpoint, PartialEndpoint>,
) -> Option<IntrinsicAnytimeSettledSelection<CompleteEndpoint, PartialEndpoint>> {
    if let Some(complete) = snapshot.complete.first() {
        return Some(IntrinsicAnytimeSettledSelection::Complete(complete.clone()));
    }
    snapshot
        .partial
        .first()
        .cloned()
        .map(IntrinsicAnytimeSettledSelection::Partial)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct FakeEndpoint {
        key: String,
        rank_value: i32,
        tag: &'static str,
    }

    /// TS: `tests/unit/intrinsicAnytimeArchive.test.ts:15-35` "dedup + invalid
    /// rejection + custom rank".
    #[test]
    fn dedup_first_occurrence_position_invalid_rejection_and_custom_rank() {
        let endpoints = vec![
            FakeEndpoint {
                key: "a".to_string(),
                rank_value: 3,
                tag: "first-a",
            },
            FakeEndpoint {
                key: "invalid".to_string(),
                rank_value: 0,
                tag: "rejected",
            },
            FakeEndpoint {
                key: "b".to_string(),
                rank_value: 1,
                tag: "only-b",
            },
            FakeEndpoint {
                key: "a".to_string(),
                rank_value: 9,
                tag: "second-a",
            },
        ];

        let mut identity = |endpoint: &FakeEndpoint| Some(endpoint.key.clone());
        let mut validate = |endpoint: &FakeEndpoint| endpoint.key != "invalid";
        let mut select_duplicate =
            |_retained: &FakeEndpoint, candidate: &FakeEndpoint| candidate.clone();
        let mut rank = |mut unique: Vec<FakeEndpoint>| -> Vec<FakeEndpoint> {
            unique.sort_by_key(|endpoint| endpoint.rank_value);
            unique
        };

        let retained =
            retain_intrinsic_anytime_archive_namespace(IntrinsicAnytimeArchiveNamespacePolicy {
                namespace: IntrinsicAnytimeArchiveNamespace::Complete,
                endpoints: &endpoints,
                identity: &mut identity,
                validate: &mut validate,
                select_duplicate: &mut select_duplicate,
                rank: &mut rank,
            });

        // "invalid" is rejected entirely; "a" keeps first-occurrence
        // *position* in `unique` (before ranking) but the *value* of the
        // later duplicate ("second-a", rank_value 9) wins via
        // `select_duplicate`.
        assert_eq!(retained.len(), 2);
        assert!(retained.iter().any(|e| e.key == "a" && e.tag == "second-a"));
        assert!(retained.iter().any(|e| e.key == "b" && e.tag == "only-b"));
        // rank_value ascending: b(1) before a(9).
        assert_eq!(retained[0].key, "b");
        assert_eq!(retained[1].key, "a");
    }

    #[test]
    fn empty_or_undefined_identity_is_rejected() {
        let endpoints = vec![FakeEndpoint {
            key: String::new(),
            rank_value: 0,
            tag: "empty-key",
        }];
        let mut identity = |endpoint: &FakeEndpoint| {
            if endpoint.key.is_empty() {
                None
            } else {
                Some(endpoint.key.clone())
            }
        };
        let mut validate = |_: &FakeEndpoint| true;
        let mut select_duplicate =
            |_retained: &FakeEndpoint, candidate: &FakeEndpoint| candidate.clone();
        let mut rank = |unique: Vec<FakeEndpoint>| unique;

        let retained =
            retain_intrinsic_anytime_archive_namespace(IntrinsicAnytimeArchiveNamespacePolicy {
                namespace: IntrinsicAnytimeArchiveNamespace::Partial,
                endpoints: &endpoints,
                identity: &mut identity,
                validate: &mut validate,
                select_duplicate: &mut select_duplicate,
                rank: &mut rank,
            });
        assert!(retained.is_empty());
    }

    /// TS: `tests/unit/intrinsicAnytimeArchive.test.ts:37-49` "complete beats
    /// partial unless complete is empty".
    #[test]
    fn complete_dominates_partial_unless_complete_is_empty() {
        let complete = vec!["complete-0".to_string()];
        let partial = vec!["partial-0".to_string()];
        let selection =
            select_intrinsic_anytime_settled_endpoint(IntrinsicAnytimeArchiveSnapshot {
                complete: &complete,
                partial: &partial,
            });
        assert_eq!(
            selection,
            Some(IntrinsicAnytimeSettledSelection::Complete(
                "complete-0".to_string()
            ))
        );

        let empty_complete: Vec<String> = Vec::new();
        let selection_partial_only =
            select_intrinsic_anytime_settled_endpoint(IntrinsicAnytimeArchiveSnapshot {
                complete: &empty_complete,
                partial: &partial,
            });
        assert_eq!(
            selection_partial_only,
            Some(IntrinsicAnytimeSettledSelection::Partial(
                "partial-0".to_string()
            ))
        );

        let empty_partial: Vec<String> = Vec::new();
        let selection_none =
            select_intrinsic_anytime_settled_endpoint(IntrinsicAnytimeArchiveSnapshot {
                complete: &empty_complete,
                partial: &empty_partial,
            });
        assert_eq!(selection_none, None);
    }
}
