//! Typed collab frames (`omp-collab.md` §5, `@oh-my-pi/pi-wire` `HostFrame`/`GuestFrame`).
//!
//! Parsing is tolerant: an unknown `t` (or a known `t` whose shape no longer matches) becomes
//! [`HostFrame::Unknown`] with the raw JSON. Session payloads (`entry`, `event`, `bus.data`) stay
//! [`serde_json::Value`]: they are unversioned and grow with every omp release; the replica reads
//! them field by field.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire protocol version carried in `hello`; the host rejects mismatches.
pub const COLLAB_PROTO: u32 = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeader {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub name: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsageWire {
    pub tokens: Option<f64>,
    pub context_window: Option<f64>,
    pub percent: Option<f64>,
}

/// Host footer state (`CollabSessionState`). `model` is the full omp model object.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    #[serde(default)]
    pub is_streaming: bool,
    #[serde(default)]
    pub is_aborting: bool,
    #[serde(default)]
    pub queued_message_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsageWire>,
    #[serde(default)]
    pub participants: Vec<Participant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub id: String,
    #[serde(default)]
    pub display_name: String,
    /// `main` | `sub`.
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// `running` | `idle` | `parked` | `aborted`.
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub has_session_file: bool,
    #[serde(default, deserialize_with = "lenient_millis")]
    pub created_at: i64,
    #[serde(default, deserialize_with = "lenient_millis")]
    pub last_activity: i64,
}

/// Epoch milliseconds as omp sends them: JS numbers. Agents restored from disk carry file times
/// (`birthtimeMs`, `mtimeMs`), which are fractional; `null` reads as 0 (unknown).
fn lenient_millis<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let n = Option::<serde_json::Number>::deserialize(d)?;
    Ok(n.and_then(|n| n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64))).unwrap_or(0))
}

/// An agent this build can't read is dropped, not the frame carrying it: a rejected `welcome`
/// is ignored by the guest, and its join would time out on every retry.
fn lenient_agents<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<AgentSnapshot>, D::Error> {
    let raw = Option::<Vec<Value>>::deserialize(d)?.unwrap_or_default();
    Ok(raw
        .into_iter()
        .filter_map(|v| {
            serde_json::from_value(v).map_err(|e| log::warn!("collab: skipping an unreadable agent snapshot: {e}")).ok()
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub proto: u32,
    pub header: SessionHeader,
    pub state: SessionState,
    #[serde(default, deserialize_with = "lenient_agents")]
    pub agents: Vec<AgentSnapshot>,
    #[serde(default)]
    pub entry_count: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnapshotChunk {
    pub entries: Vec<Value>,
    #[serde(rename = "final", default)]
    pub is_final: bool,
}

/// `string | {label, description?}` select item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SelectItem {
    Label(String),
    Rich {
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

impl SelectItem {
    pub fn label(&self) -> &str {
        match self {
            Self::Label(l) => l,
            Self::Rich { label, .. } => label,
        }
    }
    pub fn description(&self) -> Option<&str> {
        match self {
            Self::Label(_) => None,
            Self::Rich { description, .. } => description.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UiRequestFrame {
    Select {
        req_id: u64,
        title: String,
        options: Vec<SelectItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        initial_index: Option<u32>,
        /// `radio` | `checkbox`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selection_marker: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked_indices: Option<Vec<u32>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        markable_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        help_text: Option<String>,
    },
    Editor {
        req_id: u64,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefill: Option<String>,
    },
}

impl UiRequestFrame {
    pub fn req_id(&self) -> u64 {
        match self {
            Self::Select { req_id, .. } | Self::Editor { req_id, .. } => *req_id,
        }
    }
    pub fn title(&self) -> &str {
        match self {
            Self::Select { title, .. } | Self::Editor { title, .. } => title,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptFrame {
    pub req_id: u64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub new_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Host → guest frame.
#[derive(Debug, Clone, PartialEq)]
pub enum HostFrame {
    Welcome(Welcome),
    SnapshotChunk(SnapshotChunk),
    Entry { entry: Value },
    Event { event: Value },
    State { state: SessionState },
    Bus { channel: String, data: Value },
    Agents { agents: Vec<AgentSnapshot> },
    UiRequest { request: UiRequestFrame },
    UiRequestEnd { req_id: u64 },
    Transcript(TranscriptFrame),
    Bye { reason: String },
    Error { message: String },
    Unknown(Value),
}

/// Serde mirror of the known host frames (internal; `Unknown` handled in [`HostFrame::parse`]).
#[derive(Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
enum KnownHost {
    Welcome(Welcome),
    SnapshotChunk(SnapshotChunk),
    Entry { entry: Value },
    Event { event: Value },
    State { state: SessionState },
    Bus { channel: String, #[serde(default)] data: Value },
    Agents { #[serde(deserialize_with = "lenient_agents")] agents: Vec<AgentSnapshot> },
    UiRequest { request: UiRequestFrame },
    UiRequestEnd { req_id: u64 },
    Transcript(TranscriptFrame),
    Bye { #[serde(default)] reason: String },
    Error { #[serde(default)] message: String },
}

const KNOWN_TAGS: &[&str] = &[
    "welcome",
    "snapshot-chunk",
    "entry",
    "event",
    "state",
    "bus",
    "agents",
    "ui-request",
    "ui-request-end",
    "transcript",
    "bye",
    "error",
];

impl HostFrame {
    /// Parse decrypted frame JSON. Fails only on invalid JSON / non-object payloads.
    pub fn parse(json: &[u8]) -> Result<HostFrame, serde_json::Error> {
        let value: Value = serde_json::from_slice(json)?;
        Ok(Self::from_value(value))
    }

    pub fn from_value(value: Value) -> HostFrame {
        match serde_json::from_value::<KnownHost>(value.clone()) {
            Ok(k) => k.into(),
            Err(e) => {
                // An unknown `t` is a newer omp's business; a known one that no longer parses is
                // ignored by every consumer (a `welcome` stalls the join), so say why, a few times.
                static WARNED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                let tag = value.get("t").and_then(Value::as_str).unwrap_or("");
                if KNOWN_TAGS.contains(&tag) && WARNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 20 {
                    log::warn!("collab: {tag} frame doesn't match this build: {e}");
                }
                HostFrame::Unknown(value)
            }
        }
    }

    pub fn to_json(&self) -> Vec<u8> {
        let v = match self {
            HostFrame::Unknown(v) => return serde_json::to_vec(v).unwrap_or_default(),
            other => KnownHost::from(other.clone()),
        };
        serde_json::to_vec(&v).unwrap_or_default()
    }

    /// The frame tag (`t`).
    pub fn tag(&self) -> &str {
        match self {
            Self::Welcome(_) => "welcome",
            Self::SnapshotChunk(_) => "snapshot-chunk",
            Self::Entry { .. } => "entry",
            Self::Event { .. } => "event",
            Self::State { .. } => "state",
            Self::Bus { .. } => "bus",
            Self::Agents { .. } => "agents",
            Self::UiRequest { .. } => "ui-request",
            Self::UiRequestEnd { .. } => "ui-request-end",
            Self::Transcript(_) => "transcript",
            Self::Bye { .. } => "bye",
            Self::Error { .. } => "error",
            Self::Unknown(v) => v.get("t").and_then(Value::as_str).unwrap_or("?"),
        }
    }
}

impl From<KnownHost> for HostFrame {
    fn from(k: KnownHost) -> Self {
        match k {
            KnownHost::Welcome(w) => Self::Welcome(w),
            KnownHost::SnapshotChunk(c) => Self::SnapshotChunk(c),
            KnownHost::Entry { entry } => Self::Entry { entry },
            KnownHost::Event { event } => Self::Event { event },
            KnownHost::State { state } => Self::State { state },
            KnownHost::Bus { channel, data } => Self::Bus { channel, data },
            KnownHost::Agents { agents } => Self::Agents { agents },
            KnownHost::UiRequest { request } => Self::UiRequest { request },
            KnownHost::UiRequestEnd { req_id } => Self::UiRequestEnd { req_id },
            KnownHost::Transcript(t) => Self::Transcript(t),
            KnownHost::Bye { reason } => Self::Bye { reason },
            KnownHost::Error { message } => Self::Error { message },
        }
    }
}

impl From<HostFrame> for KnownHost {
    fn from(f: HostFrame) -> Self {
        match f {
            HostFrame::Welcome(w) => Self::Welcome(w),
            HostFrame::SnapshotChunk(c) => Self::SnapshotChunk(c),
            HostFrame::Entry { entry } => Self::Entry { entry },
            HostFrame::Event { event } => Self::Event { event },
            HostFrame::State { state } => Self::State { state },
            HostFrame::Bus { channel, data } => Self::Bus { channel, data },
            HostFrame::Agents { agents } => Self::Agents { agents },
            HostFrame::UiRequest { request } => Self::UiRequest { request },
            HostFrame::UiRequestEnd { req_id } => Self::UiRequestEnd { req_id },
            HostFrame::Transcript(t) => Self::Transcript(t),
            HostFrame::Bye { reason } => Self::Bye { reason },
            HostFrame::Error { message } => Self::Error { message },
            HostFrame::Unknown(_) => unreachable!("Unknown frames serialize their raw value"),
        }
    }
}

/// Image attached to a guest prompt (`ImageContent`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageContent {
    #[serde(rename = "type", default = "image_type")]
    pub kind: String,
    /// Base64 payload.
    pub data: String,
    pub mime_type: String,
}

fn image_type() -> String {
    "image".into()
}

impl ImageContent {
    pub fn new(data: impl Into<String>, mime_type: impl Into<String>) -> Self {
        Self { kind: image_type(), data: data.into(), mime_type: mime_type.into() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCmdKind {
    Chat,
    Kill,
    Revive,
}

/// Guest → host frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum GuestFrame {
    Hello {
        proto: u32,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        write_token: Option<String>,
    },
    Prompt {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageContent>,
    },
    UiResponse {
        req_id: u64,
        /// `None` = cancel.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
    },
    Abort {},
    AgentCmd {
        cmd: AgentCmdKind,
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    FetchTranscript { req_id: u64, agent_id: String, from_byte: u64 },
}

impl GuestFrame {
    pub fn to_json(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("guest frames always serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn guest_frames_match_wire() {
        let hello = GuestFrame::Hello { proto: COLLAB_PROTO, name: "teleflock".into(), write_token: Some("tok".into()) };
        assert_eq!(
            serde_json::to_value(&hello).unwrap(),
            json!({"t":"hello","proto":3,"name":"teleflock","writeToken":"tok"})
        );
        assert_eq!(serde_json::to_value(GuestFrame::Abort {}).unwrap(), json!({"t":"abort"}));
        assert_eq!(
            serde_json::to_value(GuestFrame::UiResponse { req_id: 2, value: Some("Blue".into()) }).unwrap(),
            json!({"t":"ui-response","reqId":2,"value":"Blue"})
        );
        assert_eq!(
            serde_json::to_value(GuestFrame::UiResponse { req_id: 2, value: None }).unwrap(),
            json!({"t":"ui-response","reqId":2})
        );
        assert_eq!(
            serde_json::to_value(GuestFrame::AgentCmd { cmd: AgentCmdKind::Chat, agent_id: "ReplyOk".into(), text: Some("hi".into()) })
                .unwrap(),
            json!({"t":"agent-cmd","cmd":"chat","agentId":"ReplyOk","text":"hi"})
        );
        assert_eq!(
            serde_json::to_value(GuestFrame::FetchTranscript { req_id: 9, agent_id: "A".into(), from_byte: 0 }).unwrap(),
            json!({"t":"fetch-transcript","reqId":9,"agentId":"A","fromByte":0})
        );
        assert_eq!(
            serde_json::to_value(GuestFrame::Prompt { text: "x".into(), images: vec![ImageContent::new("AAA", "image/png")] })
                .unwrap(),
            json!({"t":"prompt","text":"x","images":[{"type":"image","data":"AAA","mimeType":"image/png"}]})
        );
        assert_eq!(serde_json::to_value(GuestFrame::Prompt { text: "x".into(), images: vec![] }).unwrap(), json!({"t":"prompt","text":"x"}));
    }

    #[test]
    fn host_frames_tolerant() {
        let f = HostFrame::parse(br#"{"t":"ui-request-end","reqId":4}"#).unwrap();
        assert_eq!(f, HostFrame::UiRequestEnd { req_id: 4 });
        let f = HostFrame::parse(br#"{"t":"future-thing","x":1}"#).unwrap();
        assert!(matches!(&f, HostFrame::Unknown(v) if v["x"] == 1));
        assert_eq!(f.tag(), "future-thing");
        let f = HostFrame::parse(br#"{"t":"ui-request","request":{"reqId":2,"kind":"select","title":"Q","options":["A",{"label":"B","description":"d"}],"selectionMarker":"radio","markableCount":2,"initialIndex":0}}"#).unwrap();
        let HostFrame::UiRequest { request: UiRequestFrame::Select { options, req_id, .. } } = f else { panic!() };
        assert_eq!(req_id, 2);
        assert_eq!(options[1].label(), "B");
        assert_eq!(options[1].description(), Some("d"));
        let f = HostFrame::parse(br#"{"t":"ui-request","request":{"reqId":3,"kind":"wizard"}}"#).unwrap();
        assert!(matches!(f, HostFrame::Unknown(_)));
        assert!(HostFrame::parse(b"not json").is_err());
    }

    /// omp 18.12 restores a resumed session's subagents with file times (`mtimeMs`), which are
    /// fractional; the whole welcome used to fail and every join timed out.
    #[test]
    fn welcome_with_restored_agents_parses() {
        let f = HostFrame::parse(
            br#"{"t":"welcome","proto":3,"header":{"id":"s","timestamp":"2026-10-22T11:44:46.293Z","cwd":"/r"},
                "state":{"isStreaming":false,"cwd":"/r","participants":[{"name":"root","role":"host"}]},
                "agents":[{"id":"Main","kind":"main","status":"running","createdAt":1792739916162,"lastActivity":1792739916200},
                          {"id":"Sub","kind":"sub","status":"parked","createdAt":null,"lastActivity":1792671289132.6322,"hasSessionFile":true},
                          {"kind":"sub","status":"parked"}],
                "entryCount":1176}"#,
        )
        .unwrap();
        let HostFrame::Welcome(w) = f else { panic!("not a welcome: {f:?}") };
        assert_eq!(w.entry_count, 1176);
        assert_eq!(w.agents.len(), 2, "the agent without an id is dropped, not the welcome");
        assert_eq!((w.agents[1].created_at, w.agents[1].last_activity), (0, 1792671289133));
        let f = HostFrame::parse(br#"{"t":"agents","agents":[{"id":"Sub","lastActivity":1.5e12}]}"#).unwrap();
        assert!(matches!(&f, HostFrame::Agents { agents } if agents[0].last_activity == 1_500_000_000_000));
    }

    /// Every frame in every golden sample parses into a known variant and re-serializes.
    #[test]
    fn all_samples_parse() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/research/omp-collab-samples");
        let mut n = 0;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            for line in std::fs::read_to_string(&path).unwrap().lines() {
                let row: Value = serde_json::from_str(line).unwrap();
                let frame = &row["frame"];
                match row["dir"].as_str() {
                    Some("h2g") => {
                        let f = HostFrame::from_value(frame.clone());
                        assert!(!matches!(f, HostFrame::Unknown(_)), "{}: unknown {}", path.display(), frame["t"]);
                        let back: Value = serde_json::from_slice(&f.to_json()).unwrap();
                        assert_eq!(back["t"], frame["t"]);
                        n += 1;
                    }
                    Some("g2h") => {
                        let g: GuestFrame = serde_json::from_value(frame.clone())
                            .unwrap_or_else(|e| panic!("{}: {e}: {frame}", path.display()));
                        assert_eq!(serde_json::to_value(&g).unwrap()["t"], frame["t"]);
                    }
                    _ => {}
                }
            }
        }
        assert!(n > 1000, "parsed {n} host frames");
    }
}
