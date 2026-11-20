//! Which account serves which model (architecture §3.22 "Model access").
//!
//! An account can have usage left and still not serve a model: Anthropic answers a model the
//! account's organization has no access to (Claude Mythos on most plans) with HTTP 404
//! `not_found_error` "model: …" ([`tf_collab::refused_model`]). omp 19 classifies that answer as
//! an account-policy error: it blocks the account for that model (block scope `model-policy:<id>`
//! in its `auth_credential_blocks`) for one minute and tries the request again on another account.
//! Its ranking knows nothing of model access, so the account comes back first once the block
//! lapses, and a stop for usage leaves auto-resume counting room that cannot serve the model
//! (`docs/research/omp.md` §13). hostd keeps what omp's requests showed, per account and model, in
//! `state.json` (`modelAccess`): auto-resume leaves accounts refused the model out
//! (`crate::limit_resume`), and the accounts and usage pages say which models an account is refused
//! (`LimitAccount.models`, `LinkedAccount.models`).
//!
//! **Sources** (all read-only):
//! - every assistant message of the board's sessions, which names the credential that served it
//!   (`credentialId`, a row of omp's `auth_credentials`): the main session as the replica applies
//!   it (`Replica::take_credentials`, drained in `OmpSession::absorb`), subagents and advisors
//!   through the artifact scan (`ArtifactLedger::take_credentials`). An answer says the account
//!   serves the model; a request omp gave up on with the 404 says it does not;
//! - omp's own model blocks ([`omp_blocks`]): the refusals omp got over before writing any message,
//!   read while sessions work (`ops::limits`) and before auto-resume decides;
//! - the bridge's `turn_error` (`credentialId`, bridge 2.7.0; else the transcript's tail,
//!   [`refusing_credential`]), so a stop on a refusal is known before its ticket is decided.
//!
//! **Only this host's evidence.** A credential id means something only in the store of the host
//! whose omp wrote it: a session moved here from another host (or restored from a copy) carries
//! requests whose ids name other accounts here. hostd records when it first saw each session
//! (`modelAccessArrivals`) and learns by id only what happened since; an earlier request counts only
//! when omp recorded its account's fingerprint with it (the `credential_pin` entry that follows a
//! request on a newly pinned account: SHA-256 of provider and identity) and that fingerprint is a
//! credential of this host. omp's block store is this host's own.
//!
//! A credential maps to its account through its `auth_credentials` row (identity fields only,
//! `ops::accounts::read_credentials`), keyed as the accounts page keys it (`provider|<identity
//! key>`, `provider|#<id>` for API keys); omp's usage report names the same account by identity
//! ([`models_for`]). Credentials kept in an auth broker are not in that table and teach nothing.
//!
//! **Expiry.** The newer request wins: an answer clears a refusal at once (access was granted), a
//! refusal replaces an answer (access was withdrawn). A refusal counts for [`DENIED_FOR_MS`], since
//! access can be granted later (omp tries the account again by itself, which renews it while it
//! holds); an answer counts for [`SERVED_FOR_MS`]; records past [`FORGET_MS`] are dropped. A repeat
//! of what is known moves its time in [`RENEW_STEP_MS`] steps only, so a busy agent does not rewrite
//! `state.json` with every reply.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tf_collab::CredentialUse;
use tf_proto::{Millis, ModelAccess};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ops::accounts::{key_of, label_of, read_credentials, CredRow};
use crate::ops::host::{omp_agent_dir, open_ro};
use crate::ops::limits::{identity_matches, Ident};
use crate::state::persist::Persist;
use crate::util::now_ms;

const HOUR_MS: Millis = 3_600_000;
const DAY_MS: Millis = 24 * HOUR_MS;
/// How long a refusal counts; then nothing is known (the account may have been granted access).
pub const DENIED_FOR_MS: Millis = DAY_MS;
/// How long an answer counts.
pub const SERVED_FOR_MS: Millis = 7 * DAY_MS;
/// Records this old are dropped.
const FORGET_MS: Millis = 30 * DAY_MS;
/// A repeat of what is known moves its time only once it is this much newer.
const RENEW_STEP_MS: Millis = HOUR_MS;
/// omp's credential table is read again for a credential it lacked at most this often.
const RELOAD_MIN: Duration = Duration::from_secs(10);
/// What is noted is folded in this long after the first note.
const SETTLE_AFTER: Duration = Duration::from_secs(2);
/// omp's block scope for one model refused on one credential (pi-ai `auth/blocks.ts`).
const MODEL_SCOPE: &str = "model-policy:";

/// What the newest request on one account showed for one model (`state.json` `modelAccess`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    /// The provider refused the model on the account.
    pub denied: bool,
    pub at: Millis,
}

/// Account (`provider|<identity key>`, `provider|#<credential id>`) → model id → what its newest
/// request showed.
pub type Book = BTreeMap<String, BTreeMap<String, Seen>>;

/// Whether a record still counts at `now`.
pub fn holds(seen: &Seen, now: Millis) -> bool {
    now - seen.at < if seen.denied { DENIED_FOR_MS } else { SERVED_FOR_MS }
}

/// How an account stands with a model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// A request on it was answered (within [`SERVED_FOR_MS`]).
    Serves,
    /// The provider refused the model on it (within [`DENIED_FOR_MS`]).
    Denied,
    Unknown,
}

/// How the account whose knowledge is `models` (`LimitAccount.models`) stands with `model` at `now`.
pub fn access_of(models: &[ModelAccess], model: &str, now: Millis) -> Access {
    match models.iter().find(|m| m.model.eq_ignore_ascii_case(model)) {
        Some(m) if holds(&Seen { denied: m.denied, at: m.at }, now) => {
            if m.denied {
                Access::Denied
            } else {
                Access::Serves
            }
        }
        _ => Access::Unknown,
    }
}

/// Whether a request that showed `seen` tells more than `old`: the newer of the two counts, a
/// repeat of the same outcome only once it is [`RENEW_STEP_MS`] newer.
fn tells_more(old: Option<&Seen>, seen: &Seen) -> bool {
    match old {
        Some(old) if old.denied == seen.denied => seen.at >= old.at + RENEW_STEP_MS,
        Some(old) => seen.at > old.at,
        None => true,
    }
}

/// Records that a request on `account` showed `seen` for `model` ([`tells_more`]). True when the
/// book changed.
pub fn record(book: &mut Book, account: &str, model: &str, seen: Seen) -> bool {
    if !tells_more(book.get(account).and_then(|m| m.get(model)), &seen) {
        return false;
    }
    book.entry(account.to_owned()).or_default().insert(model.to_owned(), seen);
    true
}

/// What still counts at `now` of `models` (one account's records), the newest request first.
fn counted<'a>(models: impl IntoIterator<Item = (&'a String, &'a Seen)>, now: Millis) -> Vec<ModelAccess> {
    let mut out: Vec<ModelAccess> = models.into_iter().filter(|(_, s)| holds(s, now)).map(|(model, s)| ModelAccess { model: model.clone(), denied: s.denied, at: s.at }).collect();
    out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.model.cmp(&b.model)));
    out
}

/// What `book` knows of `account` at `now`, the newest request first.
pub fn current(book: &Book, account: &str, now: Millis) -> Vec<ModelAccess> {
    counted(book.get(account).into_iter().flatten(), now)
}

/// What `book` knows at `now` of the account omp's usage report names `provider` / `ident`: the
/// records of every stored credential whose identity key names it (the newest per model).
pub(crate) fn current_for(book: &Book, provider: &str, ident: &Ident, now: Millis) -> Vec<ModelAccess> {
    let prefix = format!("{provider}|");
    let mut models: BTreeMap<&String, &Seen> = BTreeMap::new();
    for (key, m) in book {
        let Some(ik) = key.strip_prefix(&prefix).filter(|ik| !ik.starts_with('#')) else { continue };
        if !identity_matches(ik, ident) {
            continue;
        }
        for (model, s) in m {
            if models.get(model).is_none_or(|old| old.at < s.at) {
                models.insert(model, s);
            }
        }
    }
    counted(models, now)
}

/// Drops records past [`FORGET_MS`], and accounts with none left. True when something went.
fn prune(book: &mut Book, now: Millis) -> bool {
    let before: usize = book.values().map(BTreeMap::len).sum();
    for models in book.values_mut() {
        models.retain(|_, s| now - s.at < FORGET_MS);
    }
    book.retain(|_, m| !m.is_empty());
    book.values().map(BTreeMap::len).sum::<usize>() != before
}

/// A stored credential as the book knows it (no secrets).
#[derive(Debug, Clone, PartialEq)]
struct Cred {
    provider: String,
    /// Its account in the book ([`key_of`], as the accounts page keys it).
    key: String,
    identity_key: Option<String>,
    oauth: bool,
    label: String,
    /// omp still uses it (`disabled_cause` unset).
    active: bool,
    /// The account's fingerprint as omp writes it in `credential_pin` entries ([`fingerprint`]).
    fingerprint: Option<String>,
}

/// omp's fingerprint of a signed-in account (`session/credential-pin.ts`): SHA-256 (hex) of the
/// provider, account id, email, organization and project, NUL-separated; none without an account id
/// or email.
fn fingerprint(row: &CredRow) -> Option<String> {
    use sha2::Digest as _;
    if !row.oauth || (row.account_id.is_none() && row.email.is_none()) {
        return None;
    }
    let f = |v: &Option<String>| v.clone().unwrap_or_default();
    let text = [row.provider.clone(), f(&row.account_id), f(&row.email), f(&row.org_id), f(&row.project_id)].join("\0");
    Some(sha2::Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect())
}

/// One noted request; `local`: its credential id is this host's (it happened here).
type Noted = (CredentialUse, bool);

/// What of `uses` (requests of a session this host first saw at `arrived`) can be learned: what
/// happened since by its credential id, earlier requests only by their account's fingerprint.
fn admissible(uses: Vec<CredentialUse>, arrived: Millis) -> Vec<Noted> {
    uses.into_iter().filter(|u| u.at >= arrived || u.account.is_some()).map(|u| {
        let local = u.at >= arrived;
        (u, local)
    }).collect()
}

/// The stored credential a noted request was on: by its account's fingerprint when omp recorded one
/// and this host has that account; else by its id, if the id is this host's.
fn resolve<'a>(creds: &'a HashMap<i64, Cred>, (u, local): &Noted) -> Option<&'a Cred> {
    let by_print = u.account.as_deref().and_then(|fp| creds.values().find(|c| c.provider == u.provider && c.fingerprint.as_deref() == Some(fp)));
    by_print.or_else(|| creds.get(&u.credential_id).filter(|c| *local && c.provider == u.provider))
}

#[derive(Default)]
struct Resolver {
    creds: HashMap<i64, Cred>,
    loaded: Option<Instant>,
}

impl Resolver {
    /// Reads omp's credential table again (identity fields only) unless it was read within
    /// [`RELOAD_MIN`].
    async fn reload(&mut self) {
        if self.loaded.is_some_and(|t| t.elapsed() < RELOAD_MIN) {
            return;
        }
        self.loaded = Some(Instant::now());
        let db = omp_agent_dir().join("agent.db");
        match tokio::task::spawn_blocking(move || read_credentials(&db)).await {
            Ok(Ok(rows)) => {
                self.creds = rows
                    .iter()
                    .map(|r| {
                        let cred = Cred {
                            provider: r.provider.clone(),
                            key: key_of(r),
                            identity_key: r.identity_key.clone(),
                            oauth: r.oauth,
                            label: label_of(r),
                            active: r.disabled.is_none(),
                            fingerprint: fingerprint(r),
                        };
                        (r.id, cred)
                    })
                    .collect();
            }
            Ok(Err(e)) => warn!("model access: omp's credentials: {e}"),
            Err(e) => warn!("model access: omp's credentials: {e}"),
        }
    }

    /// The credentials of `provider` omp uses now.
    fn active(&self, provider: &str) -> impl Iterator<Item = (&i64, &Cred)> {
        self.creds.iter().filter(move |(_, c)| c.active && c.provider == provider)
    }
}

static PERSIST: OnceLock<Arc<Persist>> = OnceLock::new();
/// Requests noted and not folded in yet (the replica notes them under its session's lock).
static PENDING: LazyLock<Mutex<Vec<Noted>>> = LazyLock::new(Default::default);
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
static RESOLVER: LazyLock<tokio::sync::Mutex<Resolver>> = LazyLock::new(Default::default);

/// Starts the service on hostd's `state.json` (`daemon::async_main`): what is noted is folded in
/// [`SETTLE_AFTER`] later, until `cancel`.
pub fn init(persist: Arc<Persist>, cancel: CancellationToken) {
    if PERSIST.set(persist.clone()).is_err() {
        return;
    }
    let now = now_ms();
    if persist.read(|d| d.model_access.values().flat_map(BTreeMap::values).any(|s| now - s.at >= FORGET_MS)) {
        persist.update(|d| prune(&mut d.model_access, now));
    }
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = WAKE.notified() => {}
            }
            tokio::time::sleep(SETTLE_AFTER).await;
            settle().await;
        }
    });
}

/// Requests of omp session `session_id` (its root session; assistant messages that name their
/// credential): what this host may learn of them ([`admissible`]) is folded in shortly.
pub fn note(session_id: &str, uses: Vec<CredentialUse>) {
    let Some(persist) = PERSIST.get().filter(|_| !uses.is_empty()) else { return };
    let now = now_ms();
    let arrived = match persist.read(|d| d.model_access_arrivals.get(session_id).copied()) {
        Some(at) => at,
        None => persist.update(|d| *d.model_access_arrivals.entry(session_id.to_owned()).or_insert(now)),
    };
    push(admissible(uses, arrived));
}

/// Requests this host's own omp recorded ([`omp_blocks`]): its credential ids are this host's.
pub fn note_local(uses: Vec<CredentialUse>) {
    if PERSIST.get().is_some() {
        push(uses.into_iter().map(|u| (u, true)).collect());
    }
}

fn push(noted: Vec<Noted>) {
    if noted.is_empty() {
        return;
    }
    let mut pending = PENDING.lock().unwrap_or_else(|p| p.into_inner());
    for n in noted {
        // Of the requests on one credential and model with one outcome, the newest counts.
        match pending.iter_mut().find(|(p, local)| *local == n.1 && p.credential_id == n.0.credential_id && p.model == n.0.model && p.denied == n.0.denied && p.account == n.0.account) {
            Some(p) if p.0.at < n.0.at => *p = n,
            Some(_) => {}
            None => pending.push(n),
        }
    }
    WAKE.notify_one();
}

/// Folds in what was noted, now (a stop is decided on it at once).
pub async fn settle() {
    let uses = std::mem::take(&mut *PENDING.lock().unwrap_or_else(|p| p.into_inner()));
    let Some(persist) = PERSIST.get().filter(|_| !uses.is_empty()) else { return };
    let mut resolver = RESOLVER.lock().await;
    if uses.iter().any(|n| resolve(&resolver.creds, n).is_none()) {
        resolver.reload().await;
    }
    let learned: Vec<(String, String, Seen, String)> = uses
        .into_iter()
        .filter_map(|n| {
            let c = resolve(&resolver.creds, &n)?;
            Some((c.key.clone(), n.0.model, Seen { denied: n.0.denied, at: n.0.at }, c.label.clone()))
        })
        .collect();
    drop(resolver);
    let tells = |book: &Book| learned.iter().any(|(key, model, seen, _)| tells_more(book.get(key).and_then(|m| m.get(model)), seen));
    if !persist.read(|d| tells(&d.model_access)) {
        return;
    }
    persist.update(|d| {
        for (key, model, seen, label) in &learned {
            let was = d.model_access.get(key).and_then(|m| m.get(model)).map(|s| s.denied);
            if record(&mut d.model_access, key, model, *seen) && was != Some(seen.denied) {
                info!(account = %label, model = %model, denied = seen.denied, "model access learned");
            }
        }
        let now = now_ms();
        prune(&mut d.model_access, now);
        d.model_access_arrivals.retain(|_, at| now - *at < FORGET_MS);
    });
}

/// What is known at `now` of the account omp's usage report names `provider` / `ident`
/// (`LimitAccount.models`).
pub(crate) fn models_for(provider: &str, ident: &Ident, now: Millis) -> Vec<ModelAccess> {
    PERSIST.get().map(|p| p.read(|d| current_for(&d.model_access, provider, ident, now))).unwrap_or_default()
}

/// Everything known at `now`, per stored credential's account ([`key_of`], `LinkedAccount.models`).
pub fn known(now: Millis) -> HashMap<String, Vec<ModelAccess>> {
    let Some(persist) = PERSIST.get() else { return HashMap::new() };
    persist.read(|d| d.model_access.keys().map(|k| (k.clone(), current(&d.model_access, k, now))).filter(|(_, v)| !v.is_empty()).collect())
}

/// Whether every credential of `provider` omp uses now is refused `model` at `now` (`None`: omp's
/// store lists none of them, e.g. they are in an auth broker). A stored credential the usage
/// report leaves out (an API key) may still serve it.
pub async fn all_refused(provider: &str, model: &str, now: Millis) -> Option<bool> {
    let mut resolver = RESOLVER.lock().await;
    resolver.reload().await;
    let keys: Vec<String> = resolver.active(provider).map(|(_, c)| c.key.clone()).collect();
    drop(resolver);
    if keys.is_empty() {
        return None;
    }
    let persist = PERSIST.get()?;
    Some(persist.read(|d| keys.iter().all(|k| access_of(&current(&d.model_access, k, now), model, now) == Access::Denied)))
}

/// The refusals in omp's credential block store `db` (`auth_credential_blocks` rows of scope
/// `model-policy:<model>`, read-only): what omp got over without writing a message. omp keeps an
/// expired block until one of its processes starts and clears it, so a refusal stays readable
/// for a while after its minute. Blocking I/O.
pub fn omp_blocks(db: &Path) -> Vec<CredentialUse> {
    let Some(conn) = open_ro(db).ok().flatten() else { return vec![] };
    let rows = conn
        .prepare("SELECT credential_id, provider_key, block_scope, updated_at FROM auth_credential_blocks WHERE block_scope >= 'model-policy:' AND block_scope < 'model-policy;'")
        .and_then(|mut stmt| {
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))?.collect::<Result<Vec<_>, _>>()
        });
    let Ok(rows) = rows else { return vec![] };
    rows.into_iter()
        .filter_map(|(credential_id, provider_key, scope, updated)| {
            // `<provider>:<credential type>`; `updated_at` in seconds.
            let (provider, _) = provider_key.rsplit_once(':')?;
            let model = scope.strip_prefix(MODEL_SCOPE).filter(|m| !m.is_empty())?;
            let at = if updated < 100_000_000_000 { updated * 1000 } else { updated };
            Some(CredentialUse { credential_id, provider: provider.to_owned(), model: model.to_owned(), denied: true, at, account: None })
        })
        .collect()
}

/// [`omp_blocks`] of omp's own `agent.db`, noted.
pub async fn note_omp_blocks() {
    if PERSIST.get().is_none() {
        return;
    }
    let db = omp_agent_dir().join("agent.db");
    if let Ok(blocks) = tokio::task::spawn_blocking(move || omp_blocks(&db)).await {
        note_local(blocks);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: Millis = HOUR_MS;

    fn seen(denied: bool, at: Millis) -> Seen {
        Seen { denied, at }
    }

    #[test]
    fn the_newer_request_wins_and_knowledge_expires() {
        let t = 1_000 * H;
        let mut book = Book::new();
        assert!(record(&mut book, "anthropic|email:a", "claude-mythos-5-2", seen(true, t)));
        let now = t + H;
        let a = current(&book, "anthropic|email:a", now);
        assert_eq!(access_of(&a, "claude-mythos-5-2", now), Access::Denied);
        assert_eq!(access_of(&a, "Claude-Mythos-5-2", now), Access::Denied, "ids compare without case");
        assert_eq!(access_of(&a, "claude-opus-5", now), Access::Unknown, "another model: nothing known");
        // An older answer (read late from a subagent's transcript) does not clear the refusal…
        assert!(!record(&mut book, "anthropic|email:a", "claude-mythos-5-2", seen(false, t - 1)));
        assert_eq!(access_of(&current(&book, "anthropic|email:a", now), "claude-mythos-5-2", now), Access::Denied);
        // …a newer one does: access was granted since.
        assert!(record(&mut book, "anthropic|email:a", "claude-mythos-5-2", seen(false, t + 10)));
        assert_eq!(access_of(&current(&book, "anthropic|email:a", now), "claude-mythos-5-2", now), Access::Serves);
        // A refusal counts a day, an answer a week; then nothing is known.
        assert!(record(&mut book, "anthropic|email:b", "claude-mythos-5-2", seen(true, t)));
        let day = t + DENIED_FOR_MS;
        assert_eq!(access_of(&current(&book, "anthropic|email:b", day - 1), "claude-mythos-5-2", day - 1), Access::Denied);
        assert!(current(&book, "anthropic|email:b", day).is_empty(), "expired knowledge is not sent");
        assert_eq!(access_of(&[ModelAccess { model: "claude-mythos-5-2".into(), denied: true, at: t }], "claude-mythos-5-2", day), Access::Unknown);
        let week = t + 10 + SERVED_FOR_MS;
        assert_eq!(access_of(&current(&book, "anthropic|email:a", week - 1), "claude-mythos-5-2", week - 1), Access::Serves);
        assert_eq!(access_of(&current(&book, "anthropic|email:a", week), "claude-mythos-5-2", week), Access::Unknown);
        // Repeats renew the time in steps only: a busy agent does not rewrite state.json each reply.
        assert!(!record(&mut book, "anthropic|email:b", "claude-mythos-5-2", seen(true, t + 5 * 60_000)));
        assert!(record(&mut book, "anthropic|email:b", "claude-mythos-5-2", seen(true, t + H)));
        assert_eq!(book["anthropic|email:b"]["claude-mythos-5-2"].at, t + H);
        // Records past a month go.
        assert!(prune(&mut book, t + H + FORGET_MS));
        assert!(book.is_empty());
    }

    #[test]
    fn the_usage_reports_account_gets_the_records_of_its_credentials() {
        let t = 1_000 * H;
        let mut book = Book::new();
        record(&mut book, "anthropic|email:dev@example.test|org:org_test_0001", "claude-mythos-5-2", seen(true, t));
        // An older login of the same account without its organization in the identity key.
        record(&mut book, "anthropic|email:dev@example.test", "claude-mythos-5-2", seen(false, t - H));
        record(&mut book, "anthropic|email:other@example.test|org:org_test_0002", "claude-mythos-5-2", seen(false, t));
        record(&mut book, "anthropic|#4", "claude-mythos-5-2", seen(false, t));
        let dev = Ident { email: Some("dev@example.test".into()), org_id: Some("org_test_0001".into()), ..Default::default() };
        let got = current_for(&book, "anthropic", &dev, t + 1);
        assert_eq!(got, vec![ModelAccess { model: "claude-mythos-5-2".into(), denied: true, at: t }], "the newest record of the account");
        assert!(current_for(&book, "openai-codex", &dev, t + 1).is_empty(), "another provider's account");
        let other = Ident { email: Some("someone@example.test".into()), ..Default::default() };
        assert!(current_for(&book, "anthropic", &other, t + 1).is_empty());
    }

    fn cred(id: i64, email: &str) -> (CredRow, Cred) {
        let row = CredRow { id, provider: "anthropic".into(), oauth: true, identity_key: Some(format!("email:{email}|org:org_test_0001")), email: Some(email.into()), org_id: Some("org_test_0001".into()), ..Default::default() };
        let c = Cred { provider: "anthropic".into(), key: key_of(&row), identity_key: row.identity_key.clone(), oauth: true, label: email.into(), active: true, fingerprint: fingerprint(&row) };
        (row, c)
    }

    fn refusal(id: i64, at: Millis, account: Option<String>) -> CredentialUse {
        CredentialUse { credential_id: id, provider: "anthropic".into(), model: "claude-mythos-5-2".into(), denied: true, at, account }
    }

    #[test]
    fn a_moved_session_teaches_by_id_only_what_happened_here() {
        let arrived = 1_000 * H;
        // On host B, credential 7 is another account than host A's credential 7, and A's account
        // is B's credential 9.
        let (_, b7) = cred(7, "b-seven@example.test");
        let (a_row, b9) = cred(9, "a-seven@example.test");
        let creds: HashMap<i64, Cred> = [(7, b7.clone()), (9, b9.clone())].into();
        // A's credential 7 was refused before the session came here, with no fingerprint: nothing.
        let noted = admissible(vec![refusal(7, arrived - H, None)], arrived);
        assert!(noted.is_empty(), "B's credential 7 is not marked");
        // The same refusal with the fingerprint omp recorded on A: it names B's credential 9.
        let print = fingerprint(&a_row);
        let noted = admissible(vec![refusal(7, arrived - H, print.clone())], arrived);
        assert_eq!(noted.len(), 1);
        assert_eq!(resolve(&creds, &noted[0]).map(|c| c.key.as_str()), Some(b9.key.as_str()), "the denial carries over to the same account");
        // A fingerprint this host does not know, from before the arrival: nothing.
        let noted = admissible(vec![refusal(7, arrived - H, Some("00".repeat(32)))], arrived);
        assert_eq!(resolve(&creds, &noted[0]), None);
        // Written here after the arrival: learned by its id.
        let noted = admissible(vec![refusal(7, arrived + 1, None)], arrived);
        assert_eq!(resolve(&creds, &noted[0]).map(|c| c.key.as_str()), Some(b7.key.as_str()));
        // omp's fingerprint: SHA-256 of provider, account id, email, organization and project.
        assert_eq!(print.map(|p| p.len()), Some(64));
    }

    #[test]
    fn omps_model_blocks_are_refusals() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("agent.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        // omp 19.0.1's table, as its credential store creates it.
        conn.execute_batch(
            "CREATE TABLE auth_credential_blocks (credential_id INTEGER NOT NULL, provider_key TEXT NOT NULL, block_scope TEXT NOT NULL DEFAULT '',
               blocked_until_ms INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (credential_id, provider_key, block_scope));
             INSERT INTO auth_credential_blocks VALUES (3, 'anthropic:oauth', 'model-policy:claude-mythos-5-2', 1790000060000, 1790000000);
             INSERT INTO auth_credential_blocks VALUES (2, 'openai-codex:oauth', 'chat', 1790003600000, 1790000000);
             INSERT INTO auth_credential_blocks VALUES (4, 'anthropic:oauth', 'account-policy', 1790000060000, 1790000000);",
        )
        .unwrap();
        drop(conn);
        let got = omp_blocks(&db);
        assert_eq!(got, vec![CredentialUse { credential_id: 3, provider: "anthropic".into(), model: "claude-mythos-5-2".into(), denied: true, at: 1_790_000_000_000, account: None }]);
        assert!(omp_blocks(&dir.path().join("none.db")).is_empty(), "no store: nothing");
    }
}
