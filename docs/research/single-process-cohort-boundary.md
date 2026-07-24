# Single-Process Compact Cohort Boundary

## Decision

Compact must remain single-process for each nesting job until the user
explicitly changes this rule. Complete and capacity cohorts are logical,
protected search cohorts. They advance through deterministic cooperative
checkpoints inside the existing algorithm worker; they are not separate CPU
tasks.

Forbidden without a new explicit user instruction:

- nested workers or `worker_threads`;
- child processes or subprocesses;
- simultaneous complete and capacity executions;
- concurrent benchmark arms for one nesting request.

## Evidence that led to the stop

Source `d0c64b8` added isolated measurement arms on the rejected P4 branch.
Mixed-61 `700 x 500` measured:

| Arm | Wall time | Placed | Endpoint |
| --- | ---: | ---: | --- |
| Current production | `79.164 s` | `48/61` | warm-prefix continuation selected |
| Complete only | `54.116 s` | n/a | no fitting complete endpoint |
| Cold capacity only | `9.194 s` | `47/61` | cold-search endpoint |

The difference proves that merely overlapping the cold lane would lose one
placed piece. The estimated cold-overlap percentage was only a theoretical
ceiling, not an achieved quality-preserving speedup. A concurrent pilot was
started, then cancelled as soon as the user clarified that even separate
processes violated the intended restriction. No concurrent result is accepted.

The serial extraction seam itself passed exact fit, miss, and preflight-proof
semantic equivalence at SHA-256
`95e417e0fbf36f34859df4521d7dbc96ae25a3be217936da3e43dc5b5855bd9b`.
That evidence remains useful, but the seam produces no speedup by itself and
does not authorize parallel execution.

## Consequence

Do not merge the P4 timing-arm or parallel-execution experiment into
production. Future performance work must optimize or reschedule cooperative
single-worker execution, preserve the current 48-piece warm-prefix result, and
pass the existing exact baseline gates.
