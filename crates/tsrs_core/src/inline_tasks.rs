//! Deferred work for the language server's single-threaded mode.
//!
//! The mode is chosen at run time by the program that owns the thread (`enable`), never by a cargo feature, so a
//! build that links other consumers of this crate (the `tsrs_wasm` module) keeps its own behavior. Once enabled,
//! code that would hand a closure to another thread (a context's `after_func`, the project's background queue and
//! timers, the server's request workers) queues it here, and the server loop runs the queue between messages
//! (`run_all`). A closure never runs inside the code that deferred it, so it cannot re-enter a lock its caller holds.
//! Context waits run the queue too, so a cancellation that was deferred still arrives.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

type Task = Box<dyn FnOnce() + Send>;
// Some(true): run the task now; Some(false): not yet; None: drop it unrun.
type Ready = Box<dyn FnMut() -> Option<bool> + Send>;

static TASKS: Mutex<VecDeque<Task>> = Mutex::new(VecDeque::new());
static WAITING: Mutex<Vec<(Ready, Task)>> = Mutex::new(Vec::new());
// Relaxed: set once, before the owner's loop starts, by the thread that then runs it.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Switches this process to single-threaded scheduling. Called by the thread that will run `run_all`.
pub fn enable() {
    ENABLED.store(true, Ordering::Relaxed);
}

/// Whether single-threaded scheduling is on.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Queues `f` to run on the next `run_all`.
pub fn defer(f: impl FnOnce() + Send + 'static) {
    TASKS.lock().unwrap().push_back(Box::new(f));
}

/// Queues `f` to run on the first `run_all` pass where `ready` returns `Some(true)`; `None` drops it unrun.
pub fn defer_when(
    ready: impl FnMut() -> Option<bool> + Send + 'static,
    f: impl FnOnce() + Send + 'static,
) {
    WAITING.lock().unwrap().push((Box::new(ready), Box::new(f)));
}

/// Runs queued tasks, including ones queued or made ready while it runs, until none is left. Returns how many ran.
pub fn run_all() -> usize {
    let mut ran = 0;
    loop {
        promote_ready();
        let Some(task) = TASKS.lock().unwrap().pop_front() else {
            return ran;
        };
        task();
        ran += 1;
    }
}

/// Whether a task is queued or ready to run.
pub fn pending() -> bool {
    promote_ready();
    !TASKS.lock().unwrap().is_empty()
}

// Moves the waiting tasks that became ready to the queue and drops the ones that never will run. The checks run and
// the dropped tasks are dropped with no lock held, so either may queue more work.
fn promote_ready() {
    let waiting = std::mem::take(&mut *WAITING.lock().unwrap());
    let mut still_waiting = Vec::with_capacity(waiting.len());
    for (mut ready, task) in waiting {
        match ready() {
            Some(false) => still_waiting.push((ready, task)),
            Some(true) => TASKS.lock().unwrap().push_back(task),
            None => drop((ready, task)),
        }
    }
    WAITING.lock().unwrap().append(&mut still_waiting);
}
