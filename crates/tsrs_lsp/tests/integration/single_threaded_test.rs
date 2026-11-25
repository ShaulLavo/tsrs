// The single-threaded server (`ServerOptions::single_threaded`, as on WASI) over framed byte pipes, with an
// `input_ready` that waits on the pipe: cancellation of requests queued while a handler waits for a client reply,
// client-reply waits that end at their deadline or at `exit`, and the exit status. Single-threaded scheduling is
// process-wide, so each case runs alone in a child process.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tsrs_core::context::Context;
use tsrs_core::json::{self, Value};
use tsrs_lsp::{new_server, to_reader, to_writer};

use crate::lsptestutil::test_server_options;

// Only a hang cap: every wait below ends as soon as its message arrives.
const HANG_CAP: Duration = Duration::from_secs(60);
const ROOT: &str = "/home/projects/p";
const MAIN: &str = "/home/projects/p/index.ts";
const MAIN_TEXT: &str = "function target(): number { return 1; }\ntarget();\n";
const REQUEST_CANCELLED: f64 = -32800.0;

#[derive(Default)]
struct PipeState {
    buf: VecDeque<u8>,
    closed: bool,
}

#[derive(Clone, Default)]
struct Pipe(Arc<(Mutex<PipeState>, Condvar)>);

impl Pipe {
    // `ServerOptions::input_ready`: true once bytes (or the end) are there, false when `timeout` passes first.
    fn ready(&self, timeout: Option<Duration>) -> bool {
        let deadline = timeout.map(|timeout| Instant::now() + timeout);
        let mut state = self.0.0.lock().unwrap();
        while state.buf.is_empty() && !state.closed {
            let Some(deadline) = deadline else {
                state = self.0.1.wait(state).unwrap();
                continue;
            };
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            state = self.0.1.wait_timeout(state, left).unwrap().0;
        }
        true
    }

    fn close(&self) {
        self.0.0.lock().unwrap().closed = true;
        self.0.1.notify_all();
    }
}

impl Read for Pipe {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        self.ready(None);
        let mut state = self.0.0.lock().unwrap();
        let n = out.len().min(state.buf.len());
        for (slot, byte) in out.iter_mut().zip(state.buf.drain(..n)) {
            *slot = byte;
        }
        Ok(n)
    }
}

impl Write for Pipe {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.0.0.lock().unwrap().buf.extend(data);
        self.0.1.notify_all();
        Ok(data.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    match value {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

fn registers_file_watching(request: &Value) -> bool {
    let Some(Value::Array(registrations)) =
        field(request, "params").and_then(|p| field(p, "registrations"))
    else {
        return false;
    };
    registrations
        .iter()
        .any(|r| text(field(r, "method")) == Some("workspace/didChangeWatchedFiles"))
}

fn hover_body(id: i64) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"textDocument/hover","params":{{"textDocument":{{"uri":"file://{MAIN}"}},"position":{{"line":1,"character":1}}}}}}"#
    )
}

fn read_frame(reader: &mut impl BufRead) -> Option<String> {
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        if line == "\r\n" {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = value.trim().parse().ok()?;
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    String::from_utf8(body).ok()
}

struct Client {
    to_server: Pipe,
    from_server: Receiver<Value>,
    exited: Receiver<Result<u8, String>>,
}

impl Client {
    fn start() -> Client {
        let to_server = Pipe::default();
        let to_client = Pipe::default();
        let mut options = test_server_options(
            ROOT,
            &[("/home/projects/p/tsconfig.json", "{}"), (MAIN, MAIN_TEXT)],
        );
        options.in_ = to_reader(to_server.clone());
        options.out = to_writer(to_client.clone());
        options.single_threaded = true;
        let input = to_server.clone();
        options.input_ready = Some(Box::new(move |timeout| input.ready(timeout)));
        let server = new_server(options);

        let (exit_tx, exited) = mpsc::channel();
        let output = to_client.clone();
        std::thread::spawn(move || {
            let (ctx, _stop) = Context::background().with_cancel();
            let status =
                server.run(&ctx).map(|()| server.exit_status()).map_err(|err| err.to_string());
            output.close();
            let _ = exit_tx.send(status);
        });
        let (message_tx, from_server) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(to_client);
            while let Some(body) = read_frame(&mut reader) {
                let _ = message_tx.send(json::unmarshal(&body).expect("server sent JSON"));
            }
        });
        Client { to_server, from_server, exited }
    }

    fn send(&self, body: &str) {
        let mut pipe = self.to_server.clone();
        write!(pipe, "Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    }

    fn next(&self) -> Value {
        self.from_server.recv_timeout(HANG_CAP).expect("a server message within the hang cap")
    }

    // The next server-to-client request with this method; other messages before it are dropped.
    fn request_from_server(&self, method: &str) -> Value {
        loop {
            let message = self.next();
            if text(field(&message, "method")) == Some(method) && field(&message, "id").is_some() {
                return message;
            }
        }
    }

    // Answers a server-to-client request: `workspace/configuration` with one null per item, anything else with null.
    fn answer(&self, request: &Value) {
        let id = json::marshal(field(request, "id").unwrap()).unwrap();
        let items = match field(field(request, "params").unwrap_or(&Value::Null), "items") {
            Some(Value::Array(items)) => items.len(),
            _ => 0,
        };
        let result = if text(field(request, "method")) == Some("workspace/configuration") {
            format!("[{}]", vec!["null"; items].join(","))
        } else {
            "null".to_string()
        };
        self.send(&format!(r#"{{"jsonrpc":"2.0","id":{id},"result":{result}}}"#));
    }

    // The response to client request `id`. Server requests on the way are answered, except file-watch registrations
    // when `silent_registrar` is set (a client that never answers them).
    fn response(&self, id: i64, silent_registrar: bool) -> Value {
        loop {
            let message = self.next();
            let is_request = field(&message, "method").is_some() && field(&message, "id").is_some();
            if is_request && !(silent_registrar && registers_file_watching(&message)) {
                self.answer(&message);
            }
            if !is_request && field(&message, "id") == Some(&Value::Number(id as f64)) {
                return message;
            }
        }
    }

    fn initialize(&self, capabilities: &str) {
        self.send(&format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"processId":null,"rootUri":"file://{ROOT}","capabilities":{capabilities}}}}}"#
        ));
        self.response(1, false);
        self.send(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#);
    }

    fn open_main(&self) {
        let text = json::marshal_string(MAIN_TEXT);
        self.send(&format!(
            r#"{{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{{"textDocument":{{"uri":"file://{MAIN}","languageId":"typescript","version":1,"text":{text}}}}}}}"#
        ));
    }

    fn hover(&self, id: i64) {
        self.send(&hover_body(id));
    }

    // Writes raw bytes: part of a frame.
    fn write_raw(&self, bytes: &str) {
        self.to_server.clone().write_all(bytes.as_bytes()).unwrap();
    }

    // The next file-watch registration from the server, left unanswered; other server requests are answered.
    fn watch_registration(&self) -> Value {
        loop {
            let message = self.next();
            if registers_file_watching(&message) {
                return message;
            }
            if field(&message, "method").is_some() && field(&message, "id").is_some() {
                self.answer(&message);
            }
        }
    }

    fn exit_status(&self) -> u8 {
        self.exited
            .recv_timeout(HANG_CAP)
            .expect("the server returns within the hang cap")
            .expect("run succeeds")
    }
}

#[test]
fn request_canceled_while_queued_behind_a_client_reply_answers_request_cancelled() {
    if !crate::isolated::in_child(
        "single_threaded_test::request_canceled_while_queued_behind_a_client_reply_answers_request_cancelled",
    ) {
        return;
    }
    let client = Client::start();
    client.initialize(r#"{"workspace":{"configuration":true}}"#);
    let configuration = client.request_from_server("workspace/configuration");
    client.open_main();
    client.hover(2);
    client.send(r#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":2}}"#);
    client.answer(&configuration);

    let response = client.response(2, false);
    let code = field(
        field(&response, "error").expect("the canceled hover is answered with an error"),
        "code",
    );
    assert_eq!(code, Some(&Value::Number(REQUEST_CANCELLED)));

    client.hover(3);
    let hover = client.response(3, false);
    assert!(
        field(&hover, "result").is_some_and(|result| *result != Value::Null),
        "later requests still run"
    );
}

#[test]
fn unanswered_registration_ends_at_its_deadline_and_later_requests_run() {
    if !crate::isolated::in_child(
        "single_threaded_test::unanswered_registration_ends_at_its_deadline_and_later_requests_run",
    ) {
        return;
    }
    let client = Client::start();
    client.initialize(r#"{"workspace":{"didChangeWatchedFiles":{"dynamicRegistration":true}}}"#);
    client.open_main();
    client.hover(2);
    let hover = client.response(2, true);
    assert!(field(&hover, "result").is_some_and(|result| *result != Value::Null));
}

#[test]
fn frame_split_across_a_deadline_keeps_deadlines_and_is_handled_when_complete() {
    if !crate::isolated::in_child(
        "single_threaded_test::frame_split_across_a_deadline_keeps_deadlines_and_is_handled_when_complete",
    ) {
        return;
    }
    let client = Client::start();
    client.initialize(r#"{"workspace":{"didChangeWatchedFiles":{"dynamicRegistration":true}}}"#);
    client.open_main();
    let first = client.watch_registration();
    let body = hover_body(2);
    client.write_raw(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let second = client.watch_registration();
    assert_ne!(
        field(&first, "id"),
        field(&second, "id"),
        "the first registration's deadline passed mid-frame"
    );
    client.write_raw(&body);
    let hover = client.response(2, true);
    assert!(
        field(&hover, "result").is_some_and(|result| *result != Value::Null),
        "the completed frame is handled"
    );
}

#[test]
fn exit_while_waiting_for_a_client_reply_returns_with_status_1() {
    if !crate::isolated::in_child(
        "single_threaded_test::exit_while_waiting_for_a_client_reply_returns_with_status_1",
    ) {
        return;
    }
    let client = Client::start();
    client.initialize(r#"{"workspace":{"configuration":true}}"#);
    client.request_from_server("workspace/configuration");
    client.send(r#"{"jsonrpc":"2.0","method":"exit"}"#);
    assert_eq!(client.exit_status(), 1);
}

#[test]
fn exit_without_shutdown_returns_status_1() {
    if !crate::isolated::in_child("single_threaded_test::exit_without_shutdown_returns_status_1") {
        return;
    }
    let client = Client::start();
    client.initialize("{}");
    client.send(r#"{"jsonrpc":"2.0","method":"exit"}"#);
    assert_eq!(client.exit_status(), 1);
}

#[test]
fn exit_after_shutdown_returns_status_0() {
    if !crate::isolated::in_child("single_threaded_test::exit_after_shutdown_returns_status_0") {
        return;
    }
    let client = Client::start();
    client.initialize("{}");
    client.send(r#"{"jsonrpc":"2.0","id":9,"method":"shutdown"}"#);
    client.response(9, false);
    client.send(r#"{"jsonrpc":"2.0","method":"exit"}"#);
    assert_eq!(client.exit_status(), 0);
}
