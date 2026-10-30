//! The GitHub CLI's sign-in and git's commit identity on this host (`gh.authStatus`,
//! `gh.authStart`, `git.identity`, `git.setIdentity`; architecture §3.12 and §3.14), and the Host
//! setup items they complete (`sign-in-gh`, `set-git-identity`).
//!
//! `gh.authStart` runs `gh auth login --web` with piped stdio as a sign-in flow ([`authflow`],
//! kind [`KIND`]): gh's one-time code and `https://github.com/login/device` are completed in the
//! device's browser, and nothing opens a browser on the host. `gh auth status` asks GitHub about
//! every token, so its answer is cached ([`STATUS_TTL`]) and the setup checklist waits for an
//! uncached one only briefly ([`SETUP_WAIT`]); a slower one lands in the background and
//! republishes the checklist.

use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_proto::{
    ApiError, AuthFlow, AuthFlowState, AuthPaste, GhAccount, GhAuthStartParams, GhAuthStatus, GitIdentity, GitIdentityParams, SetupIssue,
    Severity,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::{mpsc, watch};

use crate::authflow::{self, FlowCtl, FlowInput, LoopbackRedirect};
use crate::ops::fs::home_dir;
use crate::ops::git::{resolve_bin, run_cmd};
use crate::ops::tools::{self, strip_ansi, TreeGuard};
use crate::ops::Ctx;
use crate::util::clip;

/// `AuthFlow.kind` of GitHub CLI sign-ins.
pub const KIND: &str = "gh";
/// Setup issue: gh is installed but has no working sign-in (completed with `gh.authStart`).
pub const ISSUE_SIGN_IN: &str = "sign-in-gh";
/// Setup issue: git's `user.name` or `user.email` is not set (fixed with `git.setIdentity`).
pub const ISSUE_GIT_IDENTITY: &str = "set-git-identity";

const DEFAULT_HOST: &str = "github.com";
/// GitHub's device codes live 15 minutes.
const SIGN_IN_TTL: Duration = Duration::from_secs(15 * 60);
/// `gh auth status` asks GitHub about every token: its answer is reused this long.
const STATUS_TTL: Duration = Duration::from_secs(60);
/// The signed-in account's profile (`gh api user`) behind the identity suggestions.
const USER_TTL: Duration = Duration::from_secs(10 * 60);
/// How long the setup checklist waits for a `gh auth status` that isn't cached (the first host
/// probe of a session must fit in 3 s); a slower one lands in the background.
const SETUP_WAIT: Duration = Duration::from_millis(1500);
/// How long `git.identity` waits for the sign-in status behind its suggestions.
const SUGGEST_WAIT: Duration = Duration::from_secs(8);
/// `gh auth status` (it asks GitHub about every token).
const NET_TIMEOUT: Duration = Duration::from_secs(20);
/// `gh api user` for the identity suggestions: with [`SUGGEST_WAIT`] well inside the app's 30 s
/// request timeout of `git.identity`.
const USER_TIMEOUT: Duration = Duration::from_secs(10);
/// Local runs (`gh --version`, `git config`).
const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
/// `gh auth setup-git` (writes git's global config).
const SETUP_GIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the output gh printed before it exited may still take to arrive.
const DRAIN: Duration = Duration::from_millis(500);
/// The first gh with `gh auth status --json` (older ones print text only).
const STATUS_JSON_SINCE: (u32, u32, u32) = (2, 81, 0);
/// The first gh that knows `gh auth login --clipboard`: recent ones copy the one-time code to the
/// host's clipboard unless told `--clipboard=false`.
const CLIPBOARD_FLAG_SINCE: (u32, u32, u32) = (2, 79, 0);
/// Longest `user.name` / `user.email` that `git.setIdentity` takes.
const MAX_IDENTITY: usize = 200;
/// Every gh run: no colors, prompts or update checks.
const GH_ENV: &[(&str, &str)] =
    &[("NO_COLOR", "1"), ("GH_PROMPT_DISABLED", "1"), ("GH_NO_UPDATE_NOTIFIER", "1"), ("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1"), ("GIT_TERMINAL_PROMPT", "0")];
/// Every git run here.
const GIT_ENV: &[(&str, &str)] = &[("LC_ALL", "C"), ("GIT_TERMINAL_PROMPT", "0")];

fn env_with<'a>(base: &[(&'a str, &'a str)], extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    base.iter().chain(extra).copied().collect()
}

/// A variable as the child processes see it: `extra` (tests) over the daemon's environment.
fn var(extra: &[(&str, &str)], key: &str) -> Option<OsString> {
    match extra.iter().rev().find(|(k, _)| *k == key) {
        Some((_, v)) => Some(OsString::from(v)),
        None => std::env::var_os(key),
    }
    .filter(|v| !v.is_empty())
}

/// gh is not installed (also every `gh.*` pull request method's error then).
pub(crate) fn no_gh() -> ApiError {
    ApiError::new("gh_error", "the GitHub CLI (gh) is not installed on this host")
        .with_hint("Install it from Host setup in the app, then sign in there (or run `gh auth login` on the host).")
}

fn no_git() -> ApiError {
    ApiError::new("git_error", "git is not installed on this host").with_hint("Install it from Host setup in the app.")
}

// ───────────────────────────── versions ─────────────────────────────

/// `2.102.0` from `gh version 2.102.0 (2026-09-30)`; else the line itself.
fn parse_version(first_line: &str) -> Option<String> {
    let line = first_line.trim();
    if line.is_empty() {
        return None;
    }
    let v = line.strip_prefix("gh version ").and_then(|r| r.split_whitespace().next()).unwrap_or(line);
    Some(v.to_string())
}

fn version_at_least(v: &str, min: (u32, u32, u32)) -> Option<bool> {
    let mut parts = v.trim_start_matches('v').split(['.', '-', '+']).map(|p| p.parse::<u32>());
    let major = parts.next()?.ok()?;
    let minor = parts.next()?.ok()?;
    let patch = parts.next().and_then(Result::ok).unwrap_or(0);
    Some((major, minor, patch) >= min)
}

async fn gh_version(bin: &Path, env: &[(&str, &str)]) -> Option<String> {
    let out = tools::run(bin, &["--version"], LOCAL_TIMEOUT, env, &[]).await.ok()?;
    (out.code == 0).then(|| out.stdout.lines().next().and_then(parse_version)).flatten()
}

// ───────────────────────────── gh auth status ─────────────────────────────

/// How one account stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    /// gh's check passed (`state: success`).
    Ok,
    /// gh couldn't ask GitHub (`state: timeout`): signed in as far as anyone can tell.
    Unchecked,
    /// The token doesn't work.
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    account: GhAccount,
    standing: Standing,
}

/// gh's words for why a token failed, shorter: its JSON error for a revoked token is the whole
/// HTTP 401 body.
fn token_error(e: &str) -> String {
    let e = e.trim();
    if e.contains("401") || e.contains("Bad credentials") {
        "GitHub no longer accepts its token".into()
    } else {
        clip(e, 160)
    }
}

/// Active accounts first, then github.com's.
fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by_key(|e| (!e.account.active, e.account.host != DEFAULT_HOST));
}

/// `gh auth status --json hosts` (gh ≥ 2.81, exit 0 whatever the accounts' state):
/// `{"hosts":{"github.com":[{state, error, active, host, login, tokenSource, scopes, gitProtocol}]}}`.
fn parse_status_json(stdout: &str) -> Option<Vec<Entry>> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    let mut out = Vec::new();
    for (host, list) in v.get("hosts")?.as_object()? {
        for e in list.as_array()? {
            let s = |k: &str| e.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
            let state = s("state").unwrap_or_default();
            let standing = match state.as_str() {
                "success" => Standing::Ok,
                "timeout" => Standing::Unchecked,
                _ => Standing::Failed,
            };
            let error = match standing {
                Standing::Ok => None,
                Standing::Unchecked => Some(s("error").map_or_else(|| "GitHub didn't answer in time".to_string(), |e| token_error(&e))),
                Standing::Failed => Some(s("error").map_or_else(
                    || if state == "refresh_expired" { "its token expired and can't be renewed".to_string() } else { "its token doesn't work".to_string() },
                    |e| token_error(&e),
                )),
            };
            out.push(Entry {
                account: GhAccount {
                    host: s("host").unwrap_or_else(|| host.clone()),
                    login: s("login").unwrap_or_default(),
                    active: e.get("active").and_then(Value::as_bool).unwrap_or(false),
                    ok: standing == Standing::Ok,
                    error,
                    token_source: s("tokenSource"),
                    scopes: s("scopes"),
                    git_protocol: s("gitProtocol"),
                },
                standing,
            });
        }
    }
    sort_entries(&mut out);
    Some(out)
}

/// `(login, source)` of `octocat (keyring)`; `using token (GH_TOKEN)` has no login.
fn split_who(rest: &str) -> (String, Option<String>) {
    let rest = rest.trim();
    let (who, source) = match rest.rfind(" (") {
        Some(i) if rest.ends_with(')') => (&rest[..i], Some(rest[i + 2..rest.len() - 1].to_string())),
        _ => (rest, None),
    };
    let who = who.trim();
    (if who == "using token" { String::new() } else { who.to_string() }, source)
}

/// One account line of the text output: `(host, login, source, standing)`.
fn account_line(body: &str) -> Option<(String, String, Option<String>, Standing)> {
    let (standing, rest) = if let Some(r) = body.strip_prefix("Logged in to ") {
        (Standing::Ok, r)
    } else if let Some(r) = body.strip_prefix("Failed to log in to ") {
        (Standing::Failed, r)
    } else if let Some(r) = body.strip_prefix("Timeout trying to log in to ") {
        (Standing::Unchecked, r)
    } else {
        return None;
    };
    let (host, who) = rest.split_once(' ')?;
    let who = who.strip_prefix("account ").or_else(|| who.strip_prefix("as ")).unwrap_or(who);
    let (login, source) = split_who(who);
    Some((host.to_string(), login, source, standing))
}

/// A line without its status mark (`✓ `, `X `, `! `, `- `).
fn strip_icon(t: &str) -> &str {
    for icon in ["✓ ", "✔ ", "! ", "X ", "x ", "- ", "* "] {
        if let Some(r) = t.strip_prefix(icon) {
            return r.trim_start();
        }
    }
    t
}

/// `gh auth status` text (gh before 2.81): a host line, then per account
/// `✓ Logged in to <host> account <login> (<source>)` (`as <login>` before gh 2.40),
/// `X Failed to log in to <host> account <login> (<source>)` (or `using token (<source>)`),
/// `X Timeout trying to log in to …`, `X <host>: authentication failed` (before 2.40), each
/// followed by `- Active account: true`, `- Git operations protocol: https`,
/// `- Token scopes: 'gist', 'repo'` and `- The token in <source> is invalid.` lines.
fn parse_status_text(text: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    // Lines before gh 2.40 name no active account: one account per host, the active one.
    let mut multi = false;
    for raw in text.lines() {
        let line = strip_ansi(raw);
        let body = strip_icon(line.trim());
        if body.is_empty() {
            continue;
        }
        if let Some((host, login, source, standing)) = account_line(body) {
            out.push(Entry {
                account: GhAccount {
                    host,
                    login,
                    active: false,
                    ok: standing == Standing::Ok,
                    error: match standing {
                        Standing::Ok => None,
                        Standing::Unchecked => Some("GitHub didn't answer in time".into()),
                        Standing::Failed => Some("its token doesn't work".into()),
                    },
                    token_source: source,
                    scopes: None,
                    git_protocol: None,
                },
                standing,
            });
            continue;
        }
        // Before gh 2.40: `X github.com: authentication failed`, `X github.com: the token in … is …`.
        if let Some((host, what)) = body.split_once(": ")
            && !host.contains(' ')
            && host.contains('.')
            && (what.starts_with("authentication failed") || what.starts_with("the token in "))
        {
            out.push(Entry {
                account: GhAccount {
                    host: host.to_string(),
                    login: String::new(),
                    active: false,
                    ok: false,
                    error: Some(clip(what, 160)),
                    token_source: None,
                    scopes: None,
                    git_protocol: None,
                },
                standing: Standing::Failed,
            });
            continue;
        }
        let Some(cur) = out.last_mut() else { continue };
        if let Some(v) = body.strip_prefix("Active account: ") {
            multi = true;
            cur.account.active = v.trim() == "true";
        } else if let Some(v) = body.strip_prefix("Git operations protocol: ") {
            cur.account.git_protocol = Some(v.trim().to_string());
        } else if let Some(v) = body.strip_prefix("Git operations for ").and_then(|r| r.split_once(" configured to use ")) {
            cur.account.git_protocol = v.1.split_whitespace().next().map(str::to_string);
        } else if let Some(v) = body.strip_prefix("Token scopes: ") {
            let scopes: Vec<&str> = v.split(',').map(|s| s.trim().trim_matches('\'')).filter(|s| !s.is_empty() && *s != "none").collect();
            cur.account.scopes = (!scopes.is_empty()).then(|| scopes.join(", "));
        } else if body.starts_with("The ") && (body.ends_with("is invalid.") || body.ends_with("is no longer valid.")) {
            cur.account.error = Some(body.trim_end_matches('.').to_string());
        }
    }
    if !multi {
        for e in &mut out {
            e.account.active = true;
        }
    }
    sort_entries(&mut out);
    out
}

fn status_error(out: &tools::Out) -> ApiError {
    let msg = tools::last_line(&out.text).unwrap_or_else(|| format!("gh auth status failed (exit {})", out.code));
    ApiError::new("gh_error", msg)
}

fn run_error(e: String) -> ApiError {
    if e.contains("timed out") { ApiError::new("timeout", e).retryable() } else { ApiError::new("gh_error", e) }
}

/// gh's accounts: `--json` where gh has it, else its text.
async fn auth_entries(bin: &Path, env: &[(&str, &str)], version: Option<&str>) -> Result<Vec<Entry>, ApiError> {
    if version.and_then(|v| version_at_least(v, STATUS_JSON_SINCE)).unwrap_or(true) {
        let out = tools::run(bin, &["auth", "status", "--json", "hosts"], NET_TIMEOUT, env, &[]).await.map_err(run_error)?;
        if let Some(entries) = parse_status_json(&out.stdout) {
            return Ok(entries);
        }
        if !out.text.contains("unknown flag") {
            return Err(status_error(&out));
        }
    }
    let out = tools::run(bin, &["auth", "status"], NET_TIMEOUT, env, &[]).await.map_err(run_error)?;
    let entries = parse_status_text(&out.text);
    if entries.is_empty() && out.code != 0 && !out.text.contains("not logged in") {
        return Err(status_error(&out));
    }
    Ok(entries)
}

/// git hands HTTPS credentials to gh (`gh auth setup-git` added `!gh auth git-credential` as a
/// `credential.<url>.helper`).
async fn credential_helper(extra: &[(&str, &str)]) -> bool {
    let Some(git) = resolve_bin("git") else { return false };
    let env = env_with(GIT_ENV, extra);
    match run_cmd(&git, &["config", "--global", "--get-regexp", r"^credential\..*helper$"], None, &env, None, LOCAL_TIMEOUT).await {
        Ok(out) if out.ok() => out.stdout_str().lines().any(|l| l.contains("auth git-credential")),
        _ => false,
    }
}

/// One look at gh's sign-in.
#[derive(Debug)]
struct Probe {
    version: Option<String>,
    /// `Err`: gh couldn't tell (it timed out, its output was unreadable).
    entries: Result<Vec<Entry>, ApiError>,
    git_helper: bool,
}

impl Probe {
    /// A working sign-in, or one gh couldn't check (GitHub unreachable); `None`: gh couldn't tell.
    #[cfg(test)]
    fn signed_in(&self) -> Option<bool> {
        self.entries.as_ref().ok().map(|e| e.iter().any(|e| e.standing != Standing::Failed))
    }

    /// The account whose profile suggests a git identity: a working one, active and github.com first.
    fn suggest_from(&self) -> Option<&GhAccount> {
        self.entries.as_ref().ok()?.iter().find(|e| e.standing == Standing::Ok && !e.account.login.is_empty()).map(|e| &e.account)
    }

    fn status(&self, flows: Vec<AuthFlow>) -> Result<GhAuthStatus, ApiError> {
        let entries = self.entries.as_ref().map_err(Clone::clone)?;
        Ok(GhAuthStatus {
            installed: true,
            version: self.version.clone(),
            accounts: entries.iter().map(|e| e.account.clone()).collect(),
            git_credential_helper: self.git_helper,
            flows,
        })
    }
}

async fn run_probe(bin: &Path, extra: &[(&str, &str)]) -> Probe {
    let env = env_with(GH_ENV, extra);
    let version = gh_version(bin, &env).await;
    let entries = auth_entries(bin, &env, version.as_deref()).await;
    let git_helper = credential_helper(extra).await;
    Probe { version, entries, git_helper }
}

// ───────────────────────────── cache ─────────────────────────────

#[derive(Default)]
struct Slot {
    last: Option<(Instant, Arc<Probe>)>,
    /// A probe running now: flips to `true` once it is stored.
    running: Option<watch::Receiver<bool>>,
    /// Sessions whose checklist stopped waiting for the running probe: republished when it lands.
    republish: Vec<Weak<Ctx>>,
}

#[derive(Default)]
struct Cache {
    /// Per gh binary.
    slots: HashMap<PathBuf, Slot>,
    /// Bumped by [`invalidate`]: a probe that started before it is not kept.
    generation: u64,
    /// `gh api user` per `<host> <login>` (only answers: a failure is asked again).
    users: HashMap<String, (Instant, GhUser)>,
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

fn cache() -> MutexGuard<'static, Cache> {
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Forgets every cached answer (a sign-in changed them).
fn invalidate() {
    let mut c = cache();
    c.generation += 1;
    c.users.clear();
    for slot in c.slots.values_mut() {
        slot.last = None;
        slot.running = None;
    }
}

/// gh's sign-in as cached, refreshed when older than [`STATUS_TTL`]. Waits for the refresh up to
/// `wait` (`None`: until it lands); after that answers the previous look (or `None`), and
/// republishes `ctx`'s checklist once the refresh lands.
async fn probe(bin: &Path, wait: Option<Duration>, ctx: Option<&Ctx>) -> Option<Arc<Probe>> {
    let mut done = {
        let mut c = cache();
        let generation = c.generation;
        let slot = c.slots.entry(bin.to_path_buf()).or_default();
        if let Some((at, p)) = &slot.last
            && at.elapsed() < STATUS_TTL
        {
            return Some(p.clone());
        }
        match slot.running.as_ref().filter(|rx| rx.has_changed().is_ok()) {
            Some(rx) => rx.clone(),
            None => {
                let (tx, rx) = watch::channel(false);
                slot.running = Some(rx.clone());
                let bin = bin.to_path_buf();
                tokio::spawn(async move {
                    let probe = Arc::new(run_probe(&bin, &[]).await);
                    let republish = {
                        let mut c = cache();
                        if c.generation == generation {
                            let slot = c.slots.entry(bin).or_default();
                            slot.last = Some((Instant::now(), probe));
                            slot.running = None;
                            std::mem::take(&mut slot.republish)
                        } else {
                            Vec::new()
                        }
                    };
                    let _ = tx.send(true);
                    republish_later(republish);
                });
                rx
            }
        }
    };
    let landed = match wait {
        None => done.wait_for(|d| *d).await.is_ok(),
        Some(w) => matches!(tokio::time::timeout(w, done.wait_for(|d| *d)).await, Ok(Ok(_))),
    };
    let mut c = cache();
    let slot = c.slots.entry(bin.to_path_buf()).or_default();
    if !landed && let Some(ctx) = ctx {
        let me = Arc::downgrade(&ctx.arc());
        if !slot.republish.iter().any(|w| w.ptr_eq(&me)) {
            slot.republish.push(me);
        }
    }
    slot.last.as_ref().map(|(_, p)| p.clone())
}

/// Republishes the checklists that stopped waiting for a look that landed now. Not inlined in
/// [`probe`]: `publish` awaits the checklist, which awaits `probe` (an async type cycle).
fn republish_later(ctxs: Vec<Weak<Ctx>>) {
    if ctxs.is_empty() {
        return;
    }
    tokio::spawn(async move {
        for ctx in ctxs.iter().filter_map(Weak::upgrade) {
            crate::ops::host::publish(&ctx).await;
        }
    });
}

/// Looks again now (after a sign-in) and keeps the answer.
async fn refresh_now(bin: &Path, extra: &[(&str, &str)]) {
    invalidate();
    let generation = cache().generation;
    let probe = Arc::new(run_probe(bin, extra).await);
    let mut c = cache();
    if c.generation == generation {
        c.slots.entry(bin.to_path_buf()).or_default().last = Some((Instant::now(), probe));
    }
}

/// `gh.authStatus`.
pub(crate) async fn auth_status(ctx: &Ctx) -> Result<GhAuthStatus, ApiError> {
    let flows: Vec<AuthFlow> = authflow::list().into_iter().filter(|f| f.kind == KIND).collect();
    let Some(bin) = resolve_bin("gh") else {
        return Ok(GhAuthStatus { installed: false, version: None, accounts: Vec::new(), git_credential_helper: false, flows });
    };
    match probe(&bin, None, Some(ctx)).await {
        Some(p) => p.status(flows),
        None => Err(ApiError::new("gh_error", "couldn't read gh's sign-in").retryable()),
    }
}

// ───────────────────────────── gh auth login ─────────────────────────────

/// What `gh auth login --web` prints (stderr).
#[derive(Debug, Clone, PartialEq, Eq)]
enum LoginEvent {
    /// The one-time code to enter.
    Code(String),
    /// The page to enter it on.
    Url(String),
    /// gh waits for Enter (its wording when it thinks it can prompt).
    Enter,
    /// GitHub approved the device: gh stores the sign-in now.
    Approved,
    /// `✓ Logged in as <login>`.
    LoggedIn(String),
    /// No system keyring: gh keeps the token in plain text in its config folder.
    PlainText,
    /// Anything else gh said: the reason when it fails.
    Other(String),
}

/// `https://github.com/login/device`, or the device page of the host gh names (`Press Enter to
/// open github.com in your browser...`, gh before 2.40).
fn device_page(target: &str) -> String {
    if target.starts_with("http://") || target.starts_with("https://") { target.to_string() } else { format!("https://{target}/login/device") }
}

fn first_word(s: &str) -> Option<String> {
    s.split_whitespace().next().map(|w| w.trim_end_matches([',', ';']).to_string()).filter(|w| !w.is_empty())
}

/// Events of one line gh printed.
fn login_line(raw: &str) -> Vec<LoginEvent> {
    let line = strip_ansi(raw);
    let line = line.trim_end_matches(['\r', '\n']);
    // Indented lines explain the line before them (why the clipboard or a browser failed).
    if line.starts_with(char::is_whitespace) || line.trim().is_empty() {
        return Vec::new();
    }
    let body = strip_icon(line.trim());
    let mut out = Vec::new();
    if let Some(i) = body.find("one-time code: ") {
        out.extend(first_word(&body[i + "one-time code: ".len()..]).map(LoginEvent::Code));
    } else if let Some(rest) = body.strip_prefix("One-time code (")
        && let Some((code, _)) = rest.split_once(')')
    {
        out.push(LoginEvent::Code(code.trim().to_string()));
    } else if let Some(i) = body.find("to continue in your web browser: ") {
        out.extend(first_word(&body[i + "to continue in your web browser: ".len()..]).map(LoginEvent::Url));
    } else if body.contains("Press Enter") {
        if let Some(i) = body.find("to open ")
            && let Some(target) = body[i + "to open ".len()..].split(" in your browser").next().filter(|_| body.contains(" in your browser"))
        {
            out.push(LoginEvent::Url(device_page(target.trim())));
        }
        if body.contains("Authentication complete") {
            out.push(LoginEvent::Approved);
        }
        out.push(LoginEvent::Enter);
    } else if body.starts_with("Authentication complete") {
        out.push(LoginEvent::Approved);
    } else if let Some(login) = body.strip_prefix("Logged in as ") {
        out.push(LoginEvent::LoggedIn(login.trim().trim_end_matches('.').to_string()));
    } else if body.contains("credentials saved in plain text") {
        out.push(LoginEvent::PlainText);
    } else if !(body.starts_with("Failed to copy one-time code")
        || body.starts_with("Failed opening a web browser")
        || body.starts_with("gh config set ")
        || body.starts_with("Configured git protocol")
        || body.starts_with("You were already logged in")
        || body.starts_with("Please try entering the URL"))
    {
        out.push(LoginEvent::Other(body.to_string()));
    }
    out
}

/// gh's interactive wording waits on an unterminated line (`Press Enter to open … in your
/// browser... `, `Authentication complete. Press Enter to continue...`).
fn is_enter_prompt(partial: &str) -> bool {
    partial.contains("Press Enter") && partial.trim_end().ends_with("...")
}

/// Splits one output stream of `gh auth login` into lines.
struct LoginParser {
    partial: Vec<u8>,
}

impl LoginParser {
    fn new() -> Self {
        Self { partial: Vec::new() }
    }

    /// Events of the complete lines in `bytes`, and of an Enter prompt gh left unterminated.
    fn feed(&mut self, bytes: &[u8]) -> Vec<LoginEvent> {
        self.partial.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(i) = self.partial.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=i).collect();
            out.extend(login_line(&String::from_utf8_lossy(&line)));
        }
        if !self.partial.is_empty() {
            let text = String::from_utf8_lossy(&self.partial).into_owned();
            if is_enter_prompt(&strip_ansi(&text)) {
                // Answered: what gh prints next starts a line of its own.
                self.partial.clear();
                out.extend(login_line(&text));
            }
        }
        out
    }

    /// The unterminated rest, once gh exited.
    fn finish(&mut self) -> Vec<LoginEvent> {
        let rest = std::mem::take(&mut self.partial);
        login_line(&String::from_utf8_lossy(&rest))
    }
}

/// Why a sign-in failed, from what gh said last.
fn failure_reason(said: &VecDeque<String>) -> Option<String> {
    if let Some(env) = said.iter().find(|l| l.contains("environment variable is being used for authentication")) {
        return Some(format!("{env} Remove it from tf-hostd's environment to store a sign-in."));
    }
    said.back().map(|l| clip(l, 300))
}

/// The done message: who signed in, where gh keeps it, and how git's setup went.
fn done_message(host: &str, login: Option<&str>, plain_text: bool, git: Option<Result<(), String>>) -> String {
    let mut msg = match login {
        Some(l) => format!("Signed in to {host} as {l}."),
        None => format!("Signed in to {host}."),
    };
    if plain_text {
        msg.push_str(" gh keeps the token in its config folder (this host has no system keyring).");
    }
    match git {
        Some(Ok(())) => msg.push_str(&format!(" git uses it for HTTPS to {host}.")),
        Some(Err(e)) => msg.push_str(&format!(" Couldn't set git up to use it: {e}")),
        None => {}
    }
    msg
}

/// gh's host names: `github.com`, `ghe.example.com[:port]`.
fn check_host(h: &str) -> Result<String, ApiError> {
    let h = h.trim().to_ascii_lowercase();
    let (name, port) = match h.rsplit_once(':') {
        Some((n, p)) => (n, Some(p)),
        None => (h.as_str(), None),
    };
    let name_ok = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|l| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-') && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    let port_ok = port.is_none_or(|p| p.parse::<u16>().is_ok_and(|p| p > 0));
    if name_ok && port_ok { Ok(h) } else { Err(ApiError::new("invalid_params", format!("hostname: `{h}` is not a GitHub host name"))) }
}

/// What a sign-in runs with.
struct Run {
    bin: PathBuf,
    host: String,
    setup_git: bool,
    /// No-op browser openers (`accounts::no_browser_dir`).
    shim: Option<PathBuf>,
    /// Extra environment (tests: `GH_CONFIG_DIR`, `HOME`).
    env: Vec<(String, String)>,
    /// The session whose checklist is republished once signed in.
    ctx: Option<Weak<Ctx>>,
}

impl Run {
    fn extra(&self) -> Vec<(&str, &str)> {
        self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    fn command(&self, clipboard_flag: bool) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.args(["auth", "login", "--hostname", self.host.as_str(), "--git-protocol", "https", "--web"]);
        if clipboard_flag {
            cmd.arg("--clipboard=false");
        }
        cmd.current_dir(home_dir())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in GH_ENV {
            cmd.env(k, v);
        }
        if let Some(dir) = &self.shim {
            let opener = dir.join("xdg-open").to_string_lossy().into_owned();
            // gh splits GH_BROWSER like a shell would.
            let quoted = if opener.contains(char::is_whitespace) { format!("'{opener}'") } else { opener.clone() };
            cmd.env("GH_BROWSER", quoted).env("BROWSER", &opener);
            let path = std::env::var_os("PATH").unwrap_or_default();
            let joined = std::env::join_paths(std::iter::once(dir.clone()).chain(std::env::split_paths(&path))).unwrap_or(path);
            cmd.env("PATH", joined);
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
}

/// Serializes starting sign-ins (one running sign-in per GitHub host).
static STARTING: Mutex<()> = Mutex::new(());

/// Starts `gh auth login` for `host` as a flow, or returns the host's sign-in that still runs.
fn start_sign_in(run: Run) -> AuthFlow {
    let _one = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(f) = authflow::list().into_iter().find(|f| f.kind == KIND && f.subject.as_deref() == Some(run.host.as_str()) && !f.state.is_final()) {
        return f;
    }
    let ctl = authflow::start(KIND, format!("GitHub ({})", run.host), Some(run.host.clone()), SIGN_IN_TTL);
    ctl.update(|f| f.message = Some("Starting gh…".into()));
    let flow = ctl.snapshot();
    tracing::info!(host = %run.host, flow = ctl.id(), "gh sign-in started");
    tokio::spawn(drive(ctl, run));
    flow
}

/// `gh.authStart`.
pub(crate) async fn auth_start(ctx: &Ctx, p: GhAuthStartParams) -> Result<AuthFlow, ApiError> {
    let host = check_host(p.hostname.as_deref().unwrap_or(DEFAULT_HOST))?;
    let bin = resolve_bin("gh").ok_or_else(no_gh)?;
    Ok(start_sign_in(Run {
        bin,
        host,
        setup_git: p.setup_git.unwrap_or(true),
        shim: crate::ops::accounts::no_browser_dir(&ctx.paths.run),
        env: Vec::new(),
        ctx: Some(Arc::downgrade(&ctx.arc())),
    }))
}

/// A running sign-in's progress.
struct SignIn {
    redirect: Option<LoopbackRedirect>,
    login: Option<String>,
    plain_text: bool,
    approved: bool,
    /// What gh said last (the reason when it fails).
    said: VecDeque<String>,
}

impl SignIn {
    fn new() -> Self {
        Self { redirect: None, login: None, plain_text: false, approved: false, said: VecDeque::new() }
    }

    async fn event(&mut self, ctl: &FlowCtl, ev: LoginEvent, stdin: &mut Option<ChildStdin>) {
        match ev {
            LoginEvent::Code(code) => ctl.update(|f| {
                f.instructions = Some(format!("Enter the code {code} on that page and authorize GitHub CLI."));
                f.user_code = Some(code);
            }),
            LoginEvent::Url(url) if !self.approved => {
                let instructions = ctl.snapshot().instructions;
                self.redirect = ctl.publish_url(&url, instructions);
                let message = if self.redirect.is_some() { "Waiting for you to approve it in the browser…" } else { "Waiting for you to enter the code…" };
                ctl.update(|f| f.message = Some(message.into()));
            }
            LoginEvent::Url(_) => {}
            LoginEvent::Enter => {
                if let Some(pipe) = stdin.as_mut() {
                    let _ = pipe.write_all(b"\n").await;
                    let _ = pipe.flush().await;
                }
            }
            LoginEvent::Approved => {
                self.approved = true;
                // Nothing to enter anymore: the app shows progress instead of the code.
                ctl.update(|f| {
                    f.user_code = None;
                    f.url = None;
                    f.callback_port = None;
                    f.redirect_uri = None;
                    f.instructions = None;
                    f.paste = AuthPaste::None;
                    f.message = Some("GitHub approved the sign-in. gh is saving it on this host…".into());
                });
            }
            LoginEvent::LoggedIn(login) => {
                ctl.update(|f| f.message = Some(format!("Signed in as {login}.")));
                self.login = Some(login);
            }
            LoginEvent::PlainText => self.plain_text = true,
            LoginEvent::Other(line) => {
                if self.said.len() == 6 {
                    self.said.pop_front();
                }
                self.said.push_back(line);
            }
        }
    }

    /// A pasted address, only for gh's browser sign-in with a loopback callback (GitHub
    /// Enterprise without device codes).
    async fn input(&self, input: FlowInput) {
        let verdict = match &self.redirect {
            Some(r) => match authflow::check_paste(r, &input.text) {
                Ok(()) => authflow::replay_redirect(r, &input.text).await.map(|_| ()),
                Err(e) => Err(e),
            },
            None => Err(ApiError::new("invalid_params", "this sign-in finishes on GitHub's page; there is nothing to paste")),
        };
        input.reply(verdict);
    }
}

enum Chunk {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
}

fn read_into<R: tokio::io::AsyncRead + Unpin + Send + 'static>(mut pipe: R, tx: mpsc::Sender<Chunk>, wrap: fn(Vec<u8>) -> Chunk) {
    tokio::spawn(async move {
        let mut buf = vec![0u8; 8192];
        loop {
            match pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(wrap(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
}

async fn setup_git(run: &Run) -> Result<(), String> {
    let env = env_with(GH_ENV, &run.extra());
    let out = tools::run(&run.bin, &["auth", "setup-git", "--hostname", run.host.as_str()], SETUP_GIT_TIMEOUT, &env, &[]).await?;
    if out.code == 0 { Ok(()) } else { Err(tools::last_line(&out.text).unwrap_or_else(|| format!("gh auth setup-git failed (exit {})", out.code))) }
}

async fn drive(mut ctl: FlowCtl, run: Run) {
    let extra = run.extra();
    let env = env_with(GH_ENV, &extra);
    let clipboard_flag = gh_version(&run.bin, &env).await.and_then(|v| version_at_least(&v, CLIPBOARD_FLAG_SINCE)).unwrap_or(false);
    if ctl.is_final() {
        return;
    }
    let mut child = match run.command(clipboard_flag).spawn() {
        Ok(child) => child,
        Err(e) => {
            ctl.finish(AuthFlowState::Failed, Some(format!("couldn't start gh: {e}")));
            return;
        }
    };
    let mut tree = TreeGuard(child.id());
    let mut stdin = child.stdin.take();
    let (tx, mut rx) = mpsc::channel::<Chunk>(64);
    if let Some(out) = child.stdout.take() {
        read_into(out, tx.clone(), Chunk::Stdout);
    }
    if let Some(err) = child.stderr.take() {
        read_into(err, tx.clone(), Chunk::Stderr);
    }
    drop(tx);
    let (mut out, mut err) = (LoginParser::new(), LoginParser::new());
    let mut s = SignIn::new();
    let mut open = true;
    let started = Instant::now();
    let status = loop {
        tokio::select! {
            chunk = rx.recv(), if open => match chunk {
                Some(Chunk::Stdout(b)) => {
                    for ev in out.feed(&b) {
                        s.event(&ctl, ev, &mut stdin).await;
                    }
                }
                Some(Chunk::Stderr(b)) => {
                    for ev in err.feed(&b) {
                        s.event(&ctl, ev, &mut stdin).await;
                    }
                }
                None => open = false,
            },
            input = ctl.next_input() => match input {
                Some(input) => s.input(input).await,
                // Cancelled or expired: the guard kills gh's whole process group.
                None => break None,
            },
            status = child.wait() => break Some(status),
        }
    };
    let Some(status) = status else {
        drop(tree);
        tracing::info!(host = %run.host, "gh sign-in stopped: {:?}", ctl.snapshot().state);
        return;
    };
    // Exited: what it printed last may still be in the pipes.
    tree.0 = None;
    let drain = tokio::time::Instant::now() + DRAIN;
    while open {
        match tokio::time::timeout_at(drain, rx.recv()).await {
            Ok(Some(Chunk::Stdout(b))) => {
                for ev in out.feed(&b) {
                    s.event(&ctl, ev, &mut stdin).await;
                }
            }
            Ok(Some(Chunk::Stderr(b))) => {
                for ev in err.feed(&b) {
                    s.event(&ctl, ev, &mut stdin).await;
                }
            }
            _ => open = false,
        }
    }
    for ev in out.finish().into_iter().chain(err.finish()) {
        s.event(&ctl, ev, &mut stdin).await;
    }
    let code = status.ok().and_then(|s| s.code());
    if code != Some(0) {
        let reason = failure_reason(&s.said).unwrap_or_else(|| format!("gh exited with code {}", code.map_or_else(|| "?".to_string(), |c| c.to_string())));
        ctl.finish(AuthFlowState::Failed, Some(reason));
        tracing::info!(host = %run.host, code, secs = started.elapsed().as_secs(), "gh sign-in failed");
        return;
    }
    ctl.update(|f| {
        f.user_code = None;
        f.url = None;
        f.callback_port = None;
        f.paste = AuthPaste::None;
        f.message = Some(if run.setup_git { "Setting up git to use it…".into() } else { "Checking the sign-in…".into() });
    });
    // A cancel that came after gh stored the sign-in leaves git alone.
    let git = if run.setup_git && !ctl.is_final() { Some(setup_git(&run).await) } else { None };
    // Before `done`: the app reads the checklist again right then.
    refresh_now(&run.bin, &extra).await;
    let message = done_message(&run.host, s.login.as_deref(), s.plain_text, git);
    let login = s.login.clone();
    ctl.update(|f| f.account = login);
    ctl.finish(AuthFlowState::Done, Some(message));
    tracing::info!(host = %run.host, secs = started.elapsed().as_secs(), "gh sign-in done");
    if let Some(ctx) = run.ctx.as_ref().and_then(Weak::upgrade) {
        crate::ops::host::publish(&ctx).await;
    }
}

// ───────────────────────────── git identity ─────────────────────────────

/// `user.name` / `user.email` from `git config -z --get-regexp` (`key\nvalue\0`…); the last value
/// of a key wins, as in git; empty values count as unset.
fn parse_identity(z: &[u8]) -> (Option<String>, Option<String>) {
    let (mut name, mut email) = (None, None);
    for rec in z.split(|b| *b == 0) {
        let rec = String::from_utf8_lossy(rec);
        let Some((key, value)) = rec.split_once('\n') else { continue };
        let value = Some(value.trim().to_string()).filter(|v| !v.is_empty());
        match key.to_ascii_lowercase().as_str() {
            "user.name" => name = value,
            "user.email" => email = value,
            _ => {}
        }
    }
    (name, email)
}

async fn read_identity(git: &Path, extra: &[(&str, &str)]) -> Result<(Option<String>, Option<String>), ApiError> {
    let env = env_with(GIT_ENV, extra);
    let out = run_cmd(git, &["config", "--global", "-z", "--get-regexp", r"^user\.(name|email)$"], None, &env, None, LOCAL_TIMEOUT)
        .await
        .map_err(|e| ApiError::new("git_error", format!("couldn't run git: {e}")))?;
    match out.code {
        0 => Ok(parse_identity(&out.stdout)),
        // Not set (or no global config file yet).
        1 => Ok((None, None)),
        _ => Err(ApiError::new("git_error", out.message())),
    }
}

/// The file `git config --global` writes: `$GIT_CONFIG_GLOBAL`; else `~/.gitconfig`, unless only
/// `$XDG_CONFIG_HOME/git/config` (`~/.config/git/config`) exists.
fn global_file(var: impl Fn(&str) -> Option<OsString>) -> PathBuf {
    if let Some(p) = var("GIT_CONFIG_GLOBAL") {
        return PathBuf::from(p);
    }
    let home = var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_else(home_dir);
    let dot = home.join(".gitconfig");
    let xdg = var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config")).join("git").join("config");
    if !dot.exists() && xdg.exists() { xdg } else { dot }
}

/// `user.name` and `user.email` as `git.setIdentity` takes them: trimmed, set, one line, ≤ 200
/// characters, an email with an `@` and no spaces. Errors name the field (`name: …`).
fn check_identity(p: &GitIdentityParams) -> Result<(String, String), ApiError> {
    let field = |key: &str, v: &str| -> Result<String, ApiError> {
        let v = v.trim();
        let bad = |msg: &str| Err(ApiError::new("invalid_params", format!("{key}: {msg}")));
        if v.is_empty() {
            return bad("can't be empty");
        }
        if v.chars().any(char::is_control) {
            return bad("can't contain line breaks or control characters");
        }
        if v.chars().count() > MAX_IDENTITY {
            return bad(&format!("use at most {MAX_IDENTITY} characters"));
        }
        Ok(v.to_string())
    };
    let name = field("name", &p.name)?;
    let email = field("email", &p.email)?;
    if email.chars().any(char::is_whitespace) {
        return Err(ApiError::new("invalid_params", "email: can't contain spaces"));
    }
    if !email.contains('@') {
        return Err(ApiError::new("invalid_params", "email: needs an @ (like you@example.com)"));
    }
    Ok((name, email))
}

async fn write_identity(git: &Path, name: &str, email: &str, extra: &[(&str, &str)]) -> Result<(), ApiError> {
    let env = env_with(GIT_ENV, extra);
    for (key, value) in [("user.name", name), ("user.email", email)] {
        let out = run_cmd(git, &["config", "--global", "--replace-all", key, value], None, &env, None, LOCAL_TIMEOUT)
            .await
            .map_err(|e| ApiError::new("git_error", format!("couldn't run git: {e}")))?;
        if !out.ok() {
            return Err(ApiError::new("git_error", format!("git config --global {key} failed: {}", out.message())));
        }
    }
    Ok(())
}

/// What `gh api user` says about the signed-in account.
#[derive(Debug, Clone, PartialEq)]
struct GhUser {
    login: String,
    id: u64,
    name: Option<String>,
    email: Option<String>,
}

fn parse_user(json: &str) -> Option<GhUser> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    Some(GhUser { login: s("login")?, id: v.get("id")?.as_u64()?, name: s("name"), email: s("email") })
}

/// The account's name (else its login) and public email (else its no-reply address).
fn suggestion(host: &str, user: &GhUser) -> (String, String) {
    let name = user.name.clone().unwrap_or_else(|| user.login.clone());
    let email = user.email.clone().unwrap_or_else(|| format!("{}+{}@users.noreply.{host}", user.id, user.login));
    (name, email)
}

async fn gh_user(bin: &Path, host: &str, login: &str) -> Option<GhUser> {
    let key = format!("{host} {login}");
    if let Some((at, user)) = cache().users.get(&key)
        && at.elapsed() < USER_TTL
    {
        return Some(user.clone());
    }
    let user = match tools::run(bin, &["api", "--hostname", host, "user"], USER_TIMEOUT, GH_ENV, &[]).await {
        Ok(out) if out.code == 0 => parse_user(&out.stdout)?,
        // Asked again next time: GitHub may only have been out of reach.
        _ => return None,
    };
    cache().users.insert(key, (Instant::now(), user.clone()));
    Some(user)
}

/// From the signed-in GitHub account, when there is one.
async fn suggestions() -> (Option<String>, Option<String>) {
    let Some(bin) = resolve_bin("gh") else { return (None, None) };
    let Some(probe) = probe(&bin, Some(SUGGEST_WAIT), None).await else { return (None, None) };
    let Some(account) = probe.suggest_from() else { return (None, None) };
    match gh_user(&bin, &account.host, &account.login).await {
        Some(user) => {
            let (name, email) = suggestion(&account.host, &user);
            (Some(name), Some(email))
        }
        None => (None, None),
    }
}

async fn identity_of(git: &Path, extra: &[(&str, &str)], suggest: bool) -> Result<GitIdentity, ApiError> {
    let (name, email) = read_identity(git, extra).await?;
    let (suggested_name, suggested_email) = if suggest { suggestions().await } else { (None, None) };
    Ok(GitIdentity { name, email, file: Some(global_file(|k| var(extra, k)).display().to_string()), suggested_name, suggested_email })
}

/// `git.identity`.
pub(crate) async fn identity() -> Result<GitIdentity, ApiError> {
    match resolve_bin("git") {
        Some(git) => identity_of(&git, &[], true).await,
        None => Ok(GitIdentity { name: None, email: None, file: None, suggested_name: None, suggested_email: None }),
    }
}

/// `git.setIdentity`: writes both, answers the identity as git reads it now and republishes the
/// checklist.
pub(crate) async fn set_identity(ctx: &Ctx, p: GitIdentityParams) -> Result<GitIdentity, ApiError> {
    let (name, email) = check_identity(&p)?;
    let git = resolve_bin("git").ok_or_else(no_git)?;
    write_identity(&git, &name, &email, &[]).await?;
    tracing::info!("git identity set");
    let job = ctx.arc();
    tokio::spawn(async move {
        crate::ops::host::publish(&job).await;
    });
    identity_of(&git, &[], true).await
}

// ───────────────────────────── Host setup ─────────────────────────────

/// gh's and git's part of the setup checklist.
pub(crate) struct SetupPart {
    pub issues: Vec<SetupIssue>,
    pub gh_signed_in: Option<bool>,
    pub git_identity: Option<bool>,
}

/// gh's token comes from tf-hostd's environment: signing in can't change what gh uses.
fn env_token() -> bool {
    ["GH_TOKEN", "GITHUB_TOKEN"].iter().any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

fn sign_in_issue(entries: &[Entry]) -> SetupIssue {
    let state = match entries.iter().find(|e| e.standing == Standing::Failed) {
        Some(e) => {
            let who = if e.account.login.is_empty() { String::new() } else { format!(" as {}", e.account.login) };
            format!("Its sign-in{who} on {} no longer works ({}).", e.account.host, e.account.error.as_deref().unwrap_or("its token doesn't work"))
        }
        None => "It is not signed in on this host.".into(),
    };
    SetupIssue {
        id: ISSUE_SIGN_IN.into(),
        severity: Severity::Info,
        title: "Sign in to GitHub".into(),
        detail: format!(
            "Pull request status, checks and merges on the board come from the GitHub CLI. {state} Sign in from Host setup in the app with a one-time code (or run `gh auth login` on the host)."
        ),
        fixable: false,
        recommended: true,
    }
}

fn identity_issue(name: bool, email: bool) -> SetupIssue {
    let missing = match (name, email) {
        (false, false) => "user.name and user.email are not set",
        (false, true) => "user.name is not set",
        _ => "user.email is not set",
    };
    SetupIssue {
        id: ISSUE_GIT_IDENTITY.into(),
        severity: Severity::Warn,
        title: "Set your git name and email".into(),
        detail: format!(
            "Commits made on this host need git's user.name and user.email ({missing}). Set them from Host setup in the app (or run `git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com` on the host)."
        ),
        fixable: false,
        recommended: true,
    }
}

/// The checklist part from what was found: `gh` = gh's accounts (`None`: gh is not installed;
/// `Some(Err)`: gh couldn't tell), `git` = `(name set, email set)` (`None`: git is not installed or
/// can't read its config). The sign-in comes first: the identity can then come from GitHub.
fn setup_from(gh: Option<Result<&[Entry], ()>>, git: Option<(bool, bool)>, env_token: bool) -> SetupPart {
    let mut issues = Vec::new();
    let gh_signed_in = match gh {
        Some(Ok(entries)) => {
            let signed_in = entries.iter().any(|e| e.standing != Standing::Failed);
            if !signed_in && !env_token {
                issues.push(sign_in_issue(entries));
            }
            Some(signed_in)
        }
        _ => None,
    };
    let git_identity = git.map(|(name, email)| {
        if !(name && email) {
            issues.push(identity_issue(name, email));
        }
        name && email
    });
    SetupPart { issues, gh_signed_in, git_identity }
}

/// Host setup's gh and git items (`ops::host::setup_status`).
pub(crate) async fn setup(ctx: &Ctx) -> SetupPart {
    let gh = async {
        let bin = resolve_bin("gh")?;
        Some(probe(&bin, Some(SETUP_WAIT), Some(ctx)).await)
    };
    let git = async {
        let git = resolve_bin("git")?;
        read_identity(&git, &[]).await.ok().map(|(n, e)| (n.is_some(), e.is_some()))
    };
    let (gh, git) = tokio::join!(gh, git);
    let entries = gh.as_ref().map(|p| p.as_ref().and_then(|p| p.entries.as_ref().ok()).map(Vec::as_slice).ok_or(()));
    setup_from(entries, git, env_token())
}

#[cfg(test)]
mod tests;
