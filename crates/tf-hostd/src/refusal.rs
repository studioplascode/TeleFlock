//! Refusal fallback (architecture §3.22 "Refusal fallback"): when a provider refuses a turn of an
//! agent or one of its subagents, tf-hostd switches that session to another model and goes on with
//! the turn by itself, whether or not an app is connected. "If Opus refuses on a cyber topic, use
//! Sonnet": Sonnet's safety classifier is the newer and more accurate one.
//!
//! * [`Refusals`] holds the host's rules (`host.refusalFallback`, `host.refusalFallbackSet`) in
//!   `<home>/refusalfallback.json` (owner-only, atomic writes; a file that cannot be read fails
//!   closed like `autoresume.json`: no rules, a notice, the bytes kept as `.bad-<ms>`), decides which
//!   rule a refusal gets ([`Refusals::pick`]: category, refused model, never the same model) and
//!   keeps the loop guard (one fallback per session, agent and turn).
//! * [`start`] (the daemon's part, as `limit_resume::start`): the refusal `turn_error`s of bridges
//!   with `caps.refusals` (≥ 2.3.0 in an omp that can go on, [`next_refusal`]) are the only
//!   trigger; other sessions' refusals are `crate::state`'s alone. omp reports a refusal only once
//!   it settled the turn (its own retry fallback chains walked, nothing running): the transcript's
//!   refusal signal also fires at the intermediate `agent_end`s of that walk and must not be acted
//!   on. The herdr session whose board shows the session posts the one Activity entry and one
//!   notification (`crate::state` leaves them to this module for such bridges); contexts that are
//!   not up come up for it ([`locate`]).
//! * A matching rule calls the bridge's `retryRefused`: the session switches model, the transcript
//!   gets the notice "<From> refused (<category>); switched to <To> and continued", and omp goes on
//!   with the turn without a new prompt (a subagent as a job of its parent; its registry status can
//!   still read `running` right after it settled, so a first `started: false` is tried again twice).
//!   `after: back` returns the main agent to the model it ran once the continued turn has ended
//!   ([`back_when_done`]).
//! * `agent.refusalRetry` ([`retry`]) is the one-off "Retry with <model>" of a refusal row.

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tf_collab::Signal;
use tf_proto::model::{ActivityKind, Agent, Column, Notification, NotifyKind};
use tf_proto::{ApiError, Millis, ModelCatalog, Refusal, RefusalAfter, RefusalFallback, RefusalRetryParams, RefusalRule, RetryResult, RetryVia, ThinkingLevel};

use crate::bridge::{BridgeEvent, BridgeHandle, ModelChoice, RefusedRetry, TurnError};
use crate::daemon::Daemon;
use crate::omp::OmpUpdate;
use crate::ops::Ctx;
use crate::paths::write_atomic;
use crate::state::{build, StateHandle};
use crate::util::{clip, new_id, now_ms};

pub const FILE: &str = "refusalfallback.json";
/// Rules a host keeps.
pub const MAX_RULES: usize = 32;
const CATEGORY_MAX: usize = 64;
const SELECTOR_MAX: usize = 200;
/// Turns remembered by the loop guard.
const TURNS_KEEP: usize = 512;
/// Looking for the board that shows a refused session (contexts that are not up come up first).
const LOCATE_EVERY: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(1) };
const LOCATE_TRIES: u32 = if cfg!(test) { 10 } else { 90 };
/// A subagent whose registry status still reads `running` answers `started: false`: tried again this
/// many times, this far apart.
const SUB_RETRIES: u32 = 2;
const SUB_WAIT: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_secs(2) };
/// The continued turn must have been over (and the agent idle, nothing scheduled) this long before
/// `after: back` switches the model back.
const SETTLE: Duration = if cfg!(test) { Duration::from_millis(150) } else { Duration::from_secs(2) };
const TICK: Duration = if cfg!(test) { Duration::from_millis(20) } else { Duration::from_millis(250) };
/// A pending switch back whose turn never ended is dropped after this long.
const BACK_MAX: Duration = Duration::from_secs(24 * 3600);
/// The model catalog's names for the notice: asked for this long at most.
const CATALOG_WAIT: Duration = Duration::from_secs(4);

static GLOBAL: OnceLock<Arc<Refusals>> = OnceLock::new();

/// The daemon's refusal fallback ([`start`] ran), `None` in unit tests of other modules.
pub fn get() -> Option<Arc<Refusals>> {
    GLOBAL.get().cloned()
}

// ───────────────────────────── rules ─────────────────────────────

/// What `<home>/refusalfallback.json` keeps.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Data {
    rules: Vec<RefusalRule>,
    /// Why there are no rules although some may have been saved ([`load`]); until they are saved again.
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
}

/// The turns a fallback ran for, so no turn falls back twice (A → B, B refuses, B → A, …).
#[derive(Default)]
struct Turns {
    seen: HashSet<(String, String, Millis)>,
    order: VecDeque<(String, String, Millis)>,
}

impl Turns {
    /// True the first time `agent` of root session `session` is seen on the turn that began at `at`.
    fn first(&mut self, session: &str, agent: &str, at: Millis) -> bool {
        let key = (session.to_owned(), agent.to_owned(), at);
        if !self.seen.insert(key.clone()) {
            return false;
        }
        self.order.push_back(key);
        while self.order.len() > TURNS_KEEP {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            }
        }
        true
    }
}

/// What a refusal gets.
#[derive(Debug, Clone, PartialEq)]
pub enum Pick {
    /// The first rule that applies: fall back as it says.
    Rule(RefusalRule),
    /// No rule applies: the refusal stands.
    NoRule,
    /// A rule applies, but this turn already fell back once: the fallback model refused as well.
    Repeat,
    /// A rule applies, but the bridge could not say which turn this is (`promptAt`): without it the
    /// loop guard cannot tell turns apart, so nothing runs by itself.
    Unknown,
}

/// The host's rules and the loop guard.
pub struct Refusals {
    file: PathBuf,
    data: Mutex<Data>,
    turns: Mutex<Turns>,
}

impl Refusals {
    /// Loads the rules of `file` (none without a file; a damaged file fails closed, see [`load`]).
    pub fn open(file: PathBuf) -> Self {
        let data = load(&file);
        Self { file, data: Mutex::new(data), turns: Mutex::new(Turns::default()) }
    }

    fn lock(&self) -> MutexGuard<'_, Data> {
        self.data.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `host.refusalFallback`.
    pub fn config(&self) -> RefusalFallback {
        let d = self.lock();
        RefusalFallback { rules: d.rules.clone(), notice: d.notice.clone() }
    }

    /// `host.refusalFallbackSet`: replaces the rules (and with them the notice of a damaged file).
    /// Nothing changes when the rules are invalid or cannot be saved.
    pub fn set(&self, rules: Vec<RefusalRule>) -> Result<RefusalFallback, ApiError> {
        let next = Data { rules: clean_all(rules)?, notice: None };
        let bytes = serde_json::to_vec(&next).map_err(|e| ApiError::new("internal", format!("encoding the refusal fallback rules: {e}")))?;
        let mut d = self.lock();
        write_atomic(&self.file, &bytes).map_err(|e| ApiError::new("io_error", format!("saving the refusal fallback rules: {e}")))?;
        *d = next;
        info!(rules = d.rules.len(), "refusal fallback rules changed");
        Ok(RefusalFallback { rules: d.rules.clone(), notice: None })
    }

    /// The rule the refusal `e` of root session `session` gets. The loop guard is used up by a rule
    /// that applies, once per session, agent and turn.
    pub fn pick(&self, session: &str, e: &TurnError) -> Pick {
        let Some(refusal) = &e.refusal else { return Pick::NoRule };
        let rule = self.lock().rules.iter().find(|r| applies(r, e, refusal)).cloned();
        let Some(rule) = rule else { return Pick::NoRule };
        let Some(at) = e.prompt_at else { return Pick::Unknown };
        let first = self.turns.lock().unwrap_or_else(|p| p.into_inner()).first(session, &e.agent_id, at);
        if first { Pick::Rule(rule) } else { Pick::Repeat }
    }
}

/// The rules in `bytes`, validated.
fn parse(bytes: &[u8]) -> Result<Data, String> {
    let data: Data = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let rules = clean_all(data.rules).map_err(|e| e.message)?;
    Ok(Data { rules, notice: data.notice })
}

/// The rules of a file. No file: none. A file that exists but cannot be read, parsed or validated is
/// copied to `refusalfallback.json.bad-<ms>` (when it can be) and the host **fails closed**: no rules
/// and a notice saying why, until the user saves rules again. The file held the user's decisions
/// (which model may take over from which); not knowing them, nothing may switch an agent's model
/// unattended. The closed state replaces the damaged file at once in one atomic step, as
/// `recovery::load` does for `autoresume.json`.
fn load(file: &Path) -> Data {
    let why = match std::fs::read(file) {
        Ok(bytes) => match parse(&bytes) {
            Ok(data) => return data,
            Err(e) => e,
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Data::default(),
        Err(e) => format!("read: {e}"),
    };
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    fail_closed(file, &why, &file.with_file_name(format!("{name}.bad-{}", now_ms())))
}

/// The closed state of a damaged `file`: its bytes copied to `copy` when possible (a failure is
/// logged and the file is replaced anyway), then replaced atomically.
fn fail_closed(file: &Path, why: &str, copy: &Path) -> Data {
    let kept = match std::fs::copy(file, copy) {
        Ok(_) => format!("The damaged file was kept as {}.", copy.display()),
        Err(e) => {
            tracing::error!(file = %file.display(), "the damaged refusal fallback rules could not be copied aside ({e})");
            "The damaged file could not be kept.".to_string()
        }
    };
    tracing::error!(file = %file.display(), "the refusal fallback rules are unreadable ({why}); no refusal falls back. {kept}");
    let data = Data {
        rules: Vec::new(),
        notice: Some(format!("The refusal fallback rules could not be read ({why}), so no refusal falls back to another model on this host until you save the rules again. {kept}")),
    };
    match serde_json::to_vec(&data).map_err(std::io::Error::other).and_then(|b| write_atomic(file, &b)) {
        Ok(()) => {}
        Err(e) => tracing::error!(file = %file.display(), "writing the fail-closed refusal fallback rules: {e}"),
    }
    data
}

fn level_of(s: &str) -> Option<ThinkingLevel> {
    serde_json::from_value(Value::String(s.to_owned())).ok()
}

/// `spec` without a trailing `:<thinking level>`, and that level. Only a real level counts: model
/// ids hold colons too (`llama3:8b`).
fn split_level(spec: &str) -> (&str, Option<ThinkingLevel>) {
    match spec.rsplit_once(':') {
        Some((head, tail)) if !head.is_empty() => match level_of(tail) {
            Some(level) => (head, Some(level)),
            None => (spec, None),
        },
        _ => (spec, None),
    }
}

/// The rules as the host keeps them (`host.refusalFallbackSet`; the app sends them in this form
/// already): the category trimmed and lowercased (empty or `any`: every refusal), `from` and `to`
/// trimmed without a thinking suffix (one on `to` becomes `thinking` where that is unset), `from`
/// empty or `*` for any model. Invalid rules are refused with `rule <n>: …`, the list with more than
/// [`MAX_RULES`] rules too.
fn clean_all(rules: Vec<RefusalRule>) -> Result<Vec<RefusalRule>, ApiError> {
    if rules.len() > MAX_RULES {
        return Err(ApiError::new("invalid_params", format!("at most {MAX_RULES} rules")));
    }
    rules.into_iter().enumerate().map(|(i, r)| clean(i + 1, r)).collect()
}

fn clean(n: usize, r: RefusalRule) -> Result<RefusalRule, ApiError> {
    let bad = |what: &str| ApiError::new("invalid_params", format!("rule {n}: {what}"));
    let category = match r.category.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(c) if c.eq_ignore_ascii_case("any") => None,
        Some(c) if c.chars().count() > CATEGORY_MAX || c.chars().any(|ch| ch.is_whitespace() || ch.is_control()) => {
            return Err(bad(&format!("the category is one word of at most {CATEGORY_MAX} characters")));
        }
        Some(c) => Some(c.to_lowercase()),
    };
    let from = match r.from.as_deref().map(str::trim) {
        None | Some("") | Some("*") => None,
        Some(f) => {
            let (f, _) = split_level(f);
            if !selector_ok(f, true) {
                return Err(bad(r#""from" is a model as provider/id, an id, provider/* or a prefix ending in *"#));
            }
            Some(f.to_owned())
        }
    };
    let (to, level) = split_level(r.to.trim());
    if !selector_ok(to, false) || !to.contains('/') {
        return Err(bad(r#""to" is a model as provider/id"#));
    }
    if from.as_deref().is_some_and(|f| f.eq_ignore_ascii_case(to)) {
        return Err(bad("a model cannot fall back to itself"));
    }
    Ok(RefusalRule { category, from, to: to.to_owned(), thinking: r.thinking.or(level), after: r.after })
}

/// A model selector: no spaces, at most [`SELECTOR_MAX`] characters, `provider/id` or an id, with a
/// `*` at the very end where `wild` allows one (`provider/*`, `claude-opus-*`), never in the provider.
fn selector_ok(s: &str, wild: bool) -> bool {
    if s.is_empty() || s.chars().count() > SELECTOR_MAX || s.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let (provider, id) = s.split_once('/').map_or((None, s), |(p, i)| (Some(p), i));
    if provider.is_some_and(|p| p.is_empty() || p.contains('*')) || id.is_empty() {
        return false;
    }
    match id.find('*') {
        None => true,
        Some(at) => wild && at + 1 == id.len(),
    }
}

// ───────────────────────────── matching ─────────────────────────────

/// A rule's category against the refusal: absent (or `any`) covers every refusal, safety-filter
/// flags (`sensitive`) included; a name covers refusals that carry it, in any case.
fn category_matches(rule: Option<&str>, refusal: &Refusal) -> bool {
    match rule.map(str::trim) {
        None | Some("") => true,
        Some(c) if c.eq_ignore_ascii_case("any") => true,
        Some(c) => refusal.category.as_deref().is_some_and(|have| have.trim().eq_ignore_ascii_case(c)),
    }
}

/// A rule's `from` against the refused model (`provider`, `model` as omp's failed message names
/// them), in any case: `provider/id` exactly, a bare id on any provider, `provider/*` any model of
/// the provider, a trailing `*` a family (`claude-opus-*`, `anthropic/claude-opus-*`), `*` anything.
/// A `:thinking` suffix is ignored when it is a real level.
fn selector_matches(selector: &str, provider: Option<&str>, model: Option<&str>) -> bool {
    let (sel, _) = split_level(selector.trim());
    if sel == "*" {
        return true;
    }
    let (want, pattern) = sel.split_once('/').map_or((None, sel), |(p, id)| (Some(p), id));
    if want.is_some_and(|p| !provider.is_some_and(|have| have.eq_ignore_ascii_case(p))) {
        return false;
    }
    if pattern == "*" {
        return true;
    }
    let Some(model) = model else { return false };
    match pattern.strip_suffix('*') {
        Some(prefix) => model.get(..prefix.len()).is_some_and(|head| head.eq_ignore_ascii_case(prefix)),
        None => model.eq_ignore_ascii_case(pattern),
    }
}

/// `to` is the model that refused: switching to it would change nothing.
fn same_model(to: &str, provider: Option<&str>, model: Option<&str>) -> bool {
    let (to, _) = split_level(to.trim());
    let (to_provider, to_id) = to.split_once('/').unwrap_or(("", to));
    model.is_some_and(|m| m.eq_ignore_ascii_case(to_id)) && provider.is_none_or(|p| p.eq_ignore_ascii_case(to_provider))
}

/// The rule covers the refusal: its category, its `from`, and a model other than the refused one to
/// go on with (a rule that would switch to the refusing model is skipped; the next one may apply).
fn applies(rule: &RefusalRule, e: &TurnError, refusal: &Refusal) -> bool {
    let (provider, model) = (e.provider.as_deref(), e.model.as_deref());
    category_matches(rule.category.as_deref(), refusal)
        && rule.from.as_deref().is_none_or(|f| selector_matches(f, provider, model))
        && !same_model(&rule.to, provider, model)
}

// ───────────────────────────── words ─────────────────────────────

/// A model as the notice names it: omp's name without the vendor word ("Claude Opus 5.5" → "Opus 5.5").
fn short_name(name: &str) -> String {
    let name = name.trim();
    let short = match name.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("claude ") => name[7..].trim_start(),
        _ => name,
    };
    if short.is_empty() { name.to_owned() } else { short.to_owned() }
}

/// The id of `provider/id[:level]`.
fn id_of(spec: &str) -> &str {
    let (spec, _) = split_level(spec.trim());
    spec.split_once('/').map_or(spec, |(_, id)| id)
}

/// omp's name of model `spec` (`provider/id`) in the catalog.
fn label_in(catalog: Option<&ModelCatalog>, spec: &str) -> Option<String> {
    let (spec, _) = split_level(spec.trim());
    let (provider, id) = spec.split_once('/')?;
    let found = catalog?.models.iter().find(|m| m.provider.eq_ignore_ascii_case(provider) && m.id.eq_ignore_ascii_case(id))?;
    found.label.as_deref().map(short_name).filter(|n| !n.is_empty())
}

/// How the transcript, Activity and notifications name the two models.
#[derive(Debug, Clone, PartialEq)]
struct Names {
    from: String,
    to: String,
}

impl Names {
    fn of(e: &TurnError, rule: &RefusalRule, catalog: Option<&ModelCatalog>) -> Names {
        let from = e
            .model_name
            .as_deref()
            .map(short_name)
            .filter(|n| !n.is_empty())
            .or_else(|| match (&e.provider, &e.model) {
                (Some(p), Some(m)) => label_in(catalog, &format!("{p}/{m}")),
                _ => None,
            })
            .or_else(|| e.model.clone())
            .unwrap_or_else(|| "The model".to_owned());
        let to = label_in(catalog, &rule.to).unwrap_or_else(|| id_of(&rule.to).to_owned());
        Names { from, to }
    }
}

/// "Opus 5.5 refused (cyber)", "Opus 5.5 was flagged by safety filters"; a subagent's behind its name.
fn what_happened(names: &Names, refusal: &Refusal, e: &TurnError) -> String {
    let what = if refusal.kind == "sensitive" { "was flagged by safety filters" } else { "refused" };
    let category = refusal.category.as_deref().map(str::trim).filter(|c| !c.is_empty()).map(|c| format!(" ({c})")).unwrap_or_default();
    let lead = if e.main { String::new() } else { format!("Subagent {}: ", e.agent_id) };
    format!("{lead}{} {what}{category}", names.from)
}

/// The transcript's notice: "Opus 5.5 refused (cyber); switched to Sonnet 5.5 and continued".
fn notice_text(names: &Names, refusal: &Refusal, e: &TurnError) -> String {
    format!("{}; switched to {} and continued", what_happened(names, refusal, e), names.to)
}

/// What Activity and the notification say besides the notice: the provider's explanation, and what
/// happens to the model afterwards.
fn follow_up(names: &Names, refusal: &Refusal, e: &TurnError, rule: &RefusalRule) -> String {
    let explanation = refusal.explanation.as_deref().map(str::trim).filter(|x| !x.is_empty()).map(|x| format!("{}.", x.trim_end_matches('.')));
    let after = match (rule.after, e.main) {
        (_, false) => format!("The subagent finishes its run on {}.", names.to),
        (RefusalAfter::Back, true) => format!("Goes back to {} when the turn ends.", names.from),
        (RefusalAfter::Stay, true) => format!("Stays on {}.", names.to),
    };
    [explanation, Some(after)].into_iter().flatten().collect::<Vec<_>>().join(" ")
}

// ───────────────────────────── the daemon's part ─────────────────────────────

/// The daemon's part (`daemon::async_main`): loads the rules and reacts to the bridges' refusal
/// `turn_error`s ([`next_refusal`]), with no app connected.
pub fn start(daemon: &Arc<Daemon>) {
    let refusals = Arc::new(Refusals::open(daemon.paths.home.join(FILE)));
    if GLOBAL.set(refusals).is_err() {
        return;
    }
    let weak = Arc::downgrade(daemon);
    let bridge = daemon.bridge.clone();
    let mut events = daemon.bridge.subscribe();
    let shutdown = daemon.shutdown.clone();
    tokio::spawn(async move {
        loop {
            let next = tokio::select! {
                _ = shutdown.cancelled() => return,
                next = next_refusal(&bridge, &mut events) => next,
            };
            let (Some((session_id, error)), Some(d)) = (next, weak.upgrade()) else { return };
            tokio::spawn(on_refusal(d, session_id, error));
        }
    });
}

/// The next refusal this module acts on, as root session id and error: a `turn_error` that carries
/// `refusal`, from a bridge that can go on after it ([`can_go_on`]). The 2.3.0 bridge fills `refusal`
/// in every omp but says `refusals` only where omp can go on with a refused turn; for any other
/// session `crate::state` posts the refusal from the transcript's signal, as for older bridges, and
/// nothing falls back. `None` once the bridge's events end.
async fn next_refusal(bridge: &BridgeHandle, events: &mut broadcast::Receiver<BridgeEvent>) -> Option<(String, TurnError)> {
    loop {
        match events.recv().await {
            Ok(BridgeEvent::TurnError { session_id, error }) if error.refusal.is_some() && can_go_on(bridge, &session_id) => return Some((session_id, error)),
            Err(broadcast::error::RecvError::Closed) => return None,
            _ => {}
        }
    }
}

/// The bridge of `session` can go on after a refusal: bridge ≥ 2.3.0 in an omp that supports it
/// (`caps.refusals`, as `state::on_signals` checks it).
fn can_go_on(bridge: &BridgeHandle, session: &str) -> bool {
    bridge.by_session(session).is_some_and(|b| b.caps.refusals)
}

/// The card of omp session `session` on `state`'s board (a live agent).
fn card_of(state: &StateHandle, session: &str) -> Option<Agent> {
    state.agent_of_session(session).and_then(|id| state.agent(&id))
}

/// The board of one of this daemon's herdr sessions shows `session`: its context and card. Contexts
/// that are not up yet (a restarted daemon, nobody connected) come up first, for the sessions this
/// host knows whose herdr server runs; the board then maps the session within moments.
async fn locate(d: &Arc<Daemon>, session: &str) -> Option<(Arc<Ctx>, Agent)> {
    let mut opened = false;
    for _ in 0..LOCATE_TRIES {
        for ctx in d.all_ctxs().await {
            if let Some(agent) = card_of(&ctx.state, session) {
                return Some((ctx, agent));
            }
        }
        if !d.bridge.is_connected(session) {
            return None;
        }
        if !std::mem::replace(&mut opened, true) {
            open_known(d).await;
            continue;
        }
        tokio::time::sleep(LOCATE_EVERY).await;
    }
    None
}

/// Opens the context of every herdr session this host knows that has none yet and whose server runs
/// (it never starts a server for this).
async fn open_known(d: &Arc<Daemon>) {
    let up: HashSet<String> = d.all_ctxs().await.into_iter().map(|c| c.herdr_session.clone()).collect();
    let known: Vec<String> = d.persist.read(|p| p.sessions.keys().cloned().collect());
    for name in known.into_iter().filter(|n| !up.contains(n)) {
        let running = match tf_herdr::HerdrClient::discover((name != "default").then_some(name.as_str())).await {
            Ok(h) => h.ping().await.is_ok(),
            Err(_) => false,
        };
        if !running {
            continue;
        }
        if let Err(e) = d.ctx_for(&name).await {
            warn!(session = %name, "refusal fallback: cannot open the herdr session: {}", e.message);
        }
    }
}

/// omp's model catalog, for the names in the notice (`host.models` caches it; asked for [`CATALOG_WAIT`] at most).
async fn catalog() -> Option<ModelCatalog> {
    tokio::time::timeout(CATALOG_WAIT, crate::ops::host::models()).await.ok()?.ok()
}

/// What the board says about an agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Board {
    /// It runs a turn (herdr `working`).
    working: bool,
    /// It is idle: not running, not waiting for the user, for a retry omp scheduled, or for
    /// background jobs.
    settled: bool,
}

fn board_of(agent: &Agent, jobs_waiting: bool) -> Board {
    let retry = agent.omp.as_ref().is_some_and(|o| o.retry.is_some());
    Board { working: agent.column == Column::Running, settled: matches!(agent.column, Column::Review | Column::Done) && !retry && !jobs_waiting }
}

/// The agent of `session` waits for its background jobs (omp wakes it with their results).
fn jobs_waiting(bridge: &BridgeHandle, session: &str) -> bool {
    bridge.by_session(session).and_then(|b| b.jobs).is_some_and(|j| j.waiting)
}

/// What a fallback works with: the bridge, the herdr session's board that shows the agent, and what
/// that board says about the agent now (`None`: it is gone).
#[derive(Clone)]
struct Env {
    bridge: BridgeHandle,
    state: StateHandle,
    cancel: CancellationToken,
    board: Arc<dyn Fn() -> Option<Board> + Send + Sync>,
}

impl Env {
    fn of(ctx: &Ctx, session: &str) -> Env {
        let (state, bridge, sid) = (ctx.state.clone(), ctx.bridge.clone(), session.to_owned());
        let board = {
            let (state, bridge, sid) = (state.clone(), bridge.clone(), sid);
            Arc::new(move || card_of(&state, &sid).map(|a| board_of(&a, jobs_waiting(&bridge, &sid))))
        };
        Env { bridge, state, cancel: ctx.cancel.clone(), board }
    }
}

/// A refusal omp settled on (`turn_error` of a bridge with `refusals`) of root session `session`.
async fn on_refusal(d: Arc<Daemon>, session: String, e: TurnError) {
    let Some(refusals) = get() else { return };
    let Some((ctx, agent)) = locate(&d, &session).await else {
        info!(session = %session, agent = %e.agent_id, "refusal: no herdr session shows it; nothing to do");
        return;
    };
    // Subscribed before anything goes on: the continued turn's first signal must not be missed.
    let updates = d.omp.subscribe();
    react(&refusals, &Env::of(&ctx, &session), updates, &session, &agent, &e, async || catalog().await).await;
}

/// Falls back as the first rule that applies says, else posts the refusal as it always was. Posts
/// exactly one Activity entry and one notification. `catalog` is asked for only once a rule applies.
async fn react(
    refusals: &Refusals,
    env: &Env,
    updates: broadcast::Receiver<OmpUpdate>,
    session: &str,
    agent: &Agent,
    e: &TurnError,
    catalog: impl AsyncFnOnce() -> Option<ModelCatalog>,
) {
    let Some(refusal) = e.refusal.clone() else { return };
    let rule = match refusals.pick(session, e) {
        Pick::Rule(rule) => rule,
        Pick::NoRule => return post_refusal(&env.state, agent, e, &refusal, None),
        Pick::Repeat => {
            info!(session, agent = %e.agent_id, "refusal: this turn already fell back once");
            return post_refusal(&env.state, agent, e, &refusal, Some("The fallback model refused too: no further fallback for this turn."));
        }
        Pick::Unknown => {
            warn!(session, agent = %e.agent_id, "refusal: the bridge did not say which turn it was; not falling back");
            return post_refusal(&env.state, agent, e, &refusal, Some("No fallback: the turn could not be identified."));
        }
    };
    let names = Names::of(e, &rule, catalog().await.as_ref());
    let notice = notice_text(&names, &refusal, e);
    let events = env.bridge.subscribe();
    match go_on(&env.bridge, session, e, &rule, &notice).await {
        Ok(done) if done.started => {
            info!(session, agent = %e.agent_id, to = %rule.to, after = ?rule.after, "refusal: fell back and went on");
            post_fallback(&env.state, agent, e, &refusal, &rule, &names, &notice);
            if let Some(back) = plan_back(&rule, e, session, &done) {
                tokio::spawn(back_when_done(env.clone(), updates, events, back));
            }
        }
        Ok(done) => {
            // The turn is not (or no longer) one to go on with. A switch that happened without a turn
            // following leaves nothing for `back` to wait for: back at once.
            warn!(session, agent = %e.agent_id, switched = done.previous.is_some(), "refusal: the bridge did not go on with the turn");
            let note = match (&done.previous, rule.after) {
                (Some(previous), RefusalAfter::Back) => {
                    if let Some(back) = plan_back(&rule, e, session, &done) {
                        go_back(&env.bridge, &back).await;
                    }
                    let was = previous.name.as_deref().map(short_name).unwrap_or_else(|| names.from.clone());
                    format!("Switched to {}, but the turn did not continue; back on {was}.", names.to)
                }
                (Some(_), RefusalAfter::Stay) => format!("Switched to {}, but the turn did not continue.", names.to),
                (None, _) => format!("No fallback to {}: the agent had already gone on.", names.to),
            };
            post_refusal(&env.state, agent, e, &refusal, Some(&note));
        }
        Err(err) => {
            warn!(session, agent = %e.agent_id, "refusal: falling back to {} failed: {err}", rule.to);
            post_refusal(&env.state, agent, e, &refusal, Some(&format!("Falling back to {} failed: {}", names.to, err.message)));
        }
    }
}

/// The bridge's `retryRefused` for the refusal `e` of root session `session`. A subagent whose
/// registry status still reads `running` answers `started: false` right after it settled: asked
/// again up to [`SUB_RETRIES`] times. A switch that happened (`previous`) is never repeated.
async fn go_on(bridge: &BridgeHandle, session: &str, e: &TurnError, rule: &RefusalRule, notice: &str) -> Result<RefusedRetry, ApiError> {
    let sub = (!e.main).then_some(e.agent_id.as_str());
    let tries = if sub.is_some() { 1 + SUB_RETRIES } else { 1 };
    let mut done = RefusedRetry::default();
    for n in 0..tries {
        if n > 0 {
            tokio::time::sleep(SUB_WAIT).await;
        }
        done = bridge.retry_refused(session, sub, &rule.to, rule.thinking, Some(notice)).await.map_err(ApiError::from)?;
        if done.started || done.previous.is_some() {
            break;
        }
    }
    Ok(done)
}

// ───────────────────────────── Activity and notifications ─────────────────────────────

/// The fallback happened: one Activity entry (the notice, kind `modelChanged`) and one `info`
/// notification. The board's own "Model → …" entry for the switch follows, as for any model change.
fn post_fallback(state: &StateHandle, agent: &Agent, e: &TurnError, refusal: &Refusal, rule: &RefusalRule, names: &Names, notice: &str) {
    let detail = follow_up(names, refusal, e, rule);
    state.record_activity(&agent.id, ActivityKind::ModelChanged, notice.to_owned(), Some(detail.clone()));
    state.broadcast_notification(Notification {
        id: new_id("n"),
        at: now_ms(),
        kind: NotifyKind::Info,
        agent_id: agent.id.clone(),
        title: format!("{} · continued on {}", agent.name, names.to),
        body: clip(&format!("{}. {detail}", what_happened(names, refusal, e)), 240),
        request_id: None,
        actions: vec![],
    });
}

/// The refusal stands (no rule, a repeat, a fallback that did not happen): the Activity entry and
/// notification a refusal always had, `note` saying what the fallback did not do.
fn post_refusal(state: &StateHandle, agent: &Agent, e: &TurnError, refusal: &Refusal, note: Option<&str>) {
    let who = if e.main { String::new() } else { format!("Subagent {}: ", e.agent_id) };
    let mut detail = format!("{who}{}", refusal.explanation.clone().unwrap_or_else(|| e.message.clone()));
    if let Some(note) = note {
        detail = format!("{detail} {note}");
    }
    state.record_activity(&agent.id, ActivityKind::Error, build::refusal_title(refusal), Some(detail));
    let mut n = build::refusal_notification(&agent.id, &agent.name, refusal, &e.message, now_ms());
    if note.is_some() || !e.main {
        n.body = clip(&format!("{who}{} {}", n.body, note.unwrap_or_default()), 240);
    }
    state.broadcast_notification(n);
}

// ───────────────────────────── after: back ─────────────────────────────

/// The model a pending `after: back` returns to once the continued turn has ended.
#[derive(Debug, Clone, PartialEq)]
struct Back {
    /// The root omp session.
    session: String,
    /// The model the session switched to (`provider/id`): going back only while it still runs it.
    fallback: String,
    previous: ModelChoice,
}

/// A rule with `after: back` on the main agent, whose switch the bridge reported (`previous`).
fn plan_back(rule: &RefusalRule, e: &TurnError, session: &str, done: &RefusedRetry) -> Option<Back> {
    if rule.after != RefusalAfter::Back || !e.main {
        return None;
    }
    let previous = done.previous.clone().filter(|p| !p.model.is_empty())?;
    let fallback = done.model.clone().unwrap_or_else(|| split_level(&rule.to).0.to_owned());
    Some(Back { session: session.to_owned(), fallback, previous })
}

/// Waits until the turn the fallback continued has ended, then returns the session to its model.
/// Turn boundaries come from the replica's signals (`updates`, subscribed before the fallback went
/// on) and the board: the turn began with `TurnStarted` (or the board showing the agent at work), it
/// ended with `TurnEnded` (omp's own retry of it, `Retry`, or a new `TurnStarted` takes that back),
/// and the agent is over it once the board has shown it settled ([`Board::settled`]) for [`SETTLE`]
/// without a break. herdr's own state trails the replica's by a moment, so a board that still reads
/// `working` after `TurnEnded` only delays that. The user's own model change wins: nothing happens
/// when the session no longer runs the fallback model. Dropped when the session goes away, the agent
/// leaves the board, or after [`BACK_MAX`]; a daemon restart drops it too.
async fn back_when_done(env: Env, mut updates: broadcast::Receiver<OmpUpdate>, mut events: broadcast::Receiver<BridgeEvent>, back: Back) {
    let deadline = tokio::time::Instant::now() + BACK_MAX;
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The continued turn began; it ended (and omp scheduled no retry of it); since when the board shows the agent settled.
    let (mut started, mut ended) = (false, false);
    let mut idle_since: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            _ = env.cancel.cancelled() => return,
            _ = tokio::time::sleep_until(deadline) => {
                info!(session = %back.session, "refusal fallback: the continued turn never ended; staying on {}", back.fallback);
                return;
            }
            ev = events.recv() => match ev {
                Ok(BridgeEvent::Disconnected { session_id, .. }) if session_id == back.session => return,
                Ok(BridgeEvent::SessionSwitch { previous_session_id, .. }) if previous_session_id == back.session => return,
                Err(broadcast::error::RecvError::Closed) => return,
                _ => {}
            },
            up = updates.recv() => match up {
                Ok(OmpUpdate::Signals { session_id, signals }) if session_id == back.session => {
                    for signal in signals {
                        match signal {
                            Signal::TurnStarted => (started, ended) = (true, false),
                            Signal::TurnEnded { .. } if started => ended = true,
                            Signal::Retry { .. } if started => ended = false,
                            _ => {}
                        }
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
                _ => {}
            },
            _ = tick.tick() => {
                // The agent is gone from the board: nothing to go back for.
                let Some(board) = (env.board)() else {
                    debug!(session = %back.session, "refusal fallback: the agent is gone from the board; not going back");
                    return;
                };
                started |= board.working;
                if started && ended && board.settled {
                    let since = *idle_since.get_or_insert_with(tokio::time::Instant::now);
                    if since.elapsed() >= SETTLE {
                        go_back(&env.bridge, &back).await;
                        return;
                    }
                } else {
                    idle_since = None;
                }
            }
        }
    }
}

/// Returns the session to `back.previous` (model and thinking level), unless the user changed the
/// model meanwhile.
async fn go_back(bridge: &BridgeHandle, back: &Back) {
    let now = bridge.by_session(&back.session).and_then(|b| b.state.model).map(|m| format!("{}/{}", m.provider, m.id));
    if !now.as_deref().is_some_and(|m| m.eq_ignore_ascii_case(&back.fallback)) {
        info!(session = %back.session, model = now.as_deref().unwrap_or("?"), "refusal fallback: the model was changed meanwhile; not going back");
        return;
    }
    match bridge.set_model(&back.session, &back.previous.model, back.previous.thinking).await {
        Ok(_) => info!(session = %back.session, model = %back.previous.model, "refusal fallback: back on the model the turn began with"),
        Err(e) => warn!(session = %back.session, "refusal fallback: going back to {} failed: {e}", back.previous.model),
    }
}

// ───────────────────────────── methods ─────────────────────────────

fn unavailable() -> ApiError {
    ApiError::new("unavailable", "refusal fallback is not running in this tf-hostd")
}

/// `host.refusalFallback`.
pub fn config() -> Result<RefusalFallback, ApiError> {
    Ok(get().ok_or_else(unavailable)?.config())
}

/// `host.refusalFallbackSet`.
pub fn set_config(rules: Vec<RefusalRule>) -> Result<RefusalFallback, ApiError> {
    get().ok_or_else(unavailable)?.set(rules)
}

/// The bridge session of `session` when it can go on after a refusal ([`can_go_on`]), else
/// `unsupported`.
fn refusal_session(bridge: &BridgeHandle, session: Option<String>) -> Result<String, ApiError> {
    session.filter(|s| can_go_on(bridge, s)).ok_or_else(|| {
        ApiError::new("unsupported", "going on after a refusal needs TeleFlock's bridge 2.3.0 in this omp")
            .with_hint("Restart the agent (Mark done, then Resume) so it loads the current bridge; omp must be 18.13 or newer")
    })
}

/// `agent.refusalRetry`: "Retry with <model>": the agent's (or a subagent's) last turn ended on a
/// refusal; its session switches to `model` and goes on with that turn, once (no rule is saved, no
/// switch back). `started: false`: nothing to go on with (not a refusal any more, or it runs).
pub async fn retry(ctx: &Ctx, p: RefusalRetryParams) -> Result<RetryResult, ApiError> {
    let a = ctx.state.agent(&p.agent_id).ok_or_else(|| ApiError::new("not_found", format!("no agent `{}`", p.agent_id)))?;
    if a.kind != "omp" {
        return Err(ApiError::new("unsupported", format!("`{}` is a {} agent; use the terminal", a.name, a.kind)));
    }
    if a.parked.is_some() {
        return Err(ApiError::new("parked", format!("{} is done and its pane is closed", a.name)).with_hint("Resume it first"));
    }
    crate::ops::agent::check_model(&p.model)?;
    let session = refusal_session(&ctx.bridge, crate::ops::agent::bridge_sid(ctx, &p.agent_id))?;
    crate::limit_resume::intervened(ctx, &p.agent_id, "retried after a refusal");
    let to = label_in(catalog().await.as_ref(), &p.model).unwrap_or_else(|| id_of(&p.model).to_owned());
    one_off(&ctx.bridge, &session, &p, &to).await
}

/// The bridge call of [`retry`]: `to` is the model's name for the transcript's notice.
async fn one_off(bridge: &BridgeHandle, session: &str, p: &RefusalRetryParams, to: &str) -> Result<RetryResult, ApiError> {
    let notice = format!("Switched to {to} and continued");
    let done = bridge.retry_refused(session, p.subagent_id.as_deref(), &p.model, p.thinking, Some(&notice)).await.map_err(ApiError::from)?;
    Ok(RetryResult { started: done.started, via: RetryVia::Retry })
}

#[cfg(test)]
mod tests;
