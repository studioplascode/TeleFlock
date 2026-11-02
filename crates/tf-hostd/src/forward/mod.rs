//! Host-to-host forwarding, this host's side (architecture §3.30; wire `tf_proto::forward`).
//!
//! * **From-host.** Connected apps offer the rules they relay for this host (`fwdOffer`; per name
//!   the newest offer wins, [`offers`]). `tf-forward` connects to the local endpoint
//!   ([`endpoint`]: a 0600 socket in a 0700 dir, or a user-only pipe) and opens a stream towards
//!   the app relaying its name; tool shims ([`shims`]) run `tf-forward --tool`; a listener on
//!   127.0.0.1 per offered port opens one stream per connection. Streams this host opens have
//!   even ids. The caller's end ([`relay_cli`]) passes events through, acks included: the caller
//!   and the to-host do the flow control.
//! * **To-host.** Streams an app opens (odd ids) run here ([`exec`]): a command through the user's
//!   shell, a login shell, a tool, or a TCP connection to 127.0.0.1:<port>; on Linux programs get
//!   the user's current graphical session (`desktop`). The app only opens what a rule on that
//!   device allows; hostd trusts its clients (they can open terminals anyway).
//!
//! Every stream ends with its link: a dropped app ends the callers' streams with a reason and kills
//! the process group of what ran for it here.

pub mod cli;
#[cfg(target_os = "linux")]
mod desktop;
mod endpoint;
mod exec;
mod flow;
mod offers;
#[cfg(target_os = "linux")]
mod peer;
#[cfg(unix)]
mod pty;
mod shims;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tf_proto::{FWD_CHUNK, FWD_STREAMS, ForwardKind, ForwardPortError, FwdEv, FwdOffer, FwdOfferState, ServerMsg, b64_len};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::clients::ClientHandle;
use crate::ipc::{BoxRead, BoxWrite};
use crate::paths::Paths;

use self::flow::{Inflight, Window};
use self::offers::Offers;
use self::shims::Shim;

/// Streams one app may run here at once (its rules allow [`FWD_STREAMS`] each).
const STREAMS_PER_APP: usize = 4 * FWD_STREAMS;

/// First line `tf-forward` sends on the endpoint.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub(crate) enum CliRequest {
    /// Open a stream (`open` is an [`FwdEv::Open`]); `FwdEv` lines follow in both directions.
    Open { open: FwdEv },
    /// What `tf-forward --list` shows.
    List,
}

/// The answer to [`CliRequest::List`].
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListReply {
    pub forwards: Vec<ListEntry>,
    /// The shims' directory (`<home>/forward/bin`).
    pub bin: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListEntry {
    pub name: String,
    /// What the relaying app offers; `None`: no app relays it right now (one did since tf-hostd started).
    pub offer: Option<FwdOffer>,
    /// The device of the app that relays it (or relayed it last).
    pub device: String,
    #[serde(default)]
    pub port_errors: Vec<ForwardPortError>,
}

/// The forwarding service of the daemon. Cheap to clone.
#[derive(Clone)]
pub struct Forwarder {
    inner: Arc<Inner>,
}

struct Inner {
    home: PathBuf,
    /// `<home>/forward/bin`: the shims and a `tf-forward` launcher.
    bin: PathBuf,
    /// The tf-hostd the launchers and shims run.
    exe: PathBuf,
    cancel: CancellationToken,
    st: Mutex<State>,
}

#[derive(Default)]
struct State {
    offers: Offers,
    /// Apps that offered something, by client id (`fwdOffered` goes back to them).
    clients: HashMap<String, ClientHandle>,
    /// Names offered since this daemon started → the device that offered them last.
    known: BTreeMap<String, String>,
    /// Streams this host opened (even ids): the caller's end.
    local: HashMap<u64, Local>,
    next_sid: u64,
    /// Streams apps opened here (odd ids), by (client id, sid).
    remote: HashMap<(String, u64), Remote>,
    /// Port listeners on 127.0.0.1 by listen port.
    listeners: HashMap<u16, Listener>,
    /// Ports that could not be bound, by forward name.
    port_errors: BTreeMap<String, Vec<ForwardPortError>>,
    /// The shims written (tool → what it runs).
    shims: BTreeMap<String, Shim>,
    /// The `fwdOffered` last sent to each app.
    sent: HashMap<String, Vec<FwdOfferState>>,
    /// The daemon is shutting down: no shims or listeners any more.
    closed: bool,
    /// When a connection from another user's process was last logged (once a minute).
    #[cfg(target_os = "linux")]
    refused_logged: Option<std::time::Instant>,
}

/// The caller's end of a stream this host opened.
struct Local {
    client: String,
    /// The forward it runs through.
    name: String,
    /// The app's events for the caller.
    tx: mpsc::UnboundedSender<FwdEv>,
    /// Port streams: this host sends, and the to-host's acks give it credit. A CLI caller gets
    /// the acks itself.
    window: Option<Arc<Window>>,
    /// App data towards the caller that the caller has not acknowledged.
    inflight: Arc<Inflight>,
}

/// A stream an app opened here.
struct Remote {
    tx: mpsc::UnboundedSender<FwdEv>,
    window: Arc<Window>,
    inflight: Arc<Inflight>,
}

struct Listener {
    /// The forward that owns the port.
    name: String,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `[a-z0-9][a-z0-9-]{0,31}`.
fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 32 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `[A-Za-z0-9._+-]{1,64}`, not the launcher's name nor a Windows device name (tools become file
/// names).
pub(crate) fn valid_tool(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != shims::LAUNCHER
        && s != "."
        && s != ".."
        && !tf_proto::is_windows_device_name(s)
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))
}

/// Longest line a `tf-forward` caller may send (a data line is under 44 KiB; an open carries the
/// command line).
const CLI_LINE_MAX: usize = 1024 * 1024;

/// Payload bytes of a data frame, `None` past [`FWD_CHUNK`] (a peer that sends larger frames
/// breaks the protocol and is cut off).
fn frame_len(data: &str) -> Option<u64> {
    Some(b64_len(data)).filter(|n| *n <= FWD_CHUNK as u64)
}

/// [`Local::name`] of an agent's browser connections: never a forward's name (those have no `:`).
fn browser_key(agent_id: &str) -> String {
    format!("browser:{agent_id}")
}

fn valid_offer(o: &FwdOffer) -> bool {
    valid_name(&o.name) && o.tools.iter().all(|t| valid_tool(t)) && o.ports.iter().all(|p| p.listen != 0 && p.target != 0)
}

fn bind_error(port: u16, e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AddrInUse => format!("port {port} is in use on this host"),
        // Windows has no privileged ports: access is denied for ports in a range the system
        // reserved (Hyper-V, WinNAT) or held exclusively by another program.
        std::io::ErrorKind::PermissionDenied if cfg!(windows) => format!("port {port} is reserved by Windows or held exclusively by another program on this host"),
        std::io::ErrorKind::PermissionDenied => format!("port {port} needs administrator rights on this host"),
        _ => format!("port {port}: {e}"),
    }
}

impl Forwarder {
    /// Writes the launchers, clears shims a previous daemon left, and serves the endpoint.
    pub fn start(paths: &Paths, cancel: CancellationToken) -> Forwarder {
        let bin = paths.home.join("forward").join("bin");
        let exe = shims::exe_path(&paths.home);
        if let Err(e) = shims::write_launchers(&paths.home, &bin, &exe) {
            warn!("writing tf-forward: {e}");
        }
        shims::sync(&bin, &paths.home, &exe, &BTreeMap::new());
        let fwd = Forwarder { inner: Arc::new(Inner { home: paths.home.clone(), bin, exe, cancel, st: Mutex::default() }) };
        match endpoint::Endpoint::bind(paths) {
            Ok(ep) => {
                info!(endpoint = %paths.forward_endpoint(), "forwarding endpoint listening");
                tokio::spawn(fwd.clone().accept_loop(ep));
            }
            Err(e) => warn!(endpoint = %paths.forward_endpoint(), "forwarding endpoint: {e}; tf-forward cannot reach this daemon"),
        }
        fwd
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Daemon shutdown (after its cancel fired): the shims and port listeners go (a stopped daemon
    /// relays nothing, and a stale shim would shadow the real tool), and what runs here for apps
    /// is killed before the runtime stops (bounded).
    pub async fn shutdown(&self) {
        {
            let mut st = self.lock();
            st.closed = true;
            st.listeners.clear();
            shims::sync(&self.inner.bin, &self.inner.home, &self.inner.exe, &BTreeMap::new());
            st.shims.clear();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while !self.lock().remote.is_empty() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn accept_loop(self, mut ep: endpoint::Endpoint) {
        loop {
            tokio::select! {
                _ = self.inner.cancel.cancelled() => return,
                accepted = ep.accept() => match accepted {
                    Ok((r, w)) => {
                        tokio::spawn(self.clone().serve_cli(r, w));
                    }
                    Err(e) => {
                        warn!("forwarding endpoint accept: {e}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                },
            }
        }
    }

    // ───────────────────────────── app messages ─────────────────────────────

    /// `fwdOffer`: the rules `client` relays for this host now.
    pub fn offer(&self, client: &ClientHandle, offers: Vec<FwdOffer>) {
        let device = client.info().device.clone();
        let offers: Vec<FwdOffer> = offers
            .into_iter()
            .filter(|o| {
                let ok = valid_offer(o);
                if !ok {
                    warn!(client = %client.id(), name = %o.name, "ignoring a malformed forward offer");
                }
                ok
            })
            .collect();
        info!(client = %client.id(), %device, names = ?offers.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), "forward offers");
        let mut st = self.lock();
        for o in &offers {
            st.known.insert(o.name.clone(), device.clone());
        }
        st.offers.set(client.id(), &device, offers);
        st.clients.insert(client.id().to_string(), client.clone());
        self.reconcile(&mut st);
    }

    /// A `fwd` event from `client`.
    pub fn fwd(&self, client: &ClientHandle, sid: u64, ev: FwdEv) {
        if sid % 2 == 1 && matches!(ev, FwdEv::Open { .. }) {
            self.open_remote(client, sid, ev);
            return;
        }
        let mut st = self.lock();
        if sid.is_multiple_of(2) {
            let Some(l) = st.local.get(&sid).filter(|l| l.client == client.id()) else { return };
            match &ev {
                FwdEv::Ack { n } if l.window.is_some() => {
                    l.window.as_ref().expect("checked").ack(*n);
                    return;
                }
                FwdEv::Data { data, .. } if frame_len(data).is_none_or(|n| !l.inflight.arrived(n)) => {
                    let why = "the TeleFlock app sent more than the flow-control window allows".to_string();
                    if let Some(l) = st.local.remove(&sid) {
                        let _ = l.tx.send(FwdEv::Close { error: Some(why.clone()) });
                    }
                    client.send(ServerMsg::Fwd { sid, ev: FwdEv::Close { error: Some(why) } });
                    return;
                }
                _ => {}
            }
            let last = ev.is_final();
            let _ = l.tx.send(ev);
            if last {
                st.local.remove(&sid);
            }
        } else {
            let key = (client.id().to_string(), sid);
            let Some(r) = st.remote.get(&key) else { return };
            match &ev {
                FwdEv::Ack { n } => r.window.ack(*n),
                FwdEv::Data { data, .. } if frame_len(data).is_none_or(|n| !r.inflight.arrived(n)) => {
                    let r = st.remote.remove(&key).expect("found above");
                    let _ = r.tx.send(FwdEv::Close { error: None });
                    client.send(ServerMsg::Fwd {
                        sid,
                        ev: FwdEv::Close { error: Some("the TeleFlock app sent more than the flow-control window allows".into()) },
                    });
                }
                _ => {
                    let last = ev.is_final();
                    let _ = r.tx.send(ev);
                    if last {
                        st.remote.remove(&key);
                    }
                }
            }
        }
    }

    /// The app's connection is gone: its offers go (shims, ports), the callers of its streams learn
    /// why, and what ran here for it is stopped.
    pub fn client_gone(&self, client_id: &str) {
        let mut st = self.lock();
        let device = st.clients.get(client_id).map(|c| c.info().device.clone());
        st.offers.remove(client_id);
        st.clients.remove(client_id);
        st.sent.remove(client_id);
        let locals: Vec<u64> = st.local.iter().filter(|(_, l)| l.client == client_id).map(|(s, _)| *s).collect();
        for sid in locals {
            if let Some(l) = st.local.remove(&sid) {
                let why = match &device {
                    Some(d) => format!("the TeleFlock app relaying it disconnected ({d})"),
                    None => "the TeleFlock app relaying it disconnected".to_string(),
                };
                let _ = l.tx.send(FwdEv::Close { error: Some(why) });
                if let Some(w) = l.window {
                    w.close();
                }
            }
        }
        let remotes: Vec<(String, u64)> = st.remote.keys().filter(|(c, _)| c == client_id).cloned().collect();
        for key in remotes {
            if let Some(r) = st.remote.remove(&key) {
                let _ = r.tx.send(FwdEv::Close { error: None });
            }
        }
        self.reconcile(&mut st);
    }

    /// Applies the winning offers: port listeners, shims, and each app's `fwdOffered`.
    fn reconcile(&self, st: &mut State) {
        if st.closed {
            return;
        }
        let winners = st.offers.winners();
        let mut owner: BTreeMap<u16, String> = BTreeMap::new();
        let mut errors: BTreeMap<String, Vec<ForwardPortError>> = BTreeMap::new();
        for (name, w) in &winners {
            for p in &w.offer.ports {
                match owner.get(&p.listen) {
                    Some(other) => errors
                        .entry(name.clone())
                        .or_default()
                        .push(ForwardPortError { listen: p.listen, message: format!("port {} is taken by forward \"{other}\"", p.listen) }),
                    None => {
                        owner.insert(p.listen, name.clone());
                    }
                }
            }
        }
        st.listeners.retain(|port, _| owner.contains_key(port));
        for (port, name) in &owner {
            if let Some(l) = st.listeners.get_mut(port) {
                l.name = name.clone();
                continue;
            }
            let bound = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port))
                .and_then(|l| l.set_nonblocking(true).map(|()| l))
                .and_then(tokio::net::TcpListener::from_std);
            match bound {
                Ok(l) => {
                    info!(port, forward = %name, "forward port listening on 127.0.0.1");
                    let task = tokio::spawn(self.clone().accept_port(*port, l));
                    st.listeners.insert(*port, Listener { name: name.clone(), task });
                }
                Err(e) => {
                    warn!(port, forward = %name, "forward port: {e}");
                    errors.entry(name.clone()).or_default().push(ForwardPortError { listen: *port, message: bind_error(*port, &e) });
                }
            }
        }
        st.port_errors = errors;

        let mut want: BTreeMap<String, Shim> = BTreeMap::new();
        for (name, w) in &winners {
            for tool in &w.offer.tools {
                match want.get(tool) {
                    Some(first) => warn!(%tool, forward = %name, "tool is relayed by forward \"{}\" already; no shim for this one", first.name),
                    None => {
                        want.insert(tool.clone(), Shim { name: name.clone(), to: w.offer.to.clone() });
                    }
                }
            }
        }
        if want != st.shims {
            shims::sync(&self.inner.bin, &self.inner.home, &self.inner.exe, &want);
            st.shims = want;
        }

        let clients: Vec<String> = st.clients.keys().cloned().collect();
        for id in clients {
            let states: Vec<FwdOfferState> = st
                .offers
                .names_of(&id)
                .into_iter()
                .map(|name| match winners.get(&name) {
                    Some(w) if w.client == id => {
                        let port_errors = st.port_errors.get(&name).cloned().unwrap_or_default();
                        FwdOfferState { name, active: true, message: None, port_errors }
                    }
                    other => {
                        let device = other.map_or("another device", |w| w.device.as_str());
                        let message = Some(format!("TeleFlock on {device} relays \"{name}\" to this host"));
                        FwdOfferState { name, active: false, message, port_errors: Vec::new() }
                    }
                })
                .collect();
            if states.is_empty() {
                st.sent.remove(&id);
                continue;
            }
            if st.sent.get(&id) != Some(&states)
                && let Some(c) = st.clients.get(&id)
            {
                c.send(ServerMsg::FwdOffered { states: states.clone() });
                st.sent.insert(id, states);
            }
        }
    }

    fn next_sid(st: &mut State) -> u64 {
        st.next_sid += 2;
        st.next_sid
    }

    // ───────────────────────────── to-host ─────────────────────────────

    fn open_remote(&self, client: &ClientHandle, sid: u64, open: FwdEv) {
        let (tx, rx) = mpsc::unbounded_channel();
        let window = Arc::new(Window::default());
        let inflight = Arc::new(Inflight::default());
        let key = (client.id().to_string(), sid);
        {
            let mut st = self.lock();
            if st.remote.contains_key(&key) {
                return;
            }
            if st.remote.keys().filter(|(c, _)| c == client.id()).count() >= STREAMS_PER_APP {
                warn!(client = %client.id(), sid, "forwarded stream refused: {STREAMS_PER_APP} already run here");
                client.send(ServerMsg::Fwd { sid, ev: FwdEv::Close { error: Some(format!("{STREAMS_PER_APP} forwarded streams already run on that host")) } });
                return;
            }
            st.remote.insert(key.clone(), Remote { tx, window: window.clone(), inflight: inflight.clone() });
        }
        if let FwdEv::Open { kind, name, .. } = &open {
            info!(client = %client.id(), sid, forward = %name, ?kind, "forwarded stream opened here");
        }
        // Only while the stream is registered: once this daemon ended it (a sender past its
        // window), nothing of it follows the close the app got.
        let (fwd, c, k) = (self.clone(), client.clone(), key.clone());
        let send: exec::Send = Arc::new(move |ev| fwd.lock().remote.contains_key(&k) && c.send(ServerMsg::Fwd { sid, ev }));
        let (fwd, cancel) = (self.clone(), self.inner.cancel.clone());
        tokio::spawn(async move {
            exec::run(open, exec::Stream { send, rx, window, inflight }, cancel, &fwd.inner.bin).await;
            fwd.lock().remote.remove(&key);
            debug!(client = %key.0, sid, "forwarded stream ended here");
        });
    }

    // ───────────────────────────── from-host ─────────────────────────────

    async fn accept_port(self, port: u16, l: tokio::net::TcpListener) {
        loop {
            match l.accept().await {
                Ok((tcp, _)) => self.open_port(port, tcp),
                Err(e) => {
                    debug!(port, "forward port accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// A connection to a forwarded port: one stream to the app relaying its forward.
    fn open_port(&self, port: u16, tcp: tokio::net::TcpStream) {
        #[cfg(target_os = "linux")]
        if !self.same_user(port, &tcp) {
            return;
        }
        let _ = tcp.set_nodelay(true);
        let (tx, rx) = mpsc::unbounded_channel();
        let window = Arc::new(Window::default());
        let inflight = Arc::new(Inflight::default());
        let (client, sid, name) = {
            let mut st = self.lock();
            let Some(name) = st.listeners.get(&port).map(|l| l.name.clone()) else { return };
            let Some(w) = st.offers.winner(&name) else { return };
            if !w.offer.ready {
                info!(port, forward = %name, "connection closed: {} is not connected to TeleFlock on {}", w.offer.to, w.device);
                return;
            }
            let Some(client) = st.clients.get(&w.client).cloned() else { return };
            if st.local.values().filter(|l| l.name == name).count() >= FWD_STREAMS {
                warn!(port, forward = %name, "connection closed: {FWD_STREAMS} streams of the forward are open");
                return;
            }
            let sid = Self::next_sid(&mut st);
            st.local.insert(sid, Local { client: w.client.clone(), name: name.clone(), tx, window: Some(window.clone()), inflight: inflight.clone() });
            (client, sid, name)
        };
        let open = FwdEv::Open { kind: ForwardKind::Port, name, command: None, argv: None, pty: None, cwd: None, port: Some(port) };
        client.send(ServerMsg::Fwd { sid, ev: open });
        self.pump_tcp(client, sid, port, tcp, exec::Stream { send: Arc::new(|_| false), rx, window, inflight });
    }

    /// Runs a connection this host accepted as stream `sid` towards `client`: data flows once the
    /// other side opened it (`opened`), until either end closes. `s.send` is replaced here.
    fn pump_tcp(&self, client: ClientHandle, sid: u64, port: u16, tcp: tokio::net::TcpStream, mut s: exec::Stream) {
        let fwd = self.clone();
        s.send = Arc::new(move |ev| fwd.lock().local.contains_key(&sid) && client.send(ServerMsg::Fwd { sid, ev }));
        let fwd = self.clone();
        tokio::spawn(async move {
            // Data flows once the to-host (or the app's browser) connected.
            let opened = loop {
                match s.rx.recv().await {
                    Some(FwdEv::Opened { .. }) => break true,
                    Some(FwdEv::Close { error }) => {
                        info!(port, sid, "forwarded connection refused: {}", error.unwrap_or_default());
                        break false;
                    }
                    None => break false,
                    Some(_) => {}
                }
            };
            if opened {
                exec::tcp(tcp, &mut s, 0, &fwd.inner.cancel).await;
            }
            fwd.lock().local.remove(&sid);
        });
    }

    // ───────────────────────────── the TeleFlock Browser (§3.33) ─────────────────────────────

    /// A connection to an agent's browser port (`crate::browser`): one stream of kind `browser`
    /// to the app that lent its browser, whose DevTools proxy serves it. Linux: only this user's
    /// processes may connect.
    pub(crate) fn open_browser(&self, client: &ClientHandle, agent_id: &str, port: u16, tcp: tokio::net::TcpStream) {
        #[cfg(target_os = "linux")]
        if !self.same_user(port, &tcp) {
            return;
        }
        let _ = tcp.set_nodelay(true);
        let (tx, rx) = mpsc::unbounded_channel();
        let window = Arc::new(Window::default());
        let inflight = Arc::new(Inflight::default());
        let key = browser_key(agent_id);
        let sid = {
            let mut st = self.lock();
            if st.closed {
                return;
            }
            if st.local.values().filter(|l| l.name == key).count() >= FWD_STREAMS {
                warn!(port, agent = %agent_id, "browser connection closed: {FWD_STREAMS} are open");
                return;
            }
            let sid = Self::next_sid(&mut st);
            st.local.insert(sid, Local { client: client.id().to_string(), name: key, tx, window: Some(window.clone()), inflight: inflight.clone() });
            sid
        };
        debug!(port, sid, agent = %agent_id, "browser connection");
        let open = FwdEv::Open { kind: ForwardKind::Browser, name: agent_id.to_string(), command: None, argv: None, pty: None, cwd: None, port: Some(port) };
        client.send(ServerMsg::Fwd { sid, ev: open });
        self.pump_tcp(client.clone(), sid, port, tcp, exec::Stream { send: Arc::new(|_| false), rx, window, inflight });
    }

    /// Ends the browser connections of `agent_id` that `client` serves (its attachment ended):
    /// the agent's connections close and the app learns why.
    pub(crate) fn close_browser(&self, client: &ClientHandle, agent_id: &str, why: &str) {
        let key = browser_key(agent_id);
        let mut st = self.lock();
        let sids: Vec<u64> = st.local.iter().filter(|(_, l)| l.name == key && l.client == client.id()).map(|(s, _)| *s).collect();
        for sid in sids {
            if let Some(l) = st.local.remove(&sid) {
                let _ = l.tx.send(FwdEv::Close { error: None });
                if let Some(w) = l.window {
                    w.close();
                }
                client.send(ServerMsg::Fwd { sid, ev: FwdEv::Close { error: Some(why.to_string()) } });
            }
        }
    }

    /// Validates a `tf-forward` open against the winning offer and opens it towards the app.
    fn open_cli(&self, open: FwdEv) -> Result<(u64, ClientHandle, mpsc::UnboundedReceiver<FwdEv>, Arc<Inflight>), String> {
        let FwdEv::Open { kind, name, command, argv, pty, cwd, .. } = open else {
            return Err("expected a stream to open".into());
        };
        if matches!(kind, ForwardKind::Port | ForwardKind::Browser) {
            return Err("tf-forward runs commands, shells and tools; ports are forwarded by listening".into());
        }
        let mut st = self.lock();
        let Some(w) = st.offers.winner(&name) else {
            return Err(match st.known.get(&name) {
                Some(device) => format!("no TeleFlock app is connected to relay to \"{name}\" (TeleFlock on {device} relayed it)"),
                None if st.offers.clients().is_empty() => format!("no TeleFlock app is connected to relay to \"{name}\""),
                None => format!("no forward called \"{name}\" (tf-forward --list shows them)"),
            });
        };
        match kind {
            ForwardKind::Command | ForwardKind::Shell if !w.offer.shell => {
                return Err(format!("forward \"{name}\" runs no commands or shells, only its tools and ports"));
            }
            ForwardKind::Tool => {
                let tool = argv.as_ref().and_then(|a| a.first()).cloned().unwrap_or_default();
                if !w.offer.tools.contains(&tool) {
                    return Err(format!("forward \"{name}\" does not forward the tool \"{tool}\""));
                }
            }
            _ => {}
        }
        if !w.offer.ready {
            return Err(w.offer.reason.clone().unwrap_or_else(|| format!("{} is not connected to TeleFlock on {}", w.offer.to, w.device)));
        }
        let Some(client) = st.clients.get(&w.client).cloned() else {
            return Err(format!("no TeleFlock app is connected to relay to \"{name}\""));
        };
        if st.local.values().filter(|l| l.name == name).count() >= FWD_STREAMS {
            return Err(format!("forward \"{name}\" already has {FWD_STREAMS} streams open"));
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let inflight = Arc::new(Inflight::default());
        let sid = Self::next_sid(&mut st);
        st.local.insert(sid, Local { client: w.client.clone(), name: name.clone(), tx, window: None, inflight: inflight.clone() });
        info!(sid, forward = %name, ?kind, device = %w.device, "tf-forward stream opened");
        client.send(ServerMsg::Fwd { sid, ev: FwdEv::Open { kind, name, command, argv, pty, cwd, port: None } });
        Ok((sid, client, rx, inflight))
    }

    /// `tf-forward --list`.
    fn list(&self) -> ListReply {
        let st = self.lock();
        let winners = st.offers.winners();
        let forwards = st
            .known
            .iter()
            .map(|(name, device)| match winners.get(name) {
                Some(w) => ListEntry {
                    name: name.clone(),
                    offer: Some(w.offer.clone()),
                    device: w.device.clone(),
                    port_errors: st.port_errors.get(name).cloned().unwrap_or_default(),
                },
                None => ListEntry { name: name.clone(), offer: None, device: device.clone(), port_errors: Vec::new() },
            })
            .collect();
        ListReply { forwards, bin: self.inner.bin.display().to_string() }
    }

    /// One `tf-forward` connection.
    async fn serve_cli(self, read: BoxRead, mut write: BoxWrite) {
        let mut reader = BufReader::with_capacity(64 * 1024, read);
        let mut line = String::new();
        match tokio::time::timeout(Duration::from_secs(10), crate::clients::read_line_max(&mut reader, &mut line, CLI_LINE_MAX)).await {
            Ok(Ok(true)) => {}
            _ => return,
        }
        let req = match serde_json::from_str::<CliRequest>(&line) {
            Ok(r) => r,
            Err(e) => {
                write_line(&mut write, &FwdEv::Close { error: Some(format!("bad request: {e}")) }).await;
                return;
            }
        };
        match req {
            CliRequest::List => {
                let reply = self.list();
                write_line(&mut write, &reply).await;
            }
            CliRequest::Open { open } => match self.open_cli(open) {
                Err(why) => {
                    write_line(&mut write, &FwdEv::Close { error: Some(why) }).await;
                }
                Ok((sid, client, rx, inflight)) => self.relay_cli(sid, client, reader, write, rx, inflight).await,
            },
        }
    }

    /// Passes events between a `tf-forward` caller and the app until the stream ends.
    async fn relay_cli(
        self,
        sid: u64,
        client: ClientHandle,
        mut reader: BufReader<BoxRead>,
        mut write: BoxWrite,
        mut rx: mpsc::UnboundedReceiver<FwdEv>,
        inflight: Arc<Inflight>,
    ) {
        // Caller data on its way to the to-host (its acks come back through the app): a caller
        // past its window is cut off before its data piles up in this daemon's queue to the app.
        let up = Arc::new(Inflight::default());
        // App → caller, until the stream's last event.
        let up_acked = up.clone();
        let to_caller = tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if let FwdEv::Ack { n } = &ev {
                    up_acked.acked(*n);
                }
                let last = ev.is_final();
                if !write_line(&mut write, &ev).await || last {
                    break;
                }
            }
            let _ = write.shutdown().await;
        });
        // Caller → app, until the caller goes away.
        let mut line = String::new();
        loop {
            line.clear();
            let ev = match crate::clients::read_line_max(&mut reader, &mut line, CLI_LINE_MAX).await {
                Ok(true) => match serde_json::from_str::<FwdEv>(&line) {
                    Ok(ev) => ev,
                    Err(e) => {
                        debug!(sid, "tf-forward sent a bad line: {e}");
                        continue;
                    }
                },
                _ => break,
            };
            let ev = match ev {
                FwdEv::Data { data, .. } if frame_len(&data).is_none_or(|n| !up.arrived(n)) => {
                    self.cut_caller(sid, &client, "tf-forward sent more than the flow-control window allows");
                    break;
                }
                FwdEv::Data { data, .. } => FwdEv::Data { data, fd: 0 },
                // An ack of bytes it never got would open the to-host's window for nothing.
                FwdEv::Ack { n } if !inflight.acked(n) => {
                    self.cut_caller(sid, &client, "tf-forward acknowledged more than it received");
                    break;
                }
                e @ (FwdEv::Ack { .. } | FwdEv::Eof | FwdEv::Resize { .. } | FwdEv::Close { .. }) => e,
                _ => continue,
            };
            // Under the lock: nothing of the stream follows a close this daemon sent the app.
            let mut st = self.lock();
            if !st.local.contains_key(&sid) {
                break;
            }
            let last = ev.is_final();
            if last {
                st.local.remove(&sid);
            }
            client.send(ServerMsg::Fwd { sid, ev });
            drop(st);
            if last {
                break;
            }
        }
        // A caller that went away before the end: the to-host stops what it runs.
        if self.lock().local.remove(&sid).is_some() {
            client.send(ServerMsg::Fwd { sid, ev: FwdEv::Close { error: None } });
        }
        to_caller.abort();
    }

    /// Ends a caller's stream that broke the flow control: the caller and the app learn why (the
    /// to-host stops the program), and nothing of the stream follows.
    fn cut_caller(&self, sid: u64, client: &ClientHandle, why: &str) {
        warn!(sid, "tf-forward stream cut off: {why}");
        let mut st = self.lock();
        if let Some(l) = st.local.remove(&sid) {
            let _ = l.tx.send(FwdEv::Close { error: Some(why.to_string()) });
            client.send(ServerMsg::Fwd { sid, ev: FwdEv::Close { error: Some(why.to_string()) } });
        }
    }

    /// Linux: whether a connection to a forwarded port comes from this user's process. Ports
    /// listen on 127.0.0.1, which every account on the host can reach; the connecting socket's
    /// owner is in `/proc/net/tcp`. Refusals are logged at most once a minute.
    #[cfg(target_os = "linux")]
    fn same_user(&self, port: u16, tcp: &tokio::net::TcpStream) -> bool {
        // SAFETY: geteuid cannot fail.
        let me = unsafe { libc::geteuid() };
        let owner = match (tcp.peer_addr(), tcp.local_addr()) {
            (Ok(peer), Ok(local)) => peer::uid_of(peer, local),
            _ => None,
        };
        if owner == Some(me) {
            return true;
        }
        let mut st = self.lock();
        if st.refused_logged.is_none_or(|t| t.elapsed() >= Duration::from_secs(60)) {
            st.refused_logged = Some(std::time::Instant::now());
            warn!(port, ?owner, "forward port: refused a connection from another user's process (only this user's processes may use it)");
        }
        false
    }
}

/// Writes one JSON line; `false` when the caller is gone.
async fn write_line<T: serde::Serialize>(w: &mut BoxWrite, value: &T) -> bool {
    let Ok(mut s) = serde_json::to_string(value) else { return false };
    s.push('\n');
    w.write_all(s.as_bytes()).await.is_ok() && w.flush().await.is_ok()
}

// The programs these tests run are `sh` command lines.
#[cfg(all(test, unix))]
mod tests;
