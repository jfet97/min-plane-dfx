# Protected intrinsic contact seed

This experiment safely transfers the strongest result from
`contact-tier-intrinsic-reservation`: maximum-side-first intrinsic compactness
can improve a mixed layout when it is isolated from production fanout. It is
accepted as a bounded repair-disabled quality improvement. It does not close
sheet invariance.

## Provenance

- production base: `20d74f6379c4865ec9654d351b3bcbae7b2aae81`
- final algorithm checkpoint: `13a23510df57365e1242323b30f5463b06b62e61`
- committed four-sheet harness: `221da872a085be66da0913ab6a16727b7d842f8e`
- branch: `protected-intrinsic-contact-seed`
- net diff SHA-256: `28c6bb8d20f001f8fa53eda98cb007e53d8eba8eec4d65e9736599f85fe4f967`
- mixed-61 fixture SHA-256: `cf390e7a851eb1f267c5ff986032ce003372483863f3ed5e31d963bc24b95660`
- immutable evidence:
  `/private/tmp/min-plane-provenance/protected-intrinsic-contact-seed/`
- portable manifest:
  [`protected-intrinsic-contact-seed/manifest.json`](../artifacts/protected-intrinsic-contact-seed/manifest.json)

## Accepted mechanism

The normal local fanout, production beam, incumbent, and existing eight-state
boundary-anchor lane retain their previous order and capacity. On
repair-disabled edge-contact decodes without chromosome transform preferences,
the decoder may identify one additional real legal candidate only when:

1. its positive canonical shared-boundary length already occupies at least two
   production fanout positions;
2. it is the maximum-side, then area, then span winner of that exact tier; and
3. its translated geometry is not already represented.

That candidate is tagged protected-only and advances in a separate width-one
intrinsic lane. The lane ranks structural contact strength before direct
maximum side, area, span, raw occupied-hull waste, placement identity, and a
translation-normalized geometry key. It uses no sheet dimensions,
sheet-normalized fields, sheet-boundary coordinates, or free-material fields.

Cross-lane deduplication always keeps the production representative and only
combines eligibility. Production, boundary, and intrinsic terminal winners are
oriented independently. Each protected candidate must be strictly better under
the production comparator and strictly smaller in collision-envelope area
before it can compete for the returned result.

## Four-sheet result

The baseline is current main plus only the committed measurement harness.

| Sheet | Baseline area | Candidate area | Holes | Contacts total / dominant | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `1000 x 1300` | `506,644.934` | `506,644.934` | `12` | `38 / 6` | exact baseline hash |
| `1000 x 1700` | `461,475.664` | `461,475.664` | `10` | `44 / 9` | exact baseline hash |
| `2000 x 1700` | `661,441.643` | `535,808.686` | `6 -> 4` | `58 / 16 -> 56 / 17` | area `-18.99%` |
| `2000 x 2700` | `430,344.918` | `430,344.918` | `2` | `53 / 14` | exact protected reference hash |

The changed sheet increases normalized contact units from `60.100990` to
`60.610925` while reducing raw near-complete contacts by two. The dominant
contact count improves by one. Rendered inspection shows a connected layout
with complete margins; the existing central void remains, but the envelope is
substantially narrower and measured holes decrease.

The four-sheet area spread falls from `231,096.725 mm2` to `105,463.768 mm2`, a
`54.36%` reduction. Mean area falls `6.10%`. All four canonical hashes still
differ, so this is progress toward stability rather than invariance.

The changed canonical hash is:

```text
236f5f40e722bce2ba2dacecdc18ec4c1ce01344f944a2fce1c49bfbe19f7159
```

It reproduced exactly on the repeated run.

## Corpus and runtime gates

All 14 outputs in the existing seven-case, two-sheet corpus are byte-identical
to the accepted main checkpoint, including the repair-8 triangle golden,
trapezoid gain, mixed-50 seven-hole reference, and mixed-61 two-hole reference.
The official focused gate passed 60 tests.

Two serial timing samples put `1000 x 1300` at about `1.05x` current main and
`2000 x 1700` at about `1.16x`. This stays below the `1.25x` incremental budget
and is qualitatively different from M1b's rejected `8-15x` slowdown.

Lint, typecheck, and the worker build pass. The full suite reports 524 passing
tests and the same two `irregularBenchmark.test.ts` assertion failures reproduced
on the base checkout.

## Hardening findings

The first committed implementation exposed two useful integration failures:

- zero-contact candidates must not seed an "exact-contact" lane;
- an intrinsic tag on the production winner must not shadow the existing
  boundary winner during terminal arbitration.

The final checkpoint requires positive contact and evaluates boundary and
intrinsic terminal winners independently. A later audit also removed
free-material and absolute bottom/left tie-breaks from protected pruning and
replaced them with translation-normalized combined geometry.

## Remaining gap

The experiment proves that the report's max-side-first primitive is useful on
current production when given a protected role. It does not prove that one
intrinsic lane can recover a common motif. The next falsifiable step is a
bounded Pareto frontier inside the protected budget over exact contact strength,
maximum side, area, and span, with the boundary-reference and intrinsic roles
kept distinct and geometry-deduplicated. The terminal production and area gates
must remain unchanged.
