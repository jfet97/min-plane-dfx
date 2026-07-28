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
  floating-point (the `Math.hypot` calls in
  `canonicalGridEdgeLengthMm`, accumulated as floats inside
  `measureCanonicalLayoutContacts`), and total
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

## Follow-up: the bounded contact-aware tie-break (2026-07-28)

The research-only option C was then measured and implemented in bounded form.
Tie-frequency instrumentation (per-piece evidence sink on the strip runtime
control, reported by `scripts/irregular-short-side-strip-evidence.ts`) shows
anchor ties are frequent: `23/61` placement decisions on `1000x2700` and
`21/61` on `2000x2700`. In almost all of them the baseline already picks the
best-contact orientation or every tied candidate scores zero, but exactly two
ties per sheet seat a zero-contact orientation while an edge-contacting
alternative shares the same anchor.

The selector now measures the exact axis-projected overlap of every tied
candidate against the placed pieces (BigInt surrogate in
`canonicalGridContact.ts`, no floats) and takes the strongest, provided the
challenger is not deeper than the translation-order baseline winner, so no tie
choice ever deepens the tied piece itself. Downstream anchors respond to the
new geometry, so final strip depth is a measured corpus guarantee rather than
a structural one. Silent scores fall back to the historical tuple order.

Measured outcomes: the Mixed-61 `2000x2700` flagship keeps span `2000`,
depth `207.700`, envelope `415,400 mm2`, density, fill, and zero cavities,
while shared boundary grows `1,279.1` to `1,367.4 mm`, isolated pieces drop
`28` to `27`, components `37` to `36`, the largest component grows `12` to
`13`, and the hull gap tightens `0.2151` to `0.2111`; its two accepted hashes
change and are regenerated in the baselines. Triangle-20 and Shapes-17 strips
are byte-identical. On `1000x2700` the strip sheds one of its two cavities
(`2` to `1`) and two isolated pieces (`33` to `31`) but still misses
admission, so that sheet correctly stays on the quality-protected Compact
fallback. No gate was relaxed: the improved strip earns its place under the
unchanged contracts, and the extent-comparator prohibition stands because
this rule acts only inside exact anchor ties, never on extent.
