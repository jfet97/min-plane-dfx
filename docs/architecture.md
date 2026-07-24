# Architecture

This is the entry point for architecture documentation in `min-plane-dfx`.

## HARD CONSTRAINT: ONE NESTING PROCESS ONLY

> **UNTIL THE USER EXPLICITLY REVOKES THIS RULE, ONE NESTING JOB MUST USE
> EXACTLY ONE ALGORITHM WORKER EXECUTION. DO NOT START NESTED WORKERS,
> `worker_threads`, CHILD PROCESSES, SUBPROCESSES, OR CONCURRENT COMPLETE AND
> CAPACITY EXECUTIONS. ALL PORTFOLIO COHORTS MUST ADVANCE COOPERATIVELY AND
> SEQUENTIALLY INSIDE THE EXISTING WORKER.**

“Single process” here describes algorithm execution for one nesting job. It
does not remove Electron's existing renderer/main/worker application boundary.
No benchmark result, roadmap item, or external-project pattern authorizes an
exception. Only a new explicit user instruction can change this rule.

Start from the [documentation index](./README.md), then read this file and
[`architecture/index.md`](./architecture/index.md) before designing or
implementing changes.

## Architecture Tree

[`architecture/index.md`](./architecture/index.md) routes to focused docs for:

- process boundaries;
- Effect runtime and service ownership;
- project persistence;
- UI clarity;
- algorithm boundary.

## Repository Shape

The app is intentionally compact:

```text
Vue renderer
  -> preload API
  -> Electron main IPC handlers
  -> Effect-backed main services
  -> WorkerSupervisor
  -> worker_threads nesting worker
     -> rectangular MaxRects beam search
     -> convex irregular algorithm path
```

Main owns filesystem, dialogs, project files, imports, exports, and worker
lifecycle. The renderer owns UI state only. The worker owns computation
workflow and history emission for a single job. Rectangular nesting uses
MaxRects. Convex irregular nesting uses either its ordinary requested-sheet
beam/GA decoder or, for the eligible Compact quality profile, the intrinsic
shared archive described in
[`architecture/irregular-v2-infrastructure.md`](./architecture/irregular-v2-infrastructure.md).

## Non-Negotiable Boundary

The worker owns nesting computation. Infrastructure may prepare requests, validate data, display imported DXF geometry, show worker results, and replay emitted history. It must not fabricate placements, scores, history, or strategy output outside the algorithm path.
