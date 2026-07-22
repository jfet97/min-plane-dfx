export interface RelaxationSnapshot<T> {
  readonly value: T
  readonly rawLoss: number
  readonly tieKey: string
}

/** Retains the least-raw state independently from guided-local-search weights. */
export class OverlapRelaxationTracker<T> {
  private best: RelaxationSnapshot<T>

  constructor(initial: RelaxationSnapshot<T>) {
    this.best = initial
  }

  record(snapshot: RelaxationSnapshot<T>): void {
    if (
      snapshot.rawLoss < this.best.rawLoss ||
      (snapshot.rawLoss === this.best.rawLoss && snapshot.tieKey < this.best.tieKey)
    ) {
      this.best = snapshot
    }
  }

  leastRaw(): RelaxationSnapshot<T> {
    return this.best
  }
}
