# Process Boundaries

## Renderer

The renderer renders UI and holds transient interaction state through Vue composables.

It may:

- call `window.appApi`;
- hydrate stores from a validated `ProjectDocument`;
- render imported source geometry, worker results, warnings, and history frames;
- expand linked CSV cut rows into prepared pieces for one manual subrun request;
- aggregate worker-returned manual subruns into renderer-owned run records;
- expose disabled controls for future features.

It must not:

- use Node filesystem APIs;
- spawn workers;
- cast IPC payloads directly into domain types;
- mutate another composable's internal state from outside its public actions.
- parse CSV files or write CSV exports directly.

## Preload

Preload exposes the typed `AppApi` through `contextBridge`.

It unwraps `IpcResult` envelopes and keeps raw channel names out of Vue components. It should remain small and boundary-focused.

## Main

Main owns:

- Electron dialogs;
- filesystem access;
- DXF file import;
- CSV file import/export;
- temporary workspace settings persistence;
- project save/open;
- export requests/results/history;
- validated deletion of saved-run replay and decision-trace files;
- worker supervision;
- IPC result translation.

IPC handlers are the Promise boundary for main-process services. Validate renderer payloads before service work and return stable `IpcResult` envelopes.

CSV import/export follows the same boundary: renderer asks preload for file
selection, main parses Windows-1252 ABAS/CAMQUIX CSVs into schema-backed
`ProjectCsvImport` documents, and main writes exported CSV files from decoded
`ProjectCsvImport` plus `CsvRunRecord` payloads. Renderer-owned row links and
run configuration changes are persisted by calling the CSV update IPC; the
renderer never writes SQLite directly.

The renderer may request temporary workspace settings through preload, but it
must not write SQLite or files directly. Persisted temporary settings are
schema-decoded at the IPC boundary and hydrated through composable actions.

DXF geometry may contain fractional coordinates. Main normalizes imported
objects into integer-millimeter containing rectangles before they become project
or worker data: `realBounds`, `paddedBounds`, sheet dimensions, placements, and
free rectangles are integer grid values. The original DXF geometry remains
fractional inside that container and is translated for preview/export.

Renderer cutting settings store padding as total integer clearance. Request
preparation expands each side by `ceil(padding / 2)`, so odd padding values
round outward. The request always includes integer-millimeter prepared
rectangles; irregular requests may also include `sourcePieces` with the original
imported geometry summaries for polygon flattening.

## Worker

The worker receives schema-decoded `RunNestingPayload` values through `NestingWorkerRpcs`, runs the computation workflow, writes optional NDJSON history, and streams typed `WorkerResponse` messages.

The worker must not perform unit conversion for rectangle nesting. Its
rectangle inputs are already non-negative integer millimeters, with positive
integer width and height. Irregular geometry code may consume `sourcePieces`
for flattening, but that belongs to the irregular worker path and must not
change MaxRects behavior.

The worker remains stateless for multi-plate runs. Each manual subrun is one
normal worker request with a distinct `strategyRunId`; the renderer decides
which leftover prepared pieces to send next and aggregates the returned
single-subrun result into the active regular run or CSV session.

The worker transport is Effect-owned through `NodeWorker`, `NodeWorkerRunner`, and Effect RPC. The app-owned payload protocol is `RunNestingPayload -> Stream<WorkerResponse>`.

Replay history persistence is authoritative: selected-state frames are appended
to the per-job NDJSON file before optional live streaming. Live `history_frame`
delivery is best-effort; persistence failures still fail the job.

Ordinary irregular runs with history enabled also write a separate
`<jobId>.decision-trace.ndjson` file beside replay history. It records each
executed baseline or GA beam decode, including bounded local-fanout detail,
aggregate local-candidate counts, deduplication, whole-layout scoring, and beam
pruning. The Compact quality shared archive does not claim those beam decisions
or ancestry; its replay history is a single truthful selected terminal frame.
The worker drains every active history/trace queue before completion and reports
the available paths and counts in `NestingHistorySummary`. Decision traces are
diagnostic data, not replay frames, and are not streamed to the renderer.
Per-decode registries replace repeated chromosome, state, and retained
diagnostic candidate keys with compact deterministic ids, and the worker
persists ordered bounded batches rather than appending each event separately.

Saved-run history deletion is a main-process filesystem operation. Renderer
requests contain only schema-decoded job ids; main derives the two managed
filenames under its configured history root and rejects unsafe path segments
before removing any file.

The main supervisor guards every streamed response by both request id and job
id before forwarding it. The preload decodes each `progress`, `history_frame`,
or `history_complete` event through its shared schema before exposing it to the
renderer, so a stale or malformed IPC message cannot affect a later job.
