export type IntrinsicAnytimeArchiveNamespace = 'complete' | 'partial'

export interface IntrinsicAnytimeArchiveNamespacePolicy<Endpoint> {
  readonly namespace: IntrinsicAnytimeArchiveNamespace
  readonly endpoints: ReadonlyArray<Endpoint>
  readonly identity: (endpoint: Endpoint) => string | undefined
  readonly validate: (endpoint: Endpoint) => boolean
  readonly selectDuplicate: (retained: Endpoint, candidate: Endpoint) => Endpoint
  readonly rank: (endpoints: ReadonlyArray<Endpoint>) => ReadonlyArray<Endpoint>
}

export interface IntrinsicAnytimeArchiveSnapshot<CompleteEndpoint, PartialEndpoint> {
  readonly complete: ReadonlyArray<CompleteEndpoint>
  readonly partial: ReadonlyArray<PartialEndpoint>
}

export type IntrinsicAnytimeSettledSelection<CompleteEndpoint, PartialEndpoint> =
  | {
      readonly namespace: 'complete'
      readonly endpoint: CompleteEndpoint
    }
  | {
      readonly namespace: 'partial'
      readonly endpoint: PartialEndpoint
    }
  | undefined

/**
 * Validates, canonically deduplicates, and ranks one protected namespace.
 * Namespace-specific comparators and survivor slots remain outside this
 * storage mechanic.
 */
export function retainIntrinsicAnytimeArchiveNamespace<Endpoint>(
  policy: IntrinsicAnytimeArchiveNamespacePolicy<Endpoint>
): ReadonlyArray<Endpoint> {
  const unique = new Map<string, Endpoint>()
  for (const endpoint of policy.endpoints) {
    if (!policy.validate(endpoint)) continue
    const identity = policy.identity(endpoint)
    if (identity === undefined || identity.length === 0) continue
    const retained = unique.get(identity)
    unique.set(
      identity,
      retained === undefined ? endpoint : policy.selectDuplicate(retained, endpoint)
    )
  }
  return policy.rank([...unique.values()])
}

/**
 * Applies the terminal dominance contract after both namespaces have settled.
 * A fitting complete endpoint always wins; partial ranking is consulted only
 * when the complete namespace is empty.
 */
export function selectIntrinsicAnytimeSettledEndpoint<CompleteEndpoint, PartialEndpoint>(
  snapshot: IntrinsicAnytimeArchiveSnapshot<CompleteEndpoint, PartialEndpoint>
): IntrinsicAnytimeSettledSelection<CompleteEndpoint, PartialEndpoint> {
  const complete = snapshot.complete[0]
  if (complete !== undefined) return { namespace: 'complete', endpoint: complete }
  const partial = snapshot.partial[0]
  return partial === undefined ? undefined : { namespace: 'partial', endpoint: partial }
}
