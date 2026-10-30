//! `agent.getRoleModels` / `agent.setRoleModels` (architecture §3.7): one running agent's own omp
//! model roles and fallback chains. The bridge (≥ 2.1.0, `caps.roleModels`) reads them and applies
//! them as omp runtime overrides of that process; hostd keeps them for the agent
//! ([`crate::agentcfg`]: rewrites the `--config` overlay its omp was started with, and a resume
//! starts the new omp with them). The host's omp config is never written.

use tf_proto::methods::{SessionRoleModels, SetRoleModelsParams};
use tf_proto::ApiError;
use tracing::{info, warn};

use crate::agentcfg::{AgentOmp, Store};
use crate::bridge::RoleModelsState;
use crate::ops::agent::{bridge_sid, omp_agent, push_meta_overlay};
use crate::ops::Ctx;
use crate::util::now_ms;

/// How to get a bridge that has the role ops.
const RESTART_HINT: &str =
    "Restart the agent so its omp loads the current TeleFlock bridge: Mark done, then Resume it, or start a new agent";

pub async fn get(ctx: &Ctx, agent_id: &str) -> Result<SessionRoleModels, ApiError> {
    let sid = role_bridge(ctx, agent_id)?;
    let st = ctx.bridge.get_role_models(&sid).await.map_err(ApiError::from)?;
    Ok(wire(st))
}

pub async fn set(ctx: &Ctx, p: SetRoleModelsParams) -> Result<SessionRoleModels, ApiError> {
    let cfg = AgentOmp { role_models: p.role_models, fallback_chains: p.fallback_chains };
    cfg.validate()?;
    let sid = role_bridge(ctx, &p.agent_id)?;
    let name = ctx.state.agent(&p.agent_id).map(|a| a.name).unwrap_or_else(|| p.agent_id.clone());
    let store = Store::new(&ctx.paths);
    let io = |e: std::io::Error| ApiError::new("io_error", format!("saving the agent's omp settings: {e}"));
    let prev = store.set(&ctx.herdr_session, &p.agent_id, &cfg, &name, now_ms()).map_err(io)?;
    let overlay = store.get(&ctx.herdr_session, &p.agent_id).and_then(|r| store.path_of(&r)).map(|p| p.display().to_string());
    match ctx.bridge.set_role_models(&sid, &cfg.role_models, &cfg.fallback_chains, overlay.as_deref()).await {
        Ok(st) => {
            info!(agent = %p.agent_id, roles = cfg.role_models.len(), chains = cfg.fallback_chains.len(), "session model roles set");
            push_meta_overlay(ctx, &sid);
            Ok(wire(st))
        }
        Err(e) => {
            if let Err(undo) = store.restore(&ctx.herdr_session, &p.agent_id, prev, &name) {
                warn!(agent = %p.agent_id, "restoring the agent's omp settings: {undo}");
            }
            Err(ApiError::from(e))
        }
    }
}

/// The bridge session of a live omp agent whose bridge has the role ops.
fn role_bridge(ctx: &Ctx, agent_id: &str) -> Result<String, ApiError> {
    let a = omp_agent(ctx, agent_id)?;
    let sid = bridge_sid(ctx, agent_id).ok_or_else(|| {
        ApiError::new("unsupported", format!("{}'s omp has no TeleFlock bridge, which changes model roles", a.name)).with_hint(RESTART_HINT)
    })?;
    if !ctx.bridge.by_session(&sid).is_some_and(|b| b.caps.role_models) {
        return Err(ApiError::new(
            "unsupported",
            format!("{} runs a TeleFlock bridge older than 2.1.0 (or an omp without the settings it needs), which can't change model roles", a.name),
        )
        .with_hint(RESTART_HINT));
    }
    Ok(sid)
}

fn wire(st: RoleModelsState) -> SessionRoleModels {
    SessionRoleModels {
        session: st.session,
        host: st.host,
        session_chains: st.session_chains,
        host_chains: st.host_chains,
        active: st.active,
        warning: st.warning,
    }
}
