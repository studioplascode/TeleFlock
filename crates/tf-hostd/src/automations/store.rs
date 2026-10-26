//! `<home>/automations.json`: automation definitions, run history and per-automation schedule
//! cursors. Owner-only (0600), written atomically after every change.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::warn;

use tf_proto::{Automation, AutomationDraft, AutomationRun, Millis};

use super::cron::Cron;

/// Runs kept per host (every herdr session together), newest first.
pub const RUN_CAP: usize = 100;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreData {
    #[serde(default)]
    pub automations: Vec<Automation>,
    /// Newest first, ≤ [`RUN_CAP`].
    #[serde(default)]
    pub runs: Vec<AutomationRun>,
    /// Automation id → the latest schedule time already handled (fired, skipped or deliberately
    /// passed over). Scheduled times after it are due; saving an automation moves it to now so
    /// edits never fire past times.
    #[serde(default)]
    pub scheduled_through: BTreeMap<String, Millis>,
}

impl StoreData {
    pub fn load(path: &Path) -> StoreData {
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<StoreData>(&bytes) {
                Ok(mut d) => {
                    for a in &mut d.automations {
                        a.next_run_at = None;
                        a.last_run = None;
                    }
                    d
                }
                Err(e) => {
                    // Keep the unreadable file for the user; start empty.
                    let aside = path.with_extension(format!("json.bad-{}", crate::util::now_ms()));
                    warn!(path = %path.display(), "unreadable automations file ({e}); moved to {}", aside.display());
                    let _ = std::fs::rename(path, &aside);
                    StoreData::default()
                }
            },
            Err(_) => StoreData::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::paths::write_atomic(path, &bytes)
    }

    pub fn get(&self, id: &str) -> Option<&Automation> {
        self.automations.iter().find(|a| a.id == id)
    }

    /// Records a run (newest first, capped).
    pub fn push_run(&mut self, run: AutomationRun) {
        self.runs.insert(0, run);
        self.runs.truncate(RUN_CAP);
    }

    pub fn last_run(&self, automation_id: &str) -> Option<&AutomationRun> {
        self.runs.iter().find(|r| r.automation_id == automation_id)
    }

    /// The last run that started an agent.
    pub fn last_started(&self, automation_id: &str) -> Option<&AutomationRun> {
        self.runs
            .iter()
            .find(|r| r.automation_id == automation_id && r.status == tf_proto::AutomationRunStatus::Started && r.agent_id.is_some())
    }

    /// Removes an automation and its cursor; its runs stay in the history until they age out.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.automations.len();
        self.automations.retain(|a| a.id != id);
        self.scheduled_through.remove(id);
        self.automations.len() != before
    }

    pub fn any_enabled(&self) -> bool {
        self.automations.iter().any(|a| a.enabled)
    }
}

/// Checks a draft; returns the normalized draft. `cwd` must be an existing folder; it is
/// stored with `~` expanded.
pub fn validate(mut d: AutomationDraft) -> Result<AutomationDraft, String> {
    d.name = d.name.trim().to_string();
    if d.name.is_empty() {
        return Err("Give the automation a name.".into());
    }
    if d.name.chars().count() > 80 {
        return Err("Names are at most 80 characters.".into());
    }
    d.schedule = d.schedule.split_whitespace().collect::<Vec<_>>().join(" ");
    let cron = Cron::parse(&d.schedule)?;
    if cron.next_after(crate::util::now_ms(), &super::cron::local_tz()).is_none() {
        return Err(format!("`{}` never runs", d.schedule));
    }
    let cwd = d.cwd.trim();
    if cwd.is_empty() {
        return Err(if d.worktree { "Pick a repository." } else { "Pick a folder." }.into());
    }
    let path: PathBuf = crate::paths::expand_tilde(cwd);
    if !path.is_absolute() {
        return Err(format!("`{cwd}` is not an absolute path"));
    }
    if !path.is_dir() {
        return Err(format!("{} is not a folder on this host", path.display()));
    }
    d.cwd = path.display().to_string();
    if d.worktree && !is_in_git_repo(&path) {
        return Err(format!("{} is not inside a git repository (turn off “new worktree” to run in the folder itself)", d.cwd));
    }
    d.prompt = d.prompt.trim().to_string();
    if d.prompt.is_empty() && !d.plan {
        return Err("Write the prompt the agent starts with.".into());
    }
    d.model = d.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    Ok(d)
}

/// Whether `path` or one of its parents holds `.git` (a dir, or a file in linked worktrees).
fn is_in_git_repo(path: &Path) -> bool {
    path.ancestors().any(|p| p.join(".git").exists())
}

/// `[a-z0-9-]` slug of a name for branch and agent names (≤ 24 chars, never empty).
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "run".to_string() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{AutomationRunStatus, AutomationTrigger};

    fn draft(dir: &Path) -> AutomationDraft {
        AutomationDraft {
            id: None,
            name: "  Nightly audit ".into(),
            enabled: true,
            schedule: " 0  3 * * * ".into(),
            cwd: dir.display().to_string(),
            worktree: false,
            prompt: " Check deps ".into(),
            model: Some(" ".into()),
            thinking: None,
            plan: false,
            catch_up: true,
        }
    }

    fn run(id: &str, auto: &str) -> AutomationRun {
        AutomationRun {
            id: id.into(),
            automation_id: auto.into(),
            at: 1,
            trigger: AutomationTrigger::Schedule,
            status: AutomationRunStatus::Started,
            agent_id: Some(format!("ag-{id}")),
            workspace_id: None,
            branch: None,
            path: None,
            error: None,
        }
    }

    #[test]
    fn validation_normalizes_and_rejects() {
        let dir = tempfile::tempdir().unwrap();
        let d = validate(draft(dir.path())).unwrap();
        assert_eq!(d.name, "Nightly audit");
        assert_eq!(d.schedule, "0 3 * * *");
        assert_eq!(d.prompt, "Check deps");
        assert_eq!(d.model, None);

        let bad = |f: &dyn Fn(&mut AutomationDraft)| {
            let mut d = draft(dir.path());
            f(&mut d);
            validate(d).unwrap_err()
        };
        assert!(bad(&|d| d.name = " ".into()).contains("name"));
        assert!(bad(&|d| d.schedule = "61 * * * *".into()).contains("out of range"));
        assert!(bad(&|d| d.schedule = "0 0 31 2 *".into()).contains("never runs"));
        assert!(bad(&|d| d.cwd = "/definitely/not/here".into()).contains("not a folder"));
        assert!(bad(&|d| d.cwd = "relative/dir".into()).contains("absolute"));
        assert!(bad(&|d| d.prompt = "".into()).contains("prompt"));
        assert!(bad(&|d| d.worktree = true).contains("git repository"));
        // Plan mode may start without a prompt.
        let mut d = draft(dir.path());
        d.prompt = String::new();
        d.plan = true;
        assert!(validate(d).is_ok());
        // Worktree mode inside a repo.
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let mut d = draft(&dir.path().join("sub"));
        d.worktree = true;
        assert!(validate(d).is_ok());
    }

    #[test]
    fn round_trip_and_history_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("automations.json");
        let mut data = StoreData::default();
        let d = validate(draft(dir.path())).unwrap();
        data.automations.push(Automation {
            id: "au1".into(),
            name: d.name,
            enabled: true,
            schedule: d.schedule,
            cwd: d.cwd,
            worktree: false,
            prompt: d.prompt,
            model: None,
            thinking: Some(tf_proto::ThinkingLevel::High),
            plan: false,
            catch_up: true,
            herdr_session: "tf-lab".into(),
            created_at: 1,
            updated_at: 2,
            next_run_at: None,
            last_run: None,
        });
        data.scheduled_through.insert("au1".into(), 1234);
        for i in 0..(RUN_CAP + 5) {
            data.push_run(run(&format!("r{i}"), "au1"));
        }
        assert_eq!(data.runs.len(), RUN_CAP);
        assert_eq!(data.runs[0].id, format!("r{}", RUN_CAP + 4));
        data.save(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let back = StoreData::load(&path);
        assert_eq!(back, data);
        assert_eq!(back.last_started("au1").unwrap().id, format!("r{}", RUN_CAP + 4));

        // Corrupt file: set aside, start empty.
        std::fs::write(&path, b"{nope").unwrap();
        assert_eq!(StoreData::load(&path), StoreData::default());
        assert!(!path.exists());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Nightly dependency audit!"), "nightly-dependency-audit");
        assert_eq!(slug("  ** "), "run");
        assert_eq!(slug("Ünïcode café 2"), "n-code-caf-2");
        assert!(slug("a very long automation name that keeps going").len() <= 24);
    }
}
