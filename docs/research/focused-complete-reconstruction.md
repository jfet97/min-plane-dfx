# Focused Complete Reconstruction

Status: promoted candidate with two exact reproductions and current-source
portable artifacts.

## Question

The accepted Shapes-17 complete endpoint placed all `17/17` pieces legally, but
its `304,499.845650 mm2` envelope contained ten isolated pieces and was visibly
scattered. Could a small generic complete producer reuse that settled exact
geometry as construction information, rebuild it under the unchanged intrinsic
objective, and improve quality without weakening the protected complete
contract?

The experiment deliberately excluded:

- fixture IDs or shape-family thresholds;
- requested-sheet dimensions in construction or ranking;
- a wider production beam;
- changed candidate geometry or legality;
- changed `sortPiecesForNesting` behavior;
- partial endpoints competing with complete endpoints.

## Strategy probe

The probe reconstructed the same complete piece set from the settled protected
endpoint under deterministic geometry-derived orders. The explored roles
included q0/q90 left-to-right and right-to-left orders, vertical orders,
topology orders, gap-contained variants, and a large-first control. Every role
used the existing exact strict decoder and entered the same complete archive.

The large-first control duplicated the existing effective order and consumed
zero work. The full family found the same best endpoint in three independent
runs, but cost about `39,698` candidate evaluations and `8.3 s` of
reconstruction. The single generic
`endpoint-q90-right-to-left` role reproduced that endpoint with `8,035`
candidate evaluations in about `1.7 s`, so only that role was integrated.

The role means:

```text
settled sheetless complete endpoint
    -> rigid q90 coordinate frame
    -> order pieces by rightmost position first
    -> rebuild through the existing exact strict constructor
    -> submit the legal completion to the complete archive
```

It does not move pieces in place and it does not prefer a sheet edge. The q90
frame is derived from the intrinsic endpoint itself.

## Result

| Metric | Protected source | Focused winner | Change |
| --- | ---: | ---: | ---: |
| placed pieces | 17/17 | 17/17 | unchanged |
| canonical envelope area | `304,499.845650` | `281,233.148068` | `-7.64%` |
| maximum side | `559.975` | `532.691` | `-4.87%` |
| canonical cavities | 0 | 0 | unchanged |
| isolated pieces | 10 | 4 | `-6` |
| positive-contact components | 13 | 7 | `-6` |
| canonical hash | `c640c06f...` | `1ddc8426...` | distinct exact geometry |

The complete archive, not the producer, makes the final decision. A duplicate,
incomplete, evaluation-capped, deadline-censored, invalid, or losing
reconstruction leaves the settled protected endpoint authoritative.

## Production boundary

Focused reconstruction is enabled by default only after exact preflight and
the protected complete archive have produced a fitting endpoint. It has a
`12,000`-evaluation and `15 s` safety bound. Proof-impossible requests and
requests with no fitting protected endpoint record a zero-work skip and
continue through the existing capacity path.

The source is always the unfiltered settled sheetless leader. Requested-sheet
fit is checked separately. The `540 x 580` boundary proves this distinction:

| Arm | Source | Final selection | Area | Runtime |
| --- | --- | --- | ---: | ---: |
| focused default | sheetless leader `c640c06f...` | `1ddc8426...` | `281,233.148068` | `12.432 s` |
| explicit disable | no reconstruction | lower fitting protected `104f99ee...` | `310,542.212676` | `10.542 s` |

The original leader is about `543.774 mm` on its shorter side and cannot fit
the `540 mm` dimension. Reconstructing that same sheetless leader produces the
`532.691 x 527.948 mm` winner. This is a fit consequence after intrinsic
construction, not sheet-driven ranking.

Cancellation is propagated through the existing geometry control. Other
focused-producer failures record a protected-fallback trace and do not turn a
valid protected Compact result into a failed job. The trace keeps separate
source, candidate, and actual final-selected hashes plus exact evaluation
accounting.

## Reproduction matrix

Two sequential strict nine-case runs from
`acb418629cf4f494f5322829cc04cc9f859b3a4a` passed every hash, partition,
cavity, scheduler-chronology, focused-terminal, accounting, and archive
selection check. Their normalized per-case digests were identical.

The first run measured:

| Fixture | Sheet | Placed | Area | Runtime | Focused result |
| --- | --- | ---: | ---: | ---: | --- |
| Triangle-20 | `2000 x 2700` | 20/20 | `74,428.143126` | `14.942 s` | duplicate, zero work |
| Mixed-61 | `2000 x 2700` | 61/61 | `391,605.850174` | `69.361 s` | capped, protected fallback |
| Shapes-17 | `2000 x 2700` | 17/17 | `281,233.148068` | `12.658 s` | selected, `8,035` evaluations |
| Triangle-20 | `600 x 400` | 20/20 | `74,428.143126` | `14.749 s` | duplicate, zero work |
| Mixed-61 | `600 x 400` | 25/61 | `239,484.966600` | `4.591 s` | exact-preflight skip |
| Shapes-17 | `600 x 400` | 14/17 | `232,178.021694` | `12.874 s` | no-fitting-complete skip |
| Triangle-20 | `300 x 300` | 17/20 | `78,811.504488` | `15.841 s` | no-fitting-complete skip |
| Mixed-61 | `300 x 300` | 6/61 | `89,504.369008` | `1.338 s` | exact-preflight skip |
| Shapes-17 | `300 x 300` | 5/17 | `87,791.951625` | `3.030 s` | exact-preflight skip |

The focused stage adds about `1.7 s` on the selected Shapes roomy case and
about `2.4 s` on roomy Mixed before its deterministic cap. It adds no
evaluations on constrained cases where preflight or complete fit makes it
inapplicable. Mixed-61 `700 x 500` remains the exact `48/61` intertwined
capacity result and records a zero-work no-fitting-complete skip.

Shapes-17 on `600 x 600`, `2000 x 2700`, `5000 x 5000`, and
`10000 x 10000` selects the same `1ddc8426...` canonical geometry with exactly
`8,035` focused evaluations. This preserves the roomy-sheet invariance
boundary.

## Open-source lessons and next boundary

The locally pinned source review supports one later, separate experiment:
reserve one fixed-width construction survivor slot for a geometrically
distinct, pending-aware complete state. libnest2d motivates using remaining
pieces when assessing a current placement; Sparrow motivates protected basin
diversity and explicit phase budgets; Deepnest/SVGnest motivate bounded
deterministic outer-order diversity; PackingSolver motivates deterministic
portfolio accounting.

None justifies importing random GA mutation, overlap states, strip-width
fitness, iterative restart-based widening, or greedy leave-pending semantics.
The focused producer should settle first. A construction-time diversity lane
is warranted only if traces identify a useful state being generated and
discarded before completion.

## Evidence

- current nine-case reports and renders:
  [`../artifacts/current-compact-baselines/`](../artifacts/current-compact-baselines/);
- enabled/disabled fit boundary:
  [`../artifacts/focused-complete-reconstruction-boundary/`](../artifacts/focused-complete-reconstruction-boundary/);
- immutable reproductions:
  `/private/tmp/min-plane-provenance/focused-complete-promotion-acb4186/run-1`
  and `run-2`;
- extra sheet gates:
  `/private/tmp/min-plane-provenance/focused-complete-promotion-acb4186/extra`.
