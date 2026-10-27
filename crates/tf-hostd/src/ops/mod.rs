//! Request dispatcher and the per-herdr-session context (architecture §3.4).
//!
//! Every method family implements
//! `pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError>`.

use std::sync::{Arc, Weak};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use tf_proto::{ApiError, HostMethod};

use crate::bridge::BridgeHandle;
use crate::clients::ClientHandle;
use crate::daemon::Daemon;
use crate::omp::OmpHandle;
use crate::paths::Paths;
use crate::state::subs::SessionSubs;
use crate::state::StateHandle;

pub mod ai;
pub mod agent;
pub mod automation;
pub mod fs;
pub mod gh;
pub mod git;
pub mod host;
pub mod install;
pub mod limits;
pub mod omp_config;
pub mod scope;
pub mod term;
pub mod tools;
pub mod upload;
pub mod workspace;
pub mod worktree;

/// Everything a handler needs for one herdr session. Shared (`Arc`) by all clients
/// attached to that session.
pub struct Ctx {
    /// herdr session name (`default` for the default session).
    pub herdr_session: String,
    pub herdr: Arc<tf_herdr::HerdrClient>,
    pub state: StateHandle,
    /// Shared across herdr sessions: relay, registry, one guest + replica per omp session.
    pub omp: OmpHandle,
    /// Shared across herdr sessions: companion-extension connections.
    pub bridge: BridgeHandle,
    pub terms: term::TermRegistry,
    pub paths: Paths,
    pub relay_port: u16,
    /// `session.open` subscriptions (agent id → clients).
    pub sessions: SessionSubs,
    /// Shared across herdr sessions: the daemon's omp/herdr updater.
    pub tools: tools::Tools,
    /// Cancelled when the context closes (daemon shutdown).
    pub cancel: CancellationToken,
    me: Weak<Ctx>,
}

impl Ctx {
    pub(crate) async fn create(daemon: &Arc<Daemon>, session: &str) -> Result<Arc<Ctx>, ApiError> {
        let herdr_name = (session != "default").then_some(session);
        let herdr = match tf_herdr::HerdrClient::discover(herdr_name).await {
            Ok(herdr) => herdr,
            // Not installed: serve the session anyway, so Host setup can offer `install-herdr`;
            // the client expects herdr where its installer puts it.
            Err(e) if e.code == tf_herdr::code::BINARY_NOT_FOUND => {
                let bin = install::herdr_install_path();
                tracing::warn!(session, "herdr is not installed; expecting it at {}", bin.display());
                let opts = tf_herdr::DiscoverOptions { bin: Some(bin), ..Default::default() };
                tf_herdr::HerdrClient::discover_with(herdr_name, opts).await.map_err(herdr_err)?
            }
            Err(e) => return Err(herdr_err(e)),
        };
        if git::is_executable(herdr.binary())
            && let Err(e) = herdr.ensure_server().await
        {
            tracing::warn!(session, "herdr server not available: {e}");
        }
        let herdr = Arc::new(herdr);
        let cancel = daemon.shutdown.child_token();
        let ctx = Arc::new_cyclic(|me| Ctx {
            herdr_session: session.to_string(),
            herdr: herdr.clone(),
            state: StateHandle::new(session, daemon.persist.clone(), daemon.omp.clone(), daemon.bridge.clone()),
            omp: daemon.omp.clone(),
            bridge: daemon.bridge.clone(),
            terms: term::TermRegistry::default(),
            paths: daemon.paths.clone(),
            relay_port: daemon.relay_port,
            sessions: SessionSubs::default(),
            tools: daemon.tools.clone(),
            cancel,
            me: me.clone(),
        });
        tools::follow(&ctx);
        upload::start(&daemon.paths, daemon.shutdown.child_token());
        crate::state::start(&ctx).await;
        Ok(ctx)
    }

    /// Owning handle for background tasks spawned by handlers.
    pub fn arc(&self) -> Arc<Ctx> {
        self.me.upgrade().expect("Ctx is always owned by an Arc")
    }

    pub(crate) async fn close(&self) {
        self.cancel.cancel();
    }
}

/// Routes a parsed request to its family handler.
pub async fn dispatch(ctx: &Arc<Ctx>, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    let ctx: &Ctx = ctx;
    let family = req.name().split('.').next().unwrap_or_default();
    match family {
        "state" => to_value(ctx.state.resend_snapshot(client)),
        "session" | "agent" => agent::handle(ctx, req, client).await,
        "workspace" | "tab" | "pane" => workspace::handle(ctx, req, client).await,
        "worktree" => worktree::handle(ctx, req, client).await,
        "fs" => fs::handle(ctx, req, client).await,
        "git" => git::handle(ctx, req, client).await,
        "gh" => gh::handle(ctx, req, client).await,
        "term" => term::handle(ctx, req, client).await,
        "host" => host::handle(ctx, req, client).await,
        "omp" => omp_config::handle(ctx, req, client).await,
        "automation" => automation::handle(ctx, req, client).await,
        "ai" => ai::handle(ctx, req, client).await,
        "upload" => upload::handle(ctx, req, client).await,
        _ => Err(ApiError::new("unknown_method", format!("unknown method `{}`", req.name()))),
    }
}

/// Serializes a handler result.
pub fn to_value<T: serde::Serialize>(v: T) -> Result<Value, ApiError> {
    serde_json::to_value(v).map_err(|e| ApiError::new("internal", format!("encode result: {e}")))
}

/// Maps a herdr error onto the wire error.
pub fn herdr_err(e: tf_herdr::HerdrError) -> ApiError {
    let retryable = e.is_transient();
    let mut err = match e.code.as_str() {
        "agent_blocked" => ApiError::new("agent_blocked", e.message)
            .with_hint("The agent shows a dialog; answer it or open the terminal"),
        c if c.ends_with("not_found") => ApiError::new("not_found", e.message),
        "server_not_running" => ApiError::new("herdr_error", e.message).with_hint("herdr is not running on this host"),
        "timeout" => ApiError::new("timeout", e.message),
        _ => ApiError::new("herdr_error", format!("{}: {}", e.code, e.message)),
    };
    err.retryable = retryable;
    err
}
