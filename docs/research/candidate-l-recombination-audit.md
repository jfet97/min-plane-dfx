# Candidate L recombination audit

## Decision

Do not merge R1, R2, R3, or R4 as the production comparator. R2 is the useful
research result: keeping the production local placement order while applying
Candidate L's banded, sheet-intrinsic whole-layout order after depth 20 reduces
the mixed61 four-sheet envelope-area spread by `65.16%` and the mean hole count
from `9.5` to `2.5`. It also worsens the mean envelope area by `6.15%`, regresses
the approved `2000 x 2700` reference by `34.26%`, and visibly selects
perimeter/open-cavity topologies on the wider sheets.

The ablations reject Candidate L's local placement order in both forms tested:
using it for every local winner after depth 20 (R3) increases sheet spread by
`42.49%`; reserving one Candidate L local winner while retaining production
winners (R4) nearly eliminates measured holes but increases the mean envelope
area by `27.91%` and produces a long contact chain. The next experiment should
therefore preserve whole-beam topology diversity around R2's global objective,
not reserve more Candidate L local placements.

A triangle-golden failure remains a production rejection, not proof that an
algorithmic ingredient is useless. In this recombination matrix the hermetic
triangle golden passes for R1-R4, so the rejection comes from the mixed61
quality evidence rather than from overfitting the triangle gate.

## Provenance

- production scorer baseline: `aa7a264d4bc8ee99f6e5e9d890246e87e82b5db5`
- four-sheet audit harness: `80fecbaa1fae9c37ca96d2e0eb4b0261ded0badf`
- recorded standalone Candidate L ingredients: `61d10538832e8ce32d29ec394525042212de515d`
- R1 staged local and global intrinsic scoring: `6d6c6be5cd5e0052e230f0c410e069e4e09fc971`
- R2 global-only ablation: `b324fe15ed9a22e33ef55ab304a50d23fe6b51f1`
- R3 local-only ablation: `9d00315cde7204f65f56ba37bcf05b3fb8c7cd80`
- R4 reserved-local ablation: `76a8571b29ca6b3ad803df2cea7258fc19b97195`

The audit used Node `24.16.0`, pnpm `11.8.0`, and the repository's Electron
`33.4.11` dependency. Each corpus run used the compact-quality profile:
reorder window 4, beam width 8, local fanout 4, transform cap 8, rotations and
mirroring enabled, edge-contact policy, GA disabled, and repair disabled. The
four sheets were `1000 x 1300`, `1000 x 1700`, `2000 x 1700`, and
`2000 x 2700` mm. The separate hermetic triangle gate used the same profile with
repair budget 8, as required by the production golden.

## Variant semantics

| Variant | Local candidate order | Whole-layout order after depth 20 |
| --- | --- | --- |
| Baseline | Production raw shared-contact order | Production sheet-normalized compactness inside structural-contact bands |
| R1 | Production through depth 20, then Candidate L structural/intrinsic order | Candidate L dominant-contact and structural-contact bands, then intrinsic maximum side, area, and span |
| R2 | Production at every depth | Candidate L global order from R1 |
| R3 | Candidate L local order after depth 20 | Production global order |
| R4 | Production ranking plus one reserved Candidate L local winner after depth 20 | Candidate L global order from R1 |

## Mixed61 measurements

Every cell below is `collision-bounds area mm2 / free-material holes`. All 61
pieces were placed in every run.

| Variant | 1000 x 1300 | 1000 x 1700 | 2000 x 1700 | 2000 x 2700 | Four-sheet spread | Mean area |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | `506644.934 / 12` | `461475.664 / 10` | `661441.643 / 6` | `436770.039 / 10` | `224671.604` | `516583.070` |
| R1 | `469229.088 / 1` | `451243.500 / 10` | `647000.798 / 6` | `530386.946 / 4` | `195757.298` | `524465.083` |
| R2 | `533535.054 / 1` | `508119.969 / 2` | `565416.004 / 6` | `586398.572 / 1` | `78278.603` | `548367.400` |
| R3 | `742406.705 / 2` | `422281.359 / 13` | `625260.941 / 4` | `501545.108 / 9` | `320125.346` | `572873.528` |
| R4 | `545363.709 / 0` | `572039.944 / 0` | `785774.468 / 0` | `739907.984 / 2` | `240410.759` | `660771.526` |

Relative to the baseline:

| Variant | Spread change | Mean-area change | `2000 x 2700` change | Mean holes |
| --- | ---: | ---: | ---: | ---: |
| R1 | `-12.87%` | `+1.53%` | `+21.43%` | `5.25` |
| R2 | `-65.16%` | `+6.15%` | `+34.26%` | `2.50` |
| R3 | `+42.49%` | `+10.90%` | `+14.83%` | `7.00` |
| R4 | `+7.01%` | `+27.91%` | `+69.40%` | `0.50` |

R2's exact per-sheet geometry evidence is:

| Sheet | Bounds mm | Span mm | Structural / dominant contacts | Contact units | Canonical geometry SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| `1000 x 1300` | `678.020 x 786.902` | `1464.922` | `56 / 9` | `54.892427` | `df4e1485325a4e86e8246422a47f47bf0a4ba1f0464f4424fd1b481e79ca7248` |
| `1000 x 1700` | `897.312 x 566.269` | `1463.581` | `53 / 12` | `57.706709` | `c32e67b01f8280680145edfd8f7ec5b5c7f2229b7b93bb2659f1ddb9f420e143` |
| `2000 x 1700` | `744.164 x 759.800` | `1503.964` | `55 / 15` | `59.547816` | `e5c2009cf0a5765700e71bcbde6da975a520ec850397182d659273f8dea6b3e8` |
| `2000 x 2700` | `865.958 x 677.168` | `1543.125` | `54 / 13` | `55.712676` | `93ce02982cf9c62e733a5a5191b360d74de26279e37b780a07afc51e17f38bfa` |

## Triangle result

The hermetic `irregularTriangleCompactGolden.test.ts` gate passed on R1, R2,
R3, and R4 with the production repair budget of 8. This establishes that the
depth-20 staging protected the approved repaired lattice during these
ablations.

The four-sheet audit deliberately disables repair. Its `2000 x 2700` triangle
output was identical to the production no-repair baseline for every variant:
`227.025 x 441.440 mm`, `100217.916 mm2`, zero holes, 22 structural contacts,
15 dominant contacts, `21.884699` contact units, and canonical SHA-256
`b1f48443ff09aee65f783c3e2a436ada75516ffb69d6cd0cb36dc6d42414ed05`.
Do not confuse this diagnostic no-repair output with the passing hermetic golden.

The portable no-repair R2 triangle preview is
[SVG](../artifacts/candidate-l-recombination/r2-triangle-audit-no-repair-2000x2700.svg) /
[PNG](../artifacts/candidate-l-recombination/r2-triangle-audit-no-repair-2000x2700.png).

## Visual findings

The area and hole metrics are not sufficient acceptance gates:

- R2 on `1000 x 1300` and `1000 x 1700` is relatively dense and connected;
- R2 on `2000 x 1700` has a large open central region separating perimeter
  structures despite only six measured holes;
- R2 on `2000 x 2700` retains a conspicuous open cavity and chain-like edges;
- R4 drives hole count toward zero by creating a long structural-contact chain,
  which is visibly worse and explains its `69.40%` reference-area regression.

R2 previews:

- `1000 x 1300`: [SVG](../artifacts/candidate-l-recombination/r2-mixed61-1000x1300.svg) / [PNG](../artifacts/candidate-l-recombination/r2-mixed61-1000x1300.png)
- `1000 x 1700`: [SVG](../artifacts/candidate-l-recombination/r2-mixed61-1000x1700.svg) / [PNG](../artifacts/candidate-l-recombination/r2-mixed61-1000x1700.png)
- `2000 x 1700`: [SVG](../artifacts/candidate-l-recombination/r2-mixed61-2000x1700.svg) / [PNG](../artifacts/candidate-l-recombination/r2-mixed61-2000x1700.png)
- `2000 x 2700`: [SVG](../artifacts/candidate-l-recombination/r2-mixed61-2000x2700.svg) / [PNG](../artifacts/candidate-l-recombination/r2-mixed61-2000x2700.png)

Reference-sheet comparison:

- baseline: [SVG](../artifacts/candidate-l-recombination/baseline-mixed61-2000x2700.svg) / [PNG](../artifacts/candidate-l-recombination/baseline-mixed61-2000x2700.png)
- R1: [SVG](../artifacts/candidate-l-recombination/r1-mixed61-2000x2700.svg) / [PNG](../artifacts/candidate-l-recombination/r1-mixed61-2000x2700.png)
- R3: [SVG](../artifacts/candidate-l-recombination/r3-mixed61-2000x2700.svg) / [PNG](../artifacts/candidate-l-recombination/r3-mixed61-2000x2700.png)
- R4: [SVG](../artifacts/candidate-l-recombination/r4-mixed61-2000x2700.svg) / [PNG](../artifacts/candidate-l-recombination/r4-mixed61-2000x2700.png)

## Recommendation

Retain R2 commit `b324fe1` as the narrow research lead, not as a merge
candidate. Its Candidate L whole-layout contact bands plus intrinsic envelope
ordering materially reduce sheet sensitivity and holes while leaving the local
placement generator on the production order. The missing objective is topology:
R2 can prefer states with similar envelope metrics that wrap around an open
cavity or extend along the perimeter.

The next bounded experiment should keep more than one whole-beam topology after
depth 20. One lane should retain the production winner; another should retain an
R2 intrinsic-envelope winner only within a bounded structural-contact deficit;
another may minimize cavity or envelope growth. Deduplicate these lanes by
canonical geometry before filling the remaining beam. Measure connected
components, cavity area/count, and envelope area independently. Do not add
another local Candidate L reservation: R3 and R4 already show that this spends
fanout on contact-rich branches without fixing the whole-layout topology.

Only a combined candidate that recovers the triangle golden and improves the
mixed/corpus topology gates should be considered for production.
