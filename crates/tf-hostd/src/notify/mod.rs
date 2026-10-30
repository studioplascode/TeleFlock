//! Notifications that find you (architecture §3.21).
//!
//! * **Presence.** Every app past its hello is a [`presence::Device`]; apps that negotiated
//!   `presence` report what their user is doing (`active`, `idle`, `away`, phone or desktop).
//! * **Routing.** The state store hands each notification to [`Notifier::post`] instead of
//!   broadcasting it: every app still gets it (the in-app list stays complete), but presence apps
//!   are told whether to alert (`notify.alert`): the device in use, else the phones ([`route`]).
//!   Older apps alert by themselves, as before.
//! * **Escalation.** A needs-you, error or stall notification that nobody read within the policy's
//!   delay, and whose cause is still there (the request pending, the agent still erred or quiet),
//!   alerts the escalation devices (`notifyAlert`) and the push channels that want unseen ones.
//! * **Retraction.** An app that marks notifications read (`notifyRead`) stops their escalation;
//!   the other apps are told (`notifyDone`) and retract them, ntfy clears its copy, a webhook gets
//!   a `done` event. Answered requests leave host state, which every app already follows.
//! * **Push.** Channels in `<home>/notify.json` ([`store`]) deliver from the daemon itself when no
//!   app is connected, when nobody saw a notification in time, or always ([`push`]), at most a
//!   burst of 5 and then one per 20 s each; the rest leaves as one summary. With a channel on,
//!   [`start`] brings up the boards of the herdr sessions this host knows when the daemon starts,
//!   so a restarted tf-hostd pushes before any app connects.

pub mod ops;
pub mod presence;
pub mod push;
pub mod route;
pub mod store;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use tf_proto::host::ServerMsg;
use tf_proto::{
    Agent, ApiError, Column, NotifyConfig, NotifyKind, NotifyPolicy, NotifyTestParams, NotifyTestResult, Notification, Presence, PushChannelSave,
    PushKind, PushResult, PushWhen,
};

use crate::clients::{line_of, ClientHandle};
use crate::state::StateHandle;
use crate::util::{new_id, now_ms};
pub use presence::PresenceSummary;
use presence::Device;
use push::{Bucket, Event, Http, Message, Origin, Reason};
use route::Candidate;
use store::{NotifyFile, StoredChannel};

/// Notifications remembered for escalation and retraction.
const LEDGER_CAP: usize = 256;
/// Rate-limited notifications kept for the next summary; older ones are only counted.
const BACKLOG_CAP: usize = 20;
/// A channel test at most this often.
const TEST_EVERY: Duration = Duration::from_secs(3);
/// How often a pushed notification's cause is checked (answered elsewhere → retracted).
const WATCH_EVERY: Duration = Duration::from_secs(5);
/// Pushed notifications are followed this long at most.
const WATCH_FOR: Duration = Duration::from_secs(24 * 3600);

/// The daemon's notification router (one per daemon, cheap to clone).
#[derive(Clone)]
pub struct Notifier {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    cfg: Mutex<NotifyFile>,
    devices: Mutex<HashMap<String, Device>>,
    ledger: Mutex<Ledger>,
    chans: Mutex<HashMap<String, ChanState>>,
    http: Http,
    host: String,
    cancel: CancellationToken,
}

#[derive(Default)]
struct Ledger {
    order: VecDeque<String>,
    entries: HashMap<String, Entry>,
}

struct Entry {
    session: String,
    n: Notification,
    agent_name: Option<String>,
    /// Apps that alerted for it (told to, or older apps that always do).
    alerted: Vec<String>,
    read_by: Option<String>,
    escalated: bool,
    /// A newer notification of the same agent replaced it in the apps: it no longer escalates
    /// (its pushed copies are still taken back once its cause is gone, [`Notifier::watch_cause`]).
    superseded: bool,
    /// Its cause is gone (request answered, agent working again or gone).
    resolved: bool,
    /// A routed test: every channel takes it, whatever its kinds.
    test: bool,
    /// Channels it went to, with the ntfy sequence it shows under.
    pushed: Vec<(String, String)>,
}

/// Per push channel, in memory.
struct ChanState {
    bucket: Bucket,
    backlog: Vec<(Message, String)>,
    dropped: usize,
    flushing: bool,
    /// ntfy: the notification each sequence shows now (a newer one of the agent replaced it).
    shows: HashMap<String, String>,
    last_test: Option<Instant>,
}

impl ChanState {
    fn new() -> ChanState {
        ChanState { bucket: Bucket::new(Instant::now()), backlog: Vec::new(), dropped: 0, flushing: false, shows: HashMap::new(), last_test: None }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The daemon's part (`daemon::async_main`): with a push channel on, the boards of the herdr
/// sessions this host knows (whose herdr server runs) come up at once, so their notifications are
/// pushed although no app connected since the daemon started.
pub fn start(daemon: &Arc<crate::daemon::Daemon>) {
    if !lock(&daemon.notify.inner.cfg).channels.iter().any(|c| c.enabled) {
        return;
    }
    let known: Vec<String> = daemon.persist.read(|p| p.sessions.keys().cloned().collect());
    let daemon = daemon.clone();
    tokio::spawn(async move {
        for session in known {
            let name = (session != "default").then_some(session.as_str());
            let running = match tf_herdr::HerdrClient::discover(name).await {
                Ok(h) => h.ping().await.is_ok(),
                Err(_) => false,
            };
            if !running {
                debug!(session, "push: herdr server not running; nothing to watch");
                continue;
            }
            match daemon.ctx_for(&session).await {
                Ok(_) => info!(session, "push: watching the session"),
                Err(e) => warn!(session, "push: cannot open the session: {}", e.message),
            }
        }
    });
}

/// Whether what `n` is about still holds (`agent`: its agent in host state now).
pub fn still_relevant(agent: Option<&Agent>, n: &Notification) -> bool {
    if n.agent_id.is_empty() {
        return true;
    }
    let Some(a) = agent else { return false };
    if a.archived || a.parked.is_some() {
        return false;
    }
    match n.kind {
        NotifyKind::Needs => match &n.request_id {
            Some(r) => a.needs.as_ref().and_then(|x| x.request_id.as_ref()) == Some(r),
            None => a.column == Column::Needs,
        },
        NotifyKind::Error => a.column != Column::Running,
        NotifyKind::Quiet => a.column == Column::Running,
        NotifyKind::Finished => matches!(a.column, Column::Review | Column::Done),
        NotifyKind::Info => true,
    }
}

impl Notifier {
    /// Loads `<home>/notify.json`; deliveries use the host's `curl`.
    pub fn load(home: &std::path::Path, cancel: CancellationToken) -> Notifier {
        let path = store::path(home);
        let cfg = store::load(&path);
        Notifier::with(path, cfg, push::curl(), crate::ops::host::hostname(), cancel)
    }

    pub fn with(path: PathBuf, cfg: NotifyFile, http: Http, host: String, cancel: CancellationToken) -> Notifier {
        Notifier {
            inner: Arc::new(Inner {
                path,
                cfg: Mutex::new(cfg),
                devices: Mutex::new(HashMap::new()),
                ledger: Mutex::new(Ledger::default()),
                chans: Mutex::new(HashMap::new()),
                http,
                host,
                cancel,
            }),
        }
    }

    // ───────────────────────────── devices ─────────────────────────────

    /// An app attached to `session` (after its snapshot): it gets that session's notifications.
    pub fn client_attached(&self, session: &str, client: &ClientHandle) {
        lock(&self.inner.devices).insert(client.id().to_string(), Device { client: client.clone(), session: session.to_string(), presence: None });
    }

    pub fn client_detached(&self, client_id: &str) {
        lock(&self.inner.devices).remove(client_id);
    }

    /// `presence` from an app.
    pub fn presence_changed(&self, client: &ClientHandle, presence: Presence) {
        if let Some(d) = lock(&self.inner.devices).get_mut(client.id()) {
            debug!(client = %client.id(), state = ?presence.state, device = ?presence.device, "presence");
            d.presence = Some(presence);
        }
    }

    /// What the apps of `session` say about their users (for features that act when nobody is
    /// around, e.g. automatic answers).
    pub fn presence(&self, session: &str) -> PresenceSummary {
        let devices = lock(&self.inner.devices);
        presence::summarize(devices.values().filter(|d| d.session == session && !d.client.is_closed()), now_ms())
    }

    pub fn any_app_connected(&self, session: &str) -> bool {
        self.presence(session).apps > 0
    }

    /// Open apps of `session`.
    fn clients_in(&self, session: &str) -> Vec<ClientHandle> {
        lock(&self.inner.devices).values().filter(|d| d.session == session && !d.client.is_closed()).map(|d| d.client.clone()).collect()
    }

    fn policy(&self) -> NotifyPolicy {
        lock(&self.inner.cfg).policy.clone()
    }

    // ───────────────────────────── routing ─────────────────────────────

    /// Routes a notification of `session` to its apps (`sinks`: the store's clients, which all got
    /// the snapshot already). Called with the store's lock held: sends and spawns, never waits.
    pub fn post(&self, state: &StateHandle, session: &str, sinks: &[ClientHandle], n: Notification, agent_name: Option<String>) {
        let escalatable = route::escalates(n.kind);
        self.post_with(state, session, sinks, n, agent_name, escalatable, false);
    }

    /// Returns the names of the devices that alert at once.
    #[allow(clippy::too_many_arguments)]
    fn post_with(&self, state: &StateHandle, session: &str, sinks: &[ClientHandle], n: Notification, agent_name: Option<String>, escalatable: bool, test: bool) -> Vec<String> {
        let policy = self.policy();
        let decision = {
            let devices = lock(&self.inner.devices);
            let cands: Vec<Candidate> = sinks
                .iter()
                .map(|c| Candidate { id: c.id(), capable: c.features().presence, presence: devices.get(c.id()).and_then(|d| d.presence.as_ref()) })
                .collect();
            route::route(&policy, escalatable, &cands)
        };
        let line = |alert| line_of(&ServerMsg::Notify { notification: n.clone(), alert });
        let (legacy, yes, no) = (line(None), line(Some(true)), line(Some(false)));
        let (mut alerted, mut names) = (Vec::new(), Vec::new());
        for c in sinks {
            // Older apps alert for every notification by themselves.
            let (l, alerting) = if !c.features().presence {
                (&legacy, true)
            } else if decision.alert.iter().any(|a| a == c.id()) {
                (&yes, true)
            } else {
                (&no, false)
            };
            if alerting {
                alerted.push(c.id().to_string());
                names.push(c.info().device.clone());
            }
            if let Some(l) = l {
                c.send_line(l.clone(), false);
            }
        }
        info!(session, agent = %n.agent_id, kind = ?n.kind, apps = sinks.len(), alerted = alerted.len(), escalate = decision.escalate_later, "notify: {}", n.title);

        let id = n.id.clone();
        {
            let mut l = lock(&self.inner.ledger);
            if !n.agent_id.is_empty() {
                for e in l.entries.values_mut().filter(|e| e.session == session && e.n.agent_id == n.agent_id) {
                    e.superseded = true;
                }
            }
            l.order.push_back(id.clone());
            l.entries.insert(
                id.clone(),
                Entry {
                    session: session.to_string(),
                    n,
                    agent_name,
                    alerted,
                    read_by: None,
                    escalated: false,
                    superseded: false,
                    resolved: false,
                    test,
                    pushed: Vec::new(),
                },
            );
            while l.order.len() > LEDGER_CAP {
                if let Some(old) = l.order.pop_front() {
                    l.entries.remove(&old);
                }
            }
        }
        if decision.escalate_later {
            let (me, st, eid) = (self.clone(), state.clone(), id.clone());
            let after = Duration::from_secs(u64::from(policy.escalate_after_s));
            tokio::spawn(async move {
                tokio::select! {
                    _ = tokio::time::sleep(after) => me.escalate(&st, &eid),
                    _ = me.inner.cancel.cancelled() => {}
                }
            });
        }
        let offline = sinks.is_empty();
        self.push_matching(state, &id, |when| match when {
            PushWhen::Always => Some(Reason::Always),
            PushWhen::Offline | PushWhen::Unseen if offline => Some(Reason::Offline),
            _ => None,
        });
        names
    }

    /// The escalation timer of `id` fired.
    fn escalate(&self, state: &StateHandle, id: &str) {
        let (session, n, alerted) = {
            let l = lock(&self.inner.ledger);
            match l.entries.get(id) {
                Some(e) if e.read_by.is_none() && !e.superseded && !e.escalated && !e.resolved => (e.session.clone(), e.n.clone(), e.alerted.clone()),
                _ => return,
            }
        };
        if !still_relevant(state.agent(&n.agent_id).as_ref(), &n) {
            if let Some(e) = lock(&self.inner.ledger).entries.get_mut(id) {
                e.resolved = true;
            }
            debug!(id, "escalation dropped: handled meanwhile");
            return;
        }
        let policy = self.policy();
        let (targets, names, any_app) = {
            let devices = lock(&self.inner.devices);
            let open: Vec<&Device> = devices.values().filter(|d| d.session == session && !d.client.is_closed()).collect();
            let cands: Vec<Candidate> = open.iter().map(|d| Candidate { id: d.client.id(), capable: d.capable(), presence: d.presence.as_ref() }).collect();
            let ids = route::escalation_targets(&policy, &cands, &alerted);
            let targets: Vec<ClientHandle> = open.iter().filter(|d| ids.iter().any(|i| i == d.client.id())).map(|d| d.client.clone()).collect();
            let names: Vec<String> = targets.iter().map(|c| c.info().device.clone()).collect();
            (targets, names, !open.is_empty())
        };
        if let Some(line) = line_of(&ServerMsg::NotifyAlert { id: id.to_string() }) {
            for c in &targets {
                c.send_line(line.clone(), false);
            }
        }
        if let Some(e) = lock(&self.inner.ledger).entries.get_mut(id) {
            e.escalated = true;
            e.alerted.extend(targets.iter().map(|c| c.id().to_string()));
        }
        info!(session, id, to = ?names, "notification unseen: escalated");
        self.push_matching(state, id, |when| match when {
            PushWhen::Unseen | PushWhen::Always => Some(Reason::Unseen),
            PushWhen::Offline if !any_app => Some(Reason::Offline),
            PushWhen::Offline => None,
        });
    }

    /// `notifyRead` from an app: stop escalating, retract everywhere else.
    pub fn notify_read(&self, client: &ClientHandle, ids: Vec<String>) {
        let by = client.info().device.clone();
        let Some(session) = lock(&self.inner.devices).get(client.id()).map(|d| d.session.clone()) else { return };
        let mut fresh = Vec::new();
        let mut retract = Vec::new();
        {
            let mut l = lock(&self.inner.ledger);
            for id in ids.into_iter().take(500) {
                let Some(e) = l.entries.get_mut(&id).filter(|e| e.session == session && e.read_by.is_none()) else { continue };
                e.read_by = Some(by.clone());
                if !e.pushed.is_empty() && !e.resolved {
                    retract.push(id.clone());
                }
                fresh.push(id);
            }
        }
        if fresh.is_empty() {
            return;
        }
        debug!(session, by, n = fresh.len(), "notifications read");
        if let Some(line) = line_of(&ServerMsg::NotifyDone { ids: fresh, by: Some(by.clone()) }) {
            for c in self.clients_in(&session).iter().filter(|c| c.id() != client.id() && c.features().presence) {
                c.send_line(line.clone(), false);
            }
        }
        for id in retract {
            self.retract(&id, "read", Some(by.clone()));
        }
    }

    // ───────────────────────────── push ─────────────────────────────

    /// Pushes entry `id` to every enabled channel whose `when` gives a reason (and takes its kind)
    /// and that did not get it yet.
    fn push_matching(&self, state: &StateHandle, id: &str, why: impl Fn(PushWhen) -> Option<Reason>) {
        let channels: Vec<StoredChannel> = lock(&self.inner.cfg).channels.iter().filter(|c| c.enabled).cloned().collect();
        if channels.is_empty() {
            return;
        }
        // Picked and marked under one lock: an escalation racing the post never pushes twice.
        let (msgs, seq, session, watch) = {
            let mut l = lock(&self.inner.ledger);
            let Some(e) = l.entries.get_mut(id) else { return };
            let msgs: Vec<(String, Message)> = channels
                .iter()
                .filter(|c| (e.test || c.kinds.contains(&e.n.kind)) && !e.pushed.iter().any(|(ch, _)| *ch == c.id))
                .filter_map(|c| why(c.when).map(|r| (c.id.clone(), Message::new(&e.n, e.agent_name.as_deref(), c.private, r))))
                .collect();
            let Some((_, first)) = msgs.first() else { return };
            let seq = first.seq(&e.session);
            let watch = e.pushed.is_empty() && !e.n.agent_id.is_empty();
            e.pushed.extend(msgs.iter().map(|(c, _)| (c.clone(), seq.clone())));
            (msgs, seq, e.session.clone(), watch)
        };
        for (ch, m) in msgs {
            let me = self.clone();
            let (session, seq) = (session.clone(), seq.clone());
            tokio::spawn(async move { me.deliver(&ch, m, session, seq).await });
        }
        if watch {
            let (me, st, eid) = (self.clone(), state.clone(), id.to_string());
            tokio::spawn(async move { me.watch_cause(&st, &eid).await });
        }
    }

    /// Follows a pushed notification until it is read or its cause is gone (answered elsewhere,
    /// the agent working again): then its pushed copies are retracted. A newer notification of the
    /// same agent does not end the watch: it replaces the older one in the apps, but a push channel
    /// that did not take it (an `unseen` channel while an app is connected) still shows the older.
    async fn watch_cause(&self, state: &StateHandle, id: &str) {
        let until = Instant::now() + WATCH_FOR;
        while Instant::now() < until {
            tokio::select! {
                _ = tokio::time::sleep(WATCH_EVERY) => {}
                _ = self.inner.cancel.cancelled() => return,
            }
            let n = {
                let l = lock(&self.inner.ledger);
                match l.entries.get(id) {
                    Some(e) if e.read_by.is_none() && !e.resolved => e.n.clone(),
                    _ => return,
                }
            };
            if !still_relevant(state.agent(&n.agent_id).as_ref(), &n) {
                if let Some(e) = lock(&self.inner.ledger).entries.get_mut(id) {
                    e.resolved = true;
                }
                self.retract(id, "answered", None);
                return;
            }
        }
    }

    /// Takes a pushed notification back where the service allows: ntfy clears it (when its
    /// sequence still shows it), a webhook gets `done`. Pushover cannot retract.
    fn retract(&self, id: &str, reason: &'static str, by: Option<String>) {
        let (session, pushed) = {
            let l = lock(&self.inner.ledger);
            let Some(e) = l.entries.get(id) else { return };
            (e.session.clone(), e.pushed.clone())
        };
        for (ch_id, seq) in pushed {
            let Some(ch) = lock(&self.inner.cfg).channels.iter().find(|c| c.id == ch_id && c.enabled).cloned() else { continue };
            let origin = Origin { host: self.inner.host.clone(), session: session.clone() };
            let req = match ch.kind {
                PushKind::Pushover => continue,
                PushKind::Ntfy => {
                    let mut chans = lock(&self.inner.chans);
                    let st = chans.entry(ch.id.clone()).or_insert_with(ChanState::new);
                    if st.shows.get(&seq).map(String::as_str) != Some(id) {
                        continue;
                    }
                    st.shows.remove(&seq);
                    push::ntfy_clear(&ch, &seq)
                }
                PushKind::Webhook => push::webhook(&ch, &origin, Event::Done { id, reason, by: by.as_deref() }, now_ms() / 1000, &new_id("d")),
            };
            let Ok(req) = req else { continue };
            let (http, name, secrets) = (self.inner.http.clone(), ch.name.clone(), ch.secrets());
            tokio::spawn(async move {
                match http(req).await {
                    Ok(r) if (200..300).contains(&r.status) => debug!(channel = %name, "push retracted"),
                    Ok(r) => debug!(channel = %name, status = r.status, "push retraction refused: {}", push::scrub(&r.body, &secrets)),
                    Err(e) => debug!(channel = %name, "push retraction failed: {}", push::scrub(&e, &secrets)),
                }
            });
        }
    }

    /// Sends `m` through channel `ch_id`, or queues it for a summary when the channel is over its
    /// rate limit.
    async fn deliver(&self, ch_id: &str, m: Message, session: String, seq: String) {
        let queued = {
            let mut chans = lock(&self.inner.chans);
            let st = chans.entry(ch_id.to_string()).or_insert_with(ChanState::new);
            if st.bucket.take(Instant::now()) {
                false
            } else {
                if st.backlog.len() < BACKLOG_CAP {
                    st.backlog.push((m.clone(), session.clone()));
                } else {
                    st.dropped += 1;
                }
                let start = !st.flushing;
                st.flushing = true;
                if start {
                    let (me, ch) = (self.clone(), ch_id.to_string());
                    tokio::spawn(async move { me.flush(&ch).await });
                }
                true
            }
        };
        if queued {
            debug!(channel = ch_id, "push rate-limited: queued for a summary");
            return;
        }
        let Some(ch) = lock(&self.inner.cfg).channels.iter().find(|c| c.id == ch_id && c.enabled).cloned() else { return };
        let origin = Origin { host: self.inner.host.clone(), session };
        let res = self.send(&ch, &origin, Single::One(&m, &seq)).await;
        self.record(&ch, res, false);
    }

    /// Sends a rate-limited channel's backlog as one summary whenever a token is free again.
    async fn flush(&self, ch_id: &str) {
        loop {
            let wait = {
                let mut chans = lock(&self.inner.chans);
                let Some(st) = chans.get_mut(ch_id) else { return };
                st.bucket.wait(Instant::now())
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.inner.cancel.cancelled() => return,
            }
            let (items, dropped) = {
                let mut chans = lock(&self.inner.chans);
                let Some(st) = chans.get_mut(ch_id) else { return };
                if !st.bucket.take(Instant::now()) {
                    continue;
                }
                if st.backlog.is_empty() {
                    st.flushing = false;
                    return;
                }
                let dropped = std::mem::take(&mut st.dropped);
                (std::mem::take(&mut st.backlog), dropped)
            };
            let Some(ch) = lock(&self.inner.cfg).channels.iter().find(|c| c.id == ch_id && c.enabled).cloned() else { return };
            let session = items.last().map(|(_, s)| s.clone()).unwrap_or_default();
            let origin = Origin { host: self.inner.host.clone(), session };
            let msgs: Vec<Message> = items.into_iter().map(|(m, _)| m).collect();
            let res = self.send(&ch, &origin, Single::Many(&msgs, dropped)).await;
            self.record(&ch, res, false);
        }
    }

    async fn send(&self, ch: &StoredChannel, origin: &Origin, what: Single<'_>) -> PushResult {
        let delivery = new_id("d");
        let req = match (ch.kind, what) {
            (PushKind::Ntfy, Single::One(m, _)) => push::ntfy_publish(ch, origin, m),
            (PushKind::Ntfy, Single::Many(ms, dropped)) => push::ntfy_publish(ch, origin, &push::summary(ms, dropped)),
            (PushKind::Pushover, Single::One(m, _)) => push::pushover(ch, origin, m),
            (PushKind::Pushover, Single::Many(ms, dropped)) => push::pushover(ch, origin, &push::summary(ms, dropped)),
            (PushKind::Webhook, Single::One(m, _)) => push::webhook(ch, origin, Event::Notification(m), now_ms() / 1000, &delivery),
            (PushKind::Webhook, Single::Many(ms, _)) => push::webhook(ch, origin, Event::Batch(ms), now_ms() / 1000, &delivery),
        };
        let secrets = ch.secrets();
        let fail = |status, error: String| PushResult { at: now_ms(), ok: false, status, error: Some(push::scrub(&error, &secrets)), test: false };
        let req = match req {
            Ok(r) => r,
            Err(e) => return fail(None, e),
        };
        match (self.inner.http)(req).await {
            Ok(r) if (200..300).contains(&r.status) => {
                if let (PushKind::Ntfy, Single::One(m, seq)) = (ch.kind, what)
                    && m.reason != Reason::Test
                {
                    lock(&self.inner.chans).entry(ch.id.clone()).or_insert_with(ChanState::new).shows.insert(seq.to_string(), m.id.clone());
                }
                PushResult { at: now_ms(), ok: true, status: Some(r.status), error: None, test: false }
            }
            Ok(r) => fail(Some(r.status), if r.body.trim().is_empty() { format!("HTTP {}", r.status) } else { r.body }),
            Err(e) => fail(None, e),
        }
    }

    /// Stores a delivery's outcome as the channel's `last` (and logs it without details).
    fn record(&self, ch: &StoredChannel, mut res: PushResult, test: bool) -> PushResult {
        res.test = test;
        if res.ok {
            info!(channel = %ch.name, kind = ?ch.kind, test, "pushed");
        } else {
            warn!(channel = %ch.name, kind = ?ch.kind, test, status = ?res.status, "push failed: {}", res.error.as_deref().unwrap_or_default());
        }
        let mut cfg = lock(&self.inner.cfg);
        if let Some(c) = cfg.channels.iter_mut().find(|c| c.id == ch.id) {
            c.last = Some(res.clone());
            if let Err(e) = store::save(&self.inner.path, &cfg) {
                warn!("{e}");
            }
        }
        res
    }

    // ───────────────────────────── notify.* ─────────────────────────────

    pub fn config(&self, session: &str, me: &str) -> NotifyConfig {
        let (policy, channels) = {
            let cfg = lock(&self.inner.cfg);
            (cfg.policy.clone(), cfg.channels.iter().map(StoredChannel::view).collect())
        };
        let devices = lock(&self.inner.devices);
        let mut list: Vec<(&String, &Device)> = devices.iter().filter(|(_, d)| d.session == session && !d.client.is_closed()).collect();
        list.sort_by(|a, b| a.0.cmp(b.0));
        NotifyConfig { policy, channels, devices: list.into_iter().map(|(id, d)| d.view(id == me)).collect() }
    }

    fn change(&self, f: impl FnOnce(&mut NotifyFile) -> Result<(), ApiError>) -> Result<(), ApiError> {
        let mut cfg = lock(&self.inner.cfg);
        let mut next = cfg.clone();
        f(&mut next)?;
        store::save(&self.inner.path, &next)?;
        *cfg = next;
        Ok(())
    }

    pub fn set_policy(&self, p: NotifyPolicy) -> Result<(), ApiError> {
        store::validate_policy(&p)?;
        self.change(|f| {
            f.policy = p;
            Ok(())
        })?;
        info!(policy = ?self.policy(), "notification policy changed");
        Ok(())
    }

    pub fn save_channel(&self, s: PushChannelSave) -> Result<String, ApiError> {
        let mut id = String::new();
        self.change(|f| {
            id = store::save_channel(&mut f.channels, s, || new_id("pc"))?;
            Ok(())
        })?;
        info!(channel = %id, "push channel saved");
        Ok(id)
    }

    pub fn remove_channel(&self, id: &str) -> Result<(), ApiError> {
        self.change(|f| {
            let before = f.channels.len();
            f.channels.retain(|c| c.id != id);
            if f.channels.len() == before {
                return Err(ApiError::new("not_found", format!("no push channel `{id}`")));
            }
            Ok(())
        })?;
        lock(&self.inner.chans).remove(id);
        info!(channel = %id, "push channel removed");
        Ok(())
    }

    /// `notify.test`: a test push through one channel, or a test notification routed like a real
    /// one (to the apps of `session`).
    pub async fn test(&self, state: &StateHandle, session: &str, p: NotifyTestParams) -> Result<NotifyTestResult, ApiError> {
        let host = self.inner.host.clone();
        let Some(ch_id) = p.channel_id else {
            let n = Notification {
                id: new_id("n"),
                at: now_ms(),
                kind: NotifyKind::Info,
                agent_id: String::new(),
                title: format!("Test from {host}"),
                body: "Routing works: this alert went to the device you are using.".into(),
                request_id: None,
                actions: Vec::new(),
            };
            let sinks = self.clients_in(session);
            let alerted = self.post_with(state, session, &sinks, n, None, p.escalate, true);
            return Ok(NotifyTestResult { push: None, alerted });
        };
        let ch = lock(&self.inner.cfg).channels.iter().find(|c| c.id == ch_id).cloned().ok_or_else(|| ApiError::new("not_found", format!("no push channel `{ch_id}`")))?;
        {
            let mut chans = lock(&self.inner.chans);
            let st = chans.entry(ch.id.clone()).or_insert_with(ChanState::new);
            if st.last_test.is_some_and(|t| t.elapsed() < TEST_EVERY) {
                return Err(ApiError::new("busy", "a test just went out; try again in a few seconds").retryable());
            }
            st.last_test = Some(Instant::now());
        }
        let n = Notification {
            id: new_id("t"),
            at: now_ms(),
            kind: NotifyKind::Info,
            agent_id: String::new(),
            title: "TeleFlock test".into(),
            body: format!("Push notifications from {host} work."),
            request_id: None,
            actions: Vec::new(),
        };
        let m = Message::new(&n, None, false, Reason::Test);
        let origin = Origin { host, session: session.to_string() };
        let res = self.send(&ch, &origin, Single::One(&m, "")).await;
        Ok(NotifyTestResult { push: Some(self.record(&ch, res, true)), alerted: Vec::new() })
    }
}

/// One message or a summary of several (with how many more were dropped).
#[derive(Clone, Copy)]
enum Single<'a> {
    One(&'a Message, &'a str),
    Many(&'a [Message], usize),
}

#[cfg(test)]
mod tests;
