//! `skills.*` and `plugins.*`: omp's skills and plugins on this host (architecture §3.26, wire
//! types `tf_proto::plugins`).
//!
//! - **Reads** run omp's own code: the helper extension `host/teleflock-plugins/teleflock-plugins.ts`
//!   (embedded; run by the MCP helper's runner, `ops/mcp/helper.rs`, with its own [`HELPER`] spec
//!   and slots) discovers skills exactly as a session does (switched-off ones included), reads the
//!   registry installs (`skills.json` / `skills.lock.json`), asks the Skillshare registry about
//!   updates and searches, and lists package plugins, marketplace plugins, marketplaces and their
//!   catalogs.
//! - **Changes** run omp's CLI (`cli.rs`: `omp skill install|update|uninstall`, `omp plugin
//!   install|uninstall|enable|disable|upgrade|marketplace …`), without a shell or TTY, in the
//!   project folder or an empty one, one change at a time. Skill switches write omp's
//!   `disabledExtensions` (`skill:<name>`) through `omp config set`.
//! - **Running sessions** get installs, updates, removals and plugin switches through omp's
//!   `/reload-plugins` (`ops/mcp/reload.rs`); omp applies `disabledExtensions` by itself (it
//!   watches its config file).

mod cli;
mod packages;
mod skills;
#[cfg(all(test, unix))]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use serde_json::Value;
use tf_proto::{ApiError, HostMethod, InstallScope, McpReload};

use crate::ops::host::{omp_agent_dir, omp_bin};
use crate::ops::mcp::helper::{self, HelperEnv, HelperSpec, Slots};
use crate::ops::mcp::{folder, reload};
use crate::ops::{to_value, tools, Ctx};

/// The skills and plugins helper (§3.26), embedded so it always matches this tf-hostd.
pub static HELPER: HelperSpec = HelperSpec {
    source: include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/teleflock-plugins/teleflock-plugins.ts")),
    file_name: "teleflock-plugins.ts",
    stem: "plugins",
    env_in: "TF_PLUGINS_IN",
    env_out: "TF_PLUGINS_OUT",
    env_input: "TF_PLUGINS_INPUT",
    busy: "omp is busy reading skills and plugins on this host",
    needs_omp: "Install omp (Host setup) to manage skills and plugins.",
};

/// Helper runs at once (lists, catalogs, searches; each starts a throwaway omp).
const MAX_READS: usize = 3;

/// One change at a time: omp's skill and plugin installers don't lock their files against each
/// other.
static CHANGES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn handle(ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    let pl = Plugins::from_ctx(ctx);
    match req {
        HostMethod::SkillsListReq(p) => to_value(skills::list(&pl, folder(p.cwd.as_deref())?.as_deref(), p.updates.unwrap_or(false)).await?),
        HostMethod::SkillsSearch(p) => to_value(skills::search(&pl, p).await?),
        HostMethod::SkillsInstall(p) => to_value(skills::install(ctx, &pl, p).await?),
        HostMethod::SkillsUpdate(p) => to_value(skills::update(ctx, &pl, p).await?),
        HostMethod::SkillsRemove(p) => to_value(skills::remove(ctx, &pl, p).await?),
        HostMethod::SkillsSetEnabled(p) => to_value(skills::set_enabled(ctx, &pl, p).await?),
        HostMethod::PluginsListReq(p) => to_value(packages::list(&pl, folder(p.cwd.as_deref())?.as_deref()).await?),
        HostMethod::PluginsDiscover(p) => to_value(packages::discover(&pl, p).await?),
        HostMethod::PluginsInstall(p) => to_value(packages::install(ctx, &pl, p).await?),
        HostMethod::PluginsRemove(p) => to_value(packages::remove(ctx, &pl, p).await?),
        HostMethod::PluginsSetEnabled(p) => to_value(packages::set_enabled(ctx, &pl, p).await?),
        HostMethod::PluginsUpgrade(p) => to_value(packages::upgrade(ctx, &pl, p).await?),
        HostMethod::PluginsMarketplaceAdd(p) => to_value(packages::marketplace_add(&pl, p).await?),
        HostMethod::PluginsMarketplaceRemove(p) => to_value(packages::marketplace_remove(&pl, p).await?),
        HostMethod::PluginsMarketplaceUpdate(p) => to_value(packages::marketplace_update(&pl, p).await?),
        HostMethod::PluginsReload(p) => to_value(reload::reload_plugins(ctx, folder(p.cwd.as_deref())?.as_deref()).await),
        other => Err(ApiError::new("unknown_method", format!("{} is not a skills or plugins method", other.name()))),
    }
}

/// Where omp's files are and how the helper and the CLI run. Tests build one over temp dirs.
#[derive(Debug, Clone)]
pub(crate) struct Plugins {
    pub helper: HelperEnv,
    /// omp's agent dir (the user's registry installs: `<agent dir>/skills.json`).
    pub agent_dir: PathBuf,
    /// An empty folder omp runs in for user-level answers and changes: no project applies.
    pub neutral: PathBuf,
}

impl Plugins {
    fn from_ctx(ctx: &Ctx) -> Plugins {
        static SLOTS: LazyLock<Slots> = LazyLock::new(|| Slots::new(MAX_READS, 1));
        Plugins {
            helper: HelperEnv {
                spec: &HELPER,
                omp: omp_bin(),
                ext_dir: ctx.paths.home.join("ext"),
                run_dir: ctx.paths.run.clone(),
                agent_dir: None,
                slots: SLOTS.clone(),
            },
            agent_dir: omp_agent_dir(),
            neutral: ctx.paths.home.join("cache").join("plugins-user"),
        }
    }

    /// omp's cwd for answers and changes about `folder` (user level: the neutral folder, created
    /// on demand).
    fn cwd_for(&self, folder: Option<&Path>) -> Result<PathBuf, ApiError> {
        match folder {
            Some(f) => Ok(f.to_path_buf()),
            None => {
                std::fs::create_dir_all(&self.neutral).map_err(|e| ApiError::new("io_error", format!("{}: {e}", self.neutral.display())))?;
                Ok(self.neutral.clone())
            }
        }
    }

    fn omp(&self) -> Result<&Path, ApiError> {
        self.helper.omp.as_deref().ok_or_else(|| ApiError::new("omp_error", "omp is not installed on this host").with_hint(HELPER.needs_omp))
    }

    /// One helper request about `folder`; the `result` line without its `t`, and omp's version.
    async fn read(&self, folder: Option<&Path>, req: Value, timeout: Duration) -> Result<(Value, Option<String>), ApiError> {
        let cwd = self.cwd_for(folder)?;
        let deadline = Instant::now() + timeout;
        let mut run = helper::Running::start(&self.helper, &cwd, req, deadline).await?;
        let mut version = None;
        let mut answer = run
            .finish(deadline, |line| {
                if line.get("t").and_then(Value::as_str) == Some("hello") {
                    version = line.get("ompVersion").and_then(Value::as_str).map(str::to_string);
                }
            })
            .await?;
        if let Some(o) = answer.as_object_mut() {
            o.remove("t");
        }
        Ok((answer, version))
    }
}

/// The folder a `scope` change works in: `project` needs the project's `cwd`, `user` works in no
/// project.
fn scope_folder(scope: InstallScope, cwd: Option<&str>) -> Result<Option<PathBuf>, ApiError> {
    match scope {
        InstallScope::User => Ok(None),
        InstallScope::Project => match folder(cwd)? {
            Some(f) => Ok(Some(f)),
            None => Err(ApiError::new("invalid_params", "cwd: a project install needs the project's folder").with_hint("Pick the project first.")),
        },
    }
}

fn no_reload() -> McpReload {
    McpReload { reloaded: 0, queued: 0, restart_needed: 0, errors: vec![] }
}

/// Runs one change through omp's CLI in `dir`, one change at a time; a failure is `failure`'s
/// reading of omp's output.
async fn apply(pl: &Plugins, dir: &Path, args: &[&str], timeout: Duration, failure: fn(&tools::Out) -> ApiError) -> Result<tools::Out, ApiError> {
    let out = {
        let _one = CHANGES.lock().await;
        cli::omp(pl, dir, args, timeout).await?
    };
    if out.code != 0 {
        return Err(failure(&out));
    }
    Ok(out)
}

/// A helper answer as `T`.
fn decode<T: serde::de::DeserializeOwned>(v: Value, what: &str) -> Result<T, ApiError> {
    serde_json::from_value(v).map_err(|e| ApiError::new("omp_error", format!("omp's {what} came back in a shape tf-hostd doesn't know: {e}")))
}
