# Whole-beam topology diversity experiment

This report preserves a rejected production candidate that remains useful
research evidence. The experiment was performed in an isolated worktree and
was not merged into `main`.

## Provenance

- branch: `beam-topology-diversity`
- base commit: `aa7a264`
- exact implementation commit: `a2dac6accca6a5f73382db431c3e3042feb215a8`
- fixture: `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
- settings: rotations and mirroring enabled; reorder `4`; beam `8`; fanout
  `4`; transform cap `8`; local repair disabled
- environment: Node `24.16.0`; pnpm `11.8.0`; Electron `33.4.11`
- portable manifest:
  [`../artifacts/beam-topology-diversity/manifest.json`](../artifacts/beam-topology-diversity/manifest.json)

The focused gate passed all 36 tests in these files:

- `tests/unit/irregularTriangleCompactGolden.test.ts`
- `tests/unit/irregularWindowedBeam.test.ts`
- `tests/unit/decisionTraceNdjson.test.ts`

The exact triangle golden therefore remains green under this experiment.

## Hypothesis

After whole-layout scoring and geometry deduplication, keep two different
whole-beam extremes inside the configured beam width:

1. a contact-graph survivor, ranked by structural contacts and normalized
   contact units;
2. a distinct dense-envelope survivor, ranked by intrinsic maximum bounds
   side, area, span, hull waste, and holes.

The new orders contain no fixture identities, shape identities, or sheet
dimensions. They consume existing beam slots rather than widening the beam.

## Mixed61 results

All runs placed 61 of 61 pieces.

| Sheet | Envelope (mm) | Area (mm2) | Hull waste | Dominant contacts | Contact units | Holes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1000 x 1300 | 495.782 x 980.562 | 486144.760 | 0.300500 | 10 | 53.560 | 4 |
| 1000 x 1700 | 638.107 x 856.807 | 546734.293 | 0.316913 | 14 | 64.771 | 2 |
| 2000 x 1700 | 736.296 x 765.925 | 563947.709 | 0.326260 | 15 | 67.161 | 0 |
| 2000 x 2700 | 1291.377 x 1299.056 | 1677571.040 | 0.690241 | 19 | 65.230 | 0 |

Rendered layouts:

- [1000 x 1300 SVG](../artifacts/beam-topology-diversity/pair-b/mixed-61-1000x1300.svg)
  and [PNG](../artifacts/beam-topology-diversity/pair-b/mixed-61-1000x1300.png)
- [1000 x 1700 SVG](../artifacts/beam-topology-diversity/pair-a/mixed-61-1000x1700.svg)
  and [PNG](../artifacts/beam-topology-diversity/pair-a/mixed-61-1000x1700.png)
- [2000 x 1700 SVG](../artifacts/beam-topology-diversity/pair-b/mixed-61-2000x1700.svg)
  and [PNG](../artifacts/beam-topology-diversity/pair-b/mixed-61-2000x1700.png)
- [2000 x 2700 SVG](../artifacts/beam-topology-diversity/pair-a/mixed-61-2000x2700.svg)
  and [PNG](../artifacts/beam-topology-diversity/pair-a/mixed-61-2000x2700.png)

## Decision

Reject the implementation for production. The `2000 x 2700` result is a
catastrophic perimeter layout: it has the highest dominant-contact count and
zero measured holes, yet also has `0.690241` hull waste and a `1.68 million
mm2` envelope. Exact contact-graph extremeness is not a reliable proxy for
density.

Retain the hypothesis as research input. This failure means the current code is
unsafe to ship; it does not show that whole-beam diversity is useless. The
triangle lattice remains exact, and three sheets avoid the old worst chain
behavior. A follow-up may combine the topology survivor with Pareto or envelope
guards, or use a different decoder or final selector. The same distinction
applies to Candidate L and L2: failing a protected golden blocks direct
production use but does not erase coherent intrinsic-ranking ingredients that
could work when another mechanism protects or rebuilds the lattice.

## Artifact hashes

| Artifact | SHA-256 |
| --- | --- |
| `manifest.json` | `4aae25c98ab82162c8ddc7572ff066f66d110f02201efb4a86b504ce4d8b1051` |
| `pair-a/mixed-61-1000x1700.svg` | `01be9f2a80e3e031b9841d58b1b4279a9121813bd8ee3b38b9ba23b2f1eda2c1` |
| `pair-a/mixed-61-1000x1700.png` | `9afa61194b407d37adafb9c7e119348fbb11ced28742e2e0267f712c638945df` |
| `pair-a/mixed-61-2000x2700.svg` | `3ca65d7c81cc2adfa329da4038757081d354f83d45a4b255c35a9eca7e505a81` |
| `pair-a/mixed-61-2000x2700.png` | `d9d390cabb360f64a4575c3aa94213384d8ae06a9cca26e29d64370a00ab40b9` |
| `pair-b/mixed-61-1000x1300.svg` | `5ac8239f93cdeda8762cb3db440c2648bd44b77bcbd18f1f77d25865ff6ebee3` |
| `pair-b/mixed-61-1000x1300.png` | `8ffef89630157f55d2713eeec8df166ba9acfa52670be9986ce7470ef749aab5` |
| `pair-b/mixed-61-2000x1700.svg` | `7f82f7cb766ce078dc9bbfee7ba9563dd14365d93f3d4eafae65f37c93854b50` |
| `pair-b/mixed-61-2000x1700.png` | `fb9652e78686ca0959ef318aac3a537fc3aced9748e7c3fe0325b4650cbaffbd` |
