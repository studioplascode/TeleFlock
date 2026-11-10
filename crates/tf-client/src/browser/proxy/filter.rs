//! The JSON-RPC filter of one agent's DevTools connection: what passes from the agent to the
//! browser and back, decided per message against the [`Registry`]. Pure (no IO): the
//! connection's task (`session.rs`) feeds it messages and sends what it returns.
//!
//! Every agent connection has its own WebSocket to the browser target (or to one of its pages
//! for `/devtools/page/<id>`); flat sessions (`sessionId`) live on that connection only.
//! * Targets: the agent sees its own tabs and pages (and the frames and workers it attached
//!   under them), the user's while they are shared ([`Vis::Shared`]), and its own browser
//!   target, nothing else: target lists, `targetCreated`/`targetInfoChanged`/`targetDestroyed`
//!   and auto-attach are filtered; commands naming another target answer as Chrome does for a
//!   target that does not exist. Its own come first: the user's tabs Chrome reports while the
//!   agent's `setAutoAttach`/`setDiscoverTargets` has not answered wait for the answer (omp picks
//!   the first page it sees shown), and target lists are ordered so. Auto-attached targets it
//!   may not see are released at once (`Runtime.runIfWaitingForDebugger`, then detached); the
//!   user's shared tabs, and the frames and workers under them, are run by the proxy and reach
//!   the agent not waiting: `waitForDebuggerOnStart` never pauses the user's or another agent's
//!   new tab for an agent. A tab whose page is not known yet is held back (paused) until it is,
//!   at most [`HOLD_MAX`].
//! * A tab or page the agent attaches itself through one of its tab or page sessions (or a page
//!   connection) belongs to that target, not to the session it came through: a take over, a
//!   loan to another agent or the end of sharing ends it like any other session on that tab.
//! * Targets it was not shown that it may see later (lent to it, shared, handed back, decided
//!   after the hold) are attached where its auto-attach met them and announced where its
//!   discovery did.
//! * The user's tabs (shared, not lent): the agent reads them and clicks, types and browses in
//!   them (navigates, reloads, goes back and forward), but closing one is refused
//!   ([`user_tab_close_refused`]). A tab the user locked (theirs, or one they lent) stays on its
//!   page: navigating, reloading or closing it is refused, with where to open pages instead
//!   ([`locked_refused`]); an agent without a tab of its own to open pages in then gets a blank
//!   one. A click or a script in the page that navigates it is not stopped.
//! * Sessions: messages tagged with a session the agent does not have are dropped; commands on
//!   such a session answer `Session with given id not found.`.
//! * Commands that would hurt the user or the other agents are refused (`policy`); on the browser
//!   target only browser-level commands an agent needs pass (targets, versions, cookies, windows
//!   of its own tabs, probes). Its new tabs open in windows of their own while the browser runs
//!   headless, else where it asks (near a tab it can see).
//! * Take over: the agent's sessions on that tab are detached from the browser, but the agent
//!   keeps them: every command on them answers [`TAKEN_OVER`]. Hand back tells the agent they
//!   ended and attaches the tab afresh.

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

/// The error of every command on a tab the user took over.
pub(super) const TAKEN_OVER: &str = "the user took over this tab";
/// Why a page connection ends when its page is not the agent's to use any more (a lent tab taken
/// back, the user's tabs no longer shared).
pub(super) const NOT_SHARED: &str = "the user stopped sharing this tab";

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
    /// Opens the agent a blank tab of its own (refused a locked tab, it has none to open pages in).
    FirstTab,
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
    /// The tab or page it belongs to (ownership is decided by it): the target itself for a tab
    /// or page attached at the browser level or by the agent's own `attachToTarget`, else the
    /// one it came under; for browser sessions the browser target.
    top: String,
    /// It came unasked (auto-attach, or the proxy's own attach standing for one); `false`: the
    /// agent attached it itself.
    auto: bool,
}

/// A target that is not decided yet, with the messages about it the agent may get.
struct Held {
    target: String,
    info: Value,
    msgs: Vec<String>,
    attach: Option<HeldAttach>,
    /// The session its messages came on (`None`: the connection).
    via: Option<String>,
    since: Instant,
}

struct HeldAttach {
    session: String,
    parent: Option<String>,
    kind: String,
    waiting: bool,
    auto: bool,
}

/// A browser-level `setAutoAttach`/`setDiscoverTargets` on its way: the user's tabs Chrome
/// reports before it answers, and whatever follows about them, wait here for the answer.
#[derive(Default)]
struct Burst {
    /// Its commands that have not answered.
    pending: u32,
    msgs: Vec<String>,
    targets: HashSet<String>,
    sessions: HashSet<String>,
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
    /// `Target.attachToTarget` of a tab, page, frame or worker, asked on `session`.
    Attach { session: Option<String>, target: String },
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
    /// A page connection whose page the user took over or stopped sharing: why.
    root_dead: Option<&'static str>,
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
    /// Targets the agent was told about.
    seen: HashSet<String>,
    /// Tabs and pages the filter is attaching for the agent.
    attaching: HashSet<String>,
    /// Targets it was not shown, with the browser-level session (`None`: the connection) whose
    /// auto-attach met them (`released`) or whose discovery reported them (`hidden`), in the
    /// browser's order (`missed`).
    released: HashMap<String, (Option<String>, u64)>,
    hidden: HashMap<String, (Option<String>, u64)>,
    missed: u64,
    /// Browser-level sessions (`None`: the connection) whose auto-attach or discovery is turning
    /// on.
    bursts: HashMap<Option<String>, Burst>,
    /// Targets the agent asked to attach, by the session it asked on (`None`: the connection),
    /// not attached yet: what attaches for them is the agent's own attach, not auto-attach.
    explicit: HashMap<(Option<String>, String), u32>,
    /// A refusal on a locked tab found the agent without a tab of its own to open pages in.
    first_tab: bool,
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

/// Why closing one of the user's tabs (shared, not lent), which shows `url`, is refused: agents
/// use the user's tabs, the user closes them.
pub(super) fn user_tab_close_refused(method: &str, url: &str) -> String {
    format!("TeleFlock refused `{method}`: this is one of the user's own tabs ({url}); agents can use it, but only the user closes it: leave it open")
}

/// Why `method` is refused on a tab the user locked to its page, which shows `url` (empty: not
/// described yet), with where the agent opens pages instead: its newest tab it may open pages in
/// (`own`, its address), else the blank one it is given.
pub(super) fn locked_refused(method: &str, url: &str, own: Option<&str>) -> String {
    let target = own.unwrap_or("about:blank");
    let page = if url.is_empty() { String::new() } else { format!(" ({url})") };
    format!(
        "TeleFlock refused `{method}`: the user locked this tab to its page{page}; agents can read it and click and type in it, but open other pages in their own tab: call browser.open again with a new name and app: {{ target: \"{target}\" }}"
    )
}

/// An `attachedToTarget` message as if its target did not wait for a debugger.
fn not_waiting(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(mut m) if m.get("params").is_some_and(Value::is_object) => {
            m["params"]["waitingForDebugger"] = json!(false);
            m.to_string()
        }
        _ => text.to_string(),
    }
}

/// A message on session `sid`, or attaching or detaching it.
fn about_session(text: &str, sid: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|m| st(&m, "/sessionId") == Some(sid) || st(&m, "/params/sessionId") == Some(sid))
}

/// Whether an agent may open `url` (`Target.createTarget`, `Page.navigate`, `/json/new`), or use a
/// shared tab of the user's that shows it: web pages only, never the browser's own pages
/// (`chrome:`, `about:settings`, DevTools), extensions or the device's files.
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
            root_dead: None,
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
            seen: HashSet::new(),
            attaching: HashSet::new(),
            released: HashMap::new(),
            hidden: HashMap::new(),
            missed: 0,
            bursts: HashMap::new(),
            explicit: HashMap::new(),
            first_tab: false,
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
            None => match (&self.root, self.root_dead) {
                (Root::Browser, _) => Ctx::Browser,
                (Root::Page(_), Some(why)) => return vec![error(&id, None, -32000, why)],
                (Root::Page(p), None) => Ctx::Tab(p.clone()),
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
            if matches!(&self.root, Root::Page(p) if p == top) {
                let why = if how == Vis::TakenOver { TAKEN_OVER } else { NOT_SHARED };
                self.root_dead = Some(why);
                out.push(error(&id, sid, -32000, why));
                out.push(Out::Close(why.into()));
                return out;
            }
            if how == Vis::TakenOver {
                self.kill(top, &mut out);
                out.push(error(&id, sid, -32000, TAKEN_OVER));
            } else {
                self.end(top, &mut out);
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
        if std::mem::take(&mut self.first_tab) {
            out.push(Out::FirstTab);
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
                Vis::Mine | Vis::Shared => {}
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
        // A tab the user locked (theirs, or one they lent) stays on its page; the user's own tabs
        // (shared, not lent) are the user's to close. The agent reads, clicks and types in both.
        let (guarded, closes) = match (method, ctx) {
            ("Page.navigate" | "Page.navigateToHistoryEntry" | "Page.reload", Ctx::Tab(top)) => (Some(top.as_str()), false),
            ("Page.close", Ctx::Tab(top)) => (Some(top.as_str()), true),
            ("Target.closeTarget", _) => (params.get("targetId").and_then(Value::as_str), true),
            _ => (None, false),
        };
        if let Some(id) = guarded {
            if let Some(url) = reg.locked_url(&self.who, id) {
                let own = reg.newest_own(&self.who);
                self.first_tab = own.is_none();
                return Err((-32000, locked_refused(method, url, own)));
            }
            if closes && let Some(url) = reg.user_tab_url(&self.who, id) {
                return Err((-32000, user_tab_close_refused(method, url)));
            }
        }
        let flat = params.get("flatten").and_then(Value::as_bool) == Some(true);
        let session = sid.map(String::from);
        let pending = match method {
            "Target.setAutoAttach" if !flat => return Err(refused(method, FLAT_ONLY)),
            "Target.setAutoAttach" | "Target.setDiscoverTargets" if browser_level => {
                let auto = method == "Target.setAutoAttach";
                let on = params.get(if auto { "autoAttach" } else { "discover" }).and_then(Value::as_bool).unwrap_or(false);
                if on {
                    // Chrome reports what there is before it answers: the user's tabs wait.
                    self.bursts.entry(session.clone()).or_default().pending += 1;
                }
                let filter = params.get("filter").cloned();
                Some(if auto { Pending::AutoAttach { session, on, filter } } else { Pending::Discover { session, on, filter } })
            }
            "Target.attachToTarget" if !flat => return Err(refused(method, FLAT_ONLY)),
            "Target.attachToTarget" if params.get("targetId").and_then(Value::as_str) == self.own_browser.as_deref() => {
                self.expect_browser += 1;
                Some(Pending::AttachBrowser)
            }
            // Its own attach: what attaches for it is rooted at the target (`target_event`).
            "Target.attachToTarget" => {
                let target = params.get("targetId").and_then(Value::as_str).unwrap_or_default().to_string();
                *self.explicit.entry((session.clone(), target.clone())).or_default() += 1;
                Some(Pending::Attach { session, target })
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
                // Headless, agents' tabs open in windows of their own: in a background tab a
                // headless page paints no frames (the app's panel shows them). In its own window
                // the browser opens them where the agent asks, near a tab it can see.
                let mut p = params.clone();
                let mut changed = false;
                if let Some(o) = p.as_object_mut() {
                    if !reg.headed {
                        o.insert("newWindow".into(), json!(true));
                        changed = true;
                    }
                    if o.get("nearTargetId").and_then(Value::as_str).is_some_and(|near| !self.target_vis(reg, near).visible()) {
                        o.remove("nearTargetId");
                        changed = true;
                    }
                }
                return Ok(Plan::Pass { pending: Some(Pending::CreateTarget), params: changed.then_some(p) });
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
            // Headless, the windows of its own tabs are its (they open in windows of their own);
            // in its own window the browser opens agents' tabs in the user's windows, which are
            // nobody's to move.
            "Browser.getWindowForTarget"
                if !reg.headed
                    && match params.get("targetId").and_then(Value::as_str) {
                        Some(t) => self.target_vis(reg, t) == Vis::Mine,
                        None => matches!(ctx, Ctx::Tab(top) if reg.id_vis(&self.who, top) == Vis::Mine),
                    } =>
            {
                Some(Pending::WindowFor)
            }
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
                            self.suspended_attach(s, text, &mut out);
                        }
                    } else if self.releasing.contains(s) || self.dead.contains_key(s) {
                        // Not the agent's view.
                    } else if let Some(h) = self.held.iter_mut().find(|h| h.attach.as_ref().is_some_and(|a| a.session == s)) {
                        h.msgs.push(text.to_string());
                    } else if let Some(b) = self.bursts.values_mut().find(|b| b.sessions.contains(s)) {
                        // A user's tab waiting for its auto-attach to answer: its traffic waits too.
                        b.msgs.push(text.to_string());
                    } else if let Some(x) = self.sessions.get(s) {
                        if method.starts_with("Target.") {
                            let browser_level = x.kind == "browser";
                            self.target_event(reg, Some(s), browser_level, &method, text, now, &mut out);
                        } else {
                            out.push(Out::Agent(text.to_string()));
                        }
                    }
                }
                None if self.root_dead.is_some() => {}
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
                // Refused (it went meanwhile): not tried again.
                if serde_json::from_str::<Value>(text).ok().is_none_or(|v| v.get("error").is_some()) {
                    self.released.remove(&t);
                }
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
                    // Its own first, then the user's it may use (each in the browser's order).
                    let mut shown: Vec<(u8, Value)> =
                        list.drain(..).filter_map(|i| Some((self.shown_vis(reg, &i).rank()?, i))).collect();
                    shown.sort_by_key(|(rank, _)| *rank);
                    for (_, i) in &shown {
                        if let Some(id) = i.get("targetId").and_then(Value::as_str) {
                            self.seen.insert(id.to_string());
                            self.hidden.remove(id);
                        }
                    }
                    list.extend(shown.into_iter().map(|(_, i)| i));
                }
                out.push(Out::Agent(v.to_string()));
                return;
            }
            Pending::CreateTarget => {
                reg.created(self.conn);
                if let Some(page) = st(&v, "/result/targetId") {
                    reg.opened(&self.who, page);
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
                if on {
                    // Chrome attached every tab there was before answering: the user's last.
                    self.burst_answered(&session, out);
                }
                if ok {
                    if on {
                        self.auto.insert(session, filter);
                    } else {
                        self.auto.remove(&session);
                    }
                }
            }
            Pending::Discover { session, on, filter } => {
                if on {
                    self.burst_answered(&session, out);
                }
                if ok {
                    if on {
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
            Pending::Attach { session, target } => {
                // Refused: nothing attaches for it.
                if !ok {
                    self.unexpect(&session, &target);
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
                let via = parent.map(String::from);
                let auto = !self.unexpect(&via, id);
                // A tab or page it attached itself through one of its tab or page sessions (or a
                // page connection) is judged, and ends, as that target, not as what it came under.
                let rooted = browser_level || (!auto && matches!(kind.as_str(), "tab" | "page"));
                let vis = if !rooted {
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
                    Vis::Mine | Vis::Shared => {
                        let top = if !rooted {
                            match parent.and_then(|p| self.sessions.get(p)) {
                                Some(p) => p.top.clone(),
                                // Under the page the connection is attached to.
                                None => match &self.root {
                                    Root::Page(p) => p.clone(),
                                    Root::Browser => id.to_string(),
                                },
                            }
                        } else if !matches!(kind.as_str(), "tab" | "page" | "browser") {
                            // A frame or worker the agent attached again from the browser level.
                            self.sessions.values().find(|s| s.target == id).map(|s| s.top.clone()).unwrap_or_else(|| id.to_string())
                        } else {
                            id.to_string()
                        };
                        let text = self.resumed(reg, &top, vis, sid, waiting, text, out);
                        self.sessions.insert(sid.to_string(), Sess { target: id.to_string(), kind: kind.clone(), parent: via.clone(), top, auto });
                        self.shown(id);
                        self.deliver(&via, id, Some(sid), vis == Vis::Shared, &text, out);
                    }
                    Vis::Unknown => self.hold(id, &info, text, Some((sid, parent, &kind, waiting, auto)), parent, now),
                    Vis::Foreign | Vis::TakenOver => {
                        self.release(sid, parent, waiting, out);
                        if browser_level && auto {
                            self.missed_attach(id, via);
                        }
                    }
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
                    match self.bursts.values_mut().find(|b| b.sessions.contains(sid)) {
                        Some(b) => b.msgs.push(text.to_string()),
                        None => out.push(Out::Agent(text.to_string())),
                    }
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
                    v @ (Vis::Mine | Vis::Shared) => {
                        self.seen.insert(id.to_string());
                        self.hidden.remove(id);
                        self.deliver(&parent.map(String::from), id, None, v == Vis::Shared, text, out);
                    }
                    Vis::Unknown => self.hold(id, &info, text, None, parent, now),
                    Vis::Foreign | Vis::TakenOver => {
                        if browser_level {
                            self.missed_announce(id, parent.map(String::from));
                        }
                    }
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
                let seen = if method == "Target.targetDestroyed" {
                    self.hidden.remove(id);
                    self.released.remove(id);
                    self.seen.remove(id)
                } else {
                    self.seen.contains(id)
                };
                if seen {
                    self.deliver(&parent.map(String::from), id, None, false, text, out);
                }
            }
            // Non-flat sessions are refused.
            "Target.receivedMessageFromTarget" => {}
            _ => out.push(Out::Agent(text.to_string())),
        }
    }

    /// A message about a target the agent may see (`session`: attaching it): out at once, unless
    /// the auto-attach or discovery of `via` is turning on and it is the user's (`users`), or
    /// already waits there: then it waits for the answer.
    fn deliver(&mut self, via: &Option<String>, target: &str, session: Option<&str>, users: bool, text: &str, out: &mut Vec<Out>) {
        if let Some(b) = self.bursts.get_mut(via)
            && (users || b.targets.contains(target))
        {
            b.msgs.push(text.to_string());
            b.targets.insert(target.to_string());
            b.sessions.extend(session.map(String::from));
            return;
        }
        out.push(Out::Agent(text.to_string()));
    }

    /// The auto-attach or discovery `via` turned on answered: what waited reaches the agent
    /// before the answer.
    fn burst_answered(&mut self, via: &Option<String>, out: &mut Vec<Out>) {
        let Some(b) = self.bursts.get_mut(via) else { return };
        b.pending = b.pending.saturating_sub(1);
        out.extend(b.msgs.drain(..).map(Out::Agent));
        b.targets.clear();
        b.sessions.clear();
        if b.pending == 0 {
            self.bursts.remove(via);
        }
    }

    /// The agent was shown target `id` (an attach).
    fn shown(&mut self, id: &str) {
        self.seen.insert(id.to_string());
        self.released.remove(id);
    }

    /// Target `id`, auto-attached through `via`, was released: attached there should the agent
    /// see it later.
    fn missed_attach(&mut self, id: &str, via: Option<String>) {
        self.missed += 1;
        self.released.entry(id.to_string()).or_insert((via, self.missed));
    }

    /// Target `id`, reported by the discovery of `via`, was left out: announced there should the
    /// agent see it later.
    fn missed_announce(&mut self, id: &str, via: Option<String>) {
        self.missed += 1;
        self.hidden.entry(id.to_string()).or_insert((via, self.missed));
    }

    /// One attach of `target` the agent asked for on `via` happened (or failed): whether it had
    /// asked.
    fn unexpect(&mut self, via: &Option<String>, target: &str) -> bool {
        let key = (via.clone(), target.to_string());
        let Some(n) = self.explicit.get_mut(&key) else { return false };
        *n -= 1;
        if *n == 0 {
            self.explicit.remove(&key);
        }
        true
    }

    /// The user's shared tab (or a frame or worker under one) attached waiting for a debugger:
    /// the proxy runs it, so the user's new tab never waits for an agent, and the agent hears
    /// of it running (`text` as delivered).
    #[allow(clippy::too_many_arguments)]
    fn resumed(&mut self, reg: &Registry, top: &str, vis: Vis, sid: &str, waiting: bool, text: &str, out: &mut Vec<Out>) -> String {
        if !waiting || (vis != Vis::Shared && reg.id_vis(&self.who, top) != Vis::Shared) {
            return text.to_string();
        }
        out.push(self.internal_cmd(Internal::Ignore, "Runtime.runIfWaitingForDebugger", json!({}), Some(sid)));
        not_waiting(text)
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

    #[allow(clippy::too_many_arguments)]
    fn hold(&mut self, id: &str, info: &Value, text: &str, attach: Option<(&str, Option<&str>, &str, bool, bool)>, via: Option<&str>, now: Instant) {
        let attach = attach.map(|(session, parent, kind, waiting, auto)| HeldAttach {
            session: session.to_string(),
            parent: parent.map(String::from),
            kind: kind.to_string(),
            waiting,
            auto,
        });
        match self.held.iter_mut().find(|h| h.target == id) {
            Some(h) => {
                h.msgs.push(text.to_string());
                if attach.is_some() {
                    h.attach = attach;
                }
            }
            None => self.held.push(Held {
                target: id.to_string(),
                info: info.clone(),
                msgs: vec![text.to_string()],
                attach,
                via: via.map(String::from),
                since: now,
            }),
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
            let vis = match self.shown_vis(reg, &h.info) {
                Vis::Unknown if now.duration_since(h.since) < HOLD_MAX => {
                    i += 1;
                    continue;
                }
                Vis::Unknown => {
                    log::warn!("browser proxy: target {} stayed undecided; treating it as not the agent's for now", h.target);
                    Vis::Foreign
                }
                v => v,
            };
            let h = self.held.remove(i);
            if vis.visible() {
                let via = h.attach.as_ref().map_or_else(|| h.via.clone(), |a| a.parent.clone());
                let session = h.attach.as_ref().map(|a| a.session.clone());
                let mut msgs = h.msgs;
                if let Some(a) = &h.attach {
                    let top = h.target.clone();
                    // The user's tab, waiting for a debugger: the proxy runs it.
                    if a.waiting && vis == Vis::Shared {
                        out.push(self.internal_cmd(Internal::Ignore, "Runtime.runIfWaitingForDebugger", json!({}), Some(&a.session)));
                        for m in msgs.iter_mut().filter(|m| m.contains("\"Target.attachedToTarget\"")) {
                            *m = not_waiting(m);
                        }
                    }
                    self.sessions.insert(
                        a.session.clone(),
                        Sess { target: h.target.clone(), kind: a.kind.clone(), parent: a.parent.clone(), top, auto: a.auto },
                    );
                    self.shown(&h.target);
                }
                self.seen.insert(h.target.clone());
                self.hidden.remove(&h.target);
                for m in msgs {
                    self.deliver(&via, &h.target, session.as_deref(), vis == Vis::Shared, &m, out);
                }
            } else if let Some(a) = h.attach {
                // Should it turn out to be the agent's after all (its page answers the agent's
                // `Target.createTarget` late), its auto-attach gets it then.
                self.release(&a.session, a.parent.as_deref(), a.waiting, out);
                if a.auto {
                    self.missed_attach(&h.target, a.parent);
                }
            } else {
                self.missed_announce(&h.target, h.via);
            }
        }
    }

    /// Targets it was not shown that it may see now (lent to it, shared, handed back, decided
    /// after the hold), in the browser's order: attached through the session whose auto-attach
    /// released them, announced where its discovery left them out. Gone ones are forgotten.
    fn reveal(&mut self, reg: &Registry, out: &mut Vec<Out>) {
        self.released.retain(|id, _| !reg.gone(id));
        self.hidden.retain(|id, _| !reg.gone(id));
        let visible = |id: &str| reg.info(id).is_some_and(|i| self.shown_vis(reg, i).visible());
        let mut attach: Vec<(u64, String, Option<String>)> =
            self.released.iter().filter(|(id, _)| visible(id)).map(|(id, (via, n))| (*n, id.clone(), via.clone())).collect();
        let mut announce: Vec<(u64, String, Option<String>)> =
            self.hidden.iter().filter(|(id, _)| visible(id)).map(|(id, (via, n))| (*n, id.clone(), via.clone())).collect();
        attach.sort();
        announce.sort();
        for (_, target, via) in attach {
            // Its auto-attach there is still turning on: once it answered.
            if self.bursts.contains_key(&via) {
                continue;
            }
            let page = reg.page_of(&target).to_string();
            let tab = reg.tab_of(&page).map(String::from);
            let attached = self
                .sessions
                .values()
                .chain(self.dead.values())
                .any(|s| s.target == target || s.top == target || s.top == page || tab.as_deref() == Some(s.top.as_str()));
            let parent_alive = via.as_ref().is_none_or(|p| self.sessions.contains_key(p));
            if attached || !parent_alive || !self.auto.contains_key(&via) {
                self.released.remove(&target);
            } else if self.attaching.insert(target.clone()) {
                let attach = json!({ "targetId": target, "flatten": true });
                out.push(self.internal_cmd(Internal::Attach(target.clone()), "Target.attachToTarget", attach, via.as_deref()));
            }
        }
        for (_, target, via) in announce {
            if self.bursts.contains_key(&via) {
                continue;
            }
            self.hidden.remove(&target);
            let Some(info) = reg.info(&target) else { continue };
            if self.discover.contains_key(&via) && self.seen.insert(target.clone()) {
                let mut m = json!({ "method": "Target.targetCreated", "params": { "targetInfo": info } });
                if let Some(s) = &via {
                    m["sessionId"] = json!(s);
                }
                out.push(Out::Agent(m.to_string()));
            }
        }
    }

    // ───────────────────────────── ownership changes ─────────────────────────────

    /// Catches up with the registry: decides held targets, detaches the agent from tabs the user
    /// took over or took back (or stopped sharing), gives back handed-back tabs and shows the ones
    /// it may see now.
    pub fn reconcile(&mut self, reg: &mut Registry, now: Instant) -> Vec<Out> {
        let mut out = Vec::new();
        self.settle(reg, now, &mut out);
        // A page connection whose page the user took over or stopped sharing closes; what it
        // attached of other tabs follows the rules below.
        if let Root::Page(p) = &self.root {
            if self.root_dead.is_some() {
                return out;
            }
            if let Some(how) = reg.lost(&self.who, p) {
                let why = if how == Vis::TakenOver { TAKEN_OVER } else { NOT_SHARED };
                self.root_dead = Some(why);
                out.push(Out::Close(why.into()));
                return out;
            }
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
                self.end(&top, &mut out);
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
            self.end(&top, &mut out);
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
        // Lent, shared, handed back to a connection that never had it: its auto-attach and
        // discovery show it.
        self.reveal(reg, &mut out);
        out
    }

    /// `s` hangs on the connection or on a browser session (not under a tab or page).
    fn under_browser(&self, s: &Sess) -> bool {
        s.parent.as_ref().is_none_or(|p| self.sessions.get(p).is_some_and(|p| p.kind == "browser"))
    }

    /// `s` is not detached with the other sessions of its tab or page: it hangs on the
    /// connection or a browser session, or on a session of another tab (a tab or page the agent
    /// attached through one).
    fn on_its_own(&self, s: &Sess) -> bool {
        s.parent.as_ref().is_none_or(|p| {
            self.sessions.get(p).or_else(|| self.dead.get(p)).is_none_or(|p| p.kind == "browser" || p.top != s.top)
        })
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
            if !kept.contains(sid) && (self.on_its_own(s) || s.parent.as_ref().is_some_and(|p| kept.contains(p))) {
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
        if r.target == top && r.auto && self.under_browser(&r) && self.attaching.insert(top.to_string()) {
            let attach = json!({ "targetId": top, "flatten": true });
            out.push(self.internal_cmd(Internal::Attach(top.to_string()), "Target.attachToTarget", attach, r.parent.as_deref()));
        }
    }

    /// `attachedToTarget` under kept tab session `tab` while the user has the tab or it is
    /// handed back: the page attached again for the hand back, or a target to let go.
    fn suspended_attach(&mut self, tab: &str, text: &str, out: &mut Vec<Out>) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let (Some(fresh), Some(target)) = (st(&msg, "/params/sessionId"), st(&msg, "/params/targetInfo/targetId")) else {
            return;
        };
        if self.reviving.get(tab).is_some_and(|p| p == target) {
            let info = msg.pointer("/params/targetInfo").cloned().unwrap_or_default();
            self.swap(tab, fresh, &info, out);
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
    fn swap(&mut self, tab: &str, fresh: &str, info: &Value, out: &mut Vec<Out>) {
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
        let sess = Sess { target: page.clone(), kind: "page".into(), parent: Some(tab.to_string()), top: kept.top, auto: true };
        self.sessions.insert(fresh.to_string(), sess);
        // A page it never heard of (the tab's page changed while the user had it).
        let unseen = !self.seen.contains(&page);
        self.shown(&page);
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

    /// The agent's sessions on `top` end for good (the tab closed, the user took a lent tab back
    /// or stopped sharing): it hears them end, and the ones still attached in the browser are
    /// detached. Should it see the tab again (lent again, shared again), its auto-attach shows it
    /// afresh.
    fn end(&mut self, top: &str, out: &mut Vec<Out>) {
        let mut live: Vec<(String, Sess)> =
            self.sessions.iter().filter(|(_, s)| s.top == top && s.kind != "browser").map(|(k, s)| (k.clone(), s.clone())).collect();
        live.sort_by(|a, b| a.0.cmp(&b.0));
        for (sid, s) in &live {
            if self.on_its_own(s) {
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
            if let Some(s) = self.dead.get(&root)
                && s.auto
                && self.under_browser(s)
            {
                let (target, via) = (s.target.clone(), s.parent.clone());
                self.missed_attach(&target, via);
            }
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
            // Its attach still waits in a burst: the agent never heard of it, nor does it now.
            if let Some(b) = self.bursts.values_mut().find(|b| b.sessions.contains(&sid)) {
                b.sessions.remove(&sid);
                b.msgs.retain(|m| !about_session(m, &sid));
                continue;
            }
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
