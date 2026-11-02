//! The host's idle-shell settings (`<home>/idle-shells.json`): close idle shells automatically
//! (default on) after how many minutes without input or output (default 24 h). One file per
//! daemon home, shared by every herdr session the daemon serves; each session's janitor follows
//! changes at once. A file that can't be read fails closed, as `autoresume.json` does ([`load`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use tf_proto::ApiError;
use tokio::sync::watch;
use tracing::{error, info};

use crate::util::now_ms;

/// 24 h.
pub const DEFAULT_MINUTES: u32 = 24 * 60;
/// 30 days.
pub const MAX_MINUTES: u32 = 30 * 24 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub auto: bool,
    pub minutes: u32,
    /// Why `auto` is off although it may have been on: the file could not be read ([`load`]);
    /// until the settings are saved again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { auto: true, minutes: DEFAULT_MINUTES, notice: None }
    }
}

static HOMES: LazyLock<Mutex<HashMap<PathBuf, watch::Sender<Settings>>>> = LazyLock::new(Default::default);

/// One change at a time: [`set`] reads, saves and publishes under it, so two changes at once
/// can't undo each other or leave the file other than what the daemon holds.
static SAVING: Mutex<()> = Mutex::new(());

fn file(home: &Path) -> PathBuf {
    home.join("idle-shells.json")
}

/// The saved settings. No file: the defaults (on, after 24 h). A file that exists but can't be
/// read or parsed is copied to `idle-shells.json.bad-<ms>` (when it can be) and the host **fails
/// closed**: idle shells are not closed by themselves, with a notice saying why, until the
/// settings are saved again. The file may have held the user's "off"; not knowing it, nothing may
/// close shells unattended. The closed state replaces the damaged file at once in one atomic step,
/// as `recovery::load` does for `autoresume.json`.
fn load(path: &Path) -> Settings {
    let why = match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
            Ok(s) => return Settings { minutes: s.minutes.clamp(1, MAX_MINUTES), ..s },
            Err(e) => e.to_string(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(e) => format!("read: {e}"),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    fail_closed(path, &why, &path.with_file_name(format!("{name}.bad-{}", now_ms())))
}

/// The closed settings of a damaged `path`: its bytes copied to `copy` when possible (a failure
/// is logged and the file is replaced anyway), then replaced atomically.
fn fail_closed(path: &Path, why: &str, copy: &Path) -> Settings {
    let kept = match std::fs::copy(path, copy) {
        Ok(_) => format!("The damaged file was kept as {}.", copy.display()),
        Err(e) => {
            error!(file = %path.display(), "the damaged idle-shell settings could not be copied aside ({e})");
            "The damaged file could not be kept.".to_string()
        }
    };
    error!(file = %path.display(), "the idle-shell settings are unreadable ({why}); no idle shell is closed by itself. {kept}");
    let closed = Settings {
        auto: false,
        minutes: DEFAULT_MINUTES,
        notice: Some(format!(
            "The idle-shell settings file could not be read ({why}), so closing idle shells automatically is off on this host until you switch it on again. {kept}"
        )),
    };
    if let Err(e) = serde_json::to_vec_pretty(&closed).map_err(std::io::Error::other).and_then(|b| crate::paths::write_atomic(path, &b)) {
        error!(file = %path.display(), "writing the fail-closed idle-shell settings: {e}");
    }
    closed
}

fn sender(home: &Path) -> watch::Sender<Settings> {
    let mut homes = HOMES.lock().unwrap_or_else(|p| p.into_inner());
    homes.entry(home.to_path_buf()).or_insert_with(|| watch::channel(load(&file(home))).0).clone()
}

/// The settings of the daemon at `home`, and their changes.
pub fn subscribe(home: &Path) -> watch::Receiver<Settings> {
    sender(home).subscribe()
}

pub fn get(home: &Path) -> Settings {
    sender(home).borrow().clone()
}

/// `cleanup.idleShellsSet`: saves the given fields (the others keep their value). Saving
/// acknowledges a notice about a damaged file.
pub fn set(home: &Path, auto: Option<bool>, minutes: Option<u32>) -> Result<Settings, ApiError> {
    if let Some(m) = minutes
        && !(1..=MAX_MINUTES).contains(&m)
    {
        return Err(ApiError::new("invalid_params", format!("minutes must be 1 to {MAX_MINUTES} (30 days), not {m}")));
    }
    let _one = SAVING.lock().unwrap_or_else(|p| p.into_inner());
    let tx = sender(home);
    let mut next = tx.borrow().clone();
    next.auto = auto.unwrap_or(next.auto);
    next.minutes = minutes.unwrap_or(next.minutes);
    next.notice = None;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| ApiError::new("internal", format!("encode idle-shell settings: {e}")))?;
    let path = file(home);
    crate::paths::write_atomic(&path, &bytes).map_err(|e| ApiError::new("internal", format!("save {}: {e}", path.display())))?;
    info!(auto = next.auto, minutes = next.minutes, "idle-shell settings saved");
    tx.send_replace(next.clone());
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_on_after_a_day_and_persists_changes() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let off = |minutes: u32| Settings { auto: false, minutes, notice: None };
        assert_eq!(get(home), Settings { auto: true, minutes: 24 * 60, notice: None });
        let mut rx = subscribe(home);
        assert_eq!(set(home, Some(false), None).unwrap(), off(1440));
        assert!(rx.has_changed().unwrap());
        assert_eq!(*rx.borrow_and_update(), off(1440));
        assert_eq!(set(home, None, Some(90)).unwrap(), off(90));
        assert_eq!(load(&file(home)), off(90));
        assert_eq!(set(home, None, Some(0)).unwrap_err().code, "invalid_params");
        assert_eq!(set(home, None, Some(MAX_MINUTES + 1)).unwrap_err().code, "invalid_params");
        assert_eq!(get(home).minutes, 90);
    }

    fn kept_aside(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("idle-shells.json.bad-"))).collect()
    }

    /// The file may have held the user's "off": a file that can't be read closes nothing by itself
    /// until the settings are saved again, as `autoresume.json` does.
    #[test]
    fn a_damaged_file_fails_closed_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (home, path) = (dir.path(), file(dir.path()));
        std::fs::write(&path, b"{\"auto\":fal").unwrap();
        let closed = load(&path);
        assert!(!closed.auto && closed.minutes == DEFAULT_MINUTES, "{closed:?}");
        let why = closed.notice.clone().expect("the host says why");
        assert!(why.contains("could not be read") && why.contains("idle-shells.json.bad-"), "{why}");
        let bad = kept_aside(home);
        assert_eq!(bad.len(), 1);
        assert_eq!(std::fs::read(&bad[0]).unwrap(), b"{\"auto\":fal");
        // The closed state replaced the damaged file: the next start is closed too, and says why.
        assert_eq!(load(&path), closed);
        assert_eq!(kept_aside(home).len(), 1, "a readable file is not kept aside again");
        // Saving the settings acknowledges it.
        assert_eq!(get(home), closed);
        assert_eq!(set(home, None, Some(90)).unwrap(), Settings { auto: false, minutes: 90, notice: None });
        assert_eq!(load(&path).notice, None);
        // Something that is no file: closed, nothing to keep.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let s = load(&path);
        assert!(!s.auto && s.notice.is_some_and(|n| n.contains("could not be kept")));
        // A threshold out of range is no damage: it is clamped.
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, br#"{"minutes":0}"#).unwrap();
        assert_eq!(load(&path), Settings { auto: true, minutes: 1, notice: None });
    }

    /// Two devices change the settings at the same moment: neither change is lost, and the file
    /// holds what the daemon holds.
    #[test]
    fn changes_at_the_same_moment_both_stick() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        for round in 1..=20u32 {
            let auto = round % 2 == 0;
            let go = std::sync::Barrier::new(2);
            std::thread::scope(|s| {
                s.spawn(|| {
                    go.wait();
                    set(home, Some(auto), None).unwrap();
                });
                s.spawn(|| {
                    go.wait();
                    set(home, None, Some(round)).unwrap();
                });
            });
            let both = Settings { auto, minutes: round, notice: None };
            assert_eq!(get(home), both, "round {round}");
            assert_eq!(load(&file(home)), both, "round {round}: the file");
        }
    }
}
