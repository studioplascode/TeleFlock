//! Host-side herdr client used by `tf-hostd`.
//!
//! - [`HerdrClient::discover`] locates the binary, resolves the session's API socket
//!   (unix socket or Windows named pipe) and pings the server;
//!   [`HerdrClient::ensure_server`] starts it detached when absent.
//! - [`HerdrClient::request`] is the raw one-request-per-connection primitive; typed
//!   helpers (`agent_*`, `workspace_*`, `worktree_*`, `tab_*`, `pane_*`, `snapshot`) sit on it.
//! - [`HerdrClient::subscribe`] yields coalesced [`HerdrEvent`]s and reconnects with backoff.
//! - [`HerdrClient::terminal_session`] bridges `herdr terminal session control|observe`.
//!
//! See `README.md` for the API summary and `docs/research/herdr.md` for the protocol.

mod api;
mod client;
pub mod durable;
mod error;
mod events;
pub mod model;
mod terminal;
mod transport;

pub use api::{
    AgentStart, AgentWait, PaneSplit, ReadFormat, ReadOptions, ReadSource, ScrollDirection, SplitDirection, TabCreate,
    WorkspaceCreate, WorktreeCreate, WorktreeOpen, WorktreeScope, WorktreeTarget,
};
pub use client::{
    DEFAULT_REQUEST_TIMEOUT, DiscoverOptions, HerdrClient, MIN_SERVER_VERSION, SERVER_START_TIMEOUT, binary_candidates,
    config_dir, default_socket_path, locate_binary, parse_version,
};
pub use error::{HerdrError, Result, code};
pub use events::{ALL_GLOBAL_SUBSCRIPTIONS, DEFAULT_COALESCE, EventStream, HerdrEvent, SubscribeOptions, parse_event};
pub use model::*;
pub use terminal::{
    TERMINAL_START_TIMEOUT, TerminalEvent, TerminalFrame, TerminalInput, TerminalMode, TerminalOptions, TerminalSession,
    parse_terminal_line,
};
pub use transport::{Endpoint, parse_response};
