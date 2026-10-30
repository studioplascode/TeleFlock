//! Installing what a host lacks (architecture §3.12): the setup issues for a missing omp (or omp's
//! script interpreter), herdr, gh, git and ffmpeg, and their one-tap fixes.
//!
//! Installs run only on an explicit `host.setupApply`, each without a TTY, `NO_COLOR=1`, with a
//! timeout, in its own process group ([`tools::run`]) and under the user-wide install lock the
//! tool updater takes (`~/.cache/teleflock-tools.lock`). A fix succeeds only when the tool is found
//! afterwards (the daemon's PATH already holds `~/.local/bin` and `~/.bun/bin`, see
//! [`crate::userenv`]).
//!
//! - `install-omp`: omp's official installer in binary mode (`curl -fsSL https://omp.sh/install |
//!   sh -s -- --binary`; Windows: `install.ps1 -Binary`) → `~/.local/bin/omp`. Also the fix when omp
//!   is a script whose interpreter (node, …) is missing: the standalone binary needs none, and
//!   [`omp_bin`] prefers an omp that can start.
//! - `install-bun`: omp is a `#!/usr/bin/env bun` script and bun is missing: bun's installer
//!   (`curl -fsSL https://bun.sh/install | bash`, needs unzip) → `~/.bun/bin/bun`.
//! - `install-herdr`: herdr's installer (`curl -fsSL https://herdr.dev/install.sh | sh`; Windows:
//!   `irm https://herdr.dev/install.ps1 | iex`) → `~/.local/bin/herdr`, then the session's server.
//! - `install-gh`: the latest GitHub CLI release archive for this OS/arch, checked against the
//!   release's checksums → `~/.local/bin/gh` (no root).
//! - `install-git`, `install-ffmpeg`: the system package manager (apt-get, dnf, pacman, zypper,
//!   apk) as root or through passwordless `sudo -n`, else Homebrew as the user; otherwise the issue
//!   is not fixable and names the command to run.
//!
//! Installer scripts are downloaded into the hostd home first (curl, else wget) and run from
//! there, so a failed download never runs half a script. omp's, bun's and herdr's scripts download
//! with curl themselves: without curl only gh can be installed.
//!
//! Lab hook: with `TF_HOSTD_TEST_INSTALLERS=<dir>`, a fix whose `<dir>/<fix id>.sh` exists runs
//! that script (with sh) instead of its real procedure; everything around it stays the same.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use sha2::Digest as _;
use tf_proto::{ApiError, SetupIssue, Severity};
use tracing::{info, warn};

use crate::ops::git::{is_executable, resolve_bin, run_cmd};
use crate::ops::host::omp_bin;
use crate::ops::tools::{self, InstallLock};
use crate::ops::Ctx;
use crate::userenv::{self, Interpreter};

pub const FIX_OMP: &str = "install-omp";
pub const FIX_BUN: &str = "install-bun";
pub const FIX_HERDR: &str = "install-herdr";
pub const FIX_GIT: &str = "install-git";
pub const FIX_GH: &str = "install-gh";
pub const FIX_FFMPEG: &str = "install-ffmpeg";
/// Every install fix, in the order a batch runs them.
pub const FIXES: [&str; 6] = [FIX_BUN, FIX_OMP, FIX_HERDR, FIX_GIT, FIX_GH, FIX_FFMPEG];

const OMP_INSTALLER: &str = "https://omp.sh/install";
const BUN_INSTALLER: &str = "https://bun.sh/install";
const HERDR_INSTALLER: &str = "https://herdr.dev/install.sh";
const OMP_INSTALL_PS: &str = "& ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary";
const HERDR_INSTALL_PS: &str = "irm https://herdr.dev/install.ps1 | iex";
const GH_LATEST: &str = "https://api.github.com/repos/cli/cli/releases/latest";

/// One installer script or the gh install, downloads included.
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// One package-manager run.
const PM_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long a `sudo -n true` answer is reused (each failed one is an auth-log line).
const SUDO_TTL: Duration = Duration::from_secs(10 * 60);
const TEST_INSTALLERS: &str = "TF_HOSTD_TEST_INSTALLERS";

// ───────────────────────────── issues ─────────────────────────────

/// Missing tools, as setup issues.
pub(crate) struct Missing {
    /// omp (or its interpreter) and herdr: first in the checklist.
    pub core: Vec<SetupIssue>,
    /// git, gh, ffmpeg: after TeleFlock's own items.
    pub extras: Vec<SetupIssue>,
    /// herdr is not installed (its integration waits for it).
    pub herdr: bool,
}

/// What is missing (file lookups, plus a cached `sudo -n true` when git or ffmpeg is missing).
pub(crate) async fn missing(ctx: &Ctx) -> Missing {
    let fetch = Fetcher::find();
    let curl = matches!(fetch, Some(Fetcher::Curl(_)));
    let pkgs = Packages::find();
    let mut core = Vec::new();
    match omp_bin() {
        None => core.push(omp_issue(None, curl, &pkgs)),
        Some(bin) => match userenv::missing_interpreter(&bin) {
            None => {}
            Some(Interpreter::Env(name)) if name == "bun" => core.push(bun_issue(&bin, curl, &pkgs)),
            Some(other) => core.push(omp_issue(Some((&bin, &other)), curl, &pkgs)),
        },
    }
    let herdr = !is_executable(ctx.herdr.binary());
    if herdr {
        core.push(herdr_issue(&ctx.herdr_session, curl, &pkgs));
    }
    let mut extras = Vec::new();
    let git = resolve_bin("git").is_none();
    let ffmpeg = resolve_bin("ffmpeg").is_none() || resolve_bin("ffprobe").is_none();
    if git || ffmpeg {
        let sudo = pkgs.wants_sudo() && can_sudo().await;
        if git {
            extras.push(package_issue(Pkg::Git, &pkgs, sudo));
        }
        if ffmpeg {
            extras.push(package_issue(Pkg::Ffmpeg, &pkgs, sudo));
        }
    }
    if resolve_bin("gh").is_none() {
        extras.push(gh_issue(fetch.is_some(), &pkgs));
    }
    Missing { core, extras, herdr }
}

/// " `tool`'s installer downloads with curl, which is not installed: …".
fn needs(what: &str, pkg: Pkg, pkgs: &Packages) -> String {
    match pkgs.manual(pkg) {
        Some(cmd) => format!(" {what} needs {}, which is not installed: run `{cmd}` on the host, then re-check.", pkg.name()),
        None => format!(" {what} needs {}, which is not installed: install it, then re-check.", pkg.name()),
    }
}

fn omp_issue(broken: Option<(&Path, &Interpreter)>, curl: bool, pkgs: &Packages) -> SetupIssue {
    let (title, why) = match broken {
        None => ("Install omp".to_string(), "omp (oh-my-pi) is not installed, and TeleFlock runs every agent with it.".to_string()),
        Some((bin, interpreter)) => (
            "Reinstall omp as a standalone binary".to_string(),
            format!(
                "omp at {} is a {} script (`{}`) and {} is not installed, so omp cannot start.",
                bin.display(),
                interpreter.name(),
                interpreter.line(),
                interpreter.name()
            ),
        ),
    };
    let (fixable, how) = if cfg!(windows) {
        (
            resolve_bin("powershell").is_some(),
            format!(" Runs omp's official installer in binary mode in PowerShell (`{OMP_INSTALL_PS}`), which installs a standalone omp for your user."),
        )
    } else if curl {
        (
            true,
            " Runs omp's official installer in binary mode (`curl -fsSL https://omp.sh/install | sh -s -- --binary`), which installs a standalone omp in ~/.local/bin; TeleFlock uses that one from then on.".to_string(),
        )
    } else {
        (false, needs("omp's installer", Pkg::Curl, pkgs))
    };
    SetupIssue { id: FIX_OMP.into(), severity: Severity::Error, title, detail: format!("{why}{how}"), fixable, recommended: true }
}

fn bun_issue(bin: &Path, curl: bool, pkgs: &Packages) -> SetupIssue {
    let why = format!("omp at {} is a bun script (`#!/usr/bin/env bun`) and bun is not installed, so omp cannot start.", bin.display());
    let (fixable, how) = if !curl {
        (false, needs("bun's installer", Pkg::Curl, pkgs))
    } else if resolve_bin("unzip").is_none() {
        (false, needs("bun's installer", Pkg::Unzip, pkgs))
    } else if resolve_bin("bash").is_none() {
        (false, needs("bun's installer", Pkg::Bash, pkgs))
    } else {
        (
            true,
            " Runs bun's official installer (`curl -fsSL https://bun.sh/install | bash`), which installs bun in ~/.bun/bin and adds that dir to your shell's startup file.".to_string(),
        )
    };
    SetupIssue { id: FIX_BUN.into(), severity: Severity::Error, title: "Install bun for omp".into(), detail: format!("{why}{how}"), fixable, recommended: true }
}

fn herdr_issue(session: &str, curl: bool, pkgs: &Packages) -> SetupIssue {
    let why = "herdr is not installed, and TeleFlock runs every agent in a herdr pane.";
    let (fixable, how) = if cfg!(windows) {
        (
            resolve_bin("powershell").is_some(),
            format!(" Runs herdr's official installer in PowerShell (`{HERDR_INSTALL_PS}`), which installs herdr in %LOCALAPPDATA%\\Programs\\Herdr\\bin, then starts the herdr server for session {session}."),
        )
    } else if curl {
        (
            true,
            format!(" Runs herdr's official installer (`curl -fsSL https://herdr.dev/install.sh | sh`), which installs herdr in ~/.local/bin, then starts the herdr server for session {session}."),
        )
    } else {
        (false, needs("herdr's installer", Pkg::Curl, pkgs))
    };
    SetupIssue { id: FIX_HERDR.into(), severity: Severity::Error, title: "Install herdr".into(), detail: format!("{why}{how}"), fixable, recommended: true }
}

fn gh_issue(fetch: bool, pkgs: &Packages) -> SetupIssue {
    let why = "Pull request status, checks and merges on the board come from the GitHub CLI.";
    let target = GhTarget::of(std::env::consts::OS, std::env::consts::ARCH);
    let (fixable, how) = match target {
        _ if cfg!(windows) => (false, " Install it with `winget install --id GitHub.cli -e`, then sign in from Host setup in the app (or run `gh auth login` on the host).".to_string()),
        None => (false, " There is no GitHub CLI release for this OS and architecture; see https://cli.github.com.".to_string()),
        Some(_) if !fetch => (false, needs("Downloading it", Pkg::Curl, pkgs)),
        Some(t) if resolve_bin(t.extractor()).is_none() => (false, needs("Unpacking it", if t.zip { Pkg::Unzip } else { Pkg::Tar }, pkgs)),
        Some(t) => (
            true,
            format!(
                " Downloads the latest GitHub CLI release for {}/{} from github.com, checks it against the release's checksums and installs gh in ~/.local/bin (no root). Then sign in from Host setup in the app (or run `gh auth login` on the host).",
                t.os, t.arch
            ),
        ),
    };
    SetupIssue { id: FIX_GH.into(), severity: Severity::Info, title: "Install the GitHub CLI (gh)".into(), detail: format!("{why}{how}"), fixable, recommended: false }
}

fn package_issue(pkg: Pkg, pkgs: &Packages, sudo: bool) -> SetupIssue {
    let (id, title, severity, recommended, why, winget) = match pkg {
        Pkg::Git => (FIX_GIT, "Install git", Severity::Warn, true, "Repositories, diffs, branches, worktrees and commits need git.", "Git.Git"),
        _ => (FIX_FFMPEG, "Install ffmpeg", Severity::Info, false, "omp reads video attachments with ffmpeg and ffprobe.", "Gyan.FFmpeg"),
    };
    let (fixable, how) = if cfg!(windows) {
        (false, format!(" Install it with `winget install --id {winget} -e`."))
    } else {
        match plan(pkgs.system, pkgs.brew, pkgs.root, sudo) {
            Some((pm, via)) => (
                true,
                format!(
                    " Runs `{}`{}.",
                    command_line(pm, via, pm.package(pkg)),
                    match via {
                        Via::Root => " as root",
                        Via::Sudo => " (passwordless sudo)",
                        Via::User => "",
                    }
                ),
            ),
            None => (false, unprivileged(pkg, pkgs)),
        }
    };
    SetupIssue { id: id.into(), severity, title: title.into(), detail: format!("{why}{how}"), fixable, recommended }
}

/// Why TeleFlock can't install `pkg` here, and the command that does.
fn unprivileged(pkg: Pkg, pkgs: &Packages) -> String {
    match (pkgs.manual(pkg), pkgs.system) {
        (Some(cmd), Some(_)) => format!(" TeleFlock installs system packages only as root or with passwordless sudo: run `{cmd}` on the host."),
        (Some(cmd), None) => format!(" Run `{cmd}` on the host."),
        (None, _) if cfg!(target_os = "macos") && pkg == Pkg::Git => " Run `xcode-select --install` on the host (or install Homebrew).".into(),
        (None, _) if cfg!(target_os = "macos") => format!(" Install Homebrew (https://brew.sh), then run `brew install {}`.", pkg.name()),
        (None, _) => format!(" Install {} with your system's package manager.", pkg.name()),
    }
}

// ───────────────────────────── packages ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pkg {
    Git,
    Ffmpeg,
    Curl,
    Unzip,
    Tar,
    Bash,
}

impl Pkg {
    fn name(self) -> &'static str {
        match self {
            Pkg::Git => "git",
            Pkg::Ffmpeg => "ffmpeg",
            Pkg::Curl => "curl",
            Pkg::Unzip => "unzip",
            Pkg::Tar => "tar",
            Pkg::Bash => "bash",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pm {
    Apt,
    Dnf,
    Pacman,
    Zypper,
    Apk,
    Brew,
}

/// System package managers, in preference order.
const SYSTEM_PMS: [Pm; 5] = [Pm::Apt, Pm::Dnf, Pm::Pacman, Pm::Zypper, Pm::Apk];

impl Pm {
    fn program(self) -> &'static str {
        match self {
            Pm::Apt => "apt-get",
            Pm::Dnf => "dnf",
            Pm::Pacman => "pacman",
            Pm::Zypper => "zypper",
            Pm::Apk => "apk",
            Pm::Brew => "brew",
        }
    }

    /// The package that provides `pkg` (Fedora ships ffmpeg as `ffmpeg-free`).
    fn package(self, pkg: Pkg) -> &'static str {
        match (self, pkg) {
            (Pm::Dnf, Pkg::Ffmpeg) => "ffmpeg-free",
            _ => pkg.name(),
        }
    }

    fn install_args(self, package: &str) -> Vec<String> {
        let args: &[&str] = match self {
            Pm::Apt => &["install", "-y", "-q", "--no-install-recommends"],
            Pm::Dnf => &["install", "-y", "-q"],
            Pm::Pacman => &["-S", "--noconfirm", "--needed"],
            Pm::Zypper => &["--non-interactive", "install", "--no-recommends"],
            Pm::Apk => &["add", "--no-progress"],
            Pm::Brew => &["install"],
        };
        args.iter().map(|a| a.to_string()).chain(std::iter::once(package.to_string())).collect()
    }

    /// Variables that keep it from prompting.
    fn env(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Pm::Apt => &[("DEBIAN_FRONTEND", "noninteractive")],
            Pm::Brew => &[("NONINTERACTIVE", "1"), ("HOMEBREW_NO_ENV_HINTS", "1")],
            _ => &[],
        }
    }
}

/// How TeleFlock runs a package manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Via {
    Root,
    /// `sudo -n` (passwordless).
    Sudo,
    /// As the user (Homebrew, which refuses root).
    User,
}

/// The package managers on this host (cheap lookups; whether sudo works is asked separately).
struct Packages {
    system: Option<Pm>,
    brew: bool,
    root: bool,
}

impl Packages {
    fn find() -> Packages {
        Packages {
            system: SYSTEM_PMS.into_iter().find(|pm| resolve_bin(pm.program()).is_some()),
            brew: resolve_bin("brew").is_some(),
            root: is_root(),
        }
    }

    /// Whether `sudo -n` would decide anything.
    fn wants_sudo(&self) -> bool {
        !self.root && self.system.is_some()
    }

    /// The command the user runs to install `pkg` by hand.
    fn manual(&self, pkg: Pkg) -> Option<String> {
        if cfg!(windows) {
            return None;
        }
        match self.system {
            Some(pm) => {
                let sudo = if self.root { "" } else { "sudo " };
                Some(format!("{sudo}{} {}", pm.program(), pm.install_args(pm.package(pkg)).join(" ")))
            }
            None if self.brew => Some(format!("brew install {}", Pm::Brew.package(pkg))),
            None => None,
        }
    }
}

/// How TeleFlock can install system packages: the system package manager as root or through
/// passwordless sudo, else Homebrew as the user (it refuses root); `None`: not at all.
fn plan(system: Option<Pm>, brew: bool, root: bool, sudo: bool) -> Option<(Pm, Via)> {
    match system {
        Some(pm) if root => Some((pm, Via::Root)),
        Some(pm) if sudo => Some((pm, Via::Sudo)),
        _ if brew && !root => Some((Pm::Brew, Via::User)),
        _ => None,
    }
}

fn command_line(pm: Pm, via: Via, package: &str) -> String {
    let sudo = if via == Via::Sudo { "sudo -n " } else { "" };
    format!("{sudo}{} {}", pm.program(), pm.install_args(package).join(" "))
}

fn is_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Whether `sudo -n` runs commands without a password (cached for [`SUDO_TTL`]).
async fn can_sudo() -> bool {
    static CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    if let Some((at, ok)) = *CACHE.lock().unwrap_or_else(|p| p.into_inner())
        && at.elapsed() < SUDO_TTL
    {
        return ok;
    }
    let ok = match resolve_bin("sudo") {
        Some(sudo) => run_cmd(&sudo, &["-n", "true"], None, &[], None, Duration::from_secs(5)).await.is_ok_and(|o| o.ok()),
        None => false,
    };
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some((Instant::now(), ok));
    ok
}

// ───────────────────────────── installing ─────────────────────────────

/// Runs install fix `fix` (one of [`FIXES`]), checks the tool is found afterwards and, for herdr,
/// starts this session's server.
pub(crate) async fn apply(ctx: &Ctx, fix: &str) -> Result<(), ApiError> {
    let started = Instant::now();
    let installed = {
        let _lock = InstallLock::acquire(&tools::install_lock_path(), tools::LOCK_WAIT).await.map_err(|e| ApiError::new("busy", e).retryable())?;
        let ran = match test_installer(fix) {
            Some(script) => run_script("sh", &script, &[]).await,
            None => match fix {
                FIX_OMP => install_omp(ctx).await,
                FIX_BUN => install_bun(ctx).await,
                FIX_HERDR => install_herdr(ctx).await,
                FIX_GH => install_gh(ctx).await,
                FIX_GIT => install_package(Pkg::Git).await,
                FIX_FFMPEG => install_package(Pkg::Ffmpeg).await,
                other => Err(ApiError::new("invalid_params", format!("unknown install `{other}`"))),
            },
        };
        ran.and_then(|()| verify(ctx, fix))
    };
    let result = match installed {
        Ok(()) if fix == FIX_HERDR => ctx
            .herdr
            .ensure_server_with(&crate::herdr_health::launch(&ctx.paths.home))
            .await
            .map(|_| ())
            .map_err(|e| ApiError::new("herdr_error", format!("herdr is installed, but its server did not start: {e}"))),
        other => other,
    };
    let secs = started.elapsed().as_secs();
    match &result {
        Ok(()) => info!(fix, secs, "installed"),
        Err(e) => warn!(fix, secs, "install failed: {e}"),
    }
    result
}

/// The tool a fix installs, found where hostd looks for it.
fn verify(ctx: &Ctx, fix: &str) -> Result<(), ApiError> {
    let (what, found) = match fix {
        FIX_OMP => ("omp", omp_bin().is_some_and(|b| userenv::missing_interpreter(&b).is_none())),
        FIX_BUN => ("bun", userenv::on_path("bun").is_some()),
        FIX_HERDR => ("herdr", is_executable(ctx.herdr.binary())),
        FIX_GH => ("gh", resolve_bin("gh").is_some()),
        FIX_GIT => ("git", resolve_bin("git").is_some()),
        _ => ("ffmpeg and ffprobe", resolve_bin("ffmpeg").is_some() && resolve_bin("ffprobe").is_some()),
    };
    if found {
        return Ok(());
    }
    let mut err = ApiError::new("install_failed", format!("the installer finished, but {what} is still not found"));
    if fix == FIX_HERDR && let Some(elsewhere) = tf_herdr::locate_binary() {
        err.hint = Some(format!("It was installed at {}; restart tf-hostd (`tf-hostd stop`, then reconnect) to use it.", elsewhere.display()));
    }
    Err(err)
}

/// `TF_HOSTD_TEST_INSTALLERS/<fix>.sh`, when the lab hook names one.
fn test_installer(fix: &str) -> Option<PathBuf> {
    let dir = std::env::var_os(TEST_INSTALLERS).filter(|d| !d.is_empty())?;
    let script = PathBuf::from(dir).join(format!("{fix}.sh"));
    script.is_file().then_some(script)
}

async fn install_omp(ctx: &Ctx) -> Result<(), ApiError> {
    if cfg!(windows) {
        return powershell(OMP_INSTALL_PS).await;
    }
    let scratch = Scratch::new(ctx, FIX_OMP)?;
    let script = scratch.download(OMP_INSTALLER, "install.sh").await?;
    run_script("sh", &script, &["--binary"]).await
}

async fn install_bun(ctx: &Ctx) -> Result<(), ApiError> {
    let scratch = Scratch::new(ctx, FIX_BUN)?;
    let script = scratch.download(BUN_INSTALLER, "install.sh").await?;
    run_script("bash", &script, &[]).await
}

async fn install_herdr(ctx: &Ctx) -> Result<(), ApiError> {
    if cfg!(windows) {
        return powershell(HERDR_INSTALL_PS).await;
    }
    let scratch = Scratch::new(ctx, FIX_HERDR)?;
    let script = scratch.download(HERDR_INSTALLER, "install.sh").await?;
    run_script("sh", &script, &[]).await
}

async fn run_script(shell: &str, script: &Path, args: &[&str]) -> Result<(), ApiError> {
    let shell = resolve_bin(shell).ok_or_else(|| ApiError::new("install_failed", format!("{shell} is not installed")))?;
    let argv: Vec<String> = std::iter::once(script.to_string_lossy().into_owned()).chain(args.iter().map(|a| a.to_string())).collect();
    let out = tools::run(&shell, &argv, SCRIPT_TIMEOUT, &[], &[]).await.map_err(|e| ApiError::new("install_failed", e))?;
    if out.code != 0 {
        return Err(failure(&out));
    }
    Ok(())
}

async fn powershell(command: &str) -> Result<(), ApiError> {
    let ps = resolve_bin("powershell").ok_or_else(|| ApiError::new("install_failed", "PowerShell is not available"))?;
    let args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command];
    let out = tools::run(&ps, &args, SCRIPT_TIMEOUT, &[], &[]).await.map_err(|e| ApiError::new("install_failed", e))?;
    if out.code != 0 {
        return Err(failure(&out));
    }
    Ok(())
}

fn failure(out: &tools::Out) -> ApiError {
    match tools::last_line(&out.text) {
        Some(line) => ApiError::new("install_failed", format!("{line} (exit {})", out.code)),
        None => ApiError::new("install_failed", format!("the installer failed (exit {})", out.code)),
    }
}

async fn install_package(pkg: Pkg) -> Result<(), ApiError> {
    if cfg!(windows) {
        return Err(ApiError::new("unsupported", format!("TeleFlock cannot install {} on Windows hosts", pkg.name())));
    }
    let pkgs = Packages::find();
    let sudo = pkgs.wants_sudo() && can_sudo().await;
    let Some((pm, via)) = plan(pkgs.system, pkgs.brew, pkgs.root, sudo) else {
        let mut err = ApiError::new("permission_denied", format!("TeleFlock cannot install {} here", pkg.name()));
        err.hint = Some(unprivileged(pkg, &pkgs).trim().to_string());
        return Err(err);
    };
    let install = pm.install_args(pm.package(pkg));
    let mut out = pm_run(pm, via, &install).await?;
    if out.code != 0 && pm == Pm::Apt {
        // Fresh systems (containers, new WSL distros) often have no package lists yet.
        let update = pm_run(pm, via, &["update".to_string(), "-q".to_string()]).await?;
        if update.code == 0 {
            out = pm_run(pm, via, &install).await?;
        }
    }
    if out.code != 0 {
        return Err(failure(&out));
    }
    Ok(())
}

async fn pm_run(pm: Pm, via: Via, args: &[String]) -> Result<tools::Out, ApiError> {
    let program = resolve_bin(pm.program()).ok_or_else(|| ApiError::new("install_failed", format!("{} is not installed", pm.program())))?;
    let ran = match via {
        Via::Sudo => {
            let sudo = resolve_bin("sudo").ok_or_else(|| ApiError::new("install_failed", "sudo is not installed"))?;
            let argv: Vec<String> = std::iter::once("-n".to_string())
                .chain(pm.env().iter().map(|(k, v)| format!("{k}={v}")))
                .chain(std::iter::once(program.to_string_lossy().into_owned()))
                .chain(args.iter().cloned())
                .collect();
            tools::run(&sudo, &argv, PM_TIMEOUT, &[], &[]).await
        }
        Via::Root | Via::User => tools::run(&program, args, PM_TIMEOUT, pm.env(), &[]).await,
    };
    ran.map_err(|e| ApiError::new("install_failed", e))
}

// ───────────────────────────── gh ─────────────────────────────

/// A GitHub CLI release archive for one OS/arch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GhTarget {
    /// In asset names: `linux`, `macOS`.
    os: &'static str,
    /// In asset names: `amd64`, `arm64`, `386`, `armv6`.
    arch: &'static str,
    /// `.zip` (macOS) instead of `.tar.gz`.
    zip: bool,
}

impl GhTarget {
    fn of(os: &str, arch: &str) -> Option<GhTarget> {
        let (os, zip) = match os {
            "linux" => ("linux", false),
            "macos" => ("macOS", true),
            _ => return None,
        };
        let arch = match (arch, zip) {
            ("x86_64", _) => "amd64",
            ("aarch64", _) => "arm64",
            ("x86", false) => "386",
            ("arm", false) => "armv6",
            _ => return None,
        };
        Some(GhTarget { os, arch, zip })
    }

    fn extractor(self) -> &'static str {
        if self.zip { "unzip" } else { "tar" }
    }

    /// `gh_2.103.3_linux_amd64` (the archive's top dir and file stem).
    fn stem(self, version: &str) -> String {
        format!("gh_{version}_{}_{}", self.os, self.arch)
    }

    fn archive(self, version: &str) -> String {
        format!("{}.{}", self.stem(version), if self.zip { "zip" } else { "tar.gz" })
    }
}

/// The parts of a release the install uses.
#[derive(Debug, PartialEq)]
struct GhRelease {
    version: String,
    archive: String,
    archive_url: String,
    checksums_url: String,
}

/// Picks `target`'s archive and the checksums file from the GitHub releases API answer.
fn parse_gh_release(json: &str, target: GhTarget) -> Result<GhRelease, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("unreadable release list: {e}"))?;
    let tag = v.get("tag_name").and_then(Value::as_str).ok_or("the release has no tag")?;
    let version = tag.trim_start_matches('v').to_string();
    let url_of = |name: &str| {
        v.get("assets")
            .and_then(Value::as_array)
            .and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(name)))
            .and_then(|x| x.get("browser_download_url").and_then(Value::as_str))
            .map(str::to_string)
    };
    let archive = target.archive(&version);
    let archive_url = url_of(&archive).ok_or_else(|| format!("release {tag} has no {archive}"))?;
    let checksums_url = url_of(&format!("gh_{version}_checksums.txt")).ok_or_else(|| format!("release {tag} has no checksums"))?;
    Ok(GhRelease { version, archive, archive_url, checksums_url })
}

/// The sha256 that a `<hex>  <name>` checksums file lists for `name`.
fn checksum_for<'a>(sums: &'a str, name: &str) -> Option<&'a str> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let (hash, file) = (it.next()?, it.next()?);
        (file.trim_start_matches('*') == name).then_some(hash)
    })
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

async fn install_gh(ctx: &Ctx) -> Result<(), ApiError> {
    let fail = |m: String| ApiError::new("install_failed", m);
    let target = GhTarget::of(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| fail("no GitHub CLI release for this OS and architecture".into()))?;
    let scratch = Scratch::new(ctx, FIX_GH)?;
    let listing = scratch.download(GH_LATEST, "release.json").await?;
    let release = parse_gh_release(&std::fs::read_to_string(&listing).map_err(|e| fail(e.to_string()))?, target).map_err(fail)?;
    let archive = scratch.download(&release.archive_url, &release.archive).await?;
    let sums = scratch.download(&release.checksums_url, "checksums.txt").await?;
    let want = std::fs::read_to_string(&sums).ok().and_then(|s| checksum_for(&s, &release.archive).map(str::to_ascii_lowercase));
    let have = sha256_file(&archive).map_err(|e| fail(format!("read {}: {e}", archive.display())))?;
    if want.as_deref() != Some(have.as_str()) {
        return Err(fail(format!("{} does not match the release's checksum", release.archive)));
    }
    let unpack = resolve_bin(target.extractor()).ok_or_else(|| fail(format!("{} is not installed", target.extractor())))?;
    let into = scratch.dir.to_string_lossy().into_owned();
    let file = archive.to_string_lossy().into_owned();
    let args: Vec<&str> = if target.zip { vec!["-q", "-o", file.as_str(), "-d", into.as_str()] } else { vec!["-xzf", file.as_str(), "-C", into.as_str()] };
    let out = tools::run(&unpack, &args, FETCH_TIMEOUT, &[], &[]).await.map_err(fail)?;
    if out.code != 0 {
        return Err(failure(&out));
    }
    let gh = scratch.dir.join(target.stem(&release.version)).join("bin").join("gh");
    let dest_dir = crate::paths::home_dir().join(".local").join("bin");
    place_executable(&gh, &dest_dir.join("gh")).map_err(|e| fail(format!("install gh into {}: {e}", dest_dir.display())))?;
    info!(version = %release.version, "installed gh into {}", dest_dir.display());
    Ok(())
}

/// Copies `src` to `dst` (0755) through a temp file + rename.
fn place_executable(src: &Path, dst: &Path) -> std::io::Result<()> {
    let dir = dst.parent().ok_or_else(|| std::io::Error::other("no parent dir"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), std::process::id()));
    std::fs::copy(src, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, dst).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ───────────────────────────── downloads ─────────────────────────────

#[derive(Debug, Clone)]
enum Fetcher {
    Curl(PathBuf),
    Wget(PathBuf),
}

impl Fetcher {
    fn find() -> Option<Fetcher> {
        resolve_bin("curl").map(Fetcher::Curl).or_else(|| resolve_bin("wget").map(Fetcher::Wget))
    }

    async fn get(&self, url: &str, dest: &Path) -> Result<(), String> {
        let dest = dest.to_string_lossy();
        let out = match self {
            Fetcher::Curl(bin) => tools::run(bin, &["-fsSL", "--retry", "2", "--connect-timeout", "15", "-o", &*dest, url], FETCH_TIMEOUT, &[], &[]).await?,
            Fetcher::Wget(bin) => tools::run(bin, &["-q", "--tries=2", "--timeout=30", "-O", &*dest, url], FETCH_TIMEOUT, &[], &[]).await?,
        };
        if out.code != 0 {
            return Err(format!("couldn't download {url}: {}", tools::last_line(&out.text).unwrap_or_else(|| format!("exit {}", out.code))));
        }
        Ok(())
    }
}

/// A private work dir under the hostd home, removed when dropped.
struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(ctx: &Ctx, fix: &str) -> Result<Scratch, ApiError> {
        let dir = ctx.paths.home.join("tmp").join(format!("{fix}-{}-{}", std::process::id(), crate::util::now_ms()));
        std::fs::create_dir_all(&dir).map_err(|e| ApiError::new("io_error", format!("create {}: {e}", dir.display())))?;
        Ok(Scratch { dir })
    }

    /// Downloads `url` to `<dir>/<name>` (curl, else wget).
    async fn download(&self, url: &str, name: &str) -> Result<PathBuf, ApiError> {
        let fetch = Fetcher::find().ok_or_else(|| ApiError::new("install_failed", "neither curl nor wget is installed"))?;
        let dest = self.dir.join(name);
        fetch.get(url, &dest).await.map_err(|e| ApiError::new("install_failed", e))?;
        Ok(dest)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Where herdr's installer puts herdr (`$HERDR_INSTALL_DIR`, else `~/.local/bin`; Windows:
/// `%LOCALAPPDATA%\Programs\Herdr\bin`). A session on a host without herdr talks to that path, so
/// its server starts once `install-herdr` ran.
pub(crate) fn herdr_install_path() -> PathBuf {
    let exe = if cfg!(windows) { "herdr.exe" } else { "herdr" };
    if let Some(dir) = std::env::var_os("HERDR_INSTALL_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir).join(exe);
    }
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| crate::paths::home_dir().join("AppData").join("Local"));
        return local.join("Programs").join("Herdr").join("bin").join(exe);
    }
    crate::paths::home_dir().join(".local").join("bin").join(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_plans() {
        assert_eq!(plan(Some(Pm::Apt), false, true, false), Some((Pm::Apt, Via::Root)));
        assert_eq!(plan(Some(Pm::Dnf), true, false, true), Some((Pm::Dnf, Via::Sudo)), "the system manager first");
        assert_eq!(plan(Some(Pm::Apt), true, false, false), Some((Pm::Brew, Via::User)), "no sudo: Linuxbrew as the user");
        assert_eq!(plan(None, true, true, false), None, "Homebrew refuses root");
        assert_eq!(plan(None, true, false, false), Some((Pm::Brew, Via::User)));
        assert_eq!(plan(Some(Pm::Pacman), false, false, false), None);
        assert_eq!(command_line(Pm::Apt, Via::Sudo, "git"), "sudo -n apt-get install -y -q --no-install-recommends git");
        assert_eq!(command_line(Pm::Dnf, Via::Root, Pm::Dnf.package(Pkg::Ffmpeg)), "dnf install -y -q ffmpeg-free");
        let user = Packages { system: Some(Pm::Zypper), brew: false, root: false };
        assert_eq!(user.manual(Pkg::Git).as_deref(), Some("sudo zypper --non-interactive install --no-recommends git"));
        assert!(user.wants_sudo());
        let root = Packages { system: Some(Pm::Apk), brew: false, root: true };
        assert_eq!(root.manual(Pkg::Ffmpeg).as_deref(), Some("apk add --no-progress ffmpeg"));
        assert!(!root.wants_sudo());
        assert_eq!(Packages { system: None, brew: true, root: false }.manual(Pkg::Ffmpeg).as_deref(), Some("brew install ffmpeg"));
    }

    #[test]
    fn package_issues_say_what_runs_or_what_to_run() {
        if cfg!(windows) {
            return;
        }
        let user = Packages { system: Some(Pm::Apt), brew: false, root: false };
        let fixable = package_issue(Pkg::Git, &user, true);
        assert!(fixable.fixable && fixable.recommended && fixable.id == FIX_GIT);
        assert!(fixable.detail.contains("Runs `sudo -n apt-get install -y -q --no-install-recommends git` (passwordless sudo)."), "{}", fixable.detail);
        let blocked = package_issue(Pkg::Ffmpeg, &user, false);
        assert!(!blocked.fixable && !blocked.recommended && blocked.id == FIX_FFMPEG);
        assert!(blocked.detail.contains("run `sudo apt-get install -y -q --no-install-recommends ffmpeg` on the host"), "{}", blocked.detail);
    }

    #[test]
    fn gh_release_assets() {
        assert_eq!(GhTarget::of("linux", "x86_64"), Some(GhTarget { os: "linux", arch: "amd64", zip: false }));
        assert_eq!(GhTarget::of("macos", "aarch64").map(|t| t.archive("2.1.0")), Some("gh_2.1.0_macOS_arm64.zip".into()));
        assert_eq!(GhTarget::of("macos", "x86"), None);
        assert_eq!(GhTarget::of("windows", "x86_64"), None);
        let json = r#"{"tag_name":"v2.103.3","assets":[
            {"name":"gh_2.103.3_checksums.txt","browser_download_url":"https://x/sums"},
            {"name":"gh_2.103.3_linux_amd64.deb","browser_download_url":"https://x/deb"},
            {"name":"gh_2.103.3_linux_amd64.tar.gz","browser_download_url":"https://x/tgz"}]}"#;
        let target = GhTarget::of("linux", "x86_64").unwrap();
        assert_eq!(
            parse_gh_release(json, target).unwrap(),
            GhRelease {
                version: "2.103.3".into(),
                archive: "gh_2.103.3_linux_amd64.tar.gz".into(),
                archive_url: "https://x/tgz".into(),
                checksums_url: "https://x/sums".into()
            }
        );
        assert!(parse_gh_release(json, GhTarget::of("linux", "aarch64").unwrap()).unwrap_err().contains("has no gh_2.103.3_linux_arm64.tar.gz"));
        assert!(parse_gh_release("{}", target).is_err());
        let sums = "aaa  gh_2.103.3_linux_386.tar.gz\nBBB  gh_2.103.3_linux_amd64.tar.gz\n";
        assert_eq!(checksum_for(sums, "gh_2.103.3_linux_amd64.tar.gz"), Some("BBB"));
        assert_eq!(checksum_for(sums, "gh_2.103.3_macOS_arm64.zip"), None);
    }

    #[test]
    fn sha256_and_placement() {
        let td = tempfile::tempdir().unwrap();
        let src = td.path().join("gh");
        std::fs::write(&src, "abc").unwrap();
        assert_eq!(sha256_file(&src).unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let dst = td.path().join("home/.local/bin/gh");
        place_executable(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "abc");
        assert!(is_executable(&dst));
    }
}
