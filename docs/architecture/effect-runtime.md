# Effect Runtime

The main process owns a single app runtime in `src/main/runtime/effectRuntime.ts`.

```ts
Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
```

Use `@effect/platform-node` for Node services. Do not keep local FileSystem or Path shims unless there is a narrow documented package bug and no practical alternative.

## Service Shape

Main services should move toward Effect-returning APIs:

```ts
Effect.Effect<Success, TypedError, FileSystem.FileSystem | Path.Path>
```

IPC handlers are the normal place to call `appRuntime.runPromise` and translate typed errors to `IpcResult`.

## Worker Runtime

The worker may use its own small runtime with `NodeFileSystem.layer` and `NodePath.layer` for local filesystem operations such as NDJSON history files.

Do not import the main runtime into the worker. Worker lifecycle is separate from Electron main lifecycle.

`pnpm dev` must build the worker bundle before Electron starts. The worker
bundle lives at `out/workers/nesting.worker.mjs` so electron-vite can rebuild
`out/main` without deleting it. If that file is missing, `Run` fails before the
algorithm starts. Keep `build:worker` in the dev startup path whenever the
worker stays outside the electron-vite main bundle.

## Worker Protocol

The worker transport uses Effect RPC over Effect's Node worker platform:

```text
@effect/platform-node/NodeWorker
  -> effect/unstable/workers/Worker
  -> effect/unstable/rpc/RpcClient.layerProtocolWorker
  -> @effect/platform-node/NodeWorkerRunner
  -> effect/unstable/rpc/RpcServer.layerProtocolWorkerRunner
```

Effect owns worker framing, lifecycle messages, and schema-backed RPC boundary decoding.
The app-owned protocol is the `NestingWorkerRpcs` group:

```text
RunNestingPayload -> Stream<WorkerResponse>
```

`WorkerSupervisor` consumes the `RunNesting` response stream and forwards history events or resolves the final result. `nesting.worker.ts` exposes the RPC handler and streams `WorkerResponse` class instances through an endable queue.

Renderer cancellation and the outer request timeout are supervisor safety
boundaries: they emit a terminal cancellation progress event and dispose the
worker runtime. They do not claim a partial result from a computation that was
interrupted externally. Internal irregular deadline and cancellation checks are
cooperative algorithm boundaries; the current renderer cancellation path still
acts by supervisor disposal rather than by promising that an internal callback
observed the request. Portfolio-owned GA budgets and deterministic archive caps
remain separate and publish only validated complete layouts.

Do not bypass `NodeWorker` / `NodeWorkerRunner` with direct `parentPort` listeners in the same worker.

When the parent worker thread is closed after a completed run, Effect may report
`All fibers interrupted without error` from `Layer.launch`. Treat that exact
condition as normal worker shutdown, not a fatal nesting failure.

## Error Model

Prefer tagged/domain errors inside services. Convert to renderer-safe `AppErrorCode` only at IPC boundaries.

Schema validation failures are boundary failures, not generic `unknown_error`.
