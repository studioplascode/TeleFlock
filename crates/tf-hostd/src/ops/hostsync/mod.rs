//! `hostSync.*`: make this host like another one (architecture §3.24, wire types
//! `tf_proto::hostsync`).
//!
//! - **Export** (`hostSync.export`, on the source): omp's global config layer as written
//!   (`omp config list --scope global`, omp ≥ 18.13.3; credentials redacted by omp), its user-level
//!   MCP servers (secrets masked, `ops/mcp/sync.rs`) and the sign-ins `omp auth export` carries,
//!   by identity only. Nothing secret.
//! - **Plan** (`hostSync.plan`, on the target): the differences with this host (`plan.rs`).
//! - **Secrets** travel only when the user picks them, sealed end to end: the target makes a
//!   one-time X25519 key (`hostSync.keyBegin`), the source seals what was picked to it
//!   (`hostSync.seal`: the chosen `omp auth export` entries, MCP servers' stored entries, credential
//!   settings' values), the app relays the ciphertext, and only the target's key opens it, once
//!   (`seal.rs`).
//! - **Apply** (`hostSync.apply`, on the target): the plan again, then the chosen items through the
//!   host's own write paths: `omp auth import -` (stdin), `omp config set|reset` and the companion
//!   extension's settings-write mode for credentials (`omp_config::OmpAt::set_each`), omp's MCP
//!   files under omp's lock (`mcp::sync`), then `/mcp reload` in running sessions.
//!
//! Logs carry item ids (setting keys, role and server names, providers), counts and outcomes,
//! never a value of a secret item.

mod plan;
mod seal;
mod signins;
#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Instant;

use serde_json::{Map, Value};
use tf_proto::{
    ApiError, HostMethod, McpReload, OmpSettingChange, OmpSettings, SyncApplied, SyncApplyParams, SyncChange, SyncItem, SyncItemResult, SyncPlan,
    SyncProfile, SyncSealParams, SyncSealed, SyncSection, SyncSetting,
};
use zeroize::Zeroizing;

use crate::clients::ClientHandle;
use crate::ops::mcp::sync::UserMcp;
use crate::ops::omp_config::OmpAt;
use crate::ops::{to_value, Ctx};
use crate::util::now_ms;
use plan::{Here, CHAINS_KEY, ROLES_KEY};
use seal::Keys;
use signins::AUTH_TIMEOUT;

/// The first omp whose `config list --scope global` lists the global layer as written.
const MIN_OMP: (u32, u32, u32) = (18, 13, 3);

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    let host = Live::new(ctx)?;
    match req {
        HostMethod::HostSyncExport(_) => to_value(export(&host).await?),
        HostMethod::HostSyncPlan(p) => to_value(plan_for(&host, &p.source).await?),
        HostMethod::HostSyncKeyBegin(_) => to_value(seal::KEYS.begin(Instant::now(), now_ms())?),
        HostMethod::HostSyncSeal(p) => to_value(seal_secrets(&host, p).await?),
        HostMethod::HostSyncApply(p) => to_value(apply(&host, &seal::KEYS, p).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not a hostSync method", other.name()))),
    }
}

/// What changed on this host, for [`Host::after`].
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct Changed {
    pub sign_ins: bool,
    pub mcp: bool,
}

/// What `hostSync` reads and writes on a host: the daemon's ([`Live`]), or a test's.
pub(crate) trait Host: Sync {
    /// omp's settings (schema: types, labels, credential flags; omp's version).
    fn settings(&self) -> impl Future<Output = Result<OmpSettings, ApiError>> + Send;
    /// omp's global config layer as written.
    fn global_layer(&self) -> impl Future<Output = Result<Vec<(String, Value)>, ApiError>> + Send;
    /// `omp config get <key> --json` of a credential setting (wiped when dropped).
    fn setting_value(&self, key: &str) -> impl Future<Output = Result<Zeroizing<Vec<u8>>, ApiError>> + Send;
    /// Writes in order, one outcome per change.
    fn set_settings(&self, changes: &[OmpSettingChange]) -> impl Future<Output = Vec<Result<(), ApiError>>> + Send;
    /// `omp auth export`: Ok(stdout) on success, Err(omp's message) when omp refuses (an auth broker).
    fn auth_export(&self) -> impl Future<Output = Result<Result<Zeroizing<Vec<u8>>, String>, ApiError>> + Send;
    /// `omp auth import -` with `doc` on stdin; omp's summary.
    fn auth_import(&self, doc: &[u8]) -> impl Future<Output = Result<String, ApiError>> + Send;
    fn mcp(&self) -> &UserMcp;
    /// Models this host's omp offers (`provider/id`); `None` when it can't tell.
    fn models(&self) -> impl Future<Output = Option<HashSet<String>>> + Send;
    /// After changes: running sessions reload their MCP servers; caches that knew the old state go.
    fn after(&self, changed: Changed) -> impl Future<Output = Option<McpReload>> + Send;
}

/// The daemon's host.
struct Live<'a> {
    ctx: &'a Ctx,
    omp: OmpAt,
    mcp: UserMcp,
}

impl<'a> Live<'a> {
    fn new(ctx: &'a Ctx) -> Result<Live<'a>, ApiError> {
        Ok(Live { ctx, omp: OmpAt::from_ctx(ctx)?, mcp: UserMcp::from_ctx(ctx) })
    }
}

impl Host for Live<'_> {
    async fn settings(&self) -> Result<OmpSettings, ApiError> {
        self.omp.settings().await
    }

    async fn global_layer(&self) -> Result<Vec<(String, Value)>, ApiError> {
        self.omp.global_layer().await
    }

    async fn setting_value(&self, key: &str) -> Result<Zeroizing<Vec<u8>>, ApiError> {
        self.omp.value(key).await
    }

    async fn set_settings(&self, changes: &[OmpSettingChange]) -> Vec<Result<(), ApiError>> {
        self.omp.set_each(changes).await
    }

    async fn auth_export(&self) -> Result<Result<Zeroizing<Vec<u8>>, String>, ApiError> {
        let (ok, out, err) = signins::run_omp(self.omp.bin(), &["auth", "export"], &self.omp.env(), None, AUTH_TIMEOUT).await?;
        Ok(if ok { Ok(out) } else { Err(signins::omp_error(&err)) })
    }

    async fn auth_import(&self, doc: &[u8]) -> Result<String, ApiError> {
        let (ok, _, err) = signins::run_omp(self.omp.bin(), &["auth", "import", "-"], &self.omp.env(), Some(doc), AUTH_TIMEOUT).await?;
        if ok { Ok(err.trim().to_string()) } else { Err(ApiError::new("omp_error", format!("omp auth import: {}", signins::omp_error(&err)))) }
    }

    fn mcp(&self) -> &UserMcp {
        &self.mcp
    }

    async fn models(&self) -> Option<HashSet<String>> {
        crate::ops::host::models().await.ok().map(|c| c.models.iter().map(|m| format!("{}/{}", m.provider, m.id)).collect())
    }

    async fn after(&self, changed: Changed) -> Option<McpReload> {
        if changed.sign_ins {
            // New sign-ins bring their providers' models and quota windows.
            crate::ops::limits::invalidate().await;
            crate::ops::host::invalidate_models().await;
        }
        if changed.mcp { Some(crate::ops::mcp::sync::reload_sessions(self.ctx).await) } else { None }
    }
}

// ───────────────────────────── export ─────────────────────────────

fn too_old(version: &str) -> Option<ApiError> {
    let v = crate::ops::host::parse_version(version)?;
    (v < MIN_OMP).then(|| {
        ApiError::new("unsupported", format!("omp {version} on this host can't list its global config on its own; omp 18.13.3 can."))
            .with_hint("Update omp on this host (Hosts › Tools › Update), then try again.")
    })
}

/// This host's profile: nothing secret.
pub(crate) async fn export<H: Host>(host: &H) -> Result<SyncProfile, ApiError> {
    let settings = host.settings().await?;
    if let Some(e) = too_old(&settings.version) {
        return Err(e);
    }
    let (layer, auth, mcp) = tokio::join!(host.global_layer(), host.auth_export(), host.mcp().servers());
    let schema: HashMap<&str, &tf_proto::OmpSetting> = settings.settings.iter().map(|s| (s.id.as_str(), s)).collect();
    let settings_out = layer?
        .into_iter()
        .map(|(key, entry)| {
            let def = schema.get(key.as_str()).copied();
            // omp redacts a credential that holds a value; an empty one is just empty.
            let empty = entry.get("value").is_none_or(|v| v.is_null() || v.as_str() == Some(""));
            let secret = entry.get("redacted").and_then(Value::as_bool).unwrap_or(false) || (def.is_some_and(|d| d.credential) && !empty);
            SyncSetting {
                kind: entry.get("type").and_then(Value::as_str).map(str::to_string).or_else(|| def.map(|d| d.kind.clone())).unwrap_or_else(|| "string".into()),
                value: if secret { None } else { entry.get("value").cloned() },
                secret,
                label: def.and_then(|d| d.label.clone()),
                tab: def.and_then(|d| d.tab.clone()),
                group: def.and_then(|d| d.group.clone()),
                key,
            }
        })
        .collect();
    let (sign_ins, sign_ins_note) = match auth? {
        Ok(out) => match signins::list(&out) {
            Ok(list) => (list, None),
            Err(e) => (vec![], Some(e.message)),
        },
        Err(refused) => (vec![], Some(refused)),
    };
    let (mut mcp, mcp_note) = mcp?;
    for s in &mut mcp {
        // An OAuth credential omp keeps for its URL counts as signed in too.
        s.signed_in |= s.server.url.as_deref().is_some_and(|u| sign_ins.iter().any(|si| si.mcp_url.as_deref() == Some(u)));
    }
    Ok(SyncProfile { omp_version: settings.version, settings: settings_out, mcp, sign_ins, sign_ins_note, mcp_note })
}

// ───────────────────────────── plan ─────────────────────────────

/// The plan for `source` against this host as it is now; also this host's profile.
async fn plan_against<H: Host>(host: &H, source: &SyncProfile) -> Result<(SyncPlan, SyncProfile), ApiError> {
    let (profile, settings, models) = tokio::join!(export(host), host.settings(), host.models());
    let (profile, settings) = (profile?, settings?);
    let mut unfillable = HashMap::new();
    for s in source.mcp.iter().filter(|s| s.secrets) {
        unfillable.insert(s.name.clone(), host.mcp().unfillable(&s.name, &s.server).await?);
    }
    let here = Here { profile: &profile, known: settings.settings.iter().map(|s| (s.id.as_str(), s)).collect(), models, unfillable };
    let plan = plan::plan(source, &here);
    Ok((plan, profile))
}

async fn plan_for<H: Host>(host: &H, source: &SyncProfile) -> Result<SyncPlan, ApiError> {
    Ok(plan_against(host, source).await?.0)
}

// ───────────────────────────── seal (source) ─────────────────────────────

/// The secret items' ids split by kind.
#[derive(Default)]
struct Secrets {
    sign_ins: HashSet<String>,
    mcp: Vec<String>,
    settings: Vec<String>,
}

fn split_secrets(ids: &[String]) -> Result<Secrets, ApiError> {
    let mut s = Secrets::default();
    for id in ids {
        match id.split_once(':') {
            Some(("signIn", rest)) if !rest.is_empty() => {
                s.sign_ins.insert(rest.to_string());
            }
            Some(("mcpSecrets", name)) if !name.is_empty() => s.mcp.push(name.to_string()),
            Some(("setting", key)) if !key.is_empty() => s.settings.push(key.to_string()),
            _ => return Err(ApiError::new("invalid_params", format!("`{id}` is not a secret item"))),
        }
    }
    Ok(s)
}

fn is_transfer_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Seals the chosen secrets of this (the source) host to the target's one-time key.
async fn seal_secrets<H: Host>(host: &H, p: SyncSealParams) -> Result<SyncSealed, ApiError> {
    if !is_transfer_id(&p.transfer_id) {
        return Err(ApiError::new("invalid_params", "transferId: not a transfer of hostSync.keyBegin"));
    }
    let mut items = p.items.clone();
    items.sort();
    items.dedup();
    if items.is_empty() {
        return Err(ApiError::new("invalid_params", "items: nothing to seal"));
    }
    let wanted = split_secrets(&items)?;
    let mut bundle = Map::new();
    if !wanted.sign_ins.is_empty() {
        let export = host.auth_export().await?.map_err(|m| ApiError::new("unsupported", format!("Sign-ins can't be copied from this host: {m}")))?;
        let (doc, found) = signins::select(&export, &wanted.sign_ins)?;
        if found.len() < wanted.sign_ins.len() {
            return Err(ApiError::new("not_found", "A chosen sign-in is no longer on this host.").with_hint("Compare the hosts again."));
        }
        let mut parsed: Value = serde_json::from_slice(&doc).map_err(|e| ApiError::new("internal", e.to_string()))?;
        bundle.insert("signIns".into(), parsed.take());
        signins::wipe(&mut parsed);
    }
    if !wanted.mcp.is_empty() {
        let mut servers = Map::new();
        for name in &wanted.mcp {
            let entry = host.mcp().stored_entry(name).await?.ok_or_else(|| ApiError::new("not_found", format!("No MCP server “{name}” on this host any more.")))?;
            servers.insert(name.clone(), Value::String(entry.to_string()));
        }
        bundle.insert("mcp".into(), Value::Object(servers));
    }
    if !wanted.settings.is_empty() {
        let layer = host.global_layer().await?;
        let mut values = Map::new();
        for key in &wanted.settings {
            let redacted = layer.iter().any(|(k, e)| k == key && e.get("redacted").and_then(Value::as_bool) == Some(true));
            if !redacted {
                return Err(ApiError::new("invalid_params", format!("`{key}` is not a credential set in this host's omp config")));
            }
            let raw = host.setting_value(key).await?;
            let mut got: Value = serde_json::from_slice(&raw).map_err(|e| ApiError::new("omp_error", format!("omp config get {key}: {e}")))?;
            let value = got.get_mut("value").map(Value::take).filter(|v| !v.is_null()).ok_or_else(|| ApiError::new("not_found", format!("`{key}` has no value on this host any more")))?;
            signins::wipe(&mut got);
            values.insert(key.clone(), value);
        }
        bundle.insert("settings".into(), Value::Object(values));
    }
    let mut bundle = Value::Object(bundle);
    let plaintext = Zeroizing::new(serde_json::to_vec(&bundle).map_err(|e| ApiError::new("internal", e.to_string()))?);
    signins::wipe(&mut bundle);
    let sealed = seal::seal(&p.public_key, &p.transfer_id, items, &plaintext)?;
    tracing::info!(items = sealed.items.len(), transfer = &p.transfer_id[..8], "hostSync: sealed secrets for another host");
    Ok(sealed)
}

// ───────────────────────────── apply (target) ─────────────────────────────

/// The opened secrets: what each sealed item holds.
#[derive(Default)]
struct Bundle {
    /// An `omp auth export` document of the chosen sign-ins.
    sign_ins: Option<Zeroizing<Vec<u8>>>,
    /// MCP server name → its stored entry on the source (compact JSON).
    mcp: HashMap<String, Zeroizing<String>>,
    /// Credential setting → its value.
    settings: HashMap<String, Value>,
}

impl Drop for Bundle {
    fn drop(&mut self) {
        self.settings.values_mut().for_each(signins::wipe);
    }
}

impl Bundle {
    fn open(plaintext: &[u8]) -> Result<Bundle, ApiError> {
        let mut v: Value = serde_json::from_slice(plaintext).map_err(|_| ApiError::new("sealed_invalid", "The sealed secrets are not readable. Nothing was applied."))?;
        let mut b = Bundle::default();
        if let Some(doc) = v.get_mut("signIns").filter(|d| !d.is_null()) {
            b.sign_ins = Some(Zeroizing::new(serde_json::to_vec(doc).unwrap_or_default()));
        }
        if let Some(Value::Object(servers)) = v.get("mcp") {
            for (name, entry) in servers {
                if let Some(text) = entry.as_str() {
                    b.mcp.insert(name.clone(), Zeroizing::new(text.to_string()));
                }
            }
        }
        if let Some(Value::Object(values)) = v.get_mut("settings") {
            for (key, value) in values.iter_mut() {
                b.settings.insert(key.clone(), value.take());
            }
        }
        signins::wipe(&mut v);
        Ok(b)
    }
}

fn ok(id: &str, note: Option<String>) -> SyncItemResult {
    SyncItemResult { id: id.to_string(), ok: true, error: None, note }
}

fn failed(id: &str, error: impl Into<String>) -> SyncItemResult {
    SyncItemResult { id: id.to_string(), ok: false, error: Some(error.into()), note: None }
}

fn message(e: &ApiError) -> String {
    match &e.hint {
        Some(h) => format!("{} {h}", e.message),
        None => e.message.clone(),
    }
}

/// `role → value` entries of a record in this host's global layer, in written order.
fn record_of(profile: &SyncProfile, key: &str) -> Vec<(String, Value)> {
    profile.settings.iter().find(|s| s.key == key).and_then(|s| s.value.as_ref()).and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
}

fn put_entry(rec: &mut Vec<(String, Value)>, key: &str, value: Option<&Value>) {
    match (rec.iter().position(|(k, _)| k == key), value) {
        (Some(i), Some(v)) => rec[i].1 = v.clone(),
        (Some(i), None) => {
            rec.remove(i);
        }
        (None, Some(v)) => rec.push((key.to_string(), v.clone())),
        (None, None) => {}
    }
}

/// A record setting's write: its new value, or a reset when it ends up empty.
fn record_change(key: &str, rec: Vec<(String, Value)>) -> OmpSettingChange {
    let value = (!rec.is_empty()).then(|| Value::Object(rec.into_iter().collect()));
    OmpSettingChange { key: key.to_string(), value }
}

/// Opens `sealed` with its one-time key, which is taken out whatever happens next, once its items
/// are among the `wanted` ones and cover every chosen secret.
fn open_box(keys: &Keys, sealed: &SyncSealed, wanted: &[&str], secret_ids: &BTreeSet<&str>) -> Result<Bundle, ApiError> {
    let pair = keys.take(&sealed.transfer_id, Instant::now())?;
    let sealed_ids: BTreeSet<&str> = sealed.items.iter().map(String::as_str).collect();
    if !sealed_ids.iter().all(|id| wanted.contains(id)) || !secret_ids.is_subset(&sealed_ids) {
        return Err(ApiError::new("sealed_invalid", "The sealed secrets hold other items than the ones chosen. Nothing was applied.").with_hint("Start the copy again."));
    }
    Bundle::open(&seal::open(pair, sealed)?)
}

/// Applies the chosen items of `source`'s plan to this (the target) host.
pub(crate) async fn apply<H: Host>(host: &H, keys: &Keys, p: SyncApplyParams) -> Result<SyncApplied, ApiError> {
    let (plan, here) = plan_against(host, &p.source).await?;
    let by_id: HashMap<&str, &SyncItem> = plan.items.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut wanted: Vec<&str> = Vec::new();
    for id in &p.items {
        if !wanted.contains(&id.as_str()) {
            wanted.push(id);
        }
    }
    let mut results: HashMap<String, SyncItemResult> = HashMap::new();
    let mut chosen: Vec<&SyncItem> = Vec::new();
    for id in &wanted {
        match by_id.get(id) {
            None => {
                results.insert(id.to_string(), failed(id, "Not a difference between the hosts any more: compare them again."));
            }
            Some(it) if it.change == SyncChange::Same => {
                results.insert(id.to_string(), ok(id, Some("Already the same.".into())));
            }
            Some(it) if it.change == SyncChange::Unsupported => {
                results.insert(id.to_string(), failed(id, it.notes.first().cloned().unwrap_or_else(|| "Not possible on this host.".into())));
            }
            Some(it) => chosen.push(it),
        }
    }
    // What was sealed must be what this request chose; what is still secret must be in it.
    let secret_ids: BTreeSet<&str> = chosen.iter().filter(|i| i.secret).map(|i| i.id.as_str()).collect();
    let bundle = match &p.sealed {
        None if secret_ids.is_empty() => Bundle::default(),
        None => return Err(ApiError::new("invalid_params", "sealed: the chosen secrets must be sealed by the other host (hostSync.seal)")),
        Some(sealed) => open_box(keys, sealed, &wanted, &secret_ids).inspect_err(|e| {
            let transfer = if is_transfer_id(&sealed.transfer_id) { &sealed.transfer_id[..8] } else { "?" };
            tracing::warn!(code = %e.code, items = sealed.items.len(), transfer, "hostSync: refused sealed secrets from another host; nothing applied");
        })?,
    };
    let mut changed = Changed::default();

    // 1. Sign-ins first: roles may name their providers' models.
    let sign_ins: Vec<&SyncItem> = chosen.iter().copied().filter(|i| i.section == SyncSection::SignIns).collect();
    if !sign_ins.is_empty() {
        let ids: HashSet<String> = sign_ins.iter().map(|i| i.id.trim_start_matches("signIn:").to_string()).collect();
        let outcome = match &bundle.sign_ins {
            None => Err("The other host sealed no sign-in.".to_string()),
            Some(doc) => match signins::select(doc, &ids) {
                Ok((doc, found)) if found.len() == ids.len() => host.auth_import(&doc).await.map_err(|e| message(&e)),
                Ok(_) => Err("The other host sealed other sign-ins than the ones chosen.".to_string()),
                Err(e) => Err(message(&e)),
            },
        };
        changed.sign_ins = outcome.is_ok();
        for it in &sign_ins {
            results.insert(it.id.clone(), match &outcome {
                Ok(_) => ok(&it.id, None),
                Err(e) => failed(&it.id, e.clone()),
            });
        }
    }

    // 2. Settings, one write each; then 3. roles: this host's records with the chosen roles taken
    // from the source (two record writes at most).
    let mut ids: Vec<&str> = Vec::new();
    let mut writes: Vec<OmpSettingChange> = Vec::new();
    for it in chosen.iter().filter(|i| i.section == SyncSection::Settings) {
        let key = it.id.trim_start_matches("setting:");
        let value = if it.change == SyncChange::Remove {
            None
        } else if it.secret {
            match bundle.settings.get(key) {
                Some(v) => Some(v.clone()),
                None => {
                    results.insert(it.id.clone(), failed(&it.id, "The other host sealed no value for it."));
                    continue;
                }
            }
        } else {
            it.from.clone()
        };
        ids.push(&it.id);
        writes.push(OmpSettingChange { key: key.to_string(), value });
    }
    let settings_count = writes.len();
    let roles: Vec<&SyncItem> = chosen.iter().copied().filter(|i| i.section == SyncSection::Roles).collect();
    if !roles.is_empty() {
        let (mut models, mut chains) = (record_of(&here, ROLES_KEY), record_of(&here, CHAINS_KEY));
        let (models0, chains0) = (models.clone(), chains.clone());
        for it in &roles {
            let role = it.id.trim_start_matches("role:");
            let from = it.from.as_ref();
            put_entry(&mut models, role, from.and_then(|f| f.get("model")));
            put_entry(&mut chains, role, from.and_then(|f| f.get("fallbacks")));
        }
        if models != models0 {
            writes.push(record_change(ROLES_KEY, models));
        }
        if chains != chains0 {
            writes.push(record_change(CHAINS_KEY, chains));
        }
    }
    let outcomes = if writes.is_empty() { Vec::new() } else { host.set_settings(&writes).await };
    for (i, id) in ids.iter().enumerate() {
        results.insert(id.to_string(), match outcomes.get(i) {
            Some(Ok(())) => ok(id, None),
            Some(Err(e)) => failed(id, message(e)),
            None => failed(id, "Not written."),
        });
    }
    let role_error = outcomes.get(settings_count..).unwrap_or_default().iter().find_map(|r| r.as_ref().err());
    for it in &roles {
        results.insert(it.id.clone(), match role_error {
            None => ok(&it.id, it.notes.iter().find(|n| n.starts_with("Not available")).cloned()),
            Some(e) => failed(&it.id, message(e)),
        });
    }
    writes.iter_mut().filter_map(|w| w.value.as_mut()).for_each(signins::wipe);

    // 4. MCP servers (user level).
    for it in chosen.iter().filter(|i| i.section == SyncSection::Mcp) {
        let (kind, name) = it.id.split_once(':').unwrap_or_default();
        let secrets_id = format!("mcpSecrets:{name}");
        let with_secrets = chosen.iter().any(|i| i.id == secrets_id);
        let result = match (kind, it.change) {
            ("mcp", SyncChange::Remove) => host.mcp().delete(name).await.map(|()| None),
            ("mcp", _) | ("mcpSecrets", _) => {
                let definition = by_id.get(format!("mcp:{name}").as_str()).copied();
                if kind == "mcpSecrets" && wanted.contains(&format!("mcp:{name}").as_str()) && definition.is_some_and(|d| d.change != SyncChange::Same) {
                    // Applied with the definition.
                    continue;
                }
                let source = p.source.mcp.iter().find(|s| s.name == name);
                match (definition, source) {
                    (Some(d), Some(s)) if kind == "mcp" || d.change == SyncChange::Same => {
                        let sealed = if with_secrets { bundle.mcp.get(name).cloned() } else { None };
                        if with_secrets && sealed.is_none() {
                            Err(ApiError::new("not_found", "The other host sealed no secrets for it."))
                        } else {
                            host.mcp().put(name, &s.server, s.enabled, sealed).await.map(|put| {
                                (!put.emptied.is_empty()).then(|| format!("Left empty here: {}. Copy its secrets, or enter them on the MCP page.", put.emptied.join(", ")))
                            })
                        }
                    }
                    _ => Err(ApiError::new("invalid_params", "Its secrets are copied with the server: choose the server too.")),
                }
            }
            _ => Err(ApiError::new("invalid_params", "unknown item")),
        };
        changed.mcp |= result.is_ok();
        let res = match result {
            Ok(note) => ok(&it.id, note),
            Err(e) => failed(&it.id, message(&e)),
        };
        if kind == "mcp" && with_secrets {
            results.insert(secrets_id.clone(), SyncItemResult { id: secrets_id, ..res.clone() });
        }
        results.insert(it.id.clone(), res);
    }
    drop(bundle);

    let mcp_reload = host.after(changed).await;
    let fresh = plan_for(host, &p.source).await.unwrap_or_else(|e| {
        tracing::warn!("hostSync: reading the plan again after applying: {}", e.message);
        plan.clone()
    });
    let results: Vec<SyncItemResult> = wanted.iter().filter_map(|id| results.remove(*id)).collect();
    let failures = results.iter().filter(|r| !r.ok).count();
    for r in &results {
        tracing::info!(id = %r.id, ok = r.ok, "hostSync: item");
    }
    tracing::info!(applied = results.len() - failures, failed = failures, secrets = secret_ids.len(), "hostSync: applied changes from another host");
    Ok(SyncApplied { results, plan: fresh, mcp_reload })
}
