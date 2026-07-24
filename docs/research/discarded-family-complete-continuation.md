# Discarded-family complete continuation

Date: 2026-07-24.

Production base: `6433819c080b883e022fdd0c7a523d0822276d57`.

Experiment branch: `protected-complete-diversity-slot`.

The experiment tested whether one exact transform-family future discarded by
the width-one `legacy-absolute-envelope` constructor could improve the accepted
Shapes-17 complete endpoint. It did not change production selection, candidate
generation, the terminal comparator, requested-sheet scoring, or any protected
periodic producer.

## Stage A: bounded trace

Commit `432027f4eabc4a4ab0131149c68c847b8bf787e3` records the corrected
observer. An earlier `de17fe7` run exposed and preserved an instrumentation
bug: the top-level portfolio accepted the observer but did not forward it to
the direct-role runner. A portfolio-level regression test closed that gap
before measurement.

On Shapes-17 `2000 x 2700`, the corrected trace recorded:

- 17 depth-boundary observations;
- 16 canonically distinct non-selected family winners;
- 426,188 serialized bytes;
- identical accepted collision hash `1ddc8426...`;
- identical fitted hash `490194ca...`.

The exact-source consecutive control and observer runs measured
`12,509.303 ms` and `12,385.577 ms`. The observed delta was `-123.726 ms`,
below the preregistered `+500 ms` ceiling. Their canonicalized trace digests
also match across the two observer reproductions.

Evidence:

- `/private/tmp/min-plane-provenance/protected-diversity-observer-432027f/control-2/`;
- `/private/tmp/min-plane-provenance/protected-diversity-observer-432027f/observer-1/`;
- `/private/tmp/min-plane-provenance/protected-diversity-observer-432027f/observer-2/`.

## Stage B: one exact continuation

Depth 10 was the unique traced crossover whose alternate reduced maximum side
while increasing area under the unchanged local comparator:

| Future | Transform family | Maximum side | Envelope area | Span |
| --- | --- | ---: | ---: | ---: |
| selected | `180:0` | `502.469 mm` | `233,437.048020 mm2` | `967.049 mm` |
| alternate | `90:0` | `493.265 mm` | `233,701.064760 mm2` | `967.049 mm` |

Commit `1920d21ad4fa5abfd52f05f651ae62380b571c02` freezes the exact
step, piece, parent hash, pending-order digest, transform families, future
hashes, and score tuples. It captures the live alternate state, bottom-left
anchors it, verifies its traced identity, and continues only the original
pending suffix under an independent `12,000`-evaluation / `15,000 ms` cap.

The continuation settled uncensored in `798.724 ms` and 3,902 evaluations as a
complete exact endpoint:

| Metric | Continued alternate | Accepted endpoint |
| --- | ---: | ---: |
| canonical hash | `6c1bfa66...` | `1ddc8426...` |
| envelope area | `297,570.451566 mm2` | `281,233.148068 mm2` |
| maximum side | `557.878 mm` | `532.691 mm` |
| largest contact component | 2 pieces | 8 pieces |
| isolated pieces | 5 | 4 |
| canonical cavities | 0 | 0 |

The existing exact archive retained `1ddc8426...`. The alternate therefore
falsifies this retention hypothesis even though the warm handoff itself is
exact, deterministic, inexpensive, and complete.

Evidence:

- `/private/tmp/min-plane-provenance/protected-diversity-continuation-1920d21/run-1/`;
- `/private/tmp/min-plane-provenance/protected-diversity-continuation-a1ae2f5/run-1/`
  preserves a rejected preregistration run whose area literal lacked the full
  canonical floating-point precision.

## Decision

Stop before the nine-case and ten-sheet matrices. Their promotion gate applies
only after a strict targeted win. The current-source production matrices
already pass, and no observer or continuation implementation is entering
production, so rerunning them would not test a changed production path.

Retain the experiment branch and immutable provenance. Merge only this negative
result and the corrected roadmap wording. Do not merge the observer or
continuation implementation.
