use serde::{Deserialize, Serialize};
use std::fmt;

/// Error codes. herdr's own codes are passed through verbatim; the ones marked
/// *local* are produced by this crate.
pub mod code {
    // ---- local (tf-herdr) ----
    /// The herdr binary could not be located.
    pub const BINARY_NOT_FOUND: &str = "binary_not_found";
    /// Socket/pipe/process I/O failed (connection reset, broken pipe, spawn failure, ...).
    pub const TRANSPORT: &str = "transport";
    /// The server answered with something that is not a herdr envelope.
    pub const PROTOCOL: &str = "protocol";
    /// The method does not exist on the running server. herdr >= 0.9.2 sends this code;
    /// 0.9.0's `invalid_request` + "unknown variant" is normalised to it.
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    /// 0.9.2+: the subscription fell behind and the server dropped events.
    pub const EVENTS_LOST: &str = "events_lost";

    // ---- herdr (shared with local timeouts / missing sockets) ----
    pub const SERVER_NOT_RUNNING: &str = "server_not_running";
    pub const TIMEOUT: &str = "timeout";
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const INVALID_PARAMS: &str = "invalid_params";
    pub const NOT_FOUND: &str = "not_found";
    pub const PANE_NOT_FOUND: &str = "pane_not_found";
    pub const WORKSPACE_NOT_FOUND: &str = "workspace_not_found";
    pub const TAB_NOT_FOUND: &str = "tab_not_found";
    pub const AGENT_NOT_FOUND: &str = "agent_not_found";
    pub const AGENT_TARGET_AMBIGUOUS: &str = "agent_target_ambiguous";
    pub const AGENT_NAME_TAKEN: &str = "agent_name_taken";
    pub const AGENT_BLOCKED: &str = "agent_blocked";
    pub const AGENT_PROMPT_STALLED: &str = "agent_prompt_stalled";
    pub const AGENT_PANE_BUSY: &str = "agent_pane_busy";
    pub const AGENT_START_FAILED: &str = "agent_start_failed";
    pub const UNSUPPORTED_AGENT_KIND: &str = "unsupported_agent_kind";
    pub const INVALID_KEY: &str = "invalid_key";
    pub const PANE_SEND_FAILED: &str = "pane_send_failed";
    pub const NOT_GIT_WORKTREE: &str = "not_git_worktree";
    pub const WORKTREE_LIST_FAILED: &str = "worktree_list_failed";
    pub const WORKTREE_CREATE_FAILED: &str = "worktree_create_failed";
    pub const WORKTREE_OPEN_FAILED: &str = "worktree_open_failed";
    pub const WORKTREE_REMOVE_FAILED: &str = "worktree_remove_failed";
    pub const WORKTREE_NOT_FOUND: &str = "worktree_not_found";
    pub const DIRTY_WORKTREE_REQUIRES_FORCE: &str = "dirty_worktree_requires_force";
    pub const WORKSPACE_GROUP_CLOSE_REQUIRED: &str = "workspace_group_close_required";
    pub const STREAM_CONFLICT: &str = "stream_conflict";
    pub const FEATURE_DISABLED: &str = "feature_disabled";
    pub const PLATFORM_UNSUPPORTED: &str = "platform_unsupported";
}

/// A herdr API error (`{"error":{"code","message"}}`) or a local transport failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HerdrError {
    pub code: String,
    pub message: String,
}

pub type Result<T, E = HerdrError> = std::result::Result<T, E>;

impl HerdrError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    /// Normalise a server error body. Handles both the 0.9.0 shape (id lost, unknown
    /// methods reported as `invalid_request` "unknown variant") and the 0.9.2 shape.
    pub fn from_server(code: String, message: String) -> Self {
        if code == code::INVALID_REQUEST && message.contains("unknown variant") {
            return Self { code: code::UNKNOWN_METHOD.into(), message };
        }
        Self { code, message }
    }

    pub(crate) fn transport(context: &str, err: impl fmt::Display) -> Self {
        Self::new(code::TRANSPORT, format!("{context}: {err}"))
    }

    pub(crate) fn protocol(context: &str, err: impl fmt::Display) -> Self {
        Self::new(code::PROTOCOL, format!("{context}: {err}"))
    }

    pub(crate) fn timeout(context: &str) -> Self {
        Self::new(code::TIMEOUT, format!("{context}: timed out"))
    }

    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }

    /// The server is gone or never started (missing socket, refused connection).
    pub fn is_server_not_running(&self) -> bool {
        self.code == code::SERVER_NOT_RUNNING
    }

    /// Any `*_not_found` code.
    pub fn is_not_found(&self) -> bool {
        self.code.ends_with("not_found") && self.code != code::BINARY_NOT_FOUND
    }

    /// git refused a repository it considers unsafe; retry with `trust_repository: true`.
    pub fn is_dubious_ownership(&self) -> bool {
        self.message.contains("dubious ownership")
    }

    /// Worth retrying after a reconnect (transport hiccup, timeout, server restart).
    pub fn is_transient(&self) -> bool {
        matches!(self.code.as_str(), code::TRANSPORT | code::TIMEOUT | code::SERVER_NOT_RUNNING | code::EVENTS_LOST)
    }
}

impl fmt::Display for HerdrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for HerdrError {}
