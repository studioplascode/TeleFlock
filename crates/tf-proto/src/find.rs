//! Find in one session's transcript (`session.find`) and full-text search over every omp session
//! file on the host (`search.*`). Architecture §3.27.
//!
//! Queries are literal text, never patterns, matched case-insensitively (each character's simple
//! lowercase, so offsets never move) unless `caseSensitive`. A row's searchable text is what its
//! card shows: prompt and reply text, thinking, tool titles, arguments, outputs (ANSI escapes
//! removed), errors and the fields of the tool's rich view (tf-hostd `find/rows.rs`, the app's
//! `src/features/session/find/rowText.ts`).

use crate::methods::PastSession;
use crate::session::TranscriptItem;
use crate::Millis;

wire_struct! {
    /// `session.find`: which rows of an agent's transcript contain `query`, searched on the host
    /// over every row of the session, the ones the client has not loaded included.
    pub struct SessionFindParams {
        pub agent_id: String,
        pub query: String,
        pub case_sensitive: Option<bool>,
        /// Search only rows older than this one (the client's oldest loaded row: it matches the
        /// rows it holds itself). A row the session does not have: every row is searched.
        pub before: Option<String>,
        /// Most rows returned (default 2000, at most 10 000). The newest matching rows are kept.
        pub limit: Option<u32>,
    }
}

wire_struct! {
    /// One matching transcript row.
    pub struct FindHit {
        /// The row (`TranscriptItem.id`).
        pub id: String,
        /// Where the row sits in the session, 0 = oldest (of `SessionFindResult.rows`).
        pub index: u32,
        /// Occurrences of the query in the row's text.
        pub count: u32,
    }
}

wire_struct! {
    pub struct SessionFindResult {
        /// Matching rows, oldest first.
        pub hits: Vec<FindHit>,
        /// Rows the session has (all of them, not only the ones searched).
        pub rows: u32,
        /// More rows matched than `limit`: the oldest were left out.
        pub truncated: bool,
    }
}

wire_struct! {
    /// `search.start`: full-text search over the host's omp session files, newest first, in the
    /// background. Answers with the first page (after up to `waitMs`); `search.poll` reads on.
    pub struct SearchStartParams {
        pub query: String,
        pub case_sensitive: Option<bool>,
        /// Only sessions that ran in this folder (the Past sessions scope).
        pub cwd: Option<String>,
        /// Stop after this many matching sessions (default 100, at most 500).
        pub limit: Option<u32>,
        /// Wait up to this long for the first hits or the end (default 0, at most 10 000 ms).
        pub wait_ms: Option<u32>,
    }
}

wire_struct! { pub struct SearchRef { pub search_id: String } }

wire_struct! {
    pub struct SearchPollParams {
        pub search_id: String,
        /// Hits the client holds already: the page lists the ones after them.
        pub after: u32,
        /// Wait up to this long for new hits or the end (default 0, at most 10 000 ms).
        pub wait_ms: Option<u32>,
    }
}

wire_enum! {
    /// Why a search ended before it read every session file.
    pub enum SearchStop { Hits, Time, Bytes, Cancelled }
}

wire_enum! {
    /// What a match is part of.
    pub enum SnippetKind { User, Assistant, Thinking, ToolCall, ToolOutput, Summary, Other }
}

wire_struct! {
    /// One match in a session file, with some context around it (whitespace runs collapsed).
    pub struct SearchSnippet {
        pub kind: SnippetKind,
        /// Text before the match (starts with `…` when cut).
        pub before: String,
        /// The matching text as written.
        pub hit: String,
        /// Text after the match (ends with `…` when cut).
        pub after: String,
        /// Tool name (tool calls and outputs).
        pub tool: Option<String>,
        /// Transcript row of the match, as a replica of the session names it (`TranscriptItem.id`).
        pub row_id: Option<String>,
        /// When omp wrote the entry.
        pub at: Option<Millis>,
    }
}

wire_struct! {
    pub struct SessionSearchHit {
        pub session: PastSession,
        /// Occurrences found (counting stops at 1000).
        pub matches: u32,
        /// The first matches (at most 3), oldest first.
        pub snippets: Vec<SearchSnippet>,
    }
}

wire_struct! {
    pub struct SearchPage {
        pub search_id: String,
        /// Hits after `after`, in the order found (newest session files first).
        pub hits: Vec<SessionSearchHit>,
        /// Hits so far, earlier pages included.
        pub total: u32,
        /// Session files read so far, and in all.
        pub files: u32,
        pub files_total: u32,
        /// Bytes read so far.
        pub bytes: u64,
        pub elapsed_ms: u64,
        /// Ended: every file read, or stopped (`stopped` says why).
        pub done: bool,
        pub stopped: Option<SearchStop>,
    }
}

wire_struct! {
    /// `search.read`: transcript rows of a session file, read-only (the Past sessions preview).
    /// One of `around`, `before`, `after` picks the window; none: the newest `limit` rows.
    pub struct SessionReadParams {
        /// The session's `.jsonl` (`PastSession.file`).
        pub file: String,
        /// Rows centred on this row (`SearchSnippet.rowId`) …
        pub around: Option<String>,
        /// … or on the row nearest to this time, when `around` is absent or unknown.
        pub around_at: Option<Millis>,
        /// Rows older than this row (paging up).
        pub before: Option<String>,
        /// Rows newer than this row (paging down).
        pub after: Option<String>,
        /// Rows returned (default 120, at most 1000).
        pub limit: Option<u32>,
    }
}

wire_struct! {
    pub struct SessionRows {
        /// Oldest first.
        pub items: Vec<TranscriptItem>,
        /// Where `items[0]` sits in the session, 0 = oldest.
        pub start: u32,
        /// Rows the session has.
        pub rows: u32,
    }
}

#[cfg(test)]
mod tests {
    use crate::HostMethod;

    #[test]
    fn find_and_search_params_parse() {
        let req = HostMethod::parse("session.find", serde_json::json!({ "agentId": "a1", "query": "Foo", "before": "u10" })).unwrap();
        let HostMethod::SessionFind(p) = req else { panic!("wrong variant") };
        assert_eq!((p.agent_id.as_str(), p.query.as_str(), p.before.as_deref(), p.case_sensitive), ("a1", "Foo", Some("u10"), None));
        let req = HostMethod::parse("search.poll", serde_json::json!({ "searchId": "s1", "after": 3, "waitMs": 500 })).unwrap();
        let HostMethod::SearchPoll(p) = req else { panic!("wrong variant") };
        assert_eq!((p.search_id.as_str(), p.after, p.wait_ms), ("s1", 3, Some(500)));
        assert_eq!(HostMethod::parse("search.start", serde_json::json!({})).unwrap_err().code, "invalid_params");
        let page = super::SearchPage {
            search_id: "s1".into(),
            hits: vec![],
            total: 0,
            files: 2,
            files_total: 9,
            bytes: 10,
            elapsed_ms: 4,
            done: true,
            stopped: Some(super::SearchStop::Time),
        };
        let v = serde_json::to_value(&page).unwrap();
        assert_eq!(v["filesTotal"], 9);
        assert_eq!(v["stopped"], "time");
    }
}
