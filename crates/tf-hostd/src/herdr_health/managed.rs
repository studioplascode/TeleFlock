//! The herdr config of the servers TeleFlock starts (architecture §3.29): `<home>/herdr-config.toml`,
//! passed as `HERDR_CONFIG_PATH`. It is the user's own `config.toml` with
//! `[session] resume_agents_on_restore = false`, so after a restart herdr restores every pane as a
//! shell and TeleFlock relaunches the agents with its own flags (overlay, bridge, the agent's own
//! settings, its name) instead of herdr typing a plain `omp --resume=<file>`. The user's file is
//! never written. Relative sound paths are made absolute (herdr resolves them next to the config).
//!
//! herdr 0.9.5's server only reads its config. Its settings screen (theme, status indicators,
//! sound, toast delivery, onboarding) and `herdr channel set` write the config of the process
//! that runs them: `$HERDR_CONFIG_PATH`, else `~/.config/herdr/config.toml`. A herdr started in a
//! pane of a managed server inherits `HERDR_CONFIG_PATH`, so its writes land in the managed copy.
//! The copy therefore carries a checksum of what TeleFlock wrote: a copy that no longer matches
//! was edited, and TeleFlock then keeps it as it is and stops syncing ([`Managed::edited`]).

use std::path::{Path, PathBuf};

use toml_edit::{DocumentMut, Item, value};

pub const FILE: &str = "herdr-config.toml";
pub const ENV: &str = "HERDR_CONFIG_PATH";
/// The header line that carries the checksum of everything below it.
const MARK: &str = "# teleflock-sum: ";

/// Checksum of the config text TeleFlock wrote (SHA-256, first 16 hex digits).
fn body_sum(body: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(body.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The config file herdr would read for the user: `$HERDR_CONFIG_PATH` when the daemon has one of
/// its own (not ours), else `<herdr config dir>/config.toml`.
pub fn user_config_path(managed: &Path) -> PathBuf {
    match std::env::var_os(ENV).map(PathBuf::from) {
        Some(p) if !p.as_os_str().is_empty() && p != managed => p,
        _ => tf_herdr::config_dir().join("config.toml"),
    }
}

/// The managed config for the user's config text (`None`: the user has none).
pub fn render(user: Option<&str>, user_path: &Path) -> String {
    let mut doc = user.and_then(|t| t.parse::<DocumentMut>().ok()).unwrap_or_default();
    if let Some(dir) = user_path.parent()
        && let Some(sound) = doc.get_mut("ui").and_then(|u| u.get_mut("sound"))
    {
        for key in ["path", "done_path", "request_path"] {
            if let Some(item) = sound.get_mut(key)
                && let Some(s) = item.as_str()
                && Path::new(s).is_relative()
            {
                *item = value(dir.join(s).display().to_string());
            }
        }
    }
    let session = doc.entry("session").or_insert(toml_edit::table());
    if !session.is_table_like() {
        *session = toml_edit::table();
    }
    session["resume_agents_on_restore"] = value(false);
    let source = user_path.display().to_string().replace(['\n', '\r'], " ");
    let body = doc.to_string();
    format!(
        "# Written by TeleFlock (tf-hostd) for the herdr servers it starts: your herdr config\n\
         # ({source}) with session.resume_agents_on_restore = false, so TeleFlock relaunches\n\
         # agents after a restart. Edit your own config; TeleFlock copies it here.\n\
         # If you edit this file, TeleFlock keeps your edit and stops copying; delete it to start over.\n\
         {MARK}{}\n{body}",
        body_sum(&body)
    )
}

/// herdr's `session.resume_agents_on_restore` in a config text (default on).
pub fn resumes_agents(text: Option<&str>) -> bool {
    let Some(doc) = text.and_then(|t| t.parse::<DocumentMut>().ok()) else { return true };
    doc.get("session").and_then(|s| s.get("resume_agents_on_restore")).and_then(Item::as_bool).unwrap_or(true)
}

type Stamp = Option<(u64, std::time::SystemTime)>;

fn stamp(path: &Path) -> Stamp {
    std::fs::metadata(path).ok().and_then(|m| Some((m.len(), m.modified().ok()?)))
}

/// Whether `text`, the content of the managed file, is what TeleFlock wrote.
pub fn written_by_teleflock(text: &str) -> bool {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if let Some(sum) = line.trim_end().strip_prefix(MARK) {
            return body_sum(&text[offset + line.len()..]) == sum;
        }
        if !line.starts_with('#') {
            break;
        }
        offset += line.len();
    }
    // No checksum: an empty file, or the unchecked format TeleFlock wrote before.
    text.trim().is_empty() || text.starts_with("# Written by TeleFlock")
}

/// Keeps `<home>/herdr-config.toml` equal to the rendering of the user's config, unless the copy
/// was edited since TeleFlock wrote it.
#[derive(Debug)]
pub struct Managed {
    pub path: PathBuf,
    pub user: PathBuf,
    seen: Option<(Stamp, Stamp)>,
    edited: bool,
}

impl Managed {
    pub fn new(home: &Path) -> Managed {
        let path = home.join(FILE);
        let user = user_config_path(&path);
        Managed { path, user, seen: None, edited: false }
    }

    /// The managed copy was edited after TeleFlock wrote it: it is kept and no longer synced.
    /// Deleting the file starts over.
    pub fn edited(&self) -> bool {
        self.edited
    }

    /// Rewrites the managed file when the user's config changed since the last call (or the file
    /// is missing or differs from what TeleFlock wrote). Never replaces a copy someone edited.
    /// True when the file changed.
    pub fn sync(&mut self) -> std::io::Result<bool> {
        let (user, out) = (stamp(&self.user), stamp(&self.path));
        if self.seen == Some((user, out)) && out.is_some() {
            return Ok(false);
        }
        let on_disk = match std::fs::read(&self.path) {
            Ok(bytes) => Some(String::from_utf8(bytes).ok()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        // Not UTF-8 is someone's edit too.
        self.edited = on_disk.as_ref().is_some_and(|t| !t.as_deref().is_some_and(written_by_teleflock));
        if self.edited {
            self.seen = Some((user, out));
            return Ok(false);
        }
        let text = std::fs::read_to_string(&self.user).ok();
        let rendered = render(text.as_deref(), &self.user);
        if on_disk.flatten().as_deref() == Some(rendered.as_str()) {
            self.seen = Some((user, out));
            return Ok(false);
        }
        crate::paths::write_atomic(&self.path, rendered.as_bytes())?;
        self.seen = Some((user, stamp(&self.path)));
        Ok(true)
    }

    /// The launch of a server TeleFlock starts: the managed config, current. Without it (the file
    /// cannot be written) herdr reads the user's config and relaunches agents itself.
    pub fn launch(&mut self) -> tf_herdr::ServerLaunch {
        match self.sync() {
            Ok(_) => tf_herdr::ServerLaunch { env: vec![(ENV.to_string(), self.path.display().to_string())] },
            Err(e) => {
                tracing::warn!(file = %self.path.display(), "cannot write herdr's managed config ({e}); the server uses the user's config");
                tf_herdr::ServerLaunch::default()
            }
        }
    }

    /// Whether a server started with config `server_config` (its `HERDR_CONFIG_PATH`, `None`: unset)
    /// relaunches agents itself. The managed copy is read too: an edit may have turned it on.
    pub fn server_resumes(&self, server_config: Option<&str>) -> bool {
        let path = match server_config.filter(|p| !p.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => tf_herdr::config_dir().join("config.toml"),
        };
        resumes_agents(std::fs::read_to_string(path).ok().as_deref())
    }
}

/// The launch for a server TeleFlock starts outside the health worker (context start, Host setup).
pub fn launch(home: &Path) -> tf_herdr::ServerLaunch {
    Managed::new(home).launch()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_users_config_with_resume_off() {
        let user = Path::new("/home/u/.config/herdr/config.toml");
        let out = render(None, user);
        assert!(!resumes_agents(Some(&out)));
        assert!(out.starts_with("# Written by TeleFlock"));

        let text = "# mine\ntheme = \"dark\"\n\n[session]\nresume_agents_on_restore = true\nstartup_per_agent_delay_ms = 250\n\n[ui.sound]\npath = \"ding.mp3\"\ndone_path = \"/abs/done.mp3\"\n";
        let out = render(Some(text), user);
        let doc: DocumentMut = out.parse().unwrap();
        assert_eq!(doc["theme"].as_str(), Some("dark"));
        assert_eq!(doc["session"]["resume_agents_on_restore"].as_bool(), Some(false));
        assert_eq!(doc["session"]["startup_per_agent_delay_ms"].as_integer(), Some(250));
        assert_eq!(doc["ui"]["sound"]["path"].as_str(), Some("/home/u/.config/herdr/ding.mp3"));
        assert_eq!(doc["ui"]["sound"]["done_path"].as_str(), Some("/abs/done.mp3"));
        assert!(out.contains("# mine"), "comments stay");

        // Dotted and inline forms, and a broken file (herdr would use its defaults).
        for text in ["session.resume_agents_on_restore = true\n", "session = { resume_agents_on_restore = true }\n", "session = 3\n", "[[[broken"] {
            let out = render(Some(text), user);
            assert!(!resumes_agents(Some(&out)), "{text:?} → {out}");
        }
    }

    #[test]
    fn reads_herdrs_own_setting() {
        assert!(resumes_agents(None));
        assert!(resumes_agents(Some("theme = \"x\"\n")));
        assert!(resumes_agents(Some("[session]\nresume_agents_on_restore = true\n")));
        assert!(!resumes_agents(Some("[session]\nresume_agents_on_restore = false\n")));
        assert!(resumes_agents(Some("[[[broken")));
    }

    #[test]
    fn sync_writes_only_on_change_and_never_the_users_file() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "theme = \"a\"\n").unwrap();
        let mut m = Managed { path: dir.path().join(FILE), user: user.clone(), seen: None, edited: false };
        assert!(m.sync().unwrap());
        assert!(!m.sync().unwrap());
        let first = std::fs::read_to_string(&m.path).unwrap();
        assert!(first.contains("theme = \"a\"") && !resumes_agents(Some(&first)));
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&user, "theme = \"b\"\n").unwrap();
        assert!(m.sync().unwrap());
        assert!(std::fs::read_to_string(&m.path).unwrap().contains("theme = \"b\""));
        assert_eq!(std::fs::read_to_string(&user).unwrap(), "theme = \"b\"\n");
        let launch = m.launch();
        assert_eq!(launch.env, vec![(ENV.to_string(), m.path.display().to_string())]);
        assert!(!m.server_resumes(Some(&m.path.display().to_string())));
    }

    #[test]
    fn an_edited_managed_copy_is_kept_and_not_synced() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "theme = \"a\"\n").unwrap();
        let mut m = Managed { path: dir.path().join(FILE), user: user.clone(), seen: None, edited: false };
        assert!(m.sync().unwrap());
        assert!(written_by_teleflock(&std::fs::read_to_string(&m.path).unwrap()));
        assert!(!m.edited());
        // herdr's settings screen, run in a pane of the server, saves into the managed copy.
        let mut text = std::fs::read_to_string(&m.path).unwrap();
        text.push_str("[ui]\ntoast_delivery = \"system\"\n");
        std::fs::write(&m.path, &text).unwrap();
        // The user's own config changes too: the edit still wins, nothing is rewritten.
        std::fs::write(&user, "theme = \"b-longer\"\n").unwrap();
        assert!(!m.sync().unwrap());
        assert!(m.edited());
        assert_eq!(std::fs::read_to_string(&m.path).unwrap(), text);
        assert!(m.launch().env.len() == 1, "the server still reads the managed copy");
        // A fresh worker (after a restart of hostd) judges the same way: the checksum is in the file.
        let mut again = Managed { path: m.path.clone(), user: user.clone(), seen: None, edited: false };
        assert!(!again.sync().unwrap());
        assert!(again.edited());
        assert_eq!(std::fs::read_to_string(&m.path).unwrap(), text);
        // Deleting the copy starts over.
        std::fs::remove_file(&m.path).unwrap();
        assert!(m.sync().unwrap());
        assert!(!m.edited());
        assert!(std::fs::read_to_string(&m.path).unwrap().contains("theme = \"b-longer\""));
    }

    #[test]
    fn a_foreign_or_edited_file_is_never_overwritten_but_old_and_empty_ones_are() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("config.toml");
        std::fs::write(&user, "theme = \"a\"\n").unwrap();
        let path = dir.path().join(FILE);
        let new = || Managed { path: path.clone(), user: user.clone(), seen: None, edited: false };
        std::fs::write(&path, "theme = \"mine\"\n").unwrap();
        let mut m = new();
        assert!(!m.sync().unwrap() && m.edited());
        // Written by an earlier TeleFlock without a checksum: ours.
        std::fs::write(&path, "# Written by TeleFlock (tf-hostd) for the herdr servers it starts\nx = 1\n").unwrap();
        assert!(new().sync().unwrap());
        std::fs::write(&path, "").unwrap();
        assert!(new().sync().unwrap());
        // The checksum covers only the body: header words may change, the body may not.
        let ok = std::fs::read_to_string(&path).unwrap();
        assert!(written_by_teleflock(&ok.replace("# Written by TeleFlock", "# Written by TeleFlock!")));
        assert!(!written_by_teleflock(&ok.replace("resume_agents_on_restore = false", "resume_agents_on_restore = true")));
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        assert!(!new().sync().unwrap());
    }
    #[test]
    fn a_server_that_reads_the_managed_copy_follows_what_it_says() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = Managed { path: dir.path().join(FILE), user: dir.path().join("config.toml"), seen: None, edited: false };
        m.sync().unwrap();
        let path = m.path.display().to_string();
        assert!(!m.server_resumes(Some(&path)));
        std::fs::write(&m.path, "[session]\nresume_agents_on_restore = true\n").unwrap();
        assert!(m.server_resumes(Some(&path)), "an edit that turned herdr's own resume on is respected");
    }
}
