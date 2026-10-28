//! TeleFlock app core (architecture §5.2), shared by the Tauri shell and `tf-devserver`.
//!
//! See `README.md` for the public API.

mod conn;
mod deploy;
mod diag;
mod engine;
mod link;
mod platform;
mod secrets;
mod session_cache;
mod sessions;
mod settings;
mod state;
mod tunnel;
mod util;

pub use deploy::HOSTD_VERSION;
pub use engine::{Engine, EngineConfig, Resume};
pub use platform::{BadgeState, NotifyStyle, Platform};
pub use tf_proto;
