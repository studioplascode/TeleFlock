//! omp's skills and plugins on a host (`skills.*`, `plugins.*`, architecture §3.26, tf-hostd
//! `ops/plugins`).
//!
//! **Skills** are what omp sessions on the host load: authored ones (`~/.omp/agent/skills`,
//! `<project>/.omp/skills`, Claude Code's and other tools' skill folders, skills of plugins) and
//! packages installed from the Skillshare registry (`omp skill install`: `skills.json` +
//! `skills.lock.json`, unpacked in omp's store). Any skill can be switched off for omp
//! (`disabledExtensions: skill:<name>`); registry packages are installed, updated and removed.
//!
//! **Plugins** are npm / git / local packages in omp's plugin folder (`omp plugin install`) and
//! Claude-Code-format plugins installed from a marketplace (`name@marketplace`).
//!
//! **Running sessions.** Installs, updates, removals and plugin switches answer with
//! [`McpReload`](crate::McpReload): hostd runs omp's `/reload-plugins` (skills, commands, hooks,
//! tools, agents, MCP) in the running interactive sessions the change concerns, at once when idle,
//! else when their turn ends. Skill switches need none: omp watches its config file and applies
//! `disabledExtensions` to running sessions itself.

use crate::{McpReload, Millis};

wire_enum! {
    /// Where an install lives: `user` = every session on the host (omp's agent / plugin folders),
    /// `project` = sessions started in that project (its `.omp/`).
    pub enum InstallScope { User, Project }
}

// ───────────────────────────── skills ─────────────────────────────

wire_struct! {
    /// A skill omp sessions on the host load (or would, when it is switched on).
    pub struct SkillInfo {
        /// The name sessions use (`/skill:<name>`, `skill://<name>`): the SKILL.md `name`, or
        /// `<namespace>/<name>` when two different skills share a name.
        pub name: String,
        pub description: String,
        /// Its SKILL.md.
        pub path: String,
        /// omp's provider: `native` (omp's own folders), `claude`, `agents`, `codex`,
        /// `claude-plugins` (marketplace plugins), `omp-plugins`, `skillshare` (registry), `custom`, …
        pub provider: String,
        /// The provider's display name (`OMP`, `Claude Code`, …).
        pub provider_name: String,
        /// `user`, `project` or `native`.
        pub level: String,
        /// The plugin or registry package that supplies it.
        pub plugin: Option<String>,
        /// The registry package (`@scope/name`) it was installed from, when it was.
        pub registry_id: Option<String>,
        /// Off: omp's `disabledExtensions` lists it (`skill:<name>`).
        pub enabled: bool,
        /// Callable but left out of the system prompt's skill list (`hide` / `disable-model-invocation`).
        pub hidden: bool,
    }
}

wire_struct! {
    /// A Skillshare registry package installed with `omp skill install` (its `skills.json` range
    /// and `skills.lock.json` version).
    pub struct RegistrySkill {
        /// `@scope/name`.
        pub id: String,
        pub scope: InstallScope,
        /// What `skills.json` asks for (`^1.2.0`, a dist-tag, an exact version); absent: only the
        /// lock lists it.
        pub range: Option<String>,
        /// The installed (locked) version; absent: listed but never installed.
        pub version: Option<String>,
        /// The locked version is unpacked in omp's store (else sessions skip it until
        /// `skills.update` restores it).
        pub stored: bool,
        /// Newest version within `range` that `skills.update` would install, when newer than
        /// `version` (`skills.list { updates: true }`).
        pub update: Option<String>,
        /// The registry's `latest` version (may lie outside `range`: `skills.install` of the bare id
        /// moves the range to it).
        pub latest: Option<String>,
        pub description: Option<String>,
        /// The installed version is deprecated (the publisher's message) …
        pub deprecated: Option<String>,
        /// … or yanked.
        #[serde(default)]
        pub yanked: bool,
        /// Why the registry couldn't be asked about it.
        pub update_error: Option<String>,
    }
}

wire_struct! {
    pub struct SkillList {
        pub skills: Vec<SkillInfo>,
        /// Registry installs: user level, then the project's.
        #[serde(default)]
        pub registry: Vec<RegistrySkill>,
        /// omp's discovery warnings (an unreadable SKILL.md, a name two skills claim, …).
        #[serde(default)]
        pub warnings: Vec<String>,
        /// omp's `skills.registryUrl`.
        pub registry_url: String,
        /// The project the list is for (absent: user level).
        pub cwd: Option<String>,
        /// When the registry was asked about newer versions (`updates: true`).
        pub updates_checked_at: Option<Millis>,
        pub omp_version: Option<String>,
    }
}

wire_struct! {
    pub struct SkillsListParams {
        /// Project folder (absolute): the skills a session started there loads. Absent: user level.
        pub cwd: Option<String>,
        /// Also ask the registry about newer versions of registry skills (network).
        pub updates: Option<bool>,
    }
}

wire_struct! {
    pub struct SkillSearchParams {
        pub query: String,
        /// `relevance` (default), `downloads` or `recent`.
        pub sort: Option<String>,
        /// 1-based.
        pub page: Option<u32>,
        /// Marks hits installed for this project too.
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct SkillSearchHit {
        /// `@scope/name`: what `skills.install` takes.
        pub id: String,
        pub description: String,
        /// Latest version.
        pub version: String,
        pub publisher: String,
        #[serde(default)]
        pub keywords: Vec<String>,
        pub updated_at: Millis,
        #[serde(default)]
        pub weekly_downloads: u64,
        pub deprecated: Option<String>,
        /// Installed here already: where.
        pub installed: Option<InstallScope>,
    }
}

wire_struct! {
    pub struct SkillSearchResult {
        pub total: u32,
        pub page: u32,
        pub per_page: u32,
        pub hits: Vec<SkillSearchHit>,
        pub registry_url: String,
    }
}

wire_struct! {
    /// `skills.install`. A version that ships scripts is refused with `scripts_need_consent`
    /// (its message lists the files) unless `allowScripts`.
    pub struct SkillInstallParams {
        /// `@scope/name[@range|tag|version]`; the bare id installs `latest` with range `^latest`.
        pub spec: String,
        pub scope: InstallScope,
        /// The project (`project` scope), and the list the answer carries.
        pub cwd: Option<String>,
        /// The user saw the scripts the version ships and wants it anyway.
        pub allow_scripts: Option<bool>,
    }
}

wire_struct! {
    pub struct SkillUpdateParams {
        /// `@scope/name`; absent: every registry skill of `scope`.
        pub id: Option<String>,
        pub scope: InstallScope,
        pub cwd: Option<String>,
        pub allow_scripts: Option<bool>,
    }
}

wire_struct! {
    pub struct SkillRemoveParams {
        /// `@scope/name`.
        pub id: String,
        pub scope: InstallScope,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct SkillEnableParams {
        /// `SkillInfo.name`.
        pub name: String,
        pub enabled: bool,
        /// The list the answer carries.
        pub cwd: Option<String>,
    }
}

wire_struct! {
    /// Answer of every skill change: the list after it and what reached running sessions.
    pub struct SkillsChanged {
        pub list: SkillList,
        pub reload: McpReload,
        /// omp's own lines about what changed (`+ @a/b@1.0.0`, `@a/b 1.0.0 → 1.1.0`).
        #[serde(default)]
        pub changes: Vec<String>,
        /// How the change reaches sessions when it isn't a reload (skill switches).
        pub note: Option<String>,
    }
}

// ───────────────────────────── plugins ─────────────────────────────

wire_struct! {
    /// An optional part of a package plugin (`omp plugin features`).
    pub struct PluginFeatureInfo {
        pub name: String,
        pub description: Option<String>,
        pub enabled: bool,
    }
}

wire_struct! {
    /// A plugin installed from npm, git or a local folder into omp's plugin folder.
    pub struct PackagePlugin {
        /// The package name (`plugins.*` `id`).
        pub name: String,
        pub version: String,
        pub description: Option<String>,
        /// Off for every session, or for this project (`.omp/plugin-overrides.json`).
        pub enabled: bool,
        /// The package folder.
        pub path: String,
        /// A local folder linked in (`omp plugin link` / installing a path): edits apply on restart.
        #[serde(default)]
        pub linked: bool,
        /// What it brings: `extensions`, `tools`, `hooks`, `commands`.
        #[serde(default)]
        pub provides: Vec<String>,
        #[serde(default)]
        pub features: Vec<PluginFeatureInfo>,
    }
}

wire_struct! {
    /// A plugin installed from a marketplace (Claude Code's plugin format).
    pub struct MarketplacePlugin {
        /// `name@marketplace` (`plugins.*` `id`).
        pub id: String,
        pub name: String,
        pub marketplace: String,
        pub scope: InstallScope,
        pub version: String,
        pub enabled: bool,
        /// A project install of the same plugin wins over this user one.
        #[serde(default)]
        pub shadowed: bool,
        pub description: Option<String>,
        /// A newer version the marketplace's catalog (as last fetched) publishes.
        pub update: Option<String>,
        pub path: Option<String>,
        /// ISO 8601, as omp records it.
        pub updated_at: Option<String>,
        pub homepage: Option<String>,
        /// What it brings: `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`.
        #[serde(default)]
        pub provides: Vec<String>,
    }
}

wire_struct! {
    /// A plugin marketplace omp knows (`omp plugin marketplace add`).
    pub struct Marketplace {
        pub name: String,
        /// `github`, `git`, `url` or `local`.
        pub source_type: String,
        /// As added (`owner/repo`, a git or catalog URL, a folder).
        pub source: String,
        pub description: Option<String>,
        pub owner: Option<String>,
        /// Plugins its catalog lists.
        pub plugins: u32,
        /// When the catalog was last fetched (ISO 8601).
        pub updated_at: Option<String>,
        /// Its catalog can't be read.
        pub error: Option<String>,
    }
}

wire_struct! {
    pub struct PluginList {
        pub packages: Vec<PackagePlugin>,
        pub marketplace: Vec<MarketplacePlugin>,
        pub marketplaces: Vec<Marketplace>,
        /// The project the list is for (its project-scope installs; absent: user level).
        pub cwd: Option<String>,
        #[serde(default)]
        pub warnings: Vec<String>,
        pub omp_version: Option<String>,
    }
}

wire_struct! {
    pub struct PluginsListParams {
        /// Project folder (absolute); absent: user level.
        pub cwd: Option<String>,
    }
}

wire_struct! {
    /// A plugin a marketplace's catalog offers.
    pub struct CatalogPlugin {
        /// `name@marketplace`: what `plugins.install` takes.
        pub id: String,
        pub name: String,
        pub marketplace: String,
        pub description: Option<String>,
        pub version: Option<String>,
        pub author: Option<String>,
        pub category: Option<String>,
        #[serde(default)]
        pub keywords: Vec<String>,
        pub homepage: Option<String>,
        /// What it brings (as the catalog says): `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`.
        #[serde(default)]
        pub provides: Vec<String>,
        /// Where it is installed already.
        #[serde(default)]
        pub installed: Vec<InstallScope>,
    }
}

wire_struct! {
    pub struct PluginDiscoverParams {
        /// One marketplace (absent: all).
        pub marketplace: Option<String>,
        /// Marks project installs of this folder too.
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct PluginCatalog {
        pub plugins: Vec<CatalogPlugin>,
        pub marketplaces: Vec<Marketplace>,
    }
}

wire_struct! {
    pub struct PluginInstallParams {
        /// `name@marketplace`, an npm package (`pkg`, `@scope/pkg@1.2`, `pkg[feature,…]`), a git
        /// source (`github:user/repo`, `https://…#ref`) or a local folder.
        pub spec: String,
        /// Marketplace plugins: `user` (default) or `project` (needs `cwd`).
        pub scope: Option<InstallScope>,
        /// Reinstall over an existing install.
        pub force: Option<bool>,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct PluginRef {
        /// Package name, or `name@marketplace`.
        pub id: String,
        /// Marketplace plugins installed in both scopes: which one.
        pub scope: Option<InstallScope>,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct PluginEnableParams {
        pub id: String,
        pub enabled: bool,
        pub scope: Option<InstallScope>,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct PluginUpgradeParams {
        /// Package name or `name@marketplace`; absent: every marketplace plugin with an update.
        pub id: Option<String>,
        pub scope: Option<InstallScope>,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct MarketplaceAddParams {
        /// `owner/repo` (GitHub), a git URL, a catalog URL ending in `.json`, or a local folder.
        pub source: String,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    pub struct MarketplaceRefParams {
        /// `plugins.marketplaceRemove`: required; `plugins.marketplaceUpdate`: absent = all.
        pub name: Option<String>,
        pub cwd: Option<String>,
    }
}

wire_struct! {
    /// Answer of every plugin change: the list after it and what reached running sessions.
    pub struct PluginsChanged {
        pub list: PluginList,
        pub reload: McpReload,
        /// omp's own lines about what changed.
        #[serde(default)]
        pub changes: Vec<String>,
        /// What a reload can't do (a package plugin's code loads when a session starts).
        pub note: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_list_round_trips_with_defaults() {
        let v: SkillList = serde_json::from_str(r#"{"skills":[],"registryUrl":"https://skills.omp.sh"}"#).unwrap();
        assert!(v.registry.is_empty() && v.warnings.is_empty() && v.cwd.is_none());
        let back = serde_json::to_value(&v).unwrap();
        assert_eq!(back["registryUrl"], "https://skills.omp.sh");
        assert!(back.get("cwd").is_none(), "None fields are omitted");
    }

    #[test]
    fn scope_is_camel_case() {
        assert_eq!(serde_json::to_string(&InstallScope::Project).unwrap(), "\"project\"");
    }
}
