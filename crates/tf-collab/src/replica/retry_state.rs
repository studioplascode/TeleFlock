//! omp's provider-error retry as the replica reports it to the board: the wait while omp sleeps
//! before its next attempt (`Replica::retry_wait`) and how the last run ended (`Replica::tail_error`).

use serde_json::{json, Value};
use tf_proto::{Millis, RetryKind};

use super::retry::STALE_AFTER_MS;
use super::Replica;
use crate::guest::GuestEvent;

const T0: Millis = 1_793_300_000_000;
const RATE: &str = r#"429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit."}} retry-after-ms=324000"#;

fn ev(r: &mut Replica, at: Millis, event: Value) {
    r.apply(&GuestEvent::Frame(crate::frame::HostFrame::Event { event }), at);
}

fn failed(t: Millis, error: &str) -> Value {
    json!({ "role": "assistant", "content": [], "stopReason": "error", "errorMessage": error, "errorStatus": 429, "model": "claude-opus-5", "timestamp": t })
}

fn start(r: &mut Replica, at: Millis, attempt: u32, delay_ms: u64, error: &str) {
    ev(r, at, json!({ "type": "auto_retry_start", "attempt": attempt, "maxAttempts": 10, "delayMs": delay_ms, "errorMessage": error }));
}

#[test]
fn a_retry_wait_runs_from_auto_retry_start_to_its_end() {
    let mut r = Replica::new("a");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    assert_eq!(r.retry_wait(T0), None);
    start(&mut r, T0 + 1_000, 1, 294_000, RATE);
    let w = r.retry_wait(T0 + 2_000).expect("waiting");
    assert_eq!((w.kind, w.attempt, w.max_attempts, w.since, w.retry_at), (RetryKind::RateLimit, 1, 10, T0 + 1_000, T0 + 295_000));
    assert!(w.error.starts_with("429 {"), "{}", w.error);
    // A later attempt of the same streak replaces it.
    start(&mut r, T0 + 296_000, 2, 120_000, "Codex is at capacity, try later");
    let w = r.retry_wait(T0 + 296_500).unwrap();
    assert_eq!((w.kind, w.attempt, w.retry_at), (RetryKind::Overloaded, 2, T0 + 416_000));
    ev(&mut r, T0 + 300_000, json!({ "type": "auto_retry_end", "success": false, "attempt": 2, "finalError": RATE }));
    assert_eq!(r.retry_wait(T0 + 300_001), None);
}

#[test]
fn the_delayed_continue_ends_the_wait_but_a_background_turn_mid_wait_does_not() {
    let mut r = Replica::new("a");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    start(&mut r, T0, 1, 60_000, RATE);
    // omp delivered a background job result: its own run starts and stops long before the retry is due.
    ev(&mut r, T0 + 10_000, json!({ "type": "agent_start" }));
    assert!(r.retry_wait(T0 + 10_001).is_some(), "still waiting for the provider");
    ev(&mut r, T0 + 60_100, json!({ "type": "agent_start" }));
    assert_eq!(r.retry_wait(T0 + 60_101), None, "the retry attempt started");
}

#[test]
fn a_new_run_or_an_abort_ends_the_wait() {
    let mut r = Replica::new("a");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    start(&mut r, T0, 1, 60_000, RATE);
    let aborted = json!({ "role": "assistant", "content": [], "stopReason": "aborted", "timestamp": T0 + 5 });
    ev(&mut r, T0 + 1_000, json!({ "type": "message_start", "message": aborted }));
    ev(&mut r, T0 + 1_001, json!({ "type": "message_end", "message": aborted }));
    ev(&mut r, T0 + 1_002, json!({ "type": "agent_end" }));
    assert_eq!(r.retry_wait(T0 + 1_003), None, "abort");

    // A wait left over while no run is active (agent_end without retry_end) goes with the next run.
    let mut r = Replica::new("b");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    start(&mut r, T0, 1, 60_000, RATE);
    ev(&mut r, T0 + 1_000, json!({ "type": "agent_end" }));
    assert!(r.retry_wait(T0 + 1_001).is_some());
    ev(&mut r, T0 + 2_000, json!({ "type": "agent_start" }));
    assert_eq!(r.retry_wait(T0 + 2_001), None, "new run");
}

#[test]
fn a_wait_nobody_ended_stops_being_claimed() {
    let mut r = Replica::new("a");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    start(&mut r, T0, 1, 10_000, RATE);
    assert!(r.retry_wait(T0 + 10_000 + STALE_AFTER_MS).is_some());
    assert_eq!(r.retry_wait(T0 + 10_001 + STALE_AFTER_MS), None);
}

#[test]
fn a_run_that_ended_in_a_provider_error_is_the_tail_until_the_next_run() {
    let mut r = Replica::new("a");
    ev(&mut r, T0, json!({ "type": "agent_start" }));
    assert_eq!(r.tail_error(), None);
    let bad = failed(T0 + 10, RATE);
    ev(&mut r, T0 + 20, json!({ "type": "message_start", "message": bad }));
    ev(&mut r, T0 + 30, json!({ "type": "message_end", "message": bad }));
    assert_eq!(r.tail_error(), None, "still running");
    ev(&mut r, T0 + 40, json!({ "type": "agent_end" }));
    assert_eq!(r.tail_error(), Some(RATE));
    ev(&mut r, T0 + 50, json!({ "type": "agent_start" }));
    assert_eq!(r.tail_error(), None, "a new run starts");

    // A run that answered is no failure.
    let ok = json!({ "role": "assistant", "content": [{ "type": "text", "text": "done" }], "stopReason": "stop", "timestamp": T0 + 60 });
    ev(&mut r, T0 + 60, json!({ "type": "message_start", "message": ok }));
    ev(&mut r, T0 + 70, json!({ "type": "message_end", "message": ok }));
    ev(&mut r, T0 + 80, json!({ "type": "agent_end" }));
    assert_eq!(r.tail_error(), None);
}
