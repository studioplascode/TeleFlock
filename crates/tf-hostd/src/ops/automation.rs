//! `automation.*` methods: scheduled agent runs on this host (architecture §3.11). The daemon's
//! [`crate::automations::Automations`] does the work; a client sees the automations of its own
//! herdr session.

use serde_json::Value;
use tf_proto::{ApiError, Empty, HostMethod};

use crate::clients::ClientHandle;
use crate::ops::{to_value, Ctx};

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    use HostMethod as M;
    let Some(a) = crate::automations::get() else {
        return Err(ApiError::new("unavailable", "the automation scheduler is not running").retryable());
    };
    match req {
        M::AutomationListReq(_) => to_value(a.list(&ctx.herdr_session)),
        M::AutomationSave(d) => {
            let saved = a.save(&ctx.herdr_session, d)?;
            a.sync_keepalive().await;
            to_value(saved)
        }
        M::AutomationDelete(r) => {
            a.delete(&ctx.herdr_session, &r.id)?;
            a.sync_keepalive().await;
            to_value(Empty {})
        }
        M::AutomationRunNow(r) => to_value(a.run_now(ctx, &r.id).await?),
        M::AutomationPreview(p) => to_value(crate::automations::preview(&p.schedule)),
        other => Err(ApiError::new("unknown_method", format!("{} is not an automation method", other.name()))),
    }
}
