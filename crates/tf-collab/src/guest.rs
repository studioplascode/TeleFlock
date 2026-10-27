//! A full-control collab guest (`omp-collab.md` §5.1, §5.6, §4.3–4.4).
//!
//! [`Guest::connect`] opens `…/r/<roomId>?role=guest`, sends `hello`, waits for `welcome` and
//! every `snapshot-chunk` ([`JoinTimeouts`]: 30 s each by default, [`Guest::connect_with`] sets
//! longer ones), then resolves. The event stream starts with [`GuestEvent::Snapshot`] and
//! continues with live [`GuestEvent::Frame`]s.
//!
//! Reconnect rules:
//! * transient closes (1000/1001/1006/other, heartbeat loss, connect errors) retry with backoff
//!   `min(1 s · 2^n, 30 s) × U(0.75, 1.25)`; every reopen re-sends `hello` and yields a fresh
//!   `Snapshot { resync: true }`;
//! * a reopen whose welcome or snapshot timed out doubles both join timeouts for the next one
//!   (up to [`JoinTimeouts::MAX_SCALE`]× the base) and says so (`Reconnecting { timed_out }`);
//! * 4001 (room closed) retries and makes a later 4004 retryable;
//! * 4004 is retried for a bounded 30 s window after any drop (relay restart race), then the
//!   guest ends with [`EndReason::RoomGone`];
//! * `bye` ends with [`EndReason::Bye`] (session rotation: re-discover through the registry);
//! * a frame that fails to decrypt is fatal (bad key).
//!
//! Only plain `ws://` relays are supported (TeleFlock's relay is loopback-only).

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

use crate::crypto::RoomKey;
use crate::frame::{AgentCmdKind, COLLAB_PROTO, GuestFrame, HostFrame, ImageContent, TranscriptFrame, Welcome};
use crate::link::CollabLink;

/// How long a join waits for the host.
///
/// omp answers `hello` by serializing the whole session on its event loop, then seals and sends
/// it chunk by chunk. A large session on a slow or busy machine needs far longer than omp's own
/// 30 s guest timeouts. Waiting costs nothing; giving up throws that work away (the host drops a
/// departed guest's queued snapshot) and the next join starts it over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JoinTimeouts {
    /// `hello` → `welcome`.
    pub welcome: Duration,
    /// Welcome → first `snapshot-chunk`, and between chunks.
    pub snapshot_progress: Duration,
}

impl JoinTimeouts {
    /// omp's own guest timeouts.
    pub const BASE: JoinTimeouts = JoinTimeouts { welcome: Duration::from_secs(30), snapshot_progress: Duration::from_secs(30) };
    /// [`JoinTimeouts::escalated`] never goes past this multiple of [`JoinTimeouts::BASE`] (4 min).
    pub const MAX_SCALE: u32 = 8;

    /// Timeouts for a join after `timeouts` consecutive joins that timed out: the base, doubled
    /// per timeout, at most [`JoinTimeouts::MAX_SCALE`]×.
    pub fn escalated(timeouts: u32) -> JoinTimeouts {
        let k = 1u32 << timeouts.min(Self::MAX_SCALE.trailing_zeros());
        JoinTimeouts { welcome: Self::BASE.welcome * k, snapshot_progress: Self::BASE.snapshot_progress * k }
    }

    /// Both timeouts doubled, capped at [`JoinTimeouts::MAX_SCALE`]× the base.
    fn doubled(self) -> JoinTimeouts {
        let cap = |d: Duration, base: Duration| (d * 2).min(base * Self::MAX_SCALE).max(d);
        JoinTimeouts { welcome: cap(self.welcome, Self::BASE.welcome), snapshot_progress: cap(self.snapshot_progress, Self::BASE.snapshot_progress) }
    }
}

impl Default for JoinTimeouts {
    fn default() -> Self {
        Self::BASE
    }
}

const TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(20);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_DEAD: Duration = Duration::from_secs(40);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// After a drop, 4004 stays retryable this long (relay restart: guests can beat the host back).
const MISSING_ROOM_WINDOW: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// Welcome plus every snapshot entry (initial join or resync).
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub welcome: Welcome,
    pub entries: Vec<Value>,
    /// False for the first join, true for every later resync/reconnect.
    pub resync: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EndReason {
    /// Host said `bye` (e.g. `/new`, `/resume`, `/fork`): re-discover via the registry.
    Bye(String),
    /// Room no longer exists (4004 outside the retry window): host exited or rotated.
    RoomGone,
    /// Host rejected our hello (`protocol mismatch …`).
    Rejected(String),
    /// Unrecoverable (bad key, room full).
    Fatal(String),
    /// [`Guest::close`] was called.
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GuestEvent {
    Snapshot(Snapshot),
    Frame(HostFrame),
    /// Socket dropped; the guest is reconnecting (`attempt` starts at 1). `timed_out`: the host
    /// did not deliver the welcome or the snapshot in time (it is alive on the relay but not
    /// answering), as opposed to a dropped socket.
    Reconnecting { code: u16, reason: String, attempt: u32, timed_out: bool },
    Ended(EndReason),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptChunk {
    /// JSONL slice starting at `from_byte`, cut at a line boundary.
    pub text: String,
    /// Next byte offset to request.
    pub new_size: u64,
    /// Terminal read error reported by the host.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum GuestError {
    /// Connect / handshake failure.
    Connect(String),
    /// 4004 on first connect.
    NoSuchRoom,
    Timeout(&'static str),
    /// Host rejected hello.
    Rejected(String),
    /// Link or host says view-only.
    ReadOnly,
    /// Not currently joined (reconnecting or ended).
    NotConnected,
    Fatal(String),
}

impl fmt::Display for GuestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Connect(e) => write!(f, "collab connect failed: {e}"),
            Self::NoSuchRoom => f.write_str("collab room not found (4004)"),
            Self::Timeout(what) => write!(f, "timed out waiting for the host's {what}"),
            Self::Rejected(m) => write!(f, "collab host rejected the join: {m}"),
            Self::ReadOnly => f.write_str("this collab link is read-only"),
            Self::NotConnected => f.write_str("collab guest is not connected"),
            Self::Fatal(m) => write!(f, "collab guest failed: {m}"),
        }
    }
}
impl std::error::Error for GuestError {}

enum Cmd {
    Send(GuestFrame),
    Resync,
    Close,
}

struct Inner {
    cmd: mpsc::UnboundedSender<Cmd>,
    can_write: bool,
    read_only: AtomicBool,
    live: AtomicBool,
    next_req: AtomicU64,
    transcripts: Mutex<HashMap<u64, oneshot::Sender<TranscriptChunk>>>,
}

/// Handle to a joined guest. Clone freely; the connection lives until [`Guest::close`] or an
/// [`EndReason`].
#[derive(Clone)]
pub struct Guest {
    inner: Arc<Inner>,
}

impl fmt::Debug for Guest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Guest")
            .field("live", &self.is_live())
            .field("read_only", &self.read_only())
            .finish()
    }
}

impl Guest {
    /// Join the room and wait for the full snapshot ([`JoinTimeouts::BASE`]).
    pub async fn connect(
        link: CollabLink,
        display_name: &str,
    ) -> Result<(Guest, mpsc::UnboundedReceiver<GuestEvent>), GuestError> {
        Self::connect_with(link, display_name, JoinTimeouts::BASE).await
    }

    /// [`Guest::connect`] with explicit join timeouts (also the starting point for reconnects).
    pub async fn connect_with(
        link: CollabLink,
        display_name: &str,
        timeouts: JoinTimeouts,
    ) -> Result<(Guest, mpsc::UnboundedReceiver<GuestEvent>), GuestError> {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let (first_tx, first_rx) = oneshot::channel();
        let inner = Arc::new(Inner {
            cmd: cmd_tx,
            can_write: link.can_write(),
            read_only: AtomicBool::new(!link.can_write()),
            live: AtomicBool::new(false),
            next_req: AtomicU64::new(1),
            transcripts: Mutex::new(HashMap::new()),
        });
        let name: String = display_name.trim().chars().take(64).collect();
        let worker = Worker {
            key: RoomKey::new(&link.key),
            hello: GuestFrame::Hello { proto: COLLAB_PROTO, name, write_token: link.write_token_b64() },
            url: link.guest_url(),
            inner: inner.clone(),
            events: ev_tx,
            first: Some(first_tx),
            timeouts,
        };
        tokio::spawn(worker.run(cmd_rx));
        match first_rx.await {
            Ok(Ok(())) => Ok((Guest { inner }, ev_rx)),
            Ok(Err(e)) => Err(e),
            Err(_) => Err(GuestError::Fatal("guest task ended".into())),
        }
    }

    /// Joined and synced (not reconnecting / ended).
    pub fn is_live(&self) -> bool {
        self.inner.live.load(Ordering::Acquire)
    }

    /// View link, or the host marked us read-only.
    pub fn read_only(&self) -> bool {
        self.inner.read_only.load(Ordering::Acquire)
    }

    fn send(&self, frame: GuestFrame, write: bool) -> Result<(), GuestError> {
        if write && (!self.inner.can_write || self.read_only()) {
            return Err(GuestError::ReadOnly);
        }
        if !self.is_live() {
            return Err(GuestError::NotConnected);
        }
        self.inner.cmd.send(Cmd::Send(frame)).map_err(|_| GuestError::NotConnected)
    }

    /// Prompt the session. The host always steers while streaming (collab has no follow-up).
    pub fn prompt(&self, text: String, images: Vec<ImageContent>) -> Result<(), GuestError> {
        self.send(GuestFrame::Prompt { text, images }, true)
    }

    pub fn abort(&self) -> Result<(), GuestError> {
        self.send(GuestFrame::Abort {}, true)
    }

    /// Answer a `ui-request`. `value` must be an exact option label (or editor text); `None` cancels.
    pub fn ui_response(&self, req_id: u64, value: Option<String>) -> Result<(), GuestError> {
        self.send(GuestFrame::UiResponse { req_id, value }, true)
    }

    /// Subagent control: chat (steer), kill, revive.
    pub fn agent_cmd(&self, cmd: AgentCmdKind, agent_id: &str, text: Option<String>) -> Result<(), GuestError> {
        self.send(GuestFrame::AgentCmd { cmd, agent_id: agent_id.to_owned(), text }, true)
    }

    /// Read an agent's transcript JSONL from `from_byte` (works on view links too).
    pub async fn fetch_transcript(&self, agent_id: &str, from_byte: u64) -> Result<TranscriptChunk, GuestError> {
        let req_id = self.inner.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.transcripts.lock().unwrap().insert(req_id, tx);
        if let Err(e) = self.send(GuestFrame::FetchTranscript { req_id, agent_id: agent_id.to_owned(), from_byte }, false) {
            self.inner.transcripts.lock().unwrap().remove(&req_id);
            return Err(e);
        }
        match tokio::time::timeout(TRANSCRIPT_TIMEOUT, rx).await {
            Ok(Ok(chunk)) => Ok(chunk),
            Ok(Err(_)) => Err(GuestError::NotConnected),
            Err(_) => {
                self.inner.transcripts.lock().unwrap().remove(&req_id);
                Err(GuestError::Timeout("transcript"))
            }
        }
    }

    /// Re-send `hello` on the open socket; the host answers with a full snapshot train.
    pub fn resync(&self) -> Result<(), GuestError> {
        self.inner.cmd.send(Cmd::Resync).map_err(|_| GuestError::NotConnected)
    }

    /// Leave the room. The event stream ends with `Ended(Closed)`.
    pub fn close(&self) {
        let _ = self.inner.cmd.send(Cmd::Close);
    }
}

enum Phase {
    AwaitWelcome { deadline: Instant },
    Snapshot { welcome: Welcome, entries: Vec<Value>, deadline: Instant },
    Live,
}

enum ConnEnd {
    /// Socket closed with this code (1006 for abnormal).
    Closed(u16, String),
    /// The host sent no welcome / snapshot progress in time (the socket stays open meanwhile).
    TimedOut(&'static str),
    /// Stop the worker with this reason.
    End(EndReason),
}

struct Worker {
    key: RoomKey,
    hello: GuestFrame,
    url: String,
    inner: Arc<Inner>,
    events: mpsc::UnboundedSender<GuestEvent>,
    first: Option<oneshot::Sender<Result<(), GuestError>>>,
    /// Join timeouts of the next connection: doubled after each one that timed out.
    timeouts: JoinTimeouts,
}

fn backoff(attempt: u32) -> Duration {
    let base = Duration::from_secs(1).saturating_mul(1u32 << attempt.min(5)).min(MAX_BACKOFF);
    let mut r = [0u8; 2];
    let _ = getrandom::fill(&mut r);
    let jitter = 0.75 + (u16::from_le_bytes(r) as f64 / u16::MAX as f64) * 0.5;
    base.mul_f64(jitter)
}

impl Worker {
    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
        let mut attempt: u32 = 0;
        let mut retry_missing_room = false;
        let mut dropped_at: Option<Instant> = None;
        let mut joined = false;
        let reason = loop {
            let mut synced = false;
            let end = self.connection(&mut cmds, joined, &mut synced).await;
            self.inner.live.store(false, Ordering::Release);
            self.flush_transcripts();
            if synced {
                // A completed snapshot resets the outage streak.
                joined = true;
                attempt = 0;
                dropped_at = None;
                retry_missing_room = false;
            }
            let (code, why, timed_out) = match end {
                ConnEnd::End(r) => break r,
                ConnEnd::Closed(code, why) => (code, why, false),
                ConnEnd::TimedOut(what) => {
                    self.timeouts = self.timeouts.doubled();
                    (1006, format!("timed out waiting for the host's {what}"), true)
                }
            };
            if !joined {
                // Initial join failed: report instead of retrying.
                let err = match code {
                    4004 => GuestError::NoSuchRoom,
                    _ => GuestError::Connect(format!("{code} {why}")),
                };
                if let Some(first) = self.first.take() {
                    let _ = first.send(Err(err));
                }
                return;
            }
            let now = Instant::now();
            let since = *dropped_at.get_or_insert(now);
            match code {
                4001 => retry_missing_room = true,
                4004 if retry_missing_room || now.duration_since(since) < MISSING_ROOM_WINDOW => {}
                4004 => break EndReason::RoomGone,
                4029 => break EndReason::Fatal("room is full".into()),
                _ => {}
            }
            attempt += 1;
            let _ = self.events.send(GuestEvent::Reconnecting { code, reason: why, attempt, timed_out });
            // While waiting only Close and Resync (retry now) matter; other commands fail fast
            // (`live` is false).
            let sleep = tokio::time::sleep(backoff(attempt - 1));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    cmd = cmds.recv() => match cmd {
                        Some(Cmd::Close) | None => {
                            let _ = self.events.send(GuestEvent::Ended(EndReason::Closed));
                            return;
                        }
                        Some(Cmd::Resync) => break,
                        Some(Cmd::Send(_)) => {}
                    },
                }
            }
        };
        if let Some(first) = self.first.take() {
            let err = match &reason {
                EndReason::Rejected(m) => GuestError::Rejected(m.clone()),
                EndReason::Fatal(m) => GuestError::Fatal(m.clone()),
                EndReason::RoomGone => GuestError::NoSuchRoom,
                other => GuestError::Fatal(format!("{other:?}")),
            };
            let _ = first.send(Err(err));
            return;
        }
        let _ = self.events.send(GuestEvent::Ended(reason));
    }

    fn flush_transcripts(&self) {
        self.inner.transcripts.lock().unwrap().clear();
    }

    fn seal(&self, frame: &GuestFrame) -> Message {
        Message::binary(self.key.seal(0, &frame.to_json()))
    }

    /// One socket lifetime.
    async fn connection(&mut self, cmds: &mut mpsc::UnboundedReceiver<Cmd>, resync: bool, synced: &mut bool) -> ConnEnd {
        let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE)).max_frame_size(Some(MAX_MESSAGE));
        let connect = tokio_tungstenite::connect_async_with_config(self.url.as_str(), Some(config), true);
        let ws = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => return ConnEnd::Closed(1006, e.to_string()),
            Err(_) => return ConnEnd::Closed(1006, "connect timeout".into()),
        };
        let (mut sink, mut stream) = ws.split();
        if sink.send(self.seal(&self.hello)).await.is_err() {
            return ConnEnd::Closed(1006, "send failed".into());
        }
        let timeouts = self.timeouts;
        let mut phase = Phase::AwaitWelcome { deadline: Instant::now() + timeouts.welcome };
        let mut resync = resync;
        let mut last_heard = Instant::now();
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;

        loop {
            let deadline = match &phase {
                Phase::AwaitWelcome { deadline } | Phase::Snapshot { deadline, .. } => Some(*deadline),
                Phase::Live => None,
            };
            let phase_timeout = async {
                match deadline {
                    Some(d) => tokio::time::sleep_until(d.into()).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                _ = phase_timeout => {
                    let what = if matches!(phase, Phase::AwaitWelcome { .. }) { "welcome" } else { "session snapshot" };
                    if let Some(first) = self.first.take() {
                        let _ = first.send(Err(GuestError::Timeout(what)));
                        return ConnEnd::End(EndReason::Fatal(format!("timed out waiting for the host's {what}")));
                    }
                    return ConnEnd::TimedOut(what);
                }
                _ = heartbeat.tick() => {
                    if last_heard.elapsed() > HEARTBEAT_DEAD {
                        return ConnEnd::Closed(1006, "heartbeat lost".into());
                    }
                    if sink.send(Message::Ping(Default::default())).await.is_err() {
                        return ConnEnd::Closed(1006, "send failed".into());
                    }
                }
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::Send(frame)) => {
                        if sink.send(self.seal(&frame)).await.is_err() {
                            return ConnEnd::Closed(1006, "send failed".into());
                        }
                    }
                    Some(Cmd::Resync) => {
                        if sink.send(self.seal(&self.hello)).await.is_err() {
                            return ConnEnd::Closed(1006, "send failed".into());
                        }
                        self.inner.live.store(false, Ordering::Release);
                        resync = true;
                        phase = Phase::AwaitWelcome { deadline: Instant::now() + timeouts.welcome };
                    }
                    Some(Cmd::Close) | None => {
                        let frame = CloseFrame { code: CloseCode::Normal, reason: "guest left".into() };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        return ConnEnd::End(EndReason::Closed);
                    }
                },
                msg = stream.next() => {
                    let msg = match msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => return ConnEnd::Closed(1006, e.to_string()),
                        None => return ConnEnd::Closed(1006, "connection lost".into()),
                    };
                    last_heard = Instant::now();
                    let data = match msg {
                        Message::Binary(b) => b,
                        Message::Close(frame) => {
                            let (code, why) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                            return ConnEnd::Closed(code, why);
                        }
                        // TEXT control (`room-closed`) precedes 4001; pings are auto-answered.
                        _ => continue,
                    };
                    let plain = match self.key.open(&data) {
                        Ok((_, p)) => p,
                        Err(e) => return ConnEnd::End(EndReason::Fatal(e.to_string())),
                    };
                    let frame = match HostFrame::parse(&plain) {
                        Ok(f) => f,
                        Err(e) => { log::warn!("collab guest: undecodable frame: {e}"); continue; }
                    };
                    match (&mut phase, frame) {
                        (_, HostFrame::Welcome(w)) => {
                            self.inner.read_only.store(w.read_only || !self.inner.can_write, Ordering::Release);
                            let done = w.entry_count == 0;
                            phase = Phase::Snapshot { welcome: w, entries: Vec::new(), deadline: Instant::now() + timeouts.snapshot_progress };
                            if done {
                                self.finish_snapshot(&mut phase, resync, synced);
                            }
                        }
                        (Phase::Snapshot { welcome, entries, deadline }, HostFrame::SnapshotChunk(chunk)) => {
                            entries.extend(chunk.entries);
                            *deadline = Instant::now() + timeouts.snapshot_progress;
                            if chunk.is_final || entries.len() as u64 >= welcome.entry_count {
                                self.finish_snapshot(&mut phase, resync, synced);
                            }
                        }
                        (Phase::AwaitWelcome { .. }, HostFrame::Error { message }) => {
                            if let Some(first) = self.first.take() {
                                let _ = first.send(Err(GuestError::Rejected(message.clone())));
                                return ConnEnd::End(EndReason::Rejected(message));
                            }
                            if message.contains("protocol mismatch") {
                                return ConnEnd::End(EndReason::Rejected(message));
                            }
                            // Transitional rejection ("join again when it completes"): reconnect.
                            return ConnEnd::Closed(4000, message);
                        }
                        (Phase::Live, HostFrame::Transcript(t)) => self.deliver_transcript(t),
                        (Phase::Live, HostFrame::Bye { reason }) => {
                            let _ = self.events.send(GuestEvent::Frame(HostFrame::Bye { reason: reason.clone() }));
                            return ConnEnd::End(EndReason::Bye(reason));
                        }
                        (Phase::Live, frame) => { let _ = self.events.send(GuestEvent::Frame(frame)); }
                        // Live frames before the snapshot completes are dropped (§5.6.2).
                        (_, HostFrame::Transcript(t)) => self.deliver_transcript(t),
                        _ => {}
                    }
                }
            }
        }
    }

    fn deliver_transcript(&self, t: TranscriptFrame) {
        let waiter = self.inner.transcripts.lock().unwrap().remove(&t.req_id);
        match waiter {
            Some(tx) => {
                let _ = tx.send(TranscriptChunk { text: t.text, new_size: t.new_size, error: t.error });
            }
            None => {
                let _ = self.events.send(GuestEvent::Frame(HostFrame::Transcript(t)));
            }
        }
    }

    fn finish_snapshot(&mut self, phase: &mut Phase, resync: bool, synced: &mut bool) {
        let Phase::Snapshot { welcome, entries, .. } = std::mem::replace(phase, Phase::Live) else { return };
        *synced = true;
        self.inner.live.store(true, Ordering::Release);
        let _ = self.events.send(GuestEvent::Snapshot(Snapshot { welcome, entries, resync }));
        if let Some(first) = self.first.take() {
            let _ = first.send(Ok(()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_timeouts_double_up_to_eight_times_the_base() {
        let secs = |t: JoinTimeouts| (t.welcome.as_secs(), t.snapshot_progress.as_secs());
        assert_eq!(JoinTimeouts::default(), JoinTimeouts::BASE);
        assert_eq!(
            [0, 1, 2, 3, 9].map(|n| secs(JoinTimeouts::escalated(n))),
            [(30, 30), (60, 60), (120, 120), (240, 240), (240, 240)]
        );
        let mut t = JoinTimeouts::BASE;
        for _ in 0..6 {
            t = t.doubled();
        }
        assert_eq!(secs(t), (240, 240));
        // A longer custom timeout is never shortened.
        let long = JoinTimeouts { welcome: Duration::from_secs(600), snapshot_progress: Duration::from_secs(30) };
        assert_eq!(secs(long.doubled()), (600, 60));
    }
}
