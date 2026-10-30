//! `skills.*`: the skills omp sessions load, Skillshare registry installs and the registry search.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tf_proto::{
    ApiError, InstallScope, Millis, RegistrySkill, SkillEnableParams, SkillInstallParams, SkillList, SkillRemoveParams, SkillSearchParams,
    SkillSearchResult, SkillUpdateParams, SkillsChanged,
};

use super::{apply, cli, decode, no_reload, scope_folder, Plugins};
use crate::ops::mcp::{folder, reload};
use crate::ops::{omp_config, Ctx};

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
/// With the registry asked about every registry skill.
const UPDATES_TIMEOUT: Duration = Duration::from_secs(30);
const SEARCH_TIMEOUT: Duration = Duration::from_secs(25);
/// `omp skill install|update` (downloads) and `uninstall`; the app waits 300 s for the answer,
/// which also needs the list read afterwards.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(240);
const REMOVE_TIMEOUT: Duration = Duration::from_secs(60);

/// The setting omp switches skills off with (`skill:<name>` entries).
const DISABLED: &str = "disabledExtensions";
/// Switches read, change and write that one setting: one at a time.
static SWITCHES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The last update check per list folder (`""`: user level): when, and what the registry said.
type Checks = HashMap<String, (Millis, Vec<RegistrySkill>)>;
static CHECKS: LazyLock<Mutex<Checks>> = LazyLock::new(Default::default);

fn key(folder: Option<&Path>) -> String {
    folder.map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The last check of the list's folder: when it ran, and what it said about each install whose
/// version is still the one it was asked about (an install added or updated since got a version the
/// registry served then).
pub(super) fn merge_check(list: &mut SkillList, check: &(Millis, Vec<RegistrySkill>)) {
    for r in &mut list.registry {
        if let Some(c) = check.1.iter().find(|c| c.id == r.id && c.scope == r.scope && c.version == r.version) {
            r.update = c.update.clone();
            r.latest = c.latest.clone();
            r.description = c.description.clone();
            r.deprecated = c.deprecated.clone();
            r.yanked = c.yanked;
            r.update_error = c.update_error.clone();
        }
    }
    list.updates_checked_at = Some(check.0);
}

/// The skills a session in `folder` loads (user level without one), switched-off ones included.
pub(super) async fn list(pl: &Plugins, folder: Option<&Path>, updates: bool) -> Result<SkillList, ApiError> {
    let req = json!({
        "op": "skills",
        "agentDir": pl.agent_dir,
        "project": folder.is_some(),
        "updates": updates,
    });
    let (answer, version) = pl.read(folder, req, if updates { UPDATES_TIMEOUT } else { LIST_TIMEOUT }).await?;
    let mut list: SkillList = decode(answer, "skill list")?;
    list.cwd = folder.map(|f| f.to_string_lossy().into_owned());
    list.omp_version = version;
    let mut checks = CHECKS.lock().unwrap_or_else(|p| p.into_inner());
    match list.updates_checked_at {
        Some(at) if updates => {
            checks.insert(key(folder), (at, list.registry.clone()));
        }
        _ => {
            if let Some(check) = checks.get(&key(folder)) {
                merge_check(&mut list, check);
            }
        }
    }
    Ok(list)
}

pub(super) async fn search(pl: &Plugins, p: SkillSearchParams) -> Result<SkillSearchResult, ApiError> {
    let query = p.query.trim();
    if query.is_empty() {
        return Err(ApiError::new("invalid_params", "query: type something to search for"));
    }
    let sort = match p.sort.as_deref() {
        None | Some("relevance") => "relevance",
        Some("downloads") => "downloads",
        Some("recent") => "recent",
        Some(other) => return Err(ApiError::new("invalid_params", format!("sort: `{other}` is not relevance, downloads or recent"))),
    };
    let folder = folder(p.cwd.as_deref())?;
    let req = json!({
        "op": "search",
        "query": query,
        "sort": sort,
        "page": p.page.unwrap_or(1).max(1),
        "agentDir": pl.agent_dir,
        "project": folder.is_some(),
    });
    let (answer, _) = pl.read(folder.as_deref(), req, SEARCH_TIMEOUT).await?;
    decode(answer, "registry search")
}

fn skill_id(raw: &str) -> Result<&str, ApiError> {
    let id = cli::arg("id", raw)?;
    if !cli::is_skill_spec(id, false) {
        return Err(ApiError::new("invalid_params", format!("id: `{id}` is not a registry skill (@scope/name)")));
    }
    Ok(id)
}

/// Runs `omp skill <args>` for a `scope` change and answers with the list of `cwd` and what
/// reached running sessions.
async fn change(ctx: &Ctx, pl: &Plugins, scope: InstallScope, cwd: Option<&str>, args: Vec<&str>, timeout: Duration) -> Result<SkillsChanged, ApiError> {
    let target = scope_folder(scope, cwd)?;
    let shown = folder(cwd)?;
    let run_in = pl.cwd_for(target.as_deref())?;
    let mut args = args;
    if scope == InstallScope::User {
        args.push("-g");
    }
    let out = apply(pl, &run_in, &args, timeout, cli::skill_failure).await?;
    let changed = !cli::nothing_changed(&out);
    let changes = cli::changes(&out);
    answer(ctx, pl, shown, changed.then_some(target), changes, None).await
}

/// The list after a change, and the reload of the sessions it concerns (`reload`: `Some(folder)`,
/// `Some(None)` = every session).
async fn answer(ctx: &Ctx, pl: &Plugins, shown: Option<PathBuf>, reload: Option<Option<PathBuf>>, changes: Vec<String>, note: Option<String>) -> Result<SkillsChanged, ApiError> {
    let (list, reload) = tokio::join!(list(pl, shown.as_deref(), false), async {
        match &reload {
            Some(folder) => reload::reload_plugins(ctx, folder.as_deref()).await,
            None => no_reload(),
        }
    });
    let list = list.map_err(|e| ApiError { hint: Some("The change was made; reading the skills again failed.".into()), ..e })?;
    Ok(SkillsChanged { list, reload, changes, note })
}

pub(super) async fn install(ctx: &Ctx, pl: &Plugins, p: SkillInstallParams) -> Result<SkillsChanged, ApiError> {
    let spec = cli::arg("spec", &p.spec)?;
    if !cli::is_skill_spec(spec, true) {
        return Err(ApiError::new("invalid_params", format!("spec: `{spec}` is not a registry skill (@scope/name[@version])")));
    }
    let mut args = vec!["skill", "install", spec];
    if p.allow_scripts == Some(true) {
        args.push("--yes");
    }
    change(ctx, pl, p.scope, p.cwd.as_deref(), args, INSTALL_TIMEOUT).await
}

pub(super) async fn update(ctx: &Ctx, pl: &Plugins, p: SkillUpdateParams) -> Result<SkillsChanged, ApiError> {
    let mut args = vec!["skill", "update"];
    if let Some(id) = p.id.as_deref() {
        args.push(skill_id(id)?);
    }
    if p.allow_scripts == Some(true) {
        args.push("--yes");
    }
    change(ctx, pl, p.scope, p.cwd.as_deref(), args, INSTALL_TIMEOUT).await
}

pub(super) async fn remove(ctx: &Ctx, pl: &Plugins, p: SkillRemoveParams) -> Result<SkillsChanged, ApiError> {
    let id = skill_id(&p.id)?;
    change(ctx, pl, p.scope, p.cwd.as_deref(), vec!["skill", "uninstall", id], REMOVE_TIMEOUT).await
}

/// `disabledExtensions` with `name` switched on or off; `None` when it already is. Switching on
/// also drops the bare name of a namespaced skill (`<ns>/<name>`): omp matches both.
pub(super) fn switched(current: &[Value], name: &str, enabled: bool) -> Option<Vec<Value>> {
    let id = format!("skill:{name}");
    let base = name.rsplit_once('/').map(|(_, b)| format!("skill:{b}"));
    let is_off = |v: &Value| v.as_str().is_some_and(|s| s == id || base.as_deref() == Some(s));
    if enabled {
        let next: Vec<Value> = current.iter().filter(|v| !is_off(v)).cloned().collect();
        (next.len() != current.len()).then_some(next)
    } else if current.iter().any(|v| v.as_str() == Some(&id)) {
        None
    } else {
        let mut next = current.to_vec();
        next.push(Value::String(id));
        Some(next)
    }
}

pub(super) async fn set_enabled(ctx: &Ctx, pl: &Plugins, p: SkillEnableParams) -> Result<SkillsChanged, ApiError> {
    let name = p.name.trim();
    if name.is_empty() || name.len() > 300 || name.chars().any(char::is_control) {
        return Err(ApiError::new("invalid_params", "name: not a skill name"));
    }
    let shown = folder(p.cwd.as_deref())?;
    {
        // Its own lock, not `CHANGES`: an install can hold that for minutes, and this is a config write.
        let _one = SWITCHES.lock().await;
        let current = omp_config::global_value(ctx, DISABLED, true).await?;
        let current = current.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(next) = switched(&current, name, p.enabled) {
            omp_config::set_json(ctx, DISABLED, &Value::Array(next)).await?;
        }
    }
    let change = format!("{} {name}", if p.enabled { "Switched on" } else { "Switched off" });
    let note = "omp applies skill switches to running sessions by itself (it watches its config file).".to_string();
    answer(ctx, pl, shown, None, vec![change], Some(note)).await
}
