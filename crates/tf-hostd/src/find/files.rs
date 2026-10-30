//! Transcript rows of an omp session file read from disk, without a replica: the Past sessions
//! preview (`search.read`) and parked agents (their `session.find`), mapped exactly like a live
//! replica rebuilds them (`tf_collab::replica::transcript_page`). The last few files read are
//! kept while they are unchanged (path, size, mtime), so paging a preview re-reads nothing.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use tf_proto::{ApiError, SessionReadParams, SessionRows, TranscriptItem};

/// Largest tail of a session file mapped to rows.
pub const READ_MAX: u64 = 64 * 1024 * 1024;
/// Files kept mapped.
const CACHED: usize = 3;
pub const WINDOW_DEFAULT: usize = 120;
pub const WINDOW_MAX: usize = 1000;

struct Cached {
    path: PathBuf,
    len: u64,
    mtime: Option<SystemTime>,
    rows: Arc<Vec<TranscriptItem>>,
}

static CACHE: Mutex<Vec<Cached>> = Mutex::new(Vec::new());

/// The rows of a session file (blocking). `NotFound` when it is gone.
pub fn rows(path: &Path) -> std::io::Result<Arc<Vec<TranscriptItem>>> {
    let meta = std::fs::metadata(path)?;
    let (len, mtime) = (meta.len(), meta.modified().ok());
    {
        let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(i) = cache.iter().position(|c| c.path == path && c.len == len && c.mtime == mtime) {
            let hit = cache.remove(i);
            let rows = hit.rows.clone();
            cache.push(hit);
            return Ok(rows);
        }
    }
    let text = read_tail(path, READ_MAX)?;
    let rows = Arc::new(tf_collab::replica::transcript_page(&text).items);
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|c| c.path != path);
    if cache.len() >= CACHED {
        cache.remove(0);
    }
    cache.push(Cached { path: path.to_owned(), len, mtime, rows: rows.clone() });
    Ok(rows)
}

/// The file, or its last `max` bytes from a line start.
fn read_tail(path: &Path, max: u64) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut buf = Vec::new();
    if len > max {
        f.seek(SeekFrom::Start(len - max))?;
        f.take(max).read_to_end(&mut buf)?;
        let start = buf.iter().position(|b| *b == b'\n').map_or(buf.len(), |i| i + 1);
        buf.drain(..start);
    } else {
        f.read_to_end(&mut buf)?;
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// A `.jsonl` inside omp's sessions folder `root` (symlinks resolved), else `invalid_params`.
pub fn session_file(root: &Path, file: &str) -> Result<PathBuf, ApiError> {
    let p = Path::new(file);
    let bad = || ApiError::new("invalid_params", format!("{file} is not an omp session file"));
    if !p.is_absolute() || p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err(bad());
    }
    let real = std::fs::canonicalize(p).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ApiError::new("not_found", format!("the omp session file {file} was deleted")),
        _ => crate::ops::fs::io_error(e, p),
    })?;
    let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_owned());
    if !real.starts_with(&root) || !real.is_file() {
        return Err(bad());
    }
    Ok(real)
}

/// The rows `p` asks for (`around` / `aroundAt` / `before` / `after`, else the newest).
pub fn window(rows: &[TranscriptItem], p: &SessionReadParams) -> Result<SessionRows, ApiError> {
    let limit = p.limit.map_or(WINDOW_DEFAULT, |l| l as usize).clamp(1, WINDOW_MAX);
    let n = rows.len();
    let at = |id: &str| rows.iter().position(|r| r.id() == id).ok_or_else(|| ApiError::new("not_found", format!("row {id} is not in the session")));
    let (start, end) = if let Some(before) = &p.before {
        let end = at(before)?;
        (end.saturating_sub(limit), end)
    } else if let Some(after) = &p.after {
        let start = at(after)? + 1;
        (start, (start + limit).min(n))
    } else {
        let centre = p.around.as_deref().and_then(|id| rows.iter().position(|r| r.id() == id)).or_else(|| {
            let t = p.around_at?;
            Some(rows.iter().position(|r| row_at(r) >= t).unwrap_or(n.saturating_sub(1)))
        });
        match centre {
            Some(c) => {
                let start = c.saturating_sub(limit / 2).min(n.saturating_sub(limit));
                (start, (start + limit).min(n))
            }
            None => (n.saturating_sub(limit), n),
        }
    };
    Ok(SessionRows { items: rows[start..end].to_vec(), start: start as u32, rows: n as u32 })
}

fn row_at(r: &TranscriptItem) -> i64 {
    match r {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{ModeItem, SessionReadParams};

    fn mode(i: i64) -> TranscriptItem {
        TranscriptItem::Mode(ModeItem { id: format!("m{i}"), at: i * 10, text: String::new() })
    }

    fn params() -> SessionReadParams {
        SessionReadParams { file: String::new(), around: None, around_at: None, before: None, after: None, limit: Some(10) }
    }

    #[test]
    fn windows_page_both_ways_around_a_row() {
        let rows: Vec<_> = (0..100).map(mode).collect();
        let ids = |w: &SessionRows| (w.start, w.items.first().map(|r| r.id().to_owned()), w.items.len());
        let w = window(&rows, &SessionReadParams { around: Some("m50".into()), ..params() }).unwrap();
        assert_eq!(ids(&w), (45, Some("m45".into()), 10));
        let w = window(&rows, &SessionReadParams { around: Some("m98".into()), ..params() }).unwrap();
        assert_eq!(ids(&w), (90, Some("m90".into()), 10), "clamped at the end");
        let w = window(&rows, &SessionReadParams { around: Some("gone".into()), around_at: Some(201), ..params() }).unwrap();
        assert_eq!(ids(&w), (16, Some("m16".into()), 10), "nearest row in time when the id is unknown");
        let w = window(&rows, &SessionReadParams { before: Some("m5".into()), ..params() }).unwrap();
        assert_eq!(ids(&w), (0, Some("m0".into()), 5));
        let w = window(&rows, &SessionReadParams { after: Some("m95".into()), ..params() }).unwrap();
        assert_eq!(ids(&w), (96, Some("m96".into()), 4));
        let w = window(&rows, &params()).unwrap();
        assert_eq!((ids(&w), w.rows), ((90, Some("m90".into()), 10), 100));
        assert_eq!(window(&rows, &SessionReadParams { before: Some("gone".into()), ..params() }).unwrap_err().code, "not_found");
    }

    #[test]
    fn only_session_files_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(root.join("-w")).unwrap();
        let inside = root.join("-w/a.jsonl");
        std::fs::write(&inside, "{}\n").unwrap();
        let outside = dir.path().join("b.jsonl");
        std::fs::write(&outside, "{}\n").unwrap();
        assert!(session_file(&root, &inside.display().to_string()).is_ok());
        assert_eq!(session_file(&root, &outside.display().to_string()).unwrap_err().code, "invalid_params");
        assert_eq!(session_file(&root, "relative.jsonl").unwrap_err().code, "invalid_params");
        assert_eq!(session_file(&root, &root.join("-w/gone.jsonl").display().to_string()).unwrap_err().code, "not_found");
        #[cfg(unix)]
        {
            let link = root.join("-w/link.jsonl");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert_eq!(session_file(&root, &link.display().to_string()).unwrap_err().code, "invalid_params", "a link out of the folder");
        }
    }

    #[test]
    fn rows_are_cached_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        let prompt = |t: i64, text: &str| serde_json::json!({ "type": "message", "id": format!("e{t}"), "message": { "role": "user", "timestamp": t, "content": text } }).to_string();
        std::fs::write(&path, format!("{}\n", prompt(1, "hello"))).unwrap();
        let a = rows(&path).unwrap();
        assert_eq!(a.iter().map(|r| r.id().to_owned()).collect::<Vec<_>>(), ["u1"]);
        assert!(Arc::ptr_eq(&a, &rows(&path).unwrap()));
        std::fs::write(&path, format!("{}\n{}\n", prompt(1, "hello"), prompt(2, "again"))).unwrap();
        assert_eq!(rows(&path).unwrap().len(), 2, "a changed file is read again");
    }
}
