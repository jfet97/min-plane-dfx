# Protected boundary-anchor diversity

This experiment converts the most useful lesson from the contact-tier work into
an isolated whole-beam alternative. It is accepted as a bounded repair-disabled
quality improvement, not as a solution to sheet invariance.

## Provenance

- production base: `f68be50e724ffa40e059342f33168de7937b4f7c`
- experimental checkpoint: `680e9a55f38eca56684a46c20169279397edaffe`
- branch: `protected-boundary-anchor-diversity`
- net diff SHA-256: `9b02ded07ee4c94772dd49f69d7c71d0b2a0b12f08f93c2b2326790297a0ecd1`
- mixed-61 fixture SHA-256: `cf390e7a851eb1f267c5ff986032ce003372483863f3ed5e31d963bc24b95660`
- runtime: Node `v24.16.0`, pnpm `11.8.0`, Darwin arm64
- immutable artifacts:
  `/private/tmp/min-plane-provenance/boundary-anchor-current-base/`
- final corpus report:
  `/private/tmp/min-plane-provenance/boundary-anchor-current-base/680e9a5/corpus/report.json`
- decision trace:
  `/private/tmp/min-plane-provenance/boundary-anchor-current-base/680e9a5/mixed61-2000x2700.ndjson`

## Diagnosis

`95de72c` correctly removed translation-dependent noise from occupied-hull
waste. On mixed-61, that numerical fix also exposed a real deterministic tie:
production ranking kept one sheet-boundary anchor class and discarded another.
The discarded lineage is the ancestor of the compact two-hole motif.

This is not evidence that canonicalization should be reverted. It is evidence
that a numerically meaningless raw difference had accidentally supplied search
diversity. The replacement must retain canonical production ordering and keep a
bounded alternative lineage explicitly.

## Accepted mechanism

The production beam and incumbent lane remain unchanged. When beam width is
greater than one, no chromosome transform preference is active, and terminal
repair is disabled, the decoder may retain one additional boundary-anchor class
from a position-independent production-score tie. That seed owns a separate
protected lane of width eight.

The protected lane deliberately follows the pre-canonicalization legacy score
ordering, including raw hull waste, while the production lane continues to use
the canonical scorer. Cross-lane geometry deduplication always keeps the
production representative and only propagates eligibility flags. Production
and protected states are ranked and traced independently.

At the terminal boundary, both lane winners are oriented independently. The
protected winner may replace production only when it is:

1. strictly better under the production layout comparator; and
2. strictly smaller in collision-envelope area.

Terminal rotation scoring is cached, cooperatively cancellable, and emitted to
the decision trace only for the selected lane. The protected lane is disabled
when repair is enabled so it cannot alter the established repair-8 triangle
golden or repair-deadline semantics.

## Current-base corpus

The table compares the exact `f68be50` production geometry with `680e9a5`.
Runtime ratios are diagnostic single-run measurements, not stable benchmarks.

| Case | Compact sheet | Reference sheet | Holes change | Runtime ratio compact / reference |
| --- | --- | --- | --- | ---: |
| triangle-20 repair-8 golden | exact hash | exact hash | unchanged | `1.26x / 1.03x` |
| rectangles-20 | exact hash | exact hash | unchanged | `1.74x / 1.78x` |
| trapezoids-20 | area `-8.35%` | exact hash | unchanged | `1.96x / 1.92x` |
| pentagons-20 | exact hash | exact hash | unchanged | `2.03x / 1.92x` |
| star-hulls-20 | exact hash | exact hash | unchanged | `2.03x / 1.90x` |
| mixed-50 | exact hash | area `-1.31%` | reference `10 -> 7` | `1.97x / 1.98x` |
| mixed-61 | exact hash | area `-1.47%` | reference `10 -> 2` | `2.04x / 2.04x` |

The final mixed-61 reference result changes from `436,770.039 mm2`, 42 total
and 10 dominant structural contacts, and 10 holes to `430,344.918 mm2`, 53
total and 14 dominant contacts, and 2 holes. Its canonical geometry hash is
`40f8ac9c0fb24073ac141b5fb667366af55df90c78c6cca21ff76703a4a7f300`.

The other measured mixed-61 sheets retain current production geometry:

| Sheet | Envelope area | Holes | Candidate effect |
| --- | ---: | ---: | --- |
| `1000 x 1300` | `506,644.934 mm2` | 12 | exact current hash |
| `1000 x 1700` | `461,475.664 mm2` | 10 | exact current hash |
| `2000 x 1700` | `661,441.643 mm2` | 6 | exact current hash |
| `2000 x 2700` | `430,344.918 mm2` | 2 | promoted protected winner |

The candidate therefore improves the reference checkpoint without regressing
the other measured outputs, but it does not make mixed-61 sheet-invariant.

The repository reference render is
[`protected-boundary-anchor/mixed-61-2000x2700.svg`](../artifacts/protected-boundary-anchor/mixed-61-2000x2700.svg)
with a
[`PNG preview`](../artifacts/protected-boundary-anchor/mixed-61-2000x2700.png).
The portable
[`manifest`](../artifacts/protected-boundary-anchor/manifest.json) records the
source hashes, commands, runtime, reports, trace, and validation result.
Chromium inspection confirmed visible background margin on all four sides, no
truncation, one connected cluster, and the recovered two-hole motif.

## Rejected variants and what they proved

| Checkpoint | Variant | Result |
| --- | --- | --- |
| `797d080` / `9ace3ba` | score-tie boundary seed only | preserved the ancestor briefly but did not guide its descendants |
| `4caa2cf` | intrinsic compactness descendant order | confirmed protected guidance is necessary but selected a different lineage |
| `838607c` | exact contact-tier guard | too restrictive for the recovered path |
| `dca1f31` | raw-hull legacy ordering | recovered the intended ancestry and became the basis of the isolated lane |
| `8906f49` | width two | insufficient continuation diversity |
| `30b285c` | width four | missed mixed-61 target; `436,769.683 mm2`, 10 holes |
| `e30b640` | activate only on detected canonicalization loss | removed useful trapezoid and mixed-50 gains without materially reducing the expensive paths |
| `35ca946` | independent full-width lane | recovered the target; later review hardened isolation and terminal semantics |

The width-four failure is why the protected width remains eight. M2's two
global reservations should not be repeated: the accepted design spends no
production beam slots and cannot win through its private objective alone.

## Review and validation

The final diff passed lint, typecheck, 73 focused unit tests, the repair-8
triangle golden, the two-sheet corpus, the four-sheet mixed-61 gate,
and rendered inspection. The focused tests cover lane activation, propagation,
convergent deduplication, production-preferred representatives, Pareto
acceptance and rejection after orientation, terminal trace uniqueness, repair
disabling, deadline compatibility, and protected-terminal cancellation.

A persistent three-exchange review resolved seven major findings concerning
lane deduplication, terminal ranking, orientation order, trace ranks, repeated
hull work, missing control-path coverage, and duplicate uncheckpointed terminal
scoring. The final verdict was approved. The retained review log is
`/tmp/codex-review-chat-1784325904-501.md`.

## Remaining work

1. profile protected-lane expansion before changing its width or activation;
2. reduce runtime by sharing immutable geometry/scoring work across lanes,
   without merging their retention semantics;
3. continue the intrinsic max-side-first research inside a protected lane, not
   as a global local-fanout replacement;
4. solve the three unchanged mixed-61 sheets independently and require exact
   invariance plus contact/hole quality before claiming sheet independence;
5. keep the repair-8 golden and repair-0 diagnostic as separate gates.
