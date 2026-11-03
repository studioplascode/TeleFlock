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
//!    * [`FEATURE_PRESENCE`]: the client sends `presence` (what its user is doing) after the
//!      welcome and on every change, and `notifyRead` for notifications it marked read; hostd
//!      marks each `notify` with `alert` (post it to the system now, or only list it), sends
//!      `notifyAlert` when an unseen one escalates to this device and `notifyDone` when another
//!      device read one (`crate::notify`). Clients without it get every `notify` as before.
//!    * [`FEATURE_FORWARD`]: host-to-host forwarding (`crate::forward`). The client sends
//!      `fwdOffer` (the rules it relays for this host as their from-host) after the welcome and on
//!      every change; hostd answers each with `fwdOffered`. `fwd` messages carry the streams in
//!      both directions. Without it neither side sends any of them (the app shows the rules as
//!      `unsupported`).
//!    * [`FEATURE_BROWSER`]: the client has a TeleFlock Browser (`crate::browser`; desktop apps
//!      ≥ 0.9.0). It may call `agent.browserAttach`, whose connections arrive as `fwd` streams of
//!      kind `browser` (also without [`FEATURE_FORWARD`]), and hostd sends it `browserDetached`
//!      when an attachment it made ended on the host. Pending `use_user_browser` requests are on
//!      the board (`Agent.browser`) for every client. An agent asking for a browser while no
//!      client with the feature is connected is told at once that none is available.
//!    * [`FEATURE_NOTIFY_KINDS`]: the client reads a notification kind it does not know as `info`
//!      (`NotifyKind`'s deserializer; apps ≥ 0.9.1), so hostd sends it every kind. Without it a
//!      client gets only the kinds every app can parse (`NotifyKind::known_to_every_app`): no
//!      `presented` notification goes to it, since an older app drops a line it cannot parse.

use crate::forward::{FwdEv, FwdOffer, FwdOfferState};
use crate::model::{HostState, Notification, Pulse, StatePatch};
use crate::notify::Presence;
use crate::session::SessionEvent;
use crate::term::TermEvent;
use crate::{ApiError, Millis};

/// Wire feature: zstd-compressed streams after `welcome`.
pub const FEATURE_ZSTD: &str = "zstd";
/// Wire feature: cached, resumable session subscriptions (delta snapshots, seq, patches).
pub const FEATURE_SESSION_SYNC: &str = "sessionSync";
/// Wire feature: device presence and notification routing (`crate::notify`).
pub const FEATURE_PRESENCE: &str = "presence";
/// Wire feature: host-to-host forwarding offers and streams (`crate::forward`).
pub const FEATURE_FORWARD: &str = "forward";
/// Wire feature: the client has a TeleFlock Browser that agents may attach to (`crate::browser`).
pub const FEATURE_BROWSER: &str = "browser";
/// Wire feature: the client takes every notification kind, reading unknown ones as `info`.
pub const FEATURE_NOTIFY_KINDS: &str = "notifyKinds";

wire_struct! {
    pub struct ClientInfo {
        /// `teleflock-desktop` | `teleflock-android` | `teleflock-devserver`.
        pub app: String,
        pub version: String,
        /// `windows` | `android` | `linux` | `macos` | `web`.
        pub platform: String,
        /// Device display name (shown as the author of prompts sent from it).
        pub device: String,
        /// Wire features this client speaks ([`FEATURE_ZSTD`], [`FEATURE_SESSION_SYNC`],
        /// [`FEATURE_PRESENCE`], [`FEATURE_FORWARD`], [`FEATURE_BROWSER`],
        /// [`FEATURE_NOTIFY_KINDS`]).
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
    /// ([`FEATURE_PRESENCE`]) What this device's user is doing: after the welcome and on change.
    Presence { presence: Presence },
    /// ([`FEATURE_PRESENCE`]) Notifications this device marked read (opened the agent, tapped or
    /// dismissed the system notification, read the list): tf-hostd stops their escalation and
    /// retracts them on the other devices.
    NotifyRead { ids: Vec<String> },
    /// ([`FEATURE_FORWARD`]) The rules this client relays for this host as their from-host; replaces
    /// the previous list (empty: none).
    FwdOffer { offers: Vec<FwdOffer> },
    /// ([`FEATURE_FORWARD`], [`FEATURE_BROWSER`]) An event of forwarding stream `sid`.
    Fwd { sid: u64, ev: FwdEv },
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
    Notify {
        notification: Notification,
        /// ([`FEATURE_PRESENCE`]) `true`: post it to the system now; `false`: another device is in
        /// use, only list it (a `notifyAlert` may follow). Absent: decide locally, as before.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        alert: Option<bool>,
    },
    /// ([`FEATURE_PRESENCE`]) Notification `id` went unseen on the device in use: post it here now
    /// (unless it was read or resolved meanwhile).
    NotifyAlert { id: String },
    /// ([`FEATURE_PRESENCE`]) These notifications were read on another device (`by`): read and
    /// retracted here too, like a read in this app (pending needs-you ones stay posted).
    NotifyDone {
        ids: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        by: Option<String>,
    },
    Pong { ts: Millis },
    /// ([`FEATURE_FORWARD`]) What became of the client's last `fwdOffer`, per name.
    FwdOffered { states: Vec<FwdOfferState> },
    /// ([`FEATURE_FORWARD`], [`FEATURE_BROWSER`]) An event of forwarding stream `sid`.
    Fwd { sid: u64, ev: FwdEv },
    /// ([`FEATURE_BROWSER`]) This client's attachment of `agent_id` ended on the host (`reason`, in
    /// words): its turn-scoped permission ran out, the agent's omp session ended, or another
    /// device detached it.
    BrowserDetached { agent_id: String, reason: String },
    /// Fatal protocol error; the daemon closes the connection after sending it.
    Error { error: ApiError },
}
