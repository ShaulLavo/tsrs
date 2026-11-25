// `tsrs-lsp`: the language server over stdin and stdout, for a WASI Preview 1 host without threads.
// Same server as `tsrs --lsp --stdio`, without the parts a WASI command cannot have: no npm install for
// automatic type acquisition, no content-mapper child processes, no parent-process watchdog and no signals.
// The workspace comes from `initialize`; files are read through the WASI preopens.

use std::sync::Arc;
use std::time::Duration;

use tsrs_core::context::Context;
use tsrs_vfs::{FS, bundled, osvfs};

fn main() -> std::process::ExitCode {
    let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(osvfs::fs()));
    let cwd =
        std::env::var("PWD").ok().filter(|dir| dir.starts_with('/')).unwrap_or_else(|| "/".into());
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
    });
    let (ctx, _stop) = Context::background().with_cancel();
    match server.run(&ctx) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("{err}");
            std::process::ExitCode::FAILURE
        }
    }
}
