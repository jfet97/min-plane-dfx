# Capacity one-count-deficit continuation

Date: 2026-07-24.

Production base: `d43ec843dfc3ab8e349a468146191323c990bfd9`.

Experiment branch: `capacity-one-count-deficit`.

The experiment tested whether the width-16 capacity cohesion frontier loses a
useful state solely because it trails the current best placed count by one.
The observer was generic: it used the existing exact candidate generator,
legality checks, cavity measurements, capacity comparator, beam width, and
evaluation bounds. It did not change the protected complete cohort, requested
sheet scoring, production capacity output, or terminal comparator.

## Stage A: unchanged-boundary trace

Commit `209e488721035192693cc46a22e8ade3dc9f0014` first recorded raw
retained identities. The search result was unchanged, but the trace occupied
`1,452,157` bytes and therefore failed the preregistered `1 MiB` bound. That
state remains preserved as rejected instrumentation evidence.

Commit `d57046cc4076543115f7b6b4acd447f83d872ff8` replaced only those
raw identities with SHA-256 identities while retaining the complete candidate
future-decision fields. Three alternating control/observer pairs on Mixed-61
`300 x 300` produced:

- identical `6/61` placement and exact placed/unplaced partition;
- identical collision hash `bb22df35...` and fitted hash `37d7bf9c...`;
- identical 149,719 placement evaluations and 61 completed depths;
- a deterministic 160,846-byte observer trace with digest `8aaf75b4...`;
- four eligible one-count-deficit witnesses, at depths 2, 5, 12, and 53;
- median observer overhead `23.815 ms`, or `1.84%`, below the `500 ms`
  trace ceiling.

Evidence:

- `/private/tmp/min-plane-provenance/capacity-one-count-deficit/209e488-stage-a/`;
- `/private/tmp/min-plane-provenance/capacity-one-count-deficit/d57046c-stage-a/`.

## Stage B: protected continuation

Commit `fd44bb30562aa13557b4a9ceb8ac6a17dd4ef091` added a distinct
observer-only producer and retention mode. At an eligible depth it computes
the unchanged cohesion control first and replaces only `control[15]`; at every
other depth it continues the exact control list. The role and retention mode
are included in the checkpoint fingerprint.

The observer settled uncensored on Mixed-61 `300 x 300`:

| Metric | Production capacity | Deficit continuation |
| --- | ---: | ---: |
| placed pieces | 6 | 6 |
| collision hash | `bb22df35...` | `bb22df35...` |
| envelope area | `89,504.369008 mm2` | `89,504.369008 mm2` |
| cavities | 0 | 0 |
| placement evaluations | 149,719 | 149,200 |
| completed depths | 61 | 61 |
| observer runtime | n/a | `1,176.694 ms` |

The lane encountered 19 eligible substitutions while evolving its own
frontier, but selected the exact same terminal endpoint. A seven-depth
pause/resume schedule reproduced the uninterrupted endpoints, accounting,
settlement, and 61-depth count-deficit trace exactly. The 249,544-byte Stage B
trace remained below the `1 MiB` bound.

Evidence:

- `/private/tmp/min-plane-provenance/capacity-one-count-deficit/fd44bb3-stage-b/`.

## Decision

Reject P0 before the second fixture and nine-case matrix because it did not
strictly improve the targeted endpoint. Retain the branch and immutable
provenance, but do not merge the observer implementation.

The trace does not prove the specific small-before-macro causal ordering loss
required to activate P3. P3 therefore remains skipped rather than being
inferred from P0's terminal tie. Production geometry and runtime are unchanged.
