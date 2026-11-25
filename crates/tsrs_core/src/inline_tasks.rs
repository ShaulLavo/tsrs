//! Deferred work for `INLINE_TASKS` builds (`NO_THREADS` targets with the `inline-tasks` feature), where nothing
//! can start a thread.
//!
//! Code that would hand a closure to another thread (a context's `after_func`, the project's background queue and
//! timers) pushes it here instead, and the single-threaded language server loop runs the queue between messages
//! (`run_all`). A closure never runs inside the code that deferred it, so it cannot re-enter a lock its caller holds.

use std::collections::VecDeque;
use std::sync::Mutex;

type Task = Box<dyn FnOnce() + Send>;

static TASKS: Mutex<VecDeque<Task>> = Mutex::new(VecDeque::new());

/// Queues `f` to run on the next `run_all`.
pub fn defer(f: impl FnOnce() + Send + 'static) {
    TASKS.lock().unwrap().push_back(Box::new(f));
}

/// Runs queued tasks, including ones queued while it runs, until the queue is empty. Returns how many ran.
pub fn run_all() -> usize {
    let mut ran = 0;
    loop {
        let Some(task) = TASKS.lock().unwrap().pop_front() else {
            return ran;
        };
        task();
        ran += 1;
    }
}

/// Whether tasks are waiting.
pub fn pending() -> bool {
    !TASKS.lock().unwrap().is_empty()
}
