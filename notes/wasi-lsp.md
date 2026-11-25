# wasi-lsp: the language server as a single-threaded wasm32-wasip1 command

`crates/tsrs_lsp_wasi` builds `tsrs-lsp.wasm`, the same server as `tsrs --lsp --stdio` for a WASI Preview 1 host
without threads. It speaks LSP over stdin and stdout, takes no flags, reads the workspace through the WASI preopens
and embeds the default libraries. It is a separate crate and binary: the `tsrs_wasm` module and the native `tsrs`
binary do not link it.

```sh
cargo build --release -p tsrs_lsp_wasi --target wasm32-wasip1
wasmtime run --dir /path/to/project::/project target/wasm32-wasip1/release/tsrs-lsp.wasm
```

## Why single-threaded

The server is a port of tsgo's: read, dispatch and write loops, a worker per request, six background workers and a
timer thread (docs/LSP.md "Threading model"). On `wasm32-wasip1` `std::thread::spawn` returns `Unsupported`. The
compiler already runs on one thread when `tsrs_core::NO_THREADS` (notes/wasm-build.md), so only the server's own
concurrency needed a single-threaded form.

## How the mode is chosen

At run time, by the program that owns the thread: `ServerOptions::single_threaded` (always on under `NO_THREADS`)
makes `Server::run` call `tsrs_core::inline_tasks::enable()` and run `run_single_threaded`. There is no cargo
feature, so building `tsrs_wasm` and `tsrs_lsp_wasi` together (or `--workspace`) cannot change the compiler module:
`tsrs_wasm` never calls `enable`, its link has no store to the flag, and the module is byte-identical to the one
built without this change, alone or in a joint build. Native builds keep the threaded server unless a caller asks;
the integration tests (`tsrs_lsp` `single_threaded_test`, `tsrs_core` `inline_tasks_test`) run the single-threaded
mode natively, each in its own process because the switch is process-wide.

## The changes

| File | Change | Reason |
| --- | --- | --- |
| `tsrs_core/src/inline_tasks.rs` | The runtime switch (`enable`, `enabled`), a FIFO of deferred closures (`defer`, `run_all`, `pending`) and closures waiting for a condition (`defer_when`). | Stands in for "run this on another thread". A deferred closure never runs inside the code that deferred it, so it cannot re-enter a lock its caller holds. |
| `tsrs_core/src/context.rs` | Enabled: `after_func` registers its callback with `defer_when`, to run on the first pass after the context is done; `wait_timeout` runs the deferred tasks, then sleeps until the deadline or the timeout; `wait` reports a context that nothing can end instead of blocking. `cancel` and `spawn_after_func` are unchanged, and the helpers sit at the end of the file. | A Condvar wait cannot be woken without another thread, and the checker pool registers an `after_func` on every request context. A cancellation still reaches its callbacks, and no wait spins. `tsrs_wasm` links `cancel` but not `after_func` or the waits, so leaving `cancel` alone (and not calling `CancelState::err` from the new helpers) keeps its code and function order unchanged. |
| `tsrs_project/src/background/queue.rs`, `timer.rs` | Enabled: `go` and `enqueue` defer; `Queue::wait` runs deferred tasks; no timer thread, `fire_due_timers()` defers due callbacks and returns the next deadline. | The background workers and the timer thread. |
| `tsrs_project/src/session.rs` | Enabled: the snapshot-update and diagnostics-refresh debounces are skipped. | The task already runs between messages, after the events it would coalesce; sleeping would stall the only thread. |
| `tsrs_lsp/src/progress.rs`, `workerpool.rs` | Enabled: no progress runner (events are dropped); request jobs are deferred. | The progress thread and request workers. A request's async half runs right after its sync half. |
| `tsrs_lsp/src/server.rs` `route_incoming`, `dispatch_one`, `write_one` | The bodies of `read_loop`, `dispatch_loop` and `write_loop` for one message, extracted. | Both modes share them; the threaded loops call them as before. |
| `tsrs_lsp/src/server.rs` `run_single_threaded` | Run deferred tasks and due timers, take a queued request or read one, dispatch it. An idle read wakes for the next timer (`ServerOptions::input_ready`). EOF or `exit` returns. | The single-threaded `run`. |
| `tsrs_lsp/src/server.rs` `read_until_response` | After a server-to-client request, read until its response: other responses are routed, `$/cancelRequest` applies at once, `exit` is recorded and ends the wait, other messages are queued in order. The wait ends at the context's deadline (`input_ready`). | The handler that sent the request is the only thread, so it reads the reply itself. A silent client cannot stall the server past a request's deadline (watch registrations have one second each). |
| `tsrs_lsp/src/server.rs` `cancel_request`, `take_canceled` | A `$/cancelRequest` for a queued request marks it; when its turn comes it is answered with `RequestCancelled` and not run. | LSP cancellation for requests read before the one being canceled could run. |
| `tsrs_lsp/src/server.rs` `exit_status` | 1 when `exit` came without `shutdown`, else 0. | LSP's exit status. The native binary keeps tsgo's behavior; `tsrs_lsp_wasi` returns it. |
| `tsrs_lsproto` `Reader::read_before`, `tsrs_lsp` `Reader::read_before`, `Server::read_before` | Single-threaded reads go through `read_before`: it asks `input_ready` (with the time left to the deadline) before every read from the source that would wait, returns None at the deadline and keeps a partly read header or body for the next call. Frames and errors are `read`'s; `read`, which the threaded server uses, shares its header parsing and is otherwise unchanged. | A client that has sent only part of a frame (a header without its body) cannot hold the server past a deadline or a due timer; the frame is handled once the rest arrives. |
| `tsrs_lsp_wasi` | The bin: single-threaded, `input_ready` from WASI `poll_oneoff` on fd 0 with a monotonic clock subscription, osvfs plus bundled libraries, stdin and stdout; no npm install, content mappers, parent watchdog or signals; 80 MiB shadow stack; 1 GiB memory maximum. | A WASI command cannot spawn or signal. The stack is tsrs_wasm's. Without a maximum the module declares 4 GiB. |

## Behavior differences from native

- One message at a time. A long request (a cold program build) delays the next; `$/cancelRequest` is read between
  messages, or while a handler waits for a client response. Interrupting CPU-bound work is not possible here.
- No progress notifications, automatic type acquisition, content mappers, API sessions or builtin file watching.
  Client-registered watchers (`workspace/didChangeWatchedFiles`) work as natively.
- The project checker pool keeps its slots (four by default, three for queries); with one thread only one request
  holds checkers at a time.

## Size and verification

The release build (opt-level s, inline threshold 150, fat LTO, `panic = abort`, `wasm-opt -Os`, as
`tools/wasm/build.sh`) is about 12.5 MB raw and 2.66 MB brotli -q 11. `tsrs_wasm` built by `tools/wasm/build.sh`
is byte-identical before and after this change, built alone or together with `tsrs_lsp_wasi`.

`tsrs_lsp` `single_threaded_test` drives the single-threaded server over framed pipes: a request canceled while queued
behind a client reply is answered with `RequestCancelled`; an unanswered watch registration ends at its deadline
and later requests run; a request whose header arrives before such a deadline and whose body arrives after it
leaves the deadline intact and is answered once complete; `exit` while a reply is outstanding returns with status 1;
`exit` without `shutdown` returns 1 and after `shutdown` 0. `tsrs_lsproto` `baseproto_read_before_test` checks that
`read_before` returns `read`'s frames and errors when input arrives a byte at a time with pauses, and keeps a frame
split across a pause. `tsrs_core` `inline_tasks_test` covers waits that run a deferred cancellation, end
at a deadline, or report a context nothing can end. A scripted session under wasmtime checks pull diagnostics,
hover, completion and definition into `node_modules` `.d.ts`.
