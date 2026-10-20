//! Small shared helpers.

use tf_proto::Millis;

/// Epoch milliseconds now.
pub fn now_ms() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

/// Host-local calendar day (`YYYY-MM-DD`) of an epoch-ms timestamp.
pub fn local_day(at: Millis) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(at) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.format("%Y-%m-%d").to_string(),
        chrono::LocalResult::None => String::new(),
    }
}

/// Truncates to at most `max` chars (on a char boundary), appending `…` when cut.
pub fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Short random-ish id (time + counter), unique within the process.
pub fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}{:x}{:04x}", now_ms(), n & 0xffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_counts_chars() {
        assert_eq!(clip("  hello  ", 10), "hello");
        assert_eq!(clip("héllo wörld", 6), "héllo…");
    }

    #[test]
    fn ids_unique() {
        assert_ne!(new_id("n"), new_id("n"));
    }
}
