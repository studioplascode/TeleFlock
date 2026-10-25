//! `omp.*` methods: omp's settings schema and global config (owner: OmpSettings).
//! Skeleton until the implementation lands; every method answers `unknown_method`.

use serde_json::Value;
use tf_proto::{ApiError, HostMethod};

use crate::clients::ClientHandle;
use crate::ops::Ctx;

pub async fn handle(_ctx: &Ctx, req: HostMethod, _client: &ClientHandle) -> Result<Value, ApiError> {
    Err(ApiError::new("unknown_method", format!("{} is not implemented yet", req.name())))
}
