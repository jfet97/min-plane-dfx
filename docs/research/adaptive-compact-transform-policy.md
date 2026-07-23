# Adaptive Compact Transform Policy

Date: 2026-07-23  
Implementation commit: `2174c63`

## Outcome

Compact no longer uses one absolute minimum edge length and angular
deduplication tolerance for every piece scale. It derives both values from the
prepared collision polygon and configured curve sag:

```text
minimumEdgeMm =
  min(4 * sagMm, 0.01 * min(collisionWidthMm, collisionHeightMm))

angleToleranceDeg =
  min(
    0.051,
    2 * asin(min(1, sagMm / (2 * maximumVertexRadiusMm))) * 180 / pi
  )
```

The radius is measured in the collision polygon's local placement frame.
`placementReference` stores the corresponding source-space point and does not
change the local radius.

The production UI no longer exposes these values. Persisted fields remain
schema-compatible and still control ordinary or Compact-ineligible replay.
Only a genuinely eligible Compact request uses the adaptive policy.

## Why

The previous `1.2 mm` edge threshold was not scale invariant. A useful
`1.1 mm` edge disappeared only because a piece happened to be small.

The previous `0.051 degree` tolerance was not displacement bounded. At a
`2,000 mm` radius it could merge orientations whose outer vertices differ by
about `1.78 mm`, far beyond a `0.25 mm` curve-sag budget.

The adaptive edge formula scales with both curve approximation and piece size.
The adaptive angular formula solves the chord-displacement relationship
`displacement = 2 * radius * sin(angle / 2)` and caps the result at the
historical `0.051 degree` maximum.

## Representative Selection

Deduplication happens before the transform cap. Within one near-angle group:

1. orthogonal sources retain priority over edge-derived sources;
2. edge-derived sources retain priority over configured sources;
3. two competing edge-derived angles keep the contributor from the longer
   usable collision edge;
4. normalized angle and source ordinal provide deterministic tie-breaks.

Circular angular distance handles the `0/360 degree` seam. This prevents an
arbitrary smallest numeric angle from displacing the more geometrically useful
edge alignment before the cap.

## Focused Evidence

The focused suite contains 48 passing transform, schema, and UI tests. New
cases cover:

- normalized transform equality at `0.1x`, `1x`, and `10x` scale when sag
  scales with the geometry;
- large-radius orientations that must remain distinct;
- source-space placement-reference translation invariance;
- a short but scale-meaningful edge;
- ordinary or Compact-ineligible replay retaining persisted thresholds;
- longer-edge selection under transform-cap pressure;
- circular near-angle deduplication across `0/360 degrees`.

Lint, Node typecheck, renderer typecheck, and a development build pass.
A focused independent review of the implementation reported no findings.

## Post-Commit Production Gates

These are serial post-commit observations on Node `v24.16.0`, V8
`13.6.233.17-node.49`, macOS arm64. Algorithm time is reported separately from
total command time.

| Fixture | Algorithm time | Total command time | Area | Cavities | Canonical hash |
| --- | ---: | ---: | ---: | ---: | --- |
| Triangle-20 | `12.635 s` | `13.66 s` | `74,428.143126 mm2` | 0 | `371db2696b65e2122b98bdb197a1d327df0c6ecbeca6ed73d2722971be52a127` |
| Mixed-61 | `52.962 s` | `53.60 s` | `391,605.850174 mm2` | 0 | `ef2b783ae12491d2a80a12ef94d1bb2801c13cbd43aeb6e2c1cc00d86828fd3b` |
| Shapes-17 | `7.447 s` | `8.52 s` | `304,499.845650 mm2` | 0 | `c640c06f662050f8a132168f63988c40ba41f2ebc57dc50277a91119b4b4980a` |

Every requested piece was placed. All three canonical winners remain exact.
The original regenerated SVG and PNG hashes were byte-identical to the
then-accepted portable artifacts. The current artifact directory retains the
same exact geometry under explicit sheet-qualified names.

## Artifact Evidence

Portable artifacts:

- [`triangle-20-2000x2700.svg`](../artifacts/current-compact-baselines/triangle-20-2000x2700.svg)
  and [`triangle-20-2000x2700.png`](../artifacts/current-compact-baselines/triangle-20-2000x2700.png);
- [`mixed-61-2000x2700.svg`](../artifacts/current-compact-baselines/mixed-61-2000x2700.svg)
  and [`mixed-61-2000x2700.png`](../artifacts/current-compact-baselines/mixed-61-2000x2700.png);
- [`shapes-17-2000x2700.svg`](../artifacts/current-compact-baselines/shapes-17-2000x2700.svg)
  and [`shapes-17-2000x2700.png`](../artifacts/current-compact-baselines/shapes-17-2000x2700.png).

Immutable local provenance:

```text
/private/tmp/min-plane-provenance/adaptive-policy-2174c63/
/private/tmp/irregular-sheet-invariance/report.json
```

The full artifact harness also performs raw source-survival audit and report
construction, so its wall times are not production timings:

- Triangle-20: `96.31 s`;
- Mixed-61: `201.85 s`;
- Shapes-17: `6.52 s`.

## Remaining Evidence Gap

Exact preservation of the three production baselines proves compatibility but
does not fully validate arbitrary scale-diverse geometry. The next corpus pass
should include curves, `1-10 mm` pieces with intentional short edges,
`1-5 m` pieces with shallow facets, and normalized `0.1x/1x/10x` copies.
Promotion remains valid for the current production gates; broader evidence may
refine the formulas or transform cap later without restoring UI knobs.
