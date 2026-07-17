# Contact-tier diversity experiment

This report preserves an isolated research result. Neither candidate is a
production recommendation and neither implementation was merged.

## Provenance

- base commit: `45fd6a0`
- M1 implementation commit: `ff207ecf06365a1307ab1535519688046275310b`
- M1 report commit: `c62b659`
- M2 implementation commit: `7887c6d`
- terminal research commit: `aa585e7`
- fixture: `tests/fixtures/irregularSheetInvariance/mixed61-request.json`
- settings: rotations and mirroring enabled; reorder `4`; beam `8`; fanout
  `4`; transform cap `8`; local repair disabled

Both candidates passed lint, typecheck, and 49 focused placement, beam, and
exact triangle-golden tests. Every mixed61 run placed 61 of 61 pieces.

## M1: intrinsic representative inside duplicated contact tiers

M1 keeps the fanout and exact raw-contact-tier multiplicities unchanged. When
an exact raw-contact tier already occupies at least two selected fanout slots,
it replaces that tier's intrinsically worst selected member with the best
legal, geometrically distinct intrinsic-envelope candidate from the same tier.
It uses no sheet threshold or shape identity.

| Sheet | Envelope (mm) | Area (mm2) | Contact units | Structural contacts | Holes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 x 1700 | 658.907 x 660.624 | 435289.927 | 54.682 | 50 | 8 |
| 2000 x 2700 | 658.907 x 662.870 | 436770.039 | 45.309 | 42 | 10 |
| 1000 x 1300 | 658.907 x 736.885 | 485538.975 | 50.254 | 46 | 7 |
| 2000 x 1700 | 892.849 x 720.014 | 642863.970 | 61.101 | 58 | 6 |

M1 is a promising research ingredient, not a general solution. It prevents the
previous catastrophic chain on three sheets and preserves the triangle golden,
but the `2000 x 1700` layout remains sheet-dependent and perimeter-like.

## M2: intrinsic representative in every selected contact tier

M2 removes the duplicated-tier requirement and replaces the selected member of
every represented exact-contact tier with that tier's intrinsic-envelope winner
when possible. Fanout and tier multiplicity remain unchanged.

| Sheet | Envelope (mm) | Area (mm2) | Contact units | Structural contacts | Holes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1000 x 1700 | 597.292 x 761.032 | 454558.131 | 56.405 | 57 | 2 |
| 2000 x 2700 | 862.564 x 962.689 | 830380.943 | 63.524 | 58 | 0 |
| 1000 x 1300 | 836.548 x 846.976 | 708535.820 | 59.103 | 56 | 2 |
| 2000 x 1700 | 881.445 x 857.742 | 756052.397 | 64.940 | 62 | 1 |

M2 is rejected. Its higher contact and low hole counts are misleading: the
layouts form long chains or perimeter structures around large empty regions.
Local contact-tier preservation cannot distinguish a dense contact graph from a
high-contact spanning tree or ring.

## Interpretation

M1 validates the sheet-divergence audit: an intrinsic alternative inside an
otherwise identical contact tier can rescue a compact branch without damaging
the triangle lattice. M2 proves that applying this reservation to every tier is
too broad.

The next research direction should preserve explicitly different whole-beam
topologies, for example one dense-envelope survivor and one contact-graph
survivor. This is different from adding more local policy winners: the survivor
must be selected after whole-layout scoring and geometry deduplication so local
contact cannot fill all beam slots with variations of the same global topology.

