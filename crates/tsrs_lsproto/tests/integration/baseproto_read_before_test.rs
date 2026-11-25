// `read_before`: the deadline-aware read of the single-threaded language server. Same frames and errors as `read`,
// and a frame split across a pause (`wait` returning false) is kept and finished later.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::io::Read;
use std::rc::Rc;

use tsrs_lsproto::new_base_reader;

// A source that hands out one byte per read; 0 bytes once empty (end of input).
#[derive(Clone, Default)]
struct Drip(Rc<RefCell<VecDeque<u8>>>);

impl Drip {
    fn push(&self, bytes: &[u8]) {
        self.0.borrow_mut().extend(bytes);
    }

    fn is_empty(&self) -> bool {
        self.0.borrow().is_empty()
    }
}

impl Read for Drip {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let Some(byte) = self.0.borrow_mut().pop_front() else {
            return Ok(0);
        };
        out[0] = byte;
        Ok(1)
    }
}

type Outcome = Result<Vec<u8>, String>;

// Every frame `read` returns from `input`, up to and including the first error.
fn with_read(input: &[u8]) -> Vec<Outcome> {
    let mut reader = new_base_reader(input);
    let mut out = Vec::new();
    loop {
        let result = reader.read().map_err(|err| err.to_string());
        let done = result.is_err();
        out.push(result);
        if done {
            return out;
        }
    }
}

// The same with `read_before`, one byte at a time, with a "not yet" before every other byte.
fn with_read_before(input: &[u8]) -> Vec<Outcome> {
    let source = Drip::default();
    source.push(input);
    let mut reader = new_base_reader(source);
    let mut ready = false;
    let mut wait = move || {
        ready = !ready;
        ready
    };
    let mut out = Vec::new();
    loop {
        let Some(result) = reader.read_before(&mut wait) else {
            continue;
        };
        let result = result.map_err(|err| err.to_string());
        let done = result.is_err();
        out.push(result);
        if done {
            return out;
        }
    }
}

#[test]
fn read_before_matches_read_frame_for_frame_and_error_for_error() {
    let inputs: [&[u8]; 10] = [
        b"Content-Length: 0\r\n\r\n",
        b"oops",
        b"Content-Length: -1\r\n\r\n",
        b"Content-Length: 1\r\n\r\n{",
        b"Content-Length: 2\r\n\r\n{}",
        b"Content-Length: 2\r\nExtra: 1\r\n\r\n{}",
        b"Content-Length: 100\r\n\r\n{}",
        b"Content-Length: \r\n\r\n{}",
        b"Nope\r\n\r\n{}",
        b"Content-Length: 2\r\n\r\n{}Content-Length: 4\r\n\r\nnull",
    ];
    for input in inputs {
        assert_eq!(
            with_read_before(input),
            with_read(input),
            "{:?}",
            String::from_utf8_lossy(input)
        );
    }
}

#[test]
fn read_before_keeps_a_frame_split_across_a_pause() {
    let source = Drip::default();
    let mut reader = new_base_reader(source.clone());
    let pending = source.clone();
    let mut wait = move || !pending.is_empty();

    source.push(b"Content-Length: 4\r\n\r\n");
    assert!(reader.read_before(&mut wait).is_none(), "the header alone is not a frame");
    assert!(reader.read_before(&mut wait).is_none(), "still waiting for the body");
    source.push(b"nu");
    assert!(reader.read_before(&mut wait).is_none(), "half the body");
    source.push(b"llContent-Length: 2\r\n\r\n{}");
    assert_eq!(reader.read_before(&mut wait).unwrap().unwrap(), b"null");
    assert_eq!(reader.read_before(&mut wait).unwrap().unwrap(), b"{}");
}
