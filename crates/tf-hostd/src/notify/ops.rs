//! `notify.*` (architecture §3.21): the host's routing policy, the apps connected to the caller's
//! herdr session, push channels (write-only secrets) and tests.

use serde_json::Value;

use tf_proto::{ApiError, HostMethod};

use crate::clients::ClientHandle;
use crate::ops::{to_value, Ctx};

pub async fn handle(ctx: &Ctx, req: HostMethod, client: &ClientHandle) -> Result<Value, ApiError> {
    let (n, session) = (&ctx.notify, ctx.herdr_session.as_str());
    match req {
        HostMethod::NotifyConfigGet(_) => {}
        HostMethod::NotifySetPolicy(p) => n.set_policy(p)?,
        HostMethod::NotifySaveChannel(s) => {
            n.save_channel(s)?;
        }
        HostMethod::NotifyRemoveChannel(r) => n.remove_channel(&r.id)?,
        HostMethod::NotifyTest(p) => return to_value(n.test(&ctx.state, session, p).await?),
        other => return Err(ApiError::new("unknown_method", format!("unknown method `{}`", other.name()))),
    }
    to_value(n.config(session, client.id()))
}
