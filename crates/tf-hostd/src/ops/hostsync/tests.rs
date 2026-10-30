//! `hostSync` end to end between two in-memory hosts: the omp CLI side is a fake ([`Fake`]), the
//! MCP side omp's real files in temp dirs (`mcp::sync`), the crypto the real one.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tf_proto::{
    ApiError, McpReload, OmpSetting, OmpSettingChange, OmpSettings, SyncApplyParams, SyncChange, SyncItem, SyncPlan, SyncProfile, SyncSealParams,
    SyncSection,
};
use zeroize::Zeroizing;

use super::seal::Keys;
use super::{apply, export, plan_for, seal_secrets, signins, Changed, Host};
use crate::ops::mcp::sync::UserMcp;

/// Every secret the hosts hold: none may show up on the wire or in a log line.
const SECRETS: [&str; 7] = ["ANT-ACCESS-SECRET", "ANT-REFRESH-SECRET", "sk-OPENAI-SECRET", "SEARXNG-SECRET-A", "ghp_GITHUB_SECRET", "sk-B-OWN", "B-SEARX"];

fn def(id: &str, kind: &str, tab: Option<&str>, group: Option<&str>, credential: bool) -> OmpSetting {
    OmpSetting {
        id: id.into(),
        kind: kind.into(),
        value: None,
        default: None,
        values: None,
        tab: tab.map(str::to_string),
        group: group.map(str::to_string),
        label: Some(format!("Label of {id}")),
        description: None,
        options: None,
        runtime_options: false,
        condition: None,
        warning: None,
        editor: None,
        credential,
        redacted: false,
        env: None,
        items: None,
    }
}

fn schema(newer: bool) -> Vec<OmpSetting> {
    let mut s = vec![
        def("theme.dark", "string", Some("appearance"), Some("Theme"), false),
        def("compaction.enabled", "boolean", Some("context"), Some("Compaction"), false),
        def("retry.maxRetries", "number", Some("model"), Some("Retry & Fallback"), false),
        def("shell.path", "string", Some("shell"), Some("Bash"), false),
        def("enabledModels", "array", None, None, false),
        def("display.compact", "boolean", Some("appearance"), Some("Display"), false),
        def("searxng.token", "string", Some("tools"), Some("Grep & Browser"), true),
        def("modelRoles", "record", None, None, false),
        def("retry.fallbackChains", "record", Some("model"), Some("Retry & Fallback"), false),
    ];
    if newer {
        s.push(def("newer.feature", "boolean", Some("tools"), None, false));
    }
    s
}

/// One host: omp's global layer, credential settings and credential store in memory.
struct Fake {
    schema: Vec<OmpSetting>,
    layer: Mutex<Vec<(String, Value)>>,
    creds: Mutex<HashMap<String, String>>,
    store: Mutex<Vec<Value>>,
    broker: Option<String>,
    models: Option<HashSet<String>>,
    mcp: UserMcp,
    imports: Mutex<u32>,
}

impl Fake {
    fn new(dir: &Path, newer: bool, layer: Value, creds: &[(&str, &str)], store: Value, mcp: &str, models: Option<&[&str]>) -> Fake {
        std::fs::create_dir_all(dir.join("agent")).unwrap();
        std::fs::write(dir.join("agent/mcp.json"), mcp).unwrap();
        Fake {
            schema: schema(newer),
            layer: Mutex::new(layer.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            creds: Mutex::new(creds.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            store: Mutex::new(store.as_array().unwrap().clone()),
            broker: None,
            models: models.map(|m| m.iter().map(|s| s.to_string()).collect()),
            mcp: UserMcp::at(dir),
            imports: Mutex::new(0),
        }
    }

    fn layer_value(&self, key: &str) -> Option<Value> {
        self.layer.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    fn store_text(&self) -> String {
        serde_json::to_string(&*self.store.lock().unwrap()).unwrap()
    }
}

impl Host for Fake {
    async fn settings(&self) -> Result<OmpSettings, ApiError> {
        Ok(OmpSettings { version: "18.13.3".into(), source: "schema".into(), settings: self.schema.clone(), config_path: None })
    }

    async fn global_layer(&self) -> Result<Vec<(String, Value)>, ApiError> {
        let kind = |k: &str| self.schema.iter().find(|s| s.id == k).map(|s| s.kind.clone()).unwrap_or_default();
        let mut out: Vec<(String, Value)> = self.layer.lock().unwrap().iter().map(|(k, v)| (k.clone(), json!({ "value": v, "type": kind(k), "description": "" }))).collect();
        for (k, v) in self.creds.lock().unwrap().iter().filter(|(_, v)| !v.is_empty()) {
            let _ = v;
            out.push((k.clone(), json!({ "redacted": true, "type": "string", "description": "" })));
        }
        Ok(out)
    }

    async fn setting_value(&self, key: &str) -> Result<Zeroizing<Vec<u8>>, ApiError> {
        let v = self.creds.lock().unwrap().get(key).cloned();
        Ok(Zeroizing::new(serde_json::to_vec(&json!({ "key": key, "value": v, "type": "string", "description": "" })).unwrap()))
    }

    async fn set_settings(&self, changes: &[OmpSettingChange]) -> Vec<Result<(), ApiError>> {
        changes
            .iter()
            .map(|c| {
                let def = self.schema.iter().find(|s| s.id == c.key).ok_or_else(|| ApiError::new("invalid_params", format!("unknown omp setting `{}`", c.key)))?;
                if def.credential {
                    let mut creds = self.creds.lock().unwrap();
                    match &c.value {
                        Some(Value::String(s)) => creds.insert(c.key.clone(), s.clone()),
                        _ => creds.remove(&c.key),
                    };
                    return Ok(());
                }
                let mut layer = self.layer.lock().unwrap();
                layer.retain(|(k, _)| *k != c.key);
                if let Some(v) = &c.value {
                    layer.push((c.key.clone(), v.clone()));
                }
                Ok(())
            })
            .collect()
    }

    async fn auth_export(&self) -> Result<Result<Zeroizing<Vec<u8>>, String>, ApiError> {
        if let Some(b) = &self.broker {
            return Ok(Err(format!("omp uses the auth broker at {b}; credentials live there, not in this machine's agent.db.")));
        }
        Ok(Ok(Zeroizing::new(serde_json::to_vec(&json!({ "version": 1, "credentials": *self.store.lock().unwrap() })).unwrap())))
    }

    async fn auth_import(&self, doc: &[u8]) -> Result<String, ApiError> {
        let incoming: Value = serde_json::from_slice(doc).unwrap();
        let ids_in = signins::list(doc).unwrap();
        let mut store = self.store.lock().unwrap();
        for (entry, id) in incoming["credentials"].as_array().unwrap().iter().zip(&ids_in) {
            // omp's merge: a key replaces the provider's key, a login the same account's login.
            let existing = signins::list(&serde_json::to_vec(&json!({ "version": 1, "credentials": *store })).unwrap()).unwrap();
            let keep: Vec<Value> = store
                .iter()
                .zip(&existing)
                .filter(|(_, e)| !(e.provider == id.provider && (e.id == id.id || (e.kind == tf_proto::SyncSignInKind::ApiKey && id.kind == e.kind))))
                .map(|(v, _)| v.clone())
                .collect();
            *store = keep;
            store.push(entry.clone());
        }
        *self.imports.lock().unwrap() += 1;
        Ok(format!("Imported {} credential(s).", ids_in.len()))
    }

    fn mcp(&self) -> &UserMcp {
        &self.mcp
    }

    async fn models(&self) -> Option<HashSet<String>> {
        self.models.clone()
    }

    async fn after(&self, changed: Changed) -> Option<McpReload> {
        changed.mcp.then(|| McpReload { reloaded: 1, queued: 0, restart_needed: 0, errors: vec![] })
    }
}

const MCP_A: &str = r#"{
  "mcpServers": {
    "gh": { "command": "npx", "args": ["-y", "gh-mcp"], "env": { "GITHUB_TOKEN": "ghp_GITHUB_SECRET", "LOG": "info" } },
    "docs": { "type": "http", "url": "https://docs.example.com/mcp" },
    "shared": { "type": "http", "url": "https://shared.example.com/mcp" }
  }
}"#;

const MCP_B: &str = r#"{
  "mcpServers": {
    "shared": { "type": "http", "url": "https://shared.example.com/mcp" },
    "old": { "command": "old-mcp" }
  }
}"#;

fn hosts(a: &Path, b: &Path) -> (Fake, Fake) {
    let source = Fake::new(
        a,
        true,
        json!({
            "theme.dark": "dracula",
            "compaction.enabled": false,
            "retry.maxRetries": 5,
            "shell.path": "/opt/bin/zsh",
            "enabledModels": [{ "path": "/home/a/repo", "models": ["x/y"] }, "anthropic/*"],
            "newer.feature": true,
            "modelRoles": { "default": "anthropic/claude-sonnet-4-5", "smol": "openai/gpt-5-mini:low", "plan": "anthropic/claude-opus-4-1" },
            "retry.fallbackChains": { "default": ["openai/gpt-5"] }
        }),
        &[("searxng.token", "SEARXNG-SECRET-A")],
        json!([
            { "provider": "anthropic", "credential": { "type": "oauth", "access": "ANT-ACCESS-SECRET", "refresh": "ANT-REFRESH-SECRET", "expires": 1900000000000u64, "email": "a@example.com" } },
            { "provider": "openai", "credential": { "type": "api_key", "key": "sk-OPENAI-SECRET" } }
        ]),
        MCP_A,
        None,
    );
    let target = Fake::new(
        b,
        false,
        json!({
            "theme.dark": "nord",
            "retry.maxRetries": 5,
            "display.compact": true,
            "modelRoles": { "default": "openai/gpt-5", "tiny": "openai/gpt-5-nano" }
        }),
        &[],
        json!([{ "provider": "openai", "credential": { "type": "api_key", "key": "sk-B-OWN" } }]),
        MCP_B,
        Some(&["openai/gpt-5", "openai/gpt-5-mini", "openai/gpt-5-nano"]),
    );
    (source, target)
}

fn find<'a>(plan: &'a SyncPlan, id: &str) -> &'a SyncItem {
    plan.items.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("{id} missing from {:#?}", plan.items.iter().map(|i| &i.id).collect::<Vec<_>>()))
}

fn assert_clean(what: &str, text: &str) {
    for s in SECRETS {
        assert!(!text.contains(s), "{what} carries the secret {s}: {text}");
    }
}

fn sign_in_id(profile: &SyncProfile, provider: &str) -> String {
    format!("signIn:{}", profile.sign_ins.iter().find(|s| s.provider == provider).unwrap().id)
}

#[tokio::test]
async fn export_holds_no_secret() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (source, _) = hosts(a.path(), b.path());
    let profile = export(&source).await.unwrap();
    assert_clean("the profile", &serde_json::to_string(&profile).unwrap());
    let token = profile.settings.iter().find(|s| s.key == "searxng.token").unwrap();
    assert!(token.secret && token.value.is_none());
    assert_eq!(profile.settings.iter().find(|s| s.key == "theme.dark").unwrap().label.as_deref(), Some("Label of theme.dark"));
    assert_eq!(profile.sign_ins.len(), 2);
    let gh = profile.mcp.iter().find(|s| s.name == "gh").unwrap();
    assert!(gh.secrets);
    assert_eq!(gh.server.env[0].value, tf_proto::SECRET_MASK);

    // An auth broker: no sign-ins, and why.
    let brokered = Fake { broker: Some("https://broker.example".into()), ..hosts(a.path(), b.path()).0 };
    let p = export(&brokered).await.unwrap();
    assert!(p.sign_ins.is_empty());
    assert!(p.sign_ins_note.unwrap().contains("auth broker"));

    // omp older than 18.13.3 can't list its global layer as written.
    struct Old(Fake);
    impl Host for Old {
        async fn settings(&self) -> Result<OmpSettings, ApiError> {
            Ok(OmpSettings { version: "18.12.3".into(), ..self.0.settings().await? })
        }
        async fn global_layer(&self) -> Result<Vec<(String, Value)>, ApiError> {
            self.0.global_layer().await
        }
        async fn setting_value(&self, key: &str) -> Result<Zeroizing<Vec<u8>>, ApiError> {
            self.0.setting_value(key).await
        }
        async fn set_settings(&self, c: &[OmpSettingChange]) -> Vec<Result<(), ApiError>> {
            self.0.set_settings(c).await
        }
        async fn auth_export(&self) -> Result<Result<Zeroizing<Vec<u8>>, String>, ApiError> {
            self.0.auth_export().await
        }
        async fn auth_import(&self, d: &[u8]) -> Result<String, ApiError> {
            self.0.auth_import(d).await
        }
        fn mcp(&self) -> &UserMcp {
            self.0.mcp()
        }
        async fn models(&self) -> Option<HashSet<String>> {
            None
        }
        async fn after(&self, c: Changed) -> Option<McpReload> {
            self.0.after(c).await
        }
    }
    let err = export(&Old(hosts(a.path(), b.path()).0)).await.unwrap_err();
    assert_eq!(err.code, "unsupported");
    assert!(err.hint.is_some());
}

#[tokio::test]
async fn plan_lists_every_difference() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (source, target) = hosts(a.path(), b.path());
    let profile = export(&source).await.unwrap();
    let plan = plan_for(&target, &profile).await.unwrap();
    assert_clean("the plan", &serde_json::to_string(&plan).unwrap());
    assert_eq!(plan.source_omp, "18.13.3");
    let kind = |id: &str| find(&plan, id).change;

    // Settings.
    assert_eq!(kind("setting:theme.dark"), SyncChange::Change);
    let dark = find(&plan, "setting:theme.dark");
    assert_eq!((dark.from.clone(), dark.to.clone(), dark.suggested), (Some(json!("dracula")), Some(json!("nord")), true));
    assert_eq!(dark.place.as_deref(), Some("Appearance › Theme"));
    assert_eq!(kind("setting:compaction.enabled"), SyncChange::Add);
    assert_eq!(kind("setting:retry.maxRetries"), SyncChange::Same);
    assert!(!find(&plan, "setting:retry.maxRetries").suggested);
    assert!(find(&plan, "setting:shell.path").notes.iter().any(|n| n.contains("path of the other host")));
    assert!(find(&plan, "setting:enabledModels").notes.iter().any(|n| n.contains("folders of the other host")));
    assert_eq!(kind("setting:newer.feature"), SyncChange::Unsupported);
    assert_eq!(kind("setting:display.compact"), SyncChange::Remove);
    assert!(!find(&plan, "setting:display.compact").suggested, "removals are never preselected");
    let token = find(&plan, "setting:searxng.token");
    assert_eq!((token.change, token.secret, token.suggested, token.from.is_none()), (SyncChange::Add, true, false, true));
    assert!(!plan.items.iter().any(|i| i.id == "setting:modelRoles" || i.id == "setting:retry.fallbackChains"), "roles have their own section");

    // Roles: the record entries of both hosts, with the models this host lacks.
    let default = find(&plan, "role:default");
    assert_eq!(default.section, SyncSection::Roles);
    assert_eq!(default.change, SyncChange::Change);
    assert_eq!(default.from, Some(json!({ "model": "anthropic/claude-sonnet-4-5", "fallbacks": ["openai/gpt-5"] })));
    assert_eq!(default.to, Some(json!({ "model": "openai/gpt-5" })));
    assert!(default.notes.iter().any(|n| n.contains("anthropic/claude-sonnet-4-5")), "{:?}", default.notes);
    assert_eq!(kind("role:smol"), SyncChange::Add);
    assert!(find(&plan, "role:smol").notes.is_empty(), "a thinking level after the model is no model of its own");
    assert_eq!(kind("role:tiny"), SyncChange::Remove);

    // MCP servers: gh's token can't be filled here, so its definition needs its secrets.
    assert_eq!(kind("mcp:gh"), SyncChange::Add);
    assert_eq!(find(&plan, "mcp:gh").needs.as_deref(), Some("mcpSecrets:gh"));
    assert!(find(&plan, "mcp:gh").notes.iter().any(|n| n.contains("env GITHUB_TOKEN")));
    let secrets = find(&plan, "mcpSecrets:gh");
    assert_eq!((secrets.change, secrets.secret, secrets.suggested), (SyncChange::Add, true, false));
    assert_eq!(kind("mcp:docs"), SyncChange::Add);
    assert_eq!(kind("mcp:shared"), SyncChange::Same);
    assert_eq!(kind("mcp:old"), SyncChange::Remove);
    assert!(!plan.items.iter().any(|i| i.id == "mcpSecrets:docs"), "nothing secret in docs");

    // Sign-ins: by identity; this host's own openai key is replaced.
    let ant = find(&plan, &sign_in_id(&profile, "anthropic"));
    assert_eq!((ant.change, ant.secret, ant.suggested), (SyncChange::Add, true, false));
    assert!(ant.notes.iter().any(|n| n.contains("rotate refresh tokens")));
    let oai = find(&plan, &sign_in_id(&profile, "openai"));
    assert_eq!(oai.change, SyncChange::Unknown);
    assert!(oai.notes.iter().any(|n| n.contains("Replaces this host's openai API key")));

    // Sections in order.
    let sections: Vec<SyncSection> = plan.items.iter().map(|i| i.section).collect();
    let mut sorted = sections.clone();
    sorted.sort_by_key(|s| [SyncSection::Settings, SyncSection::Roles, SyncSection::Mcp, SyncSection::SignIns].iter().position(|x| x == s));
    assert_eq!(sections, sorted);

    // A target behind an auth broker can't take sign-ins.
    let brokered = Fake { broker: Some("https://broker.example".into()), ..hosts(a.path(), b.path()).1 };
    let plan = plan_for(&brokered, &profile).await.unwrap();
    let ant = find(&plan, &sign_in_id(&profile, "anthropic"));
    assert_eq!((ant.change, ant.secret), (SyncChange::Unsupported, false));
}

#[tokio::test]
async fn apply_without_secrets() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (source, target) = hosts(a.path(), b.path());
    let profile = export(&source).await.unwrap();
    let plan = plan_for(&target, &profile).await.unwrap();
    let mut items: Vec<String> = plan.items.iter().filter(|i| i.suggested).map(|i| i.id.clone()).collect();
    items.extend(["setting:retry.maxRetries".to_string(), "setting:newer.feature".into(), "mcp:old".into(), "setting:gone".into()]);
    let applied = apply(&target, &Keys::new(), SyncApplyParams { source: profile.clone(), items: items.clone(), sealed: None }).await.unwrap();
    let result = |id: &str| applied.results.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("no result for {id}")).clone();
    assert_eq!(applied.results.len(), items.len(), "one result per requested item");
    for id in ["setting:theme.dark", "setting:compaction.enabled", "role:default", "role:smol", "mcp:docs", "mcp:old"] {
        assert!(result(id).ok, "{id}: {:?}", result(id));
    }
    assert_eq!(result("setting:retry.maxRetries").note.as_deref(), Some("Already the same."));
    assert!(!result("setting:newer.feature").ok);
    assert!(!result("setting:gone").ok);
    let gh = result("mcp:gh");
    assert!(gh.ok && gh.note.unwrap().contains("env GITHUB_TOKEN"), "copied without its token, which stays empty");
    assert!(result("role:default").note.unwrap().contains("Not available"));

    // This host now.
    assert_eq!(target.layer_value("theme.dark"), Some(json!("dracula")));
    assert_eq!(target.layer_value("display.compact"), Some(json!(true)), "an unchosen removal stays");
    assert_eq!(
        target.layer_value("modelRoles"),
        Some(json!({ "default": "anthropic/claude-sonnet-4-5", "tiny": "openai/gpt-5-nano", "smol": "openai/gpt-5-mini:low", "plan": "anthropic/claude-opus-4-1" })),
        "chosen roles replaced, others kept"
    );
    assert_eq!(target.layer_value("retry.fallbackChains"), Some(json!({ "default": ["openai/gpt-5"] })));
    let mcp = std::fs::read_to_string(b.path().join("agent/mcp.json")).unwrap();
    assert!(mcp.contains("\"docs\"") && !mcp.contains("\"old\"") && mcp.contains(r#""GITHUB_TOKEN": """#), "{mcp}");
    assert_eq!(applied.mcp_reload.map(|r| r.reloaded), Some(1));
    assert_eq!(*target.imports.lock().unwrap(), 0);

    // The fresh plan: what was copied is the same now; gh's empty token still differs.
    let kind = |id: &str| find(&applied.plan, id).change;
    assert_eq!(kind("setting:theme.dark"), SyncChange::Same);
    assert_eq!(kind("role:smol"), SyncChange::Same);
    assert_eq!(kind("role:tiny"), SyncChange::Remove);
    assert_eq!(kind("mcp:docs"), SyncChange::Same);
    assert_eq!(kind("mcp:gh"), SyncChange::Change);
    assert_eq!(kind("mcpSecrets:gh"), SyncChange::Unknown);

    // Secrets chosen without the sealed box: nothing is applied.
    let id = sign_in_id(&profile, "anthropic");
    let err = apply(&target, &Keys::new(), SyncApplyParams { source: profile.clone(), items: vec![id, "setting:display.compact".into()], sealed: None }).await.unwrap_err();
    assert_eq!(err.code, "invalid_params");
    assert_eq!(target.layer_value("display.compact"), Some(json!(true)));
    // Its secrets without the definition that differs: refused, item by item.
    let applied = apply(&target, &Keys::new(), SyncApplyParams { source: profile.clone(), items: vec!["mcp:docs".into()], sealed: None }).await.unwrap();
    assert_eq!(applied.results[0].note.as_deref(), Some("Already the same."));
}

/// Collects every log line of the current thread.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn sealed_secrets_round_trip() {
    let log = Captured::default();
    let writer = log.clone();
    let subscriber = tracing_subscriber::fmt().with_max_level(tracing::Level::TRACE).with_ansi(false).with_writer(move || writer.clone()).finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    // tracing caches a log line's interest the first time any thread runs it. While only one
    // dispatcher exists it asks just the default of that thread: a parallel test reaching
    // `apply`'s lines first (no subscriber there) would switch them off here too. With a second
    // dispatcher alive it asks every dispatcher, and each line checks this thread's when it runs.
    let _second = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());

    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (source, target) = hosts(a.path(), b.path());
    let keys = Keys::new();
    let profile = export(&source).await.unwrap();
    let plan = plan_for(&target, &profile).await.unwrap();
    let (ant, oai) = (sign_in_id(&profile, "anthropic"), sign_in_id(&profile, "openai"));
    let secret_ids = vec![ant.clone(), oai.clone(), "setting:searxng.token".to_string(), "mcpSecrets:gh".to_string()];
    for id in &secret_ids {
        assert!(find(&plan, id).secret, "{id}");
    }
    let mut items = secret_ids.clone();
    items.push("mcp:gh".into());

    // The target's one-time key, the source seals, the app relays.
    let key = keys.begin(Instant::now(), 0).unwrap();
    let sealed = seal_secrets(&source, SyncSealParams { transfer_id: key.transfer_id.clone(), public_key: key.public_key.clone(), items: secret_ids.clone() }).await.unwrap();
    assert_clean("the sealed box", &serde_json::to_string(&sealed).unwrap());
    let mut sealed_items = secret_ids.clone();
    sealed_items.sort();
    assert_eq!(sealed.items, sealed_items);

    let applied = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items.clone(), sealed: Some(sealed.clone()) }).await.unwrap();
    assert!(applied.results.iter().all(|r| r.ok), "{:#?}", applied.results);
    assert_eq!(applied.results.len(), items.len());
    assert_clean("the answer", &serde_json::to_string(&applied).unwrap());

    // Sign-ins merged as omp does: the account added, the provider's key replaced.
    let store = target.store_text();
    assert!(store.contains("ANT-REFRESH-SECRET") && store.contains("sk-OPENAI-SECRET") && !store.contains("sk-B-OWN"), "{store}");
    assert_eq!(*target.imports.lock().unwrap(), 1);
    assert_eq!(target.creds.lock().unwrap().get("searxng.token").map(String::as_str), Some("SEARXNG-SECRET-A"));
    let mcp = std::fs::read_to_string(b.path().join("agent/mcp.json")).unwrap();
    assert!(mcp.contains("ghp_GITHUB_SECRET"), "{mcp}");
    let kind = |id: &str| find(&applied.plan, id).change;
    assert_eq!(kind("mcp:gh"), SyncChange::Same);
    assert_eq!(kind(&ant), SyncChange::Unknown, "now signed in here too");

    // One key, one box: the same box again is refused before anything is read.
    let again = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items.clone(), sealed: Some(sealed) }).await.unwrap_err();
    assert_eq!(again.code, "expired");

    let logged = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(logged.contains("hostSync: sealed secrets") && logged.contains("hostSync: applied"), "{logged}");
    assert!(logged.contains("hostSync: refused sealed secrets from another host; nothing applied code=expired"), "{logged}");
    assert_clean("the log", &logged);
}

#[tokio::test]
async fn tampered_or_mismatched_boxes_apply_nothing() {
    let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (source, target) = hosts(a.path(), b.path());
    let keys = Keys::new();
    let profile = export(&source).await.unwrap();
    let ant = sign_in_id(&profile, "anthropic");
    let before = (target.store_text(), std::fs::read_to_string(b.path().join("agent/mcp.json")).unwrap(), target.layer_value("theme.dark"));
    let unchanged = |t: &Fake| {
        assert_eq!((t.store_text(), std::fs::read_to_string(b.path().join("agent/mcp.json")).unwrap(), t.layer_value("theme.dark")), before, "nothing applied");
    };
    let sealed_for = |ids: Vec<String>| {
        let key = keys.begin(Instant::now(), 0).unwrap();
        seal_secrets(&source, SyncSealParams { transfer_id: key.transfer_id, public_key: key.public_key, items: ids })
    };
    let items = |extra: &[&str]| -> Vec<String> { [ant.as_str(), "setting:theme.dark"].iter().chain(extra).map(|s| s.to_string()).collect() };

    // A flipped bit.
    let mut sealed = sealed_for(vec![ant.clone()]).await.unwrap();
    let mut raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &sealed.ciphertext).unwrap();
    raw[0] ^= 0x01;
    sealed.ciphertext = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, raw);
    let err = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items(&[]), sealed: Some(sealed.clone()) }).await.unwrap_err();
    assert_eq!(err.code, "sealed_invalid");
    unchanged(&target);
    // Its key is spent.
    assert_eq!(apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items(&[]), sealed: Some(sealed) }).await.unwrap_err().code, "expired");

    // Fewer secrets sealed than chosen.
    let sealed = sealed_for(vec![ant.clone()]).await.unwrap();
    let err = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items(&["setting:searxng.token"]), sealed: Some(sealed) }).await.unwrap_err();
    assert_eq!(err.code, "sealed_invalid");
    // More sealed than chosen.
    let sealed = sealed_for(vec![ant.clone(), "setting:searxng.token".into()]).await.unwrap();
    let err = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: items(&[]), sealed: Some(sealed) }).await.unwrap_err();
    assert_eq!(err.code, "sealed_invalid");
    // The item list relabelled on the way.
    let mut sealed = sealed_for(vec![ant.clone()]).await.unwrap();
    sealed.items = vec!["setting:searxng.token".into()];
    let err = apply(&target, &keys, SyncApplyParams { source: profile.clone(), items: vec!["setting:searxng.token".into()], sealed: Some(sealed) }).await.unwrap_err();
    assert_eq!(err.code, "sealed_invalid");
    unchanged(&target);

    // The source refuses what isn't a secret item, a transfer it didn't get from a target, a gone sign-in.
    let key = keys.begin(Instant::now(), 0).unwrap();
    let seal = |items: Vec<&str>, transfer: &str| seal_secrets(&source, SyncSealParams { transfer_id: transfer.into(), public_key: key.public_key.clone(), items: items.into_iter().map(str::to_string).collect() });
    assert_eq!(seal(vec!["setting:theme.dark"], &key.transfer_id).await.unwrap_err().code, "invalid_params");
    assert_eq!(seal(vec!["role:default"], &key.transfer_id).await.unwrap_err().code, "invalid_params");
    assert_eq!(seal(vec![ant.as_str()], "not-hex").await.unwrap_err().code, "invalid_params");
    assert_eq!(seal(vec!["signIn:nobody|000000000000"], &key.transfer_id).await.unwrap_err().code, "not_found");
    assert_eq!(seal(vec!["mcpSecrets:nope"], &key.transfer_id).await.unwrap_err().code, "not_found");
}
