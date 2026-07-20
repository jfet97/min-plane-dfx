# Pre-V7 Exactness And Retained Search Foundations

Date: 2026-07-20

## Scope

This checkpoint isolates three commits on top of the V6.2 tournament record at
`970cfff`:

- `13396c5`: canonical-grid Clipper2 legality becomes authoritative for
  intrinsic pressure endpoints and projection identity; terminal contact,
  envelope, and hull certificates are recomputed from the same snapped
  geometry;
- `34f0338`: selectively retains the useful A/C/D/E/F/G/H mechanisms without
  importing their rejected whole variants;
- `66cfdba`: preserves the observer-only structural E1 exactness control in the
  report-facing portfolio outcome.

The implementation is still experiment-only. It does not contain a V7
coordinated multi-piece move and must not be merged wholesale into `main`.

The open-source control for the intended mechanisms remains
[`open-source-nesting-strategies.md`](./open-source-nesting-strategies.md).

## Immutable Evidence

Source commit: `66cfdbad45fc2819b129ea5eabfad5bb08922615`

Root:
`/private/tmp/min-plane-provenance/pre-v7-final-66cfdba/`

### Triangle-20 intrinsic diagnostic

- report: `triangle-20/report.json`, SHA-256
  `8ba6079d739a5ce5985b37280d7c912922fd1113a12c0167b65c3380502ea75b`;
- manifest: `triangle-20/manifest.json`, SHA-256
  `2cf0d9c3c79bd12a343dfa3151d874e37c5c335ff18b48338c45e1367bf92f30`;
- PNG: `triangle-20/triangle-20-e4-2000x2700.png`, SHA-256
  `8169fbb08c03ff5c83dde5badf401c4a04fbdfecdd7545f55e88cd915df44403`.

### Mixed-61 intrinsic diagnostic

- report: `mixed-61/report.json`, SHA-256
  `2fc97e2ecc9238d5688c8c80c182babc7a6d00bf0b79904b6531a6bdb1c1886d`;
- manifest: `mixed-61/manifest.json`, SHA-256
  `6fdf83717cd93aa81898f30359447003074832023f0faad933251e09816930ca`;
- PNG: `mixed-61/mixed-61-e4-selected-2000x2700.png`, SHA-256
  `e9571155d2e40c3a4c790828a22e5c76a7fa247d28c78361f026b2b1113625b0`.

## Result

The checkpoint is a correctness and search-observability improvement, not a
layout-quality solution. Both fixtures still select their exact E1 fallback,
and both selected SVG hashes are byte-identical to the preceding `13396c5`
checkpoint. Mixed-61 remains the invariant but weak `418,956.352 mm2` layout
with hull-gap ratio `0.224149`, 26 isolates, and 22/4 structural contacts. The
Triangle-20 intrinsic diagnostic remains `116,964.311 mm2` with hull-gap ratio
`0.370575` and 2/2 contacts. Neither is the approved production triangle
golden.

The three existing exact projected Mixed candidates are also unchanged. They
remain either E1-equivalent or less cohesive, so the portfolio correctly keeps
E1.

## Exactness Finding

The structural E1 control proves the suspected authority split on the real
Mixed fixture:

- SAT raw and weighted loss: `4.221362181058115e-31`;
- SAT conflicts: 2 pair conflicts involving 4 pieces;
- SAT exact-zero: false;
- canonical identity and piece coverage: exact match;
- Clipper2 canonical legality: true;
- classification: `sat-conflict-canonical-legal`;
- registered search-budget cost: 0;
- selection eligibility: false.

Triangle-20 is the clean control: SAT reports zero loss and zero conflicts and
Clipper2 agrees that the layout is legal. Across all selected contracted
intermediates, no SAT-clear/Clipper2-illegal false accept occurred. The real
Mixed control therefore confirms that SAT must remain a movement heuristic and
must not own exact endpoint legality.

## Retained A-H Mechanisms

### A: accounting and existing-first deduplication

The trace now attributes every composite candidate by source, pass, ordinal,
orientation family, transform, and canonical pose. It also records generated,
materialized, unique, evaluated, incident-clear, globally-clear, selected, and
cap-skipped counts. This made the G result below directly falsifiable.

### C: bounded forward/reverse collider order

Both orders ran 60 composite parents per fixture under one shared cap. No run
hit the evaluation cap or deadline. Reverse order provided real diversity: it
produced the best local sweep result in 6 of 12 Triangle sweeps and 3 of 12
Mixed sweeps. Relative to `13396c5`, best Mixed raw loss improved at all three
contraction ratios:

| ratio | before | after | change |
| --- | ---: | ---: | ---: |
| `1/20` | `0.188600336` | `0.134293790` | `-28.8%` |
| `1/40` | `0.047162800` | `0.035725101` | `-24.3%` |
| `1/80` | `0.013222291` | `0.010088866` | `-23.7%` |

Triangle improved at `1/40` and `1/80` but regressed at `1/20`. No order
reached a canonical-legal contracted endpoint.

The cost is material. Separation evaluations increased from 8,467 to 21,723 on
Triangle and from 12,260 to 31,420 on Mixed. Runtime increased from about
`1.01 s` to `2.84 s` on Triangle and from `26.87 s` to `38.46 s` on Mixed.
The quality/time trade remains acceptable for an experiment but should become
adaptive before production.

### D/H: conflict and survival diagnostics

All 120 composite children per fixture were emitted. Outer retention kept 66
Triangle and 69 Mixed children; the rest were capacity-pruned. The best
endpoints survived, so failure is not explained by a lost winning descendant.

The new tuples reconfirm conflict fragmentation. For Mixed, the best `1/20`
raw-loss state moved from 27 to 33 pair conflicts and from 26 to 29 conflicted
pieces. The best `1/40` state moved from 15 to 17 pairs and 17 to 20 pieces;
the best `1/80` state moved from 15 to 16 pairs and 20 to 23 pieces. The
squared penetration objective still exchanges deep overlaps for more shallow
overlaps instead of coordinating their removal.

### G: adaptive transform-family coverage

The adaptive generator emitted 13,944 Triangle and 20,776 Mixed candidates,
but existing-first canonical deduplication found **zero unique candidates**.
None was evaluated or selected. In the current single-piece neighborhood, G
adds no reachability; existing focused transform proposals already contain the
same canonical states. Retain its typed generator and attribution for V7, but
do not pay its generation cost unconditionally before a coordinated move
creates a new context.

### F: canonical control

F now runs in the real controller and survives the portfolio/report boundary.
It is observer-only and proved the Mixed SAT false rejection described above.

### E: two-radius refinement

The 16-position two-radius generator is present only as a typed, tested dormant
API. The real pressure loop has no call site, so E cannot affect current runtime
or selection. It remains reserved for a promising V7 coordinated endpoint.

## Production Golden Differential

`tests/unit/irregularTriangleCompactGolden.test.ts` fails identically at the
untouched `970cfff` base and at `66cfdba` (`short side 305.631 > 228`), while it
passes on current `main` at `ac32e94`. The regression therefore predates all
three commits in this checkpoint, but it proves the long experiment branch
cannot be merged wholesale. Any promotion must selectively replay the intrinsic
files on current `main` and rerun the production golden before acceptance.

## Open-Source Interpretation And V7 Boundary

The measurements sharpen the source review rather than contradict it:

- Sparrow's useful difference is coordinated container contraction plus
  separation, disruption, and coordinate descent over an infeasible pool. The
  current code still composes isolated single-piece decisions; reversing that
  order improves descent but does not create cooperation.
- Deepnest and SVGnest separate deterministic geometric decoding from outer
  order/rotation diversity. C proves limited order diversity has value, but it
  is repair-order diversity inside one contracted state, not a replacement for
  a coordinated topology-changing move.
- libnest2d motivates transform-family coverage before truncation. G proves
  that adding family labels after the existing single-piece generator is too
  late because every state is already duplicated.
- PackingSolver motivates bounded portfolios and staged large/small handling.
  Earlier L1 evidence already proved filler access; the remaining defect is the
  large-piece skeleton, not the eight fillers.

The next implementation question is therefore not another scalar comparator.
It is whether V7 should introduce a bounded coordinated multi-piece transport
or coordinate-descent atom that can reduce a conflict component as a unit,
then reuse A/D/H accounting, C only when adaptive evidence justifies it, G in
the newly changed context, and E only around a genuinely promising endpoint.

## Reviewer Questions

1. Does the Clipper2-authoritative endpoint boundary have any false-accept or
   certificate-consistency defect?
2. Is the active dual-order implementation fair under its shared cap, and what
   adaptive trigger would preserve its measured value without the full cost?
3. Should G remain dormant until after a coordinated V7 atom, given zero unique
   states on both fixtures?
4. Compared directly with Sparrow and the other pinned sources, what is the
   smallest coordinated V7 move that changes reachability rather than merely
   reordering the same one-piece states?
5. Which parts of this checkpoint are safe to replay selectively on current
   `main`, given the pre-existing production-golden failure on the experiment
   ancestry?
