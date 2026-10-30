//! "Make this host like that one" (`hostSync.*`, architecture §3.24, tf-hostd `ops/hostsync`).
//!
//! The app copies omp's global settings, model roles and user-level MCP servers from a source host
//! to a target host, and on request sign-ins and other secrets:
//!
//! 1. `hostSync.export` on the source → [`SyncProfile`]. Nothing secret: credential settings are
//!    withheld, MCP secrets masked, sign-ins listed by identity only.
//! 2. `hostSync.plan {source}` on the target → [`SyncPlan`]: one [`SyncItem`] per difference, for
//!    the user to choose from.
//! 3. Only when secret items are chosen: `hostSync.keyBegin` on the target → [`SyncKey`] (a
//!    one-time X25519 public key), then `hostSync.seal {transferId, publicKey, items}` on the
//!    source → [`SyncSealed`]: those secrets encrypted to that key. The app relays the ciphertext;
//!    only the target's one-time private key, which never leaves its memory, opens it, once.
//! 4. `hostSync.apply {source, items, sealed?}` on the target → [`SyncApplied`], through the
//!    host's own write paths (omp's config, omp's MCP files, `omp auth import`).

use crate::mcp::{McpReload, McpServerDraft};
use crate::Millis;

/// The sealing suite of [`SyncKey`] / [`SyncSealed`]: X25519 key agreement, HKDF-SHA256, AES-256-GCM.
pub const SYNC_SUITE: &str = "x25519-hkdf-sha256-aes256gcm/1";

wire_struct! {
    /// One key omp's global config layer (`<agent dir>/config.yml`) sets, as written
    /// (`omp config list --scope global`).
    pub struct SyncSetting {
        pub key: String,
        /// omp's type: `string` | `number` | `boolean` | `enum` | `array` | `record`.
        #[serde(rename = "type")]
        pub kind: String,
        /// The value as written; absent for a credential.
        #[ts(type = "unknown")]
        pub value: Option<serde_json::Value>,
        /// A credential: its value leaves the host only sealed (`hostSync.seal`).
        #[serde(default)]
        pub secret: bool,
        /// omp's settings panel label, tab and group (the host's omp schema).
        pub label: Option<String>,
        pub tab: Option<String>,
        pub group: Option<String>,
    }
}

wire_struct! {
    /// A server of omp's user-level MCP config (`<agent dir>/mcp.json`, or its `.mcp.json`).
    pub struct SyncMcpServer {
        pub name: String,
        /// The definition, secrets masked ([`crate::SECRET_MASK`]).
        pub server: McpServerDraft,
        /// Sessions start it.
        pub enabled: bool,
        /// Some values are masked: they travel only sealed (`mcpSecrets:<name>`).
        #[serde(default)]
        pub secrets: bool,
        /// Signed in with OAuth on this host (that sign-in is one of the profile's `signIns`).
        #[serde(default)]
        pub signed_in: bool,
        /// Fields of the entry TeleFlock doesn't edit: they are not copied.
        #[serde(default)]
        pub extra: Vec<String>,
    }
}

wire_enum! {
    pub enum SyncSignInKind { Oauth, ApiKey }
}

wire_struct! {
    /// A credential `omp auth export` carries, by identity only (never a token or a key).
    pub struct SyncSignIn {
        /// `<provider>|<12 hex digits of the SHA-256 of its identity>`: the same on every host for
        /// the same account.
        pub id: String,
        pub provider: String,
        pub kind: SyncSignInKind,
        /// Who: the email, else the account or project id.
        pub account: Option<String>,
        /// Organization name, else id.
        pub org: Option<String>,
        /// An MCP server's OAuth sign-in: the server's URL (when its credential id names it).
        pub mcp_url: Option<String>,
    }
}

wire_struct! {
    /// What a host has that `hostSync` copies. Holds no secret.
    pub struct SyncProfile {
        pub omp_version: String,
        /// omp's global config layer, in omp's order.
        pub settings: Vec<SyncSetting>,
        pub mcp: Vec<SyncMcpServer>,
        pub sign_ins: Vec<SyncSignIn>,
        /// Why sign-ins can't be listed or copied here (omp uses an auth broker, omp failed).
        pub sign_ins_note: Option<String>,
        /// Why MCP servers are missing (a config file omp can't read).
        pub mcp_note: Option<String>,
    }
}

wire_enum! {
    pub enum SyncSection { Settings, Roles, Mcp, SignIns }
}

wire_enum! {
    /// What applying an item does to this (the target) host:
    /// * `add`: the source has it, this host doesn't.
    /// * `change`: both have it, with different values.
    /// * `remove`: only this host has it: reset to omp's default (settings, roles) or delete (MCP).
    /// * `same`: equal on both hosts; nothing to do.
    /// * `unknown`: both have it, but its value is secret and can't be compared (a sign-in, a
    ///   credential setting, an MCP server's secrets): copying replaces this host's.
    /// * `unsupported`: can't be applied here (`notes` say why).
    pub enum SyncChange { Add, Change, Remove, Same, Unknown, Unsupported }
}

wire_struct! {
    /// One difference between the hosts, for the user to choose.
    pub struct SyncItem {
        /// `setting:<key>`, `role:<role>`, `mcp:<name>`, `mcpSecrets:<name>`, `signIn:<sign-in id>`.
        pub id: String,
        pub section: SyncSection,
        pub change: SyncChange,
        pub label: String,
        /// Where it lives: omp's settings tab › group; a sign-in's provider.
        pub place: Option<String>,
        /// The source's value, never a secret. Settings: as written. Roles: `{model?, fallbacks?}`.
        /// MCP: `{server: McpServerDraft, enabled}`. Sign-ins: the `SyncSignIn`.
        #[ts(type = "unknown")]
        pub from: Option<serde_json::Value>,
        /// This host's current value, same shapes.
        #[ts(type = "unknown")]
        pub to: Option<serde_json::Value>,
        /// Its value is a secret: it travels only sealed, from the source to this host, and is
        /// never shown.
        #[serde(default)]
        pub secret: bool,
        /// Preselected: a difference that is safe to copy (never a removal or a secret).
        #[serde(default)]
        pub suggested: bool,
        /// The item that supplies what this one lacks: an MCP server whose masked values this host
        /// can't fill from its own definition needs `mcpSecrets:<name>` (without it, they are left
        /// empty here).
        pub needs: Option<String>,
        #[serde(default)]
        pub notes: Vec<String>,
    }
}

wire_struct! {
    pub struct SyncPlan {
        pub source_omp: String,
        pub target_omp: String,
        /// Settings, roles, MCP servers, sign-ins; `same` items included.
        pub items: Vec<SyncItem>,
        #[serde(default)]
        pub notes: Vec<String>,
    }
}

wire_struct! {
    pub struct SyncPlanParams {
        /// `hostSync.export` of the source host.
        pub source: SyncProfile,
    }
}

wire_struct! {
    /// A one-time key pair of the target host for one transfer (`hostSync.keyBegin`). Its private
    /// half never leaves the daemon's memory and is gone after one `hostSync.apply` that uses it,
    /// or at `expiresAt`.
    pub struct SyncKey {
        pub transfer_id: String,
        /// X25519 public key, base64.
        pub public_key: String,
        /// [`SYNC_SUITE`].
        pub suite: String,
        pub expires_at: Millis,
    }
}

wire_struct! {
    pub struct SyncSealParams {
        pub transfer_id: String,
        /// The target's `SyncKey.publicKey`.
        pub public_key: String,
        /// Secret item ids of the target's plan: `signIn:…`, `mcpSecrets:…`, `setting:…`.
        pub items: Vec<String>,
    }
}

wire_struct! {
    /// Secrets the source host sealed for the target's one-time key. The app only relays it.
    pub struct SyncSealed {
        pub suite: String,
        pub transfer_id: String,
        /// The source's ephemeral X25519 public key, base64.
        pub sender_key: String,
        /// AES-256-GCM nonce, base64.
        pub nonce: String,
        /// Ciphertext with its tag, base64.
        pub ciphertext: String,
        /// The item ids it holds (authenticated with it).
        pub items: Vec<String>,
    }
}

wire_struct! {
    pub struct SyncApplyParams {
        pub source: SyncProfile,
        /// Item ids of the plan for `source` to apply.
        pub items: Vec<String>,
        /// The secret ones among `items`, sealed by the source (`hostSync.seal`).
        pub sealed: Option<SyncSealed>,
    }
}

wire_struct! {
    pub struct SyncItemResult {
        pub id: String,
        pub ok: bool,
        pub error: Option<String>,
        /// What else to know (an MCP value left empty here, a role's model missing here).
        pub note: Option<String>,
    }
}

wire_struct! {
    pub struct SyncApplied {
        /// One per requested item, in plan order.
        pub results: Vec<SyncItemResult>,
        /// The plan again, after the changes.
        pub plan: SyncPlan,
        /// MCP changes: what reloading the running sessions did.
        pub mcp_reload: Option<McpReload>,
    }
}
