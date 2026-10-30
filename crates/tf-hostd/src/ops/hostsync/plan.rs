//! The differences between a source profile and this host (`hostSync.plan`, and again inside
//! `hostSync.apply`). Pure: the caller reads this host's state.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};
use tf_proto::{OmpSetting, SyncChange, SyncItem, SyncPlan, SyncProfile, SyncSection, SyncSetting, SyncSignInKind};

/// omp's model roles (`role → model`) and their fallback chains (`role → [model]`): the roles section.
pub const ROLES_KEY: &str = "modelRoles";
pub const CHAINS_KEY: &str = "retry.fallbackChains";
/// Arrays whose entries may be `{path, …}` (scoped to a folder of the host that wrote them).
const PATH_SCOPED: [&str; 3] = ["enabledModels", "enabledProviders", "disabledProviders"];
const THINKING: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// What this host knows besides its profile.
pub struct Here<'a> {
    pub profile: &'a SyncProfile,
    /// Its omp's settings by key (schema).
    pub known: HashMap<&'a str, &'a OmpSetting>,
    /// Models its omp offers (`provider/id`); `None` when they couldn't be listed.
    pub models: Option<HashSet<String>>,
    /// Per source MCP server with secrets: the masked values this host can't fill from its own
    /// definition (empty: it can).
    pub unfillable: HashMap<String, Vec<String>>,
}

fn capitalized(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn item(id: String, section: SyncSection, change: SyncChange, label: String) -> SyncItem {
    SyncItem { id, section, change, label, place: None, from: None, to: None, secret: false, suggested: matches!(change, SyncChange::Add | SyncChange::Change), needs: None, notes: vec![] }
}

fn diff<T: PartialEq>(from: Option<&T>, to: Option<&T>) -> SyncChange {
    match (from, to) {
        (Some(a), Some(b)) if a == b => SyncChange::Same,
        (Some(_), Some(_)) => SyncChange::Change,
        (Some(_), None) => SyncChange::Add,
        (None, _) => SyncChange::Remove,
    }
}

/// Keys of both lists, the source's order first.
fn union<'a>(a: impl Iterator<Item = &'a str>, b: impl Iterator<Item = &'a str>) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    a.chain(b).filter(|k| seen.insert(*k)).collect()
}

/// Whether a value holds an absolute path (a string starting with `/`, `~/` or `X:\`).
fn has_path(v: &Value) -> bool {
    match v {
        Value::String(s) => {
            let b = s.as_bytes();
            s.starts_with('/') || s.starts_with("~/") || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        }
        Value::Array(a) => a.iter().any(has_path),
        Value::Object(o) => o.values().any(has_path),
        _ => false,
    }
}

fn setting_items(source: &SyncProfile, here: &Here) -> Vec<SyncItem> {
    let by_key = |p: &SyncProfile| -> HashMap<String, SyncSetting> { p.settings.iter().map(|s| (s.key.clone(), s.clone())).collect() };
    let (src, tgt) = (by_key(source), by_key(here.profile));
    let keys = union(source.settings.iter().map(|s| s.key.as_str()), here.profile.settings.iter().map(|s| s.key.as_str()));
    let mut out = Vec::new();
    for key in keys.into_iter().filter(|k| *k != ROLES_KEY && *k != CHAINS_KEY) {
        let (s, t, known) = (src.get(key), tgt.get(key), here.known.get(key).copied());
        // The source's value travels sealed when it is a secret there; this host's secret only hides its value.
        let (secret, here_secret) = (s.is_some_and(|s| s.secret), t.is_some_and(|t| t.secret));
        let label = known.and_then(|k| k.label.clone()).or_else(|| s.and_then(|s| s.label.clone())).unwrap_or_else(|| key.to_string());
        let tab = known.and_then(|k| k.tab.clone()).or_else(|| s.and_then(|s| s.tab.clone()));
        let group = known.and_then(|k| k.group.clone()).or_else(|| s.and_then(|s| s.group.clone()));
        let mut change = match (s, t) {
            (Some(_), Some(_)) if secret => SyncChange::Unknown,
            (Some(_), None) if secret => SyncChange::Add,
            (Some(_), Some(_)) if here_secret => SyncChange::Change,
            _ => diff(s.map(|s| &s.value), t.map(|t| &t.value)),
        };
        let mut notes = Vec::new();
        if s.is_some() && known.is_none() {
            change = SyncChange::Unsupported;
            notes.push(format!("omp {} on this host has no such setting: update omp here first.", here.profile.omp_version));
        }
        let mut it = item(format!("setting:{key}"), tf_proto::SyncSection::Settings, change, label);
        it.place = Some(match (tab, group) {
            (Some(t), Some(g)) => format!("{} › {g}", capitalized(&t)),
            (Some(t), None) => capitalized(&t),
            (None, Some(g)) => g,
            (None, None) => key.to_string(),
        });
        it.secret = secret && matches!(change, SyncChange::Add | SyncChange::Unknown);
        it.suggested = !secret && !here_secret && matches!(change, SyncChange::Add | SyncChange::Change);
        if !secret {
            it.from = s.and_then(|s| s.value.clone());
            it.to = t.filter(|_| !here_secret).and_then(|t| t.value.clone());
        }
        if here_secret && change == SyncChange::Change {
            notes.push("This host's value is a secret: it is replaced.".into());
        }
        if let Some(v) = it.from.as_ref().filter(|_| matches!(change, SyncChange::Add | SyncChange::Change)) {
            if PATH_SCOPED.contains(&key) && v.as_array().is_some_and(|a| a.iter().any(|e| e.get("path").is_some())) {
                notes.push("Has entries for folders of the other host ({path, …}): they apply here only where the same folders exist.".into());
            } else if has_path(v) {
                notes.push("Holds a path of the other host: check that it exists here.".into());
            }
        }
        if it.secret {
            notes.push("A secret: sealed on the other host for this one, never shown.".into());
        }
        it.notes = notes;
        out.push(it);
    }
    out
}

/// `role → value` of a record setting in a profile's global layer, in written order.
fn record<'a>(p: &'a SyncProfile, key: &str) -> Vec<(&'a str, &'a Value)> {
    p.settings.iter().find(|s| s.key == key).and_then(|s| s.value.as_ref()).and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.as_str(), v)).collect()).unwrap_or_default()
}

/// One role as the plan shows it: `{model?, fallbacks?}`, `None` when unset.
fn role_value(roles: &[(&str, &Value)], chains: &[(&str, &Value)], role: &str) -> Option<Value> {
    let mut o = Map::new();
    if let Some((_, m)) = roles.iter().find(|(r, _)| *r == role) {
        o.insert("model".into(), (*m).clone());
    }
    if let Some((_, c)) = chains.iter().find(|(r, _)| *r == role) {
        o.insert("fallbacks".into(), (*c).clone());
    }
    (!o.is_empty()).then_some(Value::Object(o))
}

/// A role's model (`provider/id`, a thinking level after `:` dropped) when this host can't run it.
fn missing_model(model: &str, models: &HashSet<String>) -> bool {
    let base = match model.rsplit_once(':') {
        Some((b, level)) if THINKING.contains(&level) => b,
        _ => model,
    };
    if base.contains('/') { !models.contains(base) } else { !models.iter().any(|m| m.rsplit_once('/').is_some_and(|(_, id)| id == base)) }
}

fn role_items(source: &SyncProfile, here: &Here) -> Vec<SyncItem> {
    let (sr, sc) = (record(source, ROLES_KEY), record(source, CHAINS_KEY));
    let (tr, tc) = (record(here.profile, ROLES_KEY), record(here.profile, CHAINS_KEY));
    let names = union(sr.iter().chain(&sc).map(|(r, _)| *r), tr.iter().chain(&tc).map(|(r, _)| *r));
    names
        .into_iter()
        .map(|role| {
            let (from, to) = (role_value(&sr, &sc, role), role_value(&tr, &tc, role));
            let mut it = item(format!("role:{role}"), SyncSection::Roles, diff(from.as_ref(), to.as_ref()), role.to_string());
            if let (Some(models), Some(from)) = (&here.models, &from)
                && matches!(it.change, SyncChange::Add | SyncChange::Change)
            {
                let mut missing: Vec<String> = from.get("model").and_then(Value::as_str).filter(|m| missing_model(m, models)).map(str::to_string).into_iter().collect();
                missing.extend(from.get("fallbacks").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|m| missing_model(m, models)).map(str::to_string));
                if !missing.is_empty() {
                    it.notes.push(format!("Not available on this host yet: {}. Copy the provider's sign-in too, or sign in here.", missing.join(", ")));
                }
            }
            it.from = from;
            it.to = to;
            it
        })
        .collect()
}

fn mcp_items(source: &SyncProfile, here: &Here) -> Vec<SyncItem> {
    let names = union(source.mcp.iter().map(|s| s.name.as_str()), here.profile.mcp.iter().map(|s| s.name.as_str()));
    let mut out = Vec::new();
    for name in names {
        let s = source.mcp.iter().find(|x| x.name == name);
        let t = here.profile.mcp.iter().find(|x| x.name == name);
        let shown = |x: &tf_proto::SyncMcpServer| json!({ "server": x.server, "enabled": x.enabled });
        let (from, to) = (s.map(shown), t.map(shown));
        let mut it = item(format!("mcp:{name}"), SyncSection::Mcp, diff(from.as_ref(), to.as_ref()), name.to_string());
        it.from = from;
        it.to = to;
        let Some(s) = s else {
            out.push(it);
            continue;
        };
        // Its secrets travel as an item of their own, chosen on its own.
        let secrets = s.secrets.then(|| {
            let id = format!("mcpSecrets:{name}");
            let unfillable = here.unfillable.get(name).cloned().unwrap_or_default();
            if !unfillable.is_empty() {
                it.needs = Some(id.clone());
                it.notes.push(format!("Without its secrets these stay empty here: {}.", unfillable.join(", ")));
            } else if t.is_some() {
                it.notes.push("Without its secrets, this host keeps its own values for the hidden ones.".into());
            }
            let mut secrets = item(id, SyncSection::Mcp, if t.is_some() { SyncChange::Unknown } else { SyncChange::Add }, format!("{name}: its secrets"));
            secrets.place = Some("Values shown as ••••••••".into());
            secrets.secret = true;
            secrets.suggested = false;
            secrets.notes.push(if it.change == SyncChange::Same {
                "Sealed on the other host for this one, never shown; replaces this host's values.".to_string()
            } else {
                "Sealed on the other host for this one, never shown; copied with the server.".to_string()
            });
            secrets
        });
        if s.signed_in {
            it.notes.push(signed_in_note(source, s));
        }
        if !s.extra.is_empty() {
            it.notes.push(format!("Not copied (TeleFlock doesn't edit them): {}.", s.extra.join(", ")));
        }
        out.push(it);
        out.extend(secrets);
    }
    out
}

fn signed_in_note(source: &SyncProfile, s: &tf_proto::SyncMcpServer) -> String {
    let url = s.server.url.as_deref();
    if url.is_some() && source.sign_ins.iter().any(|si| si.mcp_url.as_deref() == url) {
        "Signed in on the other host: copy its sign-in under Sign-ins, or sign in here.".into()
    } else {
        "Signed in on the other host: sign in here after copying.".into()
    }
}

const ROTATION_NOTE: &str = "Providers that rotate refresh tokens accept only the newest one: once this host refreshes it, the other host may be signed out of this account.";

fn sign_in_items(source: &SyncProfile, here: &Here) -> Vec<SyncItem> {
    source
        .sign_ins
        .iter()
        .map(|si| {
            let same = here.profile.sign_ins.iter().find(|t| t.id == si.id);
            let key_here = (si.kind == SyncSignInKind::ApiKey).then(|| here.profile.sign_ins.iter().find(|t| t.provider == si.provider && t.kind == SyncSignInKind::ApiKey)).flatten();
            let change = if here.profile.sign_ins_note.is_some() {
                SyncChange::Unsupported
            } else if same.or(key_here).is_some() {
                SyncChange::Unknown
            } else {
                SyncChange::Add
            };
            let label = match (&si.mcp_url, &si.account, si.kind) {
                (Some(url), _, _) => format!("MCP sign-in: {url}"),
                (None, _, _) if si.provider.starts_with("mcp_oauth") => "MCP sign-in".to_string(),
                (None, Some(a), _) => a.clone(),
                (None, None, SyncSignInKind::ApiKey) => "API key".to_string(),
                (None, None, SyncSignInKind::Oauth) => "Signed-in account".to_string(),
            };
            let mut it = item(format!("signIn:{}", si.id), SyncSection::SignIns, change, label);
            it.place = Some(if si.provider.starts_with("mcp_oauth") { "MCP server".into() } else { si.provider.clone() });
            it.secret = change != SyncChange::Unsupported;
            it.suggested = false;
            it.from = serde_json::to_value(si).ok();
            it.to = same.or(key_here).and_then(|t| serde_json::to_value(t).ok());
            match (&here.profile.sign_ins_note, same.or(key_here)) {
                (Some(note), _) => it.notes.push(format!("Sign-ins can't be copied to this host: {note}")),
                (None, Some(_)) if si.kind == SyncSignInKind::ApiKey => it.notes.push(format!("Replaces this host's {} API key.", si.provider)),
                (None, Some(_)) => it.notes.push("This host is signed in to this account too: copying replaces that sign-in.".into()),
                _ => {}
            }
            if si.kind == SyncSignInKind::Oauth && change != SyncChange::Unsupported {
                it.notes.push(ROTATION_NOTE.into());
            }
            it
        })
        .collect()
}

/// Every difference, in sections: settings (omp's order), roles, MCP servers, sign-ins.
pub fn plan(source: &SyncProfile, here: &Here) -> SyncPlan {
    let mut items = setting_items(source, here);
    items.extend(role_items(source, here));
    items.extend(mcp_items(source, here));
    items.extend(sign_in_items(source, here));
    let mut notes = Vec::new();
    if let Some(n) = &source.sign_ins_note {
        notes.push(format!("Sign-ins of the other host can't be listed: {n}"));
    }
    if let Some(n) = &source.mcp_note {
        notes.push(format!("MCP servers of the other host: {n}"));
    }
    if let Some(n) = &here.profile.mcp_note {
        notes.push(format!("MCP servers of this host: {n}"));
    }
    SyncPlan { source_omp: source.omp_version.clone(), target_omp: here.profile.omp_version.clone(), items, notes }
}
