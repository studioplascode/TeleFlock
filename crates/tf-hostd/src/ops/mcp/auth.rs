//! `mcp.authStart`: an MCP server's OAuth sign-in, run by omp on the host and completed from the
//! app (shared `auth.*` flow, architecture §3.14/§3.15).
//!
//! The helper runs omp's `/mcp reauth` engine (`reauthorizeMcpServer`: discovery, client
//! registration, PKCE, omp's loopback callback server, credential storage, config write-back).
//! Its authorization URL becomes the flow's `url`; the redirect (`http://localhost:<port>/…`)
//! reaches omp's callback server through the app's same-port tunnel. A pasted address goes the
//! same way ([`authflow::replay_redirect`], after [`authflow::check_paste`]); without a loopback
//! redirect (a custom `oauth.redirectUri`) it is handed to omp's manual-code input instead.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tf_proto::{ApiError, AuthFlow, AuthFlowState, AuthPaste};

use super::helper::{HelperEnv, Running};
use crate::authflow::{self, FlowCtl, LoopbackRedirect};
use crate::ops::Ctx;

/// omp gives up after 5 minutes; the flow outlives it a little so omp's own message shows.
const FLOW_TTL: Duration = Duration::from_secs(6 * 60);

/// What the driver needs to know about the server being signed in.
pub struct Target {
    pub name: String,
    /// omp's cwd for the sign-in (the project folder, or the neutral user-level folder).
    pub cwd: PathBuf,
    /// The project folder (sessions to reload after it); `None` for a user-scope server.
    pub project: Option<PathBuf>,
    /// Probe-cache key of the list the server belongs to.
    pub check_key: PathBuf,
}

pub async fn start(ctx: &Ctx, env: &HelperEnv, t: Target) -> Result<AuthFlow, ApiError> {
    let run = Running::start(env, &t.cwd, json!({ "op": "auth", "name": t.name })).await?;
    let flow = authflow::start("mcp", t.name.clone(), Some(t.name.clone()), FLOW_TTL);
    let snapshot = flow.snapshot();
    tokio::spawn(drive(flow, run, ctx.arc(), t));
    Ok(snapshot)
}

async fn drive(mut flow: FlowCtl, mut run: Running, ctx: Arc<Ctx>, t: Target) {
    let mut redirect: Option<LoopbackRedirect> = None;
    loop {
        tokio::select! {
            line = run.next() => {
                let Some(line) = line else {
                    let tail = run.stderr_tail();
                    let why = if tail.is_empty() { "omp stopped before the sign-in finished.".to_string() } else { format!("omp stopped: {}", crate::util::clip(&tail, 300)) };
                    flow.finish(AuthFlowState::Failed, Some(why));
                    return;
                };
                match line.get("t").and_then(Value::as_str) {
                    Some("auth") => {
                        let url = line.get("url").and_then(Value::as_str).unwrap_or_default();
                        let instructions = line.get("instructions").and_then(Value::as_str).map(str::to_string);
                        redirect = flow.publish_url(url, instructions);
                        if redirect.is_none() {
                            // The provider sends the browser somewhere this host can't see: paste.
                            flow.update(|f| f.paste = AuthPaste::Primary);
                        }
                    }
                    Some("progress") => {
                        if let Some(m) = line.get("message").and_then(Value::as_str) {
                            let m = m.to_string();
                            flow.update(|f| f.message = Some(m));
                        }
                    }
                    Some("result") => {
                        super::mark_dirty(&t.check_key, &t.name);
                        let reload = super::reload::reload(&ctx, t.project.as_deref()).await;
                        let mut msg = format!("Signed in to {}.", t.name);
                        if reload.reloaded > 0 {
                            msg.push_str(&format!(" Reloaded in {} running session{}.", reload.reloaded, if reload.reloaded == 1 { "" } else { "s" }));
                        }
                        flow.update(|f| f.account = Some(t.name.clone()));
                        flow.finish(AuthFlowState::Done, Some(msg));
                        return;
                    }
                    Some("error") => {
                        let e = super::helper::helper_error(&line);
                        let state = if e.code == "cancelled" { AuthFlowState::Cancelled } else { AuthFlowState::Failed };
                        flow.finish(state, Some(e.message));
                        return;
                    }
                    _ => {}
                }
            }
            input = flow.next_input() => {
                let Some(input) = input else {
                    // Cancelled, expired or finished elsewhere: stop omp (and its callback server).
                    run.kill().await;
                    return;
                };
                let verdict = match &redirect {
                    Some(r) => deliver(r, &input.text).await,
                    None => run.send_input(input.text.trim()),
                };
                input.reply(verdict);
            }
        }
    }
}

/// A pasted address or code → omp's callback server, as the browser would have delivered it.
async fn deliver(r: &LoopbackRedirect, pasted: &str) -> Result<(), ApiError> {
    authflow::check_paste(r, pasted)?;
    match authflow::replay_redirect(r, pasted).await? {
        200..=299 => Ok(()),
        status => Err(ApiError::new("invalid_params", format!("omp didn't accept that address (HTTP {status})"))
            .with_hint("Paste the address from the sign-in you started last, after approving it.")),
    }
}
