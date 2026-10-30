//! omp's idle recaps on the board (architecture §3.5, `OmpInfo.recap`).
//!
//! After `recap.idleSeconds` (default 240) of an idle TUI, omp asks the session's model for a short
//! recap of where things stand ("Tests pass; PR body drafted; waiting on your call about the
//! migration") and journals it to `<omp agent dir>/history.db`, table `session_recaps` (append-only,
//! one row per idle stretch; never in the session file). The reader here takes the newest recap of
//! every omp session on the board, read-only and only when the journal's files changed (a `stat` of
//! `history.db` and its WAL every [`POLL_EVERY`] otherwise). The store puts a recap on its agent
//! while it is current ([`current`]): written after the session's newest conversation row (live
//! agents with a replica), else after the end of the last turn hostd saw (parked agents, sessions
//! without a replica). There is none while a draft sits in omp's composer or when recaps are off;
//! the apps then show the last assistant line as before.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use rusqlite::OptionalExtension;
use tf_proto::Millis;
use tf_proto::model::{Agent, IdleRecap};
use tracing::debug;

use super::StateHandle;
use crate::ops::Ctx;
use crate::util::clip;

/// How often the journal's files are checked for changes.
pub const POLL_EVERY: Duration = Duration::from_secs(5);
/// Longest recap kept, in chars (omp asks its model for under 40 words).
const MAX_CHARS: usize = 400;
/// `created_at` has second precision.
const SECOND: Millis = 1_000;

/// Size and modification time of `history.db` and its WAL: while both stay, nothing new was
/// journaled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stamp {
    db: Option<(u64, SystemTime)>,
    wal: Option<(u64, SystemTime)>,
}

fn stamp(db: &Path) -> Stamp {
    let of = |p: &Path| {
        std::fs::metadata(p)
            .ok()
            .and_then(|m| Some((m.len(), m.modified().ok()?)))
    };
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    Stamp {
        db: of(db),
        wal: of(Path::new(&wal)),
    }
}

/// The newest recap of each session in `ids` from omp's journal at `db`. A missing database or
/// table (omp before idle recaps) reads as none.
fn latest(db: &Path, ids: &[String]) -> Result<HashMap<String, IdleRecap>, String> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let Some(conn) = crate::ops::host::open_ro(db).map_err(|e| e.message)? else {
        return Ok(out);
    };
    let has_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_recaps'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !has_table {
        return Ok(out);
    }
    // omp's own reader skips rows a damaged page decoded into other types; so does this one.
    let mut stmt = conn
        .prepare(
            "SELECT recap, created_at FROM session_recaps
              WHERE session_id = ?1 AND typeof(recap) = 'text' AND typeof(created_at) = 'integer'
              ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    for id in ids {
        let row = stmt
            .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((text, secs)) = row else { continue };
        let text = clip(
            &text.split_whitespace().collect::<Vec<_>>().join(" "),
            MAX_CHARS,
        );
        if !text.is_empty() {
            out.insert(
                id.clone(),
                IdleRecap {
                    text,
                    at: secs.saturating_mul(SECOND),
                },
            );
        }
    }
    Ok(out)
}

/// Reads the newest recap per session, skipping the work while neither the journal nor the set of
/// sessions changed.
pub struct Reader {
    db: PathBuf,
    seen: Option<(Stamp, Vec<String>)>,
}

impl Reader {
    pub fn new(db: PathBuf) -> Self {
        Self { db, seen: None }
    }

    /// The newest recap of each session of `ids`, or `None` when nothing changed since the last
    /// answer (or the journal could not be read now: the next poll tries again).
    pub fn poll(&mut self, mut ids: Vec<String>) -> Option<HashMap<String, IdleRecap>> {
        ids.sort_unstable();
        ids.dedup();
        let now = stamp(&self.db);
        if self
            .seen
            .as_ref()
            .is_some_and(|(s, i)| *s == now && *i == ids)
        {
            return None;
        }
        match latest(&self.db, &ids) {
            Ok(found) => {
                self.seen = Some((now, ids));
                Some(found)
            }
            Err(e) => {
                debug!(db = %self.db.display(), "recap journal: {e}");
                None
            }
        }
    }
}

/// Whether `recap` still describes its session: written after the session's newest conversation
/// row when the replica knows it (`last_row_at`), else after the end of the last turn hostd saw;
/// with neither known, it can't be told from an older stretch's recap, so no.
pub fn current(
    recap: &IdleRecap,
    last_row_at: Option<Millis>,
    last_turn_ended_at: Option<Millis>,
) -> bool {
    match (last_row_at, last_turn_ended_at) {
        // omp writes a recap at least a second after the newest row started, so even truncated
        // to its second it is not older; a prompt or a reply since is.
        (Some(row), _) => recap.at >= row,
        // hostd notices a turn end a moment after omp went idle.
        (None, Some(ended)) => recap.at + SECOND > ended,
        (None, None) => false,
    }
}

/// Puts each omp agent's current recap on its card. `rows`: agent id → its replica's newest
/// conversation row (`OmpView::last_turn_row_at`); parked agents have none.
pub fn attach(
    agents: &mut [Agent],
    recaps: &HashMap<String, IdleRecap>,
    rows: &HashMap<String, Millis>,
) {
    for a in agents {
        let row = rows.get(&a.id).copied();
        let Some(o) = a.omp.as_mut() else { continue };
        o.recap = o
            .session_id
            .as_deref()
            .and_then(|s| recaps.get(s))
            .filter(|r| current(r, row, o.last_turn_ended_at))
            .cloned();
    }
}

impl StateHandle {
    /// omp session ids of every agent on the board, parked ones included.
    fn recap_sessions(&self) -> Vec<String> {
        self.lock()
            .published
            .agents
            .iter()
            .filter_map(|a| a.omp.as_ref()?.session_id.clone())
            .collect()
    }

    /// The newest recap per omp session; the next build shows the current ones.
    fn set_recaps(&self, recaps: HashMap<String, IdleRecap>) {
        let mut m = self.lock();
        if m.recaps != recaps {
            m.recaps = recaps;
            drop(m);
            self.mark_dirty();
        }
    }
}

/// Polls omp's recap journal for the board's sessions and hands changes to the store.
pub async fn run(ctx: Arc<Ctx>) {
    let db = crate::ops::host::omp_agent_dir().join("history.db");
    let mut reader = Some(Reader::new(db.clone()));
    let mut tick = tokio::time::interval(POLL_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ctx.cancel.cancelled() => return,
            _ = tick.tick() => {}
        }
        let ids = ctx.state.recap_sessions();
        let mut r = reader.take().unwrap_or_else(|| Reader::new(db.clone()));
        let found = match tokio::task::spawn_blocking(move || {
            let found = r.poll(ids);
            (r, found)
        })
        .await
        {
            Ok((r, found)) => {
                reader = Some(r);
                found
            }
            Err(_) => None,
        };
        if let Some(found) = found {
            ctx.state.set_recaps(found);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal(path: &Path) -> rusqlite::Connection {
        let c = rusqlite::Connection::open(path).unwrap();
        // omp 18.13.3's DDL (session/session-index.ts).
        c.execute_batch(
            "CREATE TABLE IF NOT EXISTS session_recaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, cwd TEXT NOT NULL,
                recap TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)));
             CREATE INDEX IF NOT EXISTS idx_session_recaps_session ON session_recaps(session_id, created_at);",
        )
        .unwrap();
        c
    }

    fn add(c: &rusqlite::Connection, sid: &str, text: &str, secs: i64) {
        c.execute("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES (?1, '/w', ?2, ?3)", rusqlite::params![sid, text, secs]).unwrap();
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn newest_recap_per_session() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("history.db");
        let c = journal(&db);
        add(&c, "s1", "Old recap.", 100);
        add(&c, "s1", "  Tests pass;\n PR body drafted. ", 200);
        add(&c, "s1", "Same second, written later.", 200);
        add(&c, "s2", "Other session.", 150);
        add(&c, "s3", "Not asked for.", 300);
        // A damaged row (omp's reader skips them too).
        c.execute("INSERT INTO session_recaps (session_id, cwd, recap, created_at) VALUES ('s2', '/w', 'x', 'later')", []).unwrap();
        let got = latest(&db, &ids(&["s1", "s2", "missing"])).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(
            got["s1"],
            IdleRecap {
                text: "Same second, written later.".into(),
                at: 200_000
            }
        );
        assert_eq!(
            got["s2"],
            IdleRecap {
                text: "Other session.".into(),
                at: 150_000
            }
        );
        add(&c, "s1", "  Tests pass;\n\n  PR body   drafted. ", 201);
        assert_eq!(
            latest(&db, &ids(&["s1"])).unwrap()["s1"].text,
            "Tests pass; PR body drafted."
        );
        let long = "word ".repeat(200);
        add(&c, "s1", &long, 202);
        assert_eq!(
            latest(&db, &ids(&["s1"])).unwrap()["s1"]
                .text
                .chars()
                .count(),
            MAX_CHARS
        );
    }

    #[test]
    fn missing_journal_or_table_reads_as_none() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("history.db");
        assert!(latest(&db, &ids(&["s1"])).unwrap().is_empty());
        // omp before idle recaps: history.db without the table.
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt TEXT);")
            .unwrap();
        assert!(latest(&db, &ids(&["s1"])).unwrap().is_empty());
        assert!(latest(&db, &[]).unwrap().is_empty());
    }

    #[test]
    fn reader_reads_again_only_after_a_change() {
        let td = tempfile::tempdir().unwrap();
        let db = td.path().join("history.db");
        let c = journal(&db);
        add(&c, "s1", "First.", 100);
        let mut r = Reader::new(db.clone());
        assert_eq!(r.poll(ids(&["s1"])).unwrap()["s1"].text, "First.");
        assert!(r.poll(ids(&["s1"])).is_none(), "nothing changed");
        assert!(r.poll(ids(&["s1", "s1"])).is_none(), "same set");
        // Another session on the board: read again.
        assert_eq!(r.poll(ids(&["s2", "s1"])).unwrap().len(), 1);
        std::thread::sleep(Duration::from_millis(20));
        add(&c, "s2", "Second.", 120);
        let got = r.poll(ids(&["s1", "s2"])).unwrap();
        assert_eq!(
            (got["s1"].text.as_str(), got["s2"].text.as_str()),
            ("First.", "Second.")
        );
        assert!(r.poll(ids(&["s1", "s2"])).is_none());
    }

    #[test]
    fn a_recap_counts_while_nothing_happened_since() {
        let r = IdleRecap {
            text: "t".into(),
            at: 10_000,
        };
        // The replica knows the newest row: the recap must not be older (second precision).
        assert!(current(&r, Some(9_400), None));
        assert!(current(&r, Some(10_000), None));
        assert!(
            !current(&r, Some(10_300), None),
            "a prompt or reply since the recap"
        );
        assert!(
            current(&r, Some(9_000), Some(12_000)),
            "the replica's rows decide"
        );
        // Only the turn end hostd saw (parked, no replica): written after it (its second counts).
        assert!(current(&r, None, Some(9_000)));
        assert!(current(&r, None, Some(10_800)));
        assert!(!current(&r, None, Some(11_000)));
        // Unknown: an older stretch's recap would look the same.
        assert!(!current(&r, None, None));
    }

    /// A board card with just the fields this module reads (JSON, so other optional fields default).
    fn agent(id: &str, sid: &str, ended: Option<Millis>, parked: bool) -> Agent {
        let mut v = serde_json::json!({
            "id": id, "name": id, "kind": "omp", "paneId": "", "tabId": "", "workspaceId": "",
            "state": "idle", "stateSince": 0, "column": if parked { "done" } else { "review" }, "archived": parked,
            "turns": 1, "title": "t",
            "omp": {
                "sessionId": sid, "link": "live", "bridge": true, "fast": false, "mode": "normal",
                "queue": { "steering": [], "followUp": [] },
                "recap": { "text": "stale", "at": 1 },
            },
            "live": { "streaming": false, "thinking": false, "line": "Done." },
        });
        if let Some(t) = ended {
            v["omp"]["lastTurnEndedAt"] = t.into();
        }
        if parked {
            v["parked"] = serde_json::json!({ "at": 0, "sessionFile": "/s.jsonl" });
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn attach_puts_current_recaps_on_cards() {
        let recaps: HashMap<String, IdleRecap> = [
            (
                "s-live".to_string(),
                IdleRecap {
                    text: "Live recap.".into(),
                    at: 50_000,
                },
            ),
            (
                "s-old".to_string(),
                IdleRecap {
                    text: "Before the last prompt.".into(),
                    at: 50_000,
                },
            ),
            (
                "s-parked".to_string(),
                IdleRecap {
                    text: "Parked recap.".into(),
                    at: 50_000,
                },
            ),
        ]
        .into();
        let mut agents = vec![
            agent("a1", "s-live", None, false),
            agent("a2", "s-old", Some(40_000), false),
            agent("a3", "s-parked", Some(45_000), true),
            agent("a4", "s-none", None, false),
        ];
        agents.push({
            let mut plain = agent("a5", "s-live", None, false);
            plain.kind = "claude".into();
            plain.omp = None;
            plain
        });
        let rows: HashMap<String, Millis> =
            [("a1".to_string(), 44_000), ("a2".to_string(), 52_000)].into();
        attach(&mut agents, &recaps, &rows);
        let recap = |i: usize| {
            agents[i]
                .omp
                .as_ref()
                .and_then(|o| o.recap.as_ref())
                .map(|r| r.text.as_str())
        };
        assert_eq!(recap(0), Some("Live recap."));
        assert_eq!(recap(1), None, "a prompt came after it");
        assert_eq!(recap(2), Some("Parked recap."));
        assert_eq!(recap(3), None, "no recap journaled");
        assert!(agents[4].omp.is_none());
    }
}
