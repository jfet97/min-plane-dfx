# Intrinsic pinned-lane six-baseline matrix

- source commit: `c171f213e0a5826a2d83a09f472498c9366a900b`
- algorithm commit: `648a93e44d6ee47ece407a4a982fe209ffb0f216`
- branch: `intrinsic-anytime-portfolio`
- runtime: Darwin arm64 25.5.0, Node v24.16.0, pnpm 11.8.0
- cases: Triangle-20, Mixed-61, and Shapes-17 on `2000x2700` and `600x400`
- settings: accepted Compact baseline settings with deterministic scheduler,
  protected capacity coordination, shadow telemetry, and experimental complete
  observer enabled
- command: `/usr/bin/time -l pnpm gate:compact-six-baselines --output-dir
  /private/tmp/min-plane-provenance/intrinsic-pinned-lane-c171f21-six`

## Result

All six strict accepted-baseline checks pass: collision identity, fitted
canonical hash, placed/unplaced accounting, area, cavity bound, runtime, and
scheduler chronology. The process used `112.23 s` wall, `123.35 s` user CPU,
`1.22 s` system CPU, and `910,721,024` bytes maximum resident set size.
