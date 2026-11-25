// `tsrs-lsp`: the language server over stdin and stdout, for a WASI Preview 1 host without threads.
// Same server as `tsrs --lsp --stdio`, on its single-threaded loop, without the parts a WASI command cannot have: no
// npm install for automatic type acquisition, no content-mapper child processes, no parent-process watchdog and no
// signals. The workspace comes from `initialize`; files are read through the WASI preopens. An `exit` without a
// prior `shutdown` exits with status 1.

use std::sync::Arc;
use std::time::Duration;

use tsrs_core::context::Context;
use tsrs_vfs::{FS, bundled, osvfs};

#[cfg(target_os = "wasi")]
mod poll;

fn main() -> std::process::ExitCode {
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(osvfs::fs()));
    let cwd =
        std::env::var("PWD").ok().filter(|dir| dir.starts_with('/')).unwrap_or_else(|| "/".into());
    #[cfg(target_os = "wasi")]
    let input_ready: Option<tsrs_lsp::InputReadyFunc> = Some(Box::new(poll::stdin_ready));
    #[cfg(not(target_os = "wasi"))]
    let input_ready = None;
    let server = tsrs_lsp::new_server(tsrs_lsp::ServerOptions {
        in_: tsrs_lsp::to_reader(std::io::stdin()),
        out: tsrs_lsp::to_writer(std::io::stdout()),
        err: Box::new(std::io::stderr()),
        cwd,
        fs: Some(fs),
        default_library_path: bundled::default_lib_path(),
        typings_location: String::new(),
        parse_cache: None,
        npm_install: None,
        spawn: None,
        progress_delay: Duration::from_millis(250),
        set_parent_process_id: None,
        single_threaded: true,
        input_ready,
    });
    let (ctx, _stop) = Context::background().with_cancel();
    match server.run(&ctx) {
        Ok(()) => std::process::ExitCode::from(server.exit_status()),
        Err(err) => {
            eprintln!("{err}");
            std::process::ExitCode::FAILURE
        }
    }
}
