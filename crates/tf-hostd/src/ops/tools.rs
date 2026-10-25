//! `host.toolsUpdate` / `host.toolsConfig`: keeping omp and herdr up to date (owner: ToolUpdates).
//! Skeleton until the updater lands; every method answers `unknown_method`.

use serde_json::Value;
use tf_proto::{ApiError, HostMethod};

use crate::ops::Ctx;

pub async fn handle(_ctx: &Ctx, req: HostMethod) -> Result<Value, ApiError> {
    Err(ApiError::new("unknown_method", format!("{} is not implemented yet", req.name())))
}
