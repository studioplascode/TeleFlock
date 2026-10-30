//! omp settings for one agent only (architecture §3.7): model roles (`modelRoles`) and retry
//! fallback chains (`retry.fallbackChains`) that `AgentSpec.roleModels` / `fallbackChains` (or
//! `agent.setRoleModels`) give a single agent, without touching the host's omp config.
//!
//! They reach omp as a per-agent `--config` overlay, `<home>/agent-config/<id>.yml` (0600 in a
//! 0700 folder), passed after TeleFlock's own overlay: omp deep-merges it over the global and
//! project config, and its runtime overrides (`--model`, `PI_SMOL_MODEL`, …) still win. omp reads
//! the file at start (a missing overlay is a hard error) and re-reads it when it changes, so the
//! file exists while the agent does:
//! * written right before `herdr agent start`, deleted again when the launch fails;
//! * rewritten by `agent.setRoleModels` (the bridge then reloads it at once);
//! * kept while the agent is parked, recreated (as a new file of the new agent) on resume;
//! * deleted once the agent is gone from the board (pruned, closed elsewhere): [`Store::sweep`].
//!
//! `<home>/agent-config/agents.json` (0600) is the source of truth: herdr session → agent id →
//! [`Record`] (its overlay file, if its omp process was started with one, and the settings).
//! The YAML files are rendered from it.

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tf_proto::{AgentSpec, ApiError, Millis};
use tracing::{info, warn};

use crate::paths::{create_private_dir, write_atomic, Paths};

/// Folder of the per-agent overlays and their index, under the hostd home.
pub const DIR: &str = "agent-config";
const INDEX: &str = "agents.json";
/// At most this many roles, chain keys and entries per chain.
pub const MAX_ROLES: usize = 64;
pub const MAX_CHAINS: usize = 64;
pub const MAX_CHAIN_LEN: usize = 16;
const MAX_SELECTOR: usize = 256;
/// A record younger than this is never swept: its agent may not be on the board yet.
const SWEEP_GRACE: Duration = Duration::from_secs(5 * 60);
/// An overlay no record names (a launch that crashed between writing and binding it) goes after this.
const ORPHAN_AGE: Duration = Duration::from_secs(60 * 60);

/// One agent's own omp settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentOmp {
    /// Role → `provider/id[:thinking]`.
    pub role_models: BTreeMap<String, String>,
    /// Chain key → fallback selectors, in order.
    pub fallback_chains: BTreeMap<String, Vec<String>>,
}

impl AgentOmp {
    pub fn of(spec: &AgentSpec) -> Self {
        Self { role_models: spec.role_models.clone(), fallback_chains: spec.fallback_chains.clone() }
    }

    pub fn is_empty(&self) -> bool {
        self.role_models.is_empty() && self.fallback_chains.is_empty()
    }

    /// The agent's main model comes from `role_models.default` (then `--model` / `--thinking`
    /// are not passed: omp would apply them as a runtime override above the overlay).
    pub fn sets_default(&self) -> bool {
        self.role_models.contains_key("default")
    }

    /// Checks names and selectors (`invalid_params` naming the first bad one). omp itself checks
    /// that the models exist when it loads them (unknown ones are logged and skipped).
    pub fn validate(&self) -> Result<(), ApiError> {
        if self.role_models.len() > MAX_ROLES {
            return Err(invalid(format!("at most {MAX_ROLES} model roles")));
        }
        for (role, value) in &self.role_models {
            if !role_name_ok(role) {
                return Err(invalid(format!("model role `{}`: names are letters, digits, `-` and `_`, starting with a letter (≤ 32)", clip(role))));
            }
            // omp takes a comma list of candidates for a role.
            if value.split(',').any(|s| !selector_ok(s)) {
                return Err(invalid(format!("model role `{role}`: `{}` is not a `provider/model[:thinking]` selector", clip(value))));
            }
        }
        if self.fallback_chains.len() > MAX_CHAINS {
            return Err(invalid(format!("at most {MAX_CHAINS} fallback chains")));
        }
        for (key, chain) in &self.fallback_chains {
            if !(role_name_ok(key) || selector_ok(key)) {
                return Err(invalid(format!(
                    "fallback chain `{}`: the key is a role, `provider/model`, `provider/*` or `provider/prefix/*`",
                    clip(key)
                )));
            }
            if chain.len() > MAX_CHAIN_LEN {
                return Err(invalid(format!("fallback chain `{key}`: at most {MAX_CHAIN_LEN} fallbacks")));
            }
            if let Some(bad) = chain.iter().find(|s| !selector_ok(s)) {
                return Err(invalid(format!("fallback chain `{key}`: `{}` is not a `provider/model[:thinking]` selector", clip(bad))));
            }
        }
        Ok(())
    }

    /// The overlay omp loads with `--config`: block YAML whose keys and values are JSON strings,
    /// which YAML reads as double-quoted scalars, so no value can break out of its place.
    pub fn overlay_yaml(&self, agent: &str) -> String {
        let agent: String = agent.chars().filter(|c| !c.is_control()).take(64).collect();
        let mut out = format!("# Written by TeleFlock: omp settings for agent {agent} only (omp --config overlay); the host's omp config is unchanged.\n");
        if self.is_empty() {
            out.push_str("{}\n");
            return out;
        }
        if !self.role_models.is_empty() {
            out.push_str("modelRoles:\n");
            for (role, value) in &self.role_models {
                out.push_str(&format!("  {}: {}\n", quote(role), quote(value)));
            }
        }
        if !self.fallback_chains.is_empty() {
            out.push_str("retry:\n  fallbackChains:\n");
            for (key, chain) in &self.fallback_chains {
                if chain.is_empty() {
                    out.push_str(&format!("    {}: []\n", quote(key)));
                    continue;
                }
                out.push_str(&format!("    {}:\n", quote(key)));
                for entry in chain {
                    out.push_str(&format!("      - {}\n", quote(entry)));
                }
            }
        }
        out
    }
}

fn invalid(msg: String) -> ApiError {
    ApiError::new("invalid_params", msg)
}

fn clip(s: &str) -> String {
    let mut out: String = s.chars().take(80).collect();
    if out.len() < s.len() {
        out.push('…');
    }
    out
}

fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string always serializes")
}

/// omp role names: a plain identifier (`designer`, `review-fast`).
pub fn role_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `provider/model[:thinking]`, `provider/*` or `provider/prefix/*`: no whitespace or control
/// characters, a provider and something after it.
pub fn selector_ok(s: &str) -> bool {
    if s.is_empty() || s.len() > MAX_SELECTOR || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    s.split_once('/').is_some_and(|(provider, rest)| !provider.is_empty() && !rest.is_empty())
}

/// What the index keeps per agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    /// File name of the overlay in [`DIR`] that the agent's omp was started with; `None` when it
    /// was started without one (settings given later only apply at runtime and on resume).
    pub file: Option<String>,
    #[serde(flatten)]
    pub omp: AgentOmp,
    /// When the record was last written.
    pub at: Millis,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Index {
    /// herdr session → agent id → record.
    sessions: BTreeMap<String, BTreeMap<String, Record>>,
}

/// An overlay written for a launch that has no agent id yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub path: PathBuf,
}

/// Serializes every read-modify-write of an index (one daemon per home; tests use several homes).
static LOCK: Mutex<()> = Mutex::new(());

/// The per-agent settings of one hostd home. Cheap to create: it is a path.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(paths: &Paths) -> Self {
        Self::at(paths.home.join(DIR))
    }

    pub fn at(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Absolute path of a record's overlay.
    pub fn path_of(&self, rec: &Record) -> Option<PathBuf> {
        rec.file.as_ref().map(|f| self.dir.join(f))
    }

    /// Writes the overlay of an agent about to start (`agent` names it in the file's comment);
    /// `None` when there is nothing to write.
    pub fn prepare(&self, cfg: &AgentOmp, agent: &str) -> io::Result<Option<Launch>> {
        if cfg.is_empty() {
            return Ok(None);
        }
        create_private_dir(&self.dir)?;
        let file = format!("{}.yml", random_id());
        let path = self.dir.join(&file);
        write_atomic(&path, cfg.overlay_yaml(agent).as_bytes())?;
        Ok(Some(Launch { file, path }))
    }

    /// The launch failed: its overlay goes.
    pub fn discard(&self, launch: Launch) {
        remove_file(&launch.path);
    }

    /// The agent started (`launch`: the overlay its omp got): records its settings.
    pub fn bind(&self, session: &str, agent_id: &str, launch: Option<&Launch>, cfg: &AgentOmp, now: Millis) -> io::Result<()> {
        let rec = Record { file: launch.map(|l| l.file.clone()), omp: cfg.clone(), at: now };
        let old = self.edit(|ix| ix.sessions.entry(session.to_string()).or_default().insert(agent_id.to_string(), rec))?;
        // An id herdr reused: the old agent's overlay is nobody's now.
        if let Some(path) = old.as_ref().and_then(|o| o.file.as_ref()).filter(|f| launch.is_none_or(|l| &l.file != *f)) {
            remove_file(&self.dir.join(path));
        }
        Ok(())
    }

    pub fn get(&self, session: &str, agent_id: &str) -> Option<Record> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read().sessions.get(session)?.get(agent_id).cloned()
    }

    /// Replaces an agent's settings (`agent.setRoleModels`), rewriting the overlay its omp watches.
    /// Returns the previous record for [`Store::restore`]. An agent without a record gets one
    /// without a file, so a resume reproduces the settings.
    pub fn set(&self, session: &str, agent_id: &str, cfg: &AgentOmp, agent: &str, now: Millis) -> io::Result<Option<Record>> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut ix = self.read();
        let recs = ix.sessions.entry(session.to_string()).or_default();
        let prev = recs.get(agent_id).cloned();
        let file = prev.as_ref().and_then(|p| p.file.clone());
        if let Some(f) = &file {
            create_private_dir(&self.dir)?;
            write_atomic(&self.dir.join(f), cfg.overlay_yaml(agent).as_bytes())?;
        }
        recs.insert(agent_id.to_string(), Record { file, omp: cfg.clone(), at: now });
        if let Err(e) = self.write(&ix) {
            if let (Some(p), Some(path)) = (&prev, prev.as_ref().and_then(|p| self.path_of(p))) {
                let _ = write_atomic(&path, p.omp.overlay_yaml(agent).as_bytes());
            }
            return Err(e);
        }
        Ok(prev)
    }

    /// Undoes a [`Store::set`] whose change omp refused.
    pub fn restore(&self, session: &str, agent_id: &str, prev: Option<Record>, agent: &str) -> io::Result<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut ix = self.read();
        let recs = ix.sessions.entry(session.to_string()).or_default();
        match prev {
            Some(p) => {
                if let Some(path) = self.path_of(&p) {
                    write_atomic(&path, p.omp.overlay_yaml(agent).as_bytes())?;
                }
                recs.insert(agent_id.to_string(), p);
            }
            None => {
                recs.remove(agent_id);
            }
        }
        self.write(&ix)
    }

    /// Forgets an agent (resumed as another agent, or gone) and deletes its overlay.
    pub fn forget(&self, session: &str, agent_id: &str) -> io::Result<()> {
        let old = self.edit(|ix| {
            let recs = ix.sessions.get_mut(session)?;
            let old = recs.remove(agent_id);
            if recs.is_empty() {
                ix.sessions.remove(session);
            }
            old
        })?;
        if let Some(path) = old.as_ref().and_then(|o| self.path_of(o)) {
            remove_file(&path);
        }
        Ok(())
    }

    /// The agent whose omp was started with overlay `file` (a file name in [`DIR`]), and its record.
    pub fn find_by_file(&self, session: &str, file: &str) -> Option<(String, Record)> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        self.read().sessions.get(session)?.iter().find(|(_, r)| r.file.as_deref() == Some(file)).map(|(id, r)| (id.clone(), r.clone()))
    }

    /// The same omp process runs under a new agent id (herdr restored its pane with the command
    /// it was started with): moves the record and keeps its overlay, whose path that command
    /// names. A record `new_id` had with another overlay goes with its file. False when `old_id`
    /// has no record.
    pub fn rebind(&self, session: &str, old_id: &str, new_id: &str, now: Millis) -> io::Result<bool> {
        let (moved, displaced) = self.edit(|ix| {
            let Some(recs) = ix.sessions.get_mut(session) else { return (false, None) };
            let Some(mut rec) = recs.remove(old_id) else { return (false, None) };
            rec.at = now;
            let file = rec.file.clone();
            let displaced = recs.insert(new_id.to_string(), rec).filter(|d| d.file != file);
            (true, displaced)
        })?;
        if let Some(path) = displaced.as_ref().and_then(|d| self.path_of(d)) {
            remove_file(&path);
        }
        Ok(moved)
    }

    /// Drops the records (and overlays) of `session`'s agents that `keep` (every agent id the
    /// board knows) no longer names, past [`SWEEP_GRACE`], and overlays no record names past
    /// [`ORPHAN_AGE`]. Returns how many records went.
    pub fn sweep(&self, session: &str, keep: &HashSet<String>, now: Millis) -> usize {
        let grace = SWEEP_GRACE.as_millis() as Millis;
        let swept = self.edit(|ix| {
            let Some(recs) = ix.sessions.get_mut(session) else { return Vec::new() };
            let gone: Vec<String> = recs.iter().filter(|(id, r)| !keep.contains(*id) && now - r.at > grace).map(|(id, _)| id.clone()).collect();
            let out: Vec<(String, Record)> = gone.into_iter().filter_map(|id| recs.remove(&id).map(|r| (id, r))).collect();
            if recs.is_empty() {
                ix.sessions.remove(session);
            }
            out
        });
        let swept = match swept {
            Ok(s) => s,
            Err(e) => {
                warn!(dir = %self.dir.display(), "agent overlays: {e}");
                return 0;
            }
        };
        for (id, rec) in &swept {
            info!(session, agent = %id, "per-agent omp settings dropped: the agent is gone");
            if let Some(path) = self.path_of(rec) {
                remove_file(&path);
            }
        }
        self.sweep_orphans(now);
        swept.len()
    }

    fn sweep_orphans(&self, now: Millis) {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let named: HashSet<String> = self.read().sessions.values().flat_map(|r| r.values().filter_map(|r| r.file.clone())).collect();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return };
        let age = ORPHAN_AGE.as_millis() as Millis;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".yml") || named.contains(&name) {
                continue;
            }
            let modified = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
            if modified.is_some_and(|m| now - m.as_millis() as Millis > age) {
                remove_file(&e.path());
            }
        }
    }

    /// Read-modify-write of the index under [`LOCK`]; written only when `f` changed something.
    fn edit<T>(&self, f: impl FnOnce(&mut Index) -> T) -> io::Result<T> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut ix = self.read();
        let before = serde_json::to_vec(&ix).unwrap_or_default();
        let out = f(&mut ix);
        if serde_json::to_vec(&ix).unwrap_or_default() != before {
            self.write(&ix)?;
        }
        Ok(out)
    }

    /// The index; empty when missing. An unreadable one is set aside, never overwritten blindly.
    fn read(&self) -> Index {
        let path = self.dir.join(INDEX);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                let bad = self.dir.join(format!("{INDEX}.bad-{}", crate::util::now_ms()));
                warn!(path = %path.display(), "agent overlays index unreadable ({e}); moved to {}", bad.display());
                let _ = std::fs::rename(&path, &bad);
                Index::default()
            }),
            Err(_) => Index::default(),
        }
    }

    fn write(&self, ix: &Index) -> io::Result<()> {
        create_private_dir(&self.dir)?;
        let bytes = serde_json::to_vec(ix).map_err(io::Error::other)?;
        write_atomic(&self.dir.join(INDEX), &bytes)
    }
}

fn remove_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => warn!(path = %path.display(), "removing a per-agent omp overlay: {e}"),
    }
}

fn random_id() -> String {
    let mut b = [0u8; 8];
    match getrandom::fill(&mut b) {
        Ok(()) => b.iter().map(|x| format!("{x:02x}")).collect(),
        Err(_) => crate::util::new_id("a"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(roles: &[(&str, &str)], chains: &[(&str, &[&str])]) -> AgentOmp {
        AgentOmp {
            role_models: roles.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            fallback_chains: chains.iter().map(|(k, v)| (k.to_string(), v.iter().map(|s| s.to_string()).collect())).collect(),
        }
    }

    #[test]
    fn overlay_yaml_quotes_every_key_and_value() {
        let c = cfg(
            &[("smol", "openai/gpt-5-mini:low"), ("task", "anthropic/claude-sonnet-5"), ("default", "ollama/llama3:8b")],
            &[("default", &["openai/gpt-5-mini", "mock/m2:high"]), ("google-antigravity/*", &["google/*"]), ("mock/m1", &[])],
        );
        let yaml = c.overlay_yaml("lab-1");
        assert_eq!(
            yaml,
            "# Written by TeleFlock: omp settings for agent lab-1 only (omp --config overlay); the host's omp config is unchanged.\n\
             modelRoles:\n  \"default\": \"ollama/llama3:8b\"\n  \"smol\": \"openai/gpt-5-mini:low\"\n  \"task\": \"anthropic/claude-sonnet-5\"\n\
             retry:\n  fallbackChains:\n    \"default\":\n      - \"openai/gpt-5-mini\"\n      - \"mock/m2:high\"\n\
             \x20   \"google-antigravity/*\":\n      - \"google/*\"\n    \"mock/m1\": []\n"
        );
        // Characters YAML gives a meaning to stay inside their double-quoted scalar.
        let tricky = cfg(&[("x", "p/a\"b\\c#d: e")], &[]);
        assert!(tricky.overlay_yaml("a\nb").contains("  \"x\": \"p/a\\\"b\\\\c#d: e\"\n"));
        assert!(tricky.overlay_yaml("a\nb").starts_with("# Written by TeleFlock: omp settings for agent ab only"));
        assert!(AgentOmp::default().overlay_yaml("x").ends_with("{}\n"));
        // Only roles: no `retry` section (the host's other retry settings stay as they are).
        assert!(!cfg(&[("smol", "a/b")], &[]).overlay_yaml("x").contains("retry"));
    }

    #[test]
    fn validation() {
        assert!(cfg(&[("smol", "a/b:low"), ("designer", "x/y,z/w")], &[("task", &["a/*", "o/google/*"]), ("a/b:high", &[])]).validate().is_ok());
        let bad = |c: AgentOmp| c.validate().unwrap_err().message;
        assert!(bad(cfg(&[("1st", "a/b")], &[])).contains("model role `1st`"));
        assert!(bad(cfg(&[("smol", "gpt-5")], &[])).contains("not a `provider/model[:thinking]` selector"));
        assert!(bad(cfg(&[("smol", "a/b c")], &[])).contains("smol"));
        assert!(bad(cfg(&[("smol", "a/b,")], &[])).contains("smol"));
        assert!(bad(cfg(&[], &[("bad key", &["a/b"])])).contains("the key is a role"));
        assert!(bad(cfg(&[], &[("default", &["/b"])])).contains("fallback chain `default`"));
        let long: Vec<&str> = vec!["a/b"; MAX_CHAIN_LEN + 1];
        assert!(bad(cfg(&[], &[("default", &long)])).contains("at most 16"));
        assert!(role_name_ok("review-fast") && !role_name_ok("__proto__") && !role_name_ok(&"a".repeat(33)));
    }

    #[test]
    fn store_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join(DIR));
        let c = cfg(&[("smol", "a/b")], &[]);
        assert!(store.prepare(&AgentOmp::default(), "x").unwrap().is_none());
        let launch = store.prepare(&c, "lab").unwrap().unwrap();
        assert!(std::fs::read_to_string(&launch.path).unwrap().contains("\"smol\": \"a/b\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&launch.path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(store.dir()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        store.bind("default", "t1", Some(&launch), &c, 1_000).unwrap();
        let rec = store.get("default", "t1").unwrap();
        assert_eq!((rec.file.as_deref(), &rec.omp), (Some(launch.file.as_str()), &c));

        // A running-session change rewrites the watched file; a refused one is undone.
        let c2 = cfg(&[("smol", "a/c")], &[("default", &["a/d"])]);
        let prev = store.set("default", "t1", &c2, "lab", 2_000).unwrap();
        assert!(std::fs::read_to_string(&launch.path).unwrap().contains("\"default\":\n      - \"a/d\""));
        store.restore("default", "t1", prev, "lab").unwrap();
        assert_eq!(store.get("default", "t1").unwrap().omp, c);
        assert!(!std::fs::read_to_string(&launch.path).unwrap().contains("retry"));

        // An agent started without an overlay keeps its settings for a resume, with no file.
        assert_eq!(store.set("default", "t2", &c2, "other", 2_000).unwrap(), None);
        assert_eq!(store.get("default", "t2").unwrap().file, None);

        // Sweep: gone agents past the grace go with their file; kept and young ones stay.
        let grace = SWEEP_GRACE.as_millis() as Millis;
        let keep: HashSet<String> = ["t2".to_string()].into();
        assert_eq!(store.sweep("default", &keep, 1_000 + grace), 0);
        assert_eq!(store.sweep("default", &keep, 2_001 + grace), 1);
        assert!(store.get("default", "t1").is_none() && !launch.path.exists());
        assert!(store.get("default", "t2").is_some());
        store.forget("default", "t2").unwrap();
        assert!(store.get("default", "t2").is_none());

        // herdr restored a pane with the same command: the record follows the new id, file kept.
        let l = store.prepare(&c, "lab").unwrap().unwrap();
        store.bind("default", "t3", Some(&l), &c, 3_000).unwrap();
        assert_eq!(store.find_by_file("default", &l.file).map(|(id, _)| id).as_deref(), Some("t3"));
        assert!(store.rebind("default", "t3", "t4", 4_000).unwrap());
        assert!(store.get("default", "t3").is_none() && l.path.exists());
        let rec = store.get("default", "t4").unwrap();
        assert_eq!((rec.file.as_deref(), rec.at), (Some(l.file.as_str()), 4_000));
        assert!(!store.rebind("default", "t3", "t5", 5_000).unwrap());
        store.forget("default", "t4").unwrap();
        assert!(!l.path.exists());

        // A failed launch leaves nothing.
        let l = store.prepare(&c, "x").unwrap().unwrap();
        store.discard(l.clone());
        assert!(!l.path.exists());
    }

    #[test]
    fn orphans_and_a_broken_index() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::at(tmp.path().join(DIR));
        let c = cfg(&[("smol", "a/b")], &[]);
        let orphan = store.prepare(&c, "x").unwrap().unwrap();
        let now = crate::util::now_ms();
        store.sweep("default", &HashSet::new(), now);
        assert!(orphan.path.exists(), "a fresh overlay may belong to a launch in flight");
        store.sweep("default", &HashSet::new(), now + ORPHAN_AGE.as_millis() as Millis + 1_000);
        assert!(!orphan.path.exists());

        std::fs::write(store.dir().join(INDEX), b"{not json").unwrap();
        assert!(store.get("default", "t1").is_none());
        assert!(std::fs::read_dir(store.dir()).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("agents.json.bad-")));
        store.bind("default", "t1", None, &c, 1).unwrap();
        assert_eq!(store.get("default", "t1").unwrap().omp, c);
    }
}
