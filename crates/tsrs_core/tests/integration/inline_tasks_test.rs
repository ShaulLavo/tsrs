// Single-threaded scheduling (`inline_tasks::enable`) switches the whole process, so each case runs alone in a child.

use std::panic::AssertUnwindSafe;
use std::time::Duration;

use tsrs_core::context::{Context, ContextError};
use tsrs_core::inline_tasks;

#[test]
fn single_threaded_wait_runs_a_deferred_cancellation() {
    if !crate::isolated::in_child(
        "inline_tasks_test::single_threaded_wait_runs_a_deferred_cancellation",
    ) {
        return;
    }
    inline_tasks::enable();
    let (trigger, cancel_trigger) = Context::background().with_cancel();
    let (waited, cancel_waited) = Context::background().with_cancel();
    let _stop = trigger.after_func(move || cancel_waited.call());
    cancel_trigger.call();
    assert!(inline_tasks::pending(), "the after_func callback is deferred, not run on a thread");
    waited.wait();
    assert_eq!(waited.err(), Some(ContextError::Canceled));
}

#[test]
fn single_threaded_wait_timeout_runs_deferred_work_before_sleeping() {
    if !crate::isolated::in_child(
        "inline_tasks_test::single_threaded_wait_timeout_runs_deferred_work_before_sleeping",
    ) {
        return;
    }
    inline_tasks::enable();
    let (trigger, cancel_trigger) = Context::background().with_cancel();
    let (waited, cancel_waited) = Context::background().with_cancel();
    let _stop = trigger.after_func(move || cancel_waited.call());
    cancel_trigger.call();
    assert!(waited.wait_timeout(Duration::from_secs(3600)), "canceled by the deferred callback");
}

#[test]
fn single_threaded_wait_ends_at_the_deadline() {
    if !crate::isolated::in_child("inline_tasks_test::single_threaded_wait_ends_at_the_deadline") {
        return;
    }
    inline_tasks::enable();
    let (ctx, _cancel) = Context::background().with_timeout(Duration::from_millis(20));
    ctx.wait();
    assert_eq!(ctx.err(), Some(ContextError::DeadlineExceeded));
}

#[test]
fn single_threaded_wait_that_nothing_can_end_is_reported() {
    if !crate::isolated::in_child(
        "inline_tasks_test::single_threaded_wait_that_nothing_can_end_is_reported",
    ) {
        return;
    }
    inline_tasks::enable();
    let (ctx, _cancel) = Context::background().with_cancel();
    let waited = std::panic::catch_unwind(AssertUnwindSafe(|| ctx.wait()));
    assert!(
        waited.is_err(),
        "a wait with no deadline and nothing queued to cancel it must not block or spin"
    );
}
