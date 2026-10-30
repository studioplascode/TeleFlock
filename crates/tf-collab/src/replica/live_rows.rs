//! Rows only seen live: what the replica showed of a session that omp's session file never gets,
//! warning and error notices and turn errors omp does not persist (provider refusals). The replica
//! keeps each with the row it followed and puts it back there when it rebuilds the transcript from
//! the file (a resync); tf-hostd persists them ([`super::Signal::RowKept`]) and hands them back
//! after a restart ([`super::Replica::keep_rows`]).

use std::collections::{HashMap, HashSet};

use tf_proto::{Millis, NoticeLevel, TranscriptItem};

/// Live rows a replica keeps per session (the oldest go first).
pub const MAX_LIVE_ROWS: usize = 500;

/// A row only seen live, and where it was.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRow {
    /// The row it followed when it was built; `None`: it was the first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    pub item: TranscriptItem,
}

/// Notices worth keeping: warnings and errors about the session (not about TeleFlock's own collab
/// link, nor retry progress, which omp settles itself).
pub(crate) fn keeps_notice(level: NoticeLevel, source: Option<&str>) -> bool {
    level != NoticeLevel::Info && !matches!(source, Some("collab" | "retry"))
}

pub(crate) fn at(item: &TranscriptItem) -> Millis {
    match item {
        TranscriptItem::User(i) => i.at,
        TranscriptItem::Assistant(i) => i.at,
        TranscriptItem::Thinking(i) => i.at,
        TranscriptItem::Tool(i) => i.at,
        TranscriptItem::Notice(i) => i.at,
        TranscriptItem::Compaction(i) => i.at,
        TranscriptItem::Mode(i) => i.at,
        TranscriptItem::Irc(i) => i.at,
    }
}

/// Puts `rows` (oldest first) into a transcript rebuilt from the session file: each right after the
/// row it followed (behind the live rows put back there before it); when that row is gone (one the
/// file never got) before the first newer row. A row the file has (same id) stays as the file has it.
pub(crate) fn restore(order: &mut Vec<String>, items: &mut HashMap<String, TranscriptItem>, rows: &[LiveRow]) {
    let mut restored: HashSet<&str> = HashSet::new();
    for row in rows {
        let id = row.item.id();
        if items.contains_key(id) {
            continue;
        }
        let behind = |mut i: usize| {
            while order.get(i).is_some_and(|x| restored.contains(x.as_str())) {
                i += 1;
            }
            i
        };
        let pos = match &row.after {
            None => behind(0),
            Some(anchor) => match order.iter().position(|x| x == anchor) {
                Some(i) => behind(i + 1),
                None => {
                    let t = at(&row.item);
                    order.iter().position(|x| items.get(x).is_some_and(|it| at(it) > t)).unwrap_or(order.len())
                }
            },
        };
        order.insert(pos, id.to_owned());
        items.insert(id.to_owned(), row.item.clone());
        restored.insert(id);
    }
}

#[cfg(test)]
mod tests {
    use tf_proto::{ModeItem, NoticeItem};

    use super::*;

    fn mode(id: &str, at: Millis) -> TranscriptItem {
        TranscriptItem::Mode(ModeItem { id: id.into(), at, text: id.into() })
    }

    fn notice(id: &str, at: Millis) -> TranscriptItem {
        TranscriptItem::Notice(NoticeItem { id: id.into(), at, level: NoticeLevel::Warn, text: id.into(), source: None })
    }

    fn row(after: Option<&str>, item: TranscriptItem) -> LiveRow {
        LiveRow { after: after.map(str::to_owned), item }
    }

    #[test]
    fn rows_go_back_where_they_were() {
        let mut order: Vec<String> = ["f1", "f2", "f3"].map(String::from).to_vec();
        let mut items: HashMap<String, TranscriptItem> = [mode("f1", 10), mode("f2", 20), mode("f3", 30)].into_iter().map(|i| (i.id().to_owned(), i)).collect();
        let rows = [
            row(None, notice("n0", 5)),
            row(Some("f1"), notice("n1", 11)),
            // Two rows after the same one keep their order; a row after a live row follows it.
            row(Some("f1"), notice("n2", 12)),
            row(Some("n2"), notice("n3", 13)),
            // Its row is gone (the file never got it): by time.
            row(Some("gone"), notice("n4", 25)),
            row(Some("gone"), notice("n5", 99)),
            // The file has it: the file's copy stays.
            row(Some("f1"), notice("f2", 21)),
        ];
        restore(&mut order, &mut items, &rows);
        assert_eq!(order, ["n0", "f1", "n1", "n2", "n3", "f2", "n4", "f3", "n5"]);
        assert_eq!(items["f2"], mode("f2", 20));
    }

    #[test]
    fn kept_notices_are_about_the_session() {
        assert!(keeps_notice(NoticeLevel::Warn, Some("extension")));
        assert!(keeps_notice(NoticeLevel::Error, None));
        assert!(!keeps_notice(NoticeLevel::Info, Some("fallback")));
        assert!(!keeps_notice(NoticeLevel::Warn, Some("collab")));
        assert!(!keeps_notice(NoticeLevel::Error, Some("retry")));
    }
}
