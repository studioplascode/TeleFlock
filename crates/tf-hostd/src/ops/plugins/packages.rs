//! `plugins.*`: package plugins (npm, git, local folders), marketplace plugins, marketplaces and
//! their catalogs.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tf_proto::{
    ApiError, InstallScope, MarketplaceAddParams, MarketplaceRefParams, PluginCatalog, PluginDiscoverParams, PluginEnableParams,
    PluginInstallParams, PluginList, PluginRef, PluginUpgradeParams, PluginsChanged,
};

use super::{apply, cli, decode, no_reload, scope_folder, Plugins};
use crate::ops::mcp::{folder, reload};
use crate::ops::Ctx;

const LIST_TIMEOUT: Duration = Duration::from_secs(20);
/// Installs and upgrades download (`bun install`, `git clone`); the app waits 300 s for the
/// answer, which also needs the list read afterwards.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(240);
/// Removals and switches (a package plugin's `bun uninstall`, a runtime package re-linked).
const CHANGE_TIMEOUT: Duration = Duration::from_secs(120);

/// How a package plugin's change reaches running sessions.
const PACKAGE_NOTE: &str =
    "A package plugin's code (extensions, tools, hooks) loads when an omp session starts: running sessions keep what they loaded until they are restarted.";

pub(super) async fn list(pl: &Plugins, folder: Option<&Path>) -> Result<PluginList, ApiError> {
    let (answer, version) = pl.read(folder, json!({ "op": "plugins", "project": folder.is_some() }), LIST_TIMEOUT).await?;
    let mut list: PluginList = decode(answer, "plugin list")?;
    list.cwd = folder.map(|f| f.to_string_lossy().into_owned());
    list.omp_version = version;
    Ok(list)
}

pub(super) async fn discover(pl: &Plugins, p: PluginDiscoverParams) -> Result<PluginCatalog, ApiError> {
    let folder = folder(p.cwd.as_deref())?;
    let marketplace = p.marketplace.as_deref().map(|m| cli::arg("marketplace", m)).transpose()?;
    let req = json!({ "op": "catalog", "marketplace": marketplace, "project": folder.is_some() });
    let (answer, _) = pl.read(folder.as_deref(), req, LIST_TIMEOUT).await?;
    decode(answer, "plugin catalog")
}

/// Whether `id` (or an install spec) names a marketplace plugin: `name@marketplace` of a
/// marketplace omp knows (package specs may hold an `@` too: `@scope/pkg@1.2`).
pub(super) fn is_marketplace_plugin(id: &str, list: &PluginList) -> bool {
    list.marketplace.iter().any(|m| m.id == id)
        || id.rsplit_once('@').is_some_and(|(name, market)| !name.is_empty() && list.marketplaces.iter().any(|m| m.name == market))
}

/// What `omp plugin <args>` runs in: the project for a `project` scope, else no project.
fn target(scope: Option<InstallScope>, cwd: Option<&str>) -> Result<Option<PathBuf>, ApiError> {
    match scope {
        Some(s) => scope_folder(s, cwd),
        None => Ok(None),
    }
}

fn scope_args(scope: Option<InstallScope>) -> [&'static str; 2] {
    match scope {
        Some(InstallScope::Project) => ["--scope", "project"],
        _ => ["--scope", "user"],
    }
}

/// Runs `omp plugin <args>` and answers with the list of `cwd`. When it changed something, the
/// sessions it concerns reload (`/reload-plugins`); `plugin` (absent: every marketplace plugin
/// with an update) decides whether the change also needs a restart (a package plugin's code).
async fn change(
    ctx: &Ctx,
    pl: &Plugins,
    cwd: Option<&str>,
    run_in: Option<PathBuf>,
    args: Vec<&str>,
    timeout: Duration,
    plugin: Option<&str>,
) -> Result<PluginsChanged, ApiError> {
    let shown = folder(cwd)?;
    let dir = pl.cwd_for(run_in.as_deref())?;
    let out = apply(pl, &dir, &args, timeout, cli::plugin_failure).await?;
    let changes = cli::changes(&out);
    let changed = !cli::nothing_changed(&out);
    let (list, reload) = tokio::join!(list(pl, shown.as_deref()), async {
        if changed {
            reload::reload_plugins(ctx, run_in.as_deref()).await
        } else {
            no_reload()
        }
    });
    let list = list.map_err(|e| ApiError { hint: Some("The change was made; reading the plugins again failed.".into()), ..e })?;
    let note = plugin.filter(|id| changed && !is_marketplace_plugin(id, &list)).map(|_| PACKAGE_NOTE.to_string());
    Ok(PluginsChanged { list, reload, changes, note })
}

pub(super) async fn install(ctx: &Ctx, pl: &Plugins, p: PluginInstallParams) -> Result<PluginsChanged, ApiError> {
    let spec = cli::arg("spec", &p.spec)?;
    let run_in = target(p.scope, p.cwd.as_deref())?;
    let mut args = vec!["plugin", "install", spec];
    if p.scope.is_some() {
        args.extend(scope_args(p.scope));
    }
    if p.force == Some(true) {
        args.push("--force");
    }
    change(ctx, pl, p.cwd.as_deref(), run_in, args, INSTALL_TIMEOUT, Some(spec)).await
}

pub(super) async fn remove(ctx: &Ctx, pl: &Plugins, p: PluginRef) -> Result<PluginsChanged, ApiError> {
    let id = cli::arg("id", &p.id)?;
    let run_in = target(p.scope, p.cwd.as_deref())?;
    let mut args = vec!["plugin", "uninstall", id];
    if p.scope.is_some() {
        args.extend(scope_args(p.scope));
    }
    change(ctx, pl, p.cwd.as_deref(), run_in, args, CHANGE_TIMEOUT, Some(id)).await
}

pub(super) async fn set_enabled(ctx: &Ctx, pl: &Plugins, p: PluginEnableParams) -> Result<PluginsChanged, ApiError> {
    let id = cli::arg("id", &p.id)?;
    let run_in = target(p.scope, p.cwd.as_deref())?;
    let mut args = vec!["plugin", if p.enabled { "enable" } else { "disable" }, id];
    if p.scope.is_some() {
        args.extend(scope_args(p.scope));
    }
    change(ctx, pl, p.cwd.as_deref(), run_in, args, CHANGE_TIMEOUT, Some(id)).await
}

pub(super) async fn upgrade(ctx: &Ctx, pl: &Plugins, p: PluginUpgradeParams) -> Result<PluginsChanged, ApiError> {
    let id = p.id.as_deref().map(|i| cli::arg("id", i)).transpose()?;
    let run_in = target(p.scope, p.cwd.as_deref())?;
    let mut args = vec!["plugin", "upgrade"];
    if let Some(id) = id {
        args.push(id);
        if p.scope.is_some() {
            args.extend(scope_args(p.scope));
        }
    }
    change(ctx, pl, p.cwd.as_deref(), run_in, args, INSTALL_TIMEOUT, id).await
}

pub(super) async fn marketplace_add(pl: &Plugins, p: MarketplaceAddParams) -> Result<PluginsChanged, ApiError> {
    let source = cli::arg("source", &p.source)?;
    marketplace_change(pl, p.cwd.as_deref(), vec!["plugin", "marketplace", "add", source], INSTALL_TIMEOUT).await
}

pub(super) async fn marketplace_remove(pl: &Plugins, p: MarketplaceRefParams) -> Result<PluginsChanged, ApiError> {
    let name = cli::arg("name", p.name.as_deref().unwrap_or_default())?;
    marketplace_change(pl, p.cwd.as_deref(), vec!["plugin", "marketplace", "remove", name], CHANGE_TIMEOUT).await
}

pub(super) async fn marketplace_update(pl: &Plugins, p: MarketplaceRefParams) -> Result<PluginsChanged, ApiError> {
    let mut args = vec!["plugin", "marketplace", "update"];
    if let Some(name) = p.name.as_deref() {
        args.push(cli::arg("name", name)?);
    }
    marketplace_change(pl, p.cwd.as_deref(), args, INSTALL_TIMEOUT).await
}

/// A marketplace change: catalogs only, no installed plugin changes, so no session reloads.
async fn marketplace_change(pl: &Plugins, cwd: Option<&str>, args: Vec<&str>, timeout: Duration) -> Result<PluginsChanged, ApiError> {
    let shown = folder(cwd)?;
    let dir = pl.cwd_for(None)?;
    let out = apply(pl, &dir, &args, timeout, cli::plugin_failure).await?;
    let list = list(pl, shown.as_deref()).await.map_err(|e| ApiError { hint: Some("The change was made; reading the plugins again failed.".into()), ..e })?;
    Ok(PluginsChanged { list, reload: no_reload(), changes: cli::changes(&out), note: None })
}
