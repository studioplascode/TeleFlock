//! Keeping omp and herdr up to date (architecture §3.9): one [`Tools`] updater per daemon, the
//! `host.toolsUpdate` / `host.toolsConfig` methods, and [`follow`], which merges the status into
//! every herdr session's published `HostInfo.tools`.
//!
//! Cadence: first run 2 minutes after the daemon starts (or 6 h after the last check, whichever
//! is later), then every 6 h + up to 10 min jitter while `auto` is on. One tool at a time.
//!
//! - omp: `omp update --check`; when it offers a newer version (and this run installs),
//!   `omp update`, then `omp --version`. Never `--force`, `--canary` or `--stable` (channels stay
//!   as the user set them).
//! - herdr: `herdr --version`, `herdr status`, the stable manifest (`curl https://herdr.dev/latest.json`);
//!   when newer (or unknown) and this run installs, plain `herdr update` with stdin closed: never
//!   `--handoff`. Running herdr servers keep running; herdr itself declines (without stopping
//!   anything) when the release needs a server restart and stdin is not a terminal. Package-manager
//!   installs (Homebrew, mise, Nix) report their own update command as a note.
//!
//! Status and the `auto` switch persist in `<home>/tools.json`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use tf_proto::{ApiError, HostMethod, Millis, ToolUpdate, ToolUpdates};

use crate::ops::host::parse_version;
use crate::ops::{to_value, Ctx};
use crate::util::now_ms;

const MIN: Millis = 60_000;
/// First automatic run after the daemon starts.
const FIRST_DELAY: Millis = 2 * MIN;
/// Automatic runs while `auto` is on.
const EVERY: Millis = 6 * 60 * MIN;
/// Spread so that hosts restarted together don't all fetch at once.
const JITTER: Millis = 10 * MIN;
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
/// `host.toolsUpdate` answers once its run is done or after this long (the app's request
/// timeout is 30 s); progress keeps arriving through `HostInfo.tools`.
const REPLY_WITHIN: Duration = Duration::from_secs(20);
/// herdr's stable release manifest (the one `herdr update` reads).
const HERDR_MANIFEST_URL: &str = "https://herdr.dev/latest.json";
/// Variables that would make `herdr update` think it runs inside a herdr pane (it then refuses)
/// or narrow it to one session; without them it sees every session and only installs when none
/// of their servers must stop.
const HERDR_SCOPE_VARS: &[&str] = &["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION"];
const MAX_MESSAGE: usize = 300;

// ───────────────────────────── methods ─────────────────────────────

pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    match req {
        HostMethod::HostToolsUpdate(p) => {
            let scope = Scope::parse(p.tool.as_deref(), !p.check_only)?;
            let mut done = ctx.tools.start(scope);
            let _ = tokio::time::timeout(REPLY_WITHIN, done.wait_for(|d| *d)).await;
            to_value(ctx.tools.status())
        }
        HostMethod::HostToolsConfig(p) => to_value(ctx.tools.set_auto(p.auto)),
        other => Err(ApiError::new("unknown_method", format!("{} is not a tools method", other.name()))),
    }
}

/// Publishes the updater status into this herdr session's `HostInfo.tools` now and on every
/// change; after an install, re-probes `HostInfo.omp` / `HostInfo.herdr` so version and setup
/// views are current without waiting for the next periodic probe.
pub fn follow(ctx: &Arc<Ctx>) {
    let mut rx = ctx.tools.subscribe();
    let first = rx.borrow_and_update().clone();
    let mut installed = installed_stamps(&first);
    ctx.state.set_tools(Some(first));
    let ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = ctx.cancel.cancelled() => return,
                changed = rx.changed() => if changed.is_err() { return },
            }
            let tools = rx.borrow_and_update().clone();
            let stamps = installed_stamps(&tools);
            ctx.state.set_tools(Some(tools));
            if stamps != installed {
                installed = stamps;
                let info = crate::ops::host::probe_info(&ctx).await;
                ctx.state.set_info(info);
            }
        }
    });
}

fn installed_stamps(t: &ToolUpdates) -> (Option<Millis>, Option<Millis>) {
    (t.omp.updated_at, t.herdr.updated_at)
}

// ───────────────────────────── updater ─────────────────────────────

/// Which tools a run covers and whether it may install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Scope {
    pub omp: bool,
    pub herdr: bool,
    pub install: bool,
}

impl Scope {
    pub const ALL: Scope = Scope { omp: true, herdr: true, install: true };

    fn parse(tool: Option<&str>, install: bool) -> Result<Scope, ApiError> {
        let (omp, herdr) = match tool {
            None => (true, true),
            Some("omp") => (true, false),
            Some("herdr") => (false, true),
            Some(other) => return Err(ApiError::new("invalid_params", format!("unknown tool `{other}` (omp | herdr)"))),
        };
        Ok(Scope { omp, herdr, install })
    }

    /// A run of `self` also answers a request for `other`.
    fn covers(self, other: Scope) -> bool {
        (self.omp || !other.omp) && (self.herdr || !other.herdr) && (self.install || !other.install)
    }
}

/// Executables a run uses, resolved at the start of every run (tools may be installed later).
#[derive(Debug, Clone, Default)]
pub struct Bins {
    pub omp: Option<PathBuf>,
    pub herdr: Option<PathBuf>,
    pub curl: Option<PathBuf>,
}

impl Bins {
    /// The same binaries the rest of hostd runs: `omp` via [`resolve_bin`](crate::ops::git::resolve_bin),
    /// herdr via herdr's own search order (`$TF_HERDR_BIN`, PATH, install locations).
    pub fn resolve() -> Bins {
        Bins {
            omp: crate::ops::host::omp_bin(),
            herdr: tf_herdr::locate_binary(),
            curl: crate::ops::git::resolve_bin("curl"),
        }
    }
}

type Resolver = Box<dyn Fn() -> Bins + Send + Sync>;

/// The daemon's tool updater. Cheap to clone.
#[derive(Clone)]
pub struct Tools(Arc<Inner>);

struct Inner {
    file: PathBuf,
    bins: Resolver,
    status: watch::Sender<ToolUpdates>,
    /// One run at a time.
    run: tokio::sync::Mutex<()>,
    /// The newest started run (running or queued) and its completion flag.
    active: Mutex<Option<(Scope, watch::Receiver<bool>)>>,
    reschedule: Notify,
}

impl Tools {
    /// Loads `<home>/tools.json` (auto updates default on).
    pub fn load(file: PathBuf) -> Tools {
        Self::with_bins(file, Box::new(Bins::resolve))
    }

    pub fn with_bins(file: PathBuf, bins: Resolver) -> Tools {
        let mut status = std::fs::read(&file)
            .ok()
            .and_then(|b| match serde_json::from_slice::<ToolUpdates>(&b) {
                Ok(s) => Some(s),
                Err(e) => {
                    warn!(file = %file.display(), "ignoring unreadable tools status: {e}");
                    None
                }
            })
            .unwrap_or_else(|| ToolUpdates { auto: true, omp: blank("omp"), herdr: blank("herdr"), next_check_at: None });
        status.omp.updating = false;
        status.herdr.updating = false;
        status.next_check_at = first_check(&status, now_ms());
        let (tx, _) = watch::channel(status);
        Tools(Arc::new(Inner {
            file,
            bins,
            status: tx,
            run: tokio::sync::Mutex::new(()),
            active: Mutex::new(None),
            reschedule: Notify::new(),
        }))
    }

    pub fn status(&self) -> ToolUpdates {
        self.0.status.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<ToolUpdates> {
        self.0.status.subscribe()
    }

    /// `host.toolsConfig`: persists `auto` and reschedules (on: first run in 2 minutes unless a
    /// check ran within 6 h; off: nothing runs by itself).
    pub fn set_auto(&self, auto: bool) -> ToolUpdates {
        self.0.status.send_modify(|s| {
            s.auto = auto;
            s.next_check_at = first_check(s, now_ms());
        });
        self.persist();
        self.0.reschedule.notify_one();
        info!(auto, "tool auto-updates switched");
        self.status()
    }

    /// Starts a run (or joins the newest one when it covers `scope`). The receiver turns `true`
    /// when that run is done.
    pub fn start(&self, scope: Scope) -> watch::Receiver<bool> {
        let mut active = self.0.active.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((s, done)) = active.as_ref()
            && s.covers(scope)
            && !*done.borrow()
        {
            return done.clone();
        }
        let (tx, rx) = watch::channel(false);
        *active = Some((scope, rx.clone()));
        let me = self.clone();
        tokio::spawn(async move {
            let _one = me.0.run.lock().await;
            me.execute(scope).await;
            let _ = tx.send(true);
        });
        rx
    }

    /// Starts a run and waits for it.
    pub async fn run(&self, scope: Scope) -> ToolUpdates {
        let mut done = self.start(scope);
        let _ = done.wait_for(|d| *d).await;
        self.status()
    }

    /// Spawns the scheduler: probes installed versions right away, then runs on the cadence
    /// while `auto` is on.
    pub fn spawn(&self, cancel: CancellationToken) {
        let me = self.clone();
        tokio::spawn(async move {
            me.probe_installed().await;
            loop {
                let s = me.status();
                let wait = match s.next_check_at {
                    Some(at) if s.auto => Duration::from_millis((at - now_ms()).max(0) as u64),
                    _ => Duration::from_secs(365 * 24 * 3600),
                };
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = me.0.reschedule.notified() => continue,
                    _ = tokio::time::sleep(wait) => {}
                }
                if !me.status().auto {
                    continue;
                }
                let mut done = me.start(Scope::ALL);
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = done.wait_for(|d| *d) => {}
                }
                let next = now_ms() + EVERY + jitter();
                me.0.status.send_modify(|s| s.next_check_at = s.auto.then_some(next));
                me.persist();
            }
        });
    }

    /// Fills in installed versions at start (no network) so the app shows them before the
    /// first check.
    async fn probe_installed(&self) {
        let bins = (self.0.bins)();
        let omp = match &bins.omp {
            Some(b) => installed_version(b, Tool::Omp).await,
            None => None,
        };
        let herdr = match &bins.herdr {
            Some(b) => installed_version(b, Tool::Herdr).await,
            None => None,
        };
        self.0.status.send_modify(|s| {
            if omp.is_some() {
                s.omp.current = omp;
            }
            if herdr.is_some() {
                s.herdr.current = herdr;
            }
            drop_stale_latest(&mut s.omp);
            drop_stale_latest(&mut s.herdr);
        });
    }

    async fn execute(&self, scope: Scope) {
        let bins = (self.0.bins)();
        info!(?scope, "tool update run");
        for tool in [Tool::Omp, Tool::Herdr] {
            if !(match tool {
                Tool::Omp => scope.omp,
                Tool::Herdr => scope.herdr,
            }) {
                continue;
            }
            self.0.status.send_modify(|s| tool.of(s).updating = true);
            let prev = tool.of(&mut self.status()).clone();
            let next = match tool {
                Tool::Omp => run_omp(bins.omp.as_deref(), scope.install, prev).await,
                Tool::Herdr => run_herdr(bins.herdr.as_deref(), bins.curl.as_deref(), scope.install, prev).await,
            };
            info!(
                tool = tool.name(),
                current = ?next.current,
                latest = ?next.latest,
                error = ?next.error,
                note = ?next.note,
                "tool update result"
            );
            self.0.status.send_modify(|s| *tool.of(s) = next);
            self.persist();
        }
    }

    fn persist(&self) {
        let mut s = self.status();
        s.omp.updating = false;
        s.herdr.updating = false;
        match serde_json::to_vec_pretty(&s) {
            Ok(bytes) => {
                if let Err(e) = crate::paths::write_atomic(&self.0.file, &bytes) {
                    warn!(file = %self.0.file.display(), "save tools status: {e}");
                }
            }
            Err(e) => warn!("encode tools status: {e}"),
        }
    }
}

/// When the next automatic run is due: `None` while auto is off; otherwise 2 minutes from
/// `now`, or 6 h after the last complete check when that is later.
fn first_check(s: &ToolUpdates, now: Millis) -> Option<Millis> {
    if !s.auto {
        return None;
    }
    let soonest = now + FIRST_DELAY;
    let last = match (s.omp.checked_at, s.herdr.checked_at) {
        (Some(a), Some(b)) => Some(a.min(b)),
        _ => None,
    };
    Some(last.map_or(soonest, |l| (l + EVERY).max(soonest)))
}

fn jitter() -> Millis {
    let mut b = [0u8; 8];
    let _ = getrandom::fill(&mut b);
    (u64::from_le_bytes(b) % JITTER as u64) as Millis
}

fn blank(tool: &str) -> ToolUpdate {
    ToolUpdate {
        tool: tool.to_string(),
        current: None,
        latest: None,
        checked_at: None,
        updated_at: None,
        updating: false,
        error: None,
        note: None,
    }
}

#[derive(Debug, Clone, Copy)]
enum Tool {
    Omp,
    Herdr,
}

impl Tool {
    fn name(self) -> &'static str {
        match self {
            Tool::Omp => "omp",
            Tool::Herdr => "herdr",
        }
    }

    fn of(self, s: &mut ToolUpdates) -> &mut ToolUpdate {
        match self {
            Tool::Omp => &mut s.omp,
            Tool::Herdr => &mut s.herdr,
        }
    }
}

/// Forgets `latest` once the installed version caught up (updated by hand, by a package
/// manager, or by this updater).
fn drop_stale_latest(t: &mut ToolUpdate) {
    if let (Some(latest), Some(current)) = (&t.latest, &t.current)
        && !is_newer(latest, current)
    {
        t.latest = None;
    }
}

/// `candidate` is a strictly newer `x.y.z` than `current`.
pub(crate) fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

// ───────────────────────────── omp ─────────────────────────────

async fn run_omp(bin: Option<&Path>, install: bool, prev: ToolUpdate) -> ToolUpdate {
    let now = now_ms();
    let mut t = ToolUpdate { updating: false, checked_at: Some(now), error: None, note: None, ..prev };
    let Some(bin) = bin else {
        t.current = None;
        t.latest = None;
        t.note = Some("omp is not installed on this host".into());
        return t;
    };
    t.current = installed_version(bin, Tool::Omp).await.or(t.current);
    let check = match exec(bin, &["update", "--check"], CHECK_TIMEOUT, Tool::Omp).await {
        Ok(out) => parse_omp_check(out.code, &out.text),
        Err(e) => OmpCheck::Failed(e),
    };
    let latest = match check {
        OmpCheck::UpToDate => {
            t.latest = None;
            return t;
        }
        OmpCheck::Managed(note) => {
            t.latest = None;
            t.note = Some(note);
            return t;
        }
        OmpCheck::Failed(e) => {
            t.error = Some(format!("Couldn't check for omp updates: {e}"));
            drop_stale_latest(&mut t);
            return t;
        }
        OmpCheck::Available(v) => v,
    };
    t.latest = Some(latest.clone());
    if !install {
        return t;
    }
    let before = t.current.clone();
    let outcome = match exec(bin, &["update"], INSTALL_TIMEOUT, Tool::Omp).await {
        Ok(out) => parse_omp_install(out.code, &out.text),
        Err(e) => Outcome::Failed(e),
    };
    t.current = installed_version(bin, Tool::Omp).await.or(t.current);
    finish_install(&mut t, outcome, before, now, |old| format!("Agents already running keep omp {old} until they restart."));
    t
}

/// What `omp update --check` said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OmpCheck {
    UpToDate,
    Available(String),
    /// Installed and updated by a package manager / Nix: nothing for tf-hostd to do.
    Managed(String),
    Failed(String),
}

pub fn parse_omp_check(code: i32, text: &str) -> OmpCheck {
    if let Some(note) = omp_managed_note(text) {
        return OmpCheck::Managed(note);
    }
    if let Some(e) = after_marker(text, "Failed to check for updates:") {
        return OmpCheck::Failed(e);
    }
    if let Some(v) = after_marker(text, "New version available:") {
        return OmpCheck::Available(v.split_whitespace().next().unwrap_or_default().to_string());
    }
    if text.contains("Already up to date") {
        return OmpCheck::UpToDate;
    }
    if code != 0 {
        return OmpCheck::Failed(last_line(text).unwrap_or_else(|| format!("omp update --check exited {code}")));
    }
    OmpCheck::Failed(format!("unexpected output from omp update --check: {}", last_line(text).unwrap_or_default()))
}

pub fn parse_omp_install(code: i32, text: &str) -> Outcome {
    if let Some(note) = omp_managed_note(text) {
        return Outcome::Note(note);
    }
    if let Some(e) = after_marker(text, "Update failed:") {
        return Outcome::Failed(explain_failure(&e));
    }
    if let Some(e) = after_marker(text, "Failed to check for updates:") {
        return Outcome::Failed(e);
    }
    if let Some(w) = after_marker(text, "Warning:")
        && !text.contains("Updated to")
    {
        return Outcome::Failed(w);
    }
    if let Some(v) = after_marker(text, "Updated to") {
        return Outcome::Installed(v.split_whitespace().next().map(str::to_string));
    }
    if text.contains("Already up to date") {
        return Outcome::UpToDate;
    }
    if code != 0 {
        return Outcome::Failed(explain_failure(&last_line(text).unwrap_or_else(|| format!("omp update exited {code}"))));
    }
    // Some install paths only say "Restart omp to use the new version"; the re-probed version decides.
    Outcome::Installed(None)
}

/// omp's notes for installs it does not update itself.
fn omp_managed_note(text: &str) -> Option<String> {
    for line in text.lines() {
        if let Some(i) = line.find("is installed and kept up to date by ") {
            let manager = line[i + "is installed and kept up to date by ".len()..].split(';').next().unwrap_or("").trim();
            return Some(format!("Installed with {manager}: update omp with {manager}."));
        }
    }
    if text.contains("managed by Nix and cannot update itself") {
        return Some("Installed with Nix: update the flake input or profile that provides omp.".into());
    }
    if text.contains("Canary updates are only supported") {
        return Some("omp follows the canary channel, which this install can't update itself.".into());
    }
    None
}

// ───────────────────────────── herdr ─────────────────────────────

async fn run_herdr(bin: Option<&Path>, curl: Option<&Path>, install: bool, prev: ToolUpdate) -> ToolUpdate {
    let now = now_ms();
    let mut t = ToolUpdate { updating: false, checked_at: Some(now), error: None, note: None, ..prev };
    let Some(bin) = bin else {
        t.current = None;
        t.latest = None;
        t.note = Some("herdr is not installed on this host".into());
        return t;
    };
    t.current = installed_version(bin, Tool::Herdr).await.or(t.current);
    let status = herdr_status(bin).await;
    let preview = status.as_ref().and_then(|s| s.channel.as_deref()) == Some("preview");
    // Stable channel: the manifest `herdr update` itself reads. Preview builds only `herdr update` knows.
    let manifest = if preview {
        None
    } else {
        Some(match curl {
            Some(c) => fetch_manifest(c).await,
            None => Err("curl is not installed".to_string()),
        })
    };
    let check_error = match &manifest {
        Some(Err(e)) => Some(format!("Couldn't check for herdr updates: {e}")),
        _ => None,
    };
    let release = manifest.and_then(Result::ok);
    match (&release, &t.current) {
        (Some(r), Some(cur)) if is_newer(&r.version, cur) => t.latest = Some(r.version.clone()),
        (Some(_), _) => t.latest = None,
        _ => drop_stale_latest(&mut t),
    }
    let worth_installing = t.latest.is_some() || release.is_none();
    if !install || !worth_installing {
        t.error = check_error;
        if preview && !install {
            t.note = Some("herdr follows the preview channel: only `herdr update` can check it.".into());
        }
        if t.note.is_none() {
            t.note = stale_server_note(status.as_ref());
        }
        return t;
    }
    // A release for another endpoint generation needs the running server replaced, which stops
    // its panes: herdr would decline anyway (stdin is not a terminal), so don't download it.
    if let (Some(r), Some(s)) = (&release, &status)
        && s.server_running
        && let (Some(target), Some(own)) = (r.endpoint_generation, s.client_generation)
        && target != own
    {
        t.note = Some(restart_note(&r.version));
        return t;
    }
    let before = t.current.clone();
    let outcome = match exec(bin, &["update"], INSTALL_TIMEOUT, Tool::Herdr).await {
        Ok(out) => parse_herdr_update(out.code, &out.text),
        Err(e) => Outcome::Failed(e),
    };
    t.current = installed_version(bin, Tool::Herdr).await.or(t.current);
    let latest = t.latest.clone().or_else(|| release.as_ref().map(|r| r.version.clone()));
    let restart = matches!(&outcome, Outcome::RestartNeeded);
    finish_install(&mut t, outcome, before, now, |_| String::new());
    if restart {
        t.note = Some(restart_note(latest.as_deref().unwrap_or("The new herdr")));
    }
    if t.note.as_deref().is_none_or(str::is_empty) {
        t.note = stale_server_note(herdr_status(bin).await.as_ref());
    }
    t
}

fn restart_note(version: &str) -> String {
    let what = if parse_version(version).is_some() { format!("herdr {version}") } else { version.to_string() };
    format!("{what} needs the herdr server restarted, which stops running agents: run `herdr update` on the host when you're ready.")
}

fn stale_server_note(status: Option<&HerdrStatus>) -> Option<String> {
    let s = status?;
    if !s.server_running || s.server_binary_stale != Some(true) {
        return None;
    }
    let v = s.server_version.as_deref().filter(|v| *v != "unknown").map(|v| format!("{v} ")).unwrap_or_default();
    Some(format!("The herdr server keeps running {v}until it restarts; agents keep running."))
}

/// What `herdr update` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Installed (version from the output when it said).
    Installed(Option<String>),
    UpToDate,
    /// Nothing installed, for a reason to show (package-manager install, …).
    Note(String),
    /// herdr declined: the release needs running servers stopped.
    RestartNeeded,
    Failed(String),
}

pub fn parse_herdr_update(code: i32, text: &str) -> Outcome {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("self-update is disabled for ") {
            let manager = rest.split_whitespace().next().unwrap_or("package-manager");
            let how = rest.split_once("; ").map(|(_, h)| h.trim().trim_end_matches('.')).unwrap_or("update it with its package manager");
            return Outcome::Note(format!("Installed with {manager}: {how}."));
        }
    }
    if text.contains("Herdr was not updated") || text.contains("must stop for this update") {
        return Outcome::RestartNeeded;
    }
    if let Some(e) = after_marker(text, "update failed:") {
        return Outcome::Failed(explain_failure(&e));
    }
    if text.contains("already up to date") {
        return Outcome::UpToDate;
    }
    if let Some(v) = text.lines().find_map(|l| l.trim().strip_prefix("installed ")) {
        return Outcome::Installed(Some(v.trim().trim_start_matches('v').to_string()));
    }
    if code != 0 {
        return Outcome::Failed(explain_failure(&last_line(text).unwrap_or_else(|| format!("herdr update exited {code}"))));
    }
    Outcome::Installed(None)
}

/// The parts of `herdr status` the updater reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HerdrStatus {
    pub client_version: Option<String>,
    pub channel: Option<String>,
    pub client_generation: Option<u32>,
    pub server_running: bool,
    pub server_version: Option<String>,
    pub server_binary_stale: Option<bool>,
    pub restart_needed: Option<bool>,
}

/// Parses `herdr status` (text: `client:` / `server:` / `update:` sections of `key: value`).
pub fn parse_herdr_status(text: &str) -> HerdrStatus {
    let mut s = HerdrStatus::default();
    let mut section = "";
    let yes = |v: &str| match v {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    };
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        if !line.starts_with(' ') && line.ends_with(':') {
            section = line.trim_end_matches(':');
            continue;
        }
        let Some((k, v)) = line.trim().split_once(':') else { continue };
        let v = v.trim();
        match (section, k.trim()) {
            ("client", "version") => s.client_version = Some(v.to_string()),
            ("client", "channel") => s.channel = Some(v.to_string()),
            ("client", "endpoint_protocol_generation") => s.client_generation = v.parse().ok(),
            ("server", "status") => s.server_running = v == "running",
            ("server", "version") => s.server_version = Some(v.to_string()),
            ("update", "server_binary_stale") => s.server_binary_stale = yes(v),
            ("update", "restart_needed") => s.restart_needed = yes(v),
            _ => {}
        }
    }
    s
}

async fn herdr_status(bin: &Path) -> Option<HerdrStatus> {
    let out = exec(bin, &["status"], VERSION_TIMEOUT, Tool::Herdr).await.ok()?;
    (out.code == 0).then(|| parse_herdr_status(&out.text))
}

/// The fields of herdr's release manifest the updater reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerdrRelease {
    pub version: String,
    pub endpoint_generation: Option<u32>,
}

pub fn parse_manifest(json: &str) -> Result<HerdrRelease, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable release manifest: {e}"))?;
    let version = v.get("version").and_then(Value::as_str).filter(|s| parse_version(s).is_some()).ok_or("release manifest has no version")?;
    Ok(HerdrRelease {
        version: version.trim_start_matches('v').to_string(),
        endpoint_generation: v.get("endpoint_generation").and_then(Value::as_u64).map(|g| g as u32),
    })
}

async fn fetch_manifest(curl: &Path) -> Result<HerdrRelease, String> {
    let args = ["-sfL", "--retry", "2", "--connect-timeout", "10", "--max-time", "20", HERDR_MANIFEST_URL];
    let out = run(curl, &args, Duration::from_secs(70), &[]).await?;
    if out.code != 0 {
        return Err(format!("herdr.dev is unreachable (curl exit {})", out.code));
    }
    parse_manifest(&out.stdout)
}

// ───────────────────────────── shared ─────────────────────────────

/// Fills in the result of an install attempt.
fn finish_install(t: &mut ToolUpdate, outcome: Outcome, before: Option<String>, now: Millis, running_note: impl Fn(&str) -> String) {
    match outcome {
        Outcome::Installed(_) | Outcome::UpToDate => {
            let changed = before.is_some() && t.current != before;
            if changed {
                t.updated_at = Some(now);
                if let Some(old) = &before {
                    let n = running_note(old);
                    if !n.is_empty() {
                        t.note = Some(n);
                    }
                }
            }
            drop_stale_latest(t);
            if let (Some(latest), false) = (&t.latest, changed) {
                t.error = Some(format!(
                    "The update finished, but {} still reports {} (expected {latest}).",
                    t.tool,
                    t.current.as_deref().unwrap_or("no version")
                ));
            }
        }
        Outcome::Note(n) => t.note = Some(n),
        Outcome::RestartNeeded => {}
        Outcome::Failed(e) => t.error = Some(e),
    }
}

/// `omp --version` / `herdr --version` → `18.12.3`.
async fn installed_version(bin: &Path, tool: Tool) -> Option<String> {
    let out = exec(bin, &["--version"], VERSION_TIMEOUT, tool).await.ok()?;
    if out.code != 0 {
        return None;
    }
    let (a, b, c) = parse_version(out.stdout.lines().next().unwrap_or_default())?;
    Some(format!("{a}.{b}.{c}"))
}

/// Process output: `text` = stdout then stderr, ANSI-stripped (the CLIs print to both).
struct Out {
    code: i32,
    stdout: String,
    text: String,
}

async fn exec(bin: &Path, args: &[&str], timeout: Duration, tool: Tool) -> Result<Out, String> {
    let remove: &[&str] = match tool {
        Tool::Herdr => HERDR_SCOPE_VARS,
        Tool::Omp => &[],
    };
    run(bin, args, timeout, remove).await
}

/// Runs a tool without a shell, stdin closed (interactive prompts take their non-interactive
/// default), in the temp dir (omp reads project settings from its cwd), `NO_COLOR=1`.
async fn run(bin: &Path, args: &[&str], timeout: Duration, env_remove: &[&str]) -> Result<Out, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(std::env::temp_dir())
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for k in env_remove {
        cmd.env_remove(k);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console window from the background daemon.
        cmd.creation_flags(0x0800_0000);
    }
    let name = bin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let child = cmd.spawn().map_err(|e| format!("couldn't run {name}: {e}"))?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout));
            let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr));
            Ok(Out { code: out.status.code().unwrap_or(-1), text: format!("{stdout}\n{stderr}"), stdout })
        }
        Ok(Err(e)) => Err(format!("{name} {}: {e}", args.join(" "))),
        Err(_) => Err(format!("{name} {} timed out after {} s", args.join(" "), timeout.as_secs())),
    }
}

/// Removes ANSI escape sequences (CSI and OSC) in case a tool ignores `NO_COLOR`.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('[') => {
                for c in it.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = it.next() {
                    if c == '\u{7}' || (c == '\u{1b}' && it.peek() == Some(&'\\')) {
                        if c == '\u{1b}' {
                            it.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Text after `marker` on the first line containing it, trimmed and shortened.
fn after_marker(text: &str, marker: &str) -> Option<String> {
    text.lines().find_map(|l| l.find(marker).map(|i| shorten(l[i + marker.len()..].trim())))
}

fn last_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty()).map(shorten)
}

fn shorten(s: &str) -> String {
    if s.chars().count() <= MAX_MESSAGE {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_MESSAGE).collect();
    out.push('…');
    out
}

/// Adds what to do about the common failure: the install is owned by another user.
fn explain_failure(msg: &str) -> String {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("permission denied") || lower.contains("eacces") || lower.contains("eperm") {
        format!("{msg} — permission denied: the install belongs to another user; update it as that user.")
    } else {
        msg.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── parsing (captured outputs) ──

    #[test]
    fn omp_check_outputs() {
        let up = "Current version: 18.12.3\n✔ Already up to date\n";
        assert_eq!(parse_omp_check(0, up), OmpCheck::UpToDate);
        let new = "Current version: 18.12.3\nNew version available: 18.12.6\n";
        assert_eq!(parse_omp_check(0, new), OmpCheck::Available("18.12.6".into()));
        let colored = "\u{1b}[2mCurrent version: 18.12.3\u{1b}[22m\n\u{1b}[36mNew version available: 18.13.0\u{1b}[39m\n";
        assert_eq!(parse_omp_check(0, &strip_ansi(colored)), OmpCheck::Available("18.13.0".into()));
        let net = "Current version: 18.12.3\n\nFailed to check for updates: TypeError: fetch failed (getaddrinfo ENOTFOUND registry.npmjs.org)\n";
        match parse_omp_check(1, net) {
            OmpCheck::Failed(e) => assert!(e.contains("ENOTFOUND"), "{e}"),
            other => panic!("{other:?}"),
        }
        let brew = "/opt/homebrew/bin/omp is installed and kept up to date by Homebrew; update it from Homebrew.\n";
        assert_eq!(parse_omp_check(0, brew), OmpCheck::Managed("Installed with Homebrew: update omp with Homebrew.".into()));
        match parse_omp_check(127, "\nsh: omp: not found") {
            OmpCheck::Failed(e) => assert!(e.contains("not found")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn omp_install_outputs() {
        let ok = "Current version: 18.12.3\nNew version available: 18.12.6\nUpdating via bun...\n\n✔ Updated to 18.12.6\n";
        assert_eq!(parse_omp_install(0, ok), Outcome::Installed(Some("18.12.6".into())));
        let denied = "Current version: 18.12.3\nNew version available: 18.12.6\nUpdate failed: EACCES: permission denied, open '/usr/local/bin/omp'\n";
        match parse_omp_install(1, denied) {
            Outcome::Failed(e) => assert!(e.contains("EACCES") && e.contains("another user"), "{e}"),
            other => panic!("{other:?}"),
        }
        let nix = "Current version: 18.12.3\nNew version available: 18.12.6\nThis installation is managed by Nix and cannot update itself.\n";
        assert!(matches!(parse_omp_install(0, nix), Outcome::Note(n) if n.contains("Nix")));
        let verify = "Updating via npm...\nWarning: omp --version reported 18.12.3, expected 18.12.6\nYou may need to reinstall\n";
        assert!(matches!(parse_omp_install(0, verify), Outcome::Failed(e) if e.contains("expected 18.12.6")));
        assert_eq!(parse_omp_install(0, "✔ Already up to date"), Outcome::UpToDate);
    }

    #[test]
    fn herdr_update_outputs() {
        assert_eq!(parse_herdr_update(0, "checking stable channel for updates...\nalready up to date (0.9.0)\n"), Outcome::UpToDate);
        let ok = "checking stable channel for updates...\nrunning herdr targets:\n  default: server v0.9.0\n  update: v0.9.5\n\ndownloading v0.9.5...\ndownloaded v0.9.5\ninstalled v0.9.5\ndefault session kept running server v0.9.0.\n";
        assert_eq!(parse_herdr_update(0, ok), Outcome::Installed(Some("0.9.5".into())));
        let brew = "self-update is disabled for Homebrew installs; run `brew update && brew upgrade herdr`\n";
        assert_eq!(parse_herdr_update(1, brew), Outcome::Note("Installed with Homebrew: run `brew update && brew upgrade herdr`.".into()));
        let nix = "self-update is disabled for Nix installs; update with `nix profile upgrade` or update the flake input that provides Herdr\n";
        assert!(matches!(parse_herdr_update(1, nix), Outcome::Note(n) if n.starts_with("Installed with Nix: update with")));
        let restart = "downloading v1.0.0...\ndownloaded v1.0.0\nHerdr was not updated.\nStop running Herdr sessions when ready, then run `herdr update` again.\n";
        assert_eq!(parse_herdr_update(0, restart), Outcome::RestartNeeded);
        let net = "checking stable channel for updates...\nupdate failed: failed to fetch update manifest\n";
        assert_eq!(parse_herdr_update(1, net), Outcome::Failed("failed to fetch update manifest".into()));
        let perm = "downloading v0.9.5...\nupdate failed: can't write to /usr/local/bin: Permission denied (os error 13)\n";
        assert!(matches!(parse_herdr_update(1, perm), Outcome::Failed(e) if e.contains("another user")));
    }

    #[test]
    fn herdr_status_text() {
        let real = "client:\n  version: 0.9.0\n  channel: stable\n  protocol: 22\n  endpoint_protocol_generation: 1\n\nserver:\n  status: running\n  version: 0.9.0\n  endpoint_compatible: yes\n  private_protocol: 22\n  private_protocol_compatible: yes\n  socket: /root/.config/herdr/herdr.sock\n\nupdate:\n  restart_needed: no\n  server_binary_stale: no\n";
        let s = parse_herdr_status(real);
        assert_eq!(s.client_version.as_deref(), Some("0.9.0"));
        assert_eq!(s.channel.as_deref(), Some("stable"));
        assert_eq!(s.client_generation, Some(1));
        assert!(s.server_running);
        assert_eq!(s.server_version.as_deref(), Some("0.9.0"));
        assert_eq!((s.server_binary_stale, s.restart_needed), (Some(false), Some(false)));
        assert_eq!(stale_server_note(Some(&s)), None);
        let stale = real.replace("  version: 0.9.0\n  channel", "  version: 0.9.5\n  channel").replace("server_binary_stale: no", "server_binary_stale: yes");
        let s = parse_herdr_status(&stale);
        assert_eq!(s.client_version.as_deref(), Some("0.9.5"));
        assert_eq!(stale_server_note(Some(&s)).as_deref(), Some("The herdr server keeps running 0.9.0 until it restarts; agents keep running."));
        let stopped = parse_herdr_status("client:\n  version: 0.9.0\n\nserver:\n  status: not running\n  socket: /x\n\nupdate:\n  restart_needed: no\n  server_binary_stale: no\n");
        assert!(!stopped.server_running);
    }

    #[test]
    fn manifest_and_versions() {
        let r = parse_manifest(r#"{"version":"0.9.5","protocol":22,"endpoint_generation":1,"notes":"x"}"#).unwrap();
        assert_eq!(r, HerdrRelease { version: "0.9.5".into(), endpoint_generation: Some(1) });
        assert!(parse_manifest("<html>").is_err());
        assert!(parse_manifest(r#"{"notes":"x"}"#).is_err());
        assert!(is_newer("18.12.6", "18.12.3"));
        assert!(!is_newer("18.12.3", "18.12.3"));
        assert!(!is_newer("0.9.0", "0.10.0"));
        assert_eq!(strip_ansi("\u{1b}]8;;https://x\u{7}link\u{1b}]8;;\u{7} \u{1b}[1mbold\u{1b}[0m"), "link bold");
    }

    #[test]
    fn scope_joining() {
        let check_omp = Scope { omp: true, herdr: false, install: false };
        assert!(Scope::ALL.covers(check_omp));
        assert!(!check_omp.covers(Scope::ALL));
        assert!(!check_omp.covers(Scope { install: true, ..check_omp }));
        assert!(Scope::parse(Some("nope"), true).is_err());
        assert_eq!(Scope::parse(None, false).unwrap(), Scope { omp: true, herdr: true, install: false });
    }

    #[test]
    fn schedule() {
        let now = 1_000_000_000;
        let mut s = ToolUpdates { auto: true, omp: blank("omp"), herdr: blank("herdr"), next_check_at: None };
        assert_eq!(first_check(&s, now), Some(now + FIRST_DELAY));
        s.omp.checked_at = Some(now - MIN);
        s.herdr.checked_at = Some(now - 2 * MIN);
        assert_eq!(first_check(&s, now), Some(now - 2 * MIN + EVERY));
        s.herdr.checked_at = Some(now - EVERY * 2);
        assert_eq!(first_check(&s, now), Some(now + FIRST_DELAY));
        s.auto = false;
        assert_eq!(first_check(&s, now), None);
    }

    // ── the updater against fake `omp` / `herdr` / `curl` executables ──

    #[cfg(unix)]
    mod fake {
        use super::super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A temp dir with fake `omp`, `herdr` and `curl` scripts. Their behaviour is driven by
        /// files in the dir (`omp.ver`, `omp.check`, …); every invocation appends to `calls`.
        pub struct Lab {
            pub dir: tempfile::TempDir,
        }

        const OMP: &str = r#"#!/bin/sh
d=$(dirname "$0")
echo "omp $*" >> "$d/calls"
case "$1" in
  --version) echo "omp/$(cat "$d/omp.ver")" ;;
  update)
    echo "Current version: $(cat "$d/omp.ver")"
    if [ -f "$d/omp.managed" ]; then echo "$0 is installed and kept up to date by $(cat "$d/omp.managed"); update it from $(cat "$d/omp.managed")."; exit 0; fi
    if [ -f "$d/omp.offline" ]; then echo "Failed to check for updates: TypeError: fetch failed" >&2; exit 1; fi
    latest=$(cat "$d/omp.latest")
    if [ "$latest" = "$(cat "$d/omp.ver")" ]; then echo "✔ Already up to date"; exit 0; fi
    echo "New version available: $latest"
    [ "$2" = "--check" ] && exit 0
    if [ -f "$d/omp.denied" ]; then echo "Update failed: EACCES: permission denied, rename '$d/omp'" >&2; exit 1; fi
    echo "Updating via bun..."
    echo "$latest" > "$d/omp.ver"
    printf '\n✔ Updated to %s\n' "$latest" ;;
esac
"#;

        const HERDR: &str = r#"#!/bin/sh
d=$(dirname "$0")
echo "herdr $* env=${HERDR_ENV:-}" >> "$d/calls"
case "$1" in
  --version) echo "herdr $(cat "$d/herdr.ver")" ;;
  status)
    stale=no; [ "$(cat "$d/herdr.ver")" != "$(cat "$d/herdr.server")" ] && stale=yes
    printf 'client:\n  version: %s\n  channel: stable\n  protocol: 22\n  endpoint_protocol_generation: 1\n\n' "$(cat "$d/herdr.ver")"
    printf 'server:\n  status: running\n  version: %s\n  endpoint_compatible: yes\n\n' "$(cat "$d/herdr.server")"
    printf 'update:\n  restart_needed: no\n  server_binary_stale: %s\n' "$stale" ;;
  update)
    [ "$#" -ne 1 ] && { echo "unexpected update args: $*" >&2; exit 2; }
    echo "checking stable channel for updates..." >&2
    if [ -f "$d/herdr.brew" ]; then echo "self-update is disabled for Homebrew installs; run \`brew update && brew upgrade herdr\`" >&2; exit 1; fi
    latest=$(cat "$d/herdr.latest")
    if [ "$latest" = "$(cat "$d/herdr.ver")" ]; then echo "already up to date ($latest)" >&2; exit 0; fi
    echo "downloading v$latest..." >&2
    echo "$latest" > "$d/herdr.ver"
    echo "installed v$latest" >&2
    echo "default session kept running server v$(cat "$d/herdr.server")." >&2 ;;
esac
"#;

        const CURL: &str = r#"#!/bin/sh
d=$(dirname "$0")
echo "curl $*" >> "$d/calls"
[ -f "$d/curl.offline" ] && exit 6
printf '{"version":"%s","protocol":22,"endpoint_generation":%s}' "$(cat "$d/herdr.latest")" "$(cat "$d/herdr.gen" 2>/dev/null || echo 1)"
"#;

        impl Lab {
            pub fn new() -> Lab {
                let dir = tempfile::tempdir().unwrap();
                for (name, body) in [("omp", OMP), ("herdr", HERDR), ("curl", CURL)] {
                    let p = dir.path().join(name);
                    std::fs::write(&p, body).unwrap();
                    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
                }
                let lab = Lab { dir };
                lab.set("omp.ver", "18.12.3");
                lab.set("omp.latest", "18.12.3");
                lab.set("herdr.ver", "0.9.0");
                lab.set("herdr.server", "0.9.0");
                lab.set("herdr.latest", "0.9.0");
                lab
            }
            pub fn set(&self, file: &str, value: &str) {
                std::fs::write(self.dir.path().join(file), format!("{value}\n")).unwrap();
            }
            pub fn get(&self, file: &str) -> String {
                std::fs::read_to_string(self.dir.path().join(file)).unwrap_or_default().trim().to_string()
            }
            pub fn calls(&self) -> Vec<String> {
                self.get("calls").lines().map(str::to_string).collect()
            }
            pub fn tools(&self) -> Tools {
                let d = self.dir.path().to_path_buf();
                Tools::with_bins(
                    d.join("tools.json"),
                    Box::new(move || Bins { omp: Some(d.join("omp")), herdr: Some(d.join("herdr")), curl: Some(d.join("curl")) }),
                )
            }
        }
    }

    #[cfg(unix)]
    use fake::Lab;

    #[cfg(unix)]
    const OMP_ONLY: Scope = Scope { omp: true, herdr: false, install: true };
    #[cfg(unix)]
    const HERDR_ONLY: Scope = Scope { omp: false, herdr: true, install: true };

    #[cfg(unix)]
    #[tokio::test]
    async fn omp_update_available_is_checked_then_installed() {
        let lab = Lab::new();
        lab.set("omp.latest", "18.12.6");
        let tools = lab.tools();
        let s = tools.run(Scope { install: false, ..OMP_ONLY }).await;
        assert_eq!((s.omp.current.as_deref(), s.omp.latest.as_deref()), (Some("18.12.3"), Some("18.12.6")));
        assert!(s.omp.checked_at.is_some() && s.omp.updated_at.is_none() && !s.omp.updating);
        assert_eq!(lab.get("omp.ver"), "18.12.3", "check-only never installs");

        let s = tools.run(OMP_ONLY).await;
        assert_eq!(s.omp.current.as_deref(), Some("18.12.6"));
        assert_eq!(s.omp.latest, None);
        assert!(s.omp.updated_at.is_some());
        assert_eq!(s.omp.error, None);
        assert_eq!(s.omp.note.as_deref(), Some("Agents already running keep omp 18.12.3 until they restart."));
        assert!(!lab.calls().iter().any(|c| c.contains("--force") || c.contains("--canary") || c.contains("--stable")));
        // Persisted, `updating` never stored.
        let again = lab.tools().status();
        assert_eq!(again.omp.current.as_deref(), Some("18.12.6"));
        assert!(again.auto && !again.omp.updating);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn omp_up_to_date_offline_denied_and_managed() {
        let lab = Lab::new();
        let tools = lab.tools();
        let s = tools.run(OMP_ONLY).await;
        assert_eq!((s.omp.latest.as_ref(), s.omp.error.as_ref(), s.omp.note.as_ref()), (None, None, None));
        assert!(!lab.calls().iter().any(|c| c == "omp update"), "nothing installed when up to date");

        lab.set("omp.offline", "1");
        let s = tools.run(OMP_ONLY).await;
        assert!(s.omp.error.as_deref().is_some_and(|e| e.contains("fetch failed")), "{:?}", s.omp.error);
        std::fs::remove_file(lab.dir.path().join("omp.offline")).unwrap();

        lab.set("omp.latest", "18.13.0");
        lab.set("omp.denied", "1");
        let s = tools.run(OMP_ONLY).await;
        assert!(s.omp.error.as_deref().is_some_and(|e| e.contains("permission denied")), "{:?}", s.omp.error);
        assert_eq!(s.omp.latest.as_deref(), Some("18.13.0"));
        assert_eq!(s.omp.current.as_deref(), Some("18.12.3"));
        assert!(s.omp.updated_at.is_none());
        std::fs::remove_file(lab.dir.path().join("omp.denied")).unwrap();

        lab.set("omp.managed", "mise");
        let s = tools.run(OMP_ONLY).await;
        assert_eq!(s.omp.note.as_deref(), Some("Installed with mise: update omp with mise."));
        assert_eq!((s.omp.latest.as_ref(), s.omp.error.as_ref()), (None, None));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn herdr_update_installs_and_notes_the_stale_server() {
        let lab = Lab::new();
        lab.set("herdr.latest", "0.9.5");
        let tools = lab.tools();
        let s = tools.run(Scope { install: false, ..HERDR_ONLY }).await;
        assert_eq!((s.herdr.current.as_deref(), s.herdr.latest.as_deref()), (Some("0.9.0"), Some("0.9.5")));
        assert_eq!(lab.get("herdr.ver"), "0.9.0");

        let s = tools.run(HERDR_ONLY).await;
        assert_eq!(s.herdr.current.as_deref(), Some("0.9.5"));
        assert_eq!(s.herdr.latest, None);
        assert!(s.herdr.updated_at.is_some());
        assert_eq!(s.herdr.error, None);
        assert_eq!(s.herdr.note.as_deref(), Some("The herdr server keeps running 0.9.0 until it restarts; agents keep running."));
        let calls = lab.calls();
        assert!(calls.iter().any(|c| c.starts_with("herdr update ")), "{calls:?}");
        assert!(!calls.iter().any(|c| c.contains("--handoff")), "never a live handoff: {calls:?}");
        assert!(calls.iter().filter(|c| c.starts_with("herdr ")).all(|c| c.ends_with("env=")), "HERDR_ENV removed: {calls:?}");

        // Up to date now: no second install, the stale-server note stays until the server restarts.
        let s = tools.run(HERDR_ONLY).await;
        assert_eq!(calls.len() + 3, lab.calls().len(), "version + status + curl only: {:?}", lab.calls());
        assert!(s.herdr.note.is_some());
        lab.set("herdr.server", "0.9.5");
        let s = tools.run(HERDR_ONLY).await;
        assert_eq!(s.herdr.note, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn herdr_package_manager_restart_and_offline() {
        let lab = Lab::new();
        lab.set("herdr.latest", "0.9.5");
        lab.set("herdr.brew", "1");
        let tools = lab.tools();
        let s = tools.run(HERDR_ONLY).await;
        assert_eq!(s.herdr.note.as_deref(), Some("Installed with Homebrew: run `brew update && brew upgrade herdr`."));
        assert_eq!((s.herdr.latest.as_deref(), s.herdr.error.as_ref()), (Some("0.9.5"), None));
        std::fs::remove_file(lab.dir.path().join("herdr.brew")).unwrap();

        // Another endpoint generation needs the server replaced: not even downloaded.
        lab.set("herdr.gen", "2");
        let before = lab.calls().len();
        let s = tools.run(HERDR_ONLY).await;
        assert!(s.herdr.note.as_deref().is_some_and(|n| n.contains("needs the herdr server restarted")), "{:?}", s.herdr.note);
        assert!(!lab.calls()[before..].iter().any(|c| c.starts_with("herdr update")));
        assert_eq!(lab.get("herdr.ver"), "0.9.0");
        lab.set("herdr.gen", "1");

        // Manifest unreachable: check-only reports it; an install run lets `herdr update` decide.
        lab.set("curl.offline", "1");
        let s = tools.run(Scope { install: false, ..HERDR_ONLY }).await;
        assert!(s.herdr.error.as_deref().is_some_and(|e| e.contains("unreachable")), "{:?}", s.herdr.error);
        let s = tools.run(HERDR_ONLY).await;
        assert_eq!(s.herdr.current.as_deref(), Some("0.9.5"));
        assert_eq!(s.herdr.error, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_requests_join_and_auto_persists() {
        let lab = Lab::new();
        lab.set("omp.latest", "18.12.6");
        let tools = lab.tools();
        let a = tools.start(Scope::ALL);
        let b = tools.start(Scope { install: false, ..OMP_ONLY });
        assert!(a.same_channel(&b), "a covered request joins the running one");
        let (sa, _) = tokio::join!(tools.run(Scope::ALL), async {
            let mut b = b;
            b.wait_for(|d| *d).await.unwrap();
        });
        assert_eq!(sa.omp.current.as_deref(), Some("18.12.6"));
        assert_eq!(lab.calls().iter().filter(|c| *c == "omp update --check").count(), 1, "{:?}", lab.calls());

        assert!(tools.status().next_check_at.is_some());
        let s = tools.set_auto(false);
        assert!(!s.auto && s.next_check_at.is_none());
        let reloaded = lab.tools().status();
        assert!(!reloaded.auto && reloaded.next_check_at.is_none());
        assert!(tools.set_auto(true).next_check_at.is_some());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scheduler_runs_only_while_auto_is_on() {
        async fn eventually(what: &str, f: impl Fn() -> bool) {
            for _ in 0..200 {
                if f() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("timed out waiting for {what}");
        }
        let lab = Lab::new();
        lab.set("omp.latest", "18.12.6");
        let tools = lab.tools();
        let cancel = CancellationToken::new();
        tools.spawn(cancel.clone());
        eventually("the start probe", || tools.status().omp.current.is_some()).await;
        assert_eq!(tools.status().omp.current.as_deref(), Some("18.12.3"));
        assert!(!lab.calls().iter().any(|c| c.starts_with("omp update")), "no run before it is due");

        // Due now: the scheduler runs everything once and schedules the next run ~6 h out.
        tools.0.status.send_modify(|s| s.next_check_at = Some(now_ms()));
        tools.0.reschedule.notify_one();
        eventually("the automatic run", || tools.status().omp.current.as_deref() == Some("18.12.6")).await;
        eventually("the next schedule", || tools.status().next_check_at.is_some_and(|at| at > now_ms() + EVERY - MIN)).await;

        // Auto off: a due time is ignored.
        lab.set("omp.latest", "18.13.0");
        tools.set_auto(false);
        tools.0.status.send_modify(|s| s.next_check_at = Some(now_ms()));
        tools.0.reschedule.notify_one();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(lab.calls().iter().filter(|c| *c == "omp update --check").count(), 1, "{:?}", lab.calls());
        cancel.cancel();
    }
}
