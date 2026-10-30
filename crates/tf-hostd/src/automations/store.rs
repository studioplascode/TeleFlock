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
    /// Automation id → the agent its latest run started (the pile-up guard's subject), kept
    /// apart from `runs` so it never ages out of the capped history.
    #[serde(default)]
    pub last_started: BTreeMap<String, StartedAgent>,
    /// Automation id → its current run of identical skips (collapsed into one history entry).
    #[serde(default)]
    pub skip_streaks: BTreeMap<String, SkipStreak>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedAgent {
    pub run_id: String,
    pub agent_id: String,
    pub at: Millis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipStreak {
    /// The history entry that stands for the whole streak.
    pub run_id: String,
    /// Why (as the first skip said it).
    pub reason: String,
    pub count: u32,
    pub first_at: Millis,
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
                    // Files from before `lastStarted`: the newest started run still in the history.
                    for r in d.runs.iter().rev() {
                        if r.status == tf_proto::AutomationRunStatus::Started
                            && let Some(agent_id) = &r.agent_id
                            && d.last_started.get(&r.automation_id).is_none_or(|s| s.at <= r.at)
                        {
                            d.last_started.insert(r.automation_id.clone(), StartedAgent { run_id: r.id.clone(), agent_id: agent_id.clone(), at: r.at });
                        }
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

    /// Records a run (newest first, capped) and returns it as stored. A skip for the same reason
    /// as the automation's newest run (itself such a skip) is folded into that entry: it moves to
    /// the top with the latest time and says how many ticks were skipped in a row, so a
    /// long-blocked agent does not flood the shared history.
    pub fn push_run(&mut self, mut run: AutomationRun) -> AutomationRun {
        use tf_proto::AutomationRunStatus as S;
        let auto = run.automation_id.clone();
        if run.status == S::Skipped {
            let reason = run.error.clone().unwrap_or_default();
            let newest = self.runs.iter().position(|r| r.automation_id == auto);
            let streak = self.skip_streaks.get(&auto).filter(|s| s.reason == reason && newest.is_some_and(|i| self.runs[i].id == s.run_id)).cloned();
            let streak = match (streak, newest) {
                (Some(mut s), Some(i)) => {
                    self.runs.remove(i);
                    s.count += 1;
                    run.id = s.run_id.clone();
                    run.error = Some(format!("{reason} (skipped {} times in a row since {})", s.count, clock(s.first_at)));
                    s
                }
                _ => SkipStreak { run_id: run.id.clone(), reason, count: 1, first_at: run.at },
            };
            self.skip_streaks.insert(auto, streak);
        } else {
            self.skip_streaks.remove(&auto);
            if run.status == S::Started
                && let Some(agent_id) = &run.agent_id
            {
                self.last_started.insert(auto, StartedAgent { run_id: run.id.clone(), agent_id: agent_id.clone(), at: run.at });
            }
        }
        self.runs.insert(0, run.clone());
        self.runs.truncate(RUN_CAP);
        run
    }

    pub fn last_run(&self, automation_id: &str) -> Option<&AutomationRun> {
        self.runs.iter().find(|r| r.automation_id == automation_id)
    }

    /// The agent the automation's latest started run launched.
    pub fn last_started(&self, automation_id: &str) -> Option<&StartedAgent> {
        self.last_started.get(automation_id)
    }

    /// Removes an automation and its cursor; its runs stay in the history until they age out.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.automations.len();
        self.automations.retain(|a| a.id != id);
        self.scheduled_through.remove(id);
        self.last_started.remove(id);
        self.skip_streaks.remove(id);
        self.automations.len() != before
    }

    pub fn any_enabled(&self) -> bool {
        self.automations.iter().any(|a| a.enabled)
    }
}

/// `Mon 09:15` in the host's time zone.
fn clock(ms: Millis) -> String {
    jiff::Timestamp::from_millisecond(ms).map(|t| t.to_zoned(super::cron::local_tz()).strftime("%a %H:%M").to_string()).unwrap_or_default()
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
    let own = crate::agentcfg::AgentOmp { role_models: d.role_models.clone(), fallback_chains: d.fallback_chains.clone() };
    own.validate().map_err(|e| e.message)?;
    if let Some(p) = &d.auto_answer {
        p.validate().map_err(|e| e.message)?;
    }
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
            role_models: Default::default(),
            fallback_chains: Default::default(),
            catch_up: true,
            auto_answer: None,
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
        assert!(bad(&|d| _ = d.role_models.insert("smol".into(), "no-provider".into())).contains("model role `smol`"));
        assert!(bad(&|d| _ = d.fallback_chains.insert("default".into(), vec!["a b/c".into()])).contains("fallback chain `default`"));
        let short = tf_proto::autoanswer::AutoAnswer { enabled: true, after_secs: 30, only_when_no_app: false };
        assert!(bad(&|d| d.auto_answer = Some(short.clone())).contains("afterSecs"));
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
            role_models: [("smol".to_string(), "openai/gpt-5-mini:low".to_string())].into(),
            fallback_chains: [("default".to_string(), vec!["anthropic/claude-sonnet-5".to_string(), "openai/*".to_string()])].into(),
            catch_up: true,
            auto_answer: Some(tf_proto::autoanswer::AutoAnswer { enabled: true, after_secs: 1_200, only_when_no_app: true }),
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
        assert_eq!(back.last_started("au1").unwrap().run_id, format!("r{}", RUN_CAP + 4));

        // Corrupt file: set aside, start empty.
        std::fs::write(&path, b"{nope").unwrap();
        assert_eq!(StoreData::load(&path), StoreData::default());
        assert!(!path.exists());
    }

    fn skip(id: &str, auto: &str, at: Millis, why: &str) -> AutomationRun {
        AutomationRun { at, status: AutomationRunStatus::Skipped, agent_id: Some("ag-1".into()), error: Some(why.into()), ..run(id, auto) }
    }

    #[test]
    fn guard_outlives_the_history_and_skips_collapse() {
        let mut data = StoreData::default();
        data.push_run(run("r1", "au1"));
        // A busy agent for a whole weekend: one history entry, counting.
        for i in 0..300 {
            let stored = data.push_run(skip(&format!("s{i}"), "au1", 1000 + i, "auto-x from the previous run needs you"));
            assert_eq!(stored.id, "s0", "every repeat folds into the first skip");
        }
        let au1: Vec<&AutomationRun> = data.runs.iter().filter(|r| r.automation_id == "au1").collect();
        assert_eq!(au1.len(), 2, "the start and one skip entry");
        assert_eq!((au1[0].id.as_str(), au1[0].at), ("s0", 1299));
        assert!(au1[0].error.as_deref().unwrap().starts_with("auto-x from the previous run needs you (skipped 300 times in a row since "), "{:?}", au1[0].error);
        // Other automations fill the shared history past the cap: the guard still knows ag-r1.
        for i in 0..(RUN_CAP + 10) {
            data.push_run(run(&format!("o{i}"), "au2"));
        }
        assert!(data.runs.iter().all(|r| r.automation_id == "au2"));
        assert_eq!(data.last_started("au1").map(|s| s.agent_id.as_str()), Some("ag-r1"));
        // Another reason, or a run in between, starts a new entry.
        data.push_run(skip("t1", "au1", 2000, "auto-x from the previous run is still working"));
        data.push_run(skip("t2", "au1", 2001, "auto-x from the previous run needs you"));
        assert_eq!(data.push_run(skip("t3", "au1", 2002, "auto-x from the previous run needs you")).id, "t2");
        data.push_run(run("r2", "au1"));
        assert_eq!(data.push_run(skip("t4", "au1", 2003, "auto-x from the previous run needs you")).id, "t4");
        assert_eq!(data.last_started("au1").map(|s| s.run_id.as_str()), Some("r2"));
        // Deleting the automation drops its guard state.
        data.remove("au1");
        assert!(data.last_started("au1").is_none() && !data.skip_streaks.contains_key("au1"));
    }

    #[test]
    fn older_files_seed_the_guard_from_the_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("automations.json");
        let mut old = serde_json::to_value(StoreData { runs: vec![run("r9", "au1"), AutomationRun { at: 0, ..run("r1", "au1") }], ..Default::default() }).unwrap();
        let obj = old.as_object_mut().unwrap();
        obj.remove("lastStarted");
        obj.remove("skipStreaks");
        std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
        assert_eq!(StoreData::load(&path).last_started("au1").map(|s| s.run_id.as_str()), Some("r9"));
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Nightly dependency audit!"), "nightly-dependency-audit");
        assert_eq!(slug("  ** "), "run");
        assert_eq!(slug("Ünïcode café 2"), "n-code-caf-2");
        assert!(slug("a very long automation name that keeps going").len() <= 24);
    }
}
