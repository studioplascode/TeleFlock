//! Forwarding between hosts: processes on one host (the **from** host) run commands, open
//! shells, call tools and reach loopback ports on another host (the **to** host). Hosts never
//! talk to each other: an app core connected to both relays (`tf-client`, `forward` module).
//!
//! * App methods (`forward.list` / `save` / `remove` / `stop`) and [`crate::app::AppEvent::Forwards`]:
//!   rules are configured and saved on the device that relays ([`ForwardRule`]).
//! * Wire ([`crate::host::FEATURE_FORWARD`]): the app offers each from-host the rules it relays
//!   for it (`fwdOffer` → [`FwdOffer`], answered by `fwdOffered` → [`FwdOfferState`]); byte
//!   streams run as `fwd` messages ([`FwdEv`]) in both directions of a link. A stream is opened by
//!   the from-host's tf-hostd (`tf-forward`, a tool shim or a port connection) towards the app,
//!   and by the app towards the to-host's tf-hostd, which runs it. Stream ids belong to their
//!   opener: the app opens odd ids, tf-hostd even ones, so the two never clash on one link.
//!   Flow control is per stream and direction: a sender keeps at most [`FWD_WINDOW`] bytes
//!   unacknowledged (`ack`: bytes the receiver consumed), in data frames of at most
//!   [`FWD_CHUNK`] bytes; the app passes acknowledgements through, so the bound holds end to end
//!   and no stream can grow the link's queues or starve its other traffic.

use crate::Millis;

/// Largest payload of one `data` frame (bytes before base64).
pub const FWD_CHUNK: usize = 32 * 1024;
/// Unacknowledged bytes a stream may have in flight per direction.
pub const FWD_WINDOW: u64 = 256 * 1024;
/// Streams one rule may have open at once (a browser keeps a handful of connections per origin,
/// a DevTools client a few). The app refuses more, and so does the from-host's tf-hostd per name:
/// nothing on the from-host can pile up streams, connections and programs on either host.
pub const FWD_STREAMS: usize = 64;

wire_struct! {
    /// A forward from one host to another, saved on the relaying device (never on a host).
    pub struct ForwardRule {
        /// `""` in `forward.save` = a new rule (the core assigns the id).
        pub id: String,
        /// Host id whose processes use the forward.
        pub from_host: String,
        /// Host id where commands run and connections land.
        pub to_host: String,
        /// What from-host processes call the to-host (`tf-forward <name>`):
        /// `[a-z0-9][a-z0-9-]{0,31}`, unique per `from_host`.
        pub name: String,
        pub enabled: bool,
        /// Commands and interactive shells.
        pub shell: bool,
        /// Command names forwarded by name (shims): `[A-Za-z0-9._+-]{1,64}`, unique within the rule.
        #[serde(default)]
        pub tools: Vec<String>,
        #[serde(default)]
        pub ports: Vec<ForwardPort>,
    }
}

wire_struct! {
    /// A connection to `127.0.0.1:<listen>` on the from-host reaches `127.0.0.1:<target>` on the
    /// to-host.
    pub struct ForwardPort {
        pub listen: u16,
        pub target: u16,
    }
}

wire_enum! {
    /// * `ready`: both hosts connected and speaking forwarding.
    /// * `waiting`: a host is not connected.
    /// * `unsupported`: a host's tf-hostd predates 0.8.0 (it updates when this app reconnects).
    /// * `disabled`: the rule is off.
    /// * `error`: see [`ForwardStatus::message`].
    pub enum ForwardState { Ready, Waiting, Unsupported, Disabled, Error }
}

wire_struct! {
    pub struct ForwardStatus {
        /// Rule id.
        pub id: String,
        pub state: ForwardState,
        pub message: Option<String>,
        /// Listen ports the from-host could not bind, with the reason.
        #[serde(default)]
        pub port_errors: Vec<ForwardPortError>,
    }
}

wire_struct! {
    pub struct ForwardPortError {
        pub listen: u16,
        pub message: String,
    }
}

wire_enum! {
    /// `browser`: a DevTools connection of an agent attached to the TeleFlock Browser
    /// (`crate::browser`); tf-hostd opens it towards the attaching app (`name`: the agent id,
    /// `port`: the port tf-hostd listens on), which connects it to its browser.
    pub enum ForwardKind { Command, Shell, Tool, Port, Browser }
}

wire_struct! {
    /// A connection running through a rule right now.
    pub struct ForwardStream {
        pub id: String,
        pub rule_id: String,
        pub kind: ForwardKind,
        /// The command line; tool + args; or `127.0.0.1:<listen> → <target>`.
        pub label: String,
        pub started_at: Millis,
        /// from-host → to-host bytes.
        pub bytes_up: u64,
        /// to-host → from-host bytes.
        pub bytes_down: u64,
    }
}

wire_struct! {
    /// `forward.*` results and [`crate::app::AppEvent::Forwards`].
    pub struct ForwardList {
        pub rules: Vec<ForwardRule>,
        /// One per rule.
        pub status: Vec<ForwardStatus>,
        pub streams: Vec<ForwardStream>,
    }
}

wire_struct! {
    /// `forward.save`: create (`rule.id` empty) or replace a rule. Validation errors are
    /// `invalid_params` whose message starts with the field (`name: …`, `toHost: …`, `tools: …`,
    /// `ports: …`).
    pub struct ForwardSaveParams {
        pub rule: ForwardRule,
    }
}

wire_struct! {
    /// `forward.remove`: deletes the rule and ends its streams.
    pub struct ForwardRemoveParams {
        pub id: String,
    }
}

wire_struct! {
    /// `forward.stop`: ends one stream (its remote process is killed).
    pub struct ForwardStopParams {
        pub stream_id: String,
    }
}

// ───────────────────────────── wire (tf-client ⇄ tf-hostd) ─────────────────────────────

wire_struct! {
    /// A rule the app relays for this host as its from-host (`fwdOffer`). Every `fwdOffer`
    /// replaces the app's previous list; the offers vanish with the link.
    pub struct FwdOffer {
        /// [`ForwardRule::name`].
        pub name: String,
        /// Display name of the to-host (`tf-forward --list`).
        pub to: String,
        pub shell: bool,
        #[serde(default)]
        pub tools: Vec<String>,
        #[serde(default)]
        pub ports: Vec<ForwardPort>,
        /// The to-host is connected to the app and speaks forwarding: streams open now.
        pub ready: bool,
        /// Why streams don't open now (`ready` false), in the app's words: the to-host is not
        /// connected, or runs a tf-hostd without forwarding. Older apps send none.
        #[serde(default)]
        pub reason: Option<String>,
    }
}

wire_struct! {
    /// tf-hostd's answer to a `fwdOffer`, one per offered name.
    pub struct FwdOfferState {
        pub name: String,
        /// This app relays the name (when several apps offer one name, the newest offer wins).
        pub active: bool,
        /// Why the name is not relayed by this app, or what is wrong with it.
        pub message: Option<String>,
        /// Listen ports tf-hostd could not bind for this name.
        #[serde(default)]
        pub port_errors: Vec<ForwardPortError>,
    }
}

wire_struct! {
    /// A terminal on the to-host.
    pub struct FwdPty {
        pub cols: u16,
        pub rows: u16,
        /// `TERM` for the remote process (default `xterm-256color`).
        pub term: Option<String>,
    }
}

/// One event of a forwarding stream (`fwd { sid, ev }`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum FwdEv {
    /// Opens stream `sid` (the opener's id).
    Open {
        kind: ForwardKind,
        /// [`ForwardRule::name`].
        name: String,
        /// `command`: the command line, run by the to-host user's shell.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        command: Option<String>,
        /// `tool`: the program and its arguments, exactly.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        argv: Option<Vec<String>>,
        /// A terminal for the remote process (command, shell, tool).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        pty: Option<FwdPty>,
        /// Working directory on the to-host (default: the user's home).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cwd: Option<String>,
        /// `port`: the listen port (from-host → app) or the target port (app → to-host).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        port: Option<u16>,
    },
    /// The to-host started it (`pty`: with a terminal; a Windows to-host runs with pipes).
    Opened { pty: bool },
    /// Base64 payload of at most [`FWD_CHUNK`] bytes. `fd`: 0 towards the to-host (stdin, the
    /// connection), 1 stdout or the connection back, 2 stderr.
    Data {
        data: String,
        #[serde(default)]
        fd: u8,
    },
    /// The sender writes no more in this direction (stdin closed, the connection half-closed).
    Eof,
    /// The receiver consumed `n` more bytes of this direction: the sender may send that much more.
    Ack { n: u64 },
    /// The caller's terminal changed size.
    Resize { cols: u16, rows: u16 },
    /// The remote process ended (after its output); the stream is over.
    Exit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<i32>,
        /// Unix signal number that ended it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        signal: Option<i32>,
    },
    /// The stream is over: an error (the CLI prints it and exits 255), or nothing more to say
    /// (a port connection that ended, a caller that went away).
    Close {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<String>,
    },
}

impl FwdEv {
    /// Ends the stream (no event of it follows).
    pub fn is_final(&self) -> bool {
        matches!(self, FwdEv::Exit { .. } | FwdEv::Close { .. })
    }
}

/// Payload bytes of a base64 `data` string (padded, as [`FwdEv::Data`] carries it), without
/// decoding it.
pub fn b64_len(data: &str) -> u64 {
    let b = data.as_bytes();
    let pad = b.iter().rev().take(2).take_while(|c| **c == b'=').count();
    (b.len() / 4 * 3).saturating_sub(pad) as u64
}

/// Whether a file name is a DOS device name on Windows (`con`, `prn`, `aux`, `nul`, `com1`–`com9`,
/// `lpt1`–`lpt9`, in any case, also with an extension): a tool shim of that name would be the
/// device, not a file.
pub fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shapes() {
        let ev = FwdEv::Data { data: "aGk=".into(), fd: 1 };
        assert_eq!(serde_json::to_string(&ev).unwrap(), r#"{"t":"data","data":"aGk=","fd":1}"#);
        let open: FwdEv = serde_json::from_str(r#"{"t":"open","kind":"command","name":"laptop","command":"ls -l"}"#).unwrap();
        assert_eq!(
            open,
            FwdEv::Open { kind: ForwardKind::Command, name: "laptop".into(), command: Some("ls -l".into()), argv: None, pty: None, cwd: None, port: None }
        );
        assert_eq!(serde_json::to_string(&FwdEv::Close { error: None }).unwrap(), r#"{"t":"close"}"#);
        let up: FwdEv = serde_json::from_str(r#"{"t":"data","data":""}"#).unwrap();
        assert_eq!(up, FwdEv::Data { data: String::new(), fd: 0 });
        assert!(FwdEv::Exit { code: Some(0), signal: None }.is_final() && !FwdEv::Eof.is_final());
    }

    #[test]
    fn base64_payload_length() {
        for (s, n) in [("", 0), ("aA==", 1), ("aGk=", 2), ("aGkh", 3), ("aGkhIQ==", 4)] {
            assert_eq!(b64_len(s), n, "{s}");
        }
    }

    #[test]
    fn windows_device_names() {
        for d in ["con", "NUL", "aux.txt", "Com1", "lpt9.cmd", "prn.", "nul.tar.gz"] {
            assert!(is_windows_device_name(d), "{d}");
        }
        for ok in ["console", "com0", "com10", "lpt", "null", "conda", "x.con", "agent-browser"] {
            assert!(!is_windows_device_name(ok), "{ok}");
        }
    }
}
