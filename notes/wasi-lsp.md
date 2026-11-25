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

Every new branch is behind `tsrs_core::INLINE_TASKS`: `NO_THREADS` and tsrs_core's `inline-tasks` feature, which
only tsrs_lsp enables. It is false on native targets, and false in the `tsrs_wasm` build, which does not link
tsrs_lsp, so that module is byte-identical to the one built without this change. In the table, "inline" means
`INLINE_TASKS` is true.

## The changes

| File | Change | Reason |
| --- | --- | --- |
| `tsrs_core/src/inline_tasks.rs` | A FIFO of deferred closures: `defer`, `run_all`, `pending`. | Stands in for "run this on another thread". A deferred closure never runs inside the code that deferred it, so it cannot re-enter a lock its caller holds. |
| `tsrs_core/src/context.rs` `spawn_after_func` | Inline: defer the callback. | `Context::after_func` callbacks ran on a new thread each. |
| `tsrs_core/src/context.rs` `wait_timeout_single_threaded` | Inline: true if canceled; sleep only up to a deadline that falls inside the timeout; else false at once. | A Condvar wait panics without threads, and nothing else can cancel the context while the only thread waits. Debounce waits (snapshot update, diagnostics refresh) end at once; the work they coalesce runs between messages. |
| `tsrs_project/src/background/queue.rs` | `go` and `enqueue` defer; `Queue::wait` runs deferred tasks until the queue's count is zero. | The six background worker threads. |
| `tsrs_project/src/background/timer.rs` | No timer thread; `fire_due_timers()` defers due callbacks and returns the next deadline. | The timer thread. The server loop fires due timers before each read, so a timer runs late by up to one client message (idle cache cleanup, checker pool cleanup). |
| `tsrs_lsp/src/progress.rs` | Inline: no runner; events are dropped. | The progress thread. No work-done progress. |
| `tsrs_lsp/src/workerpool.rs` `go` | Inline: defer the job. | Request workers. A request's async half runs right after its sync half, before the next read. |
| `tsrs_lsp/src/server.rs` `route_incoming`, `dispatch_one`, `write_one` | The bodies of `read_loop`, `dispatch_loop` and `write_loop` for one message, extracted. | Both modes share them; the threaded loops call them as before. |
| `tsrs_lsp/src/server.rs` `run_single_threaded` | Run deferred tasks and due timers, take a queued request or read one, dispatch it; EOF or `exit` returns. | The single-threaded `run`. |
| `tsrs_lsp/src/server.rs` `send` | Inline: write at once. | The write thread. |
| `tsrs_lsp/src/server.rs` `read_until_response` | Inline: after a server-to-client request, read until its response; route other responses, apply `$/cancelRequest`, queue requests in `deferred_requests`. | The handler that sent the request is the only thread, so it reads the reply itself. |
| `tsrs_lsp_wasi` | The bin: osvfs plus bundled libraries, stdin and stdout; no npm install, content mappers, parent watchdog or signals; 80 MiB shadow stack; 1 GiB memory maximum. | A WASI command cannot spawn or signal. The stack is tsrs_wasm's. Without a maximum the module declares 4 GiB. |

## Behavior differences from native

- One message at a time. A long request (a cold program build) delays the next; `$/cancelRequest` is read between
  messages, or while a handler waits for a client response.
- No progress notifications, automatic type acquisition, content mappers, API sessions or builtin file watching.
  Client-registered watchers (`workspace/didChangeWatchedFiles`) work as natively.
- One checker per program (`available_parallelism` is 1 on WASI). A language-service path that takes a second
  checker while holding one (call hierarchy) would wait on itself.

## Size and verification

The release build (opt-level s, inline threshold 150, fat LTO, `panic = abort`, `wasm-opt -Os`, as
`tools/wasm/build.sh`) is 12,491,644 bytes raw and 2,657,550 brotli -q 11. `tsrs_wasm` built by
`tools/wasm/build.sh` is byte-identical before and after this change.

A scripted session under wasmtime 51 on a three-file project with a `node_modules` package that ships only `.d.ts`
checks: a TS2322 pull diagnostic that appears, clears after an incremental edit and follows five more edits; hover
(`const step: Vector`); member completion from a local class and from the package; definition across files and into
the package's `.d.ts`. Warm requests answer in about 1 ms. Native `cargo test -p tsrs_lsp -p tsrs_project
-p tsrs_core` exercises the threaded paths that now go through the extracted functions.
