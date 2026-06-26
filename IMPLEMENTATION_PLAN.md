# Min Plane DXF Electron Implementation Plan

## 0. Non-Negotiable Scope Boundary

This file is a handoff plan for an implementation agent.

The implementation agent must build the application infrastructure, UI, data flow, DXF import, validation, worker orchestration, persistence, and all communication boundaries.

The implementation agent must not implement the nesting algorithm.

The only algorithm-like function it is allowed to add is an identity sort function:

```ts
export function sortPiecesForNesting<T>(pieces: ReadonlyArray<T>): ReadonlyArray<T> {
  return pieces
}
```

That function must return the input unchanged.

No MaxRects, no beam search, no greedy placement, no rectangle packing, no placement heuristics, no optimization, no "temporary simple layout" fallback, no fake packing preview.

The future algorithm versions will be written manually by the user later.
The implementation agent must not invent or implement those versions.
The first real algorithm version will likely be a single strategy; the app must not require multiple strategies to exist.
The app must be ready for user-written algorithm versions to be inserted behind a stable TypeScript interface.
The initial rectangle ordering for the future algorithm is documented in `SCORING_CRITERIA_NOTES.md`: padded longest side descending, then padded area descending, then padded imbalance descending.
The implementation agent must not implement that ordering now; the current stub sort still returns the input unchanged.

## 1. Source Material Read Before Planning

The reference document in `~/Downloads/nesting_maxrects_beam_v1_reviewed.tex` describes the intended algorithmic domain:

- DXF shapes are reduced to real bounding boxes.
- Each real bounding box is expanded by padding to represent minimum distance between parts.
- A valid final layout must keep all placed footprints inside a rectangular sheet.
- Placed footprints must not overlap.
- The original algorithm idea is MaxRects with local rotations, candidate scoring, multiple orderings, and beam search.
- The objective in the reference material is compactness of the used cluster, not maximizing sheet area.
- The reference material includes final checks for containment, non-overlap, padded dimensions, and consistent transformation of real geometry into the chosen footprint.

Important override for this app version:

- Do not use OCaml for now.
- Use Electron, TypeScript, Vue, and Node.js workers.
- Use `effect-smol` for app workflows and communication boundariesè chiaro .
- Vue is acceptable for the frontend.
- `effect-atom` may be used for frontend state if its Vue integration is straightforward and current.
- The implementation must leave the algorithm as an identity sort stub.
- Another future difference from the TeX reference will be provided later, so keep algorithm decisions isolated and easy to replace.

## 2. Product Goal

Build a local desktop app for preparing DXF rectangular nesting jobs.

The app should let the user:

1. Load one or more shapes from one or more DXF files.
2. Parse supported geometry into distinct pieces/shapes.
3. Compute and display real bounding boxes for every imported shape.
4. Enter the target sheet dimensions directly in the app.
5. Configure unit assumptions, padding, and rotation permissions.
6. Send a validated nesting request to a Node.js computation worker.
7. Receive a typed worker result.
8. Display the algorithm result in two synchronized views:
   - a rectangle view that shows the padded footprint placements;
   - a true DXF shape view that shows the real imported geometry transformed into the placement.
9. Display the algorithm history when the future algorithm emits it:
   - slider playback over plate states;
   - support for beam search with `K=5`;
   - support for multiple automatic scoring-strategy runs when the user-written algorithm provides them;
   - each strategy run has its own final result and its own winning-path history;
   - free-rectangle overlays and split/prune visualization.
10. Let the user inspect strategy runs separately in the UI.
11. Later, support a final-selection action such as "best result" or "top N results"; the final-result scoring criteria are intentionally undecided for now.
12. Display imported pieces, bounding boxes, warnings, job status, and algorithm placeholder output.
13. Save and reload local project files.
14. Export the request, placeholder result, and history NDJSON as debugging artifacts.

The app should not attempt to produce real placements until the algorithm is added later.
The UI must still be built as if real placements will arrive from the worker, because the user must be able to see the algorithm result once the algorithm is implemented.

## 3. Recommended Stack

Use a single TypeScript Electron app with Vite and Vue.

Recommended technologies:

- Runtime: Electron.
- Main/backend language: TypeScript.
- Renderer/frontend: Vue 3 with Vite.
- Worker runtime: Node.js `worker_threads`.
- Effects/workflows: `effect-smol`.
- Frontend state: Vue composables by default, optionally `effect-atom` if it has a clean Vue package.
- DXF parsing: `dxf-parser` or another maintained npm DXF parser, plus a local bbox extraction layer.
- Validation: use one schema system consistently. Prefer whatever integrates cleanly with `effect-smol`; otherwise use `zod` at all IPC, file, and worker boundaries.
- Tests: Vitest for unit tests, Playwright only if Electron e2e is practical in the generated project.
- Package manager: pnpm.

Before importing `effect-smol` or `effect-atom`, inspect the installed package exports and examples. Do not invent API names. If `effect-atom` has no clear Vue integration, skip it and use Vue state plus effectful services.

Local Effect reference:

- The scanner checkout at `/Users/andreasimonecosta/Documents/Work/scanner` has embedded Effect source instructions that are useful for this implementation.
- In scanner, `repos/effect` is a git subtree of `https://github.com/Effect-TS/effect-smol.git`; read `/Users/andreasimonecosta/Documents/Work/scanner/repos/effect/LLMS.md` and the local source when checking real Effect v4 / effect-smol APIs.
- Scanner's README section "Embedded Effect / effect-app source" documents `pnpm embedded:effect:link`, `pnpm embedded:effect:status`, `pnpm embedded:effect:unlink`, and subtree update commands such as `pnpm effa sync-effect` and `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect-smol.git <ref> --squash`.
- Treat scanner's `repos/effect` as reference source only for this app. Do not import from `/Users/andreasimonecosta/Documents/Work/scanner/repos/*`; this app must depend on normal package imports from its own `node_modules`.
- Prefer the local scanner reference over web searches for Effect API details. If the local reference and installed package disagree, the installed package used by this app wins.

## 4. Project Shape

Keep the first version compact. Do not create a large monorepo unless the tooling template already does that cleanly.

Recommended structure:

```text
.
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── electron.vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── src
│   ├── main
│   │   ├── index.ts
│   │   ├── app
│   │   │   ├── createWindow.ts
│   │   │   ├── paths.ts
│   │   │   └── lifecycle.ts
│   │   ├── ipc
│   │   │   ├── channels.ts
│   │   │   ├── handlers.ts
│   │   │   └── validateIpc.ts
│   │   ├── services
│   │   │   ├── DxfImportService.ts
│   │   │   ├── ProjectFileService.ts
│   │   │   ├── WorkerSupervisor.ts
│   │   │   └── ExportService.ts
│   │   └── runtime
│   │       └── effectRuntime.ts
│   ├── preload
│   │   ├── index.ts
│   │   └── api.ts
│   ├── renderer
│   │   ├── main.ts
│   │   ├── App.vue
│   │   ├── components
│   │   │   ├── AppShell.vue
│   │   │   ├── FileDropZone.vue
│   │   │   ├── SheetSettingsPanel.vue
│   │   │   ├── PieceTable.vue
│   │   │   ├── DxfPreviewCanvas.vue
│   │   │   ├── WorkerJobPanel.vue
│   │   │   └── ResultPanel.vue
│   │   ├── composables
│   │   │   ├── useAppStore.ts
│   │   │   ├── useElectronApi.ts
│   │   │   └── useJobRunner.ts
│   │   ├── styles
│   │   │   ├── base.css
│   │   │   └── theme.css
│   │   └── types
│   │       └── global.d.ts
│   ├── shared
│   │   ├── domain
│   │   │   ├── ids.ts
│   │   │   ├── geometry.ts
│   │   │   ├── dxf.ts
│   │   │   ├── nesting.ts
│   │   │   └── project.ts
│   │   ├── protocol
│   │   │   ├── ipc.ts
│   │   │   ├── worker.ts
│   │   │   └── errors.ts
│   │   ├── schemas
│   │   │   ├── geometrySchemas.ts
│   │   │   ├── nestingSchemas.ts
│   │   │   └── projectSchemas.ts
│   │   └── utils
│   │       ├── assertNever.ts
│   │       └── result.ts
│   └── workers
│       ├── nesting.worker.ts
│       ├── algorithm
│       │   ├── sortPiecesForNesting.ts
│       │   └── computeNestingStub.ts
│       └── runtime
│           └── workerRuntime.ts
├── tests
│   ├── unit
│   │   ├── schemas.test.ts
│   │   ├── dxfBbox.test.ts
│   │   ├── workerProtocol.test.ts
│   │   └── algorithmStub.test.ts
│   └── fixtures
│       ├── simple-line-rect.dxf
│       └── mixed-supported-entities.dxf
└── docs
    ├── architecture.md
    └── algorithm-boundary.md
```

If the chosen Electron template uses `electron/main`, `electron/preload`, and `src/renderer`, keep the template layout. The important part is the boundary separation, not the exact folder names.

## 5. Architecture

Use this process model:

```text
Vue renderer
  -> preload API
  -> Electron main IPC handlers
  -> effect-smol services
  -> Node.js worker supervisor
  -> worker_threads nesting worker
  -> identity sort stub
```

Renderer responsibilities:

- Render the UI.
- Hold transient UI state.
- Request file imports, project saves, job runs, cancellation, and exports through `window.appApi`.
- Never access Node APIs directly.
- Never spawn workers directly.
- Never read or write arbitrary files directly.

Preload responsibilities:

- Expose a small typed API through `contextBridge`.
- Hide raw IPC channel names from Vue components.
- Validate or narrow arguments where possible.
- Return promises with typed response envelopes.

Main process responsibilities:

- Own filesystem access.
- Own dialogs.
- Own project persistence.
- Own DXF file loading.
- Own worker lifecycle.
- Validate all renderer inputs before processing.
- Validate all worker outputs before returning them to the renderer.

Worker responsibilities:

- Receive a validated `NestingWorkerRequest`.
- Run the computation workflow through `effect-smol`.
- Call only the identity sort stub in the algorithm module.
- Return a typed result envelope.
- Emit NDJSON-compatible history events when history is enabled.
- Retain or stream full plate history according to `historyMode`.
- Emit progress events for lifecycle milestones only, not fake algorithm progress.

## 6. Security Model

Electron must be configured with a secure default posture:

- `contextIsolation: true`.
- `nodeIntegration: false`.
- `sandbox: true` if compatible with the selected template and preload needs.
- No direct `ipcRenderer` exposure.
- No remote module.
- No dynamic execution in the renderer.
- Use an allowlist of IPC channels.
- Validate every request and response crossing IPC.

The preload API should look conceptually like this:

```ts
export interface AppApi {
  selectDxfFiles(): Promise<IpcResult<ImportedDxfDocument[]>>
  importDxfFiles(paths: string[]): Promise<IpcResult<ImportedDxfDocument[]>>
  runNesting(input: NestingRequest): Promise<IpcResult<NestingResult>>
  onNestingHistory(callback: (event: NestingHistoryEvent) => void): Unsubscribe
  loadHistoryReplay(ref: ProjectHistoryRef): Promise<IpcResult<ReadonlyArray<NestingHistoryFrame>>>
  cancelJob(jobId: JobId): Promise<IpcResult<void>>
  saveProject(project: ProjectDocument): Promise<IpcResult<SavedProjectRef>>
  openProject(): Promise<IpcResult<ProjectDocument>>
  exportNestingRequest(input: NestingRequest): Promise<IpcResult<void>>
  exportNestingResult(result: NestingResult): Promise<IpcResult<void>>
  exportNestingHistory(ref: ProjectHistoryRef): Promise<IpcResult<void>>
}
```

Do not expose generic `readFile`, `writeFile`, `send`, or `invoke` methods to the renderer.

## 7. Domain Model

Use millimeters internally. If DXF units are missing or unknown, let the user choose the interpretation and store it in the project.

Core types:

```ts
export type Millimeters = number

export interface Point2 {
  readonly x: Millimeters
  readonly y: Millimeters
}

export interface Size2 {
  readonly width: Millimeters
  readonly height: Millimeters
}

export interface Rect {
  readonly x: Millimeters
  readonly y: Millimeters
  readonly width: Millimeters
  readonly height: Millimeters
}

export interface SheetSpec {
  readonly width: Millimeters
  readonly height: Millimeters
  readonly label: string
}

export interface ImportedPiece {
  readonly id: PieceId
  readonly sourceFileId: SourceFileId
  readonly sourceLayer?: string
  readonly label: string
  readonly realBounds: Rect
  readonly geometry: DxfGeometrySummary
  readonly warnings: ReadonlyArray<ImportWarning>
}

export interface PreparedPiece {
  readonly id: PieceId
  readonly sourcePieceId: PieceId
  readonly realBounds: Rect
  readonly paddedBounds: Size2
  readonly padding: Millimeters
  readonly allowRotation: boolean
}

export interface NestingRequest {
  readonly version: 1
  readonly jobId: JobId
  readonly sheet: SheetSpec
  readonly padding: Millimeters
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly options: NestingOptions
}

export interface NestingOptions {
  readonly allowGlobalRotation: boolean
  readonly timeoutMs: number
  readonly workerMode: "stub"
  readonly historyMode: "stream" | "final" | "off"
  readonly historyScope: "winning_path"
  readonly strategySelectionMode: "single" | "all_configured"
  readonly strategyIds: ReadonlyArray<NestingStrategyId>
  readonly finalSelectionMode: "manual" | "best" | "top_n"
  readonly topN?: number
  readonly maxHistoryEvents?: number
}

export interface Placement {
  readonly pieceId: PieceId
  readonly x: Millimeters
  readonly y: Millimeters
  readonly width: Millimeters
  readonly height: Millimeters
  readonly rotation: 0 | 90
}

export interface NestingResult {
  readonly version: 1
  readonly jobId: JobId
  readonly status: "stub" | "completed" | "failed"
  readonly strategyResults: ReadonlyArray<NestingStrategyResult>
  readonly selectedStrategyRunId?: string
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly placements: ReadonlyArray<Placement>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly historySummary?: NestingHistorySummary
  readonly warnings: ReadonlyArray<NestingWarning>
  readonly stats: {
    readonly elapsedMs: number
    readonly pieceCount: number
  }
}
```

Future multi-strategy result types:

```ts
export type NestingStrategyId = string

export interface NestingStrategyDefinition {
  readonly id: NestingStrategyId
  readonly label: string
  readonly description: string
  readonly prefix: "balanced_compactness" | "short_side_fill"
  readonly tail: ReadonlyArray<"r" | "s" | "y" | "x">
}

export interface NestingStrategyResult {
  readonly strategyRunId: string
  readonly strategyId: NestingStrategyId
  readonly strategyLabel: string
  readonly strategyDescription?: string
  readonly status: "stub" | "completed" | "failed" | "cancelled"
  readonly sortedPieceIds: ReadonlyArray<PieceId>
  readonly placements: ReadonlyArray<Placement>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly historySummary?: NestingHistorySummary
  readonly finalScore?: FinalResultScore
  readonly stats: {
    readonly elapsedMs: number
    readonly pieceCount: number
  }
  readonly warnings: ReadonlyArray<NestingWarning>
}

export interface FinalResultScore {
  readonly strategyRunId: string
  readonly rank?: number
  readonly tuple?: ReadonlyArray<number>
  readonly mode?: "compact_first" | "largest_free_area_first" | "largest_free_short_side_first"
  readonly label: string
}
```

For the current stub:

- `strategyResults` may contain one stub strategy result.
- `selectedStrategyRunId` may point to that stub run.
- top-N and best-result selection must be UI/API placeholders only.
- Do not implement the final result scoring logic yet.
- The future final ranking modes currently under discussion are documented in `SCORING_CRITERIA_NOTES.md`.
- Stub results are not valid final nesting results and must be excluded from final ranking.

History and trace types:

```ts
export interface FreeRectangle {
  readonly id: FreeRectId
  readonly x: Millimeters
  readonly y: Millimeters
  readonly width: Millimeters
  readonly height: Millimeters
  readonly source?: "initial" | "split" | "pruned" | "algorithm"
}

export interface PlateSnapshot {
  readonly placements: ReadonlyArray<Placement>
  readonly freeRectangles: ReadonlyArray<FreeRectangle>
  readonly usedBounds?: Rect
}

export interface BeamCandidateTrace {
  readonly candidateId: string
  readonly pieceId: PieceId
  readonly placement?: Placement
  readonly score?: ReadonlyArray<number>
  readonly accepted: boolean
  readonly reason?: string
}

export interface BeamStepTrace {
  readonly strategyRunId: string
  readonly strategyLabel: string
  readonly stepIndex: number
  readonly insertedPieceId?: PieceId
  readonly beamRank: number
  readonly beamWidth: number
  readonly candidateCount?: number
  readonly selectedCandidateId?: string
}

export interface FreeRectangleSplitTrace {
  readonly strategyRunId: string
  readonly stepIndex: number
  readonly beamRank: number
  readonly placedPieceId: PieceId
  readonly before: FreeRectangle
  readonly after: ReadonlyArray<FreeRectangle>
  readonly pruned: ReadonlyArray<FreeRectangle>
}

export interface NestingHistoryFrame {
  readonly frameId: string
  readonly jobId: JobId
  readonly strategyRunId: string
  readonly strategyLabel: string
  readonly stepIndex: number
  readonly beamRank: number
  readonly title: string
  readonly plate: PlateSnapshot
  readonly beam?: BeamStepTrace
  readonly candidates?: ReadonlyArray<BeamCandidateTrace>
  readonly freeRectangleSplit?: FreeRectangleSplitTrace
  readonly createdAt: string
}

export type NestingHistoryEvent =
  | {
      readonly type: "history_frame"
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: NestingHistoryFrame
    }
  | {
      readonly type: "history_complete"
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: NestingHistorySummary
    }

export interface NestingHistorySummary {
  readonly frameCount: number
  readonly strategyRunCount: number
  readonly retainedFrameCount: number
  readonly truncated: boolean
  readonly scope: "winning_path"
  readonly strategyRunIds: ReadonlyArray<string>
  readonly ndjsonPath?: string
}

export interface ProjectHistoryRef {
  readonly kind: "ndjson_replay"
  readonly jobId: JobId
  readonly path: string
  readonly frameCount: number
  readonly createdAt: string
}

export type Unsubscribe = () => void
```

The implementation agent must add these types and validation schemas now, but must not generate real algorithm history now.
The stub may emit only a minimal empty history frame if needed to prove the streaming path.
That frame must contain no placements and no fake free-rectangle evolution.

History scope:

- Required scope for each strategy run is only that run's winning path selected by the user-written comparison function.
- The app does not need the history of all `K=5` beam survivors.
- The app does not need the history of every explored candidate.
- The app does not choose the winner inside a beam; the user-written algorithm does.
- The app stores, streams, and renders the winning path history emitted by each strategy run.
- Multiple strategy runs from `SCORING_CRITERIA_NOTES.md` can be run automatically and kept separate.
- Strategy ids must be descriptive strings, not opaque names like `A.1`.
- The initial eight experimental strategy ids should be configured data, not a hardcoded string union.
- The UI must allow selecting and replaying each strategy run independently.
- Final cross-strategy selection, such as "best" or "top 3", is a separate later ranking layer and must not be hard-coded yet.
- If future algorithm versions emit additional diagnostic candidate data, the UI may display it, but that is optional debug data.

In the stub result:

- `status` must be `"stub"`.
- `sortedPieceIds` must match the input order.
- `placements` must be an empty array.
- `unplacedPieceIds` must include every input piece id.
- `historySummary`, if present, must describe only the real stub events emitted by the worker.
- Add a warning like `algorithm_not_implemented`.

Do not create fake placements.
Do not create fake free rectangles, fake split events, fake beam candidates, or fake strategy comparisons.

For real algorithm results:

- All prepared pieces are assumed to fit.
- Any unplaced piece is a fatal result error, not a normal partial success.
- A completed strategy result must have `unplacedPieceIds: []`.
- If the algorithm cannot place every piece, that strategy result must be `status: "failed"` with an error explaining the failed piece ids.
- Final ranking must only compare completed strategy results with every piece placed.

## 8. Algorithm Boundary

Create a dedicated folder:

```text
src/workers/algorithm
├── sortPiecesForNesting.ts
└── computeNestingStub.ts
```

`sortPiecesForNesting.ts` must contain only the identity sort:

```ts
import type { PreparedPiece } from "../../shared/domain/nesting"

export function sortPiecesForNesting(
  pieces: ReadonlyArray<PreparedPiece>,
): ReadonlyArray<PreparedPiece> {
  return pieces
}
```

`computeNestingStub.ts` can build a valid stub envelope:

```ts
import type { NestingRequest, NestingResult } from "../../shared/domain/nesting"
import { sortPiecesForNesting } from "./sortPiecesForNesting"

export function computeNestingStub(request: NestingRequest, elapsedMs: number): NestingResult {
  const sortedPieces = sortPiecesForNesting(request.pieces)

  return {
    version: 1,
    jobId: request.jobId,
    status: "stub",
    sortedPieceIds: sortedPieces.map((piece) => piece.id),
    placements: [],
    unplacedPieceIds: sortedPieces.map((piece) => piece.id),
    warnings: [
      {
        code: "algorithm_not_implemented",
        message: "The nesting algorithm is intentionally not implemented yet.",
      },
    ],
    stats: {
      elapsedMs,
      pieceCount: request.pieces.length,
    },
  }
}
```

This is acceptable because it is not a layout algorithm. It only proves the request and response pipeline.

The future algorithm should replace only `computeNestingStub` and possibly the identity sort implementation. The UI, IPC, validation, and worker supervision should not need structural changes.

## 9. Worker Protocol

Use explicit message envelopes. Avoid ad hoc postMessage payloads.

Request envelope:

```ts
export type WorkerRequest =
  | {
      readonly type: "run_nesting"
      readonly requestId: string
      readonly payload: NestingRequest
    }
  | {
      readonly type: "cancel"
      readonly requestId: string
      readonly jobId: JobId
    }
```

Response envelope:

```ts
export type WorkerResponse =
  | {
      readonly type: "progress"
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: WorkerProgress
    }
  | NestingHistoryEvent
  | {
      readonly type: "success"
      readonly requestId: string
      readonly jobId: JobId
      readonly payload: NestingResult
    }
  | {
      readonly type: "failure"
      readonly requestId: string
      readonly jobId?: JobId
      readonly error: SerializedAppError
    }
```

Progress events should be honest:

- `received`.
- `validated`.
- `started`.
- `completed`.
- `cancelled`.

Do not emit fake algorithm percentages. Until the algorithm exists, progress can be phase-based only.

History delivery modes:

- `historyMode: "stream"` means the worker emits `history_frame` events while the job is running.
- `historyMode: "final"` means the worker keeps history internally and sends it at the end, either as a list of frames or as an NDJSON replay file reference.
- `historyMode: "off"` means no history is retained except final result stats.
- The worker/main side must be capable of retaining the complete winning-path history as NDJSON when history is enabled.
- The renderer may retain only a bounded in-memory window or indexed summary, as long as the full NDJSON replay can be loaded later.
- Do not retain every beam branch by default.
- Do not require the future algorithm to return the histories of all five final beam entries.

Use NDJSON-compatible event envelopes for history:

```text
{"type":"history_frame","requestId":"...","jobId":"...","payload":{...}}
{"type":"history_frame","requestId":"...","jobId":"...","payload":{...}}
{"type":"history_complete","requestId":"...","jobId":"...","payload":{...}}
```

With Node.js `worker_threads`, the primary transport can still be `postMessage`, but each posted history object must be serializable as exactly one NDJSON line.
The main process should optionally append those serialized lines to a temp NDJSON replay file for large histories.
Do not use stdout as the primary worker transport unless the implementation deliberately switches to child processes later.

Worker supervisor behavior:

- Spawn a worker lazily on first run.
- Keep one worker alive for the app session unless it crashes.
- Queue one active job at a time for the first version.
- Add a queue abstraction now so concurrency can be expanded later.
- On worker crash, fail the active job with `WorkerCrashedError`.
- On timeout, terminate and replace the worker.
- On cancel, send a cancel message and terminate if the worker does not acknowledge quickly.
- In `historyMode: "stream"`, forward history frames to the renderer incrementally.
- In `historyMode: "final"`, collect or index history and return it after completion.
- Apply a retention policy so a long beam-search run does not exhaust renderer memory.

For the stub, cancellation will rarely matter, but the protocol should already exist.

## 10. effect-smol Usage

Use `effect-smol` at boundaries where it improves clarity:

- Main process service methods.
- File import workflows.
- Project save/open workflows.
- Worker run/cancel workflows.
- Worker history streaming and NDJSON replay workflows.
- Renderer API calls if ergonomic.

Do not wrap every tiny pure function in an effect. Geometry helpers, bbox math, schema definitions, and render utilities can stay pure.

Use a consistent pattern:

- Services expose effectful methods.
- IPC handlers run effects and convert typed failures into `IpcResult`.
- Worker handlers run effects and convert typed failures into `WorkerResponse`.
- Renderer composables call preload API and update Vue state.

Conceptual main process shape:

```ts
export interface DxfImportService {
  readonly importFiles: (paths: ReadonlyArray<string>) => Effect<ImportedDxfDocument[], AppError>
}

export interface WorkerSupervisor {
  readonly runNesting: (request: NestingRequest) => Effect<NestingResult, AppError>
  readonly subscribeToHistory: (jobId: JobId) => Effect<HistorySubscription, AppError>
  readonly cancelJob: (jobId: JobId) => Effect<void, AppError>
}
```

Adapt this to the real `effect-smol` API after inspecting package exports.

Typed errors should be plain serializable domain errors at boundaries:

```ts
export type AppErrorCode =
  | "validation_error"
  | "file_not_found"
  | "file_read_error"
  | "dxf_parse_error"
  | "unsupported_dxf_entity"
  | "worker_crashed"
  | "worker_timeout"
  | "worker_cancelled"
  | "algorithm_not_implemented"
  | "piece_cannot_fit_sheet"
  | "algorithm_incomplete_layout"
  | "unknown_error"
```

Do not send raw `Error` objects over IPC or worker messages.

## 11. effect-atom and Vue State

Use Vue 3 for the renderer.

State areas:

- Imported files.
- Imported pieces.
- Sheet settings.
- Padding and rotation settings.
- Prepared pieces.
- Active job.
- Active history stream.
- Retained history frames.
- Selected history frame index.
- Available strategy runs.
- Selected strategy run.
- Strategy result summaries.
- Last stub result.
- Warnings and errors.
- Selection and viewport state for the preview.

If `effect-atom` has an official or obvious Vue integration:

- Use atoms for durable app state.
- Keep component-local UI details in normal Vue refs.
- Keep all Electron API calls inside actions/effects, not directly inside visual components.

If `effect-atom` does not have a clean Vue integration:

- Do not force it.
- Implement a `useAppStore.ts` composable with Vue `reactive`, `computed`, and typed actions.
- Keep the store small and explicit.

Either way, the renderer should not know raw IPC channel names.

## 12. Renderer UX

This is a desktop work tool, not a landing page.

First screen:

- Left panel: file import and sheet/job settings.
- Center: preview/result canvas with tabs or segmented controls for rectangle view and DXF shape view.
- Right panel: piece table and job/result status.
- Bottom timeline: algorithm history slider, frame metadata, warnings, selected piece details, worker state.

Suggested layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ Top toolbar: Open DXF | Save Project | Run | Cancel | Export │
├───────────────┬───────────────────────────────┬─────────────┤
│ Settings      │ Preview/result canvas         │ Pieces      │
│ - Sheet W/H   │ - imported geometry bounds    │ - table     │
│ - Padding     │ - rectangle result view       │ - warnings  │
│ - Rotation    │ - no fake layout placements   │             │
│               │ - true DXF shape result view  │             │
├───────────────┴───────────────────────────────┴─────────────┤
│ Strategy runs: named experiments, manual/best/top-N placeholder │
├───────────────────────────────────────────────────────────────┤
│ History timeline: slider, play/pause, selected run metadata  │
├───────────────────────────────────────────────────────────────┤
│ Job/result strip: worker state, elapsed, stub warning        │
└─────────────────────────────────────────────────────────────┘
```

Required UI states:

- Empty workspace.
- Importing.
- Import failed.
- Imported with warnings.
- Ready to run.
- Worker running.
- Worker cancelled.
- Worker failed.
- Stub result available.
- Real placement result available after the future algorithm is implemented.
- History stream available after the future algorithm emits frames.
- Multiple strategy runs available after the future algorithm emits them.

The result panel must clearly show that the algorithm is not implemented and that no real placements are available yet.
When real placements exist later, the result panel must show both the rectangle placement interpretation and the transformed true DXF geometry interpretation.
When history frames exist later, the same two result views must support playback over time so the user can see the plate filling gradually.
When multiple strategy runs exist later, the UI must let the user choose a run and inspect that run's final result and history independently.
The UI should also reserve space for a future final-selection action, for example "show best" or "show top 3", without implementing the final ranking criteria yet.

Do not show instructional marketing copy. Use direct labels and tooltips.

History playback controls:

- Slider from first retained frame to last retained frame.
- Previous and next frame buttons.
- Play and pause buttons.
- Speed control.
- Current frame label.
- Strategy/run selector when multiple strategy results are present.
- Strategy/run label display for the selected run.
- Beam metadata display when the user-written algorithm provides it.
- Toggle for free-rectangle overlays.
- Toggle for candidate overlays if the future algorithm emits candidates.

The history UI must be implemented now as an empty-capable surface.
With the current stub, it should show an empty or single initial frame state and explain that real history starts when the algorithm is implemented.

Strategy-run UI:

- Show each available strategy result as a selectable row/tab/card.
- Use descriptive labels such as `Balanced / preserve free space first` instead of opaque ids.
- Show the strategy id only as secondary metadata.
- Selecting a strategy switches the final result view and the history timeline to that strategy run.
- Show basic per-run stats: status, elapsed time, placed count, unplaced count, history frame count, and warnings.
- Add a disabled or placeholder control for future final selection: manual, best, top N.
- Do not implement final cross-strategy scoring in the app shell.

## 13. DXF Import

Implement DXF import as app infrastructure, not as the nesting algorithm.

Pipeline:

1. Main process receives selected file paths.
2. Main process reads files.
3. DXF parser converts file text into entities.
4. Local bbox extractor computes supported entity bounds.
5. Unsupported entities become warnings.
6. Imported pieces are returned to the renderer.

Supported MVP entities:

- `LINE`.
- `LWPOLYLINE`.
- `POLYLINE`.
- `CIRCLE`.
- `ARC`, using a conservative bounding box if exact arc extrema are not implemented.
- `ELLIPSE`, either conservative or warning-only if parser support is poor.

For `SPLINE`, `INSERT`, blocks, text, hatches, dimensions, and unknown entities:

- Do not crash.
- Add warnings.
- Exclude from piece bounds unless there is a clearly correct parser-provided representation.

Grouping rule for MVP:

- Treat each closed polyline or each entity with a usable bbox as one imported piece.
- Also provide a later extension point for grouping by layer, block, or connected geometry.
- The user-facing language should talk about loading one or more shapes. Internally, a shape is represented as an `ImportedPiece`.

Important:

- Bbox extraction is allowed.
- Padding is allowed.
- Validation is allowed.
- Placement is not allowed.

## 14. Preparing Pieces for the Worker

When the user clicks Run:

1. Validate sheet width and height are positive.
2. Validate padding is non-negative.
3. Validate there is at least one imported piece.
4. Convert each imported piece into a `PreparedPiece`.
5. Compute padded dimensions:

```text
padded width = real bounds width + 2 * padding
padded height = real bounds height + 2 * padding
```

6. Check if any single padded piece cannot fit on the sheet in either allowed orientation.
7. Treat any impossible single-piece fit as a fatal validation error before starting the worker.
8. Send the prepared pieces to the worker only when every individual piece can fit the sheet in at least one allowed orientation.

Do not sort in the renderer. Sorting belongs behind the worker algorithm boundary, even though it is currently identity.

## 15. Project Persistence

Use a project JSON format with a version number.

```ts
export interface ProjectDocument {
  readonly version: 1
  readonly savedAt: string
  readonly sourceFiles: ReadonlyArray<ProjectSourceFileRef>
  readonly importedPieces: ReadonlyArray<ImportedPiece>
  readonly sheet: SheetSpec
  readonly padding: Millimeters
  readonly options: NestingOptions
  readonly lastResult?: NestingResult
  readonly lastHistory?: ProjectHistoryRef
}
```

Persist:

- Sheet settings.
- Padding.
- Rotation settings.
- Imported piece metadata.
- Source file references.
- Last stub result.
- Last history metadata or replay file reference.
- Per-strategy result summaries when available.
- Warnings.

Do not persist absolute file contents unless explicitly chosen. For MVP, store file paths and imported summaries. On reopen, if a source file is missing, keep the last imported summary but show a warning.
For history, prefer storing a compact reference to an NDJSON replay file instead of embedding large frame arrays directly inside the project JSON.
If the replay file is missing on reopen, keep the final result but show a missing-history warning.

## 16. Export

Implement JSON export for debugging and future algorithm work:

- Export current `NestingRequest`.
- Export current `NestingResult`.
- Export imported DXF summary.
- Export history NDJSON when available.

Use stable pretty JSON with two-space indentation.

Do not export a final nested DXF layout until the real algorithm exists.

## 17. Testing Requirements

Add focused tests.

Required unit tests:

- Schema accepts a valid project document.
- Schema rejects invalid sheet dimensions.
- Schema rejects negative padding.
- DXF bbox extraction works for simple line rectangles.
- DXF bbox extraction works for simple closed polylines.
- Unsupported entities produce warnings, not crashes.
- Worker protocol accepts a valid `run_nesting` request.
- Worker protocol rejects malformed payloads.
- Worker history event schema accepts a valid `history_frame`.
- Worker history event schema rejects malformed frame payloads.
- `sortPiecesForNesting` returns the same array contents in the same order.
- `computeNestingStub` returns empty placements and all pieces as unplaced.

Required integration-ish test:

- Start the worker handler directly with a valid request and assert the stub result.

Do not write tests that assert a real nesting layout.

## 18. Package Scripts

Add scripts similar to:

```json
{
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "vue-tsc --noEmit && tsc --noEmit -p tsconfig.node.json",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

Use the exact scripts required by the chosen template.

After generating or editing multiple files, run:

1. Auto-fix script, if available.
2. Typecheck.
3. Tests.
4. Lint.

Fix remaining issues manually.

## 19. Implementation Sequence

### Phase 1: Create the Electron/Vue Shell

Tasks:

- Initialize Electron + Vite + Vue + TypeScript.
- Configure strict TypeScript.
- Configure ESLint and formatting.
- Configure secure Electron defaults.
- Add a basic app shell with three panels and a toolbar.
- Add preload API scaffolding.

Acceptance:

- `pnpm dev` opens the app.
- Renderer has no direct Node access.
- Typecheck passes.

### Phase 2: Shared Domain and Validation

Tasks:

- Add shared domain types.
- Add schema validators.
- Add serializable app error types.
- Add IPC result envelope.
- Add worker message envelope.

Acceptance:

- Unit tests cover valid and invalid request/project examples.
- All boundary payloads have validators.

### Phase 3: DXF Import

Tasks:

- Add file selection through main process dialog.
- Read DXF files in main process.
- Parse DXF with selected parser.
- Extract bounding boxes for MVP entities.
- Return imported documents and warnings to renderer.
- Display imported pieces in table.
- Draw source bounds in preview canvas.

Acceptance:

- Simple fixture imports successfully.
- Unsupported entity fixture returns warnings.
- UI shows piece count and warnings.

### Phase 4: Sheet and Piece Preparation

Tasks:

- Add sheet width and height controls.
- Add padding control.
- Add rotation setting.
- Convert imported pieces to prepared pieces.
- Show real and padded dimensions in the table.
- Validate impossible pieces and show warnings.

Acceptance:

- Request preview JSON can be exported.
- Prepared pieces use padded dimensions.
- No sorting happens in the renderer.

### Phase 5: Worker Infrastructure

Tasks:

- Add Node.js worker thread file.
- Add worker supervisor in main process.
- Add run/cancel IPC handlers.
- Add request/response validation.
- Add timeout and crash handling.
- Add honest progress events.
- Add history event envelopes.
- Add streaming history forwarding from worker to main to renderer.
- Add NDJSON-compatible serialization for every history event.
- Add optional temp NDJSON replay persistence for large histories.

Acceptance:

- Running a job starts the worker and returns a stub result.
- Cancelling an active job returns a cancellation state.
- Worker crash is converted into a serializable app error.
- History protocol is tested with a minimal stub event or fixture event.
- No fake algorithm history is generated.

### Phase 6: Algorithm Stub

Tasks:

- Add `sortPiecesForNesting`.
- Add `computeNestingStub`.
- Ensure the worker calls only the stub.
- Add tests proving the input order is preserved.
- Add tests proving the stub emits no fake placements, no fake free-rectangle splits, and no fake beam-search history.

Acceptance:

- Result status is `"stub"`.
- `sortedPieceIds` equals input order.
- `placements` is empty.
- `unplacedPieceIds` contains all input pieces.
- History is empty or contains only explicitly marked stub lifecycle frames.
- UI clearly says the real algorithm is not implemented.

### Phase 7: History Playback UI

Tasks:

- Add a history timeline store.
- Add a frame slider.
- Add previous, next, play, pause, and speed controls.
- Add selected strategy-run metadata display.
- Add strategy-run selector and per-run result summary display.
- Add placeholder controls for manual/best/top-N final selection.
- Add free-rectangle overlay toggles.
- Add candidate overlay toggles.
- Add a retained-frame policy so the renderer does not keep unbounded history.
- Add NDJSON replay loading from main process if history was stored on disk.
- Make rectangle and true DXF shape views render from the selected history frame when one is selected.
- Fall back to final result placements when no history frame is selected.

Acceptance:

- The UI works with an empty history.
- The UI works with fixture history frames.
- Slider movement changes both visualization modes.
- Strategy selection changes both final result and history playback source.
- Free rectangles are shown only when present in the selected frame.
- Split/prune metadata can be inspected for a selected frame.
- The UI does not require histories for all `K=5` beam survivors.
- The UI can display multiple separate strategy runs without merging them.

### Phase 8: Project Save/Open and Export

Tasks:

- Add save project dialog.
- Add open project dialog.
- Validate project files on open.
- Export request JSON.
- Export result JSON.
- Export history NDJSON if available.

Acceptance:

- Saved project can be reopened.
- Invalid project JSON fails with a clear error.
- Exported request can be used as a fixture.
- Exported history can be replayed in the history UI.

### Phase 9: UI Polish and Verification

Tasks:

- Finish empty/loading/error/result states.
- Make canvas pan/zoom usable.
- Add piece selection.
- Add history frame selection.
- Add compact warning display.
- Verify responsive layout for common desktop sizes.

Acceptance:

- No overlapping text.
- Main workflow is usable without devtools.
- Typecheck, lint, and tests pass.

## 20. Canvas Preview Rules

The preview canvas may show:

- Imported geometry summary.
- Real bounding boxes.
- Padded bounding boxes.
- Sheet outline.
- Selection highlights.
- Algorithm result rectangles, but only when actual placements are present in the worker result.
- Algorithm result true DXF shapes, transformed by the placement position and rotation, but only when actual placements are present in the worker result.
- History frame placements from `NestingHistoryFrame.plate.placements`.
- History frame free rectangles from `NestingHistoryFrame.plate.freeRectangles`.
- Free-rectangle split/prune overlays from `NestingHistoryFrame.freeRectangleSplit`.
- Candidate overlays from `NestingHistoryFrame.candidates`, only when the future algorithm emits them.

The preview canvas must not show:

- Fake placements.
- A fake nested sheet.
- A "sample" algorithm result.
- Fake free rectangles.
- Fake beam-search candidates.
- Fake free-rectangle splits.

If there are no placements, the result preview should show an explicit empty state:

```text
No placements yet. The worker pipeline is connected, but the nesting algorithm is intentionally still a stub.
```

Required visualization modes:

1. Import preview mode:
   - shows the loaded shapes in source coordinates;
   - overlays real bounding boxes;
   - can optionally overlay padded bounding boxes;
   - does not imply any nesting result.
2. Result rectangle mode:
   - shows the target sheet;
   - shows each placement as the padded rectangle footprint returned by the algorithm;
   - uses placement coordinates, dimensions, and rotation from the worker result;
   - uses the selected history frame when the timeline is active;
   - uses the final result when no history frame is selected;
   - shows nothing except an empty state while the stub returns no placements.
3. Result DXF shape mode:
   - shows the target sheet;
   - renders the real DXF shape geometry inside each placement;
   - applies the same translation and rotation convention used by the algorithm output;
   - uses the selected history frame when the timeline is active;
   - uses the final result when no history frame is selected;
   - can overlay the padded rectangle footprint as a toggle, but the main view is the real shape geometry.
4. Free-rectangle overlay mode:
   - overlays current free rectangles on top of either result mode;
   - shows rectangles with stable ids when ids are present;
   - distinguishes current, split source, split result, and pruned rectangles;
   - can show labels for width, height, and area;
   - is hidden automatically when the selected frame has no free-rectangle data.

The rectangle and true-shape result modes must be synchronized:

- Same selected piece.
- Same pan and zoom when practical.
- Same sheet coordinate system.
- Same warnings for missing geometry or unsupported entities.
- Same placement ids from the worker result.
- Same selected history frame.
- Same selected strategy run.

History visualization behavior:

- The timeline slider indexes retained `NestingHistoryFrame` objects.
- Moving the slider changes the plate state in both rectangle and true DXF views.
- The user must be able to see the plate gradually fill as frames advance.
- For future beam search with `K=5`, each strategy run shows the winning path emitted by the algorithm for that strategy, not all five beam survivors.
- For multiple lexicographic orderings or placement strategies, keep runs separate and selectable.
- A future cross-strategy final selector may choose one best run or top N runs, but that ranking logic is not part of the app shell yet.
- Free rectangles must be drawn as algorithm-provided debug overlays, not recomputed in the renderer.
- Split events should visually connect `before`, `after`, and `pruned` rectangles when a selected frame contains `freeRectangleSplit`.
- If a history stream is truncated by retention limits, the UI must say so and offer NDJSON replay if available.

## 21. Future Algorithm Insertion Point

The future algorithm should receive:

```ts
export interface AlgorithmInput {
  readonly sheet: SheetSpec
  readonly pieces: ReadonlyArray<PreparedPiece>
  readonly options: NestingOptions
}
```

It should return:

```ts
export interface AlgorithmOutput {
  readonly placements: ReadonlyArray<Placement>
  readonly unplacedPieceIds: ReadonlyArray<PieceId>
  readonly history?: AsyncIterable<NestingHistoryEvent>
  readonly stats: AlgorithmStats
}
```

The placement output is the only source of truth for result visualization.

The renderer must derive:

- rectangle result view from `placements`;
- true DXF shape result view from `placements` plus the original imported geometry summaries.
- history rectangle view from `NestingHistoryFrame.plate.placements`;
- history true DXF shape view from each history placement plus the original imported geometry summaries;
- free-rectangle overlays only from `NestingHistoryFrame.plate.freeRectangles` or `freeRectangleSplit`.

The app infrastructure should not compute MaxRects-specific internals such as free rectangles, beams, candidate vectors, or partial layouts.
It may display them as typed debug/trace payloads emitted by the future algorithm.
Those structures are visualization data at the boundary, not renderer-owned algorithm logic.

This is important because the user has already said there will be another difference from the TeX reference later.

## 22. What Not To Do

Do not:

- Use OCaml.
- Add native Node to OCaml bindings.
- Add WebAssembly.
- Implement MaxRects.
- Implement beam search.
- Implement greedy packing.
- Implement any rectangle placement heuristic.
- Recompute free rectangles in the renderer.
- Infer split/prune history in the renderer.
- Place pieces at `(0, 0)` just to display something.
- Sort by area, side length, layer, filename, or any heuristic.
- Call algorithm placeholders from the renderer.
- Expose raw IPC.
- Let the renderer access filesystem APIs.
- Persist unvalidated project files.
- Use hidden global mutable worker state without protocol messages.
- Add AI attribution to generated files, docs, commits, or PRs.

## 23. Done Definition

The implementation is done when:

- The Electron app runs locally.
- DXF files can be selected and imported.
- One or more shapes can be loaded and shown as imported pieces.
- The user can enter and edit sheet dimensions.
- Supported entity bounds are displayed.
- Sheet and padding settings produce a validated nesting request.
- The request is sent to a Node.js worker.
- The worker returns a typed stub result.
- The result preserves input order through identity sort.
- No placements are produced.
- The UI has a result area ready to show actual algorithm placements when they exist.
- The result area supports both rectangle placement visualization and true DXF shape visualization.
- The UI has a history timeline ready to show future algorithm frames.
- The UI can list and select multiple strategy runs.
- The history timeline supports slider playback for the selected strategy run.
- The history visualization can display free rectangles and split/prune overlays from fixture frames.
- The worker protocol can stream NDJSON-compatible history events.
- Project save/open works.
- JSON request/result export works.
- History NDJSON export/replay works with fixture history.
- UI communicates that the algorithm is intentionally missing.
- Typecheck passes.
- Lint passes.
- Tests pass.

The implementation is not done if it contains any real nesting logic.
