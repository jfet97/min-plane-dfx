# Agent Instructions

`min-plane-dfx` is a local Electron desktop app for preparing DXF rectangular nesting jobs.

- `src/main/`: Electron main process, IPC handlers, dialogs, filesystem services, worker supervision.
- `src/preload/`: context bridge API exposed to the renderer.
- `src/renderer/`: Vue UI, composables, canvas preview, desktop-tool interaction state.
- `src/shared/`: domain models, schemas, IPC and worker protocols.
- `src/workers/`: Node worker entry point and the nesting algorithm.
- Package manager: `pnpm`.

## Read First

For implementation work, read these files before editing:

1. [`SCORING_CRITERIA_NOTES.md`](./SCORING_CRITERIA_NOTES.md)
2. [`docs/architecture.md`](./docs/architecture.md)
3. The relevant narrower docs under [`docs/architecture/`](./docs/architecture/index.md)

If a task touches Effect APIs, inspect the installed packages in `node_modules` first. Prefer local installed types and source over memory or web docs.

## Hard Rules

- Keep placement, candidate generation, scoring, and search behavior inside
  `src/workers/algorithm/`. Deterministic irregular-v2 geometry kernels,
  collision-artifact construction, and their Effect service boundaries live in
  `src/workers/irregular/`; they must not invent placements, scores, history,
  or search behavior.
- For irregular geometry, Clipper2 owns Boolean operations on canonical integer
  paths, exact integer-grid metrics and ordering use `BigInt` shoelace, cross,
  and rational cross-multiplication, and robust predicates own orientation and
  intersection decisions on unsnapped source geometry. Never replace those
  authorities with arbitrary absolute or relative epsilons. A numeric tolerance
  is allowed only when it is a documented bound derived from quantization,
  flattening, or offset construction; it must not decide collision legality,
  topology, or winner ranking.
- A `Number` fast path may replace a `BigInt` exact-grid operation only when it
  is provably exact, never as a tolerance. Prove a bound per operation, check the
  operands against it *before* any multiplication or accumulation, and fall back
  to `BigInt` outside it — converting an already-rounded `Number` back cannot
  recover exactness. Every such path needs a differential test against the
  `BigInt` implementation that straddles the bound in both directions.
  `canonicalGridCrossSign` is the worked example.
- Do not add fake placements, fake free rectangles, fake scores, fake ranking, or fake history.
- Keep docs up to date with code changes. If implementation changes architecture, protocols, workflows, validation, persistence, or agent conventions, update the relevant `docs/` page and/or this file in the same development cycle.
- `src/workers/algorithm/sortPiecesForNesting.ts` is the user-owned initial ordering boundary. Do not change its behavior unless the user explicitly asks for algorithm work.
- Strategy IDs are descriptive strings loaded from configuration, not TypeScript unions.
- Use schema decoding at untrusted boundaries: IPC payloads, worker messages, loaded JSON, imported files, and replay NDJSON.
- Treat exported Effect Schemas as the single owner of validation for schema-backed
  inputs. Put finite-number, range, enum, structural, and cross-field input
  invariants in the relevant schema, then decode at the boundary. Do not repeat
  those input checks inside services or algorithms. Runtime checks remain only
  for values derived after decoding, external-library output, arithmetic
  overflow, or invariants that cannot be represented by the input schema.
- Keep `Schema.Class` out of trusted algorithm hot paths. A type the search
  produces from decoded input, consumes itself, and never sends across a worker,
  IPC, or persistence boundary as a schema-backed instance must be a plain
  class: schema construction
  revalidates the whole nested value every time, including already-validated
  nested instances passed by reference. See
  [`docs/architecture/schema-models.md`](./docs/architecture/schema-models.md).
  Before adding one, confirm the class itself appears in no encoded schema. If
  an untrusted boundary carries the same structural shape, declare a separate
  boundary schema beside it and decode there.
- No `as any`, `as unknown as`, or `as never` in app code. Prefer typed adapters, discriminated unions, guards, and explicit errors.
- Avoid non-null assertions in runtime code. Use guards or explicit errors.
- Use `@effect/platform-node` for Node filesystem/path services. Do not hand-roll FileSystem or Path layers.
- Renderer state writes go through composable actions such as hydration, replacement, or reset methods.
- The app uses an Effect SQLite workspace in Electron `userData` for imported DXF copies and temporary project metadata. A user-selected JSON project is still the portable snapshot/export format.

## UI Rules

- Keep the UI dense, restrained, and CAD/tool-like.
- Prefer compact labels, native titles/tooltips, helper rows, and disabled-state explanations over large explanatory blocks.
- Make algorithm status honest: show worker-reported statuses and unplaced pieces directly.
- Result rendering must be driven by real worker results or imported source geometry. Do not invent preview data.

## Validation

After development changes, run from the repo root:

```sh
pnpm lint:fix
pnpm typecheck
```

If every modified file is Markdown (`*.md`), skip lint, typecheck, and tests.
Review the Markdown diff directly instead.

For UI work, also run:

```sh
pnpm dev
```

Then verify the empty state, disabled controls, and that no fake algorithm output was introduced.

## Algorithm Experiment Provenance

- Run competing placement, search, or scoring experiments on dedicated branches
  and isolated worktrees. Do not stack unrelated hypotheses in the main working
  tree.
- Create every new `min-plane-dfx` worktree under
  `/Users/andreasimonecosta/Documents/Work/min-plane-dfx-worktrees/`. Do not
  create worktrees under `/tmp`, `/private/tmp`, or another transient directory.
  `/private/tmp/min-plane-provenance/` remains only for immutable experiment
  manifests and intermediate evidence, never for working checkouts.
- Before changing an experiment, commit the exact implementation that produced
  any result worth comparing. Use a descriptive human branch and commit name.
- For every reported layout, record the source commit, uncommitted diff or
  injected comparator, exact fixture/request, sheet dimensions, optimizer
  settings, runtime environment, metrics, and SVG/PNG paths.
- Keep immutable experiment manifests and artifact hashes under
  `/private/tmp/min-plane-provenance/` while iterating. Copy accepted reference
  artifacts into `docs/artifacts/` so they remain readable on other machines.
- Update the relevant topic under `docs/history/` and `docs/research/`, plus the
  active roadmap when forward work changes, with accepted results, rejected
  hypotheses, regressions, and open questions before starting the next
  materially different experiment.
- Never describe a layout as reproducible until its recorded checkout and
  command regenerate the same canonical geometry hash.
- Merge or cherry-pick only after comparing the isolated result against the
  triangle golden and the relevant mixed/corpus gates. Keep rejected branches
  or their manifests until their findings have been documented.

## Active Work Continuity

- Starting a subagent, external reviewer, background command, detached process,
  monitored experiment, or other asynchronous task creates an active obligation.
  Do not end the turn with a progress-only response while any such work remains
  relevant and non-terminal.
- Keep monitoring active work until it completes, fails, is explicitly cancelled,
  or reaches a genuine blocker that requires user input or an external state
  change. A wait timeout, an empty poll, a slow reviewer, or "still running" is
  not a terminal condition; check status and wait again.
- If the user asks a status question or requests a brief explanation while work
  is active, answer it and then immediately resume monitoring or execution in the
  same turn. Treat the interruption as replacing the active task only when the
  user clearly cancels or supersedes it.
- After context compaction, reconnecting, a tool interruption, or uncertainty,
  inspect the active processes, reviewer sessions, and subagents before doing
  anything else. Reattach to existing work instead of launching duplicate work.
- Before sending a final response, perform a terminal-state audit of every task
  started during the turn. The final response must include the completed result,
  a verified failure, an explicit cancellation, or a concrete blocker for each
  one; never silently abandon an active task.

## Pull Requests

Use exactly these sections, in order:

```md
## Why

## What

## How

## Remarks
```

Do not add validation sections, command lists, AI attribution, co-author lines, or tool/process notes.

## Knowledge Base

This project may have an LLM-maintained knowledge base in `knowledge/` (git-ignored). If it doesn't exist, ignore this section. If it does exist, follow these rules:

- For facts about this codebase, consult `knowledge/INDEX.md` and its pages before reading the code.
- To look something up yourself, search the KB directly (no skill): read `INDEX.md`, then use `qmd query "..." -n 5` (if `qmd` is on PATH, a fast first pass; bump to `-n 10` if the first pass under-recalls) and `grep`/`rg` over `knowledge/*.md` to dig deeper. They are complementary, not exclusive: `grep`/`rg` catches exact strings and cross-checks hits; having `qmd` never removes the need to grep.
- After meaningful work (features, refactors, non-obvious fixes) or after pulling new commits, use `$knowledge update`.
- `$knowledge query <question>` gives a synthesized cited answer (`--persist <slug>` files it back as a wiki page); `$knowledge lint` checks health; `$knowledge help` lists commands.
