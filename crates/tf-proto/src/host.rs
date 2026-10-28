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
//! 7. Features (`ClientInfo::features` ∩ what hostd speaks, echoed in `welcome.features`):
//!    * [`FEATURE_ZSTD`]: right after `welcome`, both directions switch to one zstd stream each
//!      (every message batch is flushed as a zstd block, so nothing waits for more input).
//!    * [`FEATURE_SESSION_SYNC`]: `session.open` takes `have` (what the client caches) and may
//!      answer with a delta snapshot (`SessionSnapshot::sync`); that subscription's `session`
//!      messages carry `seq` (1, 2, … from `sync.seq`: a gap means re-open with `have`), rows carry
//!      hashes (`upsert.h`), appends their start offset (`append.at`), and `meta` becomes
//!      `metaPatch` / `treePatch`. Clients without it get exactly the older messages.

use crate::model::{HostState, Notification, Pulse, StatePatch};
use crate::session::SessionEvent;
use crate::term::TermEvent;
use crate::{ApiError, Millis};

/// Wire feature: zstd-compressed streams after `welcome`.
pub const FEATURE_ZSTD: &str = "zstd";
/// Wire feature: cached, resumable session subscriptions (delta snapshots, seq, patches).
pub const FEATURE_SESSION_SYNC: &str = "sessionSync";

wire_struct! {
    pub struct ClientInfo {
        /// `teleflock-desktop` | `teleflock-android` | `teleflock-devserver`.
        pub app: String,
        pub version: String,
        /// `windows` | `android` | `linux` | `macos` | `web`.
        pub platform: String,
        /// Device display name (shown as the author of prompts sent from it).
        pub device: String,
        /// Wire features this client speaks ([`FEATURE_ZSTD`], [`FEATURE_SESSION_SYNC`]).
        pub features: Option<Vec<String>>,
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
    Welcome {
        protocol: u32,
        hostd_version: String,
        client_id: String,
        /// The client's features this hostd accepted (absent: none).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        features: Option<Vec<String>>,
    },
    Res {
        id: u64,
        #[ts(type = "unknown")]
        result: Option<serde_json::Value>,
        error: Option<ApiError>,
    },
    Snapshot { rev: u64, state: HostState },
    Patch { rev: u64, ops: Vec<StatePatch> },
    Pulse { at: Millis, pulses: Vec<Pulse> },
    Session {
        agent_id: String,
        ev: SessionEvent,
        /// Position in a `sessionSync` subscription (1, 2, … after the snapshot's `sync.seq`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        seq: Option<u64>,
    },
    Term { term_id: String, ev: TermEvent },
    Notify { notification: Notification },
    Pong { ts: Millis },
    /// Fatal protocol error; the daemon closes the connection after sending it.
    Error { error: ApiError },
}
