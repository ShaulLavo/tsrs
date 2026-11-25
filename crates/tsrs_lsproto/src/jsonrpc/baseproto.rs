use std::io::{BufRead, BufReader, BufWriter, Read, Write};

use crate::error::{Error, ErrorTag};
use crate::lsp::go_quote;

// Base protocol for JSON-RPC with Content-Length headers (as used by LSP).
// https://microsoft.github.io/language-server-protocol/specifications/base/0.9/specification/

// baseproto.go:15
const ERR_INVALID_HEADER: &str = "jsonrpc: invalid header";
const ERR_INVALID_CONTENT_LENGTH: &str = "jsonrpc: invalid content length";
const ERR_NO_CONTENT_LENGTH: &str = "jsonrpc: no content length";

// baseproto.go:22
// Reader reads JSON-RPC messages with Content-Length framing.
pub struct Reader<R: Read> {
    r: BufReader<R>,
    // tsrs-only: the frame `read_before` has read so far.
    partial: PartialFrame,
}

// baseproto.go:27
// NewReader creates a new Reader.
pub(crate) fn new_reader<R: Read>(r: R) -> Reader<R> {
    Reader { r: BufReader::with_capacity(4096, r), partial: PartialFrame::default() }
}

fn io_error(err: &std::io::Error) -> Error {
    if err.kind() == std::io::ErrorKind::UnexpectedEof {
        return Error::tagged(ErrorTag::UnexpectedEOF, "unexpected EOF");
    }
    Error::new(err.to_string())
}

// Go strconv.ParseInt(s, 10, 64).
fn parse_int(s: &str) -> Result<i64, String> {
    tsrs_core::gocompat::parse_int64(s.as_bytes(), tsrs_core::gocompat::QuoteStyle::Lsp)
}

// Go bytes.TrimSpace: trims Unicode white space (including '\v', U+0085 and U+00A0 as UTF-8, which `trim_ascii`
// keeps); an invalid UTF-8 byte decodes as RuneError and stops the trim.
fn trim_space(mut s: &[u8]) -> &[u8] {
    let is_space = |r: u32| char::from_u32(r).is_some_and(char::is_whitespace);
    loop {
        let (r, size) = tsrs_core::stringutil::decode_rune(s);
        if size == 0 || !is_space(r) {
            break;
        }
        s = &s[size..];
    }
    loop {
        let (r, size) = tsrs_core::stringutil::decode_last_rune(s);
        if size == 0 || !is_space(r) {
            break;
        }
        s = &s[..s.len() - size];
    }
    s
}

// One header line of `read`, with its line ending: true for the blank line that ends the headers. A
// `Content-Length` header sets `content_length`.
fn header_line(line: &[u8], content_length: &mut i64) -> Result<bool, Error> {
    if line == b"\r\n" {
        return Ok(true);
    }

    let Some(colon) = line.iter().position(|&b| b == b':') else {
        return Err(Error::tagged(
            ErrorTag::InvalidHeader,
            format!("{}: {}", ERR_INVALID_HEADER, go_quote(line)),
        ));
    };
    let (key, value) = (&line[..colon], &line[colon + 1..]);

    if key == b"Content-Length" {
        let value = tsrs_core::utf8::from_utf8_lossy(trim_space(value)).into_owned();
        *content_length = match parse_int(&value) {
            Ok(n) => n,
            Err(err) => {
                return Err(Error::tagged(
                    ErrorTag::InvalidContentLength,
                    format!("{ERR_INVALID_CONTENT_LENGTH}: parse error: {err}"),
                ));
            }
        };
        if *content_length < 0 {
            return Err(Error::tagged(
                ErrorTag::InvalidContentLength,
                format!("{ERR_INVALID_CONTENT_LENGTH}: negative value {content_length}"),
            ));
        }
    }
    Ok(false)
}

impl<R: Read> Reader<R> {
    // baseproto.go:34
    // Read reads the next message payload.
    pub fn read(&mut self) -> Result<Vec<u8>, Error> {
        let mut content_length: i64 = 0;

        loop {
            let mut line = Vec::new();
            match self.r.read_until(b'\n', &mut line) {
                Ok(_) if line.last() == Some(&b'\n') => {}
                Ok(_) => return Err(Error::tagged(ErrorTag::EOF, "EOF")),
                Err(err) => return Err(Error::wrap("jsonrpc: read header: ", io_error(&err))),
            }

            if header_line(&line, &mut content_length)? {
                break;
            }
        }

        if content_length <= 0 {
            return Err(Error::tagged(ErrorTag::NoContentLength, ERR_NO_CONTENT_LENGTH));
        }

        // io.ReadFull: EOF before any byte, ErrUnexpectedEOF after some.
        let mut data = vec![0u8; content_length as usize];
        let mut filled = 0;
        while filled < data.len() {
            match self.r.read(&mut data[filled..]) {
                Ok(0) => {
                    let err = if filled == 0 {
                        Error::tagged(ErrorTag::EOF, "EOF")
                    } else {
                        Error::tagged(ErrorTag::UnexpectedEOF, "unexpected EOF")
                    };
                    return Err(Error::wrap("jsonrpc: read content: ", err));
                }
                Ok(n) => filled += n,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(err) => return Err(Error::wrap("jsonrpc: read content: ", io_error(&err))),
            }
        }

        Ok(data)
    }
}

// baseproto.go:79
// Writer writes JSON-RPC messages with Content-Length framing.
pub struct Writer<W: Write> {
    w: BufWriter<W>,
}

// baseproto.go:84
// NewWriter creates a new Writer.
pub(crate) fn new_writer<W: Write>(w: W) -> Writer<W> {
    Writer { w: BufWriter::with_capacity(4096, w) }
}

impl<W: Write> Writer<W> {
    // baseproto.go:91
    // Write writes a message payload with Content-Length header.
    pub fn write(&mut self, data: &[u8]) -> Result<(), Error> {
        write!(self.w, "Content-Length: {}\r\n\r\n", data.len()).map_err(|err| io_error(&err))?;
        self.w.write_all(data).map_err(|err| io_error(&err))?;
        self.w.flush().map_err(|err| io_error(&err))
    }
}

// tsrs-only: a frame `read_before` has started. `body` is Some once the headers are complete.
#[derive(Default)]
struct PartialFrame {
    line: Vec<u8>,
    content_length: i64,
    body: Option<Vec<u8>>,
}

impl<R: Read> Reader<R> {
    /// tsrs-only: `read` that never waits for the source past a deadline, for a single-threaded caller.
    ///
    /// Before each read from the source that would have to wait (nothing buffered), it calls `wait`, which returns
    /// whether input (or the end of input) is there. When `wait` returns false it returns None and keeps what it has
    /// read of the frame; a later call continues that frame. Otherwise it returns what `read` would: the payload or
    /// the same error. Do not mix it with `read` while a frame is partly read.
    pub fn read_before(
        &mut self,
        wait: &mut dyn FnMut() -> bool,
    ) -> Option<Result<Vec<u8>, Error>> {
        loop {
            if self.r.buffer().is_empty() && !wait() {
                return None;
            }
            if let Some(result) = self.read_buffered() {
                self.partial = PartialFrame::default();
                return Some(result);
            }
        }
    }

    // Moves buffered bytes (reading the source once if nothing is buffered) into the partial frame. Some when the
    // frame is complete or failed.
    fn read_buffered(&mut self) -> Option<Result<Vec<u8>, Error>> {
        let in_body = self.partial.body.is_some();
        let context = if in_body { "jsonrpc: read content: " } else { "jsonrpc: read header: " };
        let buf = match self.r.fill_buf() {
            Ok(buf) => buf,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => return None,
            Err(err) => return Some(Err(Error::wrap(context, io_error(&err)))),
        };
        if buf.is_empty() {
            return Some(Err(self.partial.end_of_input()));
        }
        let Some(body) = &mut self.partial.body else {
            let newline = buf.iter().position(|&b| b == b'\n');
            let (taken, line_done) = newline.map_or((buf.len(), false), |i| (i + 1, true));
            self.partial.line.extend_from_slice(&buf[..taken]);
            self.r.consume(taken);
            return if line_done { self.partial.header_done() } else { None };
        };
        let want = usize::try_from(self.partial.content_length).unwrap_or(0) - body.len();
        let taken = want.min(buf.len());
        body.extend_from_slice(&buf[..taken]);
        self.r.consume(taken);
        (taken == want).then(|| Ok(std::mem::take(body)))
    }
}

impl PartialFrame {
    // A header line is complete (`read`'s header loop). Some for a failure; the blank line starts the body.
    fn header_done(&mut self) -> Option<Result<Vec<u8>, Error>> {
        let line = std::mem::take(&mut self.line);
        match header_line(&line, &mut self.content_length) {
            Err(err) => Some(Err(err)),
            Ok(false) => None,
            Ok(true) if self.content_length <= 0 => {
                Some(Err(Error::tagged(ErrorTag::NoContentLength, ERR_NO_CONTENT_LENGTH)))
            }
            Ok(true) => {
                self.body = Some(Vec::with_capacity(self.content_length as usize));
                None
            }
        }
    }

    // The source ended: `read`'s EOF (headers) or io.ReadFull's EOF / unexpected EOF (body).
    fn end_of_input(&self) -> Error {
        let Some(body) = &self.body else {
            return Error::tagged(ErrorTag::EOF, "EOF");
        };
        let err = if body.is_empty() {
            Error::tagged(ErrorTag::EOF, "EOF")
        } else {
            Error::tagged(ErrorTag::UnexpectedEOF, "unexpected EOF")
        };
        Error::wrap("jsonrpc: read content: ", err)
    }
}
