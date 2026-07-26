# Benchmark-only source patches

These patches were committed on the local
`experiment/pr16-cache-measurements` branch and were never promoted to the PR
implementation.

## Candidate memo bypass — `f6e7fb86965d1595ecf7b908571200aac2e6b0f3`

Apply to `src/workers/irregular/nfpIfpService.ts` at the start of
`makeGeneratePlacementCandidates`'s inner `service`:

```diff
 const scope = input.candidateMemoScope
-if (scope === undefined) {
+// benchmark-only switch; this commit must never be promoted to production
+const candidateMemoDisabled =
+  process.env.MIN_PLANE_EXPERIMENT_DISABLE_CANDIDATE_MEMO === '1'
+if (scope === undefined || candidateMemoDisabled) {
```

## Sampled NFP-hit timing — `9646d5c9dc9ff0ba32c3ee0b38c33b8a47f0a5e6`

The experiment sampled one call in 256. A token captured
`performance.now()` at entry, after input validation, after
`pairwiseNfpCacheKey`, when the cache callback resumed, after
`isValidCachedNfpBoundary`, and after `translateNfpBoundaryInternal`.

The accumulator fields were:

```ts
interface NfpHitTimingState {
  calls: number
  sampledCalls: number
  sampledHits: number
  sampledMisses: number
  validationMs: number
  keyMs: number
  cacheRoundTripMs: number
  cachedValidationMs: number
  translationMs: number
}
```

The experiment was enabled only when
`MIN_PLANE_EXPERIMENT_NFP_HIT_TIMINGS=1`. The corpus script wrote the detached
snapshot to `nfp-hit-timings.json`. The exact implementation remains reachable
at the recorded experiment commit; this description preserves the injection
seams even if that local branch is later removed.
