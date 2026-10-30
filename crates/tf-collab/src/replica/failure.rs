//! How an assistant message ended, as TeleFlock shows it: omp's stop reason, the error worth
//! showing (omp's own rules, pi-tui `resolveAssistantErrorPresentation`), the provider's HTTP
//! status and a provider refusal; and which failed attempts omp's auto-retry superseded.

use std::collections::HashSet;

use serde_json::Value;
use tf_proto::{Millis, Refusal};

use super::util::{arr, clip, non_empty, s, ts, u};

/// omp's `errorMessage` of an abort that carried no reason of its own (`GENERIC_ABORT_SENTINEL`).
const GENERIC_ABORT: &str = "Request was aborted";
/// omp's `USER_INTERRUPT_LABEL`: Esc in the TUI, and TeleFlock's stop (`ctx.abort()`).
const USER_INTERRUPT: &str = "Interrupted by user";
/// omp's `SILENT_ABORT_MARKER`: an expected internal transition, never shown.
const SILENT_ABORT: &str = "__omp.silent_abort__";
/// `errorId` flags (pi-ai `AIError.Flag`) of aborts that explain nothing: `SilentAbort`,
/// `UserInterrupt`, `Abort` (a bare `abort()`).
const QUIET_ABORT: u64 = 0x0200_0000 | 0x0400_0000 | 0x0800_0000;
/// Longest error text or refusal explanation a row carries.
pub(crate) const ERROR_CAP: usize = 4000;

/// The end of an assistant message (`message_end`, or its session entry).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Ending {
    pub stop: Option<String>,
    /// What to show as its error: omp's `errorMessage` of a failed request (`provider error` when it
    /// gave none), or a reason another stop carries, unless it is a user interrupt or an abort that
    /// gave no reason (omp shows neither). `Some`: the message failed.
    pub error: Option<String>,
    /// The HTTP status the provider answered with (omp `errorStatus`), of a failed message.
    pub status: Option<u16>,
    /// The provider refused the request (omp `stopDetails` `refusal` / `sensitive`), without the
    /// fallback credit omp keeps for itself.
    pub refusal: Option<Refusal>,
}

impl Ending {
    pub(crate) fn of(msg: &Value) -> Ending {
        let stop = s(msg, "stopReason").map(str::to_owned);
        let errored = stop.as_deref() == Some("error");
        let quiet = |m: &str| matches!(m.trim(), USER_INTERRUPT | SILENT_ABORT | GENERIC_ABORT) || u(msg, "errorId").is_some_and(|id| id & QUIET_ABORT != 0);
        let error = match non_empty(msg, "errorMessage") {
            Some(m) if errored || !quiet(m) => Some(cap(m, ERROR_CAP)),
            _ if errored => Some("provider error".to_owned()),
            _ => None,
        };
        let status = u(msg, "errorStatus").filter(|s| (100..=599).contains(s) && error.is_some()).map(|s| s as u16);
        let refusal = msg.get("stopDetails").filter(|_| errored).and_then(|d| {
            let kind = s(d, "type").filter(|k| matches!(*k, "refusal" | "sensitive"))?;
            Some(Refusal {
                kind: kind.to_owned(),
                category: non_empty(d, "category").map(|c| clip(c, 64)),
                explanation: non_empty(d, "explanation").map(|e| clip(e, ERROR_CAP)),
            })
        });
        Ending { stop, error, status, refusal }
    }

    pub(crate) fn failed(&self) -> bool {
        self.error.is_some()
    }
}

/// `text` as is, or cut to `max` chars (with `…`) when longer.
pub(crate) fn cap(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_owned() } else { clip(text, max) }
}

/// A text block a row shows: one with more than whitespace.
pub(crate) fn visible_text(block: &Value) -> bool {
    s(block, "type") == Some("text") && s(block, "text").is_some_and(|t| !t.trim().is_empty())
}

/// The row of a message that failed without any text to carry its error.
pub(crate) fn error_row_id(t: Millis) -> String {
    format!("a{t}.e")
}

/// The assistant message of a session entry that failed without any text.
fn failed_without_text(entry: &Value) -> Option<&Value> {
    let msg = entry.get("message").filter(|_| s(entry, "type") == Some("message"))?;
    (s(msg, "role") == Some("assistant") && Ending::of(msg).failed() && !arr(msg, "content").iter().any(visible_text)).then_some(msg)
}

/// The message builds rows besides its error row (thinking, tool calls).
fn builds_rows(msg: &Value) -> bool {
    arr(msg, "content").iter().any(|b| match s(b, "type") {
        Some("thinking" | "redactedThinking") => true,
        Some("toolCall") => non_empty(b, "id").is_some(),
        _ => false,
    })
}

/// Failed attempts omp's auto-retry superseded. omp keeps them in the session file (omp ≥ 18.13
/// stamps `retryRecovery` on them once the retry settled); live, the replica drops their error row
/// when the retry starts, so a rebuild must not show it either: a message that failed without text,
/// stamped `retryRecovery`, or followed by another assistant message before the next prompt.
/// Returns the entries to replay (without the attempts that build no other row) and the timestamps
/// of the superseded attempts, whose error rows stay away.
pub(crate) fn retried_attempts(entries: &[Value]) -> (Vec<&Value>, HashSet<Millis>) {
    let mut retried = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        if let Some(msg) = failed_without_text(entry) {
            let superseded = msg.get("retryRecovery").is_some_and(|r| !r.is_null())
                || entries[i + 1..]
                    .iter()
                    .take_while(|n| {
                        let role = n.get("message").and_then(|m| s(m, "role"));
                        s(n, "type") != Some("custom_message") && !matches!(role, Some("user" | "developer"))
                    })
                    .any(|n| n.get("message").and_then(|m| s(m, "role")) == Some("assistant"));
            if superseded {
                if let Some(t) = ts(msg) {
                    retried.insert(t);
                }
                if !builds_rows(msg) {
                    continue;
                }
            }
        }
        out.push(entry);
    }
    (out, retried)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn errors_show_as_omp_shows_them() {
        let e = Ending::of(&json!({ "stopReason": "error", "errorMessage": "529 overloaded", "errorStatus": 529 }));
        assert_eq!((e.error.as_deref(), e.status, e.refusal), (Some("529 overloaded"), Some(529), None));
        // No message: still a failure.
        assert_eq!(Ending::of(&json!({ "stopReason": "error" })).error.as_deref(), Some("provider error"));
        // User interrupts and reasonless aborts are no error; an abort's own reason is.
        for quiet in [json!({ "stopReason": "aborted", "errorMessage": "Interrupted by user" }),
            json!({ "stopReason": "aborted", "errorMessage": "Request was aborted" }),
            json!({ "stopReason": "aborted", "errorMessage": "__omp.silent_abort__" }),
            json!({ "stopReason": "aborted", "errorMessage": "cancelled", "errorId": 0x0400_1000 }),
            json!({ "stopReason": "aborted" }),
            json!({ "stopReason": "stop" })]
        {
            assert!(!Ending::of(&quiet).failed(), "{quiet}");
        }
        let stall = Ending::of(&json!({ "stopReason": "aborted", "errorMessage": "Stream stalled for 120s", "errorStatus": 200 }));
        assert_eq!(stall.error.as_deref(), Some("Stream stalled for 120s"));
        // A status that is no HTTP status is dropped.
        assert_eq!(Ending::of(&json!({ "stopReason": "error", "errorStatus": 7 })).status, None);
    }

    #[test]
    fn refusals_keep_category_and_explanation_but_not_the_credit() {
        let msg = json!({ "stopReason": "error", "errorMessage": "Refusal (cyber): Exploit development",
            "stopDetails": { "type": "refusal", "category": "cyber", "explanation": "Exploit development", "fallback_credit_token": "tok" },
            "fallbackCreditHandle": { "token": "tok" } });
        let e = Ending::of(&msg);
        assert_eq!(e.refusal, Some(Refusal { kind: "refusal".into(), category: Some("cyber".into()), explanation: Some("Exploit development".into()) }));
        assert!(!format!("{e:?}").contains("tok"));
        let sensitive = Ending::of(&json!({ "stopReason": "error", "errorMessage": "Content flagged by safety filters", "stopDetails": { "type": "sensitive" } }));
        assert_eq!(sensitive.refusal.map(|r| r.kind).as_deref(), Some("sensitive"));
        // Other stop details (compaction, a raw reason) are no refusal.
        assert_eq!(Ending::of(&json!({ "stopReason": "error", "stopDetails": { "type": "overloaded" } })).refusal, None);
    }

    #[test]
    fn superseded_attempts_are_found_in_every_shape() {
        let failed = |t: i64, content: Value| json!({ "type": "message", "message": { "role": "assistant", "content": content, "stopReason": "error", "errorMessage": "overloaded", "timestamp": t } });
        let ok = |t: i64| json!({ "type": "message", "message": { "role": "assistant", "content": [{ "type": "text", "text": "done" }], "stopReason": "stop", "timestamp": t } });
        let user = |t: i64| json!({ "type": "message", "message": { "role": "user", "content": "go", "timestamp": t } });
        let entries = vec![
            user(1),
            failed(2, json!([])),
            failed(3, json!([{ "type": "text", "text": "" }])),
            failed(4, json!([{ "type": "thinking", "thinking": "hm" }])),
            ok(5),
            user(6),
            // Terminal: nothing superseded it before the next prompt.
            failed(7, json!([{ "type": "text", "text": " " }])),
            user(8),
            // Stamped by omp after the retry settled, even if nothing follows in this slice.
            json!({ "type": "message", "message": { "role": "assistant", "content": [], "stopReason": "error", "errorMessage": "x", "timestamp": 9, "retryRecovery": { "status": "recovered" } } }),
        ];
        let (kept, retried) = retried_attempts(&entries);
        assert_eq!(retried, HashSet::from([2, 3, 4, 9]));
        let times: Vec<i64> = kept.iter().filter_map(|e| e.get("message").and_then(ts)).collect();
        // Error-only attempts leave; the one with thinking stays for its thinking row.
        assert_eq!(times, vec![1, 4, 5, 6, 7, 8]);
    }
}
