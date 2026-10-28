//! omp's MCP servers on a host (`mcp.*`, architecture §3.15, `tf-hostd` `ops/mcp`).
//!
//! The servers an omp session on the host loads: omp's own config files (`user`:
//! `<omp agent dir>/mcp.json`; `project`: `<folder>/.omp/mcp.json`, plus their `.mcp.json`
//! siblings), editable here, and servers omp imports from other tools (Claude Code, Cursor,
//! Codex, plugins, …), which are read-only but can be switched off for omp. Status and tools come
//! from omp itself: hostd connects the servers the way a session would, in a throwaway omp.
//!
//! **Secrets.** Values that look like credentials (env and header values whose name says so,
//! `Authorization`, secret URL query parameters, secret command-line flags and JSON keys, the
//! OAuth client secret) never leave the host: they come back as [`SECRET_MASK`]. Sending the mask
//! back in a draft keeps the stored value; anything else replaces it.
//!
//! **Running sessions.** omp has no MCP config watcher. Every change answers with [`McpReload`]:
//! hostd runs omp's `/mcp reload` in the running interactive sessions the change concerns (all of
//! them for `user`, the folder's for `project`) through the companion extension, at once when idle,
//! else when their turn ends. Sessions it can't reach pick the change up when they restart.

use crate::Millis;

/// Stands in for a stored secret in answers; sent back unchanged in a draft, it keeps the stored value.
pub const SECRET_MASK: &str = "••••••••";

wire_enum! {
    /// omp's writable config scopes: `user` = every session of the host, `project` = sessions
    /// started in that folder.
    pub enum McpScope { User, Project }
}

wire_enum! {
    /// `stdio`: omp starts `command`; `http`: Streamable HTTP at `url`; `sse`: legacy HTTP+SSE.
    pub enum McpTransport { Stdio, Http, Sse }
}

wire_enum! {
    /// Where a server is defined: omp's user or project config (editable), or another tool's
    /// config omp imports (read-only).
    pub enum McpOrigin { User, Project, Imported }
}

wire_enum! {
    /// What a session on the host gets from a server, as last checked:
    /// * `unknown`: not checked (yet, or its definition changed since).
    /// * `checking`: a check is running and there is no earlier result.
    /// * `connected`: connected and listed its tools.
    /// * `needsAuth`: the server wants a sign-in (OAuth, or a rejected token).
    /// * `failed`: could not connect (`error`).
    /// * `pending`: still starting when the check ended (slow first start, e.g. a package download).
    /// * `disabled`: switched off; sessions don't start it.
    /// * `skipped`: omp doesn't load it although it is on (`note` says why: omp's built-in Exa
    ///   search or browser replaces it, or project configs are switched off).
    pub enum McpStatus { Unknown, Checking, Connected, NeedsAuth, Failed, Pending, Disabled, Skipped }
}

wire_struct! {
    /// One `env` variable or HTTP header.
    pub struct McpKeyValue {
        pub key: String,
        /// The value; a stored secret comes back as [`SECRET_MASK`].
        pub value: String,
        /// Credential-like (by its name or because the stored value was masked): shown masked,
        /// typed into a password field.
        #[serde(default)]
        pub secret: bool,
    }
}

wire_struct! {
    /// The `oauth` block of a server: client settings for providers that need a pre-registered
    /// app. Usually absent: omp registers itself (dynamic client registration).
    pub struct McpOAuthSettings {
        pub client_id: Option<String>,
        /// [`SECRET_MASK`] when stored.
        pub client_secret: Option<String>,
        /// Space-separated scopes to request.
        pub scope: Option<String>,
        /// Port of omp's local callback server (default 3000).
        pub callback_port: Option<u16>,
        /// Exact redirect URI registered with the provider.
        pub redirect_uri: Option<String>,
    }
}

wire_struct! {
    /// A server definition as edited in the app (`mcp.save`) and listed (secrets masked).
    pub struct McpServerDraft {
        pub transport: McpTransport,
        /// `stdio`: the program (found on the host's PATH).
        pub command: Option<String>,
        #[serde(default)]
        pub args: Vec<String>,
        /// `stdio`: working directory (default: the session's folder).
        pub cwd: Option<String>,
        /// `stdio`: environment. omp expands `${VAR}` / `${VAR:-default}` from its own environment.
        #[serde(default)]
        pub env: Vec<McpKeyValue>,
        /// `http` / `sse`.
        pub url: Option<String>,
        #[serde(default)]
        pub headers: Vec<McpKeyValue>,
        /// Per-request timeout in ms (omp's default 30 000; 0 = none).
        pub timeout_ms: Option<u64>,
        pub oauth: Option<McpOAuthSettings>,
    }
}

wire_struct! {
    pub struct McpTool {
        pub name: String,
        pub description: Option<String>,
    }
}

wire_struct! {
    /// `serverInfo` from the server's `initialize` answer.
    pub struct McpServerInfo {
        pub name: String,
        pub version: Option<String>,
    }
}

wire_struct! {
    pub struct McpServer {
        pub name: String,
        pub origin: McpOrigin,
        /// The config file that defines it (omp's file for `user` / `project`, the other tool's
        /// file for `imported`).
        pub path: Option<String>,
        /// `imported`: the tool omp read it from (`Claude Code`, `Cursor`, a plugin, …).
        pub source_label: Option<String>,
        /// The definition, secrets masked (`imported`: as omp reads it).
        pub server: McpServerDraft,
        /// Sessions start it (its `enabled` flag and the user-level `disabledServers` /
        /// `enabledServers` lists together).
        pub enabled: bool,
        /// Has an OAuth sign-in (an `auth` block, or a credential omp stored for its URL).
        #[serde(default)]
        pub signed_in: bool,
        /// A server of the same name with higher precedence wins (project over user, omp's own
        /// files over imported ones): sessions don't load this one.
        #[serde(default)]
        pub shadowed: bool,
        pub status: McpStatus,
        /// `failed` / `needsAuth`: omp's message.
        pub error: Option<String>,
        /// Extra context for the status (`skipped`: why).
        pub note: Option<String>,
        /// Its tools at the last successful check.
        #[serde(default)]
        pub tools: Vec<McpTool>,
        pub server_info: Option<McpServerInfo>,
        /// When the status was established.
        pub checked_at: Option<Millis>,
        /// Fields of the entry TeleFlock doesn't edit (kept as they are on save).
        #[serde(default)]
        pub extra: Vec<String>,
    }
}

wire_struct! {
    pub struct McpCheckState {
        /// A check of every server is running.
        pub running: bool,
        pub started_at: Option<Millis>,
        pub finished_at: Option<Millis>,
        /// The last check failed as a whole (omp missing or too old, helper error).
        pub error: Option<String>,
    }
}

wire_struct! {
    /// A config file omp can't read (invalid JSON): its servers are missing, and TeleFlock won't
    /// write it.
    pub struct McpFileError {
        pub path: String,
        pub message: String,
    }
}

wire_struct! {
    pub struct McpList {
        /// Project folder this list is for (absent: user level, as a session started in the
        /// home folder sees it).
        pub cwd: Option<String>,
        /// omp's user config file (`<omp agent dir>/mcp.json`).
        pub user_path: String,
        /// The folder's project config file (`<cwd>/.omp/mcp.json`).
        pub project_path: Option<String>,
        /// Project servers first, then user, then imported (omp's precedence).
        pub servers: Vec<McpServer>,
        pub check: McpCheckState,
        /// omp version the checks run with.
        pub omp_version: Option<String>,
        /// Running interactive omp sessions on the host that `/mcp reload` reaches (for `cwd`:
        /// those started in that folder).
        pub live_sessions: u32,
        #[serde(default)]
        pub file_errors: Vec<McpFileError>,
    }
}

wire_struct! {
    pub struct McpListParams {
        /// Project folder (absolute; absent: user level).
        pub cwd: Option<String>,
        /// Check every server again now (otherwise a check result stays while the server's
        /// definition is unchanged and it is under 10 minutes old).
        pub refresh: Option<bool>,
        /// While a check runs, wait up to this many ms for it (≤ 25 000) before answering.
        pub wait_ms: Option<u32>,
    }
}

wire_struct! {
    pub struct McpSaveParams {
        pub scope: McpScope,
        /// Project folder: the `project` scope's folder, and the list the answer carries.
        pub cwd: Option<String>,
        pub name: String,
        /// Editing: the server's current name in `scope` (a rename when it differs from `name`).
        /// Absent: a new server (`already_exists` when `name` is taken in that file).
        pub previous_name: Option<String>,
        pub server: McpServerDraft,
        /// Default: kept when editing, on for a new server.
        pub enabled: Option<bool>,
    }
}

wire_struct! {
    pub struct McpServerRef {
        pub cwd: Option<String>,
        pub name: String,
        /// Which definition (`user` / `project`); absent: the one sessions use.
        pub scope: Option<McpScope>,
    }
}

wire_struct! {
    pub struct McpEnableParams {
        pub cwd: Option<String>,
        pub name: String,
        /// Which definition; absent: the one sessions use (an imported server is switched
        /// through omp's user-level lists).
        pub scope: Option<McpScope>,
        pub enabled: bool,
    }
}

wire_struct! {
    /// What a change did to running sessions.
    pub struct McpReload {
        /// Sessions that reloaded their MCP servers now.
        pub reloaded: u32,
        /// Busy sessions: they reload when their turn ends.
        pub queued: u32,
        /// Running omp sessions hostd can't reload (no companion extension, not interactive):
        /// they pick the change up when restarted.
        pub restart_needed: u32,
        #[serde(default)]
        pub errors: Vec<String>,
    }
}

wire_struct! {
    pub struct McpReloadParams {
        /// Only sessions started in this folder (absent: every session).
        pub cwd: Option<String>,
    }
}

wire_struct! {
    /// Answer of every change: the list after it, and the reload of running sessions.
    pub struct McpChanged {
        pub list: McpList,
        pub reload: McpReload,
    }
}

wire_struct! {
    pub struct McpTestParams {
        pub cwd: Option<String>,
        pub name: String,
        /// Which saved definition (`server` absent) or whose stored secrets fill masked values of
        /// `server`.
        pub scope: Option<McpScope>,
        /// An unsaved definition to try (absent: the saved one).
        pub server: Option<McpServerDraft>,
    }
}

wire_struct! {
    pub struct McpTestResult {
        /// `connected`, `needsAuth`, `failed` or `pending` (didn't answer in time).
        pub status: McpStatus,
        pub error: Option<String>,
        #[serde(default)]
        pub tools: Vec<McpTool>,
        pub server_info: Option<McpServerInfo>,
        /// Time to connect and list tools.
        pub ms: u32,
    }
}

wire_struct! {
    pub struct McpSearchParams {
        pub query: String,
        /// 1–30 (default 12).
        pub limit: Option<u32>,
    }
}

wire_struct! {
    /// A setting a registry server asks for (its config schema).
    pub struct McpRegistryInput {
        pub key: String,
        pub label: String,
        /// `string` | `number` | `boolean`.
        pub kind: String,
        pub required: bool,
        pub default_value: Option<String>,
        pub description: Option<String>,
        #[serde(default)]
        pub choices: Vec<String>,
        pub secret: bool,
    }
}

wire_struct! {
    /// A server from the Smithery registry, with the definition omp would add for it.
    pub struct McpRegistryEntry {
        pub id: String,
        /// Suggested config name.
        pub name: String,
        pub title: String,
        pub description: Option<String>,
        #[serde(default)]
        pub use_count: u64,
        #[serde(default)]
        pub verified: bool,
        /// Hosted by Smithery (`http`), else run locally through the Smithery CLI.
        #[serde(default)]
        pub remote: bool,
        pub homepage: Option<String>,
        pub icon_url: Option<String>,
        pub server: McpServerDraft,
        /// Settings to fill in; for a `stdio` entry they go into the JSON after its `--config` argument.
        #[serde(default)]
        pub inputs: Vec<McpRegistryInput>,
        #[serde(default)]
        pub warnings: Vec<String>,
        #[serde(default)]
        pub tools: Vec<McpTool>,
    }
}

wire_struct! {
    pub struct McpSearchResult {
        pub entries: Vec<McpRegistryEntry>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostMethod;

    #[test]
    fn save_request_parses_with_wire_names() {
        let req = HostMethod::parse(
            "mcp.save",
            serde_json::json!({
                "scope": "project", "cwd": "/w/app", "name": "docs", "previousName": "old-docs",
                "server": {
                    "transport": "http", "url": "https://mcp.example.com/mcp",
                    "headers": [{ "key": "Authorization", "value": SECRET_MASK, "secret": true }],
                    "timeoutMs": 0, "oauth": { "clientId": "abc", "callbackPort": 4100 }
                }
            }),
        )
        .unwrap();
        let HostMethod::McpSave(p) = req else { panic!() };
        assert_eq!((p.scope, p.previous_name.as_deref()), (McpScope::Project, Some("old-docs")));
        assert_eq!(p.server.transport, McpTransport::Http);
        assert_eq!(p.server.headers[0].value, SECRET_MASK);
        assert!(p.server.args.is_empty() && p.server.env.is_empty(), "lists default to empty");
        assert_eq!(p.server.oauth.unwrap().callback_port, Some(4100));
    }

    #[test]
    fn status_values_are_camel_case() {
        assert_eq!(serde_json::to_value(McpStatus::NeedsAuth).unwrap(), "needsAuth");
        assert_eq!(serde_json::to_value(McpOrigin::Imported).unwrap(), "imported");
        let tool = McpTool { name: "search".into(), description: None };
        assert_eq!(serde_json::to_string(&tool).unwrap(), r#"{"name":"search"}"#, "absent options are omitted");
    }
}
