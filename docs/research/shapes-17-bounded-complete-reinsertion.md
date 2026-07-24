# Shapes-17 Bounded Complete Reinsertion

## Question

The accepted Shapes-17 complete endpoint places all `17/17` pieces with exact
legality and no cavities, but it remains visibly fragmented: ten pieces are
isolated and the positive-contact graph has thirteen components. This
experiment tested whether one bounded, generic terminal translation pass could
improve that complete layout without changing Compact construction or adding a
material runtime cost.

The implementation lived only on branch `complete-terminal-compaction`. It was
observer-only, sheetless, and never had output authority.

## Protected contract

- candidates used `sheetless-nfp`; requested-sheet dimensions did not generate,
  constrain, or rank them;
- only singleton positive-contact components were visited;
- every other placement remained frozen;
- candidates were measured as exact complete endpoints and compared through the
  unchanged complete Pareto/archive selector;
- censored work retained the protected seed and reported
  `outputInfluence: none`;
- no fixture identifier, dimension, or Shapes-specific threshold entered the
  algorithm.

The design was reviewed on retained Sol thread
`019f8f39-988e-78c0-aac0-ccc83ca8410c`. The final review log is
`/tmp/codex-review-chat-1784874795-shapes.md`.

## Control

Current `main` at `f555f459687153d22c17c459fc882e9f2ea85f89`
reproduced the protected endpoint:

| Placed | Hash | Area | Cavities | Compute | Process wall | Maximum RSS |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 17/17 | `c640c06f...` | `304,499.845650 mm2` | 0 | `10.532 s` | `11.00 s` | `568,098,816 B` |

The full and layout-cropped control previews are:

- `/private/tmp/min-plane-provenance/shapes-17-complete-quality-control/control-layout.png`
- `/private/tmp/min-plane-provenance/shapes-17-complete-quality-control/control.svg`

## Trial 1: all transforms

The preregistered `500 ms` / 512-candidate observer evaluated 95 exact
candidates but completed none of ten singleton neighborhoods. Its best censored
candidate reduced isolated pieces from 10 to 8 and hull-gap ratio from
`0.233591` to `0.226058`, but worsened area to `317,070.724425 mm2` and maximum
side to `566.223 mm`.

The run was censored, so the candidate never entered the settled archive.
Production remained byte-identical.

## Trial 2: incumbent orientation

Sol approved one final smaller neighborhood: preserve each incumbent's exact
rotation and mirror, choose the first matching prepared transform under the
existing deterministic transform order, and search translations only. Source
commit `64ac438fbc238260657265dbd32abd8fdb7bccbb` used a fixed `1,000 ms` /
512-candidate budget.

| Status | Completed neighborhoods | Exact candidates | Observer | Process wall | Maximum RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| deadline-censored | 3/10 | 199 | `1.009 s` | `12.13 s` | `559,824,896 B` |

The best censored candidate again moved Shapes-17 toward a more connected
contact graph but away from compactness:

| Metric | Protected | Best censored | Change |
| --- | ---: | ---: | ---: |
| isolated pieces | 10 | 8 | -2 |
| contact components | 13 | 12 | -1 |
| hull-gap ratio | `0.233591` | `0.222478` | -4.76% |
| envelope area | `304,499.845650` | `316,826.015350` | +4.05% |
| maximum side | `559.975` | `565.786` | +1.04% |

Artifacts and immutable checksums are under
`/private/tmp/min-plane-provenance/shapes-17-complete-singleton-64ac438/`.
The useful cropped candidate preview is
`run-1-singleton-observer-layout.png`; the full-sheet PNG and SVG are retained
beside it.

## Decision

Reject promotion. The safe one-second observer did not settle its declared
neighborhood, added measurable work, and exposed only a topology-versus-envelope
tradeoff. It did not produce a settled strict improvement, so the nine-case
gate and two-piece reconstruction were deliberately not run.

Do not widen the all-transform budget or promote this implementation. A future
Shapes complete-quality experiment must target construction-time reachability
or a resumable explicitly budgeted improvement cohort, not silently append
several seconds to the protected complete baseline.
