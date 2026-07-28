# Irregular Nesting Artifacts

This tree preserves portable manifests, reports, SVGs, and PNG renders for
accepted and rejected experiments. Metrics belong to the commit and status
named by each artifact set; most are historical and are not current production
baselines.

## Current Production Evidence

- [`current-compact-baselines/`](./current-compact-baselines/): complete,
  Chromium-rendered PNG, SVG, and JSON evidence for the nine durable Compact
  baselines: Triangle-20, Mixed-61, and Shapes-17 on `2000 x 2700`,
  `600 x 400`, and `300 x 300`.
- [`compact-short-side-directional-contract/`](./compact-short-side-directional-contract/README.md):
  the current strict sequential 18-layout Compact/Short Side gate. All nine
  Short Side cells contain independently constructed directional geometry,
  preserve the Compact-selected piece partition, and have no Compact fallback.
- [`focused-complete-reconstruction-boundary/`](./focused-complete-reconstruction-boundary/):
  enabled/disabled Shapes-17 `540 x 580` evidence proving that focused
  reconstruction starts from the sheetless complete leader even when a
  different protected endpoint is the first one that fits.
- [`intrinsic-capacity-v1/`](./intrinsic-capacity-v1/): constrained-sheet
  capacity gate evidence — sheet-outline SVG/PNG renders of representative
  exact partial layouts, the combined strict `gate:capacity` report with full
  capacity traces, and the artifact manifest.
- [`intrinsic-anytime-pinned-lane/`](./intrinsic-anytime-pinned-lane/): accepted
  experimental evidence for one protected resumed warm lane, including the
  three constrained falsifiers and the exact six-baseline matrix.
- [`capacity-retention-quality-guard/`](./capacity-retention-quality-guard/README.md):
  the protected capacity-quality continuation evidence, including the 50- and
  59-piece Mixed-61 layouts and the unchanged 18-layout matrix.
- [`current-production-invariance-matrix/`](./current-production-invariance-matrix/):
  two complete strict runs of the ten-sheet Mixed-61 production matrix at
  `6179cef`, including exact reports and byte-identical SVG/PNG renders.
- [`intrinsic-shared-archive-quality/`](./intrinsic-shared-archive-quality/):
  archive-quality calibration that established the current Triangle-20 and
  Mixed-61 area floors before production integration.
- [`shapes-17-baseline/`](./shapes-17-baseline/): the all-distinct Shapes-17
  archive baseline.
- [`compact-short-side-observer/contact-strip/`](./compact-short-side-observer/contact-strip/README.md):
  historical short-side promotion evidence, including the rejected-shelf
  versus accepted contact-strip comparison for the targeted Mixed-61
  `2000 x 2700` case and the retained measurements of the two contact strips
  that were rejected.
- [`linear-ring-topology/`](./linear-ring-topology/): the per-function
  measurements that decided which of four candidates survived, the historical
  paired summaries, the guarded topology decision, and the complete accepted
  18-layout final-review bundle.
- [`compact-short-side-area-cost-guard/`](./compact-short-side-area-cost-guard/README.md):
  historical 18-layout evidence for the area-cost honesty guard at
  `903657e`, with the two vetoed roomy siblings retained as quality-protected
  Compact fallbacks and zero directional misses.
- [`compact-short-side-contact-tie-break/`](./compact-short-side-contact-tie-break/README.md):
  historical 18-layout evidence for the bounded contact-aware strip
  tie-break at `51befe5`, with the flagship strip's connectivity strictly
  improved at an identical envelope and zero directional misses.
- [`trusted-ring-validation-memo/`](./trusted-ring-validation-memo/): paired
  Mixed-61 gate reports, the 18-layout SVG digest comparison, and the cache
  telemetry showing a `98.2%` pairwise NFP hit rate, for the change that stopped
  revalidating rings the trusted path had already proven.
- [`pure-irregular-core-stage1/`](./pure-irregular-core-stage1/): the strict
  sequential 18-layout parity gate for the first Effect- and Schema-free
  pairwise NFP core seam, with all reports, SVGs, PNGs, manifest, and checksums.
- [`pure-irregular-core-stage2/`](./pure-irregular-core-stage2/): the independent
  strict 18-layout parity gate for pure IFP and transformed-collision cache
  resolution, including complete reports, SVGs, PNGs, manifest, and checksums.
- [`pure-irregular-core-stage3/`](./pure-irregular-core-stage3/): the strict
  18-layout parity gate after separating trusted runtime geometry carriers from
  Effect Schema boundary models, including reports, SVGs, PNGs, manifest, and
  checksums.

The executable current gates, including the fitted Mixed production hash, are
documented in
[`../operations/irregular-production-gates.md`](../operations/irregular-production-gates.md).

## Shared-Archive and Periodic Research

- [`deterministic-periodic-budget/`](./deterministic-periodic-budget/)
- [`periodic-audit-speed/`](./periodic-audit-speed/)
- [`intrinsic-shared-archive-step4/`](./intrinsic-shared-archive-step4/)
- [`v7-search-redesign/`](./v7-search-redesign/)

These sets preserve source-survival, deterministic-budget, performance, and
archive-selection evidence, including rejected or non-production endpoints.

## Historical Ordinary-Decoder Research

- [`candidate-l-audit/`](./candidate-l-audit/)
- [`candidate-l-recombination/`](./candidate-l-recombination/)
- [`beam-topology-diversity/`](./beam-topology-diversity/)
- [`bounded-ga-order-rotation/`](./bounded-ga-order-rotation/)
- [`small-piece-gap-diversity/`](./small-piece-gap-diversity/)
- [`protected-boundary-anchor/`](./protected-boundary-anchor/)
- [`protected-intrinsic-contact-seed/`](./protected-intrinsic-contact-seed/)
- [`protected-pareto-frontier-lane/`](./protected-pareto-frontier-lane/)

The protected-lane artifacts remain useful causal evidence for the ordinary
requested-sheet decoder. They are not accepted Compact quality production
outputs at `b506344`.

## Retired Fixed-Reference Handoff

[`canonical-reference-decode-handoff/`](./canonical-reference-decode-handoff/)
preserves the immutable ten-sheet result from commit `5186255`: area
`430,344.917527 mm2`, two sheet-space holes, and `53/14` structural contacts.
That evidence belongs to the deleted fixed-reference coordinator and must not
be used to claim current archive-only ten-sheet invariance.

## Provenance Notes

Artifact manifests are immutable run records. A manifest may retain an original
`help/artifacts/...` source path or `/private/tmp/min-plane-provenance/...` path
because changing it would falsify the recorded run. Documentation links use the
current `docs/artifacts/` location.

The topic-level interpretation lives in
[`../history/search-quality-decisions.md`](../history/search-quality-decisions.md)
and [`../history/sheet-invariance-decisions.md`](../history/sheet-invariance-decisions.md).
