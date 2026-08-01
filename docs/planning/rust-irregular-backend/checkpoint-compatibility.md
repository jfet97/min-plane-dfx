# Checkpoint Compatibility Design — Rust Irregular Nesting Backend

Status: Stage 0 design document, per the governing migration prompt
(`docs/history/prompts/fable5-rust-irregular-nesting-implementation.md`, §11, §22
item 6). This document specifies **how** the Rust port must reproduce the
TypeScript resumable-checkpoint contract; it does not authorize any
behavior change. Every rule below is grounded in current source
(`src/workers/algorithm/irregular/intrinsicCapacitySearch.ts`,
`intrinsicStrictDecoder.ts`, `intrinsicPlaceDeferCompleteShadow.ts`) and in
the exhaustive characterization already performed in
`docs/planning/rust-irregular-backend/characterization/checkpoint-encoding.md`
(the primary source for this document — cited throughout as
"checkpoint-encoding.md §N") and
`docs/planning/rust-irregular-backend/characterization/capacity-search.md`
(cited as "capacity-search.md §N"), with a small number of new findings from
direct source re-verification called out explicitly (§6.4). Per the task
framing, this document treats the TypeScript behavior as the specification,
including the deliberate divergences between the three checkpoint encoders.

This document intentionally does not re-derive every field-by-field
validation branch already exhaustively enumerated in
`checkpoint-encoding.md` §3, §8, §11 and `strict-decoder-gap-family.md`
§3.6, §9–§11; it cross-references those sections and focuses on the design
questions the task asked to be answered: encoding rules as a Rust
implementation contract, hash/fingerprint algorithms as ported pseudocode,
version strings, the clock-seam inventory, and the four families of tests
(deterministic-clock differential, production-clock, resume-equivalence,
corruption-rejection) plus the cross-backend acceptance policy.

---

## 1. The three checkpoint producers (inventory)

There are exactly three genuine resumable-checkpoint types in the current
TypeScript source, plus one non-checkpoint sibling encoder cited only for
contrast. All four are structurally independent — no shared base type, no
shared encoder, no shared canonical-JSON module (checkpoint-encoding.md
§3.4, §8, §15 item 1; independently confirmed by direct re-reading of
`intrinsicCapacitySearch.ts:1173-1635`,
`intrinsicStrictDecoder.ts:868-1277`, and the full 465-line
`intrinsicPlaceDeferCompleteShadow.ts`, reproduced verbatim above in this
task's working notes).

| # | Type | Version string | File | Live in production? | Has `integrityHash`? |
|---|---|---|---|---|---|
| 1 | `IntrinsicAnytimeCheckpoint` | `intrinsic-anytime-checkpoint-v3` | `intrinsicCapacitySearch.ts:154-172` | **Yes** — cold-quantum pause interleaved with the canonical-grid direct role on every archive-eligible request (checkpoint-encoding.md §1.3) | Yes (`intrinsicCapacityCheckpointIntegrityHash`, `:1503-1569`) |
| 2 | `IntrinsicStrictDirectCheckpoint` | `intrinsic-strict-direct-checkpoint-v1` | `intrinsicStrictDecoder.ts:185-197` | **Yes** — `'canonical-grid'` direct role only, paused after every committed piece in production (`canonicalGridCompletedPieceQuantum: 1`, `computeIrregularNesting.ts:649`) | Yes (`intrinsicStrictDirectCheckpointIntegrityHash`, `:1058-1078`) |
| 3 | `IntrinsicPlaceDeferCheckpoint` | `intrinsic-place-defer-checkpoint-v1` | `intrinsicPlaceDeferCompleteShadow.ts:31-75` | **No** — reachable only via `captureExperimentalPlaceDeferCompleteShadow: true`, set by exactly two test call sites, never a production preset (checkpoint-encoding.md §1.3) | **No** — field-by-field re-derivation instead (`validatePlaceDeferCheckpoint`, `:335-438`) |
| — | (not a checkpoint) source-audit digest builder | n/a | `intrinsicPeriodicFamilyPortfolio.ts:1285-1293` | n/a — no `version`/`integrityHash`/resumable-state fields | n/a — cited only in §2.5 for contrast; fully owned by `periodic.md` |

A Rust port must implement **three separate Rust types and three separate,
byte-verified encoders**, never a generic `struct AnytimeCheckpoint<Role>`
(checkpoint-encoding.md §3.4, §15 item 1). Priority for Stage 2 exact
parity is producers 1 and 2 (both live); producer 3 is required only if the
orchestrator decides the Rust port must also pass the two existing test
files that exercise `captureExperimentalPlaceDeferCompleteShadow` under
backend parameterization (§10, §14).

**Critical scope-of-truth clarification (checkpoint-encoding.md §8.0,
independently reconfirmed):** no checkpoint of any of the three types is
ever serialized to a byte string, written to disk, or crosses a Node
worker/process boundary in production. All three producers pass live,
in-process object references (holding a live `IrregularBeamState`
instance by reference — checkpoint-encoding.md §2, §12 item 1) between
pause and resume within a single `computeIrregularNesting` execution. The
`canonicalJson`/`intrinsicStrictCanonicalJson`/raw-`JSON.stringify`
encoders exist **solely to build SHA-256 hash preimages** — a tamper/
consistency-evidence mechanism, not a wire format. This has a direct
consequence for the Rust design (§9, §12): a Rust `IntrinsicAnytimeCheckpoint`-
equivalent type's primary purpose is in-process pause/resume of an owned
(or `Arc`-shared, if proven Rayon-safe) live search-state graph; `derive(Serialize)`
round-trip fidelity for the *whole struct* is not required, only (a) an
exact reproduction of each hash-preimage string builder and (b) correct
Rust ownership semantics for the live state hand-off.

---

## 2. Canonical JSON encoding rules

### 2.1 Why there are two encoders that matter for Rust parity (not four)

Source has four textually-similar `canonicalJson`-shaped functions
(checkpoint-encoding.md §8, js-semantics-audit.md line 843-844's summary
table). Only two are checkpoint-relevant for a Rust port:

- **Encoder A** — `canonicalJson`, `intrinsicCapacitySearch.ts:1626-1635`.
  Feeds `intrinsicCapacityCheckpointIntegrityHash` and
  `intrinsicCapacityRequestFingerprint` (producer 1).
- **Encoder B** — `intrinsicStrictCanonicalJson`,
  `intrinsicStrictDecoder.ts:1257-1277`. Feeds
  `intrinsicStrictDirectCheckpointIntegrityHash` and
  `intrinsicStrictDirectRequestFingerprint` (producer 2).
- **Encoder D** — raw `JSON.stringify` with a bigint replacer,
  `intrinsicPlaceDeferCompleteShadow.ts:440-453`. Feeds only
  `intrinsicPlaceDeferFingerprint` (producer 3; producer 3 has no
  `integrityHash`).
- Encoder C (`intrinsicPeriodicFamilyPortfolio.ts:1285-1293`) is **not** a
  checkpoint encoder and is out of this document's scope; it belongs to
  `periodic.md`. It is cited below only where its divergence illustrates
  why unification is unsafe.

A Rust port must implement Encoder A and Encoder B as **two independently
named functions** (or one function parameterized by an explicit key
comparator, proven equivalent per call site by a byte-level differential
test — see §2.4), and Encoder D as a **third, structurally different**
function that does not sort keys at all. Do not build one shared "canonical
JSON" module that all three checkpoint/fingerprint call sites share without
per-call-site differential proof (checkpoint-encoding.md §8.2, §12 item 2).

### 2.2 Shared primitive-encoding rules (apply to Encoders A and B identically)

Both `canonicalJson` and `intrinsicStrictCanonicalJson` share this recursive
algorithm (`intrinsicCapacitySearch.ts:1626-1635`,
`intrinsicStrictDecoder.ts:1257-1277`, read in full and confirmed
byte-identical in structure except for the two divergences in §2.3/§2.4):

```
encode(value):
  if typeof value === 'bigint':      return '"' + value.toString() + '"'   # quoted base-10, no exponent, sign preserved
  if value === null or not object:   return JSON.stringify(value)          # see "primitive encoding" below
  if Array.isArray(value):           return '[' + value.map(encode).join(',') + ']'   # order preserved, never sorted
  # object (including a JS Map for Encoder B only, see §2.3)
  fields = Object.entries(value).filter(([, v]) => v !== undefined)
  fields = fields.toSorted(keyComparator)   # ordinal for A, localeCompare for B
  return '{' + fields.map(([k, v]) => JSON.stringify(k) + ':' + encode(v)).join(',') + '}'
```

**Primitive encoding** (`JSON.stringify` on `number | string | boolean |
null`), verified directly (`node -e`, checkpoint-encoding.md §7):

- `number`: ECMA-262 `Number::toString` shortest-round-trip decimal
  rendering (e.g. `0.1` → `"0.1"`, not `"0.1000000000000000055511151231257827021181583404541015625"`).
  `-0` and `+0` both render as the single ASCII byte `0` (signed zero is
  **not** distinguishable in the byte stream). `NaN`, `Infinity`,
  `-Infinity` all render as the literal 4-byte token `null`.
- `string`: escape `"` → `\"`, `\` → `\\`, and control characters
  `U+0000`–`U+001F` (using the short forms `\b \t \n \f \r` where they
  apply, else `\u00XX` lowercase hex); **everything else, including all
  non-ASCII code points, is passed through literally as UTF-8 bytes** — no
  `\uXXXX` escaping of ordinary Unicode text, and no escaping of `U+2028`/
  `U+2029` (that escaping only matters for `<script>`-embedding safety, not
  for `JSON.stringify` itself).
- `boolean`: `true` / `false` literally.
- `null` (reached directly, not via `undefined`-filtering): `null`.
- `undefined` reached as an **object field value** is filtered out before
  the key is even emitted (see the `.filter` step above) — the key is
  **omitted**, not rendered as `null`. `undefined` reached as a bare
  top-level value or **array element** renders as the literal token `null`
  (native `JSON.stringify(undefined)` inside an array context — this case
  does not currently arise in any of the three checkpoint types' fields,
  since no array field ever legitimately holds an `undefined` element, but
  a Rust encoder function must still define this branch correctly rather
  than treat it as unreachable, to avoid a silent divergence if a future
  field introduces it).

**Object-key filter + sort**: `Object.entries(value)` first drops
`undefined`-valued entries, then sorts the remaining `[key, value]` pairs.
This means: (a) a TS interface field declared with `T | undefined` and no
`?:` (e.g. `incumbentBinding`, `phaseLedger` — checkpoint-encoding.md §3.1,
§3.2) is **always structurally present on the live object** but is still
**omitted from the hash bytes** when its value is `undefined`; (b) a Rust
port must model every such field as `Option<T>` and have its own encoder
skip the key on `None` — never serialize `null` for these fields, and never
rely on `serde_json`'s default behavior, which does not implement this
filter unless `#[serde(skip_serializing_if = "Option::is_none")]` is
applied explicitly and the struct field order is separately proven correct
(checkpoint-encoding.md §7 item on `JSON.stringify({a: undefined, b: 1})`,
§12 item 3).

**No `Map` value reaches Encoder A's object branch today** — if one did, it
would silently encode as `{}` (checkpoint-encoding.md §8.1). A Rust port's
Encoder A equivalent must be **typed to reject a map-shaped input at
compile time** (no generic "any value" entry point covering the checkpoint
fields) rather than replicate the silent-`{}` behavior, since no field
listed in §3 below is ever map-typed for this producer.

### 2.3 Encoder-specific divergence: key comparator and `Map` handling

| | Encoder A (capacity) | Encoder B (strict-direct) |
|---|---|---|
| Object key sort | **Ordinal** `compareStrings` (`intrinsicCapacitySearch.ts:2233-2237`: plain `<`/`>`, i.e. UTF-16-code-unit-wise) | **`localeCompare`** (`firstKey.localeCompare(secondKey)`, `intrinsicStrictDecoder.ts:1271`) — ICU-collation-dependent, confirmed to diverge from ordinal for mixed-case ASCII (`'a'.localeCompare('B') === -1` vs. `'a' < 'B' === false`, checkpoint-encoding.md §6) |
| `Map` value handling | **None** — falls through to the generic object branch, silently encodes as `{}` (unreachable today, §2.2) | **Explicit**: `value instanceof Map` → sort entries by `String(key).localeCompare(String(otherKey))`, recurse into the sorted `[key, value]` pair array (`intrinsicStrictDecoder.ts:1264-1266`) — also unreachable for checkpoint hashing today (no field in producer 2's hash preimage is `Map`-typed), but the function itself is shared with non-checkpoint uses elsewhere in the file and must still be ported correctly |

**Rust replication requirement for `compareStrings` (Encoder A)**: plain
`str::cmp` (Rust's `Ord` for `&str`, which compares by Unicode scalar
value / UTF-8 byte order for valid strings) is **not automatically
equivalent** to JS `<`/`>` (UTF-16 code-unit order) for strings containing
supplementary-plane characters (code points above `U+FFFF`, represented as
a surrogate pair in UTF-16). For the fixed, hand-written, all-ASCII field
names Encoder A actually sorts (`"version"`, `"requestFingerprint"`, …),
this divergence never triggers, so plain `str::cmp` is safe **for the
checkpoint's own field-name sort**. It is **not** proven safe for
`intrinsicCapacityRequestFingerprint`'s `material` sort by `pieceId`
(`:1582`, sorts arbitrary piece-ID strings with the same `compareStrings`)
or `intrinsicCapacitySuccessorIdentity`'s placement-order snapshot sort
(`:1665`) if piece IDs are ever adversarially constructed with
supplementary-plane characters — flagged as an open item (§11) requiring
either a proof that piece-ID generation never emits such characters, or a
UTF-16-code-unit-aware comparator for those two specific sort sites (not
needed for the checkpoint object-key sort itself).

**Rust replication requirement for `localeCompare` (Encoder B)**: the
practical exposure is limited to the same small, fixed, hand-written,
all-ASCII key-name set (`"pendingIds"`, `"placedIds"`, `"cavities"`,
`"anchoredOccupiedKey"`, …), which is *believed but not proven* to sort
identically under ordinal and locale-aware comparison (checkpoint-encoding.md
§6, §8.2, §12 item 6). This document does not resolve which of the two
implementation strategies below to use — that decision is an orchestrator
ruling (§11 OQ-1):

- **(a) Full collation fidelity**: pull in an ICU4X-based collation crate
  (e.g. `icu_collator`) configured to match Node's default (root/`en-US`-like)
  locale, and use it for Encoder B/D's key sort unconditionally. Highest
  fidelity, highest dependency/complexity cost for a code path whose only
  currently-reachable inputs are a closed set of ASCII identifiers.
- **(b) Pinned-equivalence proof**: enumerate every literal key string any
  field of `IntrinsicStrictDirectCheckpoint` (recursively, including nested
  `IntrinsicStrictStepTrace`, `IntrinsicStrictGapFillEvidence`,
  `IntrinsicStrictDirectPhaseLedger`, `IrregularBeamState` lineage
  projection fields per checkpoint-encoding.md §8.4) can ever contribute to
  this sort, sort that fixed list both ways in Node (`localeCompare`) and
  in Rust (`str::cmp`), assert byte-identical ordering as a pinned CI test,
  implement the Rust encoder with plain ordinal `str::cmp`, and add a
  runtime `debug_assert!`/typed-error guard that fires if the encoder is
  ever asked to sort a key outside the closed pinned set (to prevent silent
  future divergence if a field is added later). Lower dependency cost;
  requires disciplined maintenance of the pinned key list whenever a
  checkpoint-adjacent struct gains a field.

### 2.4 Encoder D (place-defer) — structurally different, no sort at all

```ts
JSON.stringify(
  { version, sheet: { width, height }, preparedPieces },
  (_key, value) => (typeof value === 'bigint' ? value.toString() : value)
)
```
(`intrinsicPlaceDeferCompleteShadow.ts:440-453`)

- **No explicit key sort** — relies on native `JSON.stringify`'s own
  property-enumeration order, which is **insertion order** for string keys
  (deterministic per object, fixed by the object literal's declared field
  order for this specific call site — `version`, `sheet`, `preparedPieces`
  — and, recursively, by each nested domain class's own constructor-assigned
  property order for `preparedPieces`' elements).
- The bigint replacer converts a bigint to its decimal-string form **before**
  `JSON.stringify`'s own serialization step runs, so the net encoded token
  (a quoted decimal string) is byte-identical to Encoders A/B's bigint
  branch for the same value, despite the different mechanism
  (checkpoint-encoding.md §7, §8.5).
- A Rust port's equivalent function must declare its input struct's fields
  in the **exact same order** as the TS object literal / class constructors
  would produce, and must **not** sort them — this is the one encoder where
  "declare Rust struct fields in the same order as the JS source" is itself
  the correctness requirement, not an incidental convenience
  (checkpoint-encoding.md §12 item 3).
- This is also the **widest, most change-exposed** fingerprint: it hashes
  the whole, unprojected `preparedPieces` array (every own-enumerable
  property of every `IrregularPreparedPiece`, including nested
  `collisionGeometry`/`transforms`), so any unrelated future field added to
  that domain class changes this hash. A Rust port must replicate this
  exposure faithfully (do not "improve" it into a curated projection);
  see §4.3.

### 2.5 Number-formatting and string-escaping implementation requirements

The crate already pins `ryu-js = "1"` in
`crates/irregular-nesting-native/Cargo.toml` (Stage 1 scaffold), which
implements ECMA-262 `Number::toString` shortest-round-trip formatting — use
it for every `number`-typed field these encoders touch. The encoder's
number branch must be:

```rust
fn encode_number(n: f64) -> String {
    if !n.is_finite() { return "null".to_string() }   // NaN / +Inf / -Inf -> JSON null, never error/panic
    if n == 0.0 { return "0".to_string() }             // -0.0 and 0.0 both render as "0"
    ryu_js::to_string(n)                                // shortest-round-trip decimal, matches V8's Number::toString
}
```
Per checkpoint-encoding.md §7: no field in a valid checkpoint is ever
expected to hold a non-finite value at encode time (this is enforced during
*validation*, not by the encoder), but the encoder itself must not
panic/error on one — it must silently produce `"null"`, matching
`JSON.stringify`'s behavior, because adversarial/corrupted-input
differential tests (§9) exercise exactly this path.

String encoding must implement the exact escape table in §2.2 — a plain
Rust `String` cannot hold an unpaired UTF-16 surrogate, so any upstream
string data that originated from a JS string with a lone surrogate must
already have been normalized (e.g. via replacement-character substitution)
**before** it becomes a Rust `String`, at the N-API boundary conversion
layer (`crates/irregular-nesting-native/src/boundary`), not inside the
canonical-JSON encoder itself (checkpoint-encoding.md §12 item 8). This is
a boundary-layer requirement, not a checkpoint-module requirement, but is
recorded here because it is load-bearing for byte-identical hashes if any
piece ID or label string is ever adversarially malformed upstream.

**Verify, do not assume**, that `serde_json`'s escaping (if ever used as a
component, e.g. for the string-primitive branch only) does not additionally
escape non-ASCII by default — `serde_json` does not escape non-ASCII unless
a non-default feature/writer is used, but this must be pinned by a
differential byte test against real Node `JSON.stringify` output for a
representative Unicode string set (§9), not assumed from documentation.

### 2.6 BigInt handling

`bigint`-typed TS fields (`placedDoubledMaterialAreaGrid2` in all three
checkpoint types) must map to a Rust arbitrary-precision signed integer
type — `num_bigint::BigInt` (already a pinned dependency). Encoding:
`format!("\"{}\"", value.to_string())` — `num_bigint::BigInt`'s `Display`
produces the same base-10, no-leading-zeros, sign-prefixed decimal string as
JS `BigInt.prototype.toString()`. **Distinguish this from fields that are
already TS `string`-typed decimal encodings of a bigint** (e.g.
`IntrinsicCapacityCavityMetrics.totalDoubledAreaGrid2: string`,
`IntrinsicCapacityEndpointMetrics.envelopeAreaGrid2: string` — see
`intrinsicCapacityEndpoint.ts:75-79`, `:17-30`) — those fields are **plain
strings** on the TS side and must map to plain Rust `String` fields encoded
via the ordinary string branch (§2.2), **not** re-parsed into a `BigInt`
and re-encoded through the bigint branch. Both mechanisms happen to render
the same *visual* decimal-string bytes for a given value, but they are
different TS types and a Rust struct that conflates them (e.g. by using
`BigInt` for both) would still produce correct bytes today only by
coincidence — model the field types exactly as declared in TS, not by
"what renders the same."

---

## 3. Checkpoint type definitions (Rust struct design)

Module: `crates/irregular-nesting-native/src/checkpoints/` (already
scaffolded with a `mod.rs` stub per the Stage 1 crate skeleton). Proposed
file layout:

```
checkpoints/
  mod.rs                 # re-exports; module-level TS-counterpart doc comment (already present)
  canonical_json.rs       # JsonValue enum + encode_ordinal / encode_locale / encode_js_insertion_order
  clock.rs                 # DeterministicClock trait + injectable clock plumbing (see §6)
  capacity.rs               # IntrinsicAnytimeCheckpoint + make/validate/hash/fingerprint (producer 1)
  strict_direct.rs           # IntrinsicStrictDirectCheckpoint + make/validate/hash/fingerprint (producer 2)
  place_defer.rs               # IntrinsicPlaceDeferCheckpoint + make/validate/fingerprint (producer 3, no integrity hash)
```

### 3.1 `canonical_json.rs` — shared value model

```rust
/// A minimal JSON value model sufficient to reproduce the four TS
/// hash-preimage encoders byte-for-byte. Not a general-purpose JSON library;
/// do not use serde_json::Value here (migration prompt §7 boundary rule
/// generalizes to internal hash-preimage models too — an untyped `Value`
/// makes it too easy to accidentally rely on serde_json's own key-ordering
/// or escaping defaults instead of the ported ones).
pub enum JsonValue {
    Null,
    Bool(bool),
    Number(f64),
    /// Pre-decimal-stringified BigInt, e.g. num_bigint::BigInt::to_string().
    BigIntDecimal(String),
    Str(String),
    Array(Vec<JsonValue>),
    /// Field order as pushed; `encode_ordinal`/`encode_locale` re-sort by
    /// key, `encode_js_insertion_order` (Encoder D) never sorts — the
    /// caller decides which encode_* function to use, this type stays
    /// encoder-agnostic.
    Object(Vec<(String, JsonValue)>),
}

pub fn encode_ordinal(value: &JsonValue) -> String { /* Encoder A */ }
pub fn encode_locale(value: &JsonValue) -> String { /* Encoder B */ }
pub fn encode_js_insertion_order(value: &JsonValue) -> String { /* Encoder D primitive-encoding reuse only; caller supplies pre-ordered Object fields */ }
```

Each checkpoint module's own hash/fingerprint function builds a
`JsonValue::Object` **projection** of exactly the fields the TS source
hashes (§4), not a generic `Serialize` derive over the whole Rust struct —
this mirrors the TS source's own "curated projection object, not
`canonicalJson(wholeCheckpoint)`" pattern (checkpoint-encoding.md §8.4).

### 3.2 `capacity.rs` — producer 1 (`IntrinsicAnytimeCheckpoint`)

Field-for-field Rust mapping (source: `intrinsicCapacitySearch.ts:60-172`,
verified directly against current source, not merely the characterization
doc):

```rust
pub const INTRINSIC_ANYTIME_CHECKPOINT_VERSION: &str = "intrinsic-anytime-checkpoint-v3";

/// 6-member union (checkpoint-encoding.md §3.1 states "7-member union" —
/// this is a miscount in that document; current source
/// (intrinsicCapacitySearch.ts:64-69) declares exactly 6 members. A Rust
/// enum should still include all 6 for type-level parity with cross-file
/// comparisons even though this file's own `make_capacity_checkpoint` only
/// ever constructs 4 of them (CapacityCold, CapacityCohesionShadow,
/// CapacityQualityWarmPrefix, CapacityWarmPrefix).
pub enum IntrinsicAnytimeProducerRole {
    CapacityCold,
    CapacityCohesionShadow,
    CapacityQualityWarmPrefix,
    CapacityWarmPrefix,
    LegacyComplete,                   // never constructed here; exists for shared vocabulary
    ExperimentalPlaceDeferComplete,   // never constructed here; exists for shared vocabulary
}

pub enum IntrinsicAnytimeArchiveCohort { Complete, Partial, ExperimentalComplete }
pub enum IntrinsicAnytimeEligibility { CompleteEligible, SubsetOnly }

pub struct IntrinsicAnytimeFitMask { pub q0: bool, pub q90: bool }

pub struct IntrinsicAnytimeDecisionState {
    pub state: Arc<IrregularBeamState>,             // live state, §9
    pub continuation_metadata_identity: String,
    pub eligibility: IntrinsicAnytimeEligibility,
    pub placed_prepared_ids: Vec<PieceId>,
    pub pending_prepared_ids: Vec<PieceId>,
    pub deferred_prepared_ids: Vec<PieceId>,        // always empty for this producer
    pub permanently_skipped_prepared_ids: Vec<PieceId>,
    pub pending_order: Vec<PieceId>,                // duplicate of pending_prepared_ids by construction
    pub cursor: i64,                                 // always == next_depth
    pub pass: i32,                                   // always 0
    pub deferral_counts: Vec<(String, i64)>,        // always empty; ordered Vec, not HashMap (never iterated for hashing here but keep contractual-order discipline)
    pub placed_doubled_material_area_grid2: BigInt,
    pub cavities: IntrinsicCapacityCavityMetrics,
    pub anchored_occupied_key: String,
    pub grid_span: IntrinsicCapacityGridSpan,
    pub fit_mask: IntrinsicAnytimeFitMask,
}

pub struct IntrinsicAnytimeDepthBudgetLedger {
    pub depth: i64,
    pub consumed_placement_evaluations: i64,
    pub quota_exhausted: bool,
}

pub struct IntrinsicAnytimeBudgetLedgers {
    pub total_placement_evaluation_cap: i64,
    pub total_consumed_placement_evaluations: i64,
    pub per_depth: Vec<IntrinsicAnytimeDepthBudgetLedger>,
    pub per_cohort_complete: i64,             // always 0 for this producer
    pub per_cohort_partial: i64,               // == total_consumed_placement_evaluations
    pub per_cohort_experimental_complete: i64, // always 0 for this producer
}

pub struct IntrinsicAnytimeNoSkipFrontierState {
    pub present: bool,
    pub first_loss_depth: Option<i64>,
}

pub struct IntrinsicAnytimeIncumbentBinding {
    pub canonical_geometry_hash: String,
    pub placed_count: i64,
    pub placed_doubled_material_area_grid2: BigInt,
    pub origin: IntrinsicCapacityEndpointOrigin,
    pub selected_rotation_deg: RotationDeg,   // 0 | 90 closed enum, not a raw i32
}

pub struct IntrinsicCapacitySearchCounters {   // 8 non-negative-safe-integer fields, i64 with runtime range check
    pub pruned_by_attainable_count: i64,
    pub pruned_by_attainable_material: i64,
    pub deduplicated_successors: i64,
    pub fit_rejected_candidates: i64,
    pub invalid_candidates: i64,
    pub endpoint_fit_rejections: i64,
    pub completed_depths: i64,
    pub depth_quota_exhaustions: i64,
}

pub struct IntrinsicCapacityTopologyRetentionDepthTrace {
    pub depth: i64,
    pub piece_id: PieceId,
    pub measured_survivor_count: i64,
    pub retained_count: i64,
    pub best_accounting_stratum_count: i64,
    pub topology_measurement_count: i64,
    pub topology_measurement_ms: f64,     // WALL-CLOCK — see §6.4, the new finding
    pub legal_candidate_count: i64,
    pub contact_measured_candidate_count: i64,
    pub positive_contact_candidate_count: i64,
    pub contact_measurement_ms: f64,       // WALL-CLOCK — see §6.4
    pub contact_selected_successor_count: i64,
    pub contact_deduplicated_successor_count: i64,
    pub contact_retained_successor_count: i64,
    pub representatives: Vec<IntrinsicCapacityTopologyRepresentative>,
}

pub struct IntrinsicAnytimeCheckpoint {
    pub version: &'static str,                                 // == INTRINSIC_ANYTIME_CHECKPOINT_VERSION
    pub request_fingerprint: String,
    pub producer_role: IntrinsicAnytimeProducerRole,
    pub archive_cohort: IntrinsicAnytimeArchiveCohort,          // makeIntrinsicCapacityCheckpoint always sets 'partial'
    pub search_bounds: IntrinsicCapacityV1Bounds,               // fixed 4-field constant, always the same literal
    pub incumbent_binding: Option<IntrinsicAnytimeIncumbentBinding>,
    pub frontier: Vec<IntrinsicAnytimeDecisionState>,           // beam order — never reordered by the checkpoint layer
    pub next_depth: i64,
    pub depth_boundary_resume_position: i64,                    // always == next_depth for this producer
    pub budget_ledgers: IntrinsicAnytimeBudgetLedgers,
    pub scheduler_deficit: i64,
    pub settlement: Settlement,                                  // literal-only Active for a checkpoint
    pub censoring: Censoring,                                    // literal-only None for a checkpoint
    pub no_skip_frontier: IntrinsicAnytimeNoSkipFrontierState,
    pub counters: IntrinsicCapacitySearchCounters,
    pub topology_retention_depths: Vec<IntrinsicCapacityTopologyRetentionDepthTrace>, // always an array, never Option (contrast: the trace type omits when empty)
    pub integrity_hash: String,
}
```

`IntrinsicCapacityV1Bounds` (`beam_width: 16, local_legal_placement_fanout:
3, minimum_placement_evaluation_cap: 50_000,
placement_evaluation_quota_per_depth: 4_096` — per
`intrinsicCapacitySearch.ts:52-57`) must be a Rust constant, not a
per-instance struct read from config, exactly mirroring the TS `as const`
object literal.

### 3.3 `strict_direct.rs` — producer 2 (`IntrinsicStrictDirectCheckpoint`)

```rust
pub const INTRINSIC_STRICT_DIRECT_CHECKPOINT_VERSION: &str = "intrinsic-strict-direct-checkpoint-v1";

pub struct IntrinsicStrictStepTrace {
    pub piece_id: PieceId,
    pub candidate_count: i64,
    pub transform_family_count: i64,
    pub selected_transform_family: Option<String>,
    pub selected_score: Option<IntrinsicStrictLocalScore>,
}

pub struct IntrinsicStrictGapFillEvidence {
    pub piece_id: PieceId,
    pub region_key: String,
    pub region_area_before_mm2: f64,
    pub region_area_after_mm2: f64,
    pub envelope_maximum_side_delta_mm: f64,
    pub envelope_area_delta_mm2: f64,
    pub shared_boundary_length_mm: f64,
    pub non_inert: bool,
}

pub struct IntrinsicStrictDirectPhaseLedger {
    pub candidate_generation_ms: f64,          // WALL-CLOCK, seamed via timingNow (§6.3)
    pub candidate_state_scoring_ms: f64,        // WALL-CLOCK, seamed via timingNow (§6.3)
    pub candidate_state: MutableCandidateStatePhaseTimings, // further nested wall-clock buckets, all seamed
}

pub struct IntrinsicStrictDirectCheckpoint {
    pub version: &'static str,
    /// NOT a closed enum on the TS side (`producerRole: string`) — production
    /// call sites use one of 3 literals, but the type places no compile-time
    /// constraint. Keep as an owned `String` unless every historical caller
    /// (including intrinsicReconstructionPortfolio.ts and
    /// intrinsicPeriodicFamilyPortfolio.ts, per
    /// strict-decoder-gap-family.md §3.1) is audited and a closed enum is
    /// proven exhaustive — do not narrow speculatively.
    pub producer_role: String,
    pub request_fingerprint: String,
    pub integrity_hash: String,
    pub state: Arc<IrregularBeamState>,
    pub next_piece_index: i64,
    pub step_trace: Vec<IntrinsicStrictStepTrace>,     // length must equal next_piece_index (validated on resume)
    pub gap_fill_evidence: Vec<IntrinsicStrictGapFillEvidence>,
    pub candidate_evaluation_count: i64,
    pub active_runtime_ms: f64,                         // accumulates across resumes: prev + max(0, timingNow() - startedAt)
    pub phase_ledger: Option<IntrinsicStrictDirectPhaseLedger>, // present iff capturePhaseTimings was true when produced
}
```

### 3.4 `place_defer.rs` — producer 3 (`IntrinsicPlaceDeferCheckpoint`, non-authoritative shadow)

```rust
pub const INTRINSIC_PLACE_DEFER_CHECKPOINT_VERSION: &str = "intrinsic-place-defer-checkpoint-v1";
pub const INTRINSIC_PLACE_DEFER_EVALUATION_CAP: i64 = 19_862;
pub const INTRINSIC_PLACE_DEFER_RUNTIME_CAP_MS: f64 = 35_000.0;

pub struct IntrinsicPlaceDeferCheckpoint {
    pub version: &'static str,
    pub request_fingerprint: String,
    // producer_role, archive_cohort, eligibility are single-literal unions on
    // the TS side (not open enums like producer 2's producer_role) — model
    // as unit structs or a 1-variant enum only if it materially helps
    // readability; a plain constant string is also acceptable since no
    // other value is ever legal.
    pub state: Arc<IrregularBeamState>,
    pub placed_prepared_ids: Vec<PieceId>,       // always [] at construction
    pub pending_prepared_ids: Vec<PieceId>,
    pub deferred_prepared_ids: Vec<PieceId>,     // 0 or 1 entries
    pub permanently_skipped_prepared_ids: Vec<PieceId>, // always []
    pub pending_order: Vec<PieceId>,
    pub cursor: i64,                              // always 0 — literal-1-only maximumDecisionBoundaries means no generalized resume position exists
    pub pass: i32,                                 // always 0
    pub deferral_counts: Vec<(String, i64)>,      // 0 or 1 entries, value always 1
    pub depth_boundary_resume_position: i64,       // always 0
    pub placed_doubled_material_area_grid2: BigInt, // always 0
    pub enclosed_cavity_count: i64,                // always 0
    pub total_enclosed_cavity_area_mm2: f64,        // always 0
    pub anchored_occupied_identity: String,
    pub fit_mask: IntrinsicAnytimeFitMask,          // always {true, true}
    pub budget_ledgers: IntrinsicAnytimeBudgetLedgers, // all zero at this boundary
    pub scheduler_deficit: i64,                      // always 1
    // settlement, censoring: same literal-only pattern as producer 1
    // no_skip_frontier.present: literal `true` type on TS side, not `bool`
}
```

No `integrity_hash` field — corruption detection for this type is entirely
`validate_place_defer_checkpoint`'s ~15 field-by-field equality checks
against a freshly-recomputed expected state (§8, §10.4), not a
hash-comparison, and this asymmetry is deliberate (checkpoint-encoding.md
§3.3) — do not add an integrity hash to the Rust port's version of this
type "for consistency."

---

## 4. Integrity hash and fingerprint computation

Every hash/fingerprint function is `sha256(hash_preimage_string)` rendered
as lower-case hex (`createHash('sha256').update(str).digest('hex')` — Rust:
`sha2::Sha256`, already a pinned dependency, `.finalize()` then
`format!("{:x}", ...)`). The **UTF-8 encoding step** inside Node's
`Hash.update(string)` is a transcode from the JS string's UTF-16
representation; any lone surrogate present in a hashed string is replaced
with `U+FFFD` at that step (checkpoint-encoding.md §2 "Shared external
callee", §12 item 8) — this must be reproduced by ensuring any string with
that property is already normalized before it becomes a Rust `String`
(§2.5), since Rust `String`s cannot themselves carry an unpaired surrogate.

Critically, **no function hashes the raw stored struct**. Each builds a
*curated projection* first (checkpoint-encoding.md §8.4) — reproducing
"hash the stored struct" or "hash a full re-derivation from live state"
both diverge from the real bytes. The exact preimage builders below are
transcribed from current source (re-verified directly, not solely from the
characterization doc) as the port's authoritative pseudocode.

### 4.1 Capacity integrity hash (`intrinsicCapacityCheckpointIntegrityHash`, `intrinsicCapacitySearch.ts:1503-1569`)

```
preimage = encode_ordinal({
  version, requestFingerprint, producerRole, archiveCohort, searchBounds,
  incumbentBinding,                                    # Option, omitted when None
  frontier: frontier.map(entry => {
    state: {                                            # 10 fields freshly RE-DERIVED from the live IrregularBeamState
      pendingIds: entry.state.remainingPreparedPieces.map(preparedPieceId),
      placedIds: entry.state.placedCollisionGeometries.map(p => p.placement.pieceId ?? p.placement.sourcePieceId),
      unplacedIds: entry.state.unplacedPieceIds,
      placementOrder: entry.state.placementOrder,
      canonicalOccupiedGeometryKey: entry.state.canonicalOccupiedGeometryKey,
      translatedCollisionBounds: entry.state.translatedCollisionBounds,
      sharedCollisionBoundaryLengthMm: entry.state.sharedCollisionBoundaryLengthMm,
      sharedCollisionBoundaryContactUnits: entry.state.sharedCollisionBoundaryContactUnits,
      nearCompleteStructuralContactCount: entry.state.nearCompleteStructuralContactCount,
      dominantNearCompleteStructuralContactCount: entry.state.dominantNearCompleteStructuralContactCount,
      continuationMetadataIdentity: entry.state.continuationMetadataIdentity()   # method call, not stored field
    },
    # ~12 more fields read directly from the STORED frontier entry, not re-derived:
    continuationMetadataIdentity: entry.continuationMetadataIdentity,
    eligibility: entry.eligibility,
    placedPreparedIds: entry.placedPreparedIds,
    pendingPreparedIds: entry.pendingPreparedIds,
    deferredPreparedIds: entry.deferredPreparedIds,
    permanentlySkippedPreparedIds: entry.permanentlySkippedPreparedIds,
    pendingOrder: entry.pendingOrder,
    cursor: entry.cursor,
    pass: entry.pass,
    deferralCounts: entry.deferralCounts,
    placedDoubledMaterialAreaGrid2: entry.placedDoubledMaterialAreaGrid2,
    cavities: entry.cavities,
    anchoredOccupiedKey: entry.anchoredOccupiedKey,
    gridSpan: entry.gridSpan,
    fitMask: entry.fitMask
  }),
  nextDepth, depthBoundaryResumePosition, budgetLedgers, schedulerDeficit,
  settlement, censoring, noSkipFrontier, counters, topologyRetentionDepths
})
integrityHash = sha256_hex(preimage)
```

A Rust port's `capacity_integrity_hash(checkpoint: &IntrinsicAnytimeCheckpoint)`
must build this **mixed** projection (10 re-derived + ~12 stored fields per
frontier entry) exactly, reading the 10 re-derived values through the same
named accessors §9's `IrregularBeamState` port must expose.

### 4.2 Capacity request fingerprint (`intrinsicCapacityRequestFingerprint`, `:1571-1610`)

```
material = [...materialAreasByPieceId.entries()].toSorted_by(pieceId, ordinal_compareStrings)
preimage = encode_ordinal({
  version: INTRINSIC_ANYTIME_CHECKPOINT_VERSION,   # dual-purpose: same string as the checkpoint version
  searchBounds: INTRINSIC_CAPACITY_V1_BOUNDS,
  sheet,                                            # whole SheetSpec
  preparedPieces,                                   # whole array, unprojected — walks full domain classes
  material,                                         # freshly sorted [pieceId, area (bigint)][]
  incumbent: incumbent === undefined ? undefined : {
    canonicalGeometryHash, placedCount, placedDoubledMaterialAreaGrid2, origin, selectedRotationDeg
  },
  schedulerDeficit: schedulerDeficit ?? 0,
  retentionMode: retentionMode ?? 'objective',
  warmPrefix: warmPrefixSeed === undefined ? undefined : {
    sourceRole, depth,
    placedPreparedIds: warmPrefixSeed.state.placementOrder,
    pendingPreparedIds: warmPrefixSeed.state.remainingPreparedPieces.map(preparedPieceId),
    anchoredOccupiedKey: warmPrefixSeed.state.bottomLeftAnchoredCanonicalOccupiedGeometryKey()  # LIVE METHOD CALL at fingerprint time
  }
})
requestFingerprint = sha256_hex(preimage)
```

Note the `warmPrefix.anchoredOccupiedKey` computation is a live-state
method call embedded inside fingerprint computation, not a stored value —
the Rust port's equivalent must call the equivalent method at fingerprint
time too, not cache/reuse an unrelated stored key.

### 4.3 Strict-direct integrity hash (`intrinsicStrictDirectCheckpointIntegrityHash`, `intrinsicStrictDecoder.ts:1058-1078`)

```
stateLineage = collectIntrinsicStrictDirectStateLineage(state, nextPieceIndex + 1)
  # walks state.parent back exactly nextPieceIndex+1 ancestors, one 12-field
  # projection record per ancestor: pendingIds, placedIds, unplacedIds,
  # placementOrder, canonicalGeometryIdentity, canonicalOccupiedGeometryKey,
  # translatedCollisionBounds, sharedCollisionBoundaryLengthMm,
  # sharedCollisionBoundaryContactUnits, nearCompleteStructuralContactCount,
  # dominantNearCompleteStructuralContactCount, continuationMetadataIdentity()
  # detects cycles (visited set) and length mismatches -> undefined
  # -> caller THROWS a plain JS Error (not a typed failure) on undefined, see §8

preimage = encode_locale({
  version, producerRole, requestFingerprint, stateLineage,   # NOT checkpoint.state directly — the ancestor-chain projection
  nextPieceIndex, stepTrace, gapFillEvidence,
  candidateEvaluationCount, activeRuntimeMs, phaseLedger      # Option, omitted when None
})
integrityHash = sha256_hex(preimage)
```

This hash is sensitive to the **entire ancestor chain** back to the frozen
seed, a materially larger and chronologically deeper hash input than the
capacity checkpoint's single-current-state-per-frontier-entry projection
(checkpoint-encoding.md §8.4). A Rust port's `collect_state_lineage`
function must reproduce the cycle detection and length-mismatch behavior
exactly, including the throw-not-Result failure mode for a
self-contradictory lineage at *construction* time (§8).

### 4.4 Strict-direct request fingerprint (`intrinsicStrictDirectRequestFingerprint`, `:1021-1056`)

```
preimage = encode_locale({
  version, producerRole, candidateMode, settings,             # whole IrregularNestingSettings
  settlement: { maximumRuntimeMs, maximumCandidateEvaluationCount, capturePhaseTimings },  # bundles POLICY, not just data
  allPreparedPieces: allPreparedPieces.map(p => ({ pieceId, collisionGeometry: p.collisionGeometry, transforms: p.transforms })),  # curated, narrower than capacity's "whole array"
  remainingPreparedIds: remainingPreparedPieces.map(preparedPieceId),   # ID-only
  frozenPlacementOrder: frozenPlaced.map(placedPieceId),                # ID-only
  frozenGeometryIdentity: canonicalCollisionLayoutIdentity(frozenPlaced) ?? ''   # `?? ''`: undefined identity becomes EMPTY STRING, not omitted/null
})
requestFingerprint = sha256_hex(preimage)
```

The `?? ''` fallback is load-bearing: model this Rust field as a plain
`String` with `.unwrap_or_default()`-style empty-string coercion at the
point the fingerprint is built, **not** as `Option<String>` with
skip-when-None semantics — the field is always present in the preimage,
just possibly empty (checkpoint-encoding.md §8.6).

### 4.5 Place-defer fingerprint (`intrinsicPlaceDeferFingerprint`, `:440-453`)

Already given in full in §2.4. No `integrityHash` counterpart exists for
this producer.

### 4.6 No two fingerprint functions share a field set, encoder, or `SheetSpec` subset

Capacity hashes the whole `SheetSpec`; strict-direct hashes the whole
`IrregularNestingSettings` (no `sheet` field at all in its own fingerprint,
sheet identity flows in only through `frozenGeometryIdentity`); place-defer
hashes only `{width, height}`. A Rust port must implement **three
independent fingerprint functions** with these exact field lists — there is
no shared "make a request fingerprint" utility to write once
(checkpoint-encoding.md §8.6).

---

## 5. Version strings

| Checkpoint type | Version string constant | Source |
|---|---|---|
| `IntrinsicAnytimeCheckpoint` | `intrinsic-anytime-checkpoint-v3` | `intrinsicCapacitySearch.ts:61` |
| `IntrinsicStrictDirectCheckpoint` | `intrinsic-strict-direct-checkpoint-v1` | `intrinsicStrictDecoder.ts:182-183` |
| `IntrinsicPlaceDeferCheckpoint` | `intrinsic-place-defer-checkpoint-v1` | `intrinsicPlaceDeferCompleteShadow.ts:26-27` |

Each validator's **first** (or near-first) check is version equality
(`checkpoint.version !== EXPECTED_VERSION` → immediate rejection —
`intrinsicCapacitySearch.ts` per capacity-search.md §9,
`intrinsicStrictDecoder.ts:917-919`,
`intrinsicPlaceDeferCompleteShadow.ts:356-360`). A Rust port's version
constants must be byte-identical `&'static str` values and must be checked
**first** (or in the same relative order as the TS validator) so that a
version-mismatch rejection reason string/error variant is produced for the
same class of malformed input the TS tests exercise (§10.4). Do not
introduce a new version scheme (e.g. semver) for these strings — they are
opaque compatibility tokens compared by strict equality, not parsed.

**Bumping policy**: none of these version strings changes as part of this
port (migration prompt §2: preserve "version strings" exactly). If the Rust
port's internal checkpoint representation differs from the TS one in any
way that is not proven byte-identical at the hash-preimage level, that is a
Stage 2 correctness bug to fix, not grounds for introducing a new version
string un-requested by the TS source.

---

## 6. Producer inventory, `timingNow` seams, and additive TS work

### 6.1 Summary table

| Producer | Own injectable clock seam today? | Timing bytes inside the **hashed** checkpoint contract? | Gap? |
|---|---|---|---|
| Capacity (`intrinsicCapacitySearch.ts`) | **No** — 20 unconditional `performance.now()` call sites (checkpoint-encoding.md §10.2), confirmed no `timingNow` parameter anywhere in `RunIntrinsicCapacityColdSearchInput` | **Yes, conditionally** — `topologyRetentionDepths[].topologyMeasurementMs` / `.contactMeasurementMs` (§6.4, new finding) whenever `captureTopologyRetention` is true; `IntrinsicCapacitySearchPhaseTimings` (a separate, non-checkpoint diagnostic) always when `capturePhaseTimings` is true | **Yes — two gaps**, see §6.4 |
| Strict-direct (`intrinsicStrictDecoder.ts`) | **Yes** — `timingNow?: () => number` (`:282`), defaulted `performance.now.bind(performance)` (`:412`); the single `.withPlacement` call site correctly forwards it whenever it matters (§6.3, re-verified) | **Yes, unconditionally** — `activeRuntimeMs` always; `phaseLedger` (nested `candidateGenerationMs`/`candidateStateScoringMs`/`candidateState.*`) whenever `capturePhaseTimings` is true | Seam exists and is verified forwarded for the one call site inside this file; §6.3 flags one remaining unaudited breadth item |
| Place-defer (`intrinsicPlaceDeferCompleteShadow.ts`) | No seam of its own; delegates entirely to the strict-direct producer's seam via its `constructIntrinsicStrictState` call (`:180-189`) | **No** — its own checkpoint type has no timing field at all; zero `performance.now`/`timingNow`/`Date.now` occurrences in the file itself | None — nothing to add |

### 6.2 Capacity producer — confirmed no seam, and it matters more than checkpoint-encoding.md concluded (§6.4)

`checkpoint-encoding.md` §10.2 correctly finds zero `timingNow` parameter in
`intrinsicCapacitySearch.ts`, but its conclusion — "there is no timing
field in the *hashed* checkpoint contract for this producer, so a missing
clock seam cannot desynchronize checkpoint bytes" — is only true for the
**cold lane** (`retentionMode` default `'objective'`, `captureTopologyRetention
=== false`). It does not hold for the **quality-warm-prefix lane**
(`retentionMode: 'quality-frontier'`, `intrinsicCapacityMode.ts:778,815`)
or the cohesion-frontier-shadow lane (`retentionMode:
'cohesion-frontier-shadow'`, `:1098`), both of which are live production
lanes. See §6.4.

### 6.3 Strict-direct producer — one confirmed-forwarded call site, breadth not fully audited

`constructIntrinsicStrictState`'s only `IrregularBeamState`-advancing call
(`.withPlacement`, `intrinsicStrictDecoder.ts:1421-1435`, the sole
`.withPlacement` call site in this file, re-confirmed by direct grep) does
forward `timingNow: input.timingNow` — but **only inside the conditional
branch that fires when `capturePhaseTimings === true`** (the `phaseTimings
=== undefined ? {} : {..., timingNow: input.timingNow}` spread at
`:1425-1435`). When `capturePhaseTimings === false`, `.withPlacement`'s own
default (`performance.now.bind(performance)`) applies instead, but this is
provably harmless: `IrregularBeamState.withPlacement`'s own internal
`timingNow()` calls are themselves gated behind `input.onPhaseTimings ===
undefined ? 0 : timingNow()` (`irregularBeamState.ts:180,185,192,197,211`),
and `onPhaseTimings` is only supplied in the same `capturePhaseTimings ===
true` branch — so when the seam is *not* forwarded, the unseamed default
clock is never actually invoked. **This resolves checkpoint-encoding.md
§15 open question 2 for this specific call site**: the seam is correctly
and completely threaded whenever it can affect observable bytes. What
remains unaudited (per checkpoint-encoding.md's own flag, not newly
resolved here) is whether the two other callers of
`constructIntrinsicStrictState` — `intrinsicReconstructionPortfolio.ts:222`
and `intrinsicPeriodicFamilyPortfolio.ts:317` (per
`strict-decoder-gap-family.md` §1.2/§2) — themselves ever construct a
*fresh* `IrregularBeamState` (bypassing `constructIntrinsicStrictState`'s
own seam) in a way that could reach a checkpoint's hashed `activeRuntimeMs`/
`phaseLedger` non-deterministically. Recommend a full-file audit of every
`new IrregularBeamState(...)` / state-transition call site reachable from a
checkpoint-producing path as a Stage 1/2 implementation task, not assumed
safe by this document.

### 6.4 New finding: `topologyRetentionDepths` leaks wall-clock timing into the capacity checkpoint's integrity hash for live production lanes

This is a source-verified correction to checkpoint-encoding.md's framing
(that document's §10.2 states the capacity checkpoint has "no timing field
at all" in its hashed contract — true only for the cold lane).

**Chain of evidence** (`intrinsicCapacitySearch.ts`, re-read directly for
this document):
1. `captureTopologyRetention = retentionMode === 'cohesion-frontier' ||
   retentionMode === 'cohesion-frontier-shadow' || retentionMode ===
   'quality-frontier'` (`:339-343`) — **independent of**
   `capturePhaseTimings`.
2. When `true`, `makeCapacityTopologyMeasurements()` (`:1974-1998`) records
   genuine `performance.now()`-derived elapsed time in `counters.elapsedMs`
   (`:1996`), and the contact-fanout branch separately accumulates
   `contactFanoutTrace.measurementMs += Math.max(0, performance.now() -
   contactStartedAt)` (`:668-671`) — both unconditional `performance.now()`
   calls with **no `timingNow` parameter anywhere in this file** (confirmed,
   §6.2).
3. `makeCapacityTopologyRetentionDepthTrace` (`:2080-2125`) copies both
   accumulated values verbatim into
   `IntrinsicCapacityTopologyRetentionDepthTrace.topologyMeasurementMs`
   (`:2112`) and `.contactMeasurementMs` (`:2118`).
4. `runIntrinsicCapacityColdSearch`'s local `topologyRetentionDepths` array
   (`:485`) is **seeded from the incoming checkpoint's own prior value**
   (`...(input.checkpoint?.topologyRetentionDepths ?? [])`) and then
   **appended to** (`:837`) as new depths complete — so a resumed
   checkpoint's array carries forward every prior segment's already-baked
   wall-clock values, compounding across every pause/resume cycle, the same
   accumulation *shape* as `activeRuntimeMs` in the strict-direct
   checkpoint, but with **no seam at all** to make any of it deterministic.
5. `makeIntrinsicCapacityCheckpoint` copies this array verbatim into
   `checkpointWithoutIntegrity.topologyRetentionDepths` (`:1252`), and
   `intrinsicCapacityCheckpointIntegrityHash` includes
   `topologyRetentionDepths: checkpoint.topologyRetentionDepths` verbatim in
   its hash preimage (`:1563`, confirmed in §4.1's pseudocode).
6. `retentionMode: 'quality-frontier'` is a **live production value** for
   the protected quality-warm-prefix lane's pilot and continuation calls
   (`intrinsicCapacityMode.ts:778,815`) — the same lane migration-prompt §11
   explicitly names as requiring preserved "separate checkpoints" and
   "current admission rule for quality-warm-prefix results."
   `retentionMode: 'cohesion-frontier-shadow'` is likewise live
   (`intrinsicCapacityMode.ts:1098`).

**Consequence**: for the quality-warm-prefix and cohesion-frontier-shadow
producer roles specifically (not the cold lane, and not the ordinary
non-quality warm-prefix lane — those default `retentionMode` to
`'objective'`, per capacity-search.md §3, which does not set
`captureTopologyRetention`), the capacity checkpoint's `integrityHash` is
**not reproducibly deterministic across otherwise-identical runs**, because
uncontrolled `performance.now()` values are part of its hash preimage. This
means:

- **The deterministic-clock differential test design (§7) cannot achieve
  byte-identical capacity-checkpoint hashes for these two roles** using
  only the existing strict-direct `timingNow` seam — a **new** TS-side
  clock seam is required, threaded specifically into
  `makeCapacityTopologyMeasurements` and the contact-fanout timer inside
  `intrinsicCapacitySearch.ts`, matching migration-prompt §11's "trace
  every other checkpoint producer and add an equivalent test-only clock
  seam where needed." This document flags the gap precisely; whether and
  how to add the seam is an orchestrator decision (§11 OQ-2), consistent
  with checkpoint-encoding.md §15 item 3's framing for the (narrower) gap
  it already found.
- For the **cold lane and ordinary warm-prefix lane** (both default
  `retentionMode`, `captureTopologyRetention === false`,
  `topologyRetentionDepths` stays `[]` throughout), the capacity
  checkpoint's hash remains fully deterministic today with no seam needed
  — checkpoint-encoding.md's conclusion is correct for those two lanes.
- A Rust port's `capacity.rs` must still model `topologyMeasurementMs` /
  `contactMeasurementMs` as genuine `f64` wall-clock fields (§3.2) and must
  still hash them (§4.1) for byte-identical TS/Rust results on production
  (non-deterministic-clock) runs of the affected lanes — the fields are
  real production data, not a bug to "fix" by omitting them. Only the
  *test-determinism* story for these two lanes is blocked pending the new
  seam.

### 6.5 Additive TS-side seam work required (per migration-prompt §11)

The following are **additive, test-only** changes to TypeScript required to
make the deterministic-clock differential test design (§7) achievable for
every live-in-production checkpoint producer/lane. None of these change any
production default or observable production behavior (the seam parameter
must default to the current unseamed `performance.now()` behavior when
omitted, exactly matching the existing `intrinsicStrictDecoder.ts:282,412`
pattern):

1. Add an optional `timingNow?: () => number` parameter to
   `RunIntrinsicCapacityColdSearchInput` (`intrinsicCapacitySearch.ts`),
   threaded into every `performance.now()` call site in the file (20 sites
   per checkpoint-encoding.md §10.2, re-confirmed), including specifically
   `makeCapacityTopologyMeasurements`'s internal clock and the contact-fanout
   timer identified in §6.4. Default: `performance.now.bind(performance)`,
   matching the strict-decoder precedent exactly.
2. Audit and, if needed, thread the same seam through the two other
   `constructIntrinsicStrictState` call sites
   (`intrinsicReconstructionPortfolio.ts:222`,
   `intrinsicPeriodicFamilyPortfolio.ts:317`) per §6.3's flagged breadth
   item, so that any checkpoint reachable through those callers (if any —
   confirm against `strict-decoder-gap-family.md`'s own call-site inventory)
   is equally deterministic-clock-testable.
3. No seam is needed for `intrinsicPlaceDeferCompleteShadow.ts` (§6.1) —
   it has no timing calls of its own.

These are TS-repo changes, not Rust changes, and are explicitly listed here
per the task's instruction to "list seams needing test-only additions on
the TS side as additive work." They should land as a small, reviewable,
additive PR before or alongside Stage 2's differential-test implementation
work — not bundled into unrelated production logic changes.

---

## 7. Deterministic-clock differential test design

Goal (migration-prompt §11, §18.3): under an identical injected clock
sequence and identical timing-capture configuration, TS and one-thread Rust
must produce **byte-identical** checkpoint encoding, fingerprints,
integrity hashes, validation decisions, resume traces, and endpoints.

### 7.1 Clock injection shape

- **TS side**: reuse the existing `timingNow?: () => number` seam pattern
  (`intrinsicStrictDecoder.ts:282`) for the strict-direct producer as-is;
  add the equivalent seam to the capacity producer per §6.5 item 1. A test
  harness constructs a **deterministic sequence generator** — e.g. a
  closure returning a strictly-increasing, pre-scripted sequence of
  millisecond values (`let calls = 0; () => SCRIPTED_SEQUENCE[calls++]`) —
  and passes the **same scripted sequence** (by call ordinal, not by
  wall-clock value) to both backends for one differential test case.
- **Rust side**: define a `checkpoints::clock::DeterministicClock` type in
  the same module (§3), implementing a trait
  `trait MonotonicClock { fn now_ms(&self) -> f64; }` with two
  implementations: `SystemClock` (production default, backed by
  `std::time::Instant`) and `ScriptedClock` (test-only, backed by an
  interior-mutable call counter indexing into a pre-scripted `Vec<f64>`,
  panicking with a clear diagnostic if the script is exhausted — a script
  exhaustion is a test-authoring bug, not a condition to silently repeat
  the last value). Thread `&dyn MonotonicClock` (or a generic `impl
  MonotonicClock`) through every function that currently calls
  `Instant::now()`/an equivalent inside the ported capacity and
  strict-direct search loops — mirroring the TS seam's call-site breadth
  exactly (§6.5).
- **Call-ordinal parity, not value parity, is the actual test invariant**:
  since the two backends' internal call *counts* to the clock may not be
  provably identical at the very first Stage 2 cut (e.g. if a Rust loop
  structure differs in a way that changes how many times the equivalent of
  `timingNow()` is invoked, even though the algorithm's *decisions* are
  identical), the test harness should supply a clock that returns a
  **fixed, constant value regardless of call count** (e.g. always `0.0`,
  or always `1000.0`) rather than a strictly-scripted sequence, for the
  specific purpose of exact checkpoint-byte comparison. This collapses
  every `elapsedMs`-style computation to the same constant delta (`0`) in
  both backends regardless of exact call-count parity, which is the
  simplest injection that still exercises the full encode/hash/validate
  pipeline byte-for-byte. Reserve a *scripted, non-constant* sequence for a
  narrower, separate test whose explicit purpose is proving call-count
  parity itself (a stronger, optional assertion — see §7.3).

### 7.2 Test matrix (per checkpoint type, per maintained fixture)

For each of the two live producers (capacity, strict-direct) and, if the
orchestrator elects to port producer 3 (§10), place-defer:

1. **Fresh-construction byte match**: run TS and Rust to the first pause
   boundary under the constant-clock injection; assert
   `request_fingerprint`, `integrity_hash`, and the full hash-preimage
   string (not just the final hash — compare the preimage too, to
   pinpoint exactly which field diverges on failure) are byte-identical.
2. **Multi-resume byte match**: resume 2–3 times (capacity: multiple
   depth-boundary quanta; strict-direct: multiple committed-piece
   boundaries) under the same constant-clock injection; assert
   byte-identical checkpoint bytes at every pause, not only the first.
3. **Quality-warm-prefix / cohesion-frontier-shadow specific case**: once
   §6.5 item 1's seam lands, add a dedicated test exercising
   `retentionMode: 'quality-frontier'` under the constant-clock injection,
   asserting `topologyRetentionDepths[].topologyMeasurementMs` /
   `.contactMeasurementMs` are byte-identical between backends (both should
   render as the same constant-delta value, e.g. `"0"`) — this is the
   regression test for §6.4's finding; without §6.5's seam this test cannot
   be written deterministically at all.
4. **Cross-fixture coverage**: run this matrix for at least the maintained
   small/medium fixtures and the Mixed-61 `2000x2700` case (per
   migration-prompt §18.6/§25), for both Compact and Compact Short Side
   where the underlying producer is reachable from each profile.

### 7.3 Optional stronger assertion — call-count parity

As a separate, non-blocking-for-Stage-2 test tier, add a scripted
(non-constant) clock sequence and assert that **the number of clock calls
consumed** by TS and Rust to reach an equivalent pause boundary is
identical. This is a stronger claim than byte-identical checkpoint output
(it additionally proves the two implementations' internal control-flow
shape matches call-for-call) and is valuable evidence but not itself a
correctness requirement — a Rust port that calls the clock a different
number of times but still produces byte-identical checkpoints under the
constant-clock injection is still exact-parity-correct per §7.1's actual
invariant. Treat call-count parity as a diagnostic/confidence signal, not a
gating differential assertion, unless the orchestrator elects otherwise.

---

## 8. Production-clock rules

Per migration-prompt §11: "With real production clocks, require the same
canonical encoding rules, field presence rules, integrity validation,
status transitions, and resume semantics, but compare timing fields as
non-semantic measurements rather than demanding equal values."

Concretely, for every production (non-deterministic-clock) differential
run:

1. **Structural equality is still required and gating**: version strings,
   field presence/omission (every `Option` field's `Some`/`None`-ness),
   array lengths and order, every non-timing scalar/array/object field,
   `settlement`/`censoring`/`producerRole`/`archiveCohort` enums, and the
   overall pass/fail outcome of validation must match exactly between TS
   and Rust for the same input and same injected non-determinism-free
   conditions (i.e. everything except wall-clock-derived numeric fields).
2. **Timing fields are compared as measurements, never as exact-equality
   assertions**: `activeRuntimeMs`, `phaseLedger.*`,
   `topologyRetentionDepths[].topologyMeasurementMs`,
   `.contactMeasurementMs`. A production differential test must assert
   these are: present/absent according to the same rule as every other
   field (§2.2's `Option` semantics still apply — a timing field's
   *presence* is semantic even though its *value* is not), finite,
   non-negative, and of the same general order of magnitude as a sanity
   bound (e.g. "less than the wall-clock time the test itself took to
   run") — never bit-for-bit equal to the TS run's value, since Rust and TS
   measure genuinely different executions.
3. **`integrityHash`/`requestFingerprint` under production clocks are
   backend-internal-only comparisons, not cross-backend comparisons**: since
   the hash preimage includes the timing fields verbatim (§4.1, §4.3), a
   TS-produced hash and a Rust-produced hash for "the same" input will
   *legitimately differ* under real clocks whenever the checkpoint type in
   question has a hashed timing field (strict-direct always;
   capacity only for the quality-warm-prefix/cohesion-frontier-shadow
   lanes per §6.4). The production-clock test's job is: (a) each backend's
   own checkpoint validates against **itself** on resume (its own
   `integrityHash` reproduces under its own re-hash — this is an
   intra-backend invariant, already required by the TS validator's own
   check, and must hold for Rust's validator identically); (b) the
   **non-timing-projected** view of the checkpoint (i.e. every field
   *except* the timing ones) matches between backends structurally, per
   item 1. Do not attempt to make cross-backend `integrityHash` values
   equal under real clocks — that is definitionally impossible for a hash
   that includes wall-clock data, and migration-prompt §11 explicitly
   anticipates this ("compare timing fields as non-semantic measurements").
4. **Never remove a timing field from a production checkpoint to make
   bytes match** (migration-prompt §11, final bullet) — if a production
   differential comparison is inconvenient because of a timing field, fix
   the *comparison projection* (exclude that one field, by name, from the
   equality assertion, matching migration-prompt §18.3's "documented
   projection that excludes only fields designated non-semantic before the
   test runs"), never the production data model.
5. **Status transitions and resume semantics** (paused vs. settled,
   evaluation-cap vs. exhausted, checkpoint-error vs. success) must match
   exactly under production clocks too — these are driven by evaluation
   counts and depth/piece boundaries, not by wall-clock values, so they
   remain fully deterministic and gating even without a clock seam
   (capacity-search.md §10 confirms the evaluation-cap and pause-boundary
   checks are depth/count-based, not time-based, for the capacity producer;
   the strict-direct producer's deadline check *is* wall-clock-based
   (§6.3), so a production-clock differential test of strict-direct's
   deadline classification specifically must treat "did it hit the
   deadline" as a measurement-dependent outcome that may legitimately
   differ between a faster Rust run and a TS run of the same input — this
   is expected and acceptable, not a parity failure, provided both
   backends implement the *same* deadline formula against their own clock).

---

## 9. Resume-equivalence tests

Per migration-prompt §11's closing requirement: "A resumed Rust checkpoint
must reproduce the same endpoint, trace, evaluation counts, and result as
uninterrupted Rust and TypeScript execution."

Required test shapes (per checkpoint type, per maintained fixture):

1. **TS resumed == TS uninterrupted** (already covered by existing tests —
   `tests/unit/intrinsicCapacityMode.test.ts:549` "resumes at depth
   boundaries with the uninterrupted trace and endpoint",
   `:895` "resumes an exact warm prefix...",
   `tests/unit/intrinsicStrictDecoder.test.ts:197` "reproduces uninterrupted
   canonical construction through every-piece resume" — these are existing,
   immutable per migration-prompt §3, and must continue passing unmodified).
2. **Rust resumed == Rust uninterrupted** (new — same fixtures, same
   pause/resume cadence as the TS tests above, ported to exercise the
   equivalent Rust checkpoint/resume call).
3. **Rust resumed == TS uninterrupted (or TS resumed)** — the actual
   cross-backend correctness claim: for the same request, TS's accepted
   endpoint/trace/evaluation-count/result (whether TS ran uninterrupted or
   itself resumed from its own checkpoint — both must already be equal per
   item 1) must equal Rust's resumed run's endpoint/trace/evaluation-
   count/result. This is an **ordinary differential-parity comparison of
   final outputs**, not a comparison of literal checkpoint bytes (checkpoint
   bytes are backend-internal, per §10) — compare `placed`/`unplaced`
   partitions, transforms/coordinates, canonical keys, scheduler trace,
   ledgers, and evaluation counts exactly, per migration-prompt §18.3's
   existing list.
4. **Multi-boundary interleaving fidelity** — specifically reproduce the
   production interleaving pattern (checkpoint-encoding.md §13 item 1):
   capacity cold-quantum checkpoints interleaved with canonical-grid
   strict-direct checkpoints via the single serial
   `onCanonicalGridCheckpointed` callback loop
   (`intrinsicSharedArchivePortfolio.ts:261-333`,
   `computeIrregularNesting.ts:650-703`). A Rust port's equivalent
   orchestration must reproduce this **exact interleaving chronology** — do
   not run the two producers' pause/resume cycles concurrently on separate
   Rayon tasks even if each individually produces correct bytes (§13 of
   checkpoint-encoding.md; this cluster is entirely serial by contract, see
   §13 below).
5. **Corrupted-checkpoint resume rejection parity** — see §10.4.

---

## 10. Cross-backend checkpoint acceptance policy

This is a genuine design decision this document must state explicitly,
because the migration prompt's §11 language ("If cross-language checkpoint
persistence is currently externally supported, preserve compatibility for
checkpoints produced by either backend...") presupposes a possibility that
current source evidence does not support in the form the prompt implies.

### 10.1 What "cross-backend checkpoint acceptance" cannot mean here

Checkpoints are **never serialized** in production (§1, checkpoint-encoding.md
§8.0) and hold a **live object-graph reference** (`IrregularBeamState`
instance, not plain data — §1, §3). There is no wire format today for a
checkpoint to cross a process or language boundary. Given the migration
prompt's own coarse-boundary architecture (§7, §17: one N-API call executes
a complete job; "no silent fallback after Rust has begun a job"; backend
selection happens once, before algorithm execution, and never mid-job), a
single production job runs entirely on one backend from start to finish. A
literal live-object checkpoint handoff from a TS-executing job to a
Rust-executing job (or vice versa) mid-pause **cannot occur** under the
approved architecture, because that would require crossing the N-API
boundary at a per-checkpoint granularity, which migration-prompt §6 Stage 1
and §7 explicitly forbid ("Do not cross N-API per candidate, per NFP
lookup, per placement validation, per checkpoint, or per search state").

### 10.2 What is actually required

1. **Byte-level hash/encoding parity for testing** (§7): Rust must
   independently reproduce, from equivalent live state, the same
   canonical-JSON bytes and SHA-256 hashes TS would produce for the
   *same logical checkpoint content* — this is what makes differential
   testing possible without ever exchanging a live object. This is fully
   specified in §2–§4 and is the actual load-bearing form of "checkpoint
   compatibility" for this port.
2. **Independent, semantically-equivalent resume mechanisms**: Rust's own
   checkpoint/pause/resume implementation must satisfy the same invariants
   TS's does (§9) — resuming reproduces the uninterrupted result — using
   Rust's own native checkpoint objects. There is no requirement, and no
   architectural path, for Rust to literally *ingest* a TS-produced
   checkpoint object or vice versa.
3. **Validation/corruption-rejection semantics parity** (§10.4): Rust's
   checkpoint validator must reject the same classes of malformed/corrupted
   checkpoint input that TS's validator rejects, for the same reasons, so
   that a fuzzed or adversarially-constructed *native* Rust checkpoint value
   is rejected exactly when the equivalent TS-shaped value would be.

### 10.3 Recommended policy statement

**No live cross-backend checkpoint handoff is required or supported in
production.** Each job stays on one backend end-to-end
(migration-prompt §17). "Checkpoint compatibility" for this port means: (a)
byte-identical encoding/hashing under a shared deterministic clock (§7),
for differential testing only; (b) equivalent validation/corruption-rejection
semantics (§10.4), implemented independently in each backend's own native
type system; (c) equivalent resume-correctness (§9), verified per-backend
and cross-backend only at the level of final job outputs, never at the
level of literal checkpoint object exchange. If a future product
requirement introduces genuine cross-process/cross-language checkpoint
persistence (e.g. suspending a job to disk and resuming it later, possibly
under a different backend selection), that is **new capability**, not a
port of existing behavior, and would require a real wire-format design
(full `Serialize`/`Deserialize` with a defined byte layout for the live
`IrregularBeamState` graph, not merely the current hash-preimage
projections) — explicitly out of scope for Stages 0–5 of this migration
unless the orchestrator directs otherwise (§11 OQ-4).

### 10.4 Corruption-rejection parity

The migration prompt requires "checkpoint corruption rejection" as a
required Rust unit test category (§18.2) and requires exact reproduction of
validation semantics (§11). Concretely:

- **Reproduce the exact validation *order*, not just the exact validation
  *outcome***, wherever an existing test asserts on which specific rejection
  fires for a given malformed input (e.g.
  `tests/unit/intrinsicStrictDecoder.test.ts:285` "rejects corrupted direct
  state lineage and changed settlement policy" — checkpoint-encoding.md
  §11, strict-decoder-gap-family.md §11.3 both flag this as
  order-sensitive). A Rust validator that reaches a *different* correct-outcome
  rejection reason via a different check order than TS would still be a
  parity bug if any test or diagnostic contract depends on the specific
  reason string/branch. Port each validator (`validateIntrinsicCapacityCheckpoint`,
  `~1250` lines / `~20` distinct reasons per checkpoint-encoding.md §11;
  `validateIntrinsicStrictDirectCheckpoint`, 11-step sequential validation
  per strict-decoder-gap-family.md §11.3;
  `validatePlaceDeferCheckpoint`, ~15 field-equality checks) as an ordered
  sequence of early-return checks in the **same order**, with a Rust error
  enum variant per distinct TS rejection reason (migration-prompt §16:
  "typed Rust error enums for precise internal provenance") — not a single
  generic `CheckpointInvalid` variant.
- **Reproduce the throw/defect vs. typed-error distinction**
  (checkpoint-encoding.md §11, strict-decoder-gap-family.md §11.1): the one
  place a checkpoint-construction invariant violation is signaled by a raw
  JS `throw` inside an `Effect.gen` body (captured as an Effect **defect**,
  not a typed failure) —
  `makeIntrinsicStrictDirectCheckpoint`'s `collectIntrinsicStrictDirectStateLineage`
  returning `undefined` (`intrinsicStrictDecoder.ts:884`) — must map to a
  genuine Rust `panic!`/process-abort-class invariant violation (contained
  at the outer native job boundary per migration-prompt §16, never a normal
  `Result::Err` a caller is expected to handle), while every other
  validation rejection in this cluster maps to a recoverable, typed Rust
  `Result::Err`.
- **Test-vector reuse**: port the existing corruption-mutation test
  fixtures byte-for-byte as Rust unit tests (object-spread-style field
  mutations — `counters.deduplicatedSuccessors = -1`,
  `budgetLedgers.perDepth[0].quotaExhausted` flipped, swapped
  `pendingPreparedIds`/`deferredPreparedIds`, etc. — per
  `tests/unit/intrinsicCapacityMode.test.ts:634-680,1181-1211`,
  `tests/unit/intrinsicStrictDecoder.test.ts:285`), constructing the
  equivalent malformed Rust checkpoint value directly (Rust has no
  `JSON.stringify`/object-spread equivalent to replicate literally — build
  the corrupted struct value directly and assert the expected typed error
  variant) rather than inventing new corruption scenarios that happen to
  be easier to express in Rust.
- **External `AppErrorCode` mapping stays as characterized**: all three
  producers' checkpoint failures map to `irregular_scoring_error`
  externally (`IrregularPortfolioError({ category: 'search' })` — checkpoint-
  encoding.md §11), except place-defer's, which never reaches
  `AppErrorCode` at all in production (fully absorbed as observer-only
  censoring via `observeIntrinsicPlaceDeferCompleteShadow`'s catch-all,
  checkpoint-encoding.md §11). A Rust port must preserve this
  indistinguishability at the external-code level while preserving full
  internal distinguishability (operation string + message/reason) per
  migration-prompt §16.

---

## 11. Open questions requiring an orchestrator ruling

1. **(OQ-1) Encoder B/D `localeCompare` key-sort strategy** (§2.3): full
   ICU4X collation crate vs. pinned ordinal-equivalence proof for the
   closed, fixed, hand-written key-name set. This is a real
   dependency/complexity-vs.-rigor tradeoff; this document recommends the
   pinned-equivalence proof (option b) as lower-cost given the currently
   fully-closed key-name universe, but the final call belongs to the
   orchestrator.
2. **(OQ-2) Whether to add the new `timingNow` seam to
   `intrinsicCapacitySearch.ts`** (§6.4, §6.5) as a TS-side additive change,
   and its exact call-site breadth (all 20 sites vs. only the two feeding
   `topologyRetentionDepths`). Recommended: add it to all 20 sites for
   uniformity with the strict-decoder precedent and to also make
   `IntrinsicCapacitySearchPhaseTimings` (a separate, non-checkpoint
   diagnostic) deterministically testable, but this is a product/process
   decision about touching TS source ahead of the Rust port proper.
3. **(OQ-3) Whether producer 3 (`IntrinsicPlaceDeferCheckpoint`) must be
   ported at all for Stage 2 promotion**, given it is non-authoritative,
   reachable only via a flag with exactly two test call sites, and never
   influences `selected` (checkpoint-encoding.md §1.3). If the orchestrator
   requires full backend-parameterized coverage of
   `tests/unit/intrinsicCapacityIntegration.test.ts:391,632` against Rust
   (per migration-prompt §18.1's "run all applicable existing tests against
   Rust through backend parameterization"), it must be ported; if those two
   tests are scoped as TS-only diagnostics, it need not be for Stage 2
   promotion (though migration-prompt §4.1's "capacity preflight... material
   accounting... capacity search" inclusion language does not explicitly
   name this shadow module, unlike several others it does name).
4. **(OQ-4) Whether genuine cross-process/cross-language checkpoint
   persistence is a real future requirement** (§10.3) — this document's
   source tracing (matching checkpoint-encoding.md §15 item 5) found no
   evidence of externally-supported persistence today; confirm with the
   product owner before investing in a wire-format design that is currently
   unmotivated by any observed requirement.
5. **(OQ-5) `IntrinsicAnytimeProducerRole` factual correction carried
   forward**: checkpoint-encoding.md §3.1 describes this as a "7-member
   union"; current source (`intrinsicCapacitySearch.ts:64-69`) declares
   exactly 6 members (§3.2 of this document lists all 6). This does not
   change any design conclusion in either document (both agree the capacity
   checkpoint's own constructor only ever populates 4 of them), but the
   miscount should be corrected in `checkpoint-encoding.md` if that
   document is revised, to avoid a future implementer chasing a
   nonexistent 7th variant.
6. **(OQ-6) UTF-16-vs-code-point ordinal comparator hazard for piece-ID
   sorts** (§2.3): whether piece-ID generation anywhere in the pipeline can
   ever produce a supplementary-plane Unicode character, which would make
   plain Rust `str::cmp` unsafe for `intrinsicCapacityRequestFingerprint`'s
   `material` sort and `intrinsicCapacitySuccessorIdentity`'s placement-order
   sort specifically (not the checkpoint object-key sort, which is safe).
   This is a narrow, likely-unreachable-in-practice hazard (piece IDs are
   typically internally generated), but was not proven unreachable by this
   document's source tracing and should be either proven safe or given a
   UTF-16-code-unit-aware comparator for those two call sites specifically.

---

## Cross-reference index

| Concern | Primary source | Deeper detail |
|---|---|---|
| Full per-branch validation walk, capacity | §10.4 (this doc) | `checkpoint-encoding.md` §3.1, §8.4; `capacity-search.md` §9 |
| Full per-branch validation walk, strict-direct | §10.4 (this doc) | `checkpoint-encoding.md` §3.2, §8.4; `strict-decoder-gap-family.md` §3.6, §9-11 |
| Production checkpoint interleaving chronology | §9 item 4 (this doc) | `checkpoint-encoding.md` §1.3, §13 item 1; `worker-coordination.md` |
| Actual production cancellation mechanism (hard thread-kill, not cooperative checkpoint) | — | `worker-coordination.md` lines 775-825; `errors-protocol.md` lines 527-575 |
| `topologyRetentionDepths` timing leak (new finding) | §6.4 (this doc) | not previously documented in the characterization corpus |
| `IrregularBeamState` full public surface | — | `checkpoint-encoding.md` §2, §12 item 1; `capacity-core.md` §2 |
| `AppErrorCode` external mapping for checkpoint failures | §10.4 (this doc) | `checkpoint-encoding.md` §11; `errors-protocol.md` |
