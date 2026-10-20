//! `tf-client` ⇄ `tf-hostd` wire messages: one JSON object per line over the stdio of
//! `tf-hostd attach` (which bridges to the daemon's local socket).
//!
//! Flow:
//! 1. client → `hello`; hostd → `welcome` (or `error` with `version_mismatch` and closes).
//! 2. hostd → `snapshot` (full [`HostState`]) then `patch`es as state changes.
//!    Revisions (`rev`) increase by one per message; a gap means the client must
//!    request `state.get` and replace its state.
//! 3. client → `req` / hostd → `res` (correlated by `id`).
//! 4. `session.open` subscribes the client to `session` events for that agent until
//!    `session.close` or disconnect. `term.open` subscribes to `term` events until close.
//! 5. `pulse` messages (≤ 10 Hz) carry liveness ticks; `notify` carries notifications.
//! 6. `ping`/`pong` every 15 s measure latency; either side drops the link after 45 s of silence.

use crate::model::{HostState, Notification, Pulse, StatePatch};
use crate::session::SessionEvent;
use crate::term::TermEvent;
use crate::{ApiError, Millis};

wire_struct! {
    pub struct ClientInfo {
        /// `teleflock-desktop` | `teleflock-android` | `teleflock-devserver`.
        pub app: String,
        pub version: String,
        /// `windows` | `android` | `linux` | `macos` | `web`.
        pub platform: String,
        /// Device display name (shown as the author of prompts sent from it).
        pub device: String,
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ClientMsg {
    Hello {
        protocol: u32,
        client: ClientInfo,
        /// herdr session to attach to (`default`).
        herdr_session: String,
    },
    Req {
        id: u64,
        method: String,
        #[ts(type = "unknown")]
        params: serde_json::Value,
    },
    /// Keyboard input for an open terminal (fast path, no response). `data` is UTF-8 text
    /// exactly as produced by xterm.js `onData` (Enter = `\r`).
    TermIn { term_id: String, data: String },
    Ping { ts: Millis },
    Bye,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum ServerMsg {
    Welcome { protocol: u32, hostd_version: String, client_id: String },
    Res {
        id: u64,
        #[ts(type = "unknown")]
        result: Option<serde_json::Value>,
        error: Option<ApiError>,
    },
    Snapshot { rev: u64, state: HostState },
    Patch { rev: u64, ops: Vec<StatePatch> },
    Pulse { at: Millis, pulses: Vec<Pulse> },
    Session { agent_id: String, ev: SessionEvent },
    Term { term_id: String, ev: TermEvent },
    Notify { notification: Notification },
    Pong { ts: Millis },
    /// Fatal protocol error; the daemon closes the connection after sending it.
    Error { error: ApiError },
}
