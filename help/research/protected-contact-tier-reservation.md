# Protected contact-tier intrinsic reservation

This report records the current-base follow-up to the historical contact-tier
and intrinsic-reservation experiments. The candidate is rejected for
production, but its mechanism and counterexamples remain useful research.

## Provenance

- base: `f68be50e724ffa40e059342f33168de7937b4f7c`
- implementation: `bc6b0cd7747f6a5d20d1559506dcee39c9dfbc8e`
- branch: `protected-contact-tier-reservation`
- runtime: Node `v24.16.0`, pnpm `11.8.0`
- immutable manifest:
  `/private/tmp/min-plane-provenance/contact-tier-current-base/bc6b0cd/manifest.json`
- corpus report:
  `/private/tmp/min-plane-provenance/contact-tier-current-base/bc6b0cd/corpus/report.json`

The implementation was committed before corpus execution. It passed 53 focused
placement, trace, beam, and repair-8 triangle-golden tests, plus lint and
typecheck.

## Candidate

The candidate keeps the production local winner, existing balanced-compactness
winner, fanout size, and exact contact-tier multiplicity. It may replace one
additional unprotected candidate only when an exact contact tier already owns
at least two selected slots. The replacement is the best candidate from that
same tier under the sheet-independent tuple:

1. cluster maximum side;
2. cluster area;
3. cluster span;
4. deterministic position, transform, and piece identity.

The reservation is disabled when a chromosome transform preference is active.
Decision traces expose the maximum-side score and distinct reservation and
displacement reasons.

This is deliberately narrower than historical M1 and M2. It performs at most
one promotion, protects both existing lanes, and never consumes two global
fanout slots.

## Corpus result

The candidate stopped at the two-sheet corpus because it failed the production
quality gate. Areas are collision-envelope square millimeters.

| Case | 1000 x 1700 baseline | Candidate | 2000 x 2700 baseline | Candidate | Decision |
| --- | ---: | ---: | ---: | ---: | --- |
| triangles-20 | 80,174 | 80,174 | 80,174 | 80,174 | exact hashes preserved |
| rectangles-20 | 539,325 | 494,974 | 439,304 | 439,304 | one improvement, reference hash changed |
| trapezoids-20 | 256,718 | 277,850 | 233,380 | 272,371 | reject, both sheets regress |
| pentagons-20 | 345,212 | 251,708 | 240,528 | 251,708 | invariant, compact improves, reference regresses |
| star-hulls-20 | 345,212 | 251,708 | 240,528 | 251,708 | same convex family and result as pentagons |
| mixed-50 | 761,885 | 761,885 | 623,249 | 716,435 | reject, reference regresses 15% |
| mixed-61 | 461,476 | 461,476 | 436,770 | 436,770 | byte-identical hashes; no target improvement |

Pentagons and star hulls become sheet-invariant with one rather than two holes,
confirming that max-side-first intrinsic selection can preserve a compact
homogeneous motif. They are not independent fixture families: convexification
reduces both to the same outer five-vertex collision geometry.

The candidate does not affect mixed-61 on either corpus sheet. More importantly,
it worsens both trapezoid layouts and the mixed-50 reference layout. The
one-promotion cap and protected local winners therefore do not make local
contact-tier replacement generally safe.

## Conclusion

Do not promote this candidate and do not repeat historical M2. The reusable
parts are the directly measured maximum-side field, intrinsic comparator, trace
visibility, and the rule that diversity must preserve baseline lanes and exact
contact strength. The local reservation itself remains too shape-dependent.

The approved mixed-61 regression has a different cause. At beam depth two,
`95de72c` correctly canonicalizes a meaningless `4.3e-15` hull-waste difference;
the resulting tie lets bottom-left ordering evict a distinct boundary-anchor
state that later produced the approved two-hole layout. The next isolated
experiment must preserve bounded whole-state boundary-anchor diversity while
retaining canonical scoring, not add another local policy winner.
