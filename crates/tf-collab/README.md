# tf-collab

omp collab (`COLLAB_PROTO = 3`) for `tf-hostd`: link parsing, AES-256-GCM envelopes, typed frames,
the embedded loopback relay, registry discovery, a reconnecting guest, and the **replica** that turns
omp's frames into tf-proto `SessionSnapshot` / `SessionEvent` (with delta compaction).

Spec: `docs/research/omp-collab.md`. Golden tests: `docs/research/omp-collab-samples/`.

## Public API

```rust
// ── link ───────────────────────────────────────────────────────────────
pub struct CollabLink { pub ws_url: String, pub room_id: String, pub key: [u8; 32], pub write_token: Option<[u8; 16]> }
impl CollabLink {
    pub fn parse(text: &str) -> Result<CollabLink, LinkError>;   // every §2 form: bare id.secret / id#secret,
                                                                  // host[:port]/r/…, ws(s)://…, http(s)://…/#<link>, %23, legacy #key
    pub fn can_write(&self) -> bool;
    pub fn write_token_b64(&self) -> Option<String>;
    pub fn relay_origin(&self) -> &str;                          // "ws://127.0.0.1:47466"
    pub fn with_relay(&self, relay_url: &str) -> Result<CollabLink, LinkError>;
    pub fn view_only(&self) -> CollabLink;
    pub fn format(&self) -> String;                               // canonical formatCollabLink form
    pub fn guest_url(&self) -> String;                            // ws_url + "?role=guest"
}
// Debug never prints the key or token.

// ── crypto ─────────────────────────────────────────────────────────────
pub struct RoomKey;
impl RoomKey {
    pub fn new(key: &[u8; 32]) -> RoomKey;
    pub fn seal(&self, peer_id: u32, plaintext: &[u8]) -> Vec<u8>;            // [u32 BE peer][iv 12][ct‖tag16], no AAD
    pub fn open(&self, envelope: &[u8]) -> Result<(u32, Vec<u8>), CryptoError>;
}
pub fn envelope_peer(envelope: &[u8]) -> Option<u32>;
pub fn set_envelope_peer(envelope: &mut [u8], peer_id: u32) -> bool;

// ── frame ──────────────────────────────────────────────────────────────
pub const COLLAB_PROTO: u32 = 3;
pub enum HostFrame { Welcome(Welcome), SnapshotChunk(SnapshotChunk), Entry { entry: Value }, Event { event: Value },
    State { state: SessionState }, Bus { channel: String, data: Value }, Agents { agents: Vec<AgentSnapshot> },
    UiRequest { request: UiRequestFrame }, UiRequestEnd { req_id: u64 }, Transcript(TranscriptFrame),
    Bye { reason: String }, Error { message: String }, Unknown(Value) }
impl HostFrame { pub fn parse(json: &[u8]) -> Result<HostFrame, serde_json::Error>; pub fn from_value(Value) -> HostFrame;
                 pub fn to_json(&self) -> Vec<u8>; pub fn tag(&self) -> &str }   // unknown `t` / shape → Unknown(Value)
pub enum GuestFrame { Hello { proto, name, write_token }, Prompt { text, images: Vec<ImageContent> },
    UiResponse { req_id: u64, value: Option<String> }, Abort {}, AgentCmd { cmd: AgentCmdKind, agent_id, text },
    FetchTranscript { req_id, agent_id, from_byte } }
pub enum AgentCmdKind { Chat, Kill, Revive }
pub struct ImageContent { pub kind: String /* "image" */, pub data: String /* base64 */, pub mime_type: String }

// ── relay ──────────────────────────────────────────────────────────────
pub struct RelayConfig { pub bind: IpAddr /*127.0.0.1*/, pub port: u16 /*0 = any*/, pub ping_interval: Duration /*20s*/,
    pub idle_timeout: Duration /*60s*/, pub max_message: usize /*16 MiB*/, pub max_guests_per_room: usize /*16, 0 = ∞*/,
    pub max_rooms: usize /*256, 0 = ∞*/, pub max_connections: usize /*512, 0 = ∞*/,
    pub max_queued_bytes: usize /*32 MiB per connection, ≥ max_message*/ }
impl RelayConfig { pub fn new(port: u16) -> Self }
pub struct Relay;   // GET /r/<room>?role=host|guest (404 / 426), GET /healthz → {"ok":true,"rooms":N,"guests":M}
                    // GET /healthz?nonce=<[A-Za-z0-9_-]{1,128}> adds "proof": hex(HMAC-SHA256(secret, nonce))
                    // Any request with an Origin header → 403 (omp's Bun client and tungstenite send none).
                    // Over max_connections → 503 before reading the request.
impl Relay {
    pub async fn start(cfg: RelayConfig) -> std::io::Result<Relay>;
    pub fn local_addr(&self) -> SocketAddr;
    pub fn port(&self) -> u16;
    pub fn url(&self) -> String;                     // "ws://127.0.0.1:<port>" (omp's collab.relayUrl)
    pub fn identity(&self) -> RelayIdentity;         // per-process random HMAC key
    pub fn stats(&self) -> RelayStats;               // { rooms, guests, frames_h2g, bytes_h2g, frames_g2h, bytes_g2h }
    pub async fn shutdown(self);                     // guests: room-closed + 4001, hosts: 1001
}
pub struct RelayIdentity;  // Clone
impl RelayIdentity {
    pub fn proof(&self, nonce: &str) -> String;
    pub fn check(&self, nonce: &str, proof: &str) -> bool;   // constant-time
    pub async fn verify(&self, addr: SocketAddr) -> Result<(), IdentityError>;  // fresh nonce → /healthz
}
pub enum IdentityError { Unreachable(String), Foreign(String) }
// Close codes: 4001 room closed, 4004 no such room, 4009 duplicate host, 4029 room full,
// 1013 relay room limit, 1008 guest exceeded its queued-bytes budget (host → guest frames are
// shared `Bytes`; guest → host frames wait for the host's budget instead of being dropped).

// ── registry ───────────────────────────────────────────────────────────
pub struct HostEntry { pub instance_id: String, pub generation: u64, pub pid: u32, pub session_id: Option<String>,
    pub session_name: Option<String>, pub cwd: Option<String>, pub model: Option<ModelId>, pub started_at: Option<i64>,
    pub participants: u32, pub relay_connected: bool, pub input_required: bool, pub busy: bool, pub access: String }
pub enum Access { Control, View }
pub struct LinkInfo { pub instance_id: String, pub generation: u64, pub url: String, pub link: CollabLink }
pub struct Registry;
impl Registry {
    pub fn new() -> Registry;                        // ~/.omp/run/collab-hosts; `omp` on PATH for the CLI fallback
    pub fn with_dir(dir: PathBuf) -> Registry;
    pub fn omp_bin(self, bin: impl Into<PathBuf>) -> Registry;
    pub async fn poll(&self) -> Result<Vec<HostEntry>, RegistryError>;   // IPC `snapshot` per host (1.5 s deadline);
        // falls back to `omp collab list --json` if the dir is unreadable or a host speaks another protocol
    pub async fn link(&self, instance_id_or_pid: &str, access: Access) -> Result<LinkInfo, RegistryError>;
        // snapshot → link(generation); `stale_generation` re-snapshots and retries (×3); CLI fallback `omp collab link`
}
// Consumer diffs poll() results, keyed by (instance_id, generation). Join only hosts with relay_connected.

// ── guest ──────────────────────────────────────────────────────────────
pub struct Guest;  // Clone; cheap handle
impl Guest {
    pub async fn connect(link: CollabLink, display_name: &str) -> Result<(Guest, mpsc::UnboundedReceiver<GuestEvent>), GuestError>;
        // resolves after hello → welcome (30 s) → every snapshot chunk (30 s each); first event is Snapshot{resync:false}
    pub fn is_live(&self) -> bool;
    pub fn read_only(&self) -> bool;
    pub fn prompt(&self, text: String, images: Vec<ImageContent>) -> Result<(), GuestError>;  // host steers while streaming
    pub fn abort(&self) -> Result<(), GuestError>;
    pub fn ui_response(&self, req_id: u64, value: Option<String>) -> Result<(), GuestError>;  // None = cancel
    pub fn agent_cmd(&self, cmd: AgentCmdKind, agent_id: &str, text: Option<String>) -> Result<(), GuestError>;
    pub async fn fetch_transcript(&self, agent_id: &str, from_byte: u64) -> Result<TranscriptChunk, GuestError>;
    pub fn resync(&self) -> Result<(), GuestError>;   // re-hello on the open socket
    pub fn close(&self);
}
pub enum GuestEvent {
    Snapshot(Snapshot),                  // { welcome, entries, resync } — initial join and every resync/reconnect
    Frame(HostFrame),                    // live frames after the snapshot (transcript replies go to fetch_transcript)
    Reconnecting { code: u16, reason: String, attempt: u32 },
    Ended(EndReason),                    // Bye(reason) → re-discover (rotation) | RoomGone | Rejected(msg) | Fatal(msg) | Closed
}
pub enum GuestError { Connect(String), NoSuchRoom, Timeout(&'static str), Rejected(String), ReadOnly, NotConnected, Fatal(String) }
// Reconnect: backoff min(1s·2^n, 30s)×U(0.75,1.25); 4001 retries; 4004 retried for 30 s after a drop
// (relay-restart race) then RoomGone; decrypt failure is fatal. Heartbeat ping 15 s, dead after 40 s.
// Plain ws:// only (the TeleFlock relay is loopback).

// ── replica ────────────────────────────────────────────────────────────
pub struct Replica;
impl Replica {
    pub fn new(agent_id: impl Into<String>) -> Replica;
    pub fn apply(&mut self, ev: &GuestEvent, now: Millis) -> Update;
    pub fn snapshot(&self, limit: usize) -> SessionSnapshot;        // newest `limit` rows; cursor = oldest row id
    pub fn history(&self, cursor: Option<&str>, limit: usize) -> HistoryPage;
    pub fn item(&self, id: &str) -> Option<&TranscriptItem>;
    pub fn meta(&self) -> &SessionMeta;                              // model, thinking, context, cost, todos, subagents, caps, tps (last turn avg)
    pub fn state(&self) -> &SessionState;  pub fn header(&self) -> Option<&SessionHeader>;
    pub fn liveness(&self, now: Millis) -> Liveness;                 // streaming, thinking, tool, live tps (3 s), line
    pub fn ui(&self) -> Option<&UiRequest>;
    pub fn needs(&self) -> Option<NeedsYou>;                         // Ask / Approval / Input for the pending request
    pub fn answer(&mut self, request_id: &str, answer: &Answer) -> Result<Vec<UiReply>, ApiError>;
        // exact labels (invalid_params otherwise); text → "Other (type your own)" + auto-answered editor;
        // chat → "Chat about this"; multi-select → checkbox toggle loop + "Next →"; cancel → None
    pub fn usage(&self) -> Option<CostInfo>;
    pub fn is_streaming(&self) -> bool;  pub fn turn_started_at(&self) -> Option<Millis>;
    pub fn read_only(&self) -> bool;     pub fn ended(&self) -> bool;
}
pub struct Update {
    pub events: Vec<SessionEvent>,    // reset / upsert / append / remove / meta / ui / ended (compacted)
    pub replies: Vec<UiReply>,        // send each via guest.ui_response (multi-select rounds, Other → editor)
    pub pulses: Vec<(PulseKind, u32)>,
    pub signals: Vec<Signal>,
    pub meta_changed: bool,
    pub liveness_changed: bool,
}
pub struct UiReply { pub req_id: u64, pub value: Option<String> }
pub enum Signal { TurnStarted, TurnEnded { aborted: bool, error: Option<String> }, Prompted { text: String, author: Option<String> },
    Asked { request_id: String }, UiSettled { request_id: String }, Notice { level: NoticeLevel, text: String },
    ToolError { tool: String, error: String }, ModelChanged { model: ModelRef }, ThinkingChanged { level: ThinkingLevel },
    Compacted { tokens_before: Option<u64> }, Retry { attempt: u32, max: u32, error: String }, Ended { reason: String } }
pub fn transcript_page(jsonl: &str) -> HistoryPage;   // subagent transcript (fetch_transcript text) with the same mapping
```

### Row ids and mapping

Ids are stable across snapshot and live frames: user `u<ts>`, assistant/thinking blocks `a<ts>.<block>`,
tools `t:<toolCallId>`, model/thinking markers `m<entryId>`, compaction `c<entryId>`, notices `n<seq>`,
retry streaks `r<seq>` (one row per auto-retry streak, updated in place: "Retrying (3/10)…" → "Recovered after 6 retries").

- Text/thinking stream as `append {field: text}`; the replica diffs each block of omp's full message against
  what it emitted (omp serializes the message lazily, so the delta field alone is unreliable).
- Tool output streams as `append {field: output}` into `ToolItem.output`; the final upsert carries the full
  output in `ToolItem.output` and `BashView.output`.
- `ToolView`s: bash, edit (omp numbered diff → unified patch), write, read (selector split from `path`),
  grep/glob/find (search), todo (also `meta.todos`), task (also `meta.subagents` from `agents` + `bus`),
  ask (question/options/answer), web_search, image blocks (eval/browser screenshots).
- User rows: `author` = collab guest name (`collab-prompt`), `synthetic` for developer reminders and
  custom messages (`author` = customType, e.g. `async-result`); our own join/leave notices are not rows.

## Bandwidth (golden samples, raw relay ciphertext → compacted SessionEvent JSON)

`06-abort` 630 KB → 18.5 KB (34×) · `01b` 146 KB → 11.7 KB (12.5×) · `02-bash` 85 KB → 7.5 KB (11.3×) · `07-task` 165 KB → 27 KB (6×).

## Tests

```bash
CARGO_TARGET_DIR=target/HostdCollab cargo test -p tf-collab                    # unit + golden + relay/guest
CARGO_TARGET_DIR=target/HostdCollab cargo test -p tf-collab --test e2e_omp -- --ignored --nocapture
```

The ignored e2e starts the Rust relay on `TF_HC_RELAY_PORT` (default 47588), omp in herdr lab session
`tf-lab-hc` with a per-process overlay (cheap model), discovers it via the registry, joins, and checks
streaming appends, a bash row, an ask answered through `ui_response`, and an abort. It stops and deletes
the lab session afterwards.
