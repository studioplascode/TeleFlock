//! `accounts.*`: the subscription accounts and API keys omp signs in with (architecture §3.14).
//!
//! - **Providers**: `omp auth-broker list --json` (what `omp login` offers, in its `/login` order),
//!   cached per omp binary.
//! - **Accounts**: omp's credential rows in `<agent dir>/agent.db`, read-only. Secrets never leave
//!   SQLite: only the identity fields (`email`, `accountId`, `projectId`, `orgId`, `orgName`,
//!   `enterpriseUrl`) are taken out of the credential JSON with `json_extract`. Quota windows and plans
//!   come from `omp usage --json` (`limits.rs`), live sessions per account from omp's session pins.
//! - **Link**: `omp login <provider>` with piped stdio, driven as an [`AuthFlow`] (`authflow.rs`):
//!   its printed URL / device code / questions become the flow, the user's answers and pastes go to
//!   its stdin (every OAuth-code login in omp also reads a pasted code or redirect address there,
//!   racing its loopback callback server). Its own attempt to open a browser on the host is
//!   suppressed (a no-op `xdg-open` / `open` first on its `PATH`): the app opens the URL on the device.
//! - **Unlink**: omp's own RPC `logout` (one credential), in a throwaway headless omp.
//! - **Prefer**: omp has no default account; `auth.accountPolicies[].priority` ranks an account first
//!   for new sessions (after omp's hard safety checks). TeleFlock writes priority
//!   [`PREFERRED_PRIORITY`] for the preferred account with a selector of its exact identity, after
//!   checking that it singles out that one stored account (omp rejects ambiguous selectors).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::mpsc;

use tf_proto::{
    AccountsSnapshot, ApiError, AuthFlow, AuthFlowState, AuthPaste, AuthPrompt, CredentialKind, HostMethod, LimitAccount, LinkedAccount,
    LoginProvider, Millis,
};

use crate::authflow::{self, FlowCtl, FlowInput, LoopbackRedirect};
use crate::clients::ClientHandle;
use crate::ops::fs::home_dir;
use crate::ops::git::run_cmd;
use crate::ops::host::{omp_agent_dir, omp_bin, open_ro};
use crate::ops::limits::{self, identity_matches, Ident};
use crate::ops::tools::{strip_ansi, TreeGuard};
use crate::ops::{omp_config, to_value, Ctx};
use crate::util::{clip, now_ms};

/// `AuthFlow.kind` of account links.
pub const KIND: &str = "account";
/// `auth.accountPolicies[].priority` TeleFlock gives the preferred account of a provider.
pub const PREFERRED_PRIORITY: f64 = 100.0;
/// Device-code logins wait up to 15 min for the user (GitHub's code lifetime).
const LINK_TTL: Duration = Duration::from_secs(15 * 60);
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// `omp --mode rpc` start + logout + its provider model refresh. Public for the app's request
/// timeout of `accounts.unlink` (tf-client `timeout_for`), which must outlast it.
pub const LOGOUT_TIMEOUT: Duration = Duration::from_secs(90);
/// An unterminated line that stays unchanged this long is a question omp waits on.
const PROMPT_QUIET: Duration = Duration::from_millis(150);
/// How long a submission waits for omp's reaction before it counts as taken.
const VERDICT_WAIT: Duration = Duration::from_secs(3);
/// Disabled credentials omp removed on purpose (not worth showing).
const QUIET_CAUSES: &[&str] = &["replaced by", "deleted by user", "logged out by user"];
/// Lines of omp's stderr kept for an error message.
const STDERR_TAIL: usize = 6;

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::AccountsList(p) => to_value(snapshot(ctx, p.refresh.unwrap_or(false)).await?),
        HostMethod::AccountsLink(p) => to_value(link(ctx, &p.provider).await?),
        HostMethod::AccountsUnlink(p) => to_value(unlink(ctx, &p.provider, p.credential_id).await?),
        HostMethod::AccountsPrefer(p) => to_value(prefer(ctx, &p.key, p.preferred).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not an accounts method", other.name()))),
    }
}

fn no_omp() -> ApiError {
    ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install omp (oh-my-pi) from Host setup.")
}

// ───────────────────────────── providers ─────────────────────────────

/// The omp binary a provider list was read from (path, size, mtime): an update reads it again.
type BinStamp = (PathBuf, u64, u128);

fn stamp(bin: &Path) -> BinStamp {
    let meta = std::fs::metadata(bin).ok();
    let mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    (bin.to_path_buf(), meta.map(|m| m.len()).unwrap_or(0), mtime)
}

static PROVIDERS: LazyLock<tokio::sync::Mutex<Option<(BinStamp, Vec<LoginProvider>)>>> = LazyLock::new(Default::default);

async fn providers(bin: &Path) -> Result<Vec<LoginProvider>, ApiError> {
    let stamp = stamp(bin);
    let mut cache = PROVIDERS.lock().await;
    if let Some((s, list)) = cache.as_ref()
        && *s == stamp
    {
        return Ok(list.clone());
    }
    let out = run_cmd(bin, &["auth-broker", "list", "--json"], Some(&std::env::temp_dir()), &[("NO_COLOR", "1")], None, CLI_TIMEOUT)
        .await
        .map_err(|e| ApiError::new("omp_error", format!("omp auth-broker list: {e}")))?;
    if !out.ok() {
        return Err(ApiError::new("omp_error", format!("omp auth-broker list failed: {}", clip(&out.message(), 300))));
    }
    let list = parse_providers(&out.stdout).map_err(|e| ApiError::new("omp_error", e))?;
    *cache = Some((stamp, list.clone()));
    Ok(list)
}

/// `omp auth-broker list --json`: one JSON array line `[{id, name}, …]` (log lines may precede it).
pub(crate) fn parse_providers(stdout: &[u8]) -> Result<Vec<LoginProvider>, String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().rev().map(str::trim).find(|l| l.starts_with('[')).ok_or("omp auth-broker list printed no provider list")?;
    let items: Vec<Value> = serde_json::from_str(line).map_err(|e| format!("omp auth-broker list output: {e}"))?;
    let mut out: Vec<LoginProvider> = Vec::with_capacity(items.len());
    for it in items {
        let Some(id) = it.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else { continue };
        if out.iter().any(|p| p.id == id) {
            continue;
        }
        let name = it.get("name").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(id);
        out.push(LoginProvider { id: id.to_string(), name: name.to_string() });
    }
    Ok(out)
}

// ───────────────────────────── stored credentials ─────────────────────────────

/// One row of omp's `auth_credentials`, without its secrets.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct CredRow {
    pub id: i64,
    pub provider: String,
    pub oauth: bool,
    /// `disabled_cause`: set = omp no longer uses it.
    pub disabled: Option<String>,
    pub identity_key: Option<String>,
    pub email: Option<String>,
    pub account_id: Option<String>,
    pub project_id: Option<String>,
    pub org_id: Option<String>,
    pub org_name: Option<String>,
    pub enterprise_url: Option<String>,
    pub created_at: Option<Millis>,
    pub updated_at: Option<Millis>,
}

impl CredRow {
    /// The credential's exact identity fields (what an account policy selector matches).
    fn ident(&self) -> Ident {
        Ident { email: self.email.clone(), account_id: self.account_id.clone(), project_id: self.project_id.clone(), org_id: self.org_id.clone() }
    }
}

/// Identity fields read out of the credential JSON (by SQLite; the tokens stay there).
const IDENTITY_FIELDS: [&str; 6] = ["email", "accountId", "projectId", "orgId", "orgName", "enterpriseUrl"];

/// omp's stored credentials, oldest first, without the MCP servers' OAuth sign-ins omp keeps in the
/// same table (managed on the MCP page). A missing database or table is an empty store.
pub(crate) fn read_credentials(db: &Path) -> Result<Vec<CredRow>, String> {
    let Some(conn) = open_ro(db).map_err(|e| e.message)? else { return Ok(vec![]) };
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('auth_credentials')")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect())
        .map_err(|e| format!("agent.db: {e}"))?;
    if cols.is_empty() {
        return Ok(vec![]);
    }
    let col = |c: &str| if cols.iter().any(|x| x == c) { c.to_string() } else { "NULL".to_string() };
    let has_data = cols.iter().any(|c| c == "data");
    let fields: Vec<String> = IDENTITY_FIELDS
        .iter()
        .map(|f| if has_data { format!("CASE WHEN credential_type = 'oauth' AND json_valid(data) THEN json_extract(data, '$.{f}') END") } else { "NULL".into() })
        .collect();
    let sql = format!(
        "SELECT id, provider, credential_type, {}, {}, {}, {}, {} FROM auth_credentials ORDER BY id",
        col("disabled_cause"),
        col("identity_key"),
        col("created_at"),
        col("updated_at"),
        fields.join(", ")
    );
    let text = |r: &rusqlite::Row<'_>, i: usize| -> Option<String> {
        r.get::<_, Option<String>>(i).ok().flatten().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let secs = |r: &rusqlite::Row<'_>, i: usize| -> Option<Millis> { r.get::<_, Option<i64>>(i).ok().flatten().filter(|s| *s > 0).map(|s| s * 1000) };
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("agent.db: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CredRow {
                id: r.get(0)?,
                provider: r.get(1)?,
                oauth: r.get::<_, String>(2)? == "oauth",
                disabled: text(r, 3),
                identity_key: text(r, 4),
                created_at: secs(r, 5),
                updated_at: secs(r, 6),
                email: text(r, 7),
                account_id: text(r, 8),
                project_id: text(r, 9),
                org_id: text(r, 10),
                org_name: text(r, 11),
                enterprise_url: text(r, 12),
            })
        })
        .map_err(|e| format!("agent.db: {e}"))?;
    let rows = rows.collect::<Result<Vec<CredRow>, _>>().map_err(|e| format!("agent.db: {e}"))?;
    Ok(rows.into_iter().filter(|r| !is_mcp_credential(&r.provider)).collect())
}

/// omp's `isManagedMCPOAuthCredentialId` (`mcp/oauth-flow.ts`): an MCP server's OAuth sign-in
/// (`mcp_oauth:profile:<profile>:<url>`, older `mcp_oauth:<url>` / `mcp_oauth_<random>`).
fn is_mcp_credential(provider: &str) -> bool {
    provider.starts_with("mcp_oauth:") || provider.starts_with("mcp_oauth_")
}

/// Live sessions per credential id, from omp's session pins (`session:sticky:<provider>:<id>`);
/// a provider with a single active credential needs no pin.
fn sessions_per_credential(db: &Path, live: &[(String, String)], rows: &[CredRow]) -> HashMap<i64, u32> {
    let mut out = HashMap::new();
    let conn = open_ro(db).ok().flatten();
    for (sid, provider) in live {
        let pinned = conn.as_ref().and_then(|c| {
            let raw: String = c
                .query_row(
                    "SELECT value FROM cache WHERE key = ?1 AND expires_at > CAST(strftime('%s','now') AS INTEGER)",
                    [format!("session:sticky:{provider}:{sid}")],
                    |r| r.get(0),
                )
                .ok()?;
            serde_json::from_str::<Value>(&raw).ok()?.get("credentialId").and_then(Value::as_i64)
        });
        let id = pinned.filter(|id| rows.iter().any(|r| r.id == *id)).or_else(|| {
            let mut active = rows.iter().filter(|r| r.disabled.is_none() && r.provider == *provider);
            match (active.next(), active.next()) {
                (Some(r), None) => Some(r.id),
                _ => None,
            }
        });
        if let Some(id) = id {
            *out.entry(id).or_insert(0) += 1;
        }
    }
    out
}

// ───────────────────────────── snapshot ─────────────────────────────

fn link_flows() -> Vec<AuthFlow> {
    authflow::list().into_iter().filter(|f| f.kind == KIND).collect()
}

/// The auth broker omp stores credentials in, if any (env first, like omp).
async fn broker_url(ctx: &Ctx, refresh: bool) -> Option<String> {
    if let Some(url) = std::env::var("OMP_AUTH_BROKER_URL").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Some(url);
    }
    match omp_config::global_value(ctx, "auth.broker.url", refresh).await {
        Ok(Some(Value::String(s))) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

pub async fn snapshot(ctx: &Ctx, refresh: bool) -> Result<AccountsSnapshot, ApiError> {
    let fetched_at = now_ms();
    let Some(bin) = omp_bin() else {
        return Ok(AccountsSnapshot { providers: vec![], accounts: vec![], broker: None, flows: link_flows(), fetched_at, error: Some(no_omp().message) });
    };
    let mut errors: Vec<String> = Vec::new();
    let providers = providers(&bin).await.unwrap_or_else(|e| {
        errors.push(e.message);
        vec![]
    });
    let (usage, idents) = limits::limits_with_idents(ctx, refresh).await?;
    if let Some(e) = &usage.error {
        errors.push(format!("quota: {e}"));
    }
    let db = omp_agent_dir().join("agent.db");
    let live: Vec<(String, String)> = ctx
        .state
        .snapshot()
        .agents
        .into_iter()
        .filter_map(|a| {
            let omp = a.omp?;
            Some((omp.session_id?, omp.model?.provider))
        })
        .collect();
    let (rows, sessions) = tokio::task::spawn_blocking(move || {
        let rows = read_credentials(&db);
        let sessions = rows.as_ref().map(|r| sessions_per_credential(&db, &live, r)).unwrap_or_default();
        (rows, sessions)
    })
    .await
    .map_err(|e| ApiError::new("internal", e.to_string()))?;
    let rows = rows.unwrap_or_else(|e| {
        errors.push(e);
        vec![]
    });
    let policies = match omp_config::global_value(ctx, "auth.accountPolicies", refresh).await {
        Ok(Some(Value::Array(p))) => p,
        Ok(_) => vec![],
        Err(e) => {
            errors.push(format!("account policies: {}", e.message));
            vec![]
        }
    };
    let broker = broker_url(ctx, refresh).await;
    let accounts = merge(&rows, &usage.accounts, &idents, &sessions, &policies, &providers, broker.is_some());
    Ok(AccountsSnapshot { providers, accounts, broker, flows: link_flows(), fetched_at, error: (!errors.is_empty()).then(|| errors.join(" · ")) })
}

fn label_of(row: &CredRow) -> String {
    if !row.oauth {
        return format!("API key #{}", row.id);
    }
    if let Some(l) = row.email.clone().or_else(|| row.account_id.clone()).or_else(|| row.project_id.clone()).or_else(|| row.enterprise_url.clone()) {
        return l;
    }
    // Older rows without identity fields: what the identity key names.
    for part in row.identity_key.as_deref().unwrap_or_default().split('|') {
        if let Some((kind, value)) = part.split_once(':')
            && matches!(kind, "email" | "account" | "project")
        {
            return value.to_string();
        }
    }
    format!("Account #{}", row.id)
}

fn key_of(row: &CredRow) -> String {
    match (&row.identity_key, row.oauth) {
        (Some(ik), true) => format!("{}|{ik}", row.provider),
        _ => format!("{}|#{}", row.provider, row.id),
    }
}

fn has_base_identity(id: &Ident) -> bool {
    id.email.is_some() || id.account_id.is_some() || id.project_id.is_some()
}

/// omp's `matchesAuthAccountSelector`: every field the selector sets equals the credential's.
fn selector_matches(selector: &Ident, id: &Ident) -> bool {
    let eq = |s: &Option<String>, v: &Option<String>| s.is_none() || s == v;
    eq(&selector.email, &id.email) && eq(&selector.account_id, &id.account_id) && eq(&selector.project_id, &id.project_id) && eq(&selector.org_id, &id.org_id)
}

fn policy_selector(p: &Value) -> Ident {
    let account = p.get("account");
    let f = |k: &str| account.and_then(|a| a.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    Ident { email: f("email"), account_id: f("accountId"), project_id: f("projectId"), org_id: f("orgId") }
}

fn policy_priority(p: &Value) -> Option<f64> {
    p.get("priority").and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// Why `row` can't be the preferred account (`None`: it can).
fn prefer_blocked(row: &CredRow, active: &[&CredRow], broker: bool) -> Option<String> {
    if broker {
        return Some("Preferences for accounts in an auth broker are set on the broker host.".into());
    }
    if !row.oauth {
        return Some("omp prefers signed-in accounts; API keys are used in the order they were added.".into());
    }
    if row.disabled.is_some() {
        return Some("Link it again first.".into());
    }
    let id = row.ident();
    if !has_base_identity(&id) {
        return Some("omp doesn't know who this account is, so it can't be preferred.".into());
    }
    let same = active.iter().filter(|o| o.provider == row.provider && o.oauth && selector_matches(&id, &o.ident())).count();
    if same > 1 {
        return Some("Another linked account has the very same identity.".into());
    }
    None
}

/// Stored credentials + omp's usage report → the accounts the app shows.
pub(crate) fn merge(
    rows: &[CredRow],
    usage: &[LimitAccount],
    idents: &[Ident],
    sessions: &HashMap<i64, u32>,
    policies: &[Value],
    providers: &[LoginProvider],
    broker: bool,
) -> Vec<LinkedAccount> {
    let mut used = vec![false; usage.len()];
    let active: Vec<&CredRow> = rows.iter().filter(|r| r.disabled.is_none()).collect();
    let mut out: Vec<LinkedAccount> = Vec::new();
    let quiet = |cause: &str| QUIET_CAUSES.iter().any(|q| cause.starts_with(q));
    // An expired login omp didn't remove on purpose.
    let expired = |r: &CredRow| r.oauth && r.disabled.as_deref().is_some_and(|c| !quiet(c));
    let same_identity = |a: &CredRow, b: &CredRow| a.provider == b.provider && a.identity_key.is_some() && a.identity_key == b.identity_key;
    for row in rows {
        // A tombstone of an account that is linked again is history. omp rewrites the cause of
        // active rows only, so an account that expired, was linked again and expired again leaves
        // two: the newest one shows.
        let shown = row.disabled.is_none()
            || (expired(row) && !active.iter().any(|a| same_identity(a, row)) && !rows.iter().any(|o| o.id > row.id && expired(o) && same_identity(o, row)));
        if !shown {
            continue;
        }
        // The usage report of this credential: same identity (OAuth), or the identity-less entry
        // omp lists for an API key.
        let report = (0..usage.len()).find(|&i| {
            !used[i]
                && usage[i].provider == row.provider
                && usage[i].disabled == row.disabled.is_some()
                && match (&row.identity_key, row.oauth) {
                    (Some(ik), true) => identity_matches(ik, &idents[i]),
                    (None, false) => !has_base_identity(&idents[i]) && idents[i].org_id.is_none(),
                    _ => false,
                }
        });
        if let Some(i) = report {
            used[i] = true;
        }
        let r = report.map(|i| &usage[i]);
        let id = row.ident();
        let preferred = row.disabled.is_none()
            && row.oauth
            && has_base_identity(&id)
            && policies.iter().any(|p| {
                p.get("provider").and_then(Value::as_str) == Some(row.provider.as_str())
                    && policy_priority(p).is_some_and(|n| n >= PREFERRED_PRIORITY)
                    && selector_matches(&policy_selector(p), &id)
            });
        out.push(LinkedAccount {
            key: r.map(|r| r.key.clone()).unwrap_or_else(|| key_of(row)),
            provider: row.provider.clone(),
            credential_id: Some(row.id),
            kind: if row.oauth { CredentialKind::Oauth } else { CredentialKind::ApiKey },
            label: label_of(row),
            org: row.org_name.clone().or_else(|| r.and_then(|r| r.org.clone())),
            plan: r.and_then(|r| r.plan.clone()),
            linked_at: row.created_at,
            updated_at: row.updated_at,
            disabled: row.disabled.is_some(),
            disabled_reason: row.disabled.as_deref().map(|c| clip(c, 200)),
            preferred,
            prefer_blocked: prefer_blocked(row, &active, broker),
            sessions: sessions.get(&row.id).copied().unwrap_or(0),
            windows: r.map(|r| r.windows.clone()).unwrap_or_default(),
            windows_at: r.and_then(|r| r.fetched_at),
            windows_error: r.and_then(|r| r.error.clone()),
        });
    }
    // Accounts only the usage report knows (an auth broker's, or credentials outside agent.db).
    for (i, r) in usage.iter().enumerate() {
        if used[i] {
            continue;
        }
        out.push(LinkedAccount {
            key: r.key.clone(),
            provider: r.provider.clone(),
            credential_id: None,
            kind: CredentialKind::Oauth,
            label: r.label.clone(),
            org: r.org.clone(),
            plan: r.plan.clone(),
            linked_at: None,
            updated_at: None,
            disabled: r.disabled,
            disabled_reason: if r.disabled { r.error.clone() } else { None },
            preferred: false,
            prefer_blocked: Some(if broker {
                "Preferences for accounts in an auth broker are set on the broker host.".into()
            } else {
                "omp reports this account but doesn't store it on this host.".into()
            }),
            sessions: 0,
            windows: r.windows.clone(),
            windows_at: r.fetched_at,
            windows_error: if r.disabled { None } else { r.error.clone() },
        });
    }
    // A preference only counts for the highest-ranked account of its provider.
    let order = |p: &str| providers.iter().position(|x| x.id == p).unwrap_or(usize::MAX);
    out.sort_by(|a, b| {
        order(&a.provider)
            .cmp(&order(&b.provider))
            .then_with(|| a.provider.cmp(&b.provider))
            .then_with(|| b.preferred.cmp(&a.preferred))
            .then_with(|| a.disabled.cmp(&b.disabled))
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
            .then_with(|| a.credential_id.cmp(&b.credential_id))
    });
    let mut seen_preferred: Vec<String> = Vec::new();
    for a in &mut out {
        if a.preferred {
            if seen_preferred.contains(&a.provider) {
                a.preferred = false;
            } else {
                seen_preferred.push(a.provider.clone());
            }
        }
    }
    out
}

// ───────────────────────────── prefer ─────────────────────────────

/// `auth.accountPolicies` with `id` of `provider` preferred (or not): its policy (an existing one
/// that selects it, else a new one with its exact identity) gets [`PREFERRED_PRIORITY`]; other
/// preferred-level priorities of the provider are dropped (a policy left with nothing but its
/// selector is removed). Other providers' and other fields of policies stay as they are.
pub(crate) fn apply_preference(policies: &[Value], provider: &str, id: &Ident, preferred: bool) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::with_capacity(policies.len() + 1);
    let mut placed = false;
    for p in policies {
        let mine = p.get("provider").and_then(Value::as_str) == Some(provider);
        if !mine {
            out.push(p.clone());
            continue;
        }
        let selects = selector_matches(&policy_selector(p), id);
        let mut p = p.clone();
        let Some(obj) = p.as_object_mut() else { continue };
        if selects && preferred && !placed {
            obj.insert("priority".into(), json!(PREFERRED_PRIORITY));
            placed = true;
        } else if (selects && !preferred) || policy_priority(&Value::Object(obj.clone())).is_some_and(|n| n >= PREFERRED_PRIORITY) {
            obj.remove("priority");
        }
        let only_selector = obj.keys().all(|k| k == "provider" || k == "account");
        if !only_selector {
            out.push(p);
        }
    }
    if preferred && !placed {
        let mut account = Map::new();
        for (k, v) in [("email", &id.email), ("accountId", &id.account_id), ("projectId", &id.project_id), ("orgId", &id.org_id)] {
            if let Some(v) = v {
                account.insert(k.into(), json!(v));
            }
        }
        out.push(json!({ "provider": provider, "account": account, "priority": PREFERRED_PRIORITY }));
    }
    out
}

pub async fn prefer(ctx: &Ctx, key: &str, preferred: bool) -> Result<AccountsSnapshot, ApiError> {
    let current = snapshot(ctx, false).await?;
    let account = current.accounts.iter().find(|a| a.key == key).ok_or_else(|| ApiError::new("not_found", "that account is not linked on this host anymore").retryable())?;
    if let Some(why) = &account.prefer_blocked
        && preferred
    {
        return Err(ApiError::new("invalid_params", why.clone()));
    }
    let credential_id = account.credential_id.ok_or_else(|| ApiError::new("invalid_params", "this account isn't stored on this host"))?;
    let provider = account.provider.clone();
    let db = omp_agent_dir().join("agent.db");
    let rows = tokio::task::spawn_blocking(move || read_credentials(&db)).await.map_err(|e| ApiError::new("internal", e.to_string()))?.map_err(|e| ApiError::new("io_error", e))?;
    let row = rows.iter().find(|r| r.id == credential_id).ok_or_else(|| ApiError::new("not_found", "that account is not linked on this host anymore"))?;
    let policies = match omp_config::global_value(ctx, "auth.accountPolicies", true).await? {
        Some(Value::Array(p)) => p,
        _ => vec![],
    };
    let next = apply_preference(&policies, &provider, &row.ident(), preferred);
    if next != policies {
        omp_config::set_json(ctx, "auth.accountPolicies", &Value::Array(next)).await?;
        tracing::info!(provider, preferred, "account preference written");
    }
    // Config only (`set_json` dropped the cached config): the quota report is not read again.
    snapshot(ctx, false).await
}

// ───────────────────────────── unlink ─────────────────────────────

pub async fn unlink(ctx: &Ctx, provider: &str, credential_id: i64) -> Result<AccountsSnapshot, ApiError> {
    let bin = omp_bin().ok_or_else(no_omp)?;
    let db = omp_agent_dir().join("agent.db");
    let rows = tokio::task::spawn_blocking(move || read_credentials(&db)).await.map_err(|e| ApiError::new("internal", e.to_string()))?.map_err(|e| ApiError::new("io_error", e))?;
    let row = rows.iter().find(|r| r.id == credential_id && r.provider == provider);
    match row {
        None => return Err(ApiError::new("not_found", "that account is not linked on this host anymore")),
        Some(r) if r.disabled.is_some() => return Err(ApiError::new("invalid_params", "omp already stopped using this account").with_hint("Link it again to use it.")),
        Some(_) => {}
    }
    rpc_logout(&bin, provider, credential_id, &[]).await?;
    tracing::info!(provider, credential_id, "account unlinked");
    accounts_changed().await;
    // The quota report was just dropped, so it is read again; omp's config didn't change.
    snapshot(ctx, false).await
}

/// What a linked or unlinked credential changes elsewhere: the quota report, and the models omp
/// can use (`host.models`, cached five minutes: a new login brings its provider's models).
async fn accounts_changed() {
    limits::invalidate().await;
    crate::ops::host::invalidate_models().await;
}

/// argv of a throwaway headless omp for RPC commands: no session, nothing else loaded.
fn rpc_args() -> [&'static str; 8] {
    ["--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-extensions"]
}

/// omp's RPC `logout`: removes one credential the way `/logout` does (and refreshes the provider's
/// models). An omp that exits without answering (a broken config, no model to start with) is
/// reported with what it said on stderr. `env` is for tests.
async fn rpc_logout(bin: &Path, provider: &str, credential_id: i64, env: &[(&str, &str)]) -> Result<(), ApiError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(rpc_args())
        .current_dir(home_dir())
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| ApiError::new("omp_error", format!("couldn't start omp: {e}")))?;
    let _tree = TreeGuard(child.id());
    let tail = Arc::new(std::sync::Mutex::new(VecDeque::new()));
    let reader = child.stderr.take().map(|err| {
        let tail = tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let l = strip_ansi(&l).trim().to_string();
                if !l.is_empty() {
                    keep_tail(&mut tail.lock().unwrap_or_else(|p| p.into_inner()), &l);
                }
            }
        })
    });
    let request = json!({ "id": "tf-logout", "type": "logout", "providerId": provider, "credentialId": credential_id });
    let mut stdin = child.stdin.take().ok_or_else(|| ApiError::new("internal", "omp stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| ApiError::new("internal", "omp stdout"))?;
    // A request omp can't take (it exited at start) is reported with its reason below.
    let sent = async {
        stdin.write_all(format!("{request}\n").as_bytes()).await?;
        stdin.flush().await
    }
    .await
    .is_ok();
    let mut lines = BufReader::new(stdout).lines();
    let answer = if sent {
        tokio::time::timeout(LOGOUT_TIMEOUT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(res) = rpc_response(&line, "tf-logout") {
                    return Some(res);
                }
            }
            None
        })
        .await
        .map_err(|_| ApiError::new("timeout", "omp did not answer the logout in time"))?
    } else {
        None
    };
    drop(stdin);
    match answer {
        Some(Ok(())) => Ok(()),
        Some(Err(e)) => Err(ApiError::new("omp_error", e)),
        None => {
            // omp exited: what it printed last may still be in the pipe.
            if let Some(reader) = reader {
                let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
            }
            let code = tokio::time::timeout(Duration::from_secs(2), child.wait()).await.ok().and_then(Result::ok).and_then(|s| s.code());
            let tail = tail.lock().unwrap_or_else(|p| p.into_inner());
            Err(logout_failure(&tail, code))
        }
    }
}

/// Why omp exited without answering the logout: its error line on stderr (`Error: …`, else the last
/// line it printed), else its exit code.
fn logout_failure(stderr: &VecDeque<String>, code: Option<i32>) -> ApiError {
    let error = stderr.iter().rev().find(|l| l.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("error:")));
    match error.or(stderr.back()) {
        Some(reason) => ApiError::new("omp_error", reason.clone()),
        None => ApiError::new("omp_error", format!("omp exited{} without answering the logout", code.map(|c| format!(" with code {c}")).unwrap_or_default())),
    }
}

/// Keeps `line` (clipped) as one of the last [`STDERR_TAIL`] lines of omp's stderr.
fn keep_tail(tail: &mut VecDeque<String>, line: &str) {
    if tail.len() >= STDERR_TAIL {
        tail.pop_front();
    }
    tail.push_back(clip(line, 300));
}

/// The verdict of an RPC response line for request `id`.
pub(crate) fn rpc_response(line: &str, id: &str) -> Option<Result<(), String>> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("type").and_then(Value::as_str) != Some("response") || v.get("id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    if v.get("success").and_then(Value::as_bool) == Some(true) {
        Some(Ok(()))
    } else {
        Some(Err(v.get("error").and_then(Value::as_str).unwrap_or("omp refused the request").to_string()))
    }
}

// ───────────────────────────── link ─────────────────────────────

/// What `omp login` prints (omp 18.13 `cli/oauth-terminal.ts`, `cli/login-cli.ts`).
const URL_HEADER: &str = "Open this URL in your browser:";
const LOCAL_SHORTCUT: &str = "Local shortcut (this machine only):";
const PASTE_PROMPT: &str = "Paste the authorization code (or full redirect URL):";
const LOGGED_IN: &str = "Logged in to ";
const NOTHING_STORED: &str = "No credentials were stored for ";
const SAVED: &str = "Credentials saved to ";
const LOGIN_FAILED: &str = "Login failed: ";

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LoginEvent {
    /// The page to open (authorization page, device-code page, or where to get a key).
    Url(String),
    /// A line the provider printed under the URL (`Enter code: …` for device codes).
    Instructions(String),
    Progress(String),
    /// A question omp waits on.
    Prompt { message: String, placeholder: Option<String> },
    /// omp waits for the pasted code or redirect address (racing its callback server).
    PastePrompt,
    /// `Logged in to <name>[ as <who>]`.
    LoggedIn(Option<String>),
    NothingStored,
}

#[derive(Debug, Default, PartialEq)]
enum Block {
    #[default]
    None,
    /// The next line is the URL.
    Url,
    /// Provider lines under the URL, up to the blank line.
    Instructions,
}

/// Turns `omp login` stdout into [`LoginEvent`]s.
#[derive(Debug, Default)]
pub(crate) struct LoginParser {
    partial: Vec<u8>,
    block: Block,
    name: String,
}

impl LoginParser {
    pub fn new(provider_name: &str) -> Self {
        Self { name: provider_name.to_string(), ..Default::default() }
    }

    /// Events of the complete lines in `bytes` (plus what was buffered).
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<LoginEvent> {
        let mut out = Vec::new();
        self.partial.extend_from_slice(bytes);
        while let Some(i) = self.partial.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = self.partial.drain(..=i).collect();
            let line = strip_ansi(&String::from_utf8_lossy(&raw[..raw.len() - 1]));
            self.line(line.trim_end_matches('\r'), &mut out);
        }
        out
    }

    pub fn has_partial(&self) -> bool {
        !self.partial.is_empty()
    }

    /// The unterminated text as the question omp waits on (`…: `), consumed. Call it once the
    /// output has been quiet for a moment.
    pub fn prompt(&mut self) -> Option<LoginEvent> {
        let text = strip_ansi(&String::from_utf8_lossy(&self.partial));
        let t = text.trim();
        if !t.ends_with(':') {
            return None;
        }
        let ev = parse_prompt(t);
        self.partial.clear();
        self.block = Block::None;
        Some(ev)
    }

    fn line(&mut self, raw: &str, out: &mut Vec<LoginEvent>) {
        let l = raw.trim();
        if l.is_empty() {
            if self.block == Block::Instructions {
                self.block = Block::None;
            }
            return;
        }
        match self.block {
            Block::Url => {
                self.block = Block::Instructions;
                out.push(LoginEvent::Url(l.to_string()));
                return;
            }
            Block::Instructions => {
                if !l.starts_with(LOCAL_SHORTCUT) {
                    out.push(LoginEvent::Instructions(l.to_string()));
                }
                return;
            }
            Block::None => {}
        }
        if l == URL_HEADER {
            self.block = Block::Url;
        } else if let Some(rest) = l.strip_prefix(LOGGED_IN) {
            out.push(LoginEvent::LoggedIn(logged_in_as(rest, &self.name)));
        } else if l.starts_with(NOTHING_STORED) {
            out.push(LoginEvent::NothingStored);
        } else if !l.starts_with(SAVED) && !l.starts_with(LOCAL_SHORTCUT) {
            out.push(LoginEvent::Progress(l.to_string()));
        }
    }
}

/// `<name> as <who>` → `who` (`<name>` alone → none).
fn logged_in_as(rest: &str, name: &str) -> Option<String> {
    let after = rest.strip_prefix(name).map(str::trim_start).unwrap_or(rest);
    let who = match after.strip_prefix("as ") {
        Some(w) => w,
        None if after.len() == rest.len() => rest.rsplit_once(" as ").map(|(_, w)| w)?,
        None => return None,
    };
    Some(who.trim().to_string()).filter(|w| !w.is_empty())
}

/// `<message> (<placeholder>):` → the question.
fn parse_prompt(t: &str) -> LoginEvent {
    if t == PASTE_PROMPT {
        return LoginEvent::PastePrompt;
    }
    let body = t.trim_end_matches(':').trim_end();
    if body.ends_with(')')
        && let Some(open) = body.rfind(" (")
    {
        let placeholder = body[open + 2..body.len() - 1].trim();
        let message = body[..open].trim();
        if !message.is_empty() && !placeholder.is_empty() {
            return LoginEvent::Prompt { message: message.to_string(), placeholder: Some(placeholder.to_string()) };
        }
    }
    LoginEvent::Prompt { message: body.to_string(), placeholder: None }
}

fn is_secret_prompt(message: &str) -> bool {
    let m = message.to_lowercase();
    ["api key", "token", "secret", "password", "passphrase", "cookie"].iter().any(|w| m.contains(w)) || m.ends_with(" key")
}

/// The device code in a provider line (`Enter code: ABCD-1234`).
pub(crate) fn user_code_in(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    if let Some(i) = lower.find("code:") {
        let tok: String = text[i + 5..].trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        if tok.len() >= 4 {
            return Some(tok);
        }
    }
    text.split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-'))
        .find(|t| (6..=16).contains(&t.len()) && t.contains('-') && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-'))
        .map(str::to_string)
}

/// Serializes starting links (one running link per provider).
static LINKING: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub async fn link(ctx: &Ctx, provider: &str) -> Result<AuthFlow, ApiError> {
    let provider = provider.trim();
    let bin = omp_bin().ok_or_else(no_omp)?;
    let list = providers(&bin).await?;
    let p = list
        .iter()
        .find(|p| p.id == provider)
        .cloned()
        .ok_or_else(|| ApiError::new("invalid_params", format!("omp offers no sign-in for `{provider}`")).with_hint("Pick a provider from the list."))?;
    let shim = no_browser_dir(&ctx.paths.run);
    start_link(&bin, p, shim.as_deref(), &[])
}

/// A directory with no-op browser openers: first on `omp login`'s `PATH`, so it never opens a
/// browser on the host (the app opens the URL on the device). `None` on Windows, where omp opens
/// URLs through PowerShell (a Windows host is the device itself).
fn no_browser_dir(run: &Path) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let dir = run.join("no-browser");
    let script = b"#!/bin/sh\n# TeleFlock: the app opens sign-in pages on the device.\nexit 0\n";
    let make = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        for name in ["xdg-open", "open", "wslview"] {
            let path = dir.join(name);
            if std::fs::read(&path).ok().as_deref() != Some(&script[..]) {
                std::fs::write(&path, script)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
            }
        }
        Ok(())
    };
    match make() {
        Ok(()) => Some(dir),
        Err(e) => {
            tracing::warn!("no-browser shim {}: {e}", dir.display());
            None
        }
    }
}

/// Starts `bin login <provider>` as a flow, or returns the provider's link that still runs.
pub(crate) fn start_link(bin: &Path, p: LoginProvider, shim: Option<&Path>, env: &[(&str, &str)]) -> Result<AuthFlow, ApiError> {
    let _one = LINKING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(f) = authflow::list().into_iter().find(|f| f.kind == KIND && f.subject.as_deref() == Some(p.id.as_str()) && !f.state.is_final()) {
        return Ok(f);
    }
    let ctl = authflow::start(KIND, p.name.clone(), Some(p.id.clone()), LINK_TTL);
    ctl.update(|f| f.message = Some("Starting omp…".into()));
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["login", p.id.as_str()])
        .current_dir(home_dir())
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = shim {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&path))).unwrap_or(path);
        cmd.env("PATH", joined);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    match cmd.spawn() {
        Ok(child) => {
            tracing::info!(provider = %p.id, flow = ctl.id(), "account link started");
            let flow = ctl.snapshot();
            tokio::spawn(drive(ctl, child, p));
            Ok(flow)
        }
        Err(e) => {
            ctl.finish(AuthFlowState::Failed, Some(format!("couldn't start omp: {e}")));
            Ok(ctl.snapshot())
        }
    }
}

/// What the running login waits on.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Waits {
    Nothing,
    Prompt,
    Paste,
}

/// A submission whose verdict depends on what omp does next.
struct Pending {
    input: FlowInput,
    kind: Waits,
    /// The question answered (`Waits::Prompt`). omp's logins never ask one again (they fail), so
    /// another question is the next one and the answer was taken; this very one again refused it.
    asked: Option<AuthPrompt>,
    until: tokio::time::Instant,
}

struct Link {
    waits: Waits,
    redirect: Option<LoopbackRedirect>,
    pending: Option<Pending>,
    logged_in: Option<Option<String>>,
    nothing_stored: bool,
    failed: Option<String>,
    stderr: VecDeque<String>,
}

impl Link {
    fn new() -> Self {
        Self { waits: Waits::Nothing, redirect: None, pending: None, logged_in: None, nothing_stored: false, failed: None, stderr: VecDeque::new() }
    }

    fn settle(&mut self, verdict: Result<(), ApiError>) {
        if let Some(p) = self.pending.take() {
            p.input.reply(verdict);
        }
    }

    fn event(&mut self, ctl: &FlowCtl, ev: LoginEvent) {
        match ev {
            LoginEvent::Url(url) => {
                self.settle(Ok(()));
                self.redirect = ctl.publish_url(&url, None);
                ctl.update(|f| {
                    f.message = None;
                    f.user_code = None;
                });
            }
            LoginEvent::Instructions(line) => {
                self.settle(Ok(()));
                let code = user_code_in(&line);
                ctl.update(|f| {
                    if code.is_some() && f.user_code.is_none() {
                        f.user_code = code;
                    }
                    f.instructions = Some(match f.instructions.take() {
                        Some(prev) => format!("{prev}\n{line}"),
                        None => line,
                    });
                });
            }
            LoginEvent::Progress(line) => {
                self.settle(Ok(()));
                ctl.update(|f| f.message = Some(clip(&line, 300)));
            }
            LoginEvent::Prompt { message, placeholder } => {
                let again = self.pending.as_ref().is_some_and(|p| p.kind == Waits::Prompt && p.asked.as_ref().is_some_and(|a| a.message == message && a.placeholder == placeholder));
                self.settle(if again { Err(ApiError::new("invalid_params", "omp didn't accept that answer").with_hint("Check it and try again.")) } else { Ok(()) });
                self.waits = Waits::Prompt;
                let secret = is_secret_prompt(&message);
                ctl.update(|f| {
                    f.state = AuthFlowState::Waiting;
                    f.prompt = Some(AuthPrompt { message, placeholder, secret });
                });
            }
            LoginEvent::PastePrompt => {
                // omp asks for the paste again after one it couldn't use; an answer before it was taken.
                let again = self.pending.as_ref().is_some_and(|p| p.kind == Waits::Paste);
                self.settle(if again {
                    Err(ApiError::new("invalid_params", "that code isn't for this sign-in")
                        .with_hint("Paste the address the browser landed on after you approved this sign-in, or the code the provider shows."))
                } else {
                    Ok(())
                });
                self.waits = Waits::Paste;
                let fallback = self.redirect.is_some();
                ctl.update(|f| {
                    f.state = AuthFlowState::Waiting;
                    f.paste = if fallback { AuthPaste::Fallback } else { AuthPaste::Primary };
                });
            }
            LoginEvent::LoggedIn(who) => {
                self.settle(Ok(()));
                self.logged_in = Some(who);
            }
            LoginEvent::NothingStored => {
                self.settle(Ok(()));
                self.nothing_stored = true;
            }
        }
    }

    fn stderr_line(&mut self, line: &str) {
        let l = strip_ansi(line).trim().to_string();
        if l.is_empty() {
            return;
        }
        if let Some(msg) = l.strip_prefix(LOGIN_FAILED) {
            let msg = clip(msg, 400);
            self.settle(Err(ApiError::new("omp_error", msg.clone())));
            self.failed = Some(msg);
            return;
        }
        keep_tail(&mut self.stderr, &l);
    }

    async fn input(&mut self, ctl: &FlowCtl, input: FlowInput, stdin: &mut Option<ChildStdin>) {
        let text = input.text.trim().to_string();
        match self.waits {
            Waits::Prompt | Waits::Paste => {
                let kind = self.waits;
                if kind == Waits::Paste
                    && let Some(r) = &self.redirect
                    && let Err(e) = authflow::check_paste(r, &text)
                {
                    input.reply(Err(e));
                    return;
                }
                let Some(pipe) = stdin.as_mut() else {
                    input.reply(Err(ApiError::new("omp_error", "omp stopped reading input")));
                    return;
                };
                let line = format!("{}\n", text.replace(['\r', '\n'], ""));
                let written = async {
                    pipe.write_all(line.as_bytes()).await?;
                    pipe.flush().await
                }
                .await;
                if let Err(e) = written {
                    input.reply(Err(ApiError::new("omp_error", format!("omp stopped reading input: {e}"))));
                    return;
                }
                let asked = if kind == Waits::Prompt { ctl.snapshot().prompt } else { None };
                self.waits = Waits::Nothing;
                ctl.update(|f| {
                    f.prompt = None;
                    if kind == Waits::Paste {
                        f.paste = AuthPaste::None;
                    }
                    f.message = Some(if kind == Waits::Paste { "Checking the code…" } else { "Sent. Waiting for omp…" }.into());
                });
                self.pending = Some(Pending { input, kind, asked, until: tokio::time::Instant::now() + VERDICT_WAIT });
            }
            // omp reads no paste here (a provider without its paste prompt): deliver the address to
            // its callback server as the browser would have.
            Waits::Nothing => match &self.redirect {
                Some(r) => {
                    let verdict = authflow::replay_redirect(r, &text).await.and_then(|status| {
                        if status < 400 {
                            Ok(())
                        } else {
                            Err(ApiError::new("invalid_params", format!("the sign-in refused that address (HTTP {status})")).with_hint("Start the sign-in again."))
                        }
                    });
                    if verdict.is_ok() {
                        // Taken like a browser redirect: nothing more to paste, omp finishes now.
                        ctl.update(|f| {
                            f.paste = AuthPaste::None;
                            f.message = Some("Checking the code…".into());
                        });
                    }
                    input.reply(verdict);
                }
                None => input.reply(Err(ApiError::new("invalid_params", "omp isn't waiting for anything to paste right now"))),
            },
        }
    }

    /// A paste omp kept quiet about for [`VERDICT_WAIT`]: taken. The paste prompt comes back if a
    /// later look shows it wasn't.
    fn expire_pending(&mut self, ctl: &FlowCtl) {
        if self.pending.as_ref().is_some_and(|p| tokio::time::Instant::now() >= p.until) {
            self.settle(Ok(()));
            ctl.update(|f| f.message = Some("Finishing sign-in…".into()));
        }
    }

    fn finish(&mut self, ctl: &FlowCtl, code: Option<i32>) {
        if let Some(who) = self.logged_in.clone() {
            self.settle(Ok(()));
            ctl.update(|f| f.account = who.clone());
            let msg = match &who {
                Some(w) => format!("Linked {w}."),
                None => "Linked.".to_string(),
            };
            ctl.finish(AuthFlowState::Done, Some(msg));
            return;
        }
        let msg = if let Some(f) = self.failed.clone() {
            f
        } else if self.nothing_stored {
            "The sign-in finished without a credential to store.".to_string()
        } else if let Some(last) = self.stderr.back() {
            last.clone()
        } else {
            format!("omp login exited{}", code.map(|c| format!(" with code {c}")).unwrap_or_default())
        };
        self.settle(Err(ApiError::new("omp_error", msg.clone())));
        ctl.finish(AuthFlowState::Failed, Some(msg));
    }
}

enum Out {
    Stdout(Vec<u8>),
    Stderr(String),
}

async fn drive(mut ctl: FlowCtl, mut child: Child, p: LoginProvider) {
    let mut tree = TreeGuard(child.id());
    let mut stdin = child.stdin.take();
    let (tx, mut rx) = mpsc::channel::<Out>(64);
    if let Some(mut out) = child.stdout.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match out.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(Out::Stdout(buf[..n].to_vec())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send(Out::Stderr(l)).await.is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut parser = LoginParser::new(&p.name);
    let mut link = Link::new();
    let mut open = true;
    let started = Instant::now();
    let status = loop {
        let quiet = parser.has_partial();
        let verdict_at = link.pending.as_ref().map(|p| p.until);
        tokio::select! {
            out = rx.recv(), if open => match out {
                Some(Out::Stdout(bytes)) => {
                    for ev in parser.feed(&bytes) {
                        link.event(&ctl, ev);
                    }
                }
                Some(Out::Stderr(line)) => link.stderr_line(&line),
                None => open = false,
            },
            _ = tokio::time::sleep(PROMPT_QUIET), if quiet => {
                if let Some(ev) = parser.prompt() {
                    link.event(&ctl, ev);
                }
            }
            _ = tokio::time::sleep_until(verdict_at.unwrap_or_else(tokio::time::Instant::now)), if verdict_at.is_some() => link.expire_pending(&ctl),
            input = ctl.next_input() => match input {
                Some(input) => link.input(&ctl, input, &mut stdin).await,
                // Cancelled or expired: the guard kills omp (and its callback server).
                None => break None,
            },
            status = child.wait() => break Some(status),
        }
    };
    let Some(status) = status else {
        drop(tree);
        tracing::info!(provider = %p.id, "account link stopped: {:?}", ctl.snapshot().state);
        return;
    };
    // Exited: what it printed last may still be in the pipes.
    tree.0 = None;
    let drain = tokio::time::Instant::now() + Duration::from_millis(500);
    while open {
        match tokio::time::timeout_at(drain, rx.recv()).await {
            Ok(Some(Out::Stdout(bytes))) => {
                for ev in parser.feed(&bytes) {
                    link.event(&ctl, ev);
                }
            }
            Ok(Some(Out::Stderr(line))) => link.stderr_line(&line),
            _ => open = false,
        }
    }
    let code = status.ok().and_then(|s| s.code());
    if link.logged_in.is_some() {
        // Before the flow says `done`: the app reads the accounts and models again right then, and
        // must not get the caches from before the login.
        accounts_changed().await;
    }
    link.finish(&ctl, code);
    let state = ctl.snapshot().state;
    tracing::info!(provider = %p.id, ?state, code, secs = started.elapsed().as_secs(), "account link finished");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{LimitStatus, LimitWindow};

    /// `omp login anthropic` stdout (omp 18.13.2), until it waits for the callback or a paste.
    const ANTHROPIC: &[u8] = b"\nOpen this URL in your browser:\nhttps://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=5JDM&code_challenge_method=S256&state=616aa5416467d86b8d3942cf58406189&code=true\nLocal shortcut (this machine only): http://localhost:54545/launch\nComplete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.\n\nWaiting for browser authentication...\nPaste the authorization code (or full redirect URL): ";
    /// `omp login github-copilot` (device code, after a blank answer to its first question).
    const COPILOT_Q: &[u8] = b"GitHub Enterprise URL/domain (blank for github.com) (company.ghe.com): ";
    const COPILOT: &[u8] = b"\nOpen this URL in your browser:\nhttps://github.com/login/device\nEnter code: 6156-D061\n\n";
    /// `omp login deepseek` (API key), then the answer's validation.
    const DEEPSEEK: &[u8] = b"\nOpen this URL in your browser:\nhttps://platform.deepseek.com/api_keys\nCreate or copy your API key from the DeepSeek dashboard\n\nPaste your DeepSeek API key (sk-...): ";

    #[test]
    fn parses_a_browser_login() {
        let mut p = LoginParser::new("Anthropic (Claude Pro/Max)");
        let evs = p.feed(ANTHROPIC);
        let LoginEvent::Url(url) = &evs[0] else { panic!("{evs:?}") };
        assert!(url.starts_with("https://claude.ai/oauth/authorize?"));
        assert_eq!(authflow::loopback_redirect(url).unwrap().port, 54545);
        assert_eq!(evs[1], LoginEvent::Instructions("Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.".into()));
        assert_eq!(evs[2], LoginEvent::Progress("Waiting for browser authentication...".into()));
        assert_eq!(evs.len(), 3, "the local shortcut is not shown: it only works on the host");
        assert!(p.has_partial());
        assert_eq!(p.prompt(), Some(LoginEvent::PastePrompt));
        assert!(!p.has_partial());
        // What follows the answer starts a new line.
        assert_eq!(p.feed(b"Exchanging authorization code for tokens...\n"), vec![LoginEvent::Progress("Exchanging authorization code for tokens...".into())]);
        assert_eq!(
            p.feed(b"\nLogged in to Anthropic (Claude Pro/Max) as dev@example.com (Work)\nCredentials saved to /tmp/x/agent.db\n"),
            vec![LoginEvent::LoggedIn(Some("dev@example.com (Work)".into()))]
        );
    }

    #[test]
    fn parses_device_codes_and_questions() {
        let mut p = LoginParser::new("GitHub Copilot");
        assert!(p.feed(COPILOT_Q).is_empty());
        assert_eq!(
            p.prompt(),
            Some(LoginEvent::Prompt { message: "GitHub Enterprise URL/domain (blank for github.com)".into(), placeholder: Some("company.ghe.com".into()) })
        );
        let evs = p.feed(COPILOT);
        assert_eq!(evs, vec![LoginEvent::Url("https://github.com/login/device".into()), LoginEvent::Instructions("Enter code: 6156-D061".into())]);
        assert_eq!(user_code_in("Enter code: 6156-D061"), Some("6156-D061".into()));
        assert_eq!(user_code_in("Then type WDJB-MJHT on the page."), Some("WDJB-MJHT".into()));
        assert_eq!(user_code_in("Complete login in your browser."), None);
        assert!(!p.has_partial());
        assert_eq!(p.feed(b"\nLogged in to GitHub Copilot\n"), vec![LoginEvent::LoggedIn(None)]);
    }

    #[test]
    fn parses_api_key_prompts() {
        let mut p = LoginParser::new("DeepSeek");
        let evs = p.feed(DEEPSEEK);
        assert_eq!(evs[0], LoginEvent::Url("https://platform.deepseek.com/api_keys".into()));
        assert_eq!(evs[1], LoginEvent::Instructions("Create or copy your API key from the DeepSeek dashboard".into()));
        let Some(LoginEvent::Prompt { message, placeholder }) = p.prompt() else { panic!() };
        assert_eq!((message.as_str(), placeholder.as_deref()), ("Paste your DeepSeek API key", Some("sk-...")));
        assert!(is_secret_prompt(&message));
        assert!(!is_secret_prompt("GitHub Enterprise URL/domain (blank for github.com)"));
        assert_eq!(p.feed(b"Validating API key...\n"), vec![LoginEvent::Progress("Validating API key...".into())]);
        // A partial line that isn't a question stays buffered.
        assert!(p.feed(b"Exchanging aut").is_empty());
        assert_eq!(p.prompt(), None);
        assert_eq!(p.feed(b"horization code\n"), vec![LoginEvent::Progress("Exchanging authorization code".into())]);
        assert_eq!(p.feed(b"\x1b[33mNo credentials were stored for DeepSeek.\x1b[0m\n"), vec![LoginEvent::NothingStored]);
        assert_eq!(parse_prompt("Enter your account identifier:"), LoginEvent::Prompt { message: "Enter your account identifier".into(), placeholder: None });
    }

    #[test]
    fn logged_in_names_the_account() {
        assert_eq!(logged_in_as("Anthropic (Claude Pro/Max) as a@b.c (Org)", "Anthropic (Claude Pro/Max)"), Some("a@b.c (Org)".into()));
        assert_eq!(logged_in_as("Anthropic (Claude Pro/Max)", "Anthropic (Claude Pro/Max)"), None);
        assert_eq!(logged_in_as("Renamed provider as x@y.z", "Other"), Some("x@y.z".into()));
    }

    #[test]
    fn parses_the_provider_list() {
        let out = b"warn: something\n[{\"id\":\"openai-codex\",\"name\":\"ChatGPT Plus/Pro (Codex Subscription)\"},{\"id\":\"anthropic\",\"name\":\"Anthropic (Claude Pro/Max)\"},{\"id\":\"anthropic\",\"name\":\"dup\"},{\"name\":\"no id\"},{\"id\":\"x\"}]\n";
        let list = parse_providers(out).unwrap();
        assert_eq!(list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["openai-codex", "anthropic", "x"]);
        assert_eq!(list[2].name, "x");
        assert!(parse_providers(b"nothing").is_err());
    }

    #[test]
    fn rpc_responses_match_their_request() {
        assert_eq!(rpc_response(r#"{"id":"tf-logout","type":"response","command":"logout","success":true,"data":{}}"#, "tf-logout"), Some(Ok(())));
        assert_eq!(
            rpc_response(r#"{"id":"tf-logout","type":"response","command":"logout","success":false,"error":"Credential not found"}"#, "tf-logout"),
            Some(Err("Credential not found".into()))
        );
        assert_eq!(rpc_response(r#"{"type":"extension_ui_request","id":"tf-logout"}"#, "tf-logout"), None);
        assert_eq!(rpc_response(r#"{"id":"other","type":"response","success":true}"#, "tf-logout"), None);
        assert_eq!(rpc_response("not json", "tf-logout"), None);
    }

    // ── stored credentials ──

    /// omp's `auth_credentials` (sqlite-credential-store.ts, 18.13) with three accounts and a key,
    /// plus the MCP OAuth sign-ins omp keeps in the same table (not accounts).
    fn fixture_db(dir: &Path) -> PathBuf {
        let db = dir.join("agent.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            r#"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
               CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
               INSERT INTO auth_credentials VALUES (1, 'anthropic', 'oauth', '{"access":"SECRET-A","refresh":"SECRET-R","expires":1,"email":"Work@Example.com","accountId":"acc-a","orgId":"org-a","orgName":"Acme"}', NULL, 'email:work@example.com|org:org-a', 1700000000, 1700000100);
               INSERT INTO auth_credentials VALUES (2, 'anthropic', 'oauth', '{"access":"SECRET-B","email":"me@example.com","accountId":"acc-b","orgId":"org-b"}', NULL, 'email:me@example.com|org:org-b', 1700000200, 1700000200);
               INSERT INTO auth_credentials VALUES (3, 'anthropic', 'oauth', '{"access":"SECRET-C","email":"old@example.com","orgId":"org-o"}', 'oauth refresh failed: invalid_grant', 'email:old@example.com|org:org-o', 1600000000, 1600000000);
               INSERT INTO auth_credentials VALUES (4, 'anthropic', 'oauth', '{"access":"SECRET-D","email":"me@example.com","orgId":"org-b"}', 'replaced by newer credential', 'email:me@example.com|org:org-b', 1600000000, 1600000000);
               INSERT INTO auth_credentials VALUES (5, 'deepseek', 'api_key', '{"key":"sk-SECRET","source":"login"}', NULL, NULL, 1700000300, 1700000300);
               INSERT INTO auth_credentials VALUES (6, 'github-copilot', 'oauth', '{"access":"SECRET-G","accountId":"12345","enterpriseUrl":"github.com"}', NULL, 'account:12345', 1700000400, 1700000400);
               INSERT INTO auth_credentials VALUES (7, 'anthropic', 'oauth', '{"access":"SECRET-E","email":"gone@example.com"}', 'deleted by user', 'email:gone@example.com', 1, 1);
               INSERT INTO auth_credentials VALUES (8, 'mcp_oauth:profile:default:https://mcp.example.com/mcp', 'oauth', '{"access":"SECRET-M","refresh":"SECRET-MR","expires":1}', NULL, NULL, 1700000500, 1700000500);
               INSERT INTO auth_credentials VALUES (9, 'mcp_oauth_1700000600_abcdefghi', 'oauth', '{"access":"SECRET-L"}', NULL, NULL, 1700000600, 1700000600);
               INSERT INTO cache VALUES ('session:sticky:anthropic:s1', '{"type":"oauth","index":1,"credentialId":2}', 4102444800);"#,
        )
        .unwrap();
        db
    }

    #[test]
    fn reads_credentials_without_their_secrets() {
        let td = tempfile::tempdir().unwrap();
        let db = fixture_db(td.path());
        let rows = read_credentials(&db).unwrap();
        assert_eq!(rows.len(), 7, "MCP servers' sign-ins are no accounts");
        assert!(rows.iter().all(|r| !r.provider.starts_with("mcp_oauth")));
        let a = &rows[0];
        assert_eq!((a.id, a.provider.as_str(), a.oauth), (1, "anthropic", true));
        assert_eq!(a.email.as_deref(), Some("Work@Example.com"), "exact stored email");
        assert_eq!((a.account_id.as_deref(), a.org_id.as_deref(), a.org_name.as_deref()), (Some("acc-a"), Some("org-a"), Some("Acme")));
        assert_eq!(a.created_at, Some(1_700_000_000_000));
        assert_eq!(rows[2].disabled.as_deref(), Some("oauth refresh failed: invalid_grant"));
        let key = &rows[4];
        assert!(!key.oauth && key.email.is_none() && key.identity_key.is_none());
        let dbg = format!("{rows:?}");
        assert!(!dbg.contains("SECRET"), "no secret is read: {dbg}");
        // No store yet: no accounts.
        assert!(read_credentials(&td.path().join("missing.db")).unwrap().is_empty());
        let empty = td.path().join("empty.db");
        rusqlite::Connection::open(&empty).unwrap().execute_batch("CREATE TABLE other (x INTEGER);").unwrap();
        assert!(read_credentials(&empty).unwrap().is_empty());
    }

    fn window() -> LimitWindow {
        LimitWindow {
            id: "anthropic:5h".into(),
            label: "Claude 5 Hour".into(),
            window: Some("5 Hour".into()),
            tier: None,
            duration_ms: Some(18_000_000),
            resets_at: Some(1),
            used: Some(0.4),
            status: LimitStatus::Ok,
            amount: None,
            limit: None,
            unit: "percent".into(),
            notes: vec![],
            samples: vec![],
        }
    }

    fn usage_account(provider: &str, key: &str, label: &str, plan: Option<&str>) -> LimitAccount {
        LimitAccount {
            key: key.into(),
            provider: provider.into(),
            label: label.into(),
            org: None,
            plan: plan.map(str::to_string),
            fetched_at: Some(5),
            windows: vec![window()],
            resets_available: None,
            notes: vec![],
            error: None,
            disabled: false,
        }
    }

    fn providers() -> Vec<LoginProvider> {
        ["openai-codex", "anthropic", "github-copilot", "deepseek"].iter().map(|id| LoginProvider { id: id.to_string(), name: id.to_string() }).collect()
    }

    #[test]
    fn merges_store_usage_sessions_and_preferences() {
        let td = tempfile::tempdir().unwrap();
        let db = fixture_db(td.path());
        let rows = read_credentials(&db).unwrap();
        let usage = vec![
            usage_account("anthropic", "anthropic|email:work@example.com|org:org-a", "Work@Example.com", Some("max")),
            usage_account("openai-codex", "openai-codex|email:x@y.z", "x@y.z", Some("pro")),
        ];
        let idents = vec![
            Ident { email: Some("Work@Example.com".into()), account_id: Some("acc-a".into()), org_id: Some("org-a".into()), project_id: None },
            Ident { email: Some("x@y.z".into()), ..Default::default() },
        ];
        let live = vec![("s1".to_string(), "anthropic".to_string()), ("s2".to_string(), "github-copilot".to_string())];
        let sessions = sessions_per_credential(&db, &live, &rows);
        assert_eq!(sessions.get(&2), Some(&1), "pinned session");
        assert_eq!(sessions.get(&6), Some(&1), "single account of its provider");
        let policies = vec![json!({ "provider": "anthropic", "account": { "email": "me@example.com", "orgId": "org-b" }, "priority": 100 })];
        let out = merge(&rows, &usage, &idents, &sessions, &policies, &providers(), false);
        let keys: Vec<&str> = out.iter().map(|a| a.key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "openai-codex|email:x@y.z",
                "anthropic|email:me@example.com|org:org-b",
                "anthropic|email:work@example.com|org:org-a",
                "anthropic|email:old@example.com|org:org-o",
                "github-copilot|account:12345",
                "deepseek|#5"
            ],
            "provider order, preferred first, disabled last; quiet tombstones hidden"
        );
        let codex = &out[0];
        assert_eq!((codex.credential_id, codex.plan.as_deref()), (None, Some("pro")), "reported but not stored here");
        let me = &out[1];
        assert!(me.preferred && me.prefer_blocked.is_none());
        assert_eq!((me.sessions, me.label.as_str()), (1, "me@example.com"));
        let work = &out[2];
        assert_eq!((work.label.as_str(), work.org.as_deref(), work.plan.as_deref()), ("Work@Example.com", Some("Acme"), Some("max")));
        assert_eq!(work.windows.len(), 1);
        assert!(!work.preferred);
        let old = &out[3];
        assert!(old.disabled && old.disabled_reason.as_deref() == Some("oauth refresh failed: invalid_grant"));
        assert!(old.prefer_blocked.is_some());
        let gh = &out[4];
        assert_eq!(gh.label, "12345");
        let key = &out[5];
        assert_eq!((key.kind, key.label.as_str()), (CredentialKind::ApiKey, "API key #5"));
        assert!(key.prefer_blocked.is_some());
        // In a broker, nothing can be preferred from here.
        let brokered = merge(&rows, &usage, &idents, &sessions, &policies, &providers(), true);
        assert!(brokered.iter().all(|a| a.prefer_blocked.is_some()));
    }

    #[test]
    fn preferences_rewrite_only_what_they_own() {
        let work = Ident { email: Some("Work@Example.com".into()), account_id: Some("acc-a".into()), org_id: Some("org-a".into()), project_id: None };
        let other = json!({ "provider": "openai-codex", "account": { "email": "x@y.z" }, "priority": 100 });
        let reserve = json!({ "provider": "anthropic", "account": { "email": "Work@Example.com" }, "reservePct": 20 });
        let was = json!({ "provider": "anthropic", "account": { "email": "me@example.com" }, "priority": 100 });
        let next = apply_preference(&[other.clone(), reserve.clone(), was.clone()], "anthropic", &work, true);
        assert_eq!(
            next,
            vec![
                other.clone(),
                json!({ "provider": "anthropic", "account": { "email": "Work@Example.com" }, "reservePct": 20, "priority": 100.0 }),
            ],
            "the existing policy of the account gets the priority; the old preferred one (selector only) goes"
        );
        // Clearing removes only the priority.
        let cleared = apply_preference(&next, "anthropic", &work, false);
        assert_eq!(cleared, vec![other.clone(), reserve.clone()]);
        // No policy yet: a new one with the exact identity.
        let fresh = apply_preference(&[], "anthropic", &work, true);
        assert_eq!(fresh, vec![json!({ "provider": "anthropic", "account": { "email": "Work@Example.com", "accountId": "acc-a", "orgId": "org-a" }, "priority": 100.0 })]);
        assert!(selector_matches(&policy_selector(&fresh[0]), &work));
        // Hand-set lower priorities survive.
        let low = json!({ "provider": "anthropic", "account": { "email": "me@example.com" }, "priority": 5 });
        let kept = apply_preference(&[low.clone()], "anthropic", &work, true);
        assert_eq!(kept[0], low);
    }

    #[test]
    fn ambiguous_identities_cannot_be_preferred() {
        let a = CredRow { id: 1, provider: "openai-codex".into(), oauth: true, account_id: Some("team".into()), ..Default::default() };
        let b = CredRow { id: 2, provider: "openai-codex".into(), oauth: true, account_id: Some("team".into()), ..Default::default() };
        let c = CredRow { id: 3, provider: "openai-codex".into(), oauth: true, account_id: Some("team".into()), email: Some("c@x.y".into()), ..Default::default() };
        let active = [&a, &b, &c];
        assert!(prefer_blocked(&a, &active, false).unwrap().contains("same identity"));
        assert_eq!(prefer_blocked(&c, &active, false), None, "the email singles it out");
        let nobody = CredRow { id: 4, provider: "x".into(), oauth: true, org_id: Some("o".into()), ..Default::default() };
        assert!(prefer_blocked(&nobody, &[&nobody], false).is_some(), "an org alone is no base identity");
    }

    #[test]
    fn shows_only_the_newest_expiry_of_an_account() {
        // Expired, linked again, expired again: omp rewrites only active rows' causes, so both stay.
        let expired = |id: i64| CredRow {
            id,
            provider: "anthropic".into(),
            oauth: true,
            disabled: Some("oauth refresh failed: invalid_grant".into()),
            identity_key: Some("email:me@x.y|org:o".into()),
            email: Some("me@x.y".into()),
            org_id: Some("o".into()),
            created_at: Some(id * 1000),
            ..Default::default()
        };
        let other = CredRow { id: 4, provider: "anthropic".into(), oauth: true, identity_key: Some("email:you@x.y".into()), email: Some("you@x.y".into()), ..Default::default() };
        // omp's usage report lists the identity's disabled credential once.
        let report = LimitAccount { disabled: true, windows: vec![], ..usage_account("anthropic", "anthropic|email:me@x.y|org:o", "me@x.y", None) };
        let idents = [Ident { email: Some("me@x.y".into()), org_id: Some("o".into()), ..Default::default() }];
        let out = merge(&[expired(2), other.clone(), expired(7)], &[report], &idents, &HashMap::new(), &[], &providers(), false);
        let shown: Vec<(Option<i64>, bool)> = out.iter().map(|a| (a.credential_id, a.disabled)).collect();
        assert_eq!(shown, [(Some(4), false), (Some(7), true)], "one Re-link row, for the newest expiry");
        let keys: std::collections::HashSet<&str> = out.iter().map(|a| a.key.as_str()).collect();
        assert_eq!(keys.len(), out.len(), "unique keys: {out:?}");
        // Linked again: neither expiry shows.
        let again = CredRow { id: 9, disabled: None, ..expired(9) };
        let out = merge(&[expired(2), other, expired(7), again], &[], &[], &HashMap::new(), &[], &providers(), false);
        assert_eq!(out.iter().map(|a| (a.credential_id, a.disabled)).collect::<Vec<_>>(), [(Some(9), false), (Some(4), false)]);
    }

    // ── the link flow, against a scripted omp ──

    /// A stand-in `omp` (`login <provider>`): prints what omp prints, reads answers.
    fn fake_omp(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("omp");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn provider(id: &str, name: &str) -> LoginProvider {
        LoginProvider { id: id.into(), name: name.into() }
    }

    async fn until(flow_id: &str, pred: impl Fn(&AuthFlow) -> bool) -> AuthFlow {
        let mut rev = None;
        for _ in 0..100 {
            let f = authflow::wait(flow_id, rev, Some(200)).await.unwrap();
            if pred(&f) {
                return f;
            }
            rev = Some(f.rev);
        }
        panic!("flow never got there: {:?}", authflow::wait(flow_id, None, None).await.unwrap());
    }

    #[tokio::test]
    async fn browser_link_with_a_pasted_redirect() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake_omp(
            td.path(),
            r#"[ "$1 $2" = "login fake-oauth" ] || exit 9
printf '\nOpen this URL in your browser:\nhttps://auth.example/authorize?redirect_uri=http%%3A%%2F%%2Flocalhost%%3A1455%%2Fauth%%2Fcallback&state=st\nLocal shortcut (this machine only): http://localhost:1455/launch\nA browser window should open.\n\nWaiting for browser authentication...\n'
while :; do
  printf 'Paste the authorization code (or full redirect URL): '
  read -r answer || exit 1
  case "$answer" in *code=good*) break ;; esac
done
echo 'Exchanging authorization code for tokens...'
printf '\nLogged in to Fake OAuth as dev@example.com (Org)\nCredentials saved to /tmp/agent.db\n'"#,
        );
        let flow = start_link(&bin, provider("fake-oauth", "Fake OAuth"), None, &[]).unwrap();
        assert_eq!(flow.state, AuthFlowState::Starting);
        assert_eq!(flow.subject.as_deref(), Some("fake-oauth"));
        let id = flow.flow_id.clone();
        let waiting = until(&id, |f| f.message.as_deref() == Some("Waiting for browser authentication...")).await;
        // Let the paste question that follows it settle (it is recognised after a quiet moment).
        tokio::time::sleep(PROMPT_QUIET * 3).await;
        assert_eq!(waiting.paste, AuthPaste::Fallback);
        assert_eq!(waiting.state, AuthFlowState::Waiting);
        assert_eq!(waiting.callback_port, Some(1455));
        assert_eq!(waiting.redirect_uri.as_deref(), Some("http://localhost:1455/auth/callback"));
        assert_eq!(waiting.instructions.as_deref(), Some("A browser window should open."));
        // The same provider again: the running flow, not a second omp.
        assert_eq!(start_link(&bin, provider("fake-oauth", "Fake OAuth"), None, &[]).unwrap().flow_id, id);
        // Another sign-in's address is refused before omp sees it.
        let err = authflow::submit(&id, "http://localhost:54545/callback?code=x&state=y").await.unwrap_err();
        assert!(err.message.contains("port 1455"), "{err:?}");
        // A code omp rejects (it asks again) is reported.
        let err = authflow::submit(&id, "http://localhost:1455/auth/callback?code=bad&state=st").await.unwrap_err();
        assert_eq!(err.code, "invalid_params", "{err:?}");
        until(&id, |f| f.paste == AuthPaste::Fallback).await;
        // The right one completes it.
        authflow::submit(&id, "http://localhost:1455/auth/callback?code=good&state=st").await.unwrap();
        let done = until(&id, |f| f.state.is_final()).await;
        assert_eq!(done.state, AuthFlowState::Done, "{done:?}");
        assert_eq!(done.account.as_deref(), Some("dev@example.com (Org)"));
    }

    #[tokio::test]
    async fn device_link_with_a_question_first() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake_omp(
            td.path(),
            r#"printf 'GitHub Enterprise URL/domain (blank for github.com) (company.ghe.com): '
read -r domain || exit 1
[ -z "$domain" ] || exit 7
printf '\nOpen this URL in your browser:\nhttps://github.com/login/device\nEnter code: 6156-D061\n\n'
sleep 0.3
echo 'Enabling models...'
printf '\nLogged in to GitHub Copilot\n'"#,
        );
        let flow = start_link(&bin, provider("fake-device", "GitHub Copilot"), None, &[]).unwrap();
        let id = flow.flow_id.clone();
        let asked = until(&id, |f| f.prompt.is_some()).await;
        let q = asked.prompt.clone().unwrap();
        assert_eq!((q.placeholder.as_deref(), q.secret), (Some("company.ghe.com"), false));
        // An empty answer is a valid answer to a question.
        authflow::submit(&id, "").await.unwrap();
        let code = until(&id, |f| f.user_code.is_some()).await;
        assert_eq!(code.user_code.as_deref(), Some("6156-D061"));
        assert_eq!(code.url.as_deref(), Some("https://github.com/login/device"));
        assert_eq!((code.callback_port, code.paste), (None, AuthPaste::None), "nothing comes back to the host");
        let done = until(&id, |f| f.state.is_final()).await;
        assert_eq!(done.state, AuthFlowState::Done, "{done:?}");
        assert_eq!(done.account, None);
    }

    #[tokio::test]
    async fn questions_in_a_row_each_take_their_answer() {
        // Cloudflare AI Gateway's login (Workers AI, Perplexity's email login, Custom endpoints
        // alike): one question after the other, none asked again.
        let td = tempfile::tempdir().unwrap();
        let bin = fake_omp(
            td.path(),
            r#"printf 'Paste your Cloudflare API token: '
read -r token || exit 1
printf 'Cloudflare account ID: '
read -r account || exit 1
printf 'AI Gateway ID (default): '
read -r gateway || exit 1
[ "$token|$account|$gateway" = "tok|acc|gw" ] || exit 7
printf '\nLogged in to Cloudflare AI Gateway\n'"#,
        );
        let flow = start_link(&bin, provider("fake-gateway", "Cloudflare AI Gateway"), None, &[]).unwrap();
        let id = flow.flow_id.clone();
        for (question, secret, answer) in [("Paste your Cloudflare API token", true, "tok"), ("Cloudflare account ID", false, "acc"), ("AI Gateway ID", false, "gw")] {
            let asked = until(&id, |f| f.prompt.as_ref().is_some_and(|p| p.message == question)).await;
            assert_eq!(asked.prompt.unwrap().secret, secret, "{question}");
            authflow::submit(&id, answer).await.unwrap_or_else(|e| panic!("the answer to `{question}` was refused: {e:?}"));
        }
        let done = until(&id, |f| f.state.is_final()).await;
        assert_eq!(done.state, AuthFlowState::Done, "{done:?}");
    }

    #[tokio::test]
    async fn the_same_question_again_refuses_the_answer() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake_omp(
            td.path(),
            r#"printf 'Base URL (https://api.example.com): '
read -r url || exit 1
while [ "$url" != "https://ok.example" ]; do printf 'Base URL (https://api.example.com): '; read -r url || exit 1; done
printf 'Model ID: '
read -r model || exit 1
printf '\nLogged in to Example\n'"#,
        );
        let flow = start_link(&bin, provider("fake-custom", "Example"), None, &[]).unwrap();
        let id = flow.flow_id.clone();
        until(&id, |f| f.prompt.is_some()).await;
        let err = authflow::submit(&id, "https://nope.example").await.unwrap_err();
        assert_eq!((err.code.as_str(), err.message.as_str()), ("invalid_params", "omp didn't accept that answer"));
        let again = until(&id, |f| f.prompt.is_some()).await;
        assert_eq!(again.prompt.unwrap().message, "Base URL");
        authflow::submit(&id, "https://ok.example").await.unwrap();
        until(&id, |f| f.prompt.as_ref().is_some_and(|p| p.message == "Model ID")).await;
        authflow::submit(&id, "m1").await.unwrap();
        assert_eq!(until(&id, |f| f.state.is_final()).await.state, AuthFlowState::Done);
    }

    #[tokio::test]
    async fn failed_and_cancelled_links() {
        let td = tempfile::tempdir().unwrap();
        let bin = fake_omp(
            td.path(),
            r#"printf '\nOpen this URL in your browser:\nhttps://platform.example/keys\n\nPaste your Example API key (sk-...): '
read -r key || exit 1
echo 'Validating API key...'
sleep 0.3
echo 'Login failed: example API key validation failed (401)' >&2
exit 1"#,
        );
        let flow = start_link(&bin, provider("fake-key", "Example"), None, &[]).unwrap();
        let id = flow.flow_id.clone();
        let asked = until(&id, |f| f.prompt.is_some()).await;
        assert!(asked.prompt.unwrap().secret);
        // The key is taken (validation started), then omp fails the login.
        authflow::submit(&id, "sk-wrong").await.unwrap();
        let failed = until(&id, |f| f.state.is_final()).await;
        assert_eq!(failed.state, AuthFlowState::Failed);
        assert_eq!(failed.message.as_deref(), Some("example API key validation failed (401)"));

        // Cancelling kills omp (its callback server with it).
        let pidfile = td.path().join("pid");
        let bin = fake_omp(td.path(), &format!("echo $$ > {}\nprintf '\\nOpen this URL in your browser:\\nhttps://x.example/a\\n\\n'\nsleep 30", pidfile.display()));
        let flow = start_link(&bin, provider("fake-slow", "Slow"), None, &[]).unwrap();
        until(&flow.flow_id, |f| f.url.is_some()).await;
        let pid: i32 = std::fs::read_to_string(&pidfile).unwrap().trim().parse().unwrap();
        authflow::cancel(&flow.flow_id).unwrap();
        let mut gone = false;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            // SAFETY: signal 0 only checks that the process exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                gone = true;
                break;
            }
        }
        assert!(gone, "omp login was killed");
        assert_eq!(authflow::wait(&flow.flow_id, None, None).await.unwrap().state, AuthFlowState::Cancelled);
    }

    #[tokio::test]
    async fn logout_through_omp_rpc() {
        let td = tempfile::tempdir().unwrap();
        let log = td.path().join("request");
        let bin = fake_omp(
            td.path(),
            &format!(
                r#"read -r line; echo "$line" > {}; echo '{{"type":"extension_ui_request","id":"x","method":"notify"}}'; echo '{{"id":"tf-logout","type":"response","command":"logout","success":true,"data":{{}}}}'; sleep 5"#,
                log.display()
            ),
        );
        rpc_logout(&bin, "anthropic", 7, &[]).await.unwrap();
        let req: Value = serde_json::from_str(&std::fs::read_to_string(&log).unwrap()).unwrap();
        assert_eq!(req, json!({ "id": "tf-logout", "type": "logout", "providerId": "anthropic", "credentialId": 7 }));
        let bin = fake_omp(td.path(), r#"read -r line; echo '{"id":"tf-logout","type":"response","command":"logout","success":false,"error":"Credential 9 not found"}'"#);
        assert_eq!(rpc_logout(&bin, "anthropic", 9, &[]).await.unwrap_err().message, "Credential 9 not found");
    }

    #[tokio::test]
    async fn a_logout_omp_never_answers_reports_its_reason() {
        let td = tempfile::tempdir().unwrap();
        let dir = |name: &str| {
            let d = td.path().join(name);
            std::fs::create_dir(&d).unwrap();
            d
        };
        // omp 18.13.2 in a home without credentials refuses to start.
        let bin = fake_omp(
            &dir("nomodel"),
            r#"read -r line; echo 'warn: telemetry off' >&2; echo 'No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.' >&2; exit 1"#,
        );
        let err = rpc_logout(&bin, "anthropic", 7, &[]).await.unwrap_err();
        assert_eq!(err.message, "No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.");
        assert_eq!(err.hint, None, "no advice to update omp");
        // Its error line, not the hint printed after it (colors stripped).
        let bin = fake_omp(&dir("config"), r#"printf '\033[31mError: Invalid config.yml: auth.accountPolicies[0] has an unknown field\033[0m\n\033[2mFix the file and try again.\033[0m\n' >&2; exit 1"#);
        assert_eq!(rpc_logout(&bin, "anthropic", 7, &[]).await.unwrap_err().message, "Error: Invalid config.yml: auth.accountPolicies[0] has an unknown field");
        // Nothing said: its exit code.
        let bin = fake_omp(&dir("silent"), "exit 3");
        assert_eq!(rpc_logout(&bin, "anthropic", 7, &[]).await.unwrap_err().message, "omp exited with code 3 without answering the logout");
    }
}
