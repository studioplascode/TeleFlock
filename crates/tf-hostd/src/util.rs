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

/// What a folder holds, by the first entry listing it gives.
#[derive(Debug)]
pub(crate) enum Occupancy {
    Filled,
    Empty,
    /// Reading an entry failed (an I/O error while listing): it says nothing either way.
    Unreadable(std::io::Error),
}

/// [`Occupancy`] of a folder's entries (`std::fs::read_dir`): filled only by an entry that was read.
pub(crate) fn occupancy<T>(mut entries: impl Iterator<Item = std::io::Result<T>>) -> Occupancy {
    match entries.next() {
        Some(Ok(_)) => Occupancy::Filled,
        Some(Err(e)) => Occupancy::Unreadable(e),
        None => Occupancy::Empty,
    }
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

    #[test]
    fn only_an_entry_that_was_read_fills_a_folder() {
        assert!(matches!(occupancy([Ok::<(), std::io::Error>(())].into_iter()), Occupancy::Filled));
        assert!(matches!(occupancy(std::iter::empty::<std::io::Result<()>>()), Occupancy::Empty));
        let failed = occupancy([Err::<(), _>(std::io::Error::other("disk read failed"))].into_iter());
        assert!(matches!(&failed, Occupancy::Unreadable(e) if e.to_string() == "disk read failed"), "{failed:?}");
    }
}
