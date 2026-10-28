//! TeleFlock host daemon (architecture §3). See README.md for the module contracts.

pub mod artifacts;
pub mod attach;
pub mod authflow;
pub mod automations;
pub mod bridge;
pub mod clients;
pub mod daemon;
pub mod feed;
pub mod inject;
pub mod ipc;
pub mod journal;
pub mod logging;
pub mod omp;
pub mod ops;
pub mod originals;
pub mod paths;
pub mod secure;
pub mod state;
pub mod sync;
pub mod util;
pub mod userenv;

/// Version line printed by `tf-hostd --version`.
pub fn version_line() -> String {
    format!("tf-hostd {} proto {}", env!("CARGO_PKG_VERSION"), tf_proto::PROTOCOL_VERSION)
}

pub const HOSTD_VERSION: &str = env!("CARGO_PKG_VERSION");
