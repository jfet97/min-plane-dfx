# Intrinsic Capacity Mode: First Production Implementation

This report records the implementation, exactness argument, evidence, and
merge recommendation for `intrinsic-capacity-v1`, the Compact capacity mode
specified in [`../planning/intrinsic-capacity-mode.md`](../planning/intrinsic-capacity-mode.md).
Work was delivered on `intrinsic-capacity-mode-fable`; the fanout-scoring
experiment lives on `capacity-contact-band-fanout`.

## Critical Review Of The Original Design

The planning contract survived implementation-grade scrutiny essentially
intact. Three specification points required interpretation; each resolution is
recorded in the planning document's implementation-status section:

1. **Fanout local rule.** The plan fixes fanout `3` but not the local order
   that selects which three legal placements survive. The complete-path local
   score includes shared-boundary contact, which requires constructing a beam
   state (spatial-index insertion plus incremental contact measurement) for
   every candidate. The capacity objective contains no contact criterion, so
   the production rule ranks candidates by exact intrinsic envelope metrics
   (maximum side, area, span on the canonical grid) derived from
   incrementally maintained occupied bounds, at `O(1)` per candidate, and
   builds states only for selected successors. The contact-aware alternative
   was implemented as a control arm (see Rejected Alternatives).
2. **"Checked for exact partial q0/q90 fit."** The in-loop check is the exact
   canonical-grid span test. For convex collision polygons that are pairwise
   legal by NFP construction, fitting the axis-aligned sheet is exactly the
   span condition; pairwise legality is invariant under the rigid quarter-turn
   because canonical grid coordinates transform exactly under
   `(x, y) -> (-y, x)`. The authoritative full canonical legality
   (`assertCanonicalGridLegalLayout`, per orientation, pairwise Clipper2)
   still runs at every endpoint materialization, so no unsound fit claim can
   reach a settled endpoint.
3. **Evaluation-cap settlement point.** When the deterministic cap fires
   mid-depth, the partially expanded depth is discarded and the last fully
   retained beam terminalizes. The stop point is deterministic because
   candidate enumeration order is deterministic.

One product-level observation: the app shell (`preparePieces`) already emits a
bounding-box `piece_does_not_fit` warning but still forwards the piece. The
worker-side singleton proof is the exact collision-polygon authority; the two
layers are complementary, not redundant.

## Implementation Architecture

New modules under `src/workers/algorithm/irregular/`:

| Module | Responsibility |
| --- | --- |
| `intrinsicCapacityPreflight.ts` | Proof-only preflight: exact `bigint` doubled-area sums and singleton q0/q90 span proofs on canonical collision polygons; `proven_impossible(reason)` or `inconclusive`; invalid accounting is an error. |
| `intrinsicCapacityMaterial.ts` | Exact doubled unpadded material areas (`bigint` shoelace over the unpadded convex hull on the 0.001 mm grid). |
| `intrinsicCapacityPrefixes.ts` | One read-only post-construction lineage walk per committed direct constructor; at most nine skip-free original-order prefix descriptors at quarter/half/three-quarter depths; zero-evaluation terminalization into incumbents. |
| `intrinsicCapacitySearch.ts` | `intrinsic-capacity-v1`: depth-synchronized cold beam (width 16, fanout 3, cap 50,000, mandatory skip successor), exact span fit, dedup and cavity cache by anchored occupied-union identity, strict incumbent bounds, deterministic settlement. |
| `intrinsicCapacityEndpoint.ts` | Exact partial endpoint: authoritative q0/q90 legality, canonical identity/hash, exact partition, capacity objective comparator. |
| `intrinsicCapacityMode.ts` | Orchestration, trace assembly, final endpoint selection across cold and prefix endpoints, partition validation. |

Coordinator wiring in `computeIrregularNesting.ts` replaces the previous hard
failure (`no exact endpoint fitting the requested sheet`) with the routing
contract. The complete sheetless archive itself is untouched; prefix capture
is a read-only callback fired only for committed, uncapped, complete direct
constructions.

### Exactness Argument

- **Area proof soundness.** Collision polygons must remain pairwise disjoint
  and inside the sheet, so the sum over pieces of the minimum valid exact
  doubled collision area exceeding the doubled canonical sheet area is a
  sound impossibility certificate. All arithmetic is integer `bigint` on the
  0.001 mm grid; no waste percentage or density factor exists anywhere.
- **Singleton proof soundness.** A convex polygon fits an axis-aligned
  rectangle exactly when its grid span fits, and grid-aligned translations
  preserve canonical coordinates exactly; the rigid layout-level q90 makes
  `min(w,h)/max(w,h)` coverage complete even when a piece's own transform set
  omits 90 degrees.
- **Endpoint legality.** Every settled endpoint re-runs
  `assertCanonicalGridLegalLayout` per rigid orientation and canonical
  identity hashing, the same authorities as the complete path.
- **Material exactness.** Placed material is the `bigint` sum of exact
  unpadded convex-hull doubled areas; ties in the objective compare `bigint`
  values, never floats.
- **Partition exactness.** `intrinsicCapacityEndpointPartitionsRequest`
  verifies the placed/unplaced partition; a violation is an error, not a
  result.
- **Determinism.** Candidate enumeration, dedup keep-first order, comparator
  tie-breaks (canonical hash, origin, depth, role), and the settlement point
  are all deterministic; paired reruns produce identical traces minus
  wall-clock fields (unit-tested).

## Defects Found And Fixed During Implementation

1. The first draft of the in-loop fit check contained a leftover degenerate
   ternary that ignored the computed span; fixed before the first commit and
   covered by the fit-rejection counters in the gate traces.
2. The skip-successor dedup key initially carried a redundant skip-count
   suffix; removed so deduplication keys are exactly the canonical
   occupied-union identity.
3. Adding phase timings to the trace initially broke the determinism
   falsifier test, which compares full traces; the test now strips only
   wall-clock fields, keeping every semantic field under exact equality.

Pre-existing, unrelated: the full vitest suite has 40 failing tests on the
handoff baseline (windowed beam, layout/placement scorer, workspace project
service, benchmark harness, strict family portfolio). They fail identically
before and after this work and are outside the Compact production gates; some
decoder tests are additionally load-flaky under a parallel full-suite run
because they carry 10 s wall-clock deadlines.

## Complete-Path Regression Evidence

| Gate | Result |
| --- | --- |
| Triangle-20 exact golden | pass, hash `371db269...`, 13.1 s (recorded baseline about 12.6 s) |
| Shapes-17 exact golden | pass, hash `c640c06f...`, 7.8 s (recorded baseline about 7.4 s) |
| `pnpm gate:mixed61-compact`, serial | pass, fitted hash `ef2b783a...`, area `391,605.850174 mm2`, 0 cavities, 55.7 s (recorded baseline about 53.0 s; single samples, within run-to-run noise) |
| Mixed-61 two-sheet invariance sample (900x1800, 1000x1300) | same fitted hash `ef2b783a...`, byte-identical SVGs, SHA-256 `febad20a...`, matching the recorded pre-capacity sample |
| Archive admission + portfolio unit tests | pass |

The proof-only preflight adds one exact pass over the prepared transform sets
(8-18 ms on the tested fixtures) to roomy-sheet runs; the complete archive,
its ranking, hashes, and winners are unchanged, and a paired direct-portfolio
run with and without the capture callback produces identical role statuses,
consumed evaluations, and endpoint hashes (unit-tested).

## Constrained Capacity Evidence

`pnpm gate:capacity` runs the constrained fixtures through the full
production coordinator. All checks pass: expected routing, exact partitions,
`capacity_subset_settled`, zero auxiliary placement evaluations, and
prefix-not-below-cold-only. Renders and the combined report are committed
under `docs/artifacts/intrinsic-capacity-v1/`.

| Fixture | Routing | Placed/Total | Settlement | Selected origin | Cavities | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2x 80x60 rect, pad 10, 100x100 | preflight proven (area) | 1/2 | exhausted | cold | 0 | archive bypassed |
| 150x20 + 90x20 rect, 100x100 | preflight proven (singleton `150x20`) | 1/2 | exhausted | cold | 0 | archive bypassed |
| 2x 55x55 square, 100x100 | bounded archive miss | 1/2 | exhausted | tie (identical geometry) | 0 | incumbent count 1 equals cold |
| 90x90 + 2x 50x45, 100x100 | preflight proven (area) | 2/3 | exhausted | cold | 0 | skip successor drops the large piece for two smaller |
| Triangle-20, pad 10, 300x300 | bounded archive miss | 15/20 | exhausted (48,167 evals) | cold | 0 | incumbent depth-10 (10 placed) beaten by cold 15 |
| Mixed-61, 500x400 | preflight proven (area) | 15/61 | evaluation-cap (50,000) | cold | 0 | archive bypassed; 1.5 s total |
| Mixed-61, 700x560 | bounded archive miss | 30/61 | evaluation-cap (50,000) | prefix incumbent depth 30 | 0 | cold-only arm reaches only 15/61 |

Key canonical identities (production arms):

- Triangle-20 300x300: `2e40031e62bd3956...`, q0, material `31,500 mm2`;
- Mixed-61 500x400: `00aa5ecfd03a1358...`, q90, material `125,177.508918 mm2`;
- Mixed-61 700x560: `11e64e37a3c91334...`, q0, material `171,261.116052 mm2`.

## Performance Profile And Paired Comparisons

Separately measured phases (production arms, cold runs):

| Phase | Triangle-20 300x300 | Mixed-61 500x400 | Mixed-61 700x560 |
| --- | ---: | ---: | ---: |
| Proof-only preflight | 8.2 ms | 15.8 ms | 18.1 ms |
| Unchanged complete archive | 1,152 ms | bypassed | 54,326 ms |
| Prefix capture + terminalization | 12.2 ms | 0 ms | 41 ms |
| Cold capacity search (incl. endpoint materialization) | 1,153 ms | 1,449 ms | 1,459 ms |
| Consumed placement evaluations | 48,167 | 50,000 | 50,000 |
| Auxiliary placement evaluations | 0 | 0 | 0 |
| Total cold runtime | 2.3 s | 1.5 s | 55.9 s |

Paired production versus cold-only arms:

- **No prefix speedup is claimed.** On every paired fixture the incumbent
  pruned zero cold states (count-first beam retention keeps attainable counts
  above the incumbent until terminal depths) and consumed evaluations were
  identical (48,167 / 50,000 / 50,000); elapsed differences were noise-level.
  The strict attainable bounds are quality-safe but currently inert as
  pruning devices.
- **Prefix reuse decisively improves quality when the cap binds early.** On
  Mixed-61 700x560 the cold search settles at depth 15 of 61 under the
  50,000-evaluation cap (15 placed, `125,177 mm2`), while the depth-30
  committed prefix terminalizes into a zero-cavity incumbent with 30 placed
  and `171,261 mm2` for 41 ms and zero placement evaluations. On small and
  medium fixtures where the cap does not bind, cold output equals or beats
  every incumbent, and prefix-enabled output never ranked below cold-only
  anywhere (gate-checked).

The cheap-fanout design keeps the cold search at roughly 34,000 candidate
evaluations per second on Mixed-61 geometry; the 50,000-evaluation cap, not
elapsed time, is the binding budget. No eager anchored-state construction was
reintroduced anywhere on the complete path, and the capacity search builds at
most `fanout` states per retained state per depth.

## Trace Interpretation

`capacityTrace` on the compute result records routing, the exact preflight
measurements (integer doubled areas as `bigint`), descriptor
capture/fitting/rejection counts and depths, the incumbent identity, cold
bounds and consumed evaluations, both prune counters, dedup and fit-rejection
counters, completed depths, settlement, and the selected endpoint identity.
The additive diagnostics codes (`capacity_preflight_proven_impossible`,
`capacity_preflight_inconclusive`, `complete_archive_fitted`,
`bounded_complete_archive_miss`, `capacity_subset_settled`) carry bounded
human-readable summaries into the ordinary result stream; the portfolio
termination reason `capacity_subset_settled` marks capacity results, and
`unplacedPieceIds` reports the honest remainder. Fit-rejection counters read
as sheet pressure: 30,017 of 48,167 candidate evaluations on Triangle-20
300x300 failed the exact partial fit, confirming the sheet, not the beam, is
the binding constraint there.

## Rejected Alternatives And Falsification Evidence

1. **Contact-aware fanout (`capacity-contact-band-fanout`, preserved
   branch).** Builds every fitting candidate state so the fanout can rank
   with the complete-path shared-boundary contact term. Same-fixture
   comparison against the production cheap-envelope fanout:

   | Fixture | Cheap fanout (production) | Contact fanout (experiment) |
   | --- | --- | --- |
   | 2x 55x55 squares | 1 placed, cold 3.3 ms | 1 placed, cold 4 ms |
   | count-vs-material | 2 placed, cold 10.9 ms | 2 placed, cold 36 ms |
   | Triangle-20 300x300 | 15 placed, `31,500 mm2`, cold 1,153 ms | 15 placed, `31,500 mm2`, cold 2,569 ms |
   | Mixed-61 500x400 | **15 placed, `125,177 mm2`**, cold 1,449 ms | 14 placed, `120,377 mm2`, cold 3,209 ms |
   | Mixed-61 700x560 | incumbent 30 placed, cold 1,459 ms | incumbent 30 placed, cold 5,723 ms |

   The contact term never improved a constrained endpoint, regressed
   Mixed-61 500x400 by one placed piece and `4,800 mm2` of material under
   the same evaluation cap (contact-heavy successors spend capped
   evaluations without helping count or material), and cost 2-4x cold-search
   time by reintroducing per-candidate state construction. The hypothesis is
   falsified; the cheap exact-envelope fanout is the production rule.
2. **Waste-factor preflight.** Rejected by contract: the preflight must stay
   a proof; every routing decision beyond the two exact proofs belongs to the
   bounded search.
3. **Warm prefix beam.** Rejected by contract and by the paired evidence:
   terminalized incumbents already capture the useful prefix value (30/61 on
   Mixed 700x560) without consuming any cold budget.
4. **Dalsoo-style feature-contact candidate generator and other open-source
   transfers.** The tracked source reviews were sufficient for every design
   decision in this work; no disputed choice required a fresh upstream
   inspection. The transferable patterns already present (skip/fill phases,
   bounded constructor portfolio, rotation-family coverage) are what the
   capacity search composes.

## Roadmap Interactions

- **Enabled:** the wider correctness/corpus freeze can now include
  constrained-sheet cases (`gate:capacity` is the seed); identical-sheet
  continuation has its required exact partition and settlement primitives.
- **Made unnecessary:** any separate "reject infeasible requests" product
  path; the preflight proofs subsume it honestly.
- **Product interaction:** the CFG-144 manual run/subrun prototype
  (`docs/planning/cfg144-csv-subruns.md`) consumes exactly the honest
  placed/unplaced partition that capacity endpoints now guarantee; the
  deferred identical-sheet continuation is its automated counterpart.
- **Seams worth keeping:** `onDirectConstructed` is the generic read-only
  committed-lineage tap that later archive-seeded destroy/repair work can
  reuse; the capacity endpoint comparator is the single place a future
  multi-sheet continuation would rank per-sheet remainders.
- **Still deferred until their triggers:** identical-sheet continuation,
  cavity-first two-piece scheduling, destroy/repair, hull steering, GA,
  broader periodic representation. Nothing in capacity v1 blocks them.

## Remaining Risks And Ranked Next Steps

1. **Evaluation-cap depth starvation on large requests.** 50,000 evaluations
   reach only ~15 of 61 Mixed depths; prefix incumbents mask this when the
   archive ran, but a proven-impossible large request gets the capped cold
   result only. Next: evidence-triggered per-depth budgeting or piece-count-
   scaled caps, only through the documented bound-change process.
2. **Inert incumbent pruning.** The strict bounds never fired; if profiling
   ever shows cold-search time mattering, a sound count-aware retention bound
   would need its own proof.
3. **Sheet-invariance matrix remains incomplete** (pre-existing); the
   two-sheet sample is preserved exactly.
4. **Suite hygiene:** 40 pre-existing failing tests outside the production
   gates should be triaged separately.

## Portable Evidence

- `docs/artifacts/intrinsic-capacity-v1/manifest.json` (SHA-256 of every
  artifact);
- `capacity-triangles20-300x300-production.{svg,png}`;
- `capacity-mixed61-500x400-production.{svg,png}`;
- `capacity-mixed61-700x560-production.{svg,png}`;
- `capacity-archive-miss-squares2-production.{svg,png}`;
- `gate-report.json` (combined strict gate output with full capacity traces).

## Merge Recommendation

```text
APPROVE WITH FOLLOW-UPS
```

The contract is implemented exactly, every falsifier test passes, all three
complete baselines and the two-sheet invariance sample are preserved
bit-for-bit, constrained behavior is honest and deterministic, and the paired
evidence quantifies prefix reuse truthfully (quality when the cap binds;
no speedup claim). Follow-ups: track the evaluation-cap starvation risk on
large proven-impossible requests and triage the pre-existing failing tests.
