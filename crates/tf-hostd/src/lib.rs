//! TeleFlock host daemon (architecture §3). See README.md for the module contracts.

pub mod agentcfg;
pub mod artifacts;
pub mod attach;
pub mod authflow;
pub mod autoanswer;
pub mod automations;
pub mod bridge;
pub mod clients;
pub mod daemon;
pub mod feed;
pub mod find;
pub mod herdr_health;
pub mod limit_resume;
pub mod inject;
pub mod ipc;
pub mod journal;
pub mod live_rows;
pub mod logging;
pub mod lossy_json;
pub mod notes;
pub mod notify;
pub mod omp;
pub mod ops;
pub mod originals;
pub mod paths;
pub mod recovery;
pub mod restart;
pub mod secure;
pub mod state;
pub mod sync;
/// Scripts written for tests that run them right away (`ETXTBSY`-proof); not part of the daemon.
#[cfg(unix)]
#[doc(hidden)]
pub mod test_exe;
pub mod util;
pub mod userenv;

/// Version line printed by `tf-hostd --version`.
pub fn version_line() -> String {
    format!("tf-hostd {} proto {}", env!("CARGO_PKG_VERSION"), tf_proto::PROTOCOL_VERSION)
}

pub const HOSTD_VERSION: &str = env!("CARGO_PKG_VERSION");
