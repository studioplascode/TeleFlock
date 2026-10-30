//! `session.find` and `search.*`: find in one session's transcript, full-text search over every
//! omp session file, and the read-only rows of a session file (architecture §3.27; matching,
//! caps and cancellation: `crate::find`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, UNIX_EPOCH};

use serde_json::Value;
use tf_proto::{ApiError, Empty, HistoryPage, HostMethod, PastSession, SearchPage, SearchPollParams, SearchStartParams, SessionFindParams, SessionFindResult, SessionHistoryParams, SessionReadParams, SessionRows, TranscriptItem};

use crate::clients::ClientHandle;
use crate::find::files;
use crate::find::rows::{self, FIND_DEFAULT, FIND_MAX};
use crate::find::search::{Candidate, Searches, Spec, BYTES_MAX, LIMIT_DEFAULT, LIMIT_MAX, TIME_MAX};
use crate::find::text::Needle;
use crate::omp::OmpSession;
use crate::ops::fs::{io_error, resolve_path};
use crate::ops::host::{id_from_file_name, live_sessions, omp_agent_dir, read_head, session_titles};
use crate::ops::{to_value, Ctx};

/// The daemon's session searches (shared by every herdr session's clients).
static SEARCHES: LazyLock<Searches> = LazyLock::new(Searches::default);

/// Rows cloned out of a live replica per lock.
const CHUNK: usize = 256;

pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::SearchStart(p) => to_value(start(ctx, p, client).await?),
        HostMethod::SearchPoll(p) => to_value(poll(p).await?),
        HostMethod::SearchCancel(p) => {
            SEARCHES.cancel(&p.search_id);
            to_value(Empty {})
        }
        HostMethod::SearchRead(p) => to_value(read(p).await?),
        other => Err(ApiError::new("unknown_method", format!("`{}` is not a search method", other.name()))),
    }
}

fn needle(query: &str, case_sensitive: Option<bool>) -> Result<Needle, ApiError> {
    Needle::new(query, case_sensitive.unwrap_or(false)).ok_or_else(|| ApiError::new("invalid_params", "nothing to search for"))
}

fn join_err(e: tokio::task::JoinError) -> ApiError {
    ApiError::new("internal", e.to_string())
}

fn wait(ms: Option<u32>) -> Duration {
    Duration::from_millis(u64::from(ms.unwrap_or(0)))
}

// ───────────────────────────── search.* ─────────────────────────────

async fn start(ctx: &Ctx, p: SearchStartParams, client: &ClientHandle) -> Result<SearchPage, ApiError> {
    let needle = needle(&p.query, p.case_sensitive)?;
    let limit = p.limit.map_or(LIMIT_DEFAULT, |l| l as usize).clamp(1, LIMIT_MAX);
    let cwd = match p.cwd.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(c) => Some(resolve_path(c)?),
        None => None,
    };
    let live = live_sessions(ctx);
    let dir = omp_agent_dir().join("sessions");
    let gone = client.clone();
    let spec = Spec {
        needle,
        limit,
        files: Box::new(move || candidates(&dir, cwd.as_deref(), &live)),
        time: TIME_MAX,
        bytes: BYTES_MAX,
        client_gone: Box::new(move || gone.is_closed()),
    };
    Ok(SEARCHES.start(client.id(), spec, wait(p.wait_ms)).await)
}

async fn poll(p: SearchPollParams) -> Result<SearchPage, ApiError> {
    SEARCHES
        .poll(&p.search_id, p.after as usize, wait(p.wait_ms))
        .await
        .ok_or_else(|| ApiError::new("not_found", format!("search {} is over", p.search_id)).with_hint("Search again"))
}

/// Top-level session files of omp's sessions folder (subagent transcripts live one level deeper),
/// newest first, with what Past sessions shows of each; `cwd` keeps the sessions of one folder.
pub(crate) fn candidates(dir: &Path, cwd: Option<&Path>, live: &HashMap<String, (String, bool)>) -> Vec<Candidate> {
    let mut files: Vec<(i64, PathBuf)> = Vec::new();
    for bucket in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if !bucket.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        for f in std::fs::read_dir(bucket.path()).into_iter().flatten().flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            if meta.is_file() {
                let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as i64);
                files.push((mtime, p));
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    let titles = session_titles();
    let mut out = Vec::with_capacity(files.len());
    for (mtime, path) in files {
        let head = read_head(&path);
        if let Some(want) = cwd
            && head.cwd.as_deref().is_none_or(|c| Path::new(c) != want)
        {
            continue;
        }
        let id = head.id.clone().or_else(|| id_from_file_name(&path)).unwrap_or_default();
        let file = path.display().to_string();
        let agent = live.get(&file).or_else(|| live.get(&id));
        let session = PastSession {
            title: titles.get(&id).cloned().or(head.title),
            cwd: head.cwd,
            updated_at: mtime,
            messages: None,
            live: agent.is_some_and(|(_, running)| *running),
            agent_id: agent.map(|(a, _)| a.clone()),
            file,
            id,
        };
        out.push(Candidate { path, session });
    }
    out
}

async fn read(p: SessionReadParams) -> Result<SessionRows, ApiError> {
    let root = omp_agent_dir().join("sessions");
    tokio::task::spawn_blocking(move || {
        let path = files::session_file(&root, &p.file)?;
        let rows = files::rows(&path).map_err(|e| io_error(e, &path))?;
        files::window(&rows, &p)
    })
    .await
    .map_err(join_err)?
}

// ───────────────────────────── session.find ─────────────────────────────

fn find_limit(p: &SessionFindParams) -> usize {
    p.limit.map_or(FIND_DEFAULT, |l| l as usize).clamp(1, FIND_MAX)
}

/// `session.find` on a live (bridge or collab) session: every row of its replica older than
/// `before`, cloned out a chunk per lock so the live feed never waits on the search.
pub async fn find_in_session(s: Arc<OmpSession>, p: SessionFindParams) -> Result<SessionFindResult, ApiError> {
    let needle = needle(&p.query, p.case_sensitive)?;
    let limit = find_limit(&p);
    tokio::task::spawn_blocking(move || {
        let (total, known) = {
            let st = s.lock();
            (st.replica.len(), p.before.as_deref().is_some_and(|b| st.replica.item(b).is_some()))
        };
        // Walking back from `before` (a row the replica does not have: from the newest row).
        let mut cursor = p.before.filter(|_| known);
        let mut back = 0usize;
        let mut found: Vec<(usize, String, u32)> = Vec::new();
        loop {
            let page = s.lock().replica.history(cursor.as_deref(), CHUNK);
            let Some(page) = page else { break };
            for item in page.items.iter().rev() {
                let count = rows::count(item, &needle);
                if count > 0 {
                    found.push((back, item.id().to_owned(), count));
                }
                back += 1;
            }
            if !page.has_more || page.cursor.is_none() {
                break;
            }
            cursor = page.cursor;
        }
        // `back` rows were walked: the oldest is row 0.
        let truncated = found.len() > limit;
        found.truncate(limit);
        let hits = found.into_iter().rev().map(|(b, id, count)| tf_proto::FindHit { id, index: (back - 1 - b) as u32, count }).collect();
        Ok(SessionFindResult { hits, rows: total as u32, truncated })
    })
    .await
    .map_err(join_err)?
}

/// `session.find` on a parked agent: the rows of its session file.
pub async fn find_in_file(file: String, p: SessionFindParams) -> Result<SessionFindResult, ApiError> {
    let needle = needle(&p.query, p.case_sensitive)?;
    let limit = find_limit(&p);
    let all = file_rows(file).await?;
    let end = p.before.as_deref().and_then(|b| all.iter().position(|r| r.id() == b)).unwrap_or(all.len());
    Ok(rows::collect(all[..end].iter().enumerate(), all.len(), &needle, limit))
}

/// The newest `limit` rows of a parked agent's session file, the cursor naming the oldest.
pub async fn parked_rows(file: String, limit: usize) -> Result<(Vec<TranscriptItem>, bool, Option<String>), ApiError> {
    let all = file_rows(file).await?;
    let start = all.len().saturating_sub(limit);
    Ok((all[start..].to_vec(), start > 0, (start > 0).then(|| all[start].id().to_owned())))
}

/// `session.history` on a parked agent: older rows of its session file.
pub async fn parked_history(file: String, p: SessionHistoryParams, default_limit: usize) -> Result<HistoryPage, ApiError> {
    let limit = p.limit.map_or(default_limit, |l| l as usize).clamp(1, 2000);
    let all = file_rows(file).await?;
    let end = all.iter().position(|r| r.id() == p.cursor).ok_or_else(|| ApiError::new("not_found", format!("row {} is not in the session", p.cursor)))?;
    let start = end.saturating_sub(limit);
    Ok(HistoryPage { items: all[start..end].to_vec(), has_more: start > 0, cursor: (start > 0).then(|| all[start].id().to_owned()) })
}

async fn file_rows(file: String) -> Result<Arc<Vec<TranscriptItem>>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&file);
        files::rows(&path).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ApiError::new("not_found", format!("the omp session file {file} was deleted")),
            _ => io_error(e, &path),
        })
    })
    .await
    .map_err(join_err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::find::scan::tests::session_lines;

    #[test]
    fn candidates_list_top_level_sessions_newest_first_in_scope() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        for (bucket, name, cwd, age) in [("-a", "1_x.jsonl", "/a", 30), ("-b", "2_y.jsonl", "/b", 10), ("-a", "3_z.jsonl", "/a", 20)] {
            std::fs::create_dir_all(root.join(bucket)).unwrap();
            let path = root.join(bucket).join(name);
            std::fs::write(&path, session_lines(name, cwd, "w").join("\n")).unwrap();
            let t = std::time::SystemTime::now() - Duration::from_secs(age);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(t).unwrap();
        }
        // A subagent transcript (one level deeper) is not a session of its own.
        std::fs::create_dir_all(root.join("-a/1_x")).unwrap();
        std::fs::write(root.join("-a/1_x/sub.jsonl"), "{}\n").unwrap();
        let live = HashMap::from([("3_z.jsonl".to_owned(), ("agent9".to_owned(), true))]);
        let all = candidates(&root, None, &live);
        assert_eq!(all.iter().map(|c| c.session.id.as_str()).collect::<Vec<_>>(), ["2_y.jsonl", "3_z.jsonl", "1_x.jsonl"]);
        let z = &all[1].session;
        assert_eq!((z.live, z.agent_id.as_deref(), z.title.as_deref(), z.cwd.as_deref()), (true, Some("agent9"), Some("About w"), Some("/a")));
        let scoped = candidates(&root, Some(Path::new("/a")), &live);
        assert_eq!(scoped.len(), 2);
    }
}
