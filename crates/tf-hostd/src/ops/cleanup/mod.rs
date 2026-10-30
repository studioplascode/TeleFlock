//! `cleanup.*` (architecture §3.17): the Cleanup page. Linked worktrees with what deciding whether
//! to delete them takes (`scan`), their removal checked again right before (`remove`), and omp's
//! storage maintenance limited to what is not a session (`storage`). Sessions are never archived
//! or deleted here.

pub mod remove;
pub mod scan;
pub mod storage;

mod prs;
mod size;

use serde_json::Value;
use tf_proto::{ApiError, HostMethod};

use crate::clients::ClientHandle;
use crate::ops::{Ctx, to_value};

pub async fn handle(ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    match req {
        HostMethod::CleanupWorktrees(p) => to_value(scan::report(ctx, &p).await),
        HostMethod::CleanupRemove(p) => to_value(remove::remove(ctx, &p).await?),
        HostMethod::CleanupStorageReq(p) => to_value(storage::status(p.wait_ms).await),
        HostMethod::CleanupStorageRun(p) => to_value(storage::run(&p).await?),
        other => Err(ApiError::new(
            "unknown_method",
            format!("{} is not a cleanup method", other.name()),
        )),
    }
}
