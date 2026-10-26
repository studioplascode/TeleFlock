//! `omp.*` methods: omp's settings schema and global config (architecture §3.4, §8).
//!
//! - **Schema**: omp's `config/all-settings` registry (ids, types, defaults, enum values, settings
//!   panel tab/group/label/description/options, conditions, warnings, env overrides, credentials),
//!   read by starting a throwaway headless `omp --mode rpc` with the companion extension in its
//!   schema-dump mode (`TF_OMP_SCHEMA_OUT`, docs/bridge-protocol.md "Schema dump"). Cached per omp
//!   binary (path + size + mtime) in memory and in `<home>/cache/omp-settings-schema.json`.
//! - **Values**: `omp config list --json` (global config, else defaults; credentials redacted by
//!   omp itself), cached [`VALUES_TTL`] and dropped after every write.
//! - **Writes**: `omp config set|reset -- <key> [<value>]`, one change at a time, never through a
//!   shell. omp validates (enum values, item vocabularies, JSON shapes); its message comes back as
//!   `invalid_params`.
//! - Without a readable schema (older omp or companion extension) the answer is `source: "cli"`,
//!   built from `config list` alone: every key is still listed and editable, without labels.
//!
//! Credential values never leave the host: not in answers, not in logs (writes log keys only).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tf_proto::{ApiError, HostMethod, OmpSetting, OmpSettingChange, OmpSettingOption, OmpSettings};

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

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::OmpSettingsGet(p) => to_value(settings(&Omp::from_ctx(ctx)?, p.refresh.unwrap_or(false)).await?),
        HostMethod::OmpSettingsSet(p) => to_value(set(&Omp::from_ctx(ctx)?, &p.changes).await?),
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
    std::fs::create_dir_all(&omp.run_dir).map_err(|e| format!("{}: {e}", omp.run_dir.display()))?;
    let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let out = omp.run_dir.join(format!("omp-schema-{}-{nanos}.json", std::process::id()));
    let mut cmd = tokio::process::Command::new(&omp.bin);
    cmd.args(["--mode", "rpc", "--no-session", "--no-skills", "--no-rules", "--no-lsp", "--no-tools", "--no-extensions", "-e"])
        .arg(&omp.ext)
        .current_dir(home_dir())
        .env(DUMP_MARKER, &out)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
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
            let _ = std::fs::remove_file(&out);
            return Err(format!("omp exited ({status}) without writing the schema"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(&out);
            return Err(format!("omp did not write its settings schema within {}s", SCHEMA_TIMEOUT.as_secs()));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // One more look at the file after the child is gone (it writes, then exits).
        exited = child.try_wait().ok().flatten();
    }
    let _ = child.kill().await;
    let bytes = std::fs::read(&out).map_err(|e| format!("read schema dump: {e}"));
    let _ = std::fs::remove_file(&out);
    parse_dump(&bytes?)
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
/// Serializes writes (each `omp config set` rewrites config.yml).
static WRITES: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn drop_values() {
    *VALUES.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

async fn values(omp: &Omp, refresh: bool) -> Result<Arc<Entries>, ApiError> {
    let config = omp.config_path();
    if !refresh {
        let cache = VALUES.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = cache.as_ref().filter(|c| c.config == config && c.at.elapsed() < VALUES_TTL) {
            return Ok(c.entries.clone());
        }
    }
    let out = omp.run(&["config", "list", "--json"]).await?;
    if !out.ok() {
        return Err(ApiError::new("omp_error", format!("omp config list: {}", omp_message(&out.message()))));
    }
    let entries = Arc::new(parse_list(&out.stdout).map_err(|e| ApiError::new("omp_error", format!("omp config list output: {e}")))?);
    *VALUES.lock().unwrap_or_else(|p| p.into_inner()) = Some(ValuesCache { config, at: Instant::now(), entries: entries.clone() });
    Ok(entries)
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

async fn set(omp: &Omp, changes: &[OmpSettingChange]) -> Result<OmpSettings, ApiError> {
    let _writing = WRITES.lock().await;
    let current = settings(omp, false).await?;
    let kinds: HashMap<&str, &str> = current.settings.iter().map(|s| (s.id.as_str(), s.kind.as_str())).collect();
    let writes = plan(changes, &kinds)?;
    let mut failure = None;
    for w in &writes {
        let (args, key) = match w {
            Write::Set(key, text) => (vec!["config", "set", "--", *key, text.as_str()], *key),
            Write::Reset(key) => (vec!["config", "reset", "--", *key], *key),
        };
        let res = omp.run(&args).await;
        let ok = matches!(&res, Ok(o) if o.ok());
        tracing::info!(key, reset = matches!(w, Write::Reset(_)), ok, "omp config write");
        match res {
            Ok(o) if o.ok() => {}
            Ok(o) => {
                failure = Some(ApiError::new("invalid_params", format!("{key}: {}", omp_message(&o.message()))));
                break;
            }
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    drop_values();
    if changes.iter().any(|c| c.key == "modelRoles") {
        crate::ops::host::invalidate_models().await;
    }
    match failure {
        Some(e) => Err(e),
        None => settings(omp, false).await,
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

    /// Real omp on this machine, in a throwaway agent dir (the user's config is never touched):
    /// `cargo test -p tf-hostd omp_config -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "needs omp ≥ 18.12 on PATH"]
    async fn real_omp_schema_and_round_trip() {
        let td = tempfile::tempdir().unwrap();
        let agent = td.path().join("agent");
        std::fs::create_dir_all(&agent).unwrap();
        let ext = td.path().join("ext").join("teleflock-bridge.ts");
        std::fs::create_dir_all(ext.parent().unwrap()).unwrap();
        std::fs::copy(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-bridge/teleflock-bridge.ts"), &ext).unwrap();
        let omp = Omp { bin: omp_bin().expect("omp"), ext, cache_dir: td.path().join("cache"), run_dir: td.path().join("run"), agent_dir: Some(agent.clone()) };

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

        // A credential: write-only.
        let s = set(&omp, &[OmpSettingChange { key: "auth.broker.token".into(), value: Some(json!("sekrit")) }]).await.unwrap();
        let token = find(&s.settings, "auth.broker.token");
        assert!(token.redacted && token.value.is_none());
        assert!(!serde_json::to_string(&s).unwrap().contains("sekrit"));
    }
}
