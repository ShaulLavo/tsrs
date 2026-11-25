// Waiting for stdin with a timeout: WASI Preview 1 `poll_oneoff` with an fd_read subscription on fd 0 and an
// optional relative monotonic clock subscription. Layouts follow the witx definitions (`subscription` 48 bytes,
// `event` 32 bytes).

use std::time::Duration;

const EVENTTYPE_CLOCK: u8 = 0;
const EVENTTYPE_FD_READ: u8 = 1;
const CLOCKID_MONOTONIC: u32 = 1;
const STDIN_USERDATA: u64 = 1;

#[repr(C)]
#[derive(Clone, Copy)]
struct SubscriptionClock {
    id: u32,
    timeout: u64,
    precision: u64,
    flags: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct SubscriptionFdReadwrite {
    file_descriptor: u32,
}

#[repr(C)]
union SubscriptionContents {
    clock: SubscriptionClock,
    fd_read: SubscriptionFdReadwrite,
}

#[repr(C)]
struct Subscription {
    userdata: u64,
    tag: u8,
    contents: SubscriptionContents,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Event {
    userdata: u64,
    error: u16,
    kind: u8,
    nbytes: u64,
    flags: u16,
}

const _: () = assert!(size_of::<Subscription>() == 48 && size_of::<Event>() == 32);

#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    fn poll_oneoff(
        subscriptions: *const Subscription,
        events: *mut Event,
        count: usize,
        ready: *mut usize,
    ) -> u16;
}

/// Whether stdin has input (or end of file) within `timeout`; no limit for None. A failed poll reports input, so
/// the caller's blocking read decides.
pub fn stdin_ready(timeout: Option<Duration>) -> bool {
    let stdin = Subscription {
        userdata: STDIN_USERDATA,
        tag: EVENTTYPE_FD_READ,
        contents: SubscriptionContents { fd_read: SubscriptionFdReadwrite { file_descriptor: 0 } },
    };
    let mut subscriptions = vec![stdin];
    if let Some(timeout) = timeout {
        let nanos = u64::try_from(timeout.as_nanos()).unwrap_or(u64::MAX);
        subscriptions.push(Subscription {
            userdata: 0,
            tag: EVENTTYPE_CLOCK,
            contents: SubscriptionContents {
                clock: SubscriptionClock {
                    id: CLOCKID_MONOTONIC,
                    timeout: nanos,
                    precision: 0,
                    flags: 0,
                },
            },
        });
    }
    let mut events = [Event::default(); 2];
    let mut ready = 0usize;
    // SAFETY: `subscriptions` holds `subscriptions.len()` initialized witx `subscription` records and `events` has room
    // for that many `event` records; the host writes at most `subscriptions.len()` events and their count to `ready`.
    let errno = unsafe {
        poll_oneoff(
            subscriptions.as_ptr(),
            events.as_mut_ptr(),
            subscriptions.len(),
            &raw mut ready,
        )
    };
    errno != 0
        || events[..ready.min(events.len())].iter().any(|event| event.userdata == STDIN_USERDATA)
}
