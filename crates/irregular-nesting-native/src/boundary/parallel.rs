//! Job-owned Rayon thread pool: construction, thread-count resolution, and
//! the thread-local "current job pool" seam that lets Rayon parallel sites
//! deep in the call graph (`result::coordinator`, `nfp_ifp::candidates`,
//! ...) opt into this job's pool without threading a `&ThreadPool`
//! parameter through every intervening function signature.
//!
//! Per `cache-concurrency-design.md` §7 ("Job-owned thread pool; no
//! global-pool leakage across jobs") and migration-prompt §14.4:
//!
//! - **One pool per job, never the ambient global Rayon pool, never
//!   `rayon::spawn`.** [`build_job_thread_pool`] always calls
//!   `rayon::ThreadPoolBuilder::build` (never `build_global`), producing a
//!   pool owned by the caller (`boundary::run_job`). Every Rayon parallel
//!   site in this crate reaches that pool exclusively through
//!   [`with_job_pool`], which runs the supplied closure via
//!   `ThreadPool::install` -- never through a bare `.par_iter()` call that
//!   would silently fall back to `rayon`'s ambient global pool.
//! - **Thread-local, not a passed-down parameter.** `run_job` (the job's
//!   single, synchronous, coordinating OS thread -- see `boundary::job`'s
//!   own doc, "one dedicated OS thread runs one job's `compute()` body end
//!   to end") calls [`JobPool::install`] once, at job start, which stashes
//!   the pool in a `thread_local!` slot scoped to that one OS thread for
//!   the lifetime of the returned guard. Every parallel site downstream
//!   calls [`with_job_pool`], which reads that same thread-local. Because
//!   the slot is `thread_local!` (not a process-global), two jobs running
//!   concurrently on two different OS threads (napi's libuv worker pool
//!   genuinely reuses/parallelizes multiple such threads) each see only
//!   their own pool -- this is the structural proof migration-prompt §14.4
//!   asks for ("no Rayon worker thread ever executes work tagged with a
//!   different job's ID"), not merely an informal claim; see this module's
//!   tests.
//! - **No pool installed means no Rayon at all, not inline `par_iter`.**
//!   `with_job_pool`'s no-pool fallback runs the closure inline on the
//!   calling thread -- which is only safe for closures that do not
//!   themselves start a parallel iterator. A `par_iter()` inside an
//!   inline-executed closure dispatches onto Rayon's ambient global
//!   registry (lazily created, process-wide, shared across jobs), which
//!   this contract forbids. Whole-batch parallel sites therefore go
//!   through [`map_slice_with_job_pool`] (or their own explicit
//!   [`has_job_pool`] branch, as `search::strict_decoder`'s chunked
//!   scoring loop does), which degrades to ordinary serial iteration when
//!   no pool is installed. `tests/no_pool_global_rayon_containment.rs`
//!   proves the whole no-pool pipeline never initializes the global
//!   registry. Direct-call unit tests (bypassing `run_job` entirely, e.g.
//!   `nfp_ifp::candidates`'s own test module) thus get serial, correct,
//!   deterministic results -- the same output a 1-thread job pool would
//!   produce, modulo which OS thread physically executes it, which is
//!   never observable in this crate's output.
//!
//! # Thread-count resolution
//!
//! Resolved once per job, before any Rayon work starts
//! ([`resolve_thread_count`]), from (highest priority first):
//! 1. an explicit override -- reserved for the thread-equality determinism
//!    test suite; no N-API argument threads this through today, so
//!    production callers always pass `None` here;
//! 2. the `MIN_PLANE_IRREGULAR_NATIVE_THREADS` process environment
//!    variable, parsed as a positive integer;
//! 3. one fewer than the OS-visible logical CPU count, clamped to `1`.
//!    Rayon workers execute parallel work while the native job coordinator
//!    runs on a separate libuv thread, so the automatic default leaves one
//!    CPU available to the coordinator and Electron. Per prompt §14.4 and
//!    `cache-concurrency-design.md` §7, this resolved value is
//!    diagnostics-only: it is echoed into
//!    `boundary::diagnostics::JobDiagnostics::thread_count_used` and never
//!    reaches the result DTO, a checkpoint, or any hashed surface.

use std::cell::{Cell, RefCell};
use std::env;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::Arc;

/// The process environment variable used to configure the job-owned Rayon
/// pool's thread count. See this module's top doc.
pub const THREAD_COUNT_ENV_VAR: &str = "MIN_PLANE_IRREGULAR_NATIVE_THREADS";

/// Monotonically-increasing source of per-pool tags, one fresh value per
/// [`build_job_thread_pool`] call. Used only to prove pool isolation (see
/// [`WORKER_POOL_TAG`]) -- never read by any algorithm code path, never
/// part of any hashed or diagnostic surface.
static NEXT_POOL_TAG: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static JOB_POOL: RefCell<Option<Arc<rayon::ThreadPool>>> = const { RefCell::new(None) };
    /// Set exactly once, at worker-thread start, by
    /// [`build_job_thread_pool`]'s `start_handler` -- identifies which
    /// job-owned pool constructed this particular worker OS thread. This is
    /// the "thread-local set at pool-thread-start" tagging technique this
    /// module's top doc promises for migration-prompt §14.4's isolation
    /// proof; it is never read outside this module's own tests. `0` on the
    /// job's coordinating thread and every other non-pool-worker thread.
    static WORKER_POOL_TAG: Cell<u64> = const { Cell::new(0) };
}

/// Resolves the thread count a job's Rayon pool should use. `override_count`,
/// when `Some`, wins unconditionally (used only by the determinism test
/// suite -- see this module's top doc, priority (1)). A non-positive or
/// unparseable environment value is treated the same as an absent one
/// (falls through to the automatic CPU-derived default), matching this
/// crate's established "malformed out-of-band configuration degrades to the
/// safe default rather than failing the job" convention (mirrors the backend
/// selector precedent `cache-concurrency-design.md` §7 cites).
pub fn resolve_thread_count(override_count: Option<usize>) -> usize {
    if let Some(count) = override_count {
        return count.max(1);
    }
    env::var(THREAD_COUNT_ENV_VAR)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or_else(automatic_thread_count)
}

fn automatic_thread_count() -> usize {
    std::thread::available_parallelism()
        .map(|available| default_thread_count_from_available(available.get()))
        .unwrap_or(1)
}

fn default_thread_count_from_available(available_cpu_count: usize) -> usize {
    available_cpu_count.saturating_sub(1).max(1)
}

/// Builds a job-owned `rayon::ThreadPool` sized to `thread_count`. Falls
/// back to a single-thread pool if pool construction itself fails
/// (OS thread-spawn failure -- unlikely, but a diagnostics/performance
/// feature must never be the reason a job fails outright). Callers that
/// report pool size must read it back from the returned pool
/// (`ThreadPool::current_num_threads`), never assume the requested count
/// was honored: the fallback path deliberately builds fewer workers than
/// requested.
pub fn build_job_thread_pool(thread_count: usize) -> rayon::ThreadPool {
    let tag = NEXT_POOL_TAG.fetch_add(1, AtomicOrdering::Relaxed);
    build_job_thread_pool_via(thread_count, |count| try_build_pool(count, tag))
}

/// The one real pool constructor: every job pool (primary and fallback
/// alike) is built here, tagged for the isolation proof this module's tests
/// rely on.
fn try_build_pool(
    thread_count: usize,
    tag: u64,
) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .start_handler(move |_worker_index: usize| {
            WORKER_POOL_TAG.with(|cell| cell.set(tag));
        })
        .build()
}

/// The fallback policy, separated from the real constructor so the
/// otherwise-unreachable failure branch is testable with an injected
/// failing builder: try the requested size once, then degrade to a
/// single-thread pool.
fn build_job_thread_pool_via(
    thread_count: usize,
    build: impl Fn(usize) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError>,
) -> rayon::ThreadPool {
    build(thread_count)
        .unwrap_or_else(|_| build(1).expect("a single-threaded Rayon pool always builds"))
}

/// A job pool's two thread counts as one non-semantic, diagnostics-only
/// snapshot: `requested` is the resolved requested size
/// ([`resolve_thread_count`]); `actual` is the built pool's live worker
/// count. They differ exactly when the pool-build fallback fired. Benchmark
/// validation must reject samples where the two diverge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobThreadCounts {
    pub requested: usize,
    pub actual: usize,
}

/// RAII guard returned by [`JobPool::install`]. Clears this OS thread's
/// installed-pool slot on drop (including during a panic unwind, so
/// `boundary::contain_panics`' `catch_unwind` never observes a stale
/// installed pool on a subsequent job reusing the same libuv worker
/// thread).
pub struct JobPoolGuard {
    _private: (),
}

impl Drop for JobPoolGuard {
    fn drop(&mut self) {
        JOB_POOL.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }
}

/// A job-owned Rayon pool plus both thread counts a diagnostics consumer
/// needs to trust a measurement: the *resolved requested* count
/// (override/env/automatic default -- what we asked
/// [`build_job_thread_pool`] for) and the *actual* live pool size read back
/// from the built pool. The two differ exactly when the pool-build fallback
/// fired; `boundary::diagnostics::JobDiagnostics` reports both so benchmark
/// validation can reject requested-versus-actual mismatches instead of
/// silently attributing multi-thread timings to a one-thread pool.
pub struct JobPool {
    pool: Arc<rayon::ThreadPool>,
    requested_thread_count: usize,
    actual_thread_count: usize,
}

impl JobPool {
    /// Resolves the thread count and builds the pool. Does not install it
    /// -- call [`Self::install`] on the job's coordinating thread to make
    /// [`with_job_pool`] reach it.
    pub fn new(override_count: Option<usize>) -> Self {
        let requested_thread_count = resolve_thread_count(override_count);
        Self::from_pool(
            build_job_thread_pool(requested_thread_count),
            requested_thread_count,
        )
    }

    fn from_pool(pool: rayon::ThreadPool, requested_thread_count: usize) -> Self {
        let actual_thread_count = pool.current_num_threads();
        Self {
            pool: Arc::new(pool),
            requested_thread_count,
            actual_thread_count,
        }
    }

    /// The resolved requested pool size (override, environment variable, or
    /// automatic default). What [`build_job_thread_pool`] was asked for.
    pub fn requested_thread_count(&self) -> usize {
        self.requested_thread_count
    }

    /// The live pool's actual worker count, read back from the built pool.
    /// Equal to [`Self::requested_thread_count`] unless the pool-build
    /// fallback degraded to a single-thread pool.
    pub fn actual_thread_count(&self) -> usize {
        self.actual_thread_count
    }

    /// Both counts as one copyable snapshot, for `boundary::run_job`'s
    /// return tuple and the diagnostics sidecar.
    pub fn thread_counts(&self) -> JobThreadCounts {
        JobThreadCounts {
            requested: self.requested_thread_count,
            actual: self.actual_thread_count,
        }
    }

    /// Installs this pool into the calling OS thread's thread-local slot
    /// for the lifetime of the returned guard, so [`with_job_pool`] and
    /// [`has_job_pool`] resolve to this pool from that thread.
    pub fn install(&self) -> JobPoolGuard {
        JOB_POOL.with(|slot| {
            *slot.borrow_mut() = Some(Arc::clone(&self.pool));
        });
        JobPoolGuard { _private: () }
    }

    /// Runs `body` inside this pool (`ThreadPool::install`), with the
    /// job-pool slot installed on the executing worker for `body`'s whole
    /// duration. The job's coordinating code thereby runs ON a pool worker,
    /// so every nested [`with_job_pool`] call resolves to the same pool the
    /// current thread already belongs to and Rayon executes it inline --
    /// no cross-thread injection, wakeup, or join handshake per call.
    ///
    /// This exists because the per-call dispatch cost of entering the pool
    /// from an outside coordinating thread is large in aggregate: the
    /// strict decoder alone crosses `with_job_pool` once per bounded
    /// scoring chunk (thousands of times per job), and the measured cost of
    /// those handshakes on the C1 Mixed-61 case was ~6.7 s per job at one
    /// thread (run_mixed61 example, no-pool 25.8 s vs 1-worker pool
    /// 32.5 s). Running the whole job body inside one install collapses
    /// every nested entry to an inline call while leaving each parallel
    /// site's chunking, replay order, and serial fallback untouched.
    ///
    /// During parallel sections the executing worker participates in the
    /// parallel iterator exactly where the outside coordinator would have
    /// parked waiting, so effective parallel width is unchanged.
    pub fn run_scoped<R, F>(&self, body: F) -> R
    where
        F: FnOnce() -> R + Send,
        R: Send,
    {
        self.pool.install(|| {
            let _guard = self.install();
            body()
        })
    }
}

/// Returns whether this OS thread has an installed job-owned pool.
pub(crate) fn has_job_pool() -> bool {
    JOB_POOL.with(|slot| slot.borrow().is_some())
}

/// Runs `body` on this OS thread's currently-installed job pool
/// (`ThreadPool::install`), or inline on the calling thread if no pool is
/// installed (see this module's top doc, third bullet). Every Rayon
/// parallel site in this crate that wants job-owned, non-global-pool
/// parallelism calls this rather than a bare `rayon::prelude` method.
pub fn with_job_pool<R, F>(body: F) -> R
where
    F: FnOnce() -> R + Send,
    R: Send,
{
    let pool = JOB_POOL.with(|slot| slot.borrow().clone());
    match pool {
        Some(pool) => pool.install(body),
        None => body(),
    }
}

/// Chunked compute-then-replay driver shared by the whole-batch parallel
/// sites whose serial loops observe a cooperative-cancellation checkpoint
/// every fixed number of items (the crop enumeration in
/// `archive::periodic_cells` and the per-point legality loop in
/// `nfp_ifp::candidates`). Dispatches `items` in bounded `chunk_size`
/// chunks through the job-owned pool ([`map_slice_with_job_pool`]:
/// ordinary serial iteration when no pool is installed), observing
/// `chunk_checkpoint` once per chunk boundary -- reproducing a serial
/// `index % chunk_size == 0` checkpoint observation ordinal for ordinal --
/// and replays every chunk completely, in source-ordinal order, before the
/// next chunk is dispatched, so at most one chunk of outcomes is ever
/// live. `before_each` fires exactly once per ordinal up to and including
/// an erroring item and never beyond it; the first error in ordinal order
/// is returned and no later chunk is dispatched, reproducing the serial
/// short-circuit exactly.
pub(crate) fn for_each_chunked_outcome<S, T, E>(
    items: &[S],
    chunk_size: usize,
    mut chunk_checkpoint: impl FnMut() -> Result<(), E>,
    compute: impl Fn(&S) -> Result<Option<T>, E> + Sync + Send,
    mut before_each: impl FnMut(&S),
    mut replay: impl FnMut(&S, T),
) -> Result<(), E>
where
    S: Sync,
    T: Send,
    E: Send,
{
    for chunk in items.chunks(chunk_size) {
        chunk_checkpoint()?;
        let outcomes = map_slice_with_job_pool(chunk, &compute);
        for (item, outcome) in chunk.iter().zip(outcomes) {
            before_each(item);
            if let Some(value) = outcome? {
                replay(item, value);
            }
        }
    }
    Ok(())
}

/// Order-preserving per-item map over `items`: dispatched across the
/// installed job-owned pool when one exists, ordinary serial iteration when
/// none does.
///
/// This is the required shape for a whole-batch parallel site (contrast
/// with `search::strict_decoder`'s chunked scoring loop, which owns its own
/// `has_job_pool` branch for the same reason): wrapping a bare `par_iter()`
/// in [`with_job_pool`] alone is NOT enough, because `with_job_pool`'s
/// no-pool fallback runs the closure inline on the calling thread and a
/// parallel iterator inside that closure would then dispatch onto Rayon's
/// ambient global registry -- a pool this crate never owns, shared across
/// jobs, forbidden by this module's top doc. The explicit [`has_job_pool`]
/// branch here guarantees the no-pool path never touches Rayon at all
/// (proven by `tests/no_pool_global_rayon_containment.rs` and this module's
/// own unit tests).
///
/// Output order is the input slice order in both branches (`par_iter`'s
/// indexed collect preserves input order regardless of completion order),
/// so ordinal = input index is the stable-index scheme for every caller.
pub fn map_slice_with_job_pool<T, R, F>(items: &[T], map: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync + Send,
{
    use rayon::prelude::*;
    if has_job_pool() {
        with_job_pool(|| items.par_iter().map(&map).collect())
    } else {
        items.iter().map(map).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Barrier, Mutex};
    use std::thread;

    #[test]
    fn resolve_thread_count_prefers_explicit_override() {
        assert_eq!(resolve_thread_count(Some(4)), 4);
    }

    #[test]
    fn resolve_thread_count_clamps_a_zero_override_to_one() {
        assert_eq!(resolve_thread_count(Some(0)), 1);
    }

    #[test]
    fn thread_count_env_parsing_rejects_invalid_or_zero_values() {
        // Intentionally does not touch `env::set_var` for the real
        // `THREAD_COUNT_ENV_VAR`: this crate's tests run concurrently in
        // one process, and mutating real process environment state from a
        // unit test would race every other test that also resolves thread
        // count. The override parameter (already covered above) is this
        // module's designed seam for deterministic testing; this test only
        // proves the pure parsing logic in isolation.
        assert_eq!(
            "not-a-number".parse::<usize>().ok().filter(|n| *n > 0),
            None
        );
        assert_eq!("0".parse::<usize>().ok().filter(|n| *n > 0), None);
        assert_eq!("3".parse::<usize>().ok().filter(|n| *n > 0), Some(3));
    }

    #[test]
    fn automatic_thread_count_reserves_one_cpu_without_dropping_below_one() {
        assert_eq!(default_thread_count_from_available(1), 1);
        assert_eq!(default_thread_count_from_available(2), 1);
        assert_eq!(default_thread_count_from_available(4), 3);
        assert_eq!(default_thread_count_from_available(16), 15);
    }

    #[test]
    fn with_job_pool_runs_inline_when_no_pool_is_installed() {
        let result = with_job_pool(|| 1 + 1);
        assert_eq!(result, 2);
    }

    #[test]
    fn map_slice_runs_serially_without_an_installed_pool() {
        let items: Vec<usize> = (0..64).collect();
        let observations =
            map_slice_with_job_pool(&items, |value| (*value, rayon::current_thread_index()));
        assert!(
            observations.iter().all(|(_, index)| index.is_none()),
            "without an installed job pool, no item may execute on any Rayon worker \
             thread (global registry included): {observations:?}"
        );
        let values: Vec<usize> = observations.into_iter().map(|(value, _)| value).collect();
        assert_eq!(values, items, "serial branch must preserve input order");
    }

    #[test]
    fn map_slice_dispatches_to_the_installed_pool_and_preserves_order() {
        let job_pool = JobPool::new(Some(4));
        let _guard = job_pool.install();
        let items: Vec<usize> = (0..64).collect();
        let observations =
            map_slice_with_job_pool(&items, |value| (*value * 2, rayon::current_thread_index()));
        assert!(
            observations.iter().all(|(_, index)| index.is_some()),
            "with an installed job pool, every item must execute on one of its worker \
             threads, never inline on the coordinating thread"
        );
        let values: Vec<usize> = observations.into_iter().map(|(value, _)| value).collect();
        let expected: Vec<usize> = items.iter().map(|value| value * 2).collect();
        assert_eq!(
            values, expected,
            "parallel branch must preserve input order regardless of completion order"
        );
    }

    /// A builder that fails for every multi-thread request and succeeds only
    /// for the single-thread fallback, producing a real
    /// `ThreadPoolBuildError` through Rayon's own `spawn_handler` seam.
    fn failing_multi_thread_builder(
        thread_count: usize,
    ) -> Result<rayon::ThreadPool, rayon::ThreadPoolBuildError> {
        let builder = rayon::ThreadPoolBuilder::new().num_threads(thread_count);
        if thread_count > 1 {
            builder
                .spawn_handler(|_thread| Err(std::io::Error::other("forced spawn failure")))
                .build()
        } else {
            builder.build()
        }
    }

    #[test]
    fn pool_build_fallback_degrades_to_a_single_thread_pool() {
        let pool = build_job_thread_pool_via(8, failing_multi_thread_builder);
        assert_eq!(
            pool.current_num_threads(),
            1,
            "a failed multi-thread pool build must fall back to a genuine 1-worker pool"
        );
    }

    #[test]
    fn job_pool_reports_actual_count_separately_from_requested_after_fallback() {
        let requested = 8;
        let pool = build_job_thread_pool_via(requested, failing_multi_thread_builder);
        let job_pool = JobPool::from_pool(pool, requested);
        assert_eq!(job_pool.requested_thread_count(), requested);
        assert_eq!(
            job_pool.actual_thread_count(),
            1,
            "diagnostics must expose the live pool size, not echo the requested count, \
             when the pool-build fallback fired"
        );
    }

    #[test]
    fn job_pool_actual_count_matches_requested_when_the_build_succeeds() {
        let job_pool = JobPool::new(Some(3));
        assert_eq!(job_pool.requested_thread_count(), 3);
        assert_eq!(job_pool.actual_thread_count(), 3);
    }

    #[test]
    fn run_scoped_executes_on_a_pool_worker_with_the_slot_installed() {
        let job_pool = JobPool::new(Some(2));
        let (worker_index, slot_installed, parallel_observations) = job_pool.run_scoped(|| {
            use rayon::prelude::*;
            let parallel_observations: Vec<bool> = with_job_pool(|| {
                (0..16)
                    .into_par_iter()
                    .map(|_| rayon::current_thread_index().is_some())
                    .collect()
            });
            (
                rayon::current_thread_index(),
                has_job_pool(),
                parallel_observations,
            )
        });
        assert!(
            worker_index.is_some(),
            "run_scoped must execute its body on a worker of the job pool"
        );
        assert!(
            slot_installed,
            "the job-pool slot must be installed on the executing worker so nested \
             with_job_pool calls resolve to this pool"
        );
        assert!(
            parallel_observations.iter().all(|on_worker| *on_worker),
            "nested parallel work must still run on pool workers"
        );
    }

    #[test]
    fn run_scoped_reinstalls_the_slot_freshly_on_every_run() {
        let job_pool = JobPool::new(Some(2));
        for _ in 0..3 {
            assert!(job_pool.run_scoped(has_job_pool));
        }
        // Outside any run_scoped call, this coordinating thread never had
        // the slot installed at all.
        assert!(!has_job_pool());
    }

    #[test]
    fn installed_pool_actually_runs_work_on_its_own_worker_threads() {
        let job_pool = JobPool::new(Some(4));
        let _guard = job_pool.install();

        let observed: Vec<bool> = with_job_pool(|| {
            use rayon::prelude::*;
            (0..8)
                .into_par_iter()
                .map(|_| rayon::current_thread_index().is_some())
                .collect()
        });
        assert!(
            observed.iter().all(|on_worker| *on_worker),
            "every task dispatched inside `with_job_pool` must run on a Rayon worker thread \
             of the installed pool, not merely be called inline"
        );
    }

    /// `(job_id, observed per-pool tags)` per job, shared across the two
    /// spawned OS threads in
    /// `two_overlapping_jobs_on_different_os_threads_never_share_a_pool`
    /// below (named alias only to satisfy `clippy::type_complexity`).
    type ObservedJobPoolTags = Vec<(u8, HashSet<u64>)>;

    #[test]
    fn two_overlapping_jobs_on_different_os_threads_never_share_a_pool() {
        // Migration-prompt §14.4's required proof: spin up two "jobs" on
        // two different OS threads with overlapping execution windows and
        // assert no Rayon worker thread ever executes work tagged with the
        // other job's id.
        let barrier = Arc::new(Barrier::new(2));
        let observed_ids: Arc<Mutex<ObservedJobPoolTags>> = Arc::new(Mutex::new(Vec::new()));

        let mut handles = Vec::new();
        for job_id in [1u8, 2u8] {
            let barrier = Arc::clone(&barrier);
            let observed_ids = Arc::clone(&observed_ids);
            handles.push(thread::spawn(move || {
                let job_pool = JobPool::new(Some(3));
                let _guard = job_pool.install();
                barrier.wait();
                let pool_addresses: HashSet<u64> = with_job_pool(|| {
                    use rayon::prelude::*;
                    (0..16)
                        .into_par_iter()
                        .map(|_| {
                            // Each worker thread's Rayon *thread index within
                            // its own pool* is not globally unique across
                            // pools, so identify "which pool ran this task"
                            // by the per-pool tag `build_job_thread_pool`'s
                            // `start_handler` stamped into this worker OS
                            // thread's own thread-local at pool-thread-start
                            // -- reading `JOB_POOL` itself would not work
                            // here: that thread-local is only ever populated
                            // on the *coordinating* thread that called
                            // `JobPool::install`, never on the pool's worker
                            // threads that actually execute dispatched
                            // closures.
                            WORKER_POOL_TAG.with(|cell| cell.get())
                        })
                        .collect()
                });
                observed_ids.lock().unwrap().push((job_id, pool_addresses));
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let recorded = observed_ids.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        let (_, first_addresses) = &recorded[0];
        let (_, second_addresses) = &recorded[1];
        assert_eq!(
            first_addresses.len(),
            1,
            "job 1's own parallel work must observe exactly one pool identity"
        );
        assert_eq!(
            second_addresses.len(),
            1,
            "job 2's own parallel work must observe exactly one pool identity"
        );
        assert!(
            first_addresses.is_disjoint(second_addresses),
            "job 1 and job 2 must never observe the same installed-pool identity: {:?} vs {:?}",
            first_addresses,
            second_addresses
        );
    }

    #[test]
    fn sequential_jobs_clear_the_installed_pool_slot_after_each_guard_drops() {
        /*
        Construct and tear down jobs sequentially. After each guard drops,
        `with_job_pool` must fall back to inline execution because the
        coordinator thread-local slot no longer retains the pool.
        */
        for _ in 0..5 {
            let job_pool = JobPool::new(Some(2));
            {
                let _guard = job_pool.install();
                let ran_on_worker: bool = with_job_pool(|| rayon::current_thread_index().is_some());
                assert!(ran_on_worker);
            }
            // Guard dropped: the thread-local slot on *this* OS thread must
            // be clear again.
            let fell_back_to_inline = JOB_POOL.with(|slot| slot.borrow().is_none());
            assert!(fell_back_to_inline);
        }
    }
}
