# Contact-tier intrinsic reservation handoff

This page preserves the external `contact-tier-intrinsic-reservation` report as
research input. The original experiment branch and immutable artifact directory
are not present in this checkout, so the measurements below are report-derived
and are not presented as a fresh reproduction.

## Experiment result

The experiment started from `b750ac0` and tested sheet-independent local
reservations inside contact-aware fanout.

| Variant | Mechanism | Result | Decision |
| --- | --- | --- | --- |
| M | intrinsic area, then span | triangle long side grew to `927.024 mm` | reject; area-first greedy growth is chain-forming |
| M1b | maximum side, then area, then span | exact triangle golden and `93/93` tests; pentagons and star hulls became invariant; the old mixed-61 `1000 x 1700` strip lost about `35%` envelope area | research-positive, production-negative |
| M2 | balanced plus intrinsic reservations | kept the new invariances and reached `480,588 mm2` on mixed-61 `1000 x 1300` | reject; reference sheet regressed about `30%` |

M1b's production rejection matters. On the then-approved mixed-61
`2000 x 2700` reference, envelope area alone appeared unchanged while holes
rose from `2` to `10` and structural contacts fell from `56/14` to `42/10`.
On `1000 x 1300`, runtime rose by roughly `15x`. M2 spent two global
reservations on competing policies and repeated the reference regression.

Pentagons and star hulls are not independent evidence families in the current
corpus: convexification produces the same five-vertex collision hull. Their
matching invariant result is still evidence that the intrinsic comparator can
stabilize a homogeneous motif, but it counts as one shape family.

## Durable findings

The standalone variants are rejected, not erased. Their reusable conclusions
are:

1. intrinsic greedy compactness must lead with cluster maximum side; area-first
   selection rewards chains;
2. a diversity mechanism must preserve exact contact tiers and the production
   winner rather than replace them globally;
3. a protected alternative lane is safer than splitting every fanout or beam
   reservation between two policies;
4. terminal promotion needs independent envelope, contact, hole, and golden
   guards because equal area is not equal layout quality;
5. every reservation must be visible in decision traces;
6. sheet invariance is a first-class diagnostic, not a sufficient quality gate;
7. the `1000 x 1300` slowdown is a profiling problem separate from ranking
   correctness.

## Current-base follow-ups

The narrower current-base local port is documented in
[Protected contact-tier intrinsic reservation](protected-contact-tier-reservation.md).
It confirmed the maximum-side mechanism on homogeneous hulls but regressed
trapezoids and mixed-50 and did not change mixed-61, so that local reservation
was rejected.

The next follow-up moved diversity to an isolated whole-beam lane. It is
documented in
[Protected boundary-anchor diversity](protected-boundary-anchor-diversity.md).
That experiment preserves production output unless a protected terminal state
is strictly better under the production comparator and strictly smaller in
envelope area.
