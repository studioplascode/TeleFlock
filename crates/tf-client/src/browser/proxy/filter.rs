//! The JSON-RPC filter of one agent's DevTools connection: what passes from the agent to the
//! browser and back, decided per message against the [`Registry`]. Pure (no IO): the
//! connection's task (`session.rs`) feeds it messages and sends what it returns.
//!
//! Every agent connection has its own WebSocket to the browser target (or to one of its pages
//! for `/devtools/page/<id>`); flat sessions (`sessionId`) live on that connection only.
//! * Targets: the agent sees its own tabs and pages (and the frames and workers it attached
//!   under them) and its own browser target, nothing else: target lists, `targetCreated`/
//!   `targetInfoChanged`/`targetDestroyed` and auto-attach are filtered; commands naming another
//!   target answer as Chrome does for a target that does not exist. Auto-attached targets that
//!   are not the agent's are released at once (`Runtime.runIfWaitingForDebugger`, then detached),
//!   so `waitForDebuggerOnStart` never pauses the user's or another agent's new tab. A tab whose
//!   page is not known yet is held back (paused) until it is, at most [`HOLD_MAX`].
//! * Sessions: messages tagged with a session the agent does not have are dropped; commands on
//!   such a session answer `Session with given id not found.`.
//! * Commands that would hurt the user or the other agents are refused (`policy`); on the browser
//!   target only browser-level commands an agent needs pass (targets, versions, cookies, windows
//!   of its own tabs, probes).
//! * Take over: the agent's sessions on that tab are detached from the browser, but the agent
//!   keeps them: every command on them answers [`TAKEN_OVER`]. Hand back tells the agent they
//!   ended and attaches the tab afresh. A lent tab appears to the agent (attached when its
//!   auto-attach is on, announced when its discovery is on).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tf_proto::Millis;

use super::AttachKey;
use super::registry::{Registry, Vis};

/// How long a target may stay undecided before it counts as not the agent's (and is released).
pub(super) const HOLD_MAX: Duration = Duration::from_secs(3);
/// How long a target released undecided may still turn out to be the agent's (it is attached or
/// announced then).
const LATE_MAX: Duration = Duration::from_secs(30);

/// The error of every command on a tab the user took over.
pub(super) const TAKEN_OVER: &str = "the user took over this tab";

const SHARED: &str = "this browser is shared with the user and other agents";
const LOCAL_FILES: &str = "agents cannot read files on the user's device";
const WHOLE_BROWSER: &str = "it would give a page the whole browser";
const FLAT_ONLY: &str = "only flat sessions (flatten: true) are supported";
const TAB_ONLY: &str = "agents send it to their own tabs, not to the whole browser";
const OWN_CONTEXT: &str = "it only works in a browser context the agent created (the user's profile is shared)";
const WEB_ONLY: &str = "agents may only open web pages (http, https, data, blob, about:blank)";

/// What the filter sends.
#[derive(Debug, PartialEq)]
pub(super) enum Out {
    /// To the agent.
    Agent(String),
    /// To the browser.
    Browser(String),
    /// Ends the connection (a page connection whose page the user took over).
    Close(String),
}

/// What the connection is attached to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Root {
    /// The browser target (`/devtools/browser/…`).
    Browser,
    /// One of the agent's pages (`/devtools/page/<id>`).
    Page(String),
}

/// A flat session the agent holds.
#[derive(Clone, Debug)]
struct Sess {
    target: String,
    kind: String,
    /// The session it was attached through (`None`: the connection itself).
    parent: Option<String>,
    /// The tab or page it belongs to (ownership is decided by it); for browser sessions the
    /// browser target.
    top: String,
}

/// A target that is not decided yet, with the messages about it the agent may get.
struct Held {
    target: String,
    info: Value,
    msgs: Vec<String>,
    attach: Option<HeldAttach>,
    since: Instant,
}

struct HeldAttach {
    session: String,
    parent: Option<String>,
    kind: String,
    waiting: bool,
}

/// Agent commands whose answers the filter reads.
enum Pending {
    GetTargets,
    CreateTarget,
    CreateContext,
    GetContexts,
    DisposeContext(String),
    WindowFor,
    AutoAttach { session: Option<String>, on: bool, filter: Option<Value> },
    Discover { session: Option<String>, on: bool, filter: Option<Value> },
    AttachBrowser,
}

/// The filter's own commands (negative ids).
enum Internal {
    OwnBrowser,
    Attach(String),
    /// Hand back: the tab's page attached again under the agent's kept tab session.
    Swap(String),
    Ignore,
}

/// Where a command goes.
enum Ctx {
    /// The browser target: the connection, or a session attached to a browser target.
    Browser,
    /// A tab or page of the agent (or a frame or worker under one): its top target.
    Tab(String),
}

enum Policy {
    Allow,
    Refuse(&'static str),
    /// Only with a `browserContextId` the agent created.
    OwnContext,
}

#[derive(Deserialize)]
struct Env<'a> {
    id: Option<i64>,
    #[serde(borrow)]
    method: Option<Cow<'a, str>>,
    #[serde(borrow, rename = "sessionId")]
    session_id: Option<Cow<'a, str>>,
}

pub(super) struct Filter {
    who: AttachKey,
    conn: u64,
    root: Root,
    /// A page connection whose page the user took over.
    root_dead: bool,
    /// The connection's browser target.
    own_browser: Option<String>,
    sessions: HashMap<String, Sess>,
    /// Sessions on tabs the user took over: detached from the browser, still held by the agent,
    /// except `suspended` ones.
    dead: HashMap<String, Sess>,
    /// Tab-level sessions kept attached in the browser while the user has the tab (Puppeteer
    /// closes the page for good when its tab's session ends): their messages stay here.
    suspended: HashSet<String>,
    /// Kept tab sessions being handed back, with the page attached again under each.
    reviving: HashMap<String, String>,
    /// Sessions the filter is releasing (not the agent's): their messages are dropped.
    releasing: HashSet<String>,
    held: Vec<Held>,
    pending: HashMap<(Option<String>, i64), Pending>,
    internal: HashMap<i64, Internal>,
    next_internal: i64,
    /// Browser-target attaches the agent asked for and Chrome has not reported yet.
    expect_browser: u32,
    /// Browser-level sessions (`None`: the connection) with auto-attach on, and their filters.
    auto: HashMap<Option<String>, Option<Value>>,
    /// Browser-level sessions with target discovery on, and their filters.
    discover: HashMap<Option<String>, Option<Value>>,
    /// Lent pages the connection's auto-attach covered, and its discovery.
    auto_known: HashSet<String>,
    disc_known: HashSet<String>,
    /// Targets the agent was told about.
    seen: HashSet<String>,
    /// Tabs and pages the filter is attaching for the agent.
    attaching: HashSet<String>,
    /// Targets released or dropped undecided (`HOLD_MAX`), with how the agent would have met
    /// them: an attach through a session (`None`: the connection) or an announcement.
    late: HashMap<String, (Option<Option<String>>, Instant)>,
}

fn st<'a>(v: &'a Value, pointer: &str) -> Option<&'a str> {
    v.pointer(pointer).and_then(Value::as_str)
}

fn error(id: &Value, session: Option<&str>, code: i64, message: &str) -> Out {
    let mut m = json!({ "id": id, "error": { "code": code, "message": message } });
    if let Some(s) = session {
        m["sessionId"] = json!(s);
    }
    Out::Agent(m.to_string())
}

fn refused(method: &str, why: &str) -> (i64, String) {
    (-32000, format!("TeleFlock refused `{method}`: {why}"))
}

/// Whether a `TargetFilter` (absent: Chrome's default, everything but the browser and tabs)
/// includes targets of type `kind`.
pub(super) fn filter_includes(filter: Option<&Value>, kind: &str) -> bool {
    let default = json!([{ "type": "browser", "exclude": true }, { "type": "tab", "exclude": true }, {}]);
    let entries = filter.and_then(Value::as_array).or(default.as_array()).cloned().unwrap_or_default();
    for e in entries {
        match e.get("type").and_then(Value::as_str) {
            Some(t) if t != kind => continue,
            _ => return !e.get("exclude").and_then(Value::as_bool).unwrap_or(false),
        }
    }
    false
}

/// Whether an agent may open `url` (`Target.createTarget`, `Page.navigate`, `/json/new`): web
/// pages only, never the browser's own pages (`chrome:`, `about:settings`, DevTools), extensions
/// or the device's files.
pub(super) fn url_allowed(url: &str) -> bool {
    let u = url.trim_matches(|c: char| c.is_ascii_whitespace() || c.is_ascii_control());
    if u.is_empty() {
        return true;
    }
    let Some((scheme, rest)) = u.split_once(':') else { return false };
    match scheme.to_ascii_lowercase().as_str() {
        "http" | "https" | "data" | "javascript" => true,
        "blob" => rest.split_once(':').is_some_and(|(inner, _)| matches!(inner.to_ascii_lowercase().as_str(), "http" | "https")),
        "about" => {
            let r = rest.to_ascii_lowercase();
            r == "blank" || r.starts_with("blank#") || r.starts_with("blank?") || r == "srcdoc"
        }
        _ => false,
    }
}

/// What an agent may send (`browser_level`: to the browser target rather than one of its tabs).
fn policy(method: &str, browser_level: bool, params: &Value) -> Policy {
    let Some((domain, name)) = method.split_once('.') else { return Policy::Allow };
    let p = match domain {
        "Browser" => match name {
            "getVersion" | "getBrowserCommandLine" | "getHistograms" | "getHistogram" | "getWindowForTarget"
            | "getWindowBounds" | "setWindowBounds" | "setContentsSize" => Policy::Allow,
            "setDownloadBehavior" | "grantPermissions" | "setPermission" | "resetPermissions" | "cancelDownload" => {
                Policy::OwnContext
            }
            _ => Policy::Refuse(SHARED),
        },
        "Target" => match name {
            "setDiscoverTargets" | "setAutoAttach" | "autoAttachRelated" | "getTargets" | "getTargetInfo"
            | "attachToTarget" | "attachToBrowserTarget" | "detachFromTarget" | "activateTarget" | "closeTarget"
            | "createTarget" | "createBrowserContext" | "getBrowserContexts" | "disposeBrowserContext"
            | "openDevTools" => Policy::Allow,
            "exposeDevToolsProtocol" => Policy::Refuse(WHOLE_BROWSER),
            "sendMessageToTarget" => Policy::Refuse(FLAT_ONLY),
            _ => Policy::Refuse(SHARED),
        },
        "Storage" => match name {
            "clearCookies" | "clearDataForOrigin" | "clearDataForStorageKey" | "clearSharedStorageEntries"
            | "clearTrustTokens" | "deleteStorageBucket" | "resetSharedStorageBudget" | "runBounceTrackingMitigations" => {
                Policy::Refuse(SHARED)
            }
            _ => Policy::Allow,
        },
        "Network" => match name {
            "clearBrowserCookies" | "clearBrowserCache" | "setCookieControls" => Policy::Refuse(SHARED),
            "loadNetworkResource" => Policy::Refuse(LOCAL_FILES),
            _ => Policy::Allow,
        },
        "Page" if name == "setDownloadBehavior" => Policy::Refuse(SHARED),
        "DOM" if name == "setFileInputFiles" => Policy::Refuse(LOCAL_FILES),
        "Input"
            if name == "dispatchDragEvent"
                && params.pointer("/data/files").and_then(Value::as_array).is_some_and(|f| !f.is_empty()) =>
        {
            Policy::Refuse(LOCAL_FILES)
        }
        "CacheStorage" if name == "deleteCache" => Policy::Refuse(SHARED),
        "IndexedDB" if name == "deleteDatabase" || name == "clearObjectStore" => Policy::Refuse(SHARED),
        "DOMStorage" if name == "clear" => Policy::Refuse(SHARED),
        "Memory" if name == "simulatePressureNotification" || name == "setPressureNotificationsSuppressed" => {
            Policy::Refuse(SHARED)
        }
        "ServiceWorker" if name != "enable" && name != "disable" => Policy::Refuse(SHARED),
        "Tethering" | "Extensions" | "PWA" | "Tracing" | "Cast" => Policy::Refuse(SHARED),
        _ => Policy::Allow,
    };
    let browser_domain = matches!(domain, "Target" | "Browser" | "SystemInfo" | "Schema" | "IO" | "Storage");
    if browser_level && matches!(p, Policy::Allow) && !browser_domain && method != "Runtime.runIfWaitingForDebugger" {
        return Policy::Refuse(TAB_ONLY);
    }
    p
}

impl Filter {
    pub fn new(who: AttachKey, conn: u64, root: Root) -> Filter {
        Filter {
            who,
            conn,
            root,
            root_dead: false,
            own_browser: None,
            sessions: HashMap::new(),
            dead: HashMap::new(),
            suspended: HashSet::new(),
            reviving: HashMap::new(),
            releasing: HashSet::new(),
            held: Vec::new(),
            pending: HashMap::new(),
            internal: HashMap::new(),
            next_internal: 0,
            expect_browser: 0,
            auto: HashMap::new(),
            discover: HashMap::new(),
            auto_known: HashSet::new(),
            disc_known: HashSet::new(),
            seen: HashSet::new(),
            attaching: HashSet::new(),
            late: HashMap::new(),
        }
    }

    /// The filter's first commands, before the agent's: the connection's own browser target.
    pub fn start(&mut self) -> Vec<Out> {
        match self.root {
            Root::Browser => vec![self.internal_cmd(Internal::OwnBrowser, "Target.getTargetInfo", json!({}), None)],
            Root::Page(_) => Vec::new(),
        }
    }

    /// When the oldest undecided target must be decided.
    pub fn deadline(&self) -> Option<Instant> {
        self.held.iter().map(|h| h.since + HOLD_MAX).min()
    }

    fn internal_cmd(&mut self, kind: Internal, method: &str, params: Value, session: Option<&str>) -> Out {
        if self.next_internal <= i64::from(i32::MIN) + 1 {
            self.next_internal = 0;
        }
        self.next_internal -= 1;
        let id = self.next_internal;
        self.internal.insert(id, kind);
        let mut m = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            m["sessionId"] = json!(s);
        }
        Out::Browser(m.to_string())
    }

    // ───────────────────────────── agent → browser ─────────────────────────────

    /// A message from the agent.
    pub fn on_agent(&mut self, reg: &mut Registry, text: &str, now: Millis) -> Vec<Out> {
        let Ok(Value::Object(msg)) = serde_json::from_str::<Value>(text) else {
            return vec![Out::Agent(json!({ "error": { "code": -32700, "message": "Message must be a valid JSON" } }).to_string())];
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let Some(n) = id.as_i64().filter(|n| (0..=i64::from(i32::MAX)).contains(n)) else {
            let e = json!({ "error": { "code": -32600, "message": "Message must have a non-negative integer 'id' property" } });
            return vec![Out::Agent(e.to_string())];
        };
        let session = msg.get("sessionId").and_then(Value::as_str).map(String::from);
        let sid = session.as_deref();
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            return vec![error(&id, sid, -32600, "Message must have string 'method' property")];
        };
        let ctx = match sid {
            None => match &self.root {
                Root::Browser => Ctx::Browser,
                Root::Page(_) if self.root_dead => return vec![error(&id, None, -32000, TAKEN_OVER)],
                Root::Page(p) => Ctx::Tab(p.clone()),
            },
            Some(s) if self.dead.contains_key(s) => return vec![error(&id, sid, -32000, TAKEN_OVER)],
            Some(s) => match self.sessions.get(s) {
                Some(x) if x.kind == "browser" => Ctx::Browser,
                Some(x) => Ctx::Tab(x.top.clone()),
                None => return vec![error(&id, None, -32001, "Session with given id not found.")],
            },
        };
        let mut out = Vec::new();
        // A take over the connection has not caught up with yet counts at once (a tab that is
        // gone is left to the browser to answer for).
        if let Ctx::Tab(top) = &ctx
            && let Some(how) = reg.lost(&self.who, top)
        {
            if let Root::Page(_) = self.root {
                self.root_dead = true;
                out.push(error(&id, sid, -32000, TAKEN_OVER));
                out.push(Out::Close(TAKEN_OVER.into()));
                return out;
            }
            if how == Vis::TakenOver {
                self.kill(top, &mut out);
                out.push(error(&id, sid, -32000, TAKEN_OVER));
            } else {
                self.end(reg, top, &mut out);
                out.push(error(&id, None, -32001, "Session with given id not found."));
            }
            return out;
        }
        let empty = json!({});
        let params = msg.get("params").unwrap_or(&empty);
        match self.plan(reg, method, &ctx, params, sid) {
            Err((code, message)) => out.push(error(&id, sid, code, &message)),
            Ok(Plan::Local(before)) => {
                out.extend(before);
                let mut m = json!({ "id": id, "result": {} });
                if let Some(s) = sid {
                    m["sessionId"] = json!(s);
                }
                out.push(Out::Agent(m.to_string()));
            }
            Ok(Plan::Pass { pending, params: new_params }) => {
                let page = match &ctx {
                    Ctx::Tab(top) => Some(reg.page_of(top).to_string()),
                    Ctx::Browser => params.get("targetId").and_then(Value::as_str).map(|t| reg.page_of(t).to_string()),
                };
                reg.touch(&self.who, page.as_deref(), now);
                if let Some(p) = pending {
                    self.pending.insert((session.clone(), n), p);
                }
                match new_params {
                    Some(p) => {
                        let mut m = Value::Object(msg);
                        m["params"] = p;
                        out.push(Out::Browser(m.to_string()));
                    }
                    None => out.push(Out::Browser(text.to_string())),
                }
            }
        }
        out
    }

    /// What the connection knows of a target a command names.
    fn target_vis(&self, reg: &Registry, id: &str) -> Vis {
        if self.own_browser.as_deref() == Some(id) {
            return Vis::Mine;
        }
        if self.sessions.values().any(|s| s.target == id && !matches!(s.kind.as_str(), "tab" | "page" | "browser")) {
            return Vis::Mine;
        }
        reg.id_vis(&self.who, id)
    }

    fn plan(&mut self, reg: &mut Registry, method: &str, ctx: &Ctx, params: &Value, sid: Option<&str>) -> Result<Plan, (i64, String)> {
        let browser_level = matches!(ctx, Ctx::Browser);
        let context = params.get("browserContextId").and_then(Value::as_str);
        match policy(method, browser_level, params) {
            Policy::Refuse(why) => return Err(refused(method, why)),
            Policy::OwnContext if !context.is_some_and(|c| reg.context_owner(c) == Some(&self.who)) => {
                return Err(refused(method, OWN_CONTEXT));
            }
            _ => {}
        }
        if let Some(t) = params.get("targetId").and_then(Value::as_str) {
            match self.target_vis(reg, t) {
                Vis::Mine => {}
                Vis::TakenOver => return Err((-32000, TAKEN_OVER.into())),
                _ => return Err((-32602, "No target with given id found".into())),
            }
        }
        if let Some(c) = context
            && reg.context_owner(c).is_some_and(|o| *o != self.who)
        {
            return Err((-32000, format!("Failed to find browser context with id {c}")));
        }
        if let Some(w) = params.get("windowId").and_then(Value::as_i64)
            && !reg.own_window(&self.who, w)
        {
            return Err((-32000, "Browser window not found".into()));
        }
        if matches!(method, "Target.createTarget" | "Page.navigate")
            && !params.get("url").and_then(Value::as_str).is_none_or(url_allowed)
        {
            return Err(refused(method, WEB_ONLY));
        }
        let flat = params.get("flatten").and_then(Value::as_bool) == Some(true);
        let session = sid.map(String::from);
        let pending = match method {
            "Target.setAutoAttach" if !flat => return Err(refused(method, FLAT_ONLY)),
            "Target.setAutoAttach" if browser_level => Some(Pending::AutoAttach {
                session,
                on: params.get("autoAttach").and_then(Value::as_bool).unwrap_or(false),
                filter: params.get("filter").cloned(),
            }),
            "Target.setDiscoverTargets" if browser_level => Some(Pending::Discover {
                session,
                on: params.get("discover").and_then(Value::as_bool).unwrap_or(false),
                filter: params.get("filter").cloned(),
            }),
            "Target.attachToTarget" if !flat => return Err(refused(method, FLAT_ONLY)),
            "Target.attachToTarget" if params.get("targetId").and_then(Value::as_str) == self.own_browser.as_deref() => {
                self.expect_browser += 1;
                Some(Pending::AttachBrowser)
            }
            "Target.activateTarget" | "Target.closeTarget" | "Target.openDevTools"
                if params.get("targetId").and_then(Value::as_str) == self.own_browser.as_deref() =>
            {
                return Err((-32602, "No target with given id found".into()));
            }
            "Target.attachToBrowserTarget" => {
                self.expect_browser += 1;
                Some(Pending::AttachBrowser)
            }
            "Target.getTargets" => Some(Pending::GetTargets),
            "Target.createTarget" => {
                reg.creating(self.conn);
                // Agents' tabs open in windows of their own: in a background tab a headless
                // page paints no frames, and in a window the user sees they do not fight over
                // the active tab.
                let mut p = params.clone();
                p["newWindow"] = json!(true);
                return Ok(Plan::Pass { pending: Some(Pending::CreateTarget), params: Some(p) });
            }
            "Target.createBrowserContext" => Some(Pending::CreateContext),
            "Target.getBrowserContexts" => Some(Pending::GetContexts),
            "Target.disposeBrowserContext" => match context {
                Some(c) if reg.context_owner(c) == Some(&self.who) => Some(Pending::DisposeContext(c.to_string())),
                _ => return Err(refused(method, OWN_CONTEXT)),
            },
            "Target.detachFromTarget" => match params.get("sessionId").and_then(Value::as_str) {
                Some(s) if self.dead.contains_key(s) => {
                    // A session on a tab the user has: the browser detached it at the take over,
                    // except a kept tab session, detached now. The agent hears them end.
                    let mut before = Vec::new();
                    self.drop_dead(s, &mut before);
                    return Ok(Plan::Local(before));
                }
                Some(s) if !self.sessions.contains_key(s) => return Err((-32602, "No session with given id".into())),
                _ => None,
            },
            "Browser.getWindowForTarget" => Some(Pending::WindowFor),
            _ => None,
        };
        Ok(Plan::Pass { pending, params: None })
    }

    // ───────────────────────────── browser → agent ─────────────────────────────

    /// A message from the browser.
    pub fn on_browser(&mut self, reg: &mut Registry, text: &str, now: Instant) -> Vec<Out> {
        let mut out = Vec::new();
        let Ok(env) = serde_json::from_str::<Env>(text) else { return out };
        let session = env.session_id.map(Cow::into_owned);
        if let Some(id) = env.id {
            if id < 0 {
                self.internal_answer(text, id, &mut out);
            } else if let Some(s) = session.as_deref()
                && self.dead.contains_key(s)
            {
                self.pending.remove(&(session.clone(), id));
                out.push(error(&json!(id), Some(s), -32000, TAKEN_OVER));
            } else if let Some(p) = self.pending.remove(&(session, id)) {
                self.answer(reg, p, text, now, &mut out);
            } else {
                out.push(Out::Agent(text.to_string()));
            }
        } else if let Some(method) = env.method {
            match session.as_deref() {
                Some(s) => {
                    if self.suspended.contains(s) {
                        // A tab the user has: the page handed back is the agent's again; any
                        // other target attached under the tab meanwhile is let go.
                        if method == "Target.attachedToTarget" {
                            self.suspended_attach(reg, s, text, &mut out);
                        }
                    } else if self.releasing.contains(s) || self.dead.contains_key(s) {
                        // Not the agent's view.
                    } else if let Some(h) = self.held.iter_mut().find(|h| h.attach.as_ref().is_some_and(|a| a.session == s)) {
                        h.msgs.push(text.to_string());
                    } else if let Some(x) = self.sessions.get(s) {
                        if method.starts_with("Target.") {
                            let browser_level = x.kind == "browser";
                            self.target_event(reg, Some(s), browser_level, &method, text, now, &mut out);
                        } else {
                            out.push(Out::Agent(text.to_string()));
                        }
                    }
                }
                None if self.root_dead => {}
                None => {
                    if method.starts_with("Target.") {
                        let browser_level = self.root == Root::Browser;
                        self.target_event(reg, None, browser_level, &method, text, now, &mut out);
                    } else {
                        out.push(Out::Agent(text.to_string()));
                    }
                }
            }
        }
        self.settle(reg, now, &mut out);
        out
    }

    fn internal_answer(&mut self, text: &str, id: i64, out: &mut Vec<Out>) {
        match self.internal.remove(&id) {
            Some(Internal::OwnBrowser) => {
                if let Ok(v) = serde_json::from_str::<Value>(text) {
                    self.own_browser = st(&v, "/result/targetInfo/targetId").map(String::from);
                }
            }
            Some(Internal::Attach(t)) => {
                self.attaching.remove(&t);
            }
            Some(Internal::Swap(tab)) => {
                let failed = serde_json::from_str::<Value>(text).ok().is_none_or(|v| v.get("error").is_some());
                if failed && self.reviving.remove(&tab).is_some() {
                    self.swap_failed(&tab, out);
                }
            }
            Some(Internal::Ignore) | None => {}
        }
    }

    fn answer(&mut self, reg: &mut Registry, p: Pending, text: &str, now: Instant, out: &mut Vec<Out>) {
        let Ok(mut v) = serde_json::from_str::<Value>(text) else {
            out.push(Out::Agent(text.to_string()));
            return;
        };
        let ok = v.get("result").is_some();
        match p {
            Pending::GetTargets => {
                if let Some(list) = v.pointer_mut("/result/targetInfos").and_then(Value::as_array_mut) {
                    list.retain(|i| self.shown_vis(reg, i) == Vis::Mine);
                    for i in list.iter() {
                        if let Some(id) = i.get("targetId").and_then(Value::as_str) {
                            self.seen.insert(id.to_string());
                        }
                    }
                }
                out.push(Out::Agent(v.to_string()));
                return;
            }
            Pending::CreateTarget => {
                reg.created(self.conn);
                if let Some(page) = st(&v, "/result/targetId") {
                    reg.opened(&self.who, page);
                    self.auto_known.insert(page.to_string());
                    self.disc_known.insert(page.to_string());
                }
                // Its tab, held back until now, reaches the agent before the answer (as Chrome
                // sends them).
                self.settle(reg, now, out);
            }
            Pending::CreateContext => {
                if let Some(c) = st(&v, "/result/browserContextId") {
                    reg.context_created(&self.who, c);
                }
            }
            Pending::GetContexts => {
                if let Some(list) = v.pointer_mut("/result/browserContextIds").and_then(Value::as_array_mut) {
                    list.retain(|c| c.as_str().and_then(|c| reg.context_owner(c)) == Some(&self.who));
                }
                out.push(Out::Agent(v.to_string()));
                return;
            }
            Pending::DisposeContext(c) => {
                if ok {
                    reg.context_disposed(&c);
                }
            }
            Pending::WindowFor => {
                if let Some(w) = v.pointer("/result/windowId").and_then(Value::as_i64) {
                    reg.window_of(&self.who, w);
                }
            }
            Pending::AutoAttach { session, on, filter } => {
                if ok {
                    if on {
                        if session.is_none() {
                            // Chrome attached every tab there was before answering.
                            self.auto_known.extend(reg.lent_to(&self.who));
                        }
                        self.auto.insert(session, filter);
                    } else {
                        self.auto.remove(&session);
                    }
                }
            }
            Pending::Discover { session, on, filter } => {
                if ok {
                    if on {
                        if session.is_none() {
                            self.disc_known.extend(reg.lent_to(&self.who));
                        }
                        self.discover.insert(session, filter);
                    } else {
                        self.discover.remove(&session);
                    }
                }
            }
            Pending::AttachBrowser => {
                if !ok {
                    self.expect_browser = self.expect_browser.saturating_sub(1);
                }
            }
        }
        out.push(Out::Agent(text.to_string()));
    }

    /// What a target the browser describes is to the agent (lists and discovery).
    fn shown_vis(&self, reg: &Registry, info: &Value) -> Vis {
        let id = info.get("targetId").and_then(Value::as_str).unwrap_or_default();
        match info.get("type").and_then(Value::as_str).unwrap_or_default() {
            "browser" if self.own_browser.as_deref() == Some(id) => Vis::Mine,
            "browser" => Vis::Foreign,
            "tab" | "page" => reg.vis(&self.who, info),
            // Frames and workers: the ones attached under the agent's pages.
            _ if self.sessions.values().any(|s| s.target == id) => Vis::Mine,
            _ => Vis::Foreign,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn target_event(
        &mut self,
        reg: &mut Registry,
        parent: Option<&str>,
        browser_level: bool,
        method: &str,
        text: &str,
        now: Instant,
        out: &mut Vec<Out>,
    ) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let params = msg.get("params").cloned().unwrap_or_default();
        match method {
            "Target.attachedToTarget" => {
                let info = params.get("targetInfo").cloned().unwrap_or_default();
                let (Some(sid), Some(id)) = (st(&params, "/sessionId"), st(&info, "/targetId")) else { return };
                let kind = st(&info, "/type").unwrap_or_default().to_string();
                let waiting = params.get("waitingForDebugger").and_then(Value::as_bool).unwrap_or(false);
                let vis = if !browser_level {
                    // Under one of the agent's tabs or pages: its frames, workers and pages are
                    // its; workers shared with the user's tabs are not.
                    if matches!(kind.as_str(), "service_worker" | "shared_worker") { Vis::Foreign } else { Vis::Mine }
                } else if kind == "browser" {
                    if self.expect_browser > 0 {
                        self.expect_browser -= 1;
                        Vis::Mine
                    } else {
                        Vis::Foreign
                    }
                } else {
                    self.shown_vis(reg, &info)
                };
                match vis {
                    Vis::Mine => {
                        let top = match parent.and_then(|p| self.sessions.get(p)) {
                            Some(p) if !browser_level => p.top.clone(),
                            // A frame or worker the agent attached again from the browser level.
                            _ if !matches!(kind.as_str(), "tab" | "page" | "browser") => self
                                .sessions
                                .values()
                                .find(|s| s.target == id)
                                .map(|s| s.top.clone())
                                .unwrap_or_else(|| id.to_string()),
                            _ => id.to_string(),
                        };
                        let parent = parent.map(String::from);
                        self.sessions.insert(sid.to_string(), Sess { target: id.to_string(), kind: kind.clone(), parent, top });
                        self.shown(reg, id, &kind);
                        out.push(Out::Agent(text.to_string()));
                    }
                    Vis::Unknown => self.hold(id, &info, text, Some((sid, parent, &kind, waiting)), now),
                    Vis::Foreign | Vis::TakenOver => self.release(sid, parent, waiting, out),
                }
            }
            "Target.detachedFromTarget" => {
                let Some(sid) = st(&params, "/sessionId") else { return };
                if self.releasing.remove(sid) || self.dead.contains_key(sid) {
                    return;
                }
                if let Some(i) = self.held.iter().position(|h| h.attach.as_ref().is_some_and(|a| a.session == sid)) {
                    self.held.remove(i);
                    return;
                }
                if self.sessions.contains_key(sid) {
                    for s in self.family(&self.sessions, sid) {
                        self.sessions.remove(&s);
                    }
                    out.push(Out::Agent(text.to_string()));
                }
            }
            "Target.targetCreated" | "Target.targetInfoChanged" => {
                let info = params.get("targetInfo").cloned().unwrap_or_default();
                let Some(id) = st(&info, "/targetId") else { return };
                if let Some(h) = self.held.iter_mut().find(|h| h.target == id) {
                    h.info = info.clone();
                    h.msgs.push(text.to_string());
                    return;
                }
                match self.shown_vis(reg, &info) {
                    Vis::Mine => {
                        if parent.is_none() {
                            self.disc_known.insert(reg.page_of(id).to_string());
                        }
                        self.seen.insert(id.to_string());
                        out.push(Out::Agent(text.to_string()));
                    }
                    Vis::Unknown => self.hold(id, &info, text, None, now),
                    Vis::Foreign | Vis::TakenOver => {}
                }
            }
            "Target.targetDestroyed" | "Target.targetCrashed" => {
                let Some(id) = st(&params, "/targetId") else { return };
                if let Some(i) = self.held.iter().position(|h| h.target == id) {
                    if method == "Target.targetDestroyed" {
                        self.held.remove(i);
                    } else {
                        self.held[i].msgs.push(text.to_string());
                    }
                    return;
                }
                let seen = if method == "Target.targetDestroyed" { self.seen.remove(id) } else { self.seen.contains(id) };
                if seen {
                    out.push(Out::Agent(text.to_string()));
                }
            }
            // Non-flat sessions are refused.
            "Target.receivedMessageFromTarget" => {}
            _ => out.push(Out::Agent(text.to_string())),
        }
    }

    /// The agent was shown target `id` of type `kind` (an attach).
    fn shown(&mut self, reg: &Registry, id: &str, kind: &str) {
        self.seen.insert(id.to_string());
        if matches!(kind, "tab" | "page") {
            self.auto_known.insert(reg.page_of(id).to_string());
        }
    }

    /// `sid` and every session attached through it, in `map`.
    fn family(&self, map: &HashMap<String, Sess>, sid: &str) -> Vec<String> {
        let mut all = vec![sid.to_string()];
        let mut i = 0;
        while i < all.len() {
            let p = all[i].clone();
            all.extend(map.iter().filter(|(_, s)| s.parent.as_deref() == Some(p.as_str())).map(|(k, _)| k.clone()));
            i += 1;
        }
        all
    }

    fn hold(&mut self, id: &str, info: &Value, text: &str, attach: Option<(&str, Option<&str>, &str, bool)>, now: Instant) {
        let attach = attach.map(|(session, parent, kind, waiting)| HeldAttach {
            session: session.to_string(),
            parent: parent.map(String::from),
            kind: kind.to_string(),
            waiting,
        });
        match self.held.iter_mut().find(|h| h.target == id) {
            Some(h) => {
                h.msgs.push(text.to_string());
                if attach.is_some() {
                    h.attach = attach;
                }
            }
            None => self.held.push(Held { target: id.to_string(), info: info.clone(), msgs: vec![text.to_string()], attach, since: now }),
        }
    }

    /// Lets a target the agent may not see run (when it waits for a debugger) and detaches it.
    fn release(&mut self, sid: &str, parent: Option<&str>, waiting: bool, out: &mut Vec<Out>) {
        if waiting {
            out.push(self.internal_cmd(Internal::Ignore, "Runtime.runIfWaitingForDebugger", json!({}), Some(sid)));
        }
        out.push(self.internal_cmd(Internal::Ignore, "Target.detachFromTarget", json!({ "sessionId": sid }), parent));
        self.releasing.insert(sid.to_string());
    }

    /// Decides the held targets that can be decided (or waited too long).
    fn settle(&mut self, reg: &mut Registry, now: Instant, out: &mut Vec<Out>) {
        let mut i = 0;
        while i < self.held.len() {
            let h = &self.held[i];
            let (vis, late) = match self.shown_vis(reg, &h.info) {
                Vis::Unknown if now.duration_since(h.since) < HOLD_MAX => {
                    i += 1;
                    continue;
                }
                Vis::Unknown => {
                    log::warn!("browser proxy: target {} stayed undecided; treating it as not the agent's for now", h.target);
                    (Vis::Foreign, true)
                }
                v => (v, false),
            };
            let h = self.held.remove(i);
            if vis == Vis::Mine {
                if let Some(a) = &h.attach {
                    let top = h.target.clone();
                    self.sessions
                        .insert(a.session.clone(), Sess { target: h.target.clone(), kind: a.kind.clone(), parent: a.parent.clone(), top });
                    self.shown(reg, &h.target, &a.kind);
                }
                self.seen.insert(h.target.clone());
                self.disc_known.insert(reg.page_of(&h.target).to_string());
                out.extend(h.msgs.into_iter().map(Out::Agent));
            } else if let Some(a) = h.attach {
                self.release(&a.session, a.parent.as_deref(), a.waiting, out);
                if late {
                    self.late.insert(h.target, (Some(a.parent), now));
                }
            } else if late {
                self.late.insert(h.target, (None, now));
            }
        }
    }

    /// Targets released undecided that turned out to be the agent's: attached through the
    /// session that met them first, or announced.
    fn catch_up(&mut self, reg: &Registry, now: Instant, out: &mut Vec<Out>) {
        for (target, (via, since)) in std::mem::take(&mut self.late) {
            let Some(info) = reg.info(&target).cloned() else { continue };
            match self.shown_vis(reg, &info) {
                Vis::Mine => match via {
                    Some(parent) => {
                        let parent_alive = parent.as_ref().is_none_or(|p| self.sessions.contains_key(p));
                        let attached = self.sessions.values().any(|s| s.target == target);
                        if parent_alive && !attached && self.attaching.insert(target.clone()) {
                            let attach = json!({ "targetId": target, "flatten": true });
                            out.push(self.internal_cmd(Internal::Attach(target.clone()), "Target.attachToTarget", attach, parent.as_deref()));
                        }
                    }
                    None if self.seen.insert(target.clone()) => {
                        out.push(Out::Agent(json!({ "method": "Target.targetCreated", "params": { "targetInfo": info } }).to_string()));
                    }
                    None => {}
                },
                Vis::Unknown if now.duration_since(since) < LATE_MAX => {
                    self.late.insert(target, (via, since));
                }
                _ => {}
            }
        }
    }

    // ───────────────────────────── ownership changes ─────────────────────────────

    /// Catches up with the registry: decides held targets, detaches the agent from tabs the user
    /// took over, gives back handed-back tabs and shows newly lent ones.
    pub fn reconcile(&mut self, reg: &mut Registry, now: Instant) -> Vec<Out> {
        let mut out = Vec::new();
        self.settle(reg, now, &mut out);
        self.catch_up(reg, now, &mut out);
        if let Root::Page(p) = &self.root {
            if !self.root_dead && reg.lost(&self.who, p).is_some() {
                self.root_dead = true;
                out.push(Out::Close(TAKEN_OVER.into()));
            }
            return out;
        }
        // Taken over: the agent's sessions there are frozen. Not its any more (a lent tab the
        // user took back): they end.
        let mut lost: Vec<(String, Vis)> = self
            .sessions
            .values()
            .filter(|s| s.kind != "browser")
            .map(|s| s.top.clone())
            .collect::<HashSet<String>>()
            .into_iter()
            .filter_map(|top| reg.lost(&self.who, &top).map(|how| (top, how)))
            .collect();
        lost.sort_by(|a, b| a.0.cmp(&b.0));
        for (top, how) in lost {
            if how == Vis::TakenOver {
                self.kill(&top, &mut out);
            } else {
                self.end(reg, &top, &mut out);
            }
        }
        // Frozen sessions on a tab that closed, or that is not the agent's any more, end.
        let mut ended: Vec<String> = self
            .dead
            .values()
            .map(|s| s.top.clone())
            .collect::<HashSet<String>>()
            .into_iter()
            .filter(|top| reg.gone(top) || reg.lost(&self.who, top) == Some(Vis::Foreign))
            .collect();
        ended.sort();
        for top in ended {
            self.end(reg, &top, &mut out);
        }
        // Handed back.
        let mut back: Vec<String> = self
            .dead
            .values()
            .map(|s| s.top.clone())
            .collect::<HashSet<String>>()
            .into_iter()
            .filter(|top| reg.id_vis(&self.who, top) == Vis::Mine)
            .collect();
        back.sort();
        for top in back {
            self.revive(reg, &top, &mut out);
        }
        // Lent: the agent's auto-attach and discovery show it.
        for page in reg.lent_to(&self.who) {
            let tab = reg.tab_of(&page).map(String::from);
            if let Some(filter) = self.auto.get(&None).cloned()
                && !self.auto_known.contains(&page)
            {
                self.auto_known.insert(page.clone());
                let has_session = self.sessions.values().chain(self.dead.values()).any(|s| s.top == page || Some(&s.top) == tab.as_ref());
                let target = if filter_includes(filter.as_ref(), "tab") {
                    tab.clone()
                } else if filter_includes(filter.as_ref(), "page") {
                    Some(page.clone())
                } else {
                    None
                };
                if !has_session && let Some(t) = target.filter(|t| !self.attaching.contains(t)) {
                    self.attaching.insert(t.clone());
                    out.push(self.internal_cmd(
                        Internal::Attach(t.clone()),
                        "Target.attachToTarget",
                        json!({ "targetId": t, "flatten": true }),
                        None,
                    ));
                }
            }
            if let Some(filter) = self.discover.get(&None).cloned()
                && !self.disc_known.contains(&page)
            {
                self.disc_known.insert(page.clone());
                for id in tab.iter().chain([&page]) {
                    let Some(info) = reg.info(id) else { continue };
                    let kind = info.get("type").and_then(Value::as_str).unwrap_or_default();
                    if filter_includes(filter.as_ref(), kind) && self.seen.insert(id.clone()) {
                        out.push(Out::Agent(json!({ "method": "Target.targetCreated", "params": { "targetInfo": info } }).to_string()));
                    }
                }
            }
        }
        out
    }

    /// `s` hangs on the connection or on a browser session (not under a tab or page).
    fn under_browser(&self, s: &Sess) -> bool {
        s.parent.as_ref().is_none_or(|p| self.sessions.get(p).is_some_and(|p| p.kind == "browser"))
    }

    /// The user took over `top`: the agent's sessions there are frozen (their commands answer
    /// [`TAKEN_OVER`], their events stay here). A tab's own session stays attached in the
    /// browser, since Puppeteer closes the page for good when its tab's session ends; the
    /// sessions under it, and any other session on `top`, are detached from the browser.
    fn kill(&mut self, top: &str, out: &mut Vec<Out>) {
        let mut group: Vec<(String, Sess)> =
            self.sessions.iter().filter(|(_, s)| s.top == top).map(|(k, s)| (k.clone(), s.clone())).collect();
        group.sort_by(|a, b| a.0.cmp(&b.0));
        let kept: HashSet<String> =
            group.iter().filter(|(_, s)| s.kind == "tab" && self.under_browser(s)).map(|(k, _)| k.clone()).collect();
        for (sid, s) in &group {
            if !kept.contains(sid) && (self.under_browser(s) || s.parent.as_ref().is_some_and(|p| kept.contains(p))) {
                out.push(self.internal_cmd(Internal::Ignore, "Target.detachFromTarget", json!({ "sessionId": sid }), s.parent.as_deref()));
            }
        }
        for (sid, s) in group {
            self.sessions.remove(&sid);
            if kept.contains(&sid) {
                self.suspended.insert(sid.clone());
            }
            self.dead.insert(sid, s);
        }
    }

    /// The user handed `top` back. A kept tab session gets the tab's page attached again under
    /// it (`swap` delivers it); other frozen sessions end and `top` is attached afresh where
    /// the agent's auto-attach would have attached it.
    fn revive(&mut self, reg: &Registry, top: &str, out: &mut Vec<Out>) {
        let mut roots: Vec<String> = self
            .dead
            .iter()
            .filter(|(_, s)| s.top == top && s.parent.as_ref().is_none_or(|p| !self.dead.contains_key(p)))
            .map(|(k, _)| k.clone())
            .collect();
        roots.sort();
        for root in roots {
            if !self.suspended.contains(&root) {
                self.revive_fresh(top, &root, out);
                continue;
            }
            if self.reviving.contains_key(&root) {
                continue;
            }
            if !self.dead.values().any(|s| s.parent.as_deref() == Some(root.as_str())) {
                // Nothing hung under the tab session: it is simply the agent's again.
                self.suspended.remove(&root);
                if let Some(s) = self.dead.remove(&root) {
                    self.sessions.insert(root, s);
                }
                continue;
            }
            let page = reg.page_of(top).to_string();
            self.reviving.insert(root.clone(), page.clone());
            let attach = json!({ "targetId": page, "flatten": true });
            out.push(self.internal_cmd(Internal::Swap(root.clone()), "Target.attachToTarget", attach, Some(&root)));
        }
    }

    /// Frozen `root` (not a kept tab session) and the sessions under it end; `top` is attached
    /// afresh where the agent's auto-attach would have attached it.
    fn revive_fresh(&mut self, top: &str, root: &str, out: &mut Vec<Out>) {
        let Some(r) = self.dead.get(root).cloned() else { return };
        self.tell_ended(root, out);
        if r.target == top && self.under_browser(&r) && self.attaching.insert(top.to_string()) {
            let attach = json!({ "targetId": top, "flatten": true });
            out.push(self.internal_cmd(Internal::Attach(top.to_string()), "Target.attachToTarget", attach, r.parent.as_deref()));
        }
    }

    /// `attachedToTarget` under kept tab session `tab` while the user has the tab or it is
    /// handed back: the page attached again for the hand back, or a target to let go.
    fn suspended_attach(&mut self, reg: &Registry, tab: &str, text: &str, out: &mut Vec<Out>) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let (Some(fresh), Some(target)) = (st(&msg, "/params/sessionId"), st(&msg, "/params/targetInfo/targetId")) else {
            return;
        };
        if self.reviving.get(tab).is_some_and(|p| p == target) {
            let info = msg.pointer("/params/targetInfo").cloned().unwrap_or_default();
            self.swap(reg, tab, fresh, &info, out);
        } else {
            let waiting = msg.pointer("/params/waitingForDebugger").and_then(Value::as_bool).unwrap_or(false);
            self.release(fresh, Some(tab), waiting, out);
        }
    }

    /// Hand back of kept tab session `tab`: the browser attached the tab's page again under it
    /// (session `fresh`, target info `info`). The agent hears its old sessions under the tab
    /// end, then gets the new page session the way a prerendered page is activated, which is
    /// how Puppeteer moves a live page to another session: attached under the tab with
    /// `subtype: "prerender"`, then the page's info without the subtype (`targetInfoChanged`).
    /// A client without discovery (no `targetInfoChanged` to get) has it attached plainly.
    fn swap(&mut self, reg: &Registry, tab: &str, fresh: &str, info: &Value, out: &mut Vec<Out>) {
        self.reviving.remove(tab);
        let Some(kept) = self.dead.get(tab).cloned() else { return };
        let mut under: Vec<String> = self.dead.iter().filter(|(_, s)| s.parent.as_deref() == Some(tab)).map(|(k, _)| k.clone()).collect();
        under.sort();
        for sid in under {
            self.tell_ended(&sid, out);
        }
        self.dead.remove(tab);
        self.suspended.remove(tab);
        self.sessions.insert(tab.to_string(), kept.clone());
        let page = st(info, "/targetId").unwrap_or_default().to_string();
        let sess = Sess { target: page.clone(), kind: "page".into(), parent: Some(tab.to_string()), top: kept.top };
        self.sessions.insert(fresh.to_string(), sess);
        // A page it never heard of (the tab's page changed while the user had it).
        let unseen = !self.seen.contains(&page);
        self.shown(reg, &page, "page");
        self.disc_known.insert(page.clone());
        let mut current = info.clone();
        current["attached"] = json!(true);
        if let Some(o) = current.as_object_mut() {
            o.remove("subtype");
        }
        let attached = |info: &Value| {
            json!({ "method": "Target.attachedToTarget", "params": { "sessionId": fresh, "targetInfo": info, "waitingForDebugger": false }, "sessionId": tab })
                .to_string()
        };
        if self.discover.contains_key(&None) {
            if unseen {
                out.push(Out::Agent(json!({ "method": "Target.targetCreated", "params": { "targetInfo": current } }).to_string()));
            }
            let mut prerender = current.clone();
            prerender["subtype"] = json!("prerender");
            out.push(Out::Agent(attached(&prerender)));
            out.push(Out::Agent(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": current } }).to_string()));
        } else {
            out.push(Out::Agent(attached(&current)));
        }
    }

    /// The page could not be attached again under kept tab session `tab` (it went, or the
    /// browser refused): the tab session ends too and the tab is attached afresh.
    fn swap_failed(&mut self, tab: &str, out: &mut Vec<Out>) {
        let Some(kept) = self.dead.get(tab).cloned() else { return };
        out.push(self.internal_cmd(Internal::Ignore, "Target.detachFromTarget", json!({ "sessionId": tab }), kept.parent.as_deref()));
        self.suspended.remove(tab);
        self.revive_fresh(&kept.top, tab, out);
    }

    /// The agent's sessions on `top` end for good (the tab closed, or the user took a lent tab
    /// back): it hears them end, and the ones still attached in the browser are detached. A page
    /// lent again later is shown to the agent again (its auto-attach covers it afresh).
    fn end(&mut self, reg: &Registry, top: &str, out: &mut Vec<Out>) {
        self.auto_known.remove(reg.page_of(top));
        let mut live: Vec<(String, Sess)> =
            self.sessions.iter().filter(|(_, s)| s.top == top && s.kind != "browser").map(|(k, s)| (k.clone(), s.clone())).collect();
        live.sort_by(|a, b| a.0.cmp(&b.0));
        for (sid, s) in &live {
            if self.under_browser(s) {
                out.push(self.internal_cmd(Internal::Ignore, "Target.detachFromTarget", json!({ "sessionId": sid }), s.parent.as_deref()));
            }
        }
        for (sid, s) in live {
            self.sessions.remove(&sid);
            self.dead.insert(sid, s);
        }
        let mut roots: Vec<String> = self
            .dead
            .iter()
            .filter(|(_, s)| s.top == top && s.parent.as_ref().is_none_or(|p| !self.dead.contains_key(p)))
            .map(|(k, _)| k.clone())
            .collect();
        roots.sort();
        for root in roots {
            self.drop_dead(&root, out);
        }
    }

    /// Frozen `root` and the sessions under it end: a kept tab session among them is detached in
    /// the browser too (the others were at the take over).
    fn drop_dead(&mut self, root: &str, out: &mut Vec<Out>) {
        for sid in self.family(&self.dead, root) {
            if self.suspended.contains(&sid)
                && let Some(parent) = self.dead.get(&sid).map(|s| s.parent.clone())
            {
                out.push(self.internal_cmd(Internal::Ignore, "Target.detachFromTarget", json!({ "sessionId": sid }), parent.as_deref()));
            }
        }
        self.tell_ended(root, out);
    }

    /// The agent hears that frozen `root` and the sessions under it ended (innermost first, each
    /// on its parent); they are forgotten.
    fn tell_ended(&mut self, root: &str, out: &mut Vec<Out>) {
        let family = self.family(&self.dead, root);
        for sid in deepest_first(&self.dead, family) {
            let Some(s) = self.dead.remove(&sid) else { continue };
            self.suspended.remove(&sid);
            self.reviving.remove(&sid);
            let mut m = json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": sid, "targetId": s.target } });
            if let Some(p) = &s.parent {
                m["sessionId"] = json!(p);
            }
            out.push(Out::Agent(m.to_string()));
        }
    }
}

/// `ids` innermost first (by their depth in `map`), then by id.
fn deepest_first(map: &HashMap<String, Sess>, ids: Vec<String>) -> Vec<String> {
    let depth = |sid: &str| {
        let mut d = 0usize;
        let mut cur = map.get(sid).and_then(|s| s.parent.as_deref());
        while let Some(p) = cur
            && d <= map.len()
        {
            d += 1;
            cur = map.get(p).and_then(|s| s.parent.as_deref());
        }
        d
    };
    let mut v: Vec<(usize, String)> = ids.into_iter().map(|id| (depth(&id), id)).collect();
    v.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    v.into_iter().map(|(_, id)| id).collect()
}

/// What to do with a command that passes the checks.
enum Plan {
    /// Answered here (`{}`), without the browser, after these messages.
    Local(Vec<Out>),
    Pass { pending: Option<Pending>, params: Option<Value> },
}
