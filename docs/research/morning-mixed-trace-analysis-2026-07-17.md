# Morning Mixed-61 Trace Analysis — 2026-07-17

## Scope

This report analyzes exactly the two newest morning decision traces and their
matching replay histories. Both runs use the same 61-piece mixed request on a
`2000 x 2700 mm` sheet with `10 mm` padding. No older trace was used to identify
the runs.

## Exact runs

| Run | Created locally | Decision trace | Replay | Trace bytes | Replay bytes |
| --- | --- | --- | --- | ---: | ---: |
| Repair 0 | 2026-07-17 09:24:05 | `3f0aa4f7-d551-4ead-a525-66a734edfe65.decision-trace.ndjson` | `3f0aa4f7-d551-4ead-a525-66a734edfe65.ndjson` | 26,352,690 | 1,045,853 |
| Repair 8 | 2026-07-17 09:25:48 | `9b4d65b7-536d-4d58-ae0e-2ce8d01c40cb.decision-trace.ndjson` | `9b4d65b7-536d-4d58-ae0e-2ce8d01c40cb.ndjson` | 26,383,052 | 1,045,931 |

All four files are under:

`/Users/andreasimonecosta/Library/Application Support/min-plane-dfx/dfx-min-project/history/`

Shared optimizer settings: reorder window `4`, beam width `8`, local fanout `4`,
transform cap `8`, policy `edge-contact-then-balanced-compactness`, rotations and
edge alignment enabled, GA disabled. The only optimizer-setting difference is
local repair budget `0` versus `8`.

## The beam is identical

After excluding `decode_started` and terminal-only events
(`local_repair_accepted`, `terminal_orientation_scored`, `decode_winner`), both
decision traces have the identical SHA-256:

`0aaef33c529c75932c7cdcd28f1093a2a737ed449c7f89071f3b13a0a7c97945`

Both contain the same 61 beam steps and beam event counts. Therefore the second
run does not explore a different beam. It takes the first run's terminal beam
state and applies eight repair moves.

## Winner comparison

| Metric | Repair 0 (`s1yu`) | Repair 8 (`s1z2`) | Change |
| --- | ---: | ---: | ---: |
| Placed | 61 | 61 | 0 |
| Dominant structural contacts | 17 | 17 | 0 |
| Total structural contacts | 64 | 68 | +4 |
| Normalized contact units | 65.211743 | 68.369869 | +3.158126 |
| Bounds area, mm2 | 531,886.484 | 573,836.581 | **+7.89%** |
| Bounds span, mm | 1,509.645 | 1,561.620 | **+3.44%** |
| Worst sheet consumption | 0.351639 | 0.359293 | +2.18% |
| Normalized span sum | 0.631749 | 0.655057 | +3.69% |
| Hull waste | 0.335945 | 0.334515 | -0.43% relative |
| Free-material holes | 1 | 1 | 0 |

Repair 8 is not an improvement for this fixture. It preserves the dominant
motif count, buys four additional structural contacts, but expands the bounds by
about `41,950 mm2` and `51.975 mm`.

The damaging repair acceptances are explicit:

- iteration 1 increases contacts `65 -> 66` while area grows
  `531,886 -> 561,612 mm2` (+5.59%) and holes temporarily increase `1 -> 2`;
- iteration 3 increases contacts `67 -> 68` while area grows
  `561,612 -> 573,837 mm2` (+2.18%) and span grows `1,540.954 -> 1,561.620 mm`;
- iterations 4–7 only improve hull waste inside the already enlarged envelope.

This follows directly from the comparator: total structural contact is ranked
before every bounds metric, so one extra contact can justify unbounded envelope
growth.

## Where the fragmented branch wins

The first pure contact-versus-compactness divergence appears at beam step 2
(three placed pieces):

| Candidate | Total contacts | Worst consumption | Area, mm2 | Span, mm | Current rank |
| --- | ---: | ---: | ---: | ---: | ---: |
| retained `s2u` | 2 | 0.135253 | 61,574.405 | 533.796 | 1 |
| pruned `s25` | 1 | 0.101130 | 51,612.856 | 457.441 | 36 |

At step 10 the same trade is already large: current accepts one extra contact
(`10` versus `9`) for `217,865 mm2` instead of `186,060 mm2` (+17.1%). Pure
compactness is not a suitable replacement because it also creates holes and is
known to break the approved triangle lattice, but these events show that strict
contact begins growing the vertical/fragmented envelope very early.

## Pivotal recoverable branches

### Step 22: scale-aware contact band would preserve a better state

At 23 placed pieces:

| Candidate | Dominant / total | Worst | Span sum | Area, mm2 | Span, mm | Hull waste | Current rank |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| retained `stw` | 3 / 23 | 0.258314 | 0.498139 | 334,531.096 | 1,164.156 | 0.282027 | 1 |
| pruned `su7` | 3 / 22 | 0.258314 | 0.479434 | 308,439.315 | 1,113.652 | 0.259074 | 28 |

`su7` sacrifices one total contact for 7.8% less bounds area and 50.504 mm less
span. A two-contact band after the small-layout phase ranks both in the same
contact band and keeps `su7` by compactness. This is the first divergence of the
already-tested `depth21-total2` strategy.

### Step 31: an excellent no-hole state is explicitly displaced

At 32 placed pieces:

| Candidate | Dominant / total | Units | Worst | Area, mm2 | Span, mm | Hull waste | Holes | Beam result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| current `s16h` | 3 / 29 | 27.654992 | 0.295584 | 447,097.339 | 1,358.295 | 0.330776 | 1 | retained rank 1 |
| compact `s16v` | 3 / 28 | 27.858635 | 0.280110 | 385,583.052 | 1,248.491 | 0.275274 | 0 | pruned rank 8 |
| incumbent `s17v` | 2 / 20 | 21.534263 | 0.329454 | 340,007.872 | 1,174.925 | 0.248466 | 2 | retained rank 57 |

`s16v` has 13.76% less area, 109.804 mm less span, zero holes, and even more
continuous contact units than the winner branch. The trace records its reason as
`displaced_by_protected_incumbent`; rank-57 `s17v` consumes the eighth beam slot
because it is the protected incumbent.

This does not justify deleting incumbent protection globally: previous fixed
quota/removal experiments regressed other fixtures. It does show that incumbent
protection needs a quality envelope or stage limit. A rank-57 incumbent with
fewer dominant contacts, eight fewer total contacts, worse worst-consumption,
and two holes should not displace a rank-8 no-hole candidate.

## Previously tested adaptive strategies against this evidence

- `depth21-total2` matches the current comparator through 20 placed pieces, then
  keeps dominant contact strict, bands total contacts by two, and lets bounds
  compactness decide inside the band. It preserves `su7` at step 22 and `s16v`
  at step 31. Previous deterministic runs kept the triangle golden and all
  20-piece corpus fixtures byte-identical, while mixed-61 improved to area
  `436,789.920` (-17.9%), span `1,338.205`, hull waste `0.246346`, contacts
  `56 / 14`, and two holes. It previously regressed pentagons-50 by 9.1%.
- global normalized-contact band width 2 would also preserve `s16v` and improved
  mixed-61 by about 19.9%, but it breaks the triangle golden and is unsuitable
  as a global rule.
- contact-density band `0.06` preserves the known golden/20-piece gates and has
  smaller recorded regressions (pentagons-50 +4.5%, mixed-50 +0.8%), but it does
  not preserve `s16v` at this exact step because 28 and 29 contacts fall into
  different density buckets.
- fixed dual-objective beam quotas preserve the golden but only improve
  mixed-61 by about 11%, create five holes, lose many contacts, and regress
  rectangles-50 by 6.4%. They are weaker than the scale-aware comparator here.

Given the user's stated willingness to accept a moderate specialist regression
to prevent unacceptable large mixed layouts, `depth21-total2` is the strongest
already-measured separator supported by these traces. It should still be
exposed/documented as scale-aware ranking semantics, not keyed to this fixture.

## Actionable changes

1. **Use scale-aware total-contact slack after the small-layout phase.** Retain
   strict dominant structural contact, but compare total structural contacts in
   width-two bands once more than 20 pieces are placed, then apply the existing
   compactness tuple. This is the smallest proven change that keeps the approved
   20-triangle behavior and preserves the pivotal better mixed branches.
2. **Make terminal repair use the same adaptive acceptance comparator.** Under
   the current strict comparator repair iteration 1 and iteration 3 are accepted
   solely for one contact despite 5.59% and 2.18% area growth. At minimum, repair
   must reject contact gains that cross a material bounds-growth guard; preferably
   it should call the exact selected whole-layout comparator.
3. **Bound incumbent protection instead of deleting it.** Keep the protected
   incumbent only when it remains inside a documented rank/quality envelope, or
   stop unconditional protection after the early search phase. Add a regression
   fixture for the step-31 pattern: a rank-8 no-hole state must not be displaced
   by a rank-57 state that is worse on dominant contact, total contact, worst
   consumption, and holes.
4. **Keep dominant contact strict for now.** The useful branches above tie on
   dominant count and differ by only one total contact. Relaxing dominant motif
   count is not necessary to recover them and carries more risk for repeated
   lattice fixtures.
5. **Do not recommend repair budget 8 on this fixture until acceptance is
   corrected.** The trace proves that current repair makes the final envelope
   worse; the beam itself is not responsible for the difference between the two
   morning screenshots.

## Conclusion

The morning traces identify two independent defects, not search randomness:

1. strict total-contact ranking throws away materially tighter same-dominant
   branches for a single extra contact;
2. unconditional incumbent protection can evict the last valid compact branch;
3. terminal repair repeats the first defect and expands the final envelope.

The two runs are deterministic and their beam search is byte-identical. The
strongest evidence-backed next production candidate is the already-tested
post-20, width-two total-contact band, paired with the same comparator for repair
acceptance and a bounded incumbent-protection rule.
