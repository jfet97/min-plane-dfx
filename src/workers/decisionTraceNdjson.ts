import type { IrregularDecisionTraceEvent } from './algorithm/irregular/decisionTrace.js'

export const DECISION_TRACE_BATCH_EVENT_LIMIT = 256

/** Buffers trace events synchronously and emits ordered bounded batches. */
export class IrregularDecisionTraceBatcher {
  private pendingEvents: IrregularDecisionTraceEvent[] = []
  private readonly maximumEvents: number
  private readonly emitBatch: (events: ReadonlyArray<IrregularDecisionTraceEvent>) => void

  constructor(input: {
    readonly emitBatch: (events: ReadonlyArray<IrregularDecisionTraceEvent>) => void
    readonly maximumEvents?: number
  }) {
    this.emitBatch = input.emitBatch
    this.maximumEvents = input.maximumEvents ?? DECISION_TRACE_BATCH_EVENT_LIMIT
  }

  add(event: IrregularDecisionTraceEvent): void {
    this.pendingEvents.push(event)
    if (this.pendingEvents.length >= this.maximumEvents) this.flush()
  }

  flush(): void {
    if (this.pendingEvents.length === 0) return
    const batch = this.pendingEvents
    this.pendingEvents = []
    this.emitBatch(batch)
  }
}

/** Serializes one ordered trace batch as complete newline-delimited JSON records. */
export function serializeIrregularDecisionTraceBatch(
  events: ReadonlyArray<IrregularDecisionTraceEvent>
): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}
