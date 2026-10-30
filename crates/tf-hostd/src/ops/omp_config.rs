//! `omp.*` methods: omp's settings schema and global config (architecture §3.4, §8).
//!
//! - **Schema**: omp's `config/all-settings` registry (ids, types, defaults, enum values, settings
//!   panel tab/group/label/description/options, conditions, warnings, env overrides, credentials),
//!   read by starting a throwaway headless `omp --mode rpc` with the companion extension in its
//!   schema-dump mode (`TF_OMP_SCHEMA_OUT`, docs/bridge-protocol.md "Schema dump"). Cached per omp
//!   binary (path + size + mtime) in memory and in `<home>/cache/omp-settings-schema.json`.
//! - **Values**: `omp config list --json` (global config, else defaults; credentials redacted by
//!   omp itself), cached [`VALUES_TTL`] and dropped after every write (a list that started before
//!   a write never fills the cache).
//! - **Writes**: `omp config set|reset -- <key> [<value>]`, one change at a time, never through a
//!   shell. omp validates (enum values, item vocabularies, JSON shapes); its message comes back as
//!   `invalid_params`. A batch that sets a **credential** never uses argv (readable by every local
//!   user): a throwaway omp runs the companion extension's settings-write mode
//!   (`TF_OMP_SETTINGS_IN`, docs/bridge-protocol.md "Settings write"), which applies the batch
//!   through omp's Settings API from an owner-only file it deletes on read. Without that mode
//!   (extension < 1.3.0) credential writes are refused (`unsupported`, hint: the env override).
//! - Without a readable schema (older omp or companion extension) the answer is `source: "cli"`,
//!   built from `config list` alone: every key is still listed and editable, without labels; keys
//!   named like secrets (`…token`, `…apiKey`, `…password`, …) count as credentials there.
//!
//! Credential values never leave the host: not in answers, not in logs (writes log keys only),
//! not in any command line.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tf_proto::{ApiError, HostMethod, OmpSetting, OmpSettingChange, OmpSettingOption, OmpSettingValues, OmpSettings};
use zeroize::Zeroizing;

use crate::clients::ClientHandle;
use crate::ops::fs::home_dir;
use crate::ops::git::run_cmd;
use crate::ops::host::{omp_agent_dir, omp_bin, parse_version};
use crate::ops::{to_value, Ctx};

/// Bound on one schema dump (omp start + extension load ≈ 2 s).
const SCHEMA_TIMEOUT: Duration = Duration::from_secs(20);
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const VALUES_TTL: Duration = Duration::from_secs(10);
const SCHEMA_CACHE_FILE: &str = "omp-settings-schema.json";
/// Bumped when the cached schema layout changes (older cache files are ignored).
const CACHE_FORMAT: u32 = 1;
/// Present in companion extensions that know the schema-dump mode (bridge ≥ 1.2.0). Older ones
/// would run as a normal bridge inside the throwaway omp, so they are never started for a dump.
const DUMP_MARKER: &str = "TF_OMP_SCHEMA_OUT";
/// Settings-write mode (bridge ≥ 1.3.0): the input file (also the marker, as above) and the
/// result file.
const WRITE_MARKER: &str = "TF_OMP_SETTINGS_IN";
const WRITE_OUT: &str = "TF_OMP_SETTINGS_OUT";

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::OmpSettingsGet(p) => to_value(settings(&Omp::from_ctx(ctx)?, p.refresh.unwrap_or(false)).await?),
        HostMethod::OmpSettingsSet(p) => to_value(set(&Omp::from_ctx(ctx)?, &p.changes).await?),
        HostMethod::OmpSettingValuesGet(p) => to_value(setting_values(&Omp::from_ctx(ctx)?, &p.keys).await?),
        other => Err(ApiError::new("unknown_method", format!("{} is not an omp method", other.name()))),
    }
}

/// The omp install the methods talk to. Tests point `agent_dir` at a temp dir
/// (`PI_CODING_AGENT_DIR` for every child) instead of mutating the process environment.
struct Omp {
    bin: PathBuf,
    /// Deployed companion extension (`<home>/ext/teleflock-bridge.ts`).
    ext: PathBuf,
    /// `<home>/cache`.
    cache_dir: PathBuf,
    /// Owner-only scratch dir for the dump file (`<home>/run`).
    run_dir: PathBuf,
    agent_dir: Option<PathBuf>,
}

impl Omp {
    fn from_ctx(ctx: &Ctx) -> Result<Self, ApiError> {
        let bin = omp_bin().ok_or_else(|| {
            ApiError::new("omp_error", "omp is not installed on this host").with_hint("Install omp (oh-my-pi) and make sure `omp` is on PATH or in ~/.local/bin.")
        })?;
        Ok(Self { bin, ext: ctx.paths.ext.clone(), cache_dir: ctx.paths.home.join("cache"), run_dir: ctx.paths.run.clone(), agent_dir: None })
    }

    fn env(&self) -> Vec<(&str, &str)> {
        let mut env = vec![("NO_COLOR", "1")];
        if let Some(dir) = self.agent_dir.as_deref().and_then(Path::to_str) {
            env.push(("PI_CODING_AGENT_DIR", dir));
        }
        env
    }

    /// omp's global config file (`<agent dir>/config.yml`).
    fn config_path(&self) -> PathBuf {
        self.agent_dir.clone().unwrap_or_else(omp_agent_dir).join("config.yml")
    }

    async fn run(&self, args: &[&str]) -> Result<crate::ops::git::CmdOut, ApiError> {
        run_cmd(&self.bin, args, Some(&home_dir()), &self.env(), None, CLI_TIMEOUT).await.map_err(|e| {
            let code = if e.kind() == std::io::ErrorKind::TimedOut { "timeout" } else { "omp_error" };
            ApiError::new(code, format!("omp {}: {e}", args.iter().take(2).copied().collect::<Vec<_>>().join(" ")))
        })
    }

    /// A fresh path in the owner-only run dir (`<stem>-<pid>-<nanos>.json`).
    fn scratch(&self, stem: &str) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.run_dir).map_err(|e| format!("{}: {e}", self.run_dir.display()))?;
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        Ok(self.run_dir.join(format!("{stem}-{}-{nanos}.json", std::process::id())))
    }
}

// ───────────────────────────── schema ─────────────────────────────

/// Identity of the omp binary a schema was read from: a new build (update) reads it again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct BinIdent {
    path: String,
    size: u64,
    mtime_ms: u64,
}

impl BinIdent {
    fn of(bin: &Path) -> Self {
        let meta = std::fs::metadata(bin).ok();
        let mtime_ms = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let path = std::fs::canonicalize(bin).unwrap_or_else(|_| bin.to_path_buf());
        Self { path: path.display().to_string(), size: meta.map(|m| m.len()).unwrap_or(0), mtime_ms }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Schema {
    format: u32,
    ident: BinIdent,
    omp_version: Option<String>,
    /// omp's setting definitions, in settings-panel order (functions already dropped).
    settings: Vec<Value>,
}

enum Loaded {
    Schema(Arc<Schema>),
    /// The last dump failed for this omp binary + companion extension: answer from the CLI until
    /// either changes (or `refresh`) instead of starting omp on every call.
    Failed { ident: (BinIdent, BinIdent), reason: String },
}

static SCHEMA: LazyLock<tokio::sync::Mutex<Option<Loaded>>> = LazyLock::new(|| tokio::sync::Mutex::new(None));

/// The schema for the current omp binary: memory, else the disk cache, else a fresh dump
/// (`refresh` skips the caches). One dump at a time; concurrent callers wait for it.
async fn schema(omp: &Omp, refresh: bool) -> Result<Arc<Schema>, String> {
    let ident = BinIdent::of(&omp.bin);
    let failed_ident = (ident.clone(), BinIdent::of(&omp.ext));
    let mut slot = SCHEMA.lock().await;
    if !refresh {
        match slot.as_ref() {
            Some(Loaded::Schema(s)) if s.ident == ident => return Ok(s.clone()),
            Some(Loaded::Failed { ident, reason }) if *ident == failed_ident => return Err(reason.clone()),
            _ => {}
        }
        let cached = std::fs::read(omp.cache_dir.join(SCHEMA_CACHE_FILE)).ok().and_then(|b| serde_json::from_slice::<Schema>(&b).ok());
        if let Some(s) = cached.filter(|s| s.format == CACHE_FORMAT && s.ident == ident && !s.settings.is_empty()) {
            let s = Arc::new(s);
            *slot = Some(Loaded::Schema(s.clone()));
            return Ok(s);
        }
    }
    let started = Instant::now();
    let (omp_version, settings) = match dump_schema(omp).await {
        Ok(v) => v,
        Err(reason) => {
            *slot = Some(Loaded::Failed { ident: failed_ident, reason: reason.clone() });
            return Err(reason);
        }
    };
    tracing::info!(settings = settings.len(), ms = started.elapsed().as_millis() as u64, "read omp settings schema");
    let s = Arc::new(Schema { format: CACHE_FORMAT, ident, omp_version, settings });
    if let Err(e) = std::fs::create_dir_all(&omp.cache_dir)
        .and_then(|_| serde_json::to_vec(&*s).map_err(std::io::Error::other))
        .and_then(|bytes| crate::paths::write_atomic(&omp.cache_dir.join(SCHEMA_CACHE_FILE), &bytes))
    {
        tracing::warn!("cache omp settings schema: {e}");
    }
    *slot = Some(Loaded::Schema(s.clone()));
    Ok(s)
}

/// Starts `omp --mode rpc` with the companion extension in schema-dump mode, waits for the file
/// and kills the child. Returns (omp version, definitions).
async fn dump_schema(omp: &Omp) -> Result<(Option<String>, Vec<Value>), String> {
    let ext = std::fs::read_to_string(&omp.ext).map_err(|e| format!("companion extension {}: {e}", omp.ext.display()))?;
    if !ext.contains(DUMP_MARKER) {
        return Err("the companion extension predates the schema dump (bridge < 1.2.0)".into());
    }
    let out = omp.scratch("omp-schema")?;
    parse_dump(&run_ext_mode(omp, &[(DUMP_MARKER, &out)], &out, "its settings schema").await?)
}

/// argv of a throwaway omp running the companion extension in a one-shot mode: headless, no
/// session, nothing else loaded. Never carries a setting value (those go through a 0600 file).
fn ext_mode_args(ext: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> =
        ["--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-extensions", "-e"].iter().map(Into::into).collect();
    args.push(ext.as_os_str().to_owned());
    args
}

/// Runs the companion extension in a one-shot mode (`env`: the mode's file variables), waits
/// for it to write `out`, kills the child and returns `out`'s bytes (the file is removed).
async fn run_ext_mode(omp: &Omp, env: &[(&str, &Path)], out: &Path, what: &str) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new(&omp.bin);
    cmd.args(ext_mode_args(&omp.ext))
        .current_dir(home_dir())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    for (k, v) in omp.env() {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("spawn omp: {e}"))?;
    let deadline = Instant::now() + SCHEMA_TIMEOUT;
    let mut exited = None;
    while !out.exists() {
        if let Some(status) = exited {
            let _ = std::fs::remove_file(out);
            return Err(format!("omp exited ({status}) without writing {what}"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(out);
            return Err(format!("omp did not write {what} within {}s", SCHEMA_TIMEOUT.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // One more look at the file after the child is gone (it writes, then exits).
        exited = child.try_wait().ok().flatten();
    }
    let _ = child.kill().await;
    let bytes = std::fs::read(out).map_err(|e| format!("read {what}: {e}"));
    let _ = std::fs::remove_file(out);
    bytes
}

/// Parses the extension's dump `{bridgeVersion, ompVersion, settings, error?}`.
fn parse_dump(bytes: &[u8]) -> Result<(Option<String>, Vec<Value>), String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("schema dump: {e}"))?;
    let version = v.get("ompVersion").and_then(Value::as_str).map(str::to_string);
    match v.get("settings").and_then(Value::as_array) {
        Some(defs) if !defs.is_empty() => Ok((version, defs.iter().filter(|d| d.get("id").and_then(Value::as_str).is_some()).cloned().collect())),
        _ => Err(format!("omp settings schema unavailable: {}", v.get("error").and_then(Value::as_str).unwrap_or("empty"))),
    }
}

// ───────────────────────────── values ─────────────────────────────

/// `omp config list --json` entries (`{value?, type, description, redacted?}`) in omp's order.
type Entries = Vec<(String, Value)>;

struct ValuesCache {
    config: PathBuf,
    at: Instant,
    entries: Arc<Entries>,
}

static VALUES: LazyLock<std::sync::Mutex<Option<ValuesCache>>> = LazyLock::new(|| std::sync::Mutex::new(None));
/// Bumped by every write: a `config list` that started before a write never fills the cache
/// (it may hold the old values).
static VALUES_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Serializes writes (each `omp config set` rewrites config.yml).
static WRITES: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn drop_values() {
    let mut cache = VALUES.lock().unwrap_or_else(|p| p.into_inner());
    VALUES_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    *cache = None;
}

async fn values(omp: &Omp, refresh: bool) -> Result<Arc<Entries>, ApiError> {
    let config = omp.config_path();
    if !refresh {
        let cache = VALUES.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = cache.as_ref().filter(|c| c.config == config && c.at.elapsed() < VALUES_TTL) {
            return Ok(c.entries.clone());
        }
    }
    let generation = VALUES_GEN.load(std::sync::atomic::Ordering::SeqCst);
    let out = omp.run(&["config", "list", "--json"]).await?;
    if !out.ok() {
        return Err(ApiError::new("omp_error", format!("omp config list: {}", omp_message(&out.message()))));
    }
    let entries = Arc::new(parse_list(&out.stdout).map_err(|e| ApiError::new("omp_error", format!("omp config list output: {e}")))?);
    let mut cache = VALUES.lock().unwrap_or_else(|p| p.into_inner());
    if VALUES_GEN.load(std::sync::atomic::Ordering::SeqCst) == generation {
        *cache = Some(ValuesCache { config, at: Instant::now(), entries: entries.clone() });
    }
    Ok(entries)
}

/// One global value from `omp config list` (cached like the settings page's; `None` = unset and
/// no default).
pub(crate) async fn global_value(ctx: &Ctx, key: &str, refresh: bool) -> Result<Option<Value>, ApiError> {
    let entries = values(&Omp::from_ctx(ctx)?, refresh).await?;
    Ok(entries.iter().find(|(k, _)| k == key).and_then(|(_, e)| e.get("value").cloned()))
}

/// Writes one non-credential array / record setting (`omp config set -- <key> <json>`), serialized
/// with the settings page's writes.
pub(crate) async fn set_json(ctx: &Ctx, key: &str, value: &Value) -> Result<(), ApiError> {
    let omp = Omp::from_ctx(ctx)?;
    let _writing = WRITES.lock().await;
    let written = write_via_cli(&omp, &[Write::Set(key, value.to_string())]).await;
    drop_values();
    written
}

/// Parses `config list --json` keeping omp's key order (serde_json's map would sort it).
fn parse_list(bytes: &[u8]) -> Result<Entries, serde_json::Error> {
    struct Ordered(Entries);
    impl<'de> Deserialize<'de> for Ordered {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Ordered;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("an object of settings")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Ordered, A::Error> {
                    let mut out = Vec::with_capacity(map.size_hint().unwrap_or(0));
                    while let Some(entry) = map.next_entry::<String, Value>()? {
                        out.push(entry);
                    }
                    Ok(Ordered(out))
                }
            }
            d.deserialize_map(V)
        }
    }
    serde_json::from_slice::<Ordered>(bytes).map(|o| o.0)
}

// ───────────────────────────── mapping ─────────────────────────────

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn flag(v: Option<&Value>) -> bool {
    v.and_then(Value::as_bool).unwrap_or(false)
}

/// One schema definition + its `config list` entry → wire setting. Credentials never carry a
/// value or default.
fn map_definition(def: &Value, entry: Option<&Value>) -> Option<OmpSetting> {
    let id = def.get("id")?.as_str()?.to_string();
    let ui = def.get("ui").filter(|u| u.is_object());
    let ui_field = |k: &str| ui.and_then(|u| u.get(k));
    let redacted = flag(entry.and_then(|e| e.get("redacted")));
    let credential = flag(def.get("credential")) || flag(ui_field("secret")) || redacted;
    let (options, runtime_options) = match ui_field("options") {
        Some(Value::Array(a)) => (Some(a.iter().filter_map(map_option).collect()), false),
        Some(Value::String(s)) if s == "runtime" => (None, true),
        _ => (None, false),
    };
    let env = match def.get("env") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => str_of(o.get("name")),
        _ => None,
    };
    let value = match entry {
        _ if credential => None,
        Some(e) => e.get("value").cloned(),
        None => def.get("default").cloned(),
    };
    Some(OmpSetting {
        id,
        kind: str_of(def.get("type")).or_else(|| str_of(entry.and_then(|e| e.get("type")))).unwrap_or_else(|| "string".into()),
        value,
        default: if credential { None } else { def.get("default").cloned() },
        values: def.get("values").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()),
        tab: str_of(ui_field("tab")),
        group: str_of(ui_field("group")),
        label: str_of(ui_field("label")),
        description: str_of(ui_field("description")).or_else(|| str_of(entry.and_then(|e| e.get("description")))),
        options,
        runtime_options,
        condition: str_of(ui_field("condition")),
        warning: str_of(ui_field("warning")),
        editor: str_of(ui_field("editor")),
        credential,
        redacted,
        env,
        items: def.get("items").filter(|v| !v.is_null()).cloned(),
    })
}

fn map_option(o: &Value) -> Option<OmpSettingOption> {
    let value = match o.get("value")? {
        Value::String(s) => s.clone(),
        v @ (Value::Number(_) | Value::Bool(_)) => v.to_string(),
        _ => return None,
    };
    Some(OmpSettingOption { label: str_of(o.get("label")).unwrap_or_else(|| value.clone()), value, description: str_of(o.get("description")) })
}

/// Schema order; keys `config list` knows but the schema lacks are appended from the list.
fn map_schema(defs: &[Value], entries: &Entries) -> Vec<OmpSetting> {
    let by_key: HashMap<&str, &Value> = entries.iter().map(|(k, v)| (k.as_str(), v)).collect();
    let mut out: Vec<OmpSetting> = defs.iter().filter_map(|d| map_definition(d, d.get("id").and_then(Value::as_str).and_then(|id| by_key.get(id).copied()))).collect();
    let known: std::collections::HashSet<String> = out.iter().map(|s| s.id.clone()).collect();
    out.extend(entries.iter().filter(|(k, _)| !known.contains(k)).filter_map(|(k, e)| map_cli_entry(k, e)));
    out
}

/// `source: "cli"`: what `config list` alone says.
fn map_cli_entry(key: &str, e: &Value) -> Option<OmpSetting> {
    let def = serde_json::json!({ "id": key, "type": e.get("type").cloned().unwrap_or(Value::Null) });
    map_definition(&def, Some(e))
}

// ───────────────────────────── methods ─────────────────────────────

/// Most keys one `omp.settingValues` asks for.
const MAX_VALUE_KEYS: usize = 64;

async fn setting_values(omp: &Omp, keys: &[String]) -> Result<OmpSettingValues, ApiError> {
    if keys.len() > MAX_VALUE_KEYS {
        return Err(ApiError::new("invalid_params", format!("{} keys asked for; at most {MAX_VALUE_KEYS}", keys.len())));
    }
    let entries = values(omp, false).await?;
    Ok(OmpSettingValues { values: pick_values(&entries, keys) })
}

/// The current value (global config, else omp's default: what `config list` reports) of each of
/// `keys`. A key `config list` lacks, one without a value (unset, no default: `null`) and a
/// credential (omp marks it `redacted: true` and sends no value; a value next to that flag is
/// dropped too) are absent.
fn pick_values(entries: &Entries, keys: &[String]) -> BTreeMap<String, Value> {
    keys.iter()
        .filter_map(|key| {
            let entry = &entries.iter().find(|(k, _)| k == key)?.1;
            if flag(entry.get("redacted")) {
                return None;
            }
            entry.get("value").filter(|v| !v.is_null()).map(|v| (key.clone(), v.clone()))
        })
        .collect()
}

async fn settings(omp: &Omp, refresh: bool) -> Result<OmpSettings, ApiError> {
    let (schema, entries) = tokio::join!(schema(omp, refresh), values(omp, refresh));
    let entries = entries?;
    let config_path = Some(omp.config_path().display().to_string());
    match schema {
        Ok(s) => {
            let version = match s.omp_version.clone() {
                Some(v) => v,
                None => cli_version(omp).await,
            };
            Ok(OmpSettings { version, source: "schema".into(), settings: map_schema(&s.settings, &entries), config_path })
        }
        Err(reason) => {
            tracing::warn!("omp settings schema unavailable ({reason}); answering from `omp config list`");
            Ok(OmpSettings { version: cli_version(omp).await, source: "cli".into(), settings: entries.iter().filter_map(|(k, e)| map_cli_entry(k, e)).collect(), config_path })
        }
    }
}

async fn cli_version(omp: &Omp) -> String {
    let raw = omp.run(&["--version"]).await.map(|o| o.line()).unwrap_or_default();
    match parse_version(&raw) {
        Some((a, b, c)) => format!("{a}.{b}.{c}"),
        None => "unknown".into(),
    }
}

/// Text for `omp config set <key> <text>`. Strings go as-is unless omp's parser would change
/// them (it trims, and unquotes a leading `"`); then JSON-quoted, which omp unquotes exactly.
pub(crate) fn encode(kind: &str, v: &Value) -> Result<String, String> {
    match (kind, v) {
        ("string" | "enum", Value::String(s)) => {
            let plain = s.trim() == s && !s.starts_with('"') && !s.contains(['\n', '\r']);
            Ok(if plain { s.clone() } else { Value::String(s.clone()).to_string() })
        }
        ("number", Value::Number(n)) => Ok(n.to_string()),
        ("boolean", Value::Bool(b)) => Ok(b.to_string()),
        ("array", Value::Array(_)) | ("record", Value::Object(_)) => Ok(v.to_string()),
        ("string" | "enum" | "number" | "boolean" | "array" | "record", _) => Err(format!("expects a{} {kind}", if matches!(kind, "enum" | "array") { "n" } else { "" })),
        // A type this hostd does not know (newer omp): let omp parse it.
        (_, Value::String(s)) => Ok(s.clone()),
        (_, other) => Ok(other.to_string()),
    }
}

/// First line of omp's error output without its `Error: ` prefix.
fn omp_message(raw: &str) -> String {
    let line = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("omp failed");
    line.strip_prefix("Error: ").unwrap_or(line).to_string()
}

enum Write<'a> {
    Set(&'a str, String),
    Reset(&'a str),
}

/// Plans every change against the known keys before running any (a typo writes nothing).
fn plan<'a>(changes: &'a [OmpSettingChange], kinds: &HashMap<&str, &str>) -> Result<Vec<Write<'a>>, ApiError> {
    changes
        .iter()
        .map(|c| {
            let kind = kinds.get(c.key.as_str()).ok_or_else(|| ApiError::new("invalid_params", format!("unknown omp setting `{}`", c.key)))?;
            match &c.value {
                None | Some(Value::Null) => Ok(Write::Reset(&c.key)),
                Some(v) => encode(kind, v).map(|t| Write::Set(&c.key, t)).map_err(|e| ApiError::new("invalid_params", format!("{} {e}", c.key))),
            }
        })
        .collect()
}

/// Credential values never go into a command line (any local user can read
/// `/proc/<pid>/cmdline`): a batch that sets one is written by the companion extension's
/// settings-write mode instead of `omp config set`.
fn needs_bridge(writes: &[Write<'_>], credentials: &HashSet<&str>) -> bool {
    writes.iter().any(|w| matches!(w, Write::Set(key, _) if credentials.contains(key)))
}

/// Keys that are credentials: flagged by omp's schema; without a schema (`source: "cli"`) also
/// every key named like a secret, since omp's list only marks those already set.
fn credential_keys(current: &OmpSettings) -> HashSet<&str> {
    current
        .settings
        .iter()
        .filter(|s| s.credential || (current.source != "schema" && looks_secret(&s.id)))
        .map(|s| s.id.as_str())
        .collect()
}

fn looks_secret(key: &str) -> bool {
    let last = key.rsplit('.').next().unwrap_or(key).to_ascii_lowercase();
    ["token", "apikey", "api_key", "secret", "password", "passwd", "credential"].iter().any(|w| last.contains(w))
}

/// The settings-write input `{changes: [{key, text}]}` (`text: null` resets).
fn write_request(writes: &[Write<'_>]) -> Vec<u8> {
    let changes: Vec<Value> = writes
        .iter()
        .map(|w| match w {
            Write::Set(key, text) => serde_json::json!({ "key": key, "text": text }),
            Write::Reset(key) => serde_json::json!({ "key": key, "text": null }),
        })
        .collect();
    serde_json::to_vec(&serde_json::json!({ "changes": changes })).unwrap_or_default()
}

/// Parses the settings-write result `{bridgeVersion, results: [{key, ok, error?}], error?}`:
/// per applied change its key and failure, in order.
fn parse_write(bytes: &[u8]) -> Result<Vec<(String, Option<String>)>, String> {
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("settings write result: {e}"))?;
    if let Some(e) = v.get("error").and_then(Value::as_str) {
        return Err(e.to_string());
    }
    let results = v.get("results").and_then(Value::as_array).ok_or("settings write result: no results")?;
    Ok(results
        .iter()
        .map(|r| {
            let key = str_of(r.get("key")).unwrap_or_default();
            let failed = (!flag(r.get("ok"))).then(|| str_of(r.get("error")).unwrap_or_else(|| "omp refused the value".into()));
            (key, failed)
        })
        .collect())
}

enum BridgeWrite {
    /// The deployed extension cannot do it (missing, or older than 1.3.0): nothing was written.
    Unavailable(String),
    Failed(String),
}

/// Writes `writes` through a throwaway omp running the extension's settings-write mode: the
/// values travel in an owner-only file under `<home>/run` that the extension deletes on read
/// (and hostd right after), never in argv or the environment.
async fn write_via_bridge(omp: &Omp, writes: &[Write<'_>]) -> Result<Vec<(String, Option<String>)>, BridgeWrite> {
    let ext = std::fs::read_to_string(&omp.ext).map_err(|e| BridgeWrite::Unavailable(format!("companion extension {}: {e}", omp.ext.display())))?;
    if !ext.contains(WRITE_MARKER) {
        return Err(BridgeWrite::Unavailable("the deployed companion extension predates credential writes (bridge < 1.3.0)".into()));
    }
    let input = omp.scratch("omp-settings-in").map_err(BridgeWrite::Failed)?;
    let out = omp.scratch("omp-settings-out").map_err(BridgeWrite::Failed)?;
    crate::paths::write_atomic(&input, &write_request(writes)).map_err(|e| BridgeWrite::Failed(format!("{}: {e}", input.display())))?;
    let res = run_ext_mode(omp, &[(WRITE_MARKER, &input), (WRITE_OUT, &out)], &out, "the settings").await;
    let _ = std::fs::remove_file(&input);
    parse_write(&res.map_err(BridgeWrite::Failed)?).map_err(BridgeWrite::Failed)
}

/// Applies `writes` in order with `omp config set|reset -- <key> [<text>]` (no credential values:
/// see [`needs_bridge`]); stops at the first failure.
async fn write_via_cli(omp: &Omp, writes: &[Write<'_>]) -> Result<(), ApiError> {
    for w in writes {
        let (args, key) = match w {
            Write::Set(key, text) => (vec!["config", "set", "--", *key, text.as_str()], *key),
            Write::Reset(key) => (vec!["config", "reset", "--", *key], *key),
        };
        let res = omp.run(&args).await;
        let ok = matches!(&res, Ok(o) if o.ok());
        tracing::info!(key, reset = matches!(w, Write::Reset(_)), ok, "omp config write");
        match res {
            Ok(o) if o.ok() => {}
            Ok(o) => return Err(ApiError::new("invalid_params", format!("{key}: {}", omp_message(&o.message())))),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

async fn write_credentials(omp: &Omp, writes: &[Write<'_>], current: &OmpSettings, credentials: &HashSet<&str>) -> Result<(), ApiError> {
    let results = match write_via_bridge(omp, writes).await {
        Ok(r) => r,
        Err(BridgeWrite::Unavailable(reason)) => {
            tracing::warn!("credential write refused: {reason}");
            let keys: Vec<&str> = writes.iter().filter_map(|w| match w {
                Write::Set(k, _) if credentials.contains(k) => Some(*k),
                _ => None,
            }).collect();
            let envs: Vec<String> = current.settings.iter().filter(|s| keys.contains(&s.id.as_str())).filter_map(|s| s.env.as_ref().map(|e| format!("${e}"))).collect();
            let env_hint = if envs.is_empty() { String::new() } else { format!(", or set {} in omp's environment on the host", envs.join(" / ")) };
            return Err(ApiError::new(
                "unsupported",
                format!("{} is a credential: TeleFlock writes credentials only through its companion extension, which is not available here ({reason}). Nothing was saved.", keys.join(", ")),
            )
            .with_hint(format!("Reconnect with the current TeleFlock app so it deploys the new extension{env_hint}.")));
        }
        Err(BridgeWrite::Failed(e)) => return Err(ApiError::new("omp_error", format!("omp settings write: {e}"))),
    };
    for (i, w) in writes.iter().enumerate() {
        let key = match w {
            Write::Set(k, _) | Write::Reset(k) => *k,
        };
        let failed = match results.get(i) {
            Some((k, failed)) if k == key => failed.clone(),
            _ => Some("omp stopped before this change".into()),
        };
        tracing::info!(key, reset = matches!(w, Write::Reset(_)), ok = failed.is_none(), via = "bridge", "omp config write");
        if let Some(msg) = failed {
            return Err(ApiError::new("invalid_params", format!("{key}: {msg}")));
        }
    }
    Ok(())
}

async fn set(omp: &Omp, changes: &[OmpSettingChange]) -> Result<OmpSettings, ApiError> {
    let _writing = WRITES.lock().await;
    let current = settings(omp, false).await?;
    let kinds: HashMap<&str, &str> = current.settings.iter().map(|s| (s.id.as_str(), s.kind.as_str())).collect();
    let credentials = credential_keys(&current);
    let writes = plan(changes, &kinds)?;
    let written = if needs_bridge(&writes, &credentials) {
        write_credentials(omp, &writes, &current, &credentials).await
    } else {
        write_via_cli(omp, &writes).await
    };
    drop_values();
    if changes.iter().any(|c| c.key == "modelRoles") {
        crate::ops::host::invalidate_models().await;
    }
    written?;
    settings(omp, false).await
}

// ───────────────────────────── for `ops/hostsync` ─────────────────────────────

/// The daemon's omp config for another module (`ops/hostsync`). Shares the settings page's caches
/// and write lock.
pub(crate) struct OmpAt(Omp);

impl OmpAt {
    pub(crate) fn from_ctx(ctx: &Ctx) -> Result<OmpAt, ApiError> {
        Omp::from_ctx(ctx).map(OmpAt)
    }

    pub(crate) fn bin(&self) -> &Path {
        &self.0.bin
    }

    /// What every omp child gets: `NO_COLOR`, and the agent dir when it isn't the daemon's.
    pub(crate) fn env(&self) -> Vec<(&str, &str)> {
        self.0.env()
    }

    /// omp's settings as the settings page shows them (schema, current values, omp's version).
    pub(crate) async fn settings(&self) -> Result<OmpSettings, ApiError> {
        settings(&self.0, false).await
    }

    /// `omp config list --scope global --json` (omp ≥ 18.13.3): the keys omp's global layer sets,
    /// as written, in omp's order; omp redacts credentials.
    pub(crate) async fn global_layer(&self) -> Result<Vec<(String, Value)>, ApiError> {
        let out = self.0.run(&["config", "list", "--scope", "global", "--json"]).await?;
        if !out.ok() {
            return Err(ApiError::new("omp_error", format!("omp config list --scope global: {}", omp_message(&out.message()))));
        }
        parse_list(&out.stdout).map_err(|e| ApiError::new("omp_error", format!("omp config list --scope global output: {e}")))
    }

    /// `omp config get <key> --json`: the value omp uses, a credential's included (the source seals
    /// it). The output is wiped when dropped.
    pub(crate) async fn value(&self, key: &str) -> Result<Zeroizing<Vec<u8>>, ApiError> {
        let out = self.0.run(&["config", "get", key, "--json"]).await?;
        let ok = out.ok();
        let message = out.stderr.clone();
        let stdout = Zeroizing::new(out.stdout);
        if !ok {
            return Err(ApiError::new("omp_error", format!("omp config get {key}: {}", omp_message(&message))));
        }
        Ok(stdout)
    }

    /// Writes `changes` one at a time, each with its own outcome: a key this omp doesn't know or a
    /// value it refuses fails that change only. Credential values go through the companion
    /// extension's settings-write mode, never argv, as for `omp.settingsSet`.
    pub(crate) async fn set_each(&self, changes: &[OmpSettingChange]) -> Vec<Result<(), ApiError>> {
        let omp = &self.0;
        let _writing = WRITES.lock().await;
        let current = match settings(omp, false).await {
            Ok(c) => c,
            Err(e) => return changes.iter().map(|_| Err(e.clone())).collect(),
        };
        let kinds: HashMap<&str, &str> = current.settings.iter().map(|s| (s.id.as_str(), s.kind.as_str())).collect();
        let credentials = credential_keys(&current);
        let mut out = Vec::with_capacity(changes.len());
        for change in changes {
            out.push(match plan(std::slice::from_ref(change), &kinds) {
                Err(e) => Err(e),
                Ok(writes) if needs_bridge(&writes, &credentials) => write_credentials(omp, &writes, &current, &credentials).await,
                Ok(writes) => write_via_cli(omp, &writes).await,
            });
        }
        drop_values();
        if changes.iter().any(|c| c.key == "modelRoles") {
            crate::ops::host::invalidate_models().await;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SCHEMA_DUMP: &str = include_str!("testdata/omp-settings-schema-18.12.3.json");
    const CONFIG_LIST: &str = include_str!("testdata/omp-config-list-18.12.3.json");

    fn real() -> Vec<OmpSetting> {
        let (version, defs) = parse_dump(SCHEMA_DUMP.as_bytes()).unwrap();
        assert_eq!(version.as_deref(), Some("18.12.3"));
        map_schema(&defs, &parse_list(CONFIG_LIST.as_bytes()).unwrap())
    }

    fn find<'a>(all: &'a [OmpSetting], id: &str) -> &'a OmpSetting {
        all.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("{id} missing"))
    }

    #[test]
    fn maps_the_real_schema() {
        let all = real();
        assert_eq!(all.len(), 559);
        assert_eq!(all.iter().filter(|s| s.tab.is_some()).count(), 419);
        // Schema (settings panel) order, not alphabetical.
        assert_eq!(all[0].id, "auth.broker.url");

        let dark = find(&all, "theme.dark");
        assert_eq!((dark.tab.as_deref(), dark.group.as_deref(), dark.label.as_deref()), (Some("appearance"), Some("Theme"), Some("Dark Theme")));
        assert!(dark.runtime_options);
        assert_eq!(dark.value, Some(json!("titanium")));

        let timeout = find(&all, "loop.conditionTimeoutMs");
        assert_eq!(timeout.kind, "number");
        let opts = timeout.options.as_ref().unwrap();
        assert_eq!((opts[0].value.as_str(), opts[0].label.as_str()), ("0", "Unlimited"));

        let device = find(&all, "providers.tinyModelDevice");
        assert_eq!(device.kind, "enum");
        assert!(device.values.as_ref().unwrap().contains(&"cuda".to_string()));
        assert_eq!(device.env.as_deref(), Some("PI_TINY_DEVICE"));

        let segs = find(&all, "statusLine.leftSegments");
        assert_eq!(segs.items.as_ref().and_then(|i| i.get("label")), Some(&json!("status line segment")));

        assert_eq!(find(&all, "contextFiles.extra").editor.as_deref(), Some("json"));
        assert!(all.iter().any(|s| s.condition.as_deref() == Some("macOS")));

        let roles = find(&all, "modelRoles");
        assert_eq!(roles.kind, "record");
        assert!(roles.tab.is_none());
        assert_eq!(roles.value, Some(json!({"default": "anthropic/claude-opus-5-5:max", "designer": "openai/gpt-5"})));
    }

    #[test]
    fn credentials_never_carry_values() {
        let all = real();
        let token = find(&all, "auth.broker.token");
        assert!(token.credential && token.redacted);
        assert!(token.value.is_none() && token.default.is_none());
        assert_eq!(token.env.as_deref(), Some("OMP_AUTH_BROKER_TOKEN"));
        for s in all.iter().filter(|s| s.credential) {
            assert!(s.value.is_none() && s.default.is_none(), "{} leaks", s.id);
        }
        // Even if a definition says credential and the list (wrongly) had a value.
        let def = json!({"id": "x.key", "type": "string", "credential": true, "default": "d"});
        let s = map_definition(&def, Some(&json!({"value": "secret", "type": "string"}))).unwrap();
        assert!(s.value.is_none() && s.default.is_none());
    }

    #[test]
    fn cli_fallback_lists_every_key_in_omp_order() {
        let entries = parse_list(CONFIG_LIST.as_bytes()).unwrap();
        let all: Vec<OmpSetting> = entries.iter().filter_map(|(k, e)| map_cli_entry(k, e)).collect();
        assert_eq!(all.len(), 559);
        assert_eq!(all[0].id, "auth.broker.url");
        let token = find(&all, "auth.broker.token");
        assert!(token.credential && token.redacted && token.value.is_none());
        let t = find(&all, "loop.conditionTimeoutMs");
        // The captured config set it to -5 (`omp config set -- loop.conditionTimeoutMs -5`).
        assert_eq!((t.kind.as_str(), t.value.clone()), ("number", Some(json!(-5))));
        assert!(t.description.as_deref().unwrap().starts_with("Max wait"));
        assert!(t.label.is_none() && t.tab.is_none());
    }

    #[test]
    fn schema_keys_missing_from_the_list_and_back() {
        let defs = vec![json!({"id": "a.b", "type": "boolean", "default": true, "env": {"name": "A_B"}})];
        let entries = vec![("z.new".to_string(), json!({"value": 3, "type": "number", "description": ""}))];
        let all = map_schema(&defs, &entries);
        assert_eq!(all.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a.b", "z.new"]);
        assert_eq!(all[0].value, Some(json!(true)));
        assert_eq!(all[0].env.as_deref(), Some("A_B"));
    }

    #[test]
    fn picks_the_asked_for_values_and_never_a_credential() {
        let entries: Entries = vec![
            ("paste.largeMenuThreshold".into(), json!({"value": 250, "type": "number", "description": ""})),
            ("paste.largeMenuEnabled".into(), json!({"value": true, "type": "boolean", "description": ""})),
            ("theme.dark".into(), json!({"value": null, "type": "string", "description": ""})),
            ("auth.broker.token".into(), json!({"type": "string", "description": "", "redacted": true})),
            ("auth.leaky".into(), json!({"value": "s3cr3t", "type": "string", "description": "", "redacted": true})),
        ];
        let keys: Vec<String> = ["paste.largeMenuThreshold", "paste.largeMenuEnabled", "theme.dark", "auth.broker.token", "auth.leaky", "no.such.key"].map(String::from).into();
        let got = pick_values(&entries, &keys);
        assert_eq!(got, BTreeMap::from([("paste.largeMenuEnabled".to_string(), json!(true)), ("paste.largeMenuThreshold".to_string(), json!(250))]));
        // Only what was asked for.
        assert_eq!(pick_values(&entries, &["paste.largeMenuThreshold".to_string()]).len(), 1);
        assert!(pick_values(&entries, &[]).is_empty());
    }

    #[test]
    fn dump_errors() {
        assert!(parse_dump(br#"{"settings":null,"error":"Cannot find module"}"#).unwrap_err().contains("Cannot find module"));
        assert!(parse_dump(b"nope").is_err());
    }

    #[test]
    fn encodes_per_type() {
        assert_eq!(encode("string", &json!("titanium")).unwrap(), "titanium");
        assert_eq!(encode("string", &json!("")).unwrap(), "");
        assert_eq!(encode("string", &json!(" padded ")).unwrap(), r#"" padded ""#);
        assert_eq!(encode("string", &json!("\"q\"")).unwrap(), r#""\"q\"""#);
        assert_eq!(encode("string", &json!("a\nb")).unwrap(), r#""a\nb""#);
        assert_eq!(encode("enum", &json!("cuda")).unwrap(), "cuda");
        assert_eq!(encode("number", &json!(-5)).unwrap(), "-5");
        assert_eq!(encode("number", &json!(0.25)).unwrap(), "0.25");
        assert_eq!(encode("boolean", &json!(false)).unwrap(), "false");
        assert_eq!(encode("array", &json!(["a", "b"])).unwrap(), r#"["a","b"]"#);
        assert_eq!(encode("record", &json!({"default": "x/y:high"})).unwrap(), r#"{"default":"x/y:high"}"#);
        assert!(encode("number", &json!("5")).is_err());
        assert!(encode("boolean", &json!("yes")).is_err());
        assert!(encode("record", &json!([])).is_err());
        assert_eq!(encode("future", &json!({"a": 1})).unwrap(), r#"{"a":1}"#);
    }

    #[test]
    fn plans_reject_unknown_keys_before_writing() {
        let kinds: HashMap<&str, &str> = [("a", "number"), ("b", "boolean")].into();
        let ok = vec![OmpSettingChange { key: "a".into(), value: Some(json!(2)) }, OmpSettingChange { key: "b".into(), value: None }];
        let w = plan(&ok, &kinds).unwrap();
        assert!(matches!(w[0], Write::Set("a", ref t) if t == "2"));
        assert!(matches!(w[1], Write::Reset("b")));
        let bad = vec![OmpSettingChange { key: "a".into(), value: Some(json!(1)) }, OmpSettingChange { key: "nope".into(), value: Some(json!(1)) }];
        assert_eq!(plan(&bad, &kinds).err().unwrap().code, "invalid_params");
        let wrong = vec![OmpSettingChange { key: "b".into(), value: Some(json!("x")) }];
        assert!(plan(&wrong, &kinds).err().unwrap().message.contains("expects a boolean"));
    }

    #[test]
    fn omp_messages() {
        assert_eq!(omp_message("Error: Invalid value: bogus. Valid values: a, b\n"), "Invalid value: bogus. Valid values: a, b");
        assert_eq!(omp_message("Unknown setting: nope\n\nRun 'omp config list' to see available keys"), "Unknown setting: nope");
    }

    #[test]
    fn credentials_go_through_the_bridge_never_argv() {
        let all = real();
        let current = OmpSettings { version: "18.12.3".into(), source: "schema".into(), settings: all, config_path: None };
        let creds = credential_keys(&current);
        assert!(creds.contains("auth.broker.token") && creds.contains("searxng.basicPassword"));
        assert!(!creds.contains("theme.dark"));
        let kinds: HashMap<&str, &str> = current.settings.iter().map(|s| (s.id.as_str(), s.kind.as_str())).collect();
        let plain = vec![OmpSettingChange { key: "theme.dark".into(), value: Some(json!("titanium")) }];
        assert!(!needs_bridge(&plan(&plain, &kinds).unwrap(), &creds));
        // Resetting a credential carries no value: the CLI may do it.
        let reset = vec![OmpSettingChange { key: "auth.broker.token".into(), value: None }];
        assert!(!needs_bridge(&plan(&reset, &kinds).unwrap(), &creds));
        let mixed = vec![plain[0].clone(), OmpSettingChange { key: "auth.broker.token".into(), value: Some(json!("s3cr3t")) }];
        let writes = plan(&mixed, &kinds).unwrap();
        assert!(needs_bridge(&writes, &creds), "a batch with a credential goes whole through the bridge");
        // The value is only in the request file, never in the throwaway omp's argv.
        let req: Value = serde_json::from_slice(&write_request(&writes)).unwrap();
        assert_eq!(req, json!({"changes": [{"key": "theme.dark", "text": "titanium"}, {"key": "auth.broker.token", "text": "s3cr3t"}]}));
        let argv: Vec<String> = ext_mode_args(Path::new("/h/ext/teleflock-bridge.ts")).iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(!argv.iter().any(|a| a.contains("s3cr3t")) && argv.last().map(String::as_str) == Some("/h/ext/teleflock-bridge.ts"));
        // Without a schema (`config list` alone marks only credentials already set), keys named
        // like secrets count as credentials too.
        let unset_key = map_cli_entry("providers.exampleApiKey", &json!({"value": null, "type": "string"})).unwrap();
        assert!(!unset_key.credential);
        let mut cli = OmpSettings { source: "cli".into(), ..current };
        cli.settings.push(unset_key);
        assert!(credential_keys(&cli).contains("providers.exampleApiKey") && credential_keys(&cli).contains("auth.broker.token"));
        assert!(!credential_keys(&cli).contains("theme.dark"));
        assert!(looks_secret("x.apiKey") && looks_secret("searxng.basicPassword") && !looks_secret("statusLine.leftSegments"));
    }

    #[test]
    fn write_results() {
        let ok = parse_write(br#"{"bridgeVersion":"1.3.0","results":[{"key":"a","ok":true},{"key":"b","ok":false,"error":"Invalid value"}]}"#).unwrap();
        assert_eq!(ok, vec![("a".to_string(), None), ("b".to_string(), Some("Invalid value".to_string()))]);
        assert_eq!(parse_write(br#"{"results":[],"error":"omp settings are not initialized"}"#).unwrap_err(), "omp settings are not initialized");
        assert!(parse_write(b"{}").is_err());
    }

    #[cfg(unix)]
    fn fake_omp(dir: &Path, body: &str) -> Omp {
        let bin = dir.join("omp");
        crate::test_exe::write_exe(&bin, format!("#!/bin/sh\nD={}\n{body}", dir.display()));
        let ext = dir.join("ext.ts");
        std::fs::write(&ext, "// TF_OMP_SCHEMA_OUT TF_OMP_SETTINGS_IN").unwrap();
        Omp { bin, ext, cache_dir: dir.join("cache"), run_dir: dir.join("run"), agent_dir: Some(dir.join("agent")) }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn bridge_write_hands_the_value_over_in_a_private_file() {
        let td = tempfile::tempdir().unwrap();
        let omp = fake_omp(
            td.path(),
            r#"echo "$@" > "$D/argv"
stat -c %a "$TF_OMP_SETTINGS_IN" > "$D/mode"
cp "$TF_OMP_SETTINGS_IN" "$D/seen.json"
rm -f "$TF_OMP_SETTINGS_IN"
printf '{"bridgeVersion":"1.3.0","results":[{"key":"auth.broker.token","ok":true}]}' > "$TF_OMP_SETTINGS_OUT"
sleep 5
"#,
        );
        let writes = vec![Write::Set("auth.broker.token", "s3cr3t-value".into())];
        let Ok(results) = write_via_bridge(&omp, &writes).await else { panic!("bridge write failed") };
        assert_eq!(results, vec![("auth.broker.token".to_string(), None)]);
        let read = |f: &str| std::fs::read_to_string(td.path().join(f)).unwrap();
        assert!(!read("argv").contains("s3cr3t"), "argv: {}", read("argv"));
        assert_eq!(read("mode").trim(), "600");
        assert!(read("seen.json").contains("s3cr3t-value"));
        assert!(std::fs::read_dir(&omp.run_dir).unwrap().next().is_none(), "input and result files are gone");

        // An extension without the mode is never started for it.
        std::fs::write(&omp.ext, "// TF_OMP_SCHEMA_OUT only").unwrap();
        std::fs::remove_file(td.path().join("argv")).unwrap();
        assert!(matches!(write_via_bridge(&omp, &writes).await, Err(BridgeWrite::Unavailable(_))));
        assert!(!td.path().join("argv").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_list_older_than_a_write_is_not_cached() {
        let td = tempfile::tempdir().unwrap();
        let omp = fake_omp(td.path(), "sleep 0.4\necho '{\"a\":{\"value\":1,\"type\":\"number\",\"description\":\"\"}}'\n");
        // A write lands while `config list` runs: its (old) answer is used, not cached.
        let (listed, ()) = tokio::join!(values(&omp, true), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop_values();
        });
        assert_eq!(listed.unwrap().len(), 1);
        assert!(VALUES.lock().unwrap().is_none(), "a list older than the write must not fill the cache");
        values(&omp, true).await.unwrap();
        assert!(VALUES.lock().unwrap().is_some());
        drop_values();
    }

    /// Real omp on this machine, in a throwaway agent dir (the user's config is never touched;
    /// `TF_LAB_OMP_AGENT_DIR` picks a lab dir): `cargo test -p tf-hostd omp_config -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs omp ≥ 18.12 on PATH"]
    async fn real_omp_schema_and_round_trip() {
        let td = tempfile::tempdir().unwrap();
        let agent = std::env::var_os("TF_LAB_OMP_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| td.path().join("agent"));
        assert!(!agent.starts_with(home_dir().join(".omp")), "never the user's omp config");
        std::fs::create_dir_all(&agent).unwrap();
        let ext = td.path().join("ext").join("teleflock-bridge.ts");
        std::fs::create_dir_all(ext.parent().unwrap()).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-bridge/teleflock-bridge.ts"), &ext).unwrap();
        let omp = Omp { bin: omp_bin().expect("omp"), ext: ext.clone(), cache_dir: td.path().join("cache"), run_dir: td.path().join("run"), agent_dir: Some(agent.clone()) };

        let started = Instant::now();
        let s = settings(&omp, true).await.unwrap();
        println!("omp {} source={} settings={} in {:?}", s.version, s.source, s.settings.len(), started.elapsed());
        assert_eq!(s.source, "schema");
        assert!(s.settings.len() > 400);
        assert!(find(&s.settings, "compaction.enabled").label.is_some());
        assert!(td.path().join("cache").join(SCHEMA_CACHE_FILE).is_file());
        assert!(std::fs::read_dir(td.path().join("run")).unwrap().next().is_none(), "dump file cleaned up");

        let changes = vec![
            OmpSettingChange { key: "theme.dark".into(), value: Some(json!(" spaced ")) },
            OmpSettingChange { key: "compaction.enabled".into(), value: Some(json!(false)) },
            OmpSettingChange { key: "loop.conditionTimeoutMs".into(), value: Some(json!(-5)) },
            OmpSettingChange { key: "modelRoles".into(), value: Some(json!({"default": "anthropic/claude-opus-5-5:max", "designer": "openai/gpt-5"})) },
            OmpSettingChange { key: "statusLine.leftSegments".into(), value: Some(json!(["model", "git"])) },
        ];
        let s = set(&omp, &changes).await.unwrap();
        assert_eq!(find(&s.settings, "theme.dark").value, Some(json!(" spaced ")));
        assert_eq!(find(&s.settings, "compaction.enabled").value, Some(json!(false)));
        assert_eq!(find(&s.settings, "loop.conditionTimeoutMs").value, Some(json!(-5)));
        assert_eq!(find(&s.settings, "modelRoles").value.as_ref().and_then(|v| v.get("designer")), Some(&json!("openai/gpt-5")));
        let yml = std::fs::read_to_string(agent.join("config.yml")).unwrap();
        assert!(yml.contains("designer: openai/gpt-5"), "{yml}");

        let err = set(&omp, &[OmpSettingChange { key: "providers.tinyModelDevice".into(), value: Some(json!("bogus")) }]).await.unwrap_err();
        println!("enum error: {}", err.message);
        assert_eq!(err.code, "invalid_params");
        assert!(err.message.contains("Valid values"), "{}", err.message);

        let s = set(&omp, &[OmpSettingChange { key: "theme.dark".into(), value: None }]).await.unwrap();
        let dark = find(&s.settings, "theme.dark");
        assert_eq!(dark.value, dark.default);

        // A credential: write-only, and never in any process's command line while it is written.
        // Positive control: a process carrying a marker in its argv is seen by the same scan.
        let secret = format!("tf-lab-secret-{}", std::process::id());
        let control = format!("tf-lab-control-{}", std::process::id());
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let scanner = {
            let (stop, secret, control) = (stop.clone(), secret.clone(), control.clone());
            std::thread::spawn(move || {
                let (mut scans, mut hits, mut seen_control) = (0u64, Vec::new(), false);
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    for p in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
                        let Ok(cmd) = std::fs::read(p.path().join("cmdline")) else { continue };
                        let cmd = String::from_utf8_lossy(&cmd).replace('\0', " ");
                        seen_control |= cmd.contains(&control);
                        if cmd.contains(&secret) {
                            hits.push(cmd);
                        }
                    }
                    scans += 1;
                }
                (scans, hits, seen_control)
            })
        };
        let mut control_proc = std::process::Command::new("sh").args(["-c", "sleep 1", &control]).spawn().unwrap();
        let s = set(&omp, &[
            OmpSettingChange { key: "theme.dark".into(), value: Some(json!("titanium")) },
            OmpSettingChange { key: "auth.broker.token".into(), value: Some(json!(secret)) },
        ])
        .await
        .unwrap();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = control_proc.wait();
        let (scans, hits, seen_control) = scanner.join().unwrap();
        println!("credential write: {scans} scans of /proc/*/cmdline, control seen: {seen_control}, secret hits: {}", hits.len());
        assert!(seen_control, "the scan must see argv markers");
        assert!(scans > 10 && hits.is_empty(), "secret in argv: {hits:?}");
        let token = find(&s.settings, "auth.broker.token");
        assert!(token.redacted && token.value.is_none());
        assert_eq!(find(&s.settings, "theme.dark").value, Some(json!("titanium")), "the rest of the batch landed too");
        assert!(!serde_json::to_string(&s).unwrap().contains(&secret));
        let yml = std::fs::read_to_string(agent.join("config.yml")).unwrap();
        assert!(yml.contains(&secret), "the token reached omp's config");
        assert!(std::fs::read_dir(td.path().join("run")).unwrap().next().is_none(), "no input file left behind");
        // A bad value inside a credential batch: omp's message, the batch stops there.
        let err = set(&omp, &[
            OmpSettingChange { key: "auth.broker.token".into(), value: Some(json!("x")) },
            OmpSettingChange { key: "providers.tinyModelDevice".into(), value: Some(json!("bogus")) },
        ])
        .await
        .unwrap_err();
        println!("bridge enum error: {}", err.message);
        assert!(err.code == "invalid_params" && err.message.contains("Valid values"), "{err:?}");

        // An older extension (no write mode): refused, nothing written, the hint names the env override.
        std::fs::write(&ext, std::fs::read_to_string(&ext).unwrap().replace(WRITE_MARKER, "TF_OMP_NOPE")).unwrap();
        let err = set(&omp, &[OmpSettingChange { key: "auth.broker.token".into(), value: Some(json!("never-written")) }]).await.unwrap_err();
        println!("old extension: {} / {:?}", err.message, err.hint);
        assert_eq!(err.code, "unsupported");
        assert!(err.hint.as_deref().is_some_and(|h| h.contains("$OMP_AUTH_BROKER_TOKEN")));
        assert!(!std::fs::read_to_string(agent.join("config.yml")).unwrap().contains("never-written"));
    }
}
