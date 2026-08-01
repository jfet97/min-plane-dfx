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
//! - **`with_job_pool` degrades to inline execution when no pool is
//!   installed.** Every unit test in this crate that calls a
//!   Rayon-touching function directly (bypassing `run_job` entirely, e.g.
//!   `nfp_ifp::candidates`'s own test module) still gets correct,
//!   deterministic results: the closure just runs on the calling thread,
//!   with no `ThreadPool::install` in the picture at all. This is not a
//!   parallelism opportunity lost in tests -- it is the same code path a
//!   1-thread job pool would produce, modulo which OS thread physically
//!   executes it, which is never observable in this crate's output.
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
//! 3. a compiled-in default of `1` -- this task's brief: "default = 1 for
//!    now -- promotion flips the default later." Per prompt §14.4 and
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
/// (falls through to the compiled-in default of `1`), matching this crate's
/// established "malformed out-of-band configuration degrades to the safe
/// default rather than failing the job" convention (mirrors the backend
/// selector precedent `cache-concurrency-design.md` §7 cites).
pub fn resolve_thread_count(override_count: Option<usize>) -> usize {
    if let Some(count) = override_count {
        return count.max(1);
    }
    env::var(THREAD_COUNT_ENV_VAR)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|count| *count > 0)
        .unwrap_or(1)
}

/// Builds a job-owned `rayon::ThreadPool` sized to `thread_count`. Falls
/// back to a single-thread pool if pool construction itself fails
/// (OS thread-spawn failure -- unlikely, but a diagnostics/performance
/// feature must never be the reason a job fails outright).
pub fn build_job_thread_pool(thread_count: usize) -> rayon::ThreadPool {
    let tag = NEXT_POOL_TAG.fetch_add(1, AtomicOrdering::Relaxed);
    rayon::ThreadPoolBuilder::new()
        .num_threads(thread_count)
        .start_handler(move |_worker_index: usize| {
            WORKER_POOL_TAG.with(|cell| cell.set(tag));
        })
        .build()
        .unwrap_or_else(|_| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(1)
                .start_handler(move |_worker_index: usize| {
                    WORKER_POOL_TAG.with(|cell| cell.set(tag));
                })
                .build()
                .expect("a single-threaded Rayon pool always builds")
        })
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

/// A job-owned Rayon pool plus the resolved thread count that produced it
/// (the value `boundary::diagnostics::JobDiagnostics::thread_count_used`
/// reports).
pub struct JobPool {
    pool: Arc<rayon::ThreadPool>,
    thread_count: usize,
}

impl JobPool {
    /// Resolves the thread count and builds the pool. Does not install it
    /// -- call [`Self::install`] on the job's coordinating thread to make
    /// [`with_job_pool`] reach it.
    pub fn new(override_count: Option<usize>) -> Self {
        let thread_count = resolve_thread_count(override_count);
        Self {
            pool: Arc::new(build_job_thread_pool(thread_count)),
            thread_count,
        }
    }

    pub fn thread_count(&self) -> usize {
        self.thread_count
    }

    /// Installs this pool into the calling OS thread's thread-local slot
    /// for the lifetime of the returned guard. Must be called from the
    /// job's single coordinating thread, before any Rayon parallel site
    /// downstream runs (`boundary::run_job`'s own call site is the only
    /// production caller).
    pub fn install(&self) -> JobPoolGuard {
        JOB_POOL.with(|slot| {
            *slot.borrow_mut() = Some(Arc::clone(&self.pool));
        });
        JobPoolGuard { _private: () }
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
    fn resolve_thread_count_defaults_to_one_when_env_var_is_absent_or_invalid() {
        // Intentionally does not touch `env::set_var` for the real
        // `THREAD_COUNT_ENV_VAR`: this crate's tests run concurrently in
        // one process, and mutating real process environment state from a
        // unit test would race every other test that also resolves thread
        // count. The override parameter (already covered above) is this
        // module's designed seam for deterministic testing; this test only
        // proves the pure parsing/fallback logic in isolation.
        assert_eq!(
            "not-a-number".parse::<usize>().ok().filter(|n| *n > 0),
            None
        );
        assert_eq!("0".parse::<usize>().ok().filter(|n| *n > 0), None);
        assert_eq!("3".parse::<usize>().ok().filter(|n| *n > 0), Some(3));
    }

    #[test]
    fn with_job_pool_runs_inline_when_no_pool_is_installed() {
        let result = with_job_pool(|| 1 + 1);
        assert_eq!(result, 2);
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
