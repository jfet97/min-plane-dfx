# Compact Short-Side Strip Relaxation Rejection

Date: 2026-07-28

## Why the question arose

On a `1000 x 2700` sheet the Short Side profile returns the protected Compact
block (`622.202 x 629.387 mm`, `62.2%` short-edge fill). The user asked why the
result is not a directional strip. Reproducing the run with observer capture
(`scripts/irregular-compact-baseline.ts --fixture mixed-61 --sheet 1000x2700
--objective-profile short-side`) shows the pipeline working as designed:

- the multi-row shelf (`971.168 x 569.973 mm`, fill `97.1%`, density `0.566`)
  is vetoed by the area-cost guard at `1.414x` the Compact envelope, its only
  failing term (causal veto, retained in the trace);
- the contact strip (`1000.000 x 416.475 mm`, fill `100%`, density `0.753`,
  area `1.0635x`) passes the area guard and every other admission gate except
  one: it carries `2` enclosed occupied-union cavities against the
  zero-cavity admission gate;
- even if admitted, the strip regresses all three promotion connectivity
  terms against the (itself inadmissible) shelf: isolated pieces `33 vs 31`,
  positive-contact components `40 vs 37`, largest contact component `11 vs
  12`, while winning fill, envelope area, depth, density, hull gap, and
  shared boundary length (`1,494.5 vs 1,383.6 mm`).

The raw strip was constructed outside the gates and rendered
(`scripts/irregular-short-side-strip-evidence.ts`): a good-looking full-width
band with two small enclosed voids. Shipping it was evaluated seriously.

## Why the relaxation was rejected

Independent design review ruled to keep the protected Compact result.

- Shared-boundary length cannot replace the connectivity guards. It is
  floating-point (`Math.hypot` at `canonicalGridContact.ts:227,274`,
  accumulated as floats at `canonicalLayoutGeometry.ts:226`), and total
  length can grow while contact concentrates in fewer pieces; this strip is
  itself the witness, winning length while regressing every connectivity
  term. The observer research record treats shared boundary as descriptive
  and connectivity as the robust structural signal.
- A cavity-count tolerance without the companion shape bound (stage 1 pairs
  `<= 2` cavities with an exact `15%` hull-gap ceiling, which this strip
  fails at `0.2219`) leaves cavity severity unbounded. Any future
  reconsideration requires an explicit exact cavity-area bound via
  `measureCanonicalEnclosedCavities` plus a wider validation corpus.
- Bypassing connectivity terms only when the incumbent failed admission still
  ships the strip: the rejected incumbent's metrics are present, every
  promotion term reads true, and the admitted strip is promoted. There is no
  conservative middle ground in that direction.
- A contact-aware anchor tie-break only acts when both anchor coordinates
  tie, with no evidence such ties are frequent enough to remove cavities or
  isolated pieces, and the previously tested extent comparator already
  regressed the flagship Mixed-61 depth. It remains research-only, gated on
  equal-anchor tie-frequency instrumentation.

## Decision

No gate, admission, or promotion change. On `1000 x 2700`-class sheets where
every directional construction either overspends the `4/3` area-cost guard or
regresses connectivity, the profile retains Compact and reports
`short-side-quality-protected-compact-fallback`. The strip evidence script
and this record preserve the investigation.

Evidence: traces `/tmp/ss-inspect/m61-1000x2700-ss.json` (local, reproducible
with the command above), strip render `/tmp/ss-inspect/strip-1000x2700.png`
(local, reproducible with `scripts/irregular-short-side-strip-evidence.ts`),
design document and review transcript retained locally.
