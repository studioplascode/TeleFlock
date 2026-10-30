//! omp's auto-retry of a provider error, as the board needs it: what the error is (rate limit,
//! usage limit, overload), when omp tries again, and whether a turn ended in an error.
//!
//! The wait starts with `auto_retry_start` and ends with `auto_retry_end`, with the delayed
//! continue (`agent_start` once the delay is over), with an abort, or with a replica rebuild. It is
//! not in the transcript (the replica's `Retrying (n/m) in Xs` notice is the row); this is the
//! state a card and the board's column mapping read.

use tf_proto::{Millis, RetryKind, RetryWait};

use super::util::clip;

/// Longest error text a [`RetryWait`] carries.
const ERROR_CLIP: usize = 240;
/// A wait still shown this long after its retry was due had no `auto_retry_end` or `agent_start`
/// to end it (a dropped feed): the card stops claiming omp is retrying.
pub const STALE_AFTER_MS: Millis = 120_000;
/// omp's delayed continue may reach the replica a little before the host clock reads `retry_at`.
const EARLY_MS: Millis = 1_500;

/// Words that name an exhausted account allowance, not a burst limit.
const USAGE_WORDS: [&str; 9] = [
    "usage limit",
    "usage_limit",
    "usagelimit",
    "insufficient_quota",
    "exceeded your current quota",
    "quota exceeded",
    "credit balance",
    "out of credits",
    "billing",
];
const OVERLOAD_WORDS: [&str; 6] = ["overloaded", "at capacity", "service unavailable", "server is busy", "temporarily unavailable", "high demand"];
const RATE_WORDS: [&str; 5] = ["rate limit", "rate_limit", "ratelimit", "too many requests", "throttl"];

/// Whether `text` holds the HTTP status `code` as a number of its own (`429 {`, `HTTP 429`,
/// `status=429`, not `14290`).
fn has_status(text: &str, code: &str) -> bool {
    text.match_indices(code).any(|(i, _)| {
        let before = text[..i].chars().next_back();
        let after = text[i + code.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_digit()) && !after.is_some_and(|c| c.is_ascii_digit())
    })
}

/// What omp's provider error is, by its text (omp's `errorMessage`; it leads with the HTTP status
/// when it has one).
pub fn classify(error: &str) -> RetryKind {
    let e = error.to_ascii_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| e.contains(w));
    if any(&USAGE_WORDS) {
        RetryKind::UsageLimit
    } else if any(&OVERLOAD_WORDS) || has_status(&e, "529") || has_status(&e, "503") {
        RetryKind::Overloaded
    } else if any(&RATE_WORDS) || has_status(&e, "429") {
        RetryKind::RateLimit
    } else {
        RetryKind::Other
    }
}

/// The wait `auto_retry_start` opens at host time `now`.
pub(crate) fn wait(now: Millis, attempt: u32, max_attempts: u32, delay_ms: f64, error: &str) -> RetryWait {
    let delay = if delay_ms.is_finite() && delay_ms > 0.0 { delay_ms.round() as Millis } else { 0 };
    RetryWait {
        kind: classify(error),
        attempt,
        max_attempts,
        since: now,
        retry_at: now.saturating_add(delay),
        error: clip(error, ERROR_CLIP),
    }
}

/// omp's delayed continue (`agent_start`) reached the replica: the wait is over once it was due.
pub(crate) fn over_at_agent_start(wait: &RetryWait, now: Millis) -> bool {
    now + EARLY_MS >= wait.retry_at
}

/// The wait while it still holds: not older than [`STALE_AFTER_MS`] past its due time.
pub(crate) fn current(wait: &RetryWait, now: Millis) -> bool {
    now <= wait.retry_at.saturating_add(STALE_AFTER_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_what_omp_reports() {
        let cases = [
            (
                r#"429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}} retry-after-ms=324000"#,
                RetryKind::RateLimit,
            ),
            ("Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)", RetryKind::Overloaded),
            ("529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", RetryKind::Overloaded),
            ("503 Service Unavailable", RetryKind::Overloaded),
            ("You have hit your usage limit. Try again at 3:00 AM", RetryKind::UsageLimit),
            ("429 insufficient_quota: You exceeded your current quota", RetryKind::UsageLimit),
            ("Your credit balance is too low to access the API", RetryKind::UsageLimit),
            ("Too Many Requests", RetryKind::RateLimit),
            ("fetch failed: ECONNRESET", RetryKind::Other),
            ("500 internal error (request 14290)", RetryKind::Other),
            ("", RetryKind::Other),
        ];
        for (text, kind) in cases {
            assert_eq!(classify(text), kind, "{text}");
        }
    }

    #[test]
    fn a_wait_is_due_after_omps_delay() {
        let w = wait(10_000, 1, 10, 294_000.4, "429 rate limit");
        assert_eq!((w.since, w.retry_at, w.attempt, w.max_attempts), (10_000, 304_000, 1, 10));
        let w = wait(10_000, 0, 0, f64::NAN, "x");
        assert_eq!(w.retry_at, 10_000);
        assert!(current(&w, 10_000 + STALE_AFTER_MS));
        assert!(!current(&w, 10_001 + STALE_AFTER_MS));
    }

    #[test]
    fn the_delayed_continue_ends_the_wait_only_once_due() {
        let w = wait(0, 1, 10, 5_000.0, "429");
        assert!(!over_at_agent_start(&w, 1_000), "a background turn mid-wait leaves it");
        assert!(over_at_agent_start(&w, 3_600));
        assert!(over_at_agent_start(&w, 6_000));
    }
}
