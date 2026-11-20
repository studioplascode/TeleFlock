//! Keeping the host responsive while agents load it (architecture §3.36, `HostInfo.priority`).
//!
//! Agents' builds and test runs can take every core and the disk. tf-hostd runs TeleFlock's own
//! processes, the SSH server and Tailscale above them, so the app's connection, new logins and the
//! tailnet keep answering:
//!
//! - **Linux with systemd and cgroup v2 CPU control.** Tasks in different cgroups do not compete
//!   by nice value, only by their units' weights. tf-hostd raises `CPUWeight` and `IOWeight`
//!   (default 100) to [`WEIGHT`], runtime only (`systemctl set-property --runtime`: gone at the next
//!   boot), on its own transient scope (`teleflock-hostd-*.scope`, made by `attach`), the SSH
//!   server's unit (the sshd listener's: `ssh.service`, `sshd.service`) and Tailscale's
//!   (`tailscaled.service`). Root sets system units; another user only its own manager's units
//!   (tf-hostd's scope there). A weight already higher stays.
//! - **Elsewhere** (no systemd, cgroup v1, no CPU controller, a unit tf-hostd may not set): nice
//!   [`NICE`] on every thread (Linux keeps nice per thread), and on the autogroup where the task
//!   sits in the root CPU group with autogroups on (there autogroups compete, not threads).
//!   Lowering a nice value needs root.
//! - **macOS:** nice [`NICE`], root only. **Windows:** `ABOVE_NORMAL_PRIORITY_CLASS` for tf-hostd and
//!   `attach` (no rights needed), and for sshd and tailscaled, which run as SYSTEM, when tf-hostd
//!   runs as an elevated administrator.
//! - `tf-hostd attach` (the app's connection) raises itself where it may ([`raise_attach`]: nice as
//!   root, the class on Windows). It runs in the login's session scope, which tf-hostd leaves alone:
//!   that scope holds whatever the login runs, and with CPU control it competes as one group anyway.
//!
//! The agents' work never rides on it:
//! - Children inherit nice. The herdr servers TeleFlock starts and the commands other hosts forward
//!   here drop a raised nice before exec (`tf_herdr::durable::drop_raised_nice`), in a session of
//!   their own (`setsid`: a new autogroup starts at nice 0).
//! - Children share their parent's cgroup. herdr servers run in a scope of their own already;
//!   forwarded commands are moved into one ([`work`]) while tf-hostd's own unit is raised.
//!   tf-hostd raises its unit only after a probe moved a throwaway process into a new scope the same
//!   way (redone hourly, and at once after a move failed), and not while a herdr server shares its
//!   cgroup (herdr started directly when its scope failed): then it renices its own threads, which
//!   compete inside that cgroup, and puts back the weights it had raised.
//! - `tf-forward` relays (`forward/cli.rs`, the caller's end) run inside panes as part of an
//!   agent's command: that is the agent's work, so they keep the agent's priority.
//!
//! Only the real home (`~/.teleflock`, like the boot service) touches the SSH server and
//! Tailscale; another home (labs) raises only itself, unless [`SERVICES_VAR`] names stand-in
//! units (`ssh=<unit>,tailscale=<unit>`; `none` leaves both alone in any home). Tests use a
//! recording [`System`].
//!
//! Checked at start and every [`EVERY`] (a restarted process comes back at normal priority, a
//! service may start later); the log notes changes only. Nothing is lowered again when tf-hostd
//! stops: its own scope goes with it, and the services' runtime settings with the next boot.

pub mod low;
pub mod system;
#[cfg(unix)]
pub mod work;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use tf_herdr::durable::Manager;
use tf_proto::{Millis, PriorityStatus};
use tokio::sync::{watch, Notify};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::ops::Ctx;
use crate::paths::Paths;
use crate::util::now_ms;

pub use system::{Fail, Replaced, System};

/// The nice value TeleFlock, the SSH server and Tailscale get where nice values compete.
pub const NICE: i32 = -10;
/// The `CPUWeight` and `IOWeight` they get where unit weights compete (systemd's default: 100).
pub const WEIGHT: u64 = 1000;
/// How often tf-hostd checks again.
pub const EVERY: Duration = Duration::from_secs(5 * 60);
/// How long a probe that moved a process into a new scope counts.
const PROBE_FRESH: Duration = Duration::from_secs(60 * 60);
/// Names the units that stand for the SSH server and Tailscale (`ssh=<unit>,tailscale=<unit>`),
/// or `none`. Unset: the real home finds the real ones, other homes leave them alone.
pub const SERVICES_VAR: &str = "TF_HOSTD_PRIORITY_SERVICES";

/// What tf-hostd raises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Target {
    TeleFlock,
    Ssh,
    Tailscale,
}

impl Target {
    /// As the app shows it (`PriorityStatus.raised`).
    pub fn label(self) -> &'static str {
        match self {
            Target::TeleFlock => "TeleFlock",
            Target::Ssh => "SSH server",
            Target::Tailscale => "Tailscale",
        }
    }

    /// In a sentence: "needs root to raise the SSH server".
    fn phrase(self) -> &'static str {
        match self {
            Target::TeleFlock => "TeleFlock",
            Target::Ssh => "the SSH server",
            Target::Tailscale => "Tailscale",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux,
    Macos,
    Windows,
    Other,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "linux") {
            Os::Linux
        } else if cfg!(target_os = "macos") {
            Os::Macos
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Other
        }
    }
}

/// A systemd unit and the manager that owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unit {
    pub manager: Manager,
    /// `ssh.service`, `teleflock-hostd-4809-1794591303200.scope`.
    pub name: String,
    /// Its cgroup below the cgroup root: `/system.slice/ssh.service`.
    pub cgroup: String,
}

/// A process tf-hostd may raise, as found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    /// The systemd unit its cgroup belongs to (Linux).
    pub unit: Option<Unit>,
    /// Weights decide for it: systemd, cgroup v2, and the unit's parent cgroup offers the CPU
    /// controller (nice values do not compete across such cgroups).
    pub weights: bool,
    /// Its autogroup's nice decides for it (Linux: autogroups on and the task in the root CPU group).
    pub autogroup: bool,
}

impl Proc {
    pub fn plain(pid: u32) -> Proc {
        Proc { pid, unit: None, weights: false, autogroup: false }
    }
}

/// What a home may touch besides tf-hostd itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Services {
    /// The real home: find the SSH server and Tailscale.
    Discover,
    /// These units stand for them (labs: throwaway units, never the real services).
    StandIns(Vec<(Target, String)>),
    /// Neither (another home without [`SERVICES_VAR`], or `none`).
    Untouched,
}

impl Services {
    /// From [`SERVICES_VAR`]'s value `var` and whether this is the real home.
    pub fn from_env(default_home: bool, var: Option<&str>) -> Services {
        match var.map(str::trim).filter(|v| !v.is_empty()) {
            Some("none") => Services::Untouched,
            Some(list) => {
                let mut units = Vec::new();
                for entry in list.split(',').map(str::trim).filter(|e| !e.is_empty()) {
                    let target = match entry.split_once('=') {
                        Some(("ssh", unit)) if !unit.trim().is_empty() => (Target::Ssh, unit.trim()),
                        Some(("tailscale", unit)) if !unit.trim().is_empty() => (Target::Tailscale, unit.trim()),
                        _ => {
                            warn!("{SERVICES_VAR}: ignoring {entry:?} (ssh=<unit> or tailscale=<unit>)");
                            continue;
                        }
                    };
                    units.push((target.0, target.1.to_string()));
                }
                Services::StandIns(units)
            }
            None if default_home => Services::Discover,
            None => Services::Untouched,
        }
    }
}

/// What the host looks like, as far as raising goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub os: Os,
    /// Root on Unix, an elevated administrator on Windows.
    pub privileged: bool,
    /// tf-hostd itself.
    pub own: Proc,
    /// A herdr server shares tf-hostd's cgroup (started directly when its own scope failed).
    pub herdr_in_own_cgroup: bool,
    /// The SSH server's and Tailscale's processes as found (empty: not running). Only what this
    /// home may touch is looked for.
    pub services: Vec<(Target, Vec<Proc>)>,
}

/// One change a check makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// `CPUWeight` and `IOWeight` at least [`WEIGHT`] (`systemctl set-property --runtime`).
    Weights { target: Target, unit: Unit },
    /// tf-hostd's own unit back to the weights it had before an earlier check raised them.
    Restore { unit: Unit },
    /// nice [`NICE`] on every thread of `pid` (and on its autogroup).
    Nice { target: Target, pid: u32, autogroup: bool },
    /// Windows: `ABOVE_NORMAL_PRIORITY_CLASS`.
    Class { target: Target, pid: u32 },
}

/// Why a target is not raised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// Only root (Windows: an administrator) may raise it.
    NeedsRoot,
    /// tf-hostd could not move a process into a scope of its own, so the agents' work it starts
    /// would share its raised unit.
    NoScope,
    /// It went wrong.
    Failed(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Plan {
    pub steps: Vec<Step>,
    /// Found, but left as it is (decided without trying).
    pub skipped: Vec<(Target, Why)>,
    /// tf-hostd runs as root (an administrator): a refusal is the system's, not a missing right.
    pub privileged: bool,
}

/// What a check did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    pub raised: BTreeSet<Target>,
    pub not: BTreeMap<Target, Why>,
    /// tf-hostd's own unit while it carries raised weights: agents' work tf-hostd starts moves out
    /// of it ([`work`]).
    pub own_unit: Option<Unit>,
}

/// What survives from one check to the next.
#[derive(Debug, Default)]
pub struct State {
    /// tf-hostd's own unit as an earlier check raised it, with the weights it replaced.
    own: Option<(Unit, Replaced)>,
    /// When a probe last moved a process into a new scope.
    probed_ok_at: Option<Instant>,
}

/// tf-hostd's own unit when tf-hostd may raise it: the transient scope `attach` made for it, with
/// weights, owned by a manager it may change (the system's as root, else its own user's).
fn own_unit(f: &Facts) -> Option<&Unit> {
    let unit = f.own.unit.as_ref()?;
    let ours = unit.name.starts_with("teleflock-hostd-") && unit.name.ends_with(".scope");
    let may = match unit.manager {
        Manager::System => f.privileged,
        Manager::User => true,
    };
    (ours && may && f.own.weights).then_some(unit)
}

/// A unit that holds a service alone: a system `.service`. Not a scope: a login session's, init's,
/// or a herdr server's (an sshd or tailscaled an agent started in a pane, gone to init as its
/// parent) holds more than the service, the agents themselves in the last case.
fn service_unit(unit: &Unit) -> bool {
    unit.manager == Manager::System && unit.name.ends_with(".service") && !unit.name.starts_with("user@")
}

/// What to change. `scope_ok`: a process can be moved into a new scope (a probe showed it);
/// `raised_before`: tf-hostd's own unit as an earlier check raised it.
pub fn plan(f: &Facts, scope_ok: bool, raised_before: Option<&Unit>) -> Plan {
    let mut p = Plan { privileged: f.privileged, ..Plan::default() };
    if f.os == Os::Windows {
        p.steps.push(Step::Class { target: Target::TeleFlock, pid: f.own.pid });
    } else {
        match own_unit(f) {
            Some(unit) if !f.herdr_in_own_cgroup => {
                if scope_ok {
                    p.steps.push(Step::Weights { target: Target::TeleFlock, unit: unit.clone() });
                } else {
                    p.skipped.push((Target::TeleFlock, Why::NoScope));
                }
            }
            // A herdr server shares tf-hostd's cgroup, or the cgroup is not tf-hostd's to weigh:
            // nice, which competes inside it.
            _ => p.steps.push(Step::Nice { target: Target::TeleFlock, pid: f.own.pid, autogroup: f.own.autogroup }),
        }
    }
    if let Some(before) = raised_before
        && !p.steps.iter().any(|s| matches!(s, Step::Weights { target: Target::TeleFlock, unit } if unit == before))
    {
        p.steps.insert(0, Step::Restore { unit: before.clone() });
    }
    for (target, procs) in &f.services {
        if procs.is_empty() {
            continue;
        }
        if !f.privileged {
            p.skipped.push((*target, Why::NeedsRoot));
            continue;
        }
        for proc in procs {
            let step = match (f.os, &proc.unit) {
                (Os::Windows, _) => Step::Class { target: *target, pid: proc.pid },
                (_, Some(unit)) if proc.weights && service_unit(unit) => Step::Weights { target: *target, unit: unit.clone() },
                _ => Step::Nice { target: *target, pid: proc.pid, autogroup: proc.autogroup },
            };
            if !p.steps.contains(&step) {
                p.steps.push(step);
            }
        }
    }
    p
}

/// Makes the plan's changes through `sys`.
pub fn apply(sys: &dyn System, plan: &Plan, state: &mut State) -> Outcome {
    let mut o = Outcome::default();
    for (target, why) in &plan.skipped {
        o.not.entry(*target).or_insert_with(|| why.clone());
    }
    let privileged = plan.privileged;
    let failed = |o: &mut Outcome, target: Target, fail: Fail| {
        let why = match fail {
            // Refused although tf-hostd runs as root: a container without CAP_SYS_NICE, a policy.
            Fail::Denied if privileged => Why::Failed("the system does not permit it".into()),
            Fail::Denied => Why::NeedsRoot,
            // It ended meanwhile: the next check finds what runs then.
            Fail::Gone => return,
            Fail::Other(e) => Why::Failed(e),
        };
        o.not.entry(target).or_insert(why);
    };
    for step in &plan.steps {
        match step {
            Step::Restore { unit } => {
                if let Some((_, before)) = state.own.take_if(|(u, _)| u == unit)
                    && let Err(e) = sys.restore_weights(unit, &before)
                {
                    warn!(unit = %unit.name, "could not put tf-hostd's own weights back: {e:?}");
                }
            }
            Step::Weights { target, unit } => match sys.raise_weights(unit) {
                Ok(replaced) => {
                    o.raised.insert(*target);
                    if *target == Target::TeleFlock {
                        o.own_unit = Some(unit.clone());
                        // Keep what the first raise replaced: later checks find the raised values.
                        if state.own.as_ref().is_none_or(|(u, _)| u != unit) {
                            state.own = Some((unit.clone(), replaced));
                        }
                    }
                }
                Err(fail) => failed(&mut o, *target, fail),
            },
            Step::Nice { target, pid, autogroup } => match sys.renice(*pid, *autogroup) {
                Ok(()) => {
                    o.raised.insert(*target);
                }
                Err(fail) => failed(&mut o, *target, fail),
            },
            Step::Class { target, pid } => match sys.raise_class(*pid) {
                Ok(()) => {
                    o.raised.insert(*target);
                }
                Err(fail) => failed(&mut o, *target, fail),
            },
        }
    }
    // Raised through one process and refused for another (two sshd): it is raised.
    let raised = o.raised.clone();
    o.not.retain(|t, _| !raised.contains(t));
    o
}

/// One check: what the host looks like, what to change, the changes. `move_failed`: a move of
/// agents' work into its scope failed since the last check (probe again).
pub fn check(sys: &dyn System, services: &Services, state: &mut State, now: Instant, move_failed: bool) -> (Facts, Plan, Outcome) {
    let facts = sys.observe(services);
    let scope_ok = match own_unit(&facts) {
        Some(unit) if !facts.herdr_in_own_cgroup => {
            let fresh = !move_failed && state.probed_ok_at.is_some_and(|at| now.saturating_duration_since(at) < PROBE_FRESH);
            fresh || {
                let ok = sys.probe(unit.manager);
                state.probed_ok_at = ok.then_some(now);
                ok
            }
        }
        _ => false,
    };
    let plan = plan(&facts, scope_ok, state.own.as_ref().map(|(u, _)| u));
    let outcome = apply(sys, &plan, state);
    (facts, plan, outcome)
}

/// `HostInfo.priority` for an outcome.
pub fn status(o: &Outcome, os: Os, at: Millis) -> PriorityStatus {
    PriorityStatus { raised: o.raised.iter().map(|t| t.label().to_string()).collect(), note: note(o, os), checked_at: at }
}

fn note(o: &Outcome, os: Os) -> Option<String> {
    let mut parts = Vec::new();
    let refused: Vec<&str> = o.not.iter().filter(|(_, why)| **why == Why::NeedsRoot).map(|(t, _)| t.phrase()).collect();
    if !refused.is_empty() {
        let who = if os == Os::Windows { "administrator rights" } else { "root" };
        parts.push(format!("needs {who} to raise {}", and_list(&refused)));
    }
    if o.not.get(&Target::TeleFlock) == Some(&Why::NoScope) {
        parts.push("TeleFlock stays at normal priority: systemd could not give the commands it starts a scope of their own".to_string());
    }
    // One sentence per reason: "could not raise the SSH server and Tailscale: <why>".
    let mut failures: Vec<(&str, Vec<&str>)> = Vec::new();
    for (target, why) in &o.not {
        if let Why::Failed(e) = why {
            match failures.iter_mut().find(|(reason, _)| *reason == e.as_str()) {
                Some((_, targets)) => targets.push(target.phrase()),
                None => failures.push((e.as_str(), vec![target.phrase()])),
            }
        }
    }
    for (reason, targets) in failures {
        parts.push(format!("could not raise {}: {}", and_list(&targets), clip(reason, 160)));
    }
    (!parts.is_empty()).then(|| parts.join("; "))
}

/// "a", "a and b", "a, b and c".
fn and_list(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

fn clip(s: &str, max: usize) -> String {
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    match line.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line.to_string(),
    }
}

/// How each raised target was raised, for the log. Names no pids or counts: per-connection sshd
/// processes come and go, and the line is logged only when it changes.
fn summary(plan: &Plan, o: &Outcome, status: &PriorityStatus) -> String {
    let mut how: BTreeMap<Target, Vec<String>> = BTreeMap::new();
    let mut restored = None;
    for step in &plan.steps {
        let (target, what) = match step {
            Step::Weights { target, unit } => (*target, format!("weights {WEIGHT} on {}", unit.name)),
            Step::Nice { target, autogroup, .. } => (*target, if *autogroup { format!("nice {NICE} with its autogroup") } else { format!("nice {NICE}") }),
            Step::Class { target, .. } => (*target, "above-normal class".to_string()),
            Step::Restore { unit } => {
                restored = Some(format!("tf-hostd's own weights on {} put back", unit.name));
                continue;
            }
        };
        let ways = how.entry(target).or_default();
        if o.raised.contains(&target) && !ways.contains(&what) {
            ways.push(what);
        }
    }
    let raised: Vec<String> = how.iter().filter(|(_, w)| !w.is_empty()).map(|(t, w)| format!("{} ({})", t.label(), w.join(", "))).collect();
    let mut line = if raised.is_empty() { "nothing raised".to_string() } else { format!("raised {}", raised.join("; ")) };
    for extra in restored.iter().chain(status.note.as_ref()) {
        line.push_str(&format!("; {extra}"));
    }
    line
}

// ───────────────────────────── the daemon's worker ─────────────────────────────

/// The last check's status, for every herdr session's `HostInfo.priority`.
static STATUS: LazyLock<watch::Sender<Option<PriorityStatus>>> = LazyLock::new(|| watch::channel(None).0);
/// The manager of tf-hostd's own unit while that unit carries raised weights.
static RAISED_UNIT: Mutex<Option<Manager>> = Mutex::new(None);
/// A move of agents' work into its scope failed: the next check probes again.
static MOVE_FAILED: AtomicBool = AtomicBool::new(false);
/// Checks again before [`EVERY`] is up.
static RECHECK: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Daemon start: checks now and every [`EVERY`], and publishes `HostInfo.priority`.
pub fn start(paths: &Paths, shutdown: CancellationToken) {
    let services = Services::from_env(paths.is_default_home(), std::env::var(SERVICES_VAR).ok().as_deref());
    let sys = system::real();
    tokio::spawn(async move {
        let mut state = State::default();
        let mut logged: Option<String> = None;
        loop {
            let (services, sys) = (services.clone(), sys.clone());
            let mut st = std::mem::take(&mut state);
            let move_failed = MOVE_FAILED.swap(false, Ordering::Relaxed);
            let done = tokio::task::spawn_blocking(move || {
                let r = check(sys.as_ref(), &services, &mut st, Instant::now(), move_failed);
                (st, r)
            })
            .await;
            match done {
                Ok((st, (facts, plan, outcome))) => {
                    state = st;
                    *RAISED_UNIT.lock().unwrap_or_else(|p| p.into_inner()) = outcome.own_unit.as_ref().map(|u| u.manager);
                    let status = status(&outcome, facts.os, now_ms());
                    let line = summary(&plan, &outcome, &status);
                    if logged.as_deref() != Some(line.as_str()) {
                        info!("process priority: {line}");
                        logged = Some(line);
                    } else {
                        debug!("process priority unchanged: {line}");
                    }
                    STATUS.send_replace(Some(status));
                }
                Err(e) => warn!("process priority check failed: {e}"),
            }
            tokio::select! {
                _ = shutdown.cancelled() => return,
                _ = tokio::time::sleep(EVERY) => {}
                _ = RECHECK.notified() => {}
            }
        }
    });
}

/// Publishes the status into this herdr session's `HostInfo.priority` now and on every change.
pub fn follow(ctx: &Arc<Ctx>) {
    let mut rx = STATUS.subscribe();
    ctx.state.set_priority(rx.borrow_and_update().clone());
    let ctx = ctx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = ctx.cancel.cancelled() => return,
                changed = rx.changed() => if changed.is_err() { return },
            }
            let status = rx.borrow_and_update().clone();
            ctx.state.set_priority(status);
        }
    });
}

/// `tf-hostd attach`, before it starts any thread: the app's connection runs above the agents where
/// it may (root: nice, inherited by the threads it starts; Windows: the priority class). A daemon
/// it starts inherits it too; the daemon's own check takes over from there.
pub fn raise_attach() {
    system::raise_self();
}

/// For agents' work tf-hostd starts itself (commands other hosts forward here): a [`work::Gate`]
/// that moves it into a scope of its own before it runs, while tf-hostd's own unit carries raised
/// weights; `None` otherwise (it starts as always).
#[cfg(unix)]
pub(crate) fn work_gate() -> Option<work::Gate> {
    gate_for(*RAISED_UNIT.lock().unwrap_or_else(|p| p.into_inner()), system::real())
}

/// [`work_gate`] for tf-hostd's own unit raised in `manager` (`None`: not raised).
#[cfg(unix)]
fn gate_for(manager: Option<Manager>, sys: Arc<dyn System>) -> Option<work::Gate> {
    let manager = manager?;
    let place: work::Place = Arc::new(move |pid| sys.place(manager, &work::unit_name("teleflock-forward"), "Command forwarded to this host by TeleFlock", pid));
    match work::Gate::new(place) {
        Ok(gate) => Some(gate),
        Err(e) => {
            warn!("cannot hold a forwarded command for its scope ({e}); it starts in tf-hostd's own unit");
            None
        }
    }
}

/// For a background child (`low`) while tf-hostd's own unit carries raised weights: a
/// [`work::Gate`] that moves it into a transient scope with `CPUWeight` and `IOWeight` 1 before it
/// runs, so it competes below the agents rather than with tf-hostd's weight; `None` otherwise (a
/// nice value is enough then).
#[cfg(target_os = "linux")]
pub(crate) fn background_gate() -> Option<work::Gate> {
    let manager = (*RAISED_UNIT.lock().unwrap_or_else(|p| p.into_inner()))?;
    let place: work::Place = Arc::new(move |pid| system::linux::place_low(manager, &work::unit_name("teleflock-background"), "TeleFlock background work (Cleanup scan)", pid));
    work::Gate::new(place).ok()
}

/// A move of agents' work into its scope failed: check again (and probe) now.
#[cfg_attr(not(unix), allow(dead_code))]
fn move_failed() {
    MOVE_FAILED.store(true, Ordering::Relaxed);
    RECHECK.notify_one();
}

#[cfg(test)]
mod tests;
