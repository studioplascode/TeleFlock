# tf-collab

omp collab (`COLLAB_PROTO = 3`) for `tf-hostd`: link parsing, AES-256-GCM envelopes, typed frames,
the embedded loopback relay, registry discovery, a reconnecting guest, and the **replica** that turns
omp's frames into tf-proto `SessionSnapshot` / `SessionEvent` (with delta compaction).

Spec: `docs/research/omp-collab.md`. Golden tests: `docs/research/omp-collab-samples/`.

## Public API

```rust
use tf_collab::{link, crypto, frame, relay, registry, guest, replica};

// ── link ───────────────────────────────────────────────────────────────
pub struct CollabLink { pub ws_url: String, pub room_id: String, pub key: [u8; 32], pub write_token: Option<[u8; 16]> }
impl CollabLink {
    pub fn parse(text: &str) -> Result<CollabLink, LinkError>;   // every §2 form (bare, host/r/, ws://, http(s)://…/#…, %23, legacy #key)
    pub fn can_write(&self) -> bool;
    pub fn write_token_b64(&self) -> Option<String>;
    pub fn format(&self) -> String;                               // canonical formatCollabLink form
}
impl FromStr for CollabLink;

// ── crypto ─────────────────────────────────────────────────────────────
pub struct RoomKey;
impl RoomKey {
    pub fn new(key: &[u8; 32]) -> RoomKey;
    pub fn seal(&self, peer_id: u32, plaintext: &[u8]) -> Vec<u8>;            // [u32 BE peer][iv 12][ct‖tag]
    pub fn open(&self, envelope: &[u8]) -> Result<(u32, Vec<u8>), CryptoError>;
}

// ── frame ──────────────────────────────────────────────────────────────
pub const COLLAB_PROTO: u32 = 3;
pub enum HostFrame { Welcome(Welcome), SnapshotChunk(SnapshotChunk), Entry { entry: Value }, Event { event: Value },
    State { state: SessionState }, Bus { channel: String, data: Value }, Agents { agents: Vec<AgentSnapshot> },
    UiRequest { request: UiRequestFrame }, UiRequestEnd { req_id: u64 }, Transcript(TranscriptFrame),
    Bye { reason: String }, Error { message: String }, Unknown(Value) }
pub enum GuestFrame { Hello { proto, name, write_token }, Prompt { text, images: Vec<ImageContent> }, Abort,
    AgentCmd { cmd: AgentCmdKind, agent_id, text }, FetchTranscript { req_id, agent_id, from_byte },
    UiResponse { req_id: u64, value: Option<String> } }
HostFrame::parse(json: &[u8]) -> Result<HostFrame, serde_json::Error>;   // unknown `t` → Unknown(Value)
GuestFrame::to_json(&self) -> Vec<u8>;

// ── relay ──────────────────────────────────────────────────────────────
pub struct RelayConfig { pub port: u16, pub ping_interval: Duration /*20s*/, pub idle_timeout: Duration /*60s*/,
    pub max_message: usize /*16 MiB*/, pub max_guests_per_room: usize /*16*/ }
impl RelayConfig { pub fn new(port: u16) -> Self }
pub struct Relay;   // bound to 127.0.0.1:<port>; GET /healthz → {"ok":true,"rooms":N,"guests":M}
impl Relay {
    pub async fn start(cfg: RelayConfig) -> std::io::Result<Relay>;
    pub fn local_addr(&self) -> SocketAddr;
    pub fn port(&self) -> u16;
    pub fn stats(&self) -> RelayStats;               // { rooms, guests }
    pub async fn shutdown(self);                     // guests: room-closed + 4001, hosts: 1001
}

// ── registry ───────────────────────────────────────────────────────────
pub struct HostEntry { pub instance_id: String, pub generation: u64, pub pid: u32, pub session_id: Option<String>,
    pub session_name: Option<String>, pub cwd: Option<String>, pub model: Option<ModelId>, pub started_at: Option<i64>,
    pub participants: u32, pub relay_connected: bool, pub input_required: bool, pub busy: bool, pub access: String }
pub enum Access { Control, View }
pub struct Registry;
impl Registry {
    pub fn new() -> Registry;                        // ~/.omp/run/collab-hosts, `omp` on PATH for fallback
    pub fn with_dir(dir: PathBuf) -> Registry;
    pub fn omp_bin(self, bin: PathBuf) -> Registry;
    pub async fn poll(&self) -> Result<Vec<HostEntry>, RegistryError>;   // IPC snapshot per host; CLI fallback
    pub async fn link(&self, instance_id: &str, access: Access) -> Result<LinkInfo, RegistryError>;
        // handles stale_generation (re-snapshot + retry); LinkInfo { generation, url, link: CollabLink }
}

// ── guest ──────────────────────────────────────────────────────────────
pub struct Guest;  // Clone; cheap handle
impl Guest {
    pub async fn connect(link: CollabLink, display_name: &str) -> Result<(Guest, mpsc::UnboundedReceiver<GuestEvent>), GuestError>;
        // resolves after hello → welcome → all snapshot chunks; first event is GuestEvent::Snapshot
    pub fn prompt(&self, text: String, images: Vec<ImageContent>) -> Result<(), GuestError>;  // steers while streaming
    pub fn abort(&self) -> Result<(), GuestError>;
    pub fn ui_response(&self, req_id: u64, value: Option<String>) -> Result<(), GuestError>;  // None = cancel
    pub fn agent_cmd(&self, cmd: AgentCmdKind, agent_id: &str, text: Option<String>) -> Result<(), GuestError>;
    pub async fn fetch_transcript(&self, agent_id: &str, from_byte: u64) -> Result<TranscriptChunk, GuestError>;
    pub fn resync(&self) -> Result<(), GuestError>;   // re-hello on the open socket
    pub fn read_only(&self) -> bool;
    pub fn close(&self);
}
pub enum GuestEvent {
    Snapshot(Snapshot),                  // welcome + entries (initial join and every resync/reconnect)
    Frame(HostFrame),                    // live frames after the snapshot
    Reconnecting { code: u16, reason: String, attempt: u32 },
    Ended(EndReason),                    // Bye{reason} (rotation → re-discover) | RoomGone | Fatal(String) | Closed
}

// ── replica ────────────────────────────────────────────────────────────
pub struct Replica;
impl Replica {
    pub fn new(agent_id: impl Into<String>) -> Replica;
    pub fn apply(&mut self, ev: &GuestEvent, now: Millis) -> Update;
    pub fn snapshot(&self, limit: usize) -> SessionSnapshot;        // newest `limit` rows; cursor for history
    pub fn history(&self, cursor: Option<&str>, limit: usize) -> HistoryPage;
    pub fn meta(&self) -> &SessionMeta;
    pub fn liveness(&self, now: Millis) -> Liveness;
    pub fn ui(&self) -> Option<&UiRequest>;
    pub fn needs(&self) -> Option<NeedsYou>;                         // board needs-you for the pending UiRequest
    pub fn answer(&mut self, request_id: &str, answer: &Answer) -> Result<Vec<UiReply>, ApiError>;
        // maps tf-proto Answer → exact ui-response values (Other → editor text, Chat, multi checkbox loop)
    pub fn usage(&self) -> Option<CostInfo>;
    pub fn is_streaming(&self) -> bool;
}
pub struct Update {
    pub events: Vec<SessionEvent>,    // reset / upsert / append / remove / meta / ui / ended (compacted)
    pub replies: Vec<UiReply>,        // automatic ui-responses to send (multi-select loop, Other → editor)
    pub pulses: Vec<(PulseKind, u32)>,
    pub signals: Vec<Signal>,         // TurnStarted, TurnEnded{aborted, error}, Asked, UiSettled, Notice{..}, ModelChanged, Compacted, Ended
    pub liveness_changed: bool,
    pub meta_changed: bool,
}
pub struct UiReply { pub req_id: u64, pub value: Option<String> }
```

Item ids are stable across snapshot and live: user `u<ts>`, assistant/thinking blocks `a<ts>.<i>`,
tools `t:<toolCallId>`, notices `n<seq>`, compaction `c<entryId>`, mode `m<entryId>`.

Live bash/tool output streams as `append {field: output}` into `ToolItem.output`; the final upsert
carries the full output in both `ToolItem.output` and `BashView.output`.
