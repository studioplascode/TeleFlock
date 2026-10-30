//! TeleFlock wire protocol.
//!
//! This crate is the single source of truth for every message that crosses a
//! process boundary:
//!
//! * `tf-hostd` (host daemon) ⇄ `tf-client` (app core): [`host::ClientMsg`] / [`host::ServerMsg`]
//!   as JSON lines over `tf-hostd attach` stdio.
//! * `tf-client` ⇄ frontend (Tauri command/channel, devserver WebSocket, demo host):
//!   [`methods::AppMethod`] / [`methods::HostMethod`] requests and [`app::AppEvent`] events.
//!
//! TypeScript bindings are generated into `src/core/gen/` by `scripts/gen-proto-ts.sh`
//! (`cargo test -p tf-proto export_bindings` with `TS_RS_EXPORT_DIR` + `TS_RS_LARGE_INT=number`).
//!
//! Conventions:
//! * JSON field names are camelCase; enum string values are camelCase.
//! * Timestamps are epoch milliseconds ([`Millis`]).
//! * `Option` fields on structs are omitted when `None` and optional (`?:`) in TypeScript.
//!   `Option` fields inside enum variants serialize as `null` (TypeScript `T | null`).

/// Declares a wire struct: serde camelCase, `None` fields skipped, TS export with optional fields.
macro_rules! wire_struct {
    ($(#[$m:meta])* pub struct $name:ident { $($body:tt)* }) => {
        #[serde_with::skip_serializing_none]
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase")]
        #[ts(export, optional_fields)]
        $(#[$m])*
        pub struct $name { $($body)* }
    };
}

/// Declares a wire unit-enum: camelCase string values, TS string union.
macro_rules! wire_enum {
    ($(#[$m:meta])* pub enum $name:ident { $($body:tt)* }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS)]
        #[serde(rename_all = "camelCase")]
        #[ts(export)]
        $(#[$m])*
        pub enum $name { $($body)* }
    };
}

pub mod accounts;
pub mod autoanswer;
pub mod artifacts;
pub mod autoresume;
pub mod app;
pub mod cleanup;
pub mod find;
pub mod github;
pub mod host;
pub mod herdr;
pub mod hostsync;
pub mod jobs;
pub mod mcp;
pub mod methods;
pub mod model;
pub mod moves;
pub mod notify;
pub mod plugins;
pub mod session;
pub mod term;
pub mod upload;
pub mod usage;
pub mod version;
pub mod wrapped;
pub mod xray;

pub use accounts::*;
pub use artifacts::*;
pub use autoanswer::*;
pub use autoresume::*;
pub use app::*;
pub use cleanup::*;
pub use find::*;
pub use github::*;
pub use herdr::*;
pub use host::*;
pub use hostsync::*;
pub use jobs::*;
pub use mcp::*;
pub use methods::*;
pub use moves::*;
pub use model::*;
pub use notify::*;
pub use plugins::*;
pub use session::*;
pub use term::*;
pub use upload::*;
pub use usage::*;
pub use wrapped::*;
pub use xray::*;

/// Epoch milliseconds.
pub type Millis = i64;

/// Version of the `tf-client` ⇄ `tf-hostd` protocol. Bump on any breaking change.
pub const PROTOCOL_VERSION: u32 = 1;

/// Default loopback port of the omp collab relay embedded in `tf-hostd`.
pub const DEFAULT_RELAY_PORT: u16 = 47466;

/// Empty params / result object (`{}`).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Empty {}

wire_struct! {
    /// Structured error returned by any request.
    ///
    /// `code` is a stable machine string. Known codes:
    /// `invalid_params`, `unknown_method`, `not_found`, `not_connected`, `unsupported`,
    /// `busy` (agent is streaming / dialog open), `agent_blocked`, `timeout`,
    /// `herdr_error`, `omp_error`, `git_error`, `gh_error`, `io_error`, `version_mismatch`,
    /// `auth_required`, `permission_denied`, `ai_unavailable`, `ai_failed`, `install_failed`
    /// (a Host setup install), `deploy_failed` (the host can't run TeleFlock's setup: its shell
    /// rejects the script, or a program it needs is missing; not retried), `port_in_use` /
    /// `port_unavailable` (`tunnel.open { localPort }`),
    /// `auth_flow_gone` (an `auth.*` flow that finished long ago or never existed), `internal`.
    pub struct ApiError {
        pub code: String,
        pub message: String,
        /// Human hint on how to fix it (shown under the message).
        pub hint: Option<String>,
        /// True when retrying the same request later can succeed.
        #[serde(default)]
        pub retryable: bool,
    }
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), hint: None, retryable: false }
    }
    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}
