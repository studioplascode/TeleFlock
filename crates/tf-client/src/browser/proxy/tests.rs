//! The proxy's rules on recorded DevTools traffic (Chrome for Testing 156, Puppeteer-style
//! clients: browser-level auto-attach of tabs with `waitForDebuggerOnStart`, pages attached under
//! their tabs). Target and session ids are the ones Chrome sent in the recording.

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::AttachKey;
use super::filter::{Filter, HOLD_MAX, Out, Root, TAKEN_OVER, filter_includes, url_allowed};
use super::http::{host_ok, list_for, parse};
use super::monitor::Monitor;
use super::registry::{Registry, Vis};

const CTX: &str = "E327C4903FFFBAD75E712B28D934A51B";
// The user's tab and its page.
const USER_TAB: &str = "9BE252A20A6D6DA856736B19A21ACCF9";
const USER_PAGE: &str = "98E69140FA4475559BE9D8990B49D2D4";
// Agent A's tab and page; agent B's.
const A_TAB: &str = "8CAD25CCB3A2E8E66D1CE05C4848EE6A";
const A_PAGE: &str = "FEE4378F647AFCA5E6167150BEF463D3";
const B_TAB: &str = "C93952AD730DFFC0027D114244BCF49C";
const B_PAGE: &str = "988C1DD22FFA1273CEFF89625B68D4C8";
// A window's toolbar: a tab showing browser UI.
const UI_TAB: &str = "8E69713DB7D6D7C45DA8E28F651BCA34";
const UI_PAGE: &str = "BE2FE6E03A436EC5C33FF99269D57E5B";
const WORKER: &str = "861453E03A0FB2F0B095934225282883";
// The browser targets of A's and B's connections.
const A_BROWSER: &str = "dbb2c7bd-fcfb-48e1-9030-2f5a25b73f08";
const B_BROWSER: &str = "776926c3-6b19-4a16-9c1a-4e7634fd0ee7";

fn who(agent: &str) -> AttachKey {
    AttachKey { host_id: "h1".into(), agent_id: agent.into() }
}

fn info(id: &str, kind: &str, url: &str) -> Value {
    let mut v = json!({
        "targetId": id, "type": kind, "title": url, "url": url, "attached": true,
        "canAccessOpener": false, "browserContextId": CTX,
    });
    if kind == "browser" {
        v = json!({ "targetId": id, "type": "browser", "title": "", "url": "", "attached": true, "canAccessOpener": false });
    }
    v
}

fn popup_info(id: &str, opener: &str) -> Value {
    json!({
        "targetId": id, "type": "page", "title": "", "url": "", "attached": false, "openerId": opener,
        "canAccessOpener": true, "openerFrameId": opener, "browserContextId": CTX,
    })
}

fn attached(session: &str, info: Value, waiting: bool, parent: Option<&str>) -> Value {
    let mut m = json!({ "method": "Target.attachedToTarget", "params": { "sessionId": session, "targetInfo": info, "waitingForDebugger": waiting } });
    if let Some(p) = parent {
        m["sessionId"] = json!(p);
    }
    m
}

fn detached(session: &str, target: &str, parent: Option<&str>) -> Value {
    let mut m = json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": session, "targetId": target } });
    if let Some(p) = parent {
        m["sessionId"] = json!(p);
    }
    m
}

fn cmd(id: i64, method: &str, params: Value, session: Option<&str>) -> Value {
    let mut m = json!({ "id": id, "method": method, "params": params });
    if let Some(s) = session {
        m["sessionId"] = json!(s);
    }
    m
}

fn answer(id: i64, result: Value, session: Option<&str>) -> Value {
    let mut m = json!({ "id": id, "result": result });
    if let Some(s) = session {
        m["sessionId"] = json!(s);
    }
    m
}

/// The browser as the monitor reported it: the user's tab, A's and B's tabs (each showing its
/// page), a window toolbar, an extension's service worker, two connections' browser targets.
fn world() -> Registry {
    let mut r = Registry::default();
    for (tab, page, url) in [(USER_TAB, USER_PAGE, "https://mail.example/"), (A_TAB, A_PAGE, "about:blank"), (B_TAB, B_PAGE, "about:blank")] {
        r.target_seen(&info(tab, "tab", url), false);
        r.target_seen(&info(page, "page", url), false);
        r.tab_shows(tab, &info(page, "page", url));
    }
    r.target_seen(&info(UI_TAB, "tab", "chrome://webui-toolbar.top-chrome/"), false);
    r.tab_shows(UI_TAB, &info(UI_PAGE, "browser_ui", "chrome://webui-toolbar.top-chrome/"));
    r.target_seen(&info(WORKER, "service_worker", "chrome-extension://nkeimhogjdpnpccoofpliimaahmaaome/thunk.js"), false);
    r.target_seen(&info(A_BROWSER, "browser", ""), false);
    r.target_seen(&info(B_BROWSER, "browser", ""), false);
    r.synced = true;
    r.attach(&who("a"));
    r.attach(&who("b"));
    r.opened(&who("a"), A_PAGE);
    r.opened(&who("b"), B_PAGE);
    r
}

/// Agent A's connection to the browser target, its own browser target known.
struct Conn {
    reg: Registry,
    f: Filter,
    t0: Instant,
}

impl Conn {
    fn new(reg: Registry, agent: &str, own: &str) -> Conn {
        Conn::for_key(reg, who(agent), own)
    }

    /// A connection of any attachment (host and agent).
    fn for_key(reg: Registry, key: AttachKey, own: &str) -> Conn {
        let mut f = Filter::new(key, 7, Root::Browser);
        let first = f.start();
        let [Out::Browser(q)] = first.as_slice() else { panic!("start: {first:?}") };
        let q: Value = serde_json::from_str(q).unwrap();
        assert_eq!(q["method"], "Target.getTargetInfo");
        let mut c = Conn { reg, f, t0: Instant::now() };
        let out = c.browser(answer(q["id"].as_i64().unwrap(), json!({ "targetInfo": info(own, "browser", "") }), None));
        assert!(out.is_empty(), "the filter's own answer reaches nobody: {out:?}");
        c
    }

    fn a() -> Conn {
        Conn::new(world(), "a", A_BROWSER)
    }

    fn agent(&mut self, m: Value) -> Vec<Out> {
        self.f.on_agent(&mut self.reg, &m.to_string(), 1_000)
    }

    fn browser(&mut self, m: Value) -> Vec<Out> {
        self.f.on_browser(&mut self.reg, &m.to_string(), self.t0)
    }

    fn browser_at(&mut self, m: Value, later: Duration) -> Vec<Out> {
        self.f.on_browser(&mut self.reg, &m.to_string(), self.t0 + later)
    }

    fn reconcile(&mut self) -> Vec<Out> {
        self.f.reconcile(&mut self.reg, self.t0)
    }

    /// Puppeteer's start: discovery, then auto-attach of tabs waiting for the debugger; Chrome
    /// attaches every tab there is (as recorded) and answers.
    fn puppeteer_start(&mut self) -> Vec<Out> {
        let mut out = self.agent(cmd(1, "Target.setDiscoverTargets", json!({ "discover": true, "filter": [{}] }), None));
        out.extend(self.browser(answer(1, json!({}), None)));
        out.extend(self.agent(cmd(
            2,
            "Target.setAutoAttach",
            json!({ "waitForDebuggerOnStart": true, "flatten": true, "autoAttach": true, "filter": [{ "type": "page", "exclude": true }, {}] }),
            None,
        )));
        for (sid, tab, url) in [
            ("788F13325609E54D0CB592A0737962DF", USER_TAB, "https://mail.example/"),
            ("1CF98BE4CA0A5A7A7E5CEF248DCB8E78", A_TAB, "about:blank"),
            ("C7FCE88A7DCE271B43D6C0B3AE3D25C2", B_TAB, "about:blank"),
            ("8D7BB6A6384FE96F56262F8DCDC57284", UI_TAB, "chrome://webui-toolbar.top-chrome/"),
        ] {
            out.extend(self.browser(attached(sid, info(tab, "tab", url), false, None)));
        }
        out.extend(self.browser(attached("69F1B51E1592E2CDA8EC974544D605A8", info(WORKER, "service_worker", "chrome-extension://x/thunk.js"), false, None)));
        out.extend(self.browser(answer(2, json!({}), None)));
        out
    }
}

fn agent_msgs(out: &[Out]) -> Vec<Value> {
    out.iter().filter_map(|o| if let Out::Agent(s) = o { Some(serde_json::from_str(s).unwrap()) } else { None }).collect()
}

fn browser_msgs(out: &[Out]) -> Vec<Value> {
    out.iter().filter_map(|o| if let Out::Browser(s) = o { Some(serde_json::from_str(s).unwrap()) } else { None }).collect()
}

fn ids(list: &[Value]) -> Vec<String> {
    let mut v: Vec<String> = list.iter().map(|i| i["targetId"].as_str().unwrap().to_string()).collect();
    v.sort();
    v
}

fn assert_error(out: &[Out], id: i64, code: i64, text: &str) {
    let a = agent_msgs(out);
    assert_eq!(a.len(), 1, "{out:?}");
    assert_eq!(a[0]["id"], json!(id));
    assert_eq!(a[0]["error"]["code"], json!(code), "{a:?}");
    assert!(a[0]["error"]["message"].as_str().unwrap().contains(text), "{a:?}");
    assert!(browser_msgs(out).is_empty(), "nothing reaches the browser: {out:?}");
}

#[test]
fn get_targets_lists_only_the_agents_own() {
    let mut c = Conn::a();
    let out = c.agent(cmd(5, "Target.getTargets", json!({}), None));
    assert_eq!(browser_msgs(&out).len(), 1);
    let all: Vec<Value> = vec![
        info(USER_TAB, "tab", "https://mail.example/"),
        info(USER_PAGE, "page", "https://mail.example/"),
        info(A_TAB, "tab", "about:blank"),
        info(A_PAGE, "page", "about:blank"),
        info(B_TAB, "tab", "about:blank"),
        info(B_PAGE, "page", "about:blank"),
        info(UI_TAB, "tab", "chrome://webui-toolbar.top-chrome/"),
        info(UI_PAGE, "browser_ui", "chrome://webui-toolbar.top-chrome/"),
        info(WORKER, "service_worker", "chrome-extension://x/thunk.js"),
        info(A_BROWSER, "browser", ""),
        info(B_BROWSER, "browser", ""),
    ];
    let out = c.browser(answer(5, json!({ "targetInfos": all }), None));
    let a = agent_msgs(&out);
    let mut want = vec![A_TAB.to_string(), A_PAGE.to_string(), A_BROWSER.to_string()];
    want.sort();
    assert_eq!(ids(a[0]["result"]["targetInfos"].as_array().unwrap()), want);
}

#[test]
fn discovery_shows_only_the_agents_targets() {
    let mut c = Conn::a();
    c.agent(cmd(1, "Target.setDiscoverTargets", json!({ "discover": true, "filter": [{}] }), None));
    let mut shown = Vec::new();
    for i in [
        info(USER_TAB, "tab", "https://mail.example/"),
        info(USER_PAGE, "page", "https://mail.example/"),
        info(A_TAB, "tab", "about:blank"),
        info(A_PAGE, "page", "about:blank"),
        info(B_PAGE, "page", "about:blank"),
        info(WORKER, "service_worker", "chrome-extension://x/thunk.js"),
        info(B_BROWSER, "browser", ""),
        info(A_BROWSER, "browser", ""),
    ] {
        for method in ["Target.targetCreated", "Target.targetInfoChanged"] {
            let out = c.browser(json!({ "method": method, "params": { "targetInfo": i.clone() } }));
            shown.extend(agent_msgs(&out).into_iter().map(|m| m["params"]["targetInfo"]["targetId"].as_str().unwrap().to_string()));
        }
    }
    shown.dedup();
    assert_eq!(shown, vec![A_TAB, A_PAGE, A_BROWSER]);
    // Destroyed: only what the agent was shown.
    let gone = |id: &str| json!({ "method": "Target.targetDestroyed", "params": { "targetId": id } });
    assert!(agent_msgs(&c.browser(gone(USER_PAGE))).is_empty());
    assert_eq!(agent_msgs(&c.browser(gone(A_PAGE))).len(), 1);
}

#[test]
fn the_users_tabs_are_released_at_once_and_their_traffic_dropped() {
    let mut c = Conn::a();
    let out = c.puppeteer_start();
    let shown: Vec<String> = agent_msgs(&out)
        .iter()
        .filter(|m| m["method"] == "Target.attachedToTarget")
        .map(|m| m["params"]["targetInfo"]["targetId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(shown, vec![A_TAB], "only A's tab is attached for A");
    // Each other target is detached right away (none was waiting: they existed already).
    let sent = browser_msgs(&out);
    let detached_sessions: Vec<&str> = sent
        .iter()
        .filter(|m| m["method"] == "Target.detachFromTarget")
        .map(|m| m["params"]["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(
        detached_sessions,
        vec![
            "788F13325609E54D0CB592A0737962DF",
            "C7FCE88A7DCE271B43D6C0B3AE3D25C2",
            "8D7BB6A6384FE96F56262F8DCDC57284",
            "69F1B51E1592E2CDA8EC974544D605A8"
        ]
    );
    assert!(sent.iter().filter(|m| m["method"] == "Target.detachFromTarget").all(|m| m["id"].as_i64().unwrap() < 0));
    // The answers to the proxy's own commands, the detach events and anything else tagged with
    // those sessions never reach the agent.
    let mut out = Vec::new();
    for m in sent.iter().filter(|m| m["id"].as_i64().unwrap() < 0) {
        out.extend(c.browser(answer(m["id"].as_i64().unwrap(), json!({}), m["sessionId"].as_str())));
    }
    out.extend(c.browser(detached("788F13325609E54D0CB592A0737962DF", USER_TAB, None)));
    out.extend(c.browser(json!({ "method": "Inspector.workerScriptLoaded", "params": {}, "sessionId": "69F1B51E1592E2CDA8EC974544D605A8" })));
    out.extend(c.browser(json!({ "method": "Page.frameNavigated", "params": {}, "sessionId": "C7FCE88A7DCE271B43D6C0B3AE3D25C2" })));
    assert!(out.is_empty(), "{out:?}");
    // A command on a session the agent never got.
    assert_error(&c.agent(cmd(9, "Runtime.evaluate", json!({ "expression": "1" }), Some("788F13325609E54D0CB592A0737962DF"))), 9, -32001, "Session with given id not found");
}

#[test]
fn a_new_user_tab_waiting_for_the_debugger_is_run_and_detached() {
    let mut c = Conn::a();
    c.puppeteer_start();
    // The user opens a tab; Chrome pauses it for A's auto-attach (recorded: waitingForDebugger).
    c.reg.target_seen(&info("D7E54D87DBC36EB03FE53CF578013A11", "tab", ""), true);
    c.reg.tab_shows("D7E54D87DBC36EB03FE53CF578013A11", &info("EA023652CF2613A6906EB015EDA0C73F", "page", "data:text/html,usertab"));
    let out = c.browser(attached("CE40719CC3D2C7637AACB5446EF7431E", info("D7E54D87DBC36EB03FE53CF578013A11", "tab", ""), true, None));
    assert!(agent_msgs(&out).is_empty());
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(sent[0]["sessionId"], "CE40719CC3D2C7637AACB5446EF7431E");
    assert_eq!(sent[1]["method"], "Target.detachFromTarget");
    assert_eq!(sent[1]["params"]["sessionId"], "CE40719CC3D2C7637AACB5446EF7431E");
}

#[test]
fn the_agents_tab_and_its_page_are_attached_and_driven() {
    let mut c = Conn::a();
    c.puppeteer_start();
    // Puppeteer auto-attaches the tab's page under the tab session.
    let out = c.browser(attached("16C396EC938E5612C76751EE737DAB50", info(A_PAGE, "page", "about:blank"), false, Some("1CF98BE4CA0A5A7A7E5CEF248DCB8E78")));
    assert_eq!(agent_msgs(&out).len(), 1);
    // Per-tab commands pass untouched.
    let nav = cmd(11, "Page.navigate", json!({ "url": "https://example.com/" }), Some("16C396EC938E5612C76751EE737DAB50"));
    let out = c.agent(nav.clone());
    assert_eq!(browser_msgs(&out), vec![nav]);
    let out = c.agent(cmd(12, "Runtime.evaluate", json!({ "expression": "document.title" }), Some("16C396EC938E5612C76751EE737DAB50")));
    assert_eq!(browser_msgs(&out).len(), 1);
    // Events and answers on its sessions reach it.
    let ev = json!({ "method": "Page.loadEventFired", "params": { "timestamp": 1.0 }, "sessionId": "16C396EC938E5612C76751EE737DAB50" });
    assert_eq!(agent_msgs(&c.browser(ev.clone())), vec![ev]);
    // Its tab's activity is recorded.
    assert!(c.reg.tabs().iter().any(|t| t.target_id == A_PAGE && t.active_at == Some(1_000)));
}

#[test]
fn an_agents_new_tab_is_held_until_it_is_known_to_be_its() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let out = c.agent(cmd(20, "Target.createTarget", json!({ "url": "about:blank" }), None));
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["params"]["newWindow"], json!(true), "agents' tabs open in windows of their own");
    // Recorded order: the new tab is attached (paused) before createTarget answers; the monitor
    // has not seen its page yet.
    let tab = "C92EA0088CFB51DCF1B5C8E06477795B";
    let page = "5A9B07D13B4F9954BB8961D48C8BBADE";
    let out = c.browser(json!({ "method": "Target.targetCreated", "params": { "targetInfo": info(tab, "tab", "") } }));
    assert!(out.is_empty(), "undecided: {out:?}");
    let out = c.browser(attached("D87CD1A3957294345C0B00B001F9A879", info(tab, "tab", ""), true, None));
    assert!(out.is_empty(), "undecided targets are held, paused: {out:?}");
    let out = c.browser(answer(20, json!({ "targetId": page }), None));
    assert_eq!(agent_msgs(&out), vec![answer(20, json!({ "targetId": page }), None)]);
    assert_eq!(c.reg.id_vis(&who("a"), page), Vis::Mine);
    // The monitor learns which page the tab shows: the tab is A's and reaches it, in order.
    c.reg.target_seen(&info(tab, "tab", ""), true);
    c.reg.tab_shows(tab, &info(page, "page", "about:blank"));
    let out = c.reconcile();
    let a = agent_msgs(&out);
    assert_eq!(a.len(), 2, "{a:?}");
    assert_eq!(a[0]["method"], "Target.targetCreated");
    assert_eq!(a[1]["method"], "Target.attachedToTarget");
    assert_eq!(a[1]["params"]["waitingForDebugger"], json!(true), "A releases its own tab itself");
    assert!(browser_msgs(&out).is_empty());
    // A drives it.
    let out = c.agent(cmd(21, "Runtime.runIfWaitingForDebugger", json!({}), Some("D87CD1A3957294345C0B00B001F9A879")));
    assert_eq!(browser_msgs(&out).len(), 1);
}

#[test]
fn a_user_tab_opened_while_an_agent_creates_one_is_released() {
    let mut c = Conn::a();
    c.puppeteer_start();
    c.agent(cmd(20, "Target.createTarget", json!({ "url": "about:blank" }), None));
    // The user's new tab shows up first: it may be A's answer, so it waits…
    let tab = "FF65E2DD4741F962E89CEBB5C3B002BE";
    let page = "7311801EF70CA2629C266082D56754BB";
    c.reg.target_seen(&info(tab, "tab", ""), true);
    c.reg.target_seen(&info(page, "page", "https://news.example/"), true);
    c.reg.tab_shows(tab, &info(page, "page", "https://news.example/"));
    let out = c.browser(attached("DFE6CDD765DC532F955AF4FA74D967B5", info(tab, "tab", ""), true, None));
    assert!(out.is_empty());
    // …until A's tab is known: then it is released.
    let out = c.browser(answer(20, json!({ "targetId": A_PAGE }), None));
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 2, "{out:?}");
    assert_eq!(sent[0]["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(sent[1]["method"], "Target.detachFromTarget");
    assert!(agent_msgs(&out).iter().all(|m| m["method"] != "Target.attachedToTarget"));
}

#[test]
fn an_undecided_tab_is_released_after_the_hold_limit() {
    let mut c = Conn::a();
    c.puppeteer_start();
    // A tab whose page the monitor never reports.
    let out = c.browser(attached("AAAA", info("0123456789ABCDEF0123456789ABCDEF", "tab", ""), true, None));
    assert!(out.is_empty());
    assert!(c.f.deadline().is_some());
    let out = c.browser_at(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": info(A_TAB, "tab", "x") } }), HOLD_MAX);
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(sent[1]["method"], "Target.detachFromTarget");
}

#[test]
fn commands_on_other_targets_answer_as_if_they_did_not_exist() {
    let mut c = Conn::a();
    for (i, method) in ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"].iter().enumerate() {
        for target in [USER_PAGE, USER_TAB, B_PAGE, B_TAB, B_BROWSER, UI_TAB, WORKER] {
            let out = c.agent(cmd(i as i64, method, json!({ "targetId": target, "flatten": true }), None));
            assert_error(&out, i as i64, -32602, "No target with given id found");
        }
    }
    let out = c.agent(cmd(30, "Browser.getWindowForTarget", json!({ "targetId": USER_PAGE }), None));
    assert_error(&out, 30, -32602, "No target with given id found");
    // Its own pass.
    for method in ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"] {
        let out = c.agent(cmd(31, method, json!({ "targetId": A_PAGE, "flatten": true }), None));
        assert_eq!(browser_msgs(&out).len(), 1, "{method}");
    }
    // Its own browser target can be attached (Puppeteer's browser.target().createCDPSession()),
    // not closed.
    let out = c.agent(cmd(32, "Target.attachToTarget", json!({ "targetId": A_BROWSER, "flatten": true }), None));
    assert_eq!(browser_msgs(&out).len(), 1);
    assert_error(&c.agent(cmd(33, "Target.closeTarget", json!({ "targetId": A_BROWSER }), None)), 33, -32602, "No target");
}

#[test]
fn browser_wide_commands_that_hurt_others_are_refused() {
    let mut c = Conn::a();
    c.puppeteer_start();
    c.browser(attached("16C396EC938E5612C76751EE737DAB50", info(A_PAGE, "page", "about:blank"), false, Some("1CF98BE4CA0A5A7A7E5CEF248DCB8E78")));
    let page = Some("16C396EC938E5612C76751EE737DAB50");
    let refused = [
        ("Browser.close", json!({}), None),
        ("Browser.crash", json!({}), None),
        ("Browser.crashGpuProcess", json!({}), None),
        ("Browser.close", json!({}), page),
        ("Target.disposeBrowserContext", json!({ "browserContextId": CTX }), None),
        ("Storage.clearDataForOrigin", json!({ "origin": "https://mail.example", "storageTypes": "all" }), None),
        ("Storage.clearCookies", json!({}), None),
        ("Network.clearBrowserCookies", json!({}), page),
        ("Network.clearBrowserCache", json!({}), page),
        ("Browser.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": "/home/u" }), None),
        ("Browser.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": "/tmp", "browserContextId": CTX }), None),
        ("Page.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": "/tmp" }), page),
        ("Target.exposeDevToolsProtocol", json!({ "targetId": A_PAGE }), None),
        ("Target.sendMessageToTarget", json!({ "message": "{}", "targetId": A_PAGE }), None),
        ("DOM.setFileInputFiles", json!({ "files": ["/home/u/.ssh/id_ed25519"], "nodeId": 4 }), page),
        ("Network.loadNetworkResource", json!({ "url": "file:///etc/passwd", "options": {} }), page),
        ("Tethering.bind", json!({ "port": 22 }), None),
        ("Tracing.start", json!({}), page),
        ("Fetch.enable", json!({}), None),
        ("Security.setIgnoreCertificateErrors", json!({ "ignore": true }), None),
        ("Page.navigate", json!({ "url": "chrome://settings/clearBrowserData" }), page),
        ("Page.navigate", json!({ "url": "file:///home/u/.ssh/id_ed25519" }), page),
        ("Target.createTarget", json!({ "url": "chrome://password-manager/passwords" }), None),
        ("Target.createTarget", json!({ "url": " about:settings" }), None),
        ("Target.attachToTarget", json!({ "targetId": A_PAGE }), None),
        ("Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false }), None),
    ];
    for (i, (method, params, session)) in refused.iter().enumerate() {
        let out = c.agent(cmd(100 + i as i64, method, params.clone(), *session));
        let text = if *method == "Browser.close" || method.contains("clear") { "this browser is shared" } else { "TeleFlock refused" };
        assert_error(&out, 100 + i as i64, -32000, text);
    }
    // Probes and everything an agent needs on its own tabs pass.
    let allowed = [
        ("Browser.getVersion", json!({}), None),
        ("SystemInfo.getInfo", json!({}), None),
        ("Storage.getCookies", json!({}), None),
        ("Network.getCookies", json!({ "urls": ["https://mail.example/"] }), page),
        ("Security.setIgnoreCertificateErrors", json!({ "ignore": true }), page),
        ("Fetch.enable", json!({}), page),
        ("Page.navigate", json!({ "url": "https://example.com/" }), page),
        ("Page.navigate", json!({ "url": "data:text/html,hi" }), page),
        ("Target.createTarget", json!({ "url": "about:blank" }), None),
        ("Input.dispatchMouseEvent", json!({ "type": "mousePressed", "x": 1, "y": 2 }), page),
    ];
    for (i, (method, params, session)) in allowed.iter().enumerate() {
        let out = c.agent(cmd(200 + i as i64, method, params.clone(), *session));
        assert_eq!(browser_msgs(&out).len(), 1, "{method}: {out:?}");
    }
}

#[test]
fn browser_contexts_and_downloads_work_in_the_agents_own_context() {
    let mut c = Conn::a();
    c.agent(cmd(1, "Target.createBrowserContext", json!({}), None));
    c.browser(answer(1, json!({ "browserContextId": "AGENTCTX" }), None));
    let out = c.agent(cmd(2, "Browser.setDownloadBehavior", json!({ "behavior": "allow", "downloadPath": "/tmp", "browserContextId": "AGENTCTX" }), None));
    assert_eq!(browser_msgs(&out).len(), 1);
    // B cannot use or see A's context.
    let mut b = Conn::new(std::mem::take(&mut c.reg), "b", B_BROWSER);
    assert_error(&b.agent(cmd(3, "Target.createTarget", json!({ "url": "about:blank", "browserContextId": "AGENTCTX" }), None)), 3, -32000, "Failed to find browser context");
    assert_error(&b.agent(cmd(4, "Target.disposeBrowserContext", json!({ "browserContextId": "AGENTCTX" }), None)), 4, -32000, "Failed to find browser context");
    b.agent(cmd(5, "Target.getBrowserContexts", json!({}), None));
    let out = b.browser(answer(5, json!({ "browserContextIds": ["AGENTCTX"] }), None));
    assert_eq!(agent_msgs(&out)[0]["result"]["browserContextIds"], json!([]));
}

/// A's tab session and its page session (with a frame session under the page), as Puppeteer
/// holds them: (tab session, page session, frame session).
fn a_with_page(c: &mut Conn) -> (&'static str, &'static str, &'static str) {
    let tab_s = "1CF98BE4CA0A5A7A7E5CEF248DCB8E78";
    let page_s = "16C396EC938E5612C76751EE737DAB50";
    let frame_s = "FRAMESESSION0000000000000000000A";
    c.puppeteer_start();
    assert_eq!(agent_msgs(&c.browser(attached(page_s, info(A_PAGE, "page", "about:blank"), false, Some(tab_s)))).len(), 1);
    assert_eq!(agent_msgs(&c.browser(attached(frame_s, info("OOPIF1", "iframe", "https://ads.example/"), false, Some(page_s)))).len(), 1);
    (tab_s, page_s, frame_s)
}

/// Takes A's tab over and checks what the connection does: the page session is detached in the
/// browser (under the tab session, which stays attached), the agent is told nothing.
fn take_over_a(c: &mut Conn, tab_s: &str, page_s: &str) {
    c.reg.take_over(A_PAGE).unwrap();
    let out = c.reconcile();
    assert!(agent_msgs(&out).is_empty(), "{out:?}");
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "only the page session is detached: {sent:?}");
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["params"]["sessionId"], page_s);
    assert_eq!(sent[0]["sessionId"], tab_s, "under the tab session");
    assert!(c.browser(detached(page_s, A_PAGE, Some(tab_s))).is_empty());
}

#[test]
fn take_over_freezes_the_agent_and_hand_back_moves_its_live_page_to_a_new_session() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    // Its next command there fails with the reason, on the page and on the tab session.
    assert_error(&c.agent(cmd(40, "Runtime.evaluate", json!({ "expression": "1" }), Some(page_s))), 40, -32000, TAKEN_OVER);
    assert_error(&c.agent(cmd(41, "Target.setAutoAttach", json!({ "autoAttach": true, "flatten": true }), Some(tab_s))), 41, -32000, TAKEN_OVER);
    assert_error(&c.agent(cmd(42, "Target.activateTarget", json!({ "targetId": A_PAGE }), None)), 42, -32000, TAKEN_OVER);
    // It cannot see it either, and the tab session's own traffic stays here.
    c.agent(cmd(43, "Target.getTargets", json!({}), None));
    let out = c.browser(answer(43, json!({ "targetInfos": [info(A_TAB, "tab", ""), info(A_PAGE, "page", "")] }), None));
    assert_eq!(agent_msgs(&out)[0]["result"]["targetInfos"], json!([]));
    assert!(c.browser(json!({ "method": "Inspector.detached", "params": {}, "sessionId": tab_s })).is_empty());
    // Hand back: the page is attached again under the agent's tab session.
    c.reg.hand_back(A_PAGE).unwrap();
    let out = c.reconcile();
    assert!(agent_msgs(&out).is_empty(), "nothing before the browser attached it: {out:?}");
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["method"], "Target.attachToTarget");
    assert_eq!(sent[0]["params"], json!({ "targetId": A_PAGE, "flatten": true }));
    assert_eq!(sent[0]["sessionId"], tab_s);
    assert!(c.reconcile().is_empty(), "attached once");
    // Chrome attaches it (recorded: the event on the tab session, then the answer).
    let now = info(A_PAGE, "page", "https://inbox.example/");
    let out = c.browser(attached("NEWPAGESESSION", now.clone(), false, Some(tab_s)));
    assert!(browser_msgs(&out).is_empty());
    let a = agent_msgs(&out);
    assert_eq!(a.len(), 4, "{a:?}");
    // Its old sessions under the tab end, innermost first, each on its parent; the tab session
    // lives on (Puppeteer keeps the page object as long as it does).
    assert_eq!(a[0], detached(frame_s, "OOPIF1", Some(page_s)));
    assert_eq!(a[1], detached(page_s, A_PAGE, Some(tab_s)));
    // The new session arrives as a prerendered page of the tab, then is activated: Puppeteer
    // swaps its live page onto it.
    let mut prerender = now.clone();
    prerender["subtype"] = json!("prerender");
    assert_eq!(a[2], attached("NEWPAGESESSION", prerender, false, Some(tab_s)));
    assert_eq!(a[3], json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": now } }));
    assert!(c.browser(answer(sent[0]["id"].as_i64().unwrap(), json!({ "sessionId": "NEWPAGESESSION" }), Some(tab_s))).is_empty());
    // Both sessions are the agent's again.
    let eval = cmd(44, "Runtime.evaluate", json!({ "expression": "document.title" }), Some("NEWPAGESESSION"));
    assert_eq!(browser_msgs(&c.agent(eval.clone())), vec![eval]);
    assert_eq!(browser_msgs(&c.agent(cmd(45, "Target.setAutoAttach", json!({ "autoAttach": true, "flatten": true }), Some(tab_s)))).len(), 1);
    let ev = json!({ "method": "Page.loadEventFired", "params": {}, "sessionId": "NEWPAGESESSION" });
    assert_eq!(agent_msgs(&c.browser(ev.clone())), vec![ev]);
    assert_error(&c.agent(cmd(46, "Runtime.evaluate", json!({ "expression": "1" }), Some(page_s))), 46, -32001, "Session with given id not found");
}

#[test]
fn hand_back_without_discovery_attaches_the_page_plainly() {
    let mut c = Conn::a();
    let tab_s = "TABSESSION000000000000000000000A";
    let page_s = "PAGESESSION00000000000000000000A";
    // A client that auto-attaches tabs but does not discover targets.
    c.agent(cmd(1, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true, "filter": [{ "type": "page", "exclude": true }, {}] }), None));
    c.browser(answer(1, json!({}), None));
    c.browser(attached(tab_s, info(A_TAB, "tab", "about:blank"), false, None));
    c.browser(attached(page_s, info(A_PAGE, "page", "about:blank"), false, Some(tab_s)));
    take_over_a(&mut c, tab_s, page_s);
    c.reg.hand_back(A_PAGE).unwrap();
    c.reconcile();
    let out = c.browser(attached("P2", info(A_PAGE, "page", "about:blank"), false, Some(tab_s)));
    let a = agent_msgs(&out);
    assert_eq!(a, vec![detached(page_s, A_PAGE, Some(tab_s)), attached("P2", info(A_PAGE, "page", "about:blank"), false, Some(tab_s))]);
}

#[test]
fn a_take_over_counts_for_the_next_command_even_before_the_connection_catches_up() {
    let mut c = Conn::a();
    let (tab_s, page_s, _) = a_with_page(&mut c);
    c.reg.take_over(A_PAGE).unwrap();
    let out = c.agent(cmd(50, "Runtime.evaluate", json!({ "expression": "1" }), Some(page_s)));
    assert_eq!(agent_msgs(&out)[0]["error"]["message"], TAKEN_OVER);
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["params"]["sessionId"], page_s);
    assert_eq!(sent[0]["sessionId"], tab_s);
}

#[test]
fn targets_attached_under_a_taken_over_tab_are_let_go() {
    let mut c = Conn::a();
    let (tab_s, page_s, _) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    // The user's browsing prerenders a page in the tab; Puppeteer's auto-attach on the kept tab
    // session pauses it for the debugger: the proxy runs it and detaches it, unseen.
    let mut pre = info("PRERENDER0000000000000000000000CC", "page", "https://next.example/");
    pre["subtype"] = json!("prerender");
    let out = c.browser(attached("PRESESSION", pre, true, Some(tab_s)));
    assert!(agent_msgs(&out).is_empty(), "{out:?}");
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Runtime.runIfWaitingForDebugger");
    assert_eq!(sent[0]["sessionId"], "PRESESSION");
    assert_eq!(sent[1]["method"], "Target.detachFromTarget");
    assert_eq!(sent[1]["params"]["sessionId"], "PRESESSION");
    assert_eq!(sent[1]["sessionId"], tab_s);
}

#[test]
fn a_page_replaced_while_taken_over_is_handed_back_as_the_new_page() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    // The user follows a link that activates a prerendered page: the tab shows a new page, the
    // old one goes.
    let next = "NEXTPAGE000000000000000000000000";
    let mut pre = info(next, "page", "https://next.example/");
    pre["subtype"] = json!("prerender");
    c.reg.target_seen(&pre, true);
    c.reg.tab_shows(A_TAB, &pre);
    c.reg.target_seen(&info(next, "page", "https://next.example/"), false);
    c.reg.target_gone(A_PAGE);
    let out = c.reconcile();
    assert!(out.is_empty(), "still the user's: {out:?}");
    c.reg.hand_back(next).unwrap();
    let sent = browser_msgs(&c.reconcile());
    assert_eq!(sent[0]["params"]["targetId"], next);
    let now = info(next, "page", "https://next.example/");
    let a = agent_msgs(&c.browser(attached("P2", now.clone(), false, Some(tab_s))));
    assert_eq!(a[0], detached(frame_s, "OOPIF1", Some(page_s)));
    assert_eq!(a[1], detached(page_s, A_PAGE, Some(tab_s)));
    assert_eq!(a[2], json!({ "method": "Target.targetCreated", "params": { "targetInfo": now } }), "a page it never saw");
    assert_eq!(a[3]["params"]["targetInfo"]["subtype"], "prerender");
    assert_eq!(a[4], json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": now } }));
}

#[test]
fn a_tab_closed_while_taken_over_ends_the_agents_sessions() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    // The user closes it: the browser detaches the kept tab session, the monitor reports it gone.
    assert!(c.browser(detached(tab_s, A_TAB, None)).is_empty());
    c.reg.target_gone(A_PAGE);
    c.reg.target_gone(A_TAB);
    let out = c.reconcile();
    assert_eq!(agent_msgs(&out), vec![detached(frame_s, "OOPIF1", Some(page_s)), detached(page_s, A_PAGE, Some(tab_s)), detached(tab_s, A_TAB, None)]);
    assert!(browser_msgs(&out).iter().all(|m| m["method"] == "Target.detachFromTarget"), "{out:?}");
    assert!(c.reconcile().is_empty(), "told once");
    assert_error(&c.agent(cmd(60, "Runtime.evaluate", json!({ "expression": "1" }), Some(tab_s))), 60, -32001, "Session with given id not found");
}

#[test]
fn a_lent_tab_taken_back_ends_the_agents_sessions() {
    let mut c = Conn::a();
    c.puppeteer_start();
    c.reg.lend(USER_PAGE, &who("a")).unwrap();
    c.reconcile();
    c.browser(attached("LENTTAB", info(USER_TAB, "tab", "https://mail.example/"), false, None));
    c.browser(attached("LENTPAGE", info(USER_PAGE, "page", "https://mail.example/"), false, Some("LENTTAB")));
    // The user takes it back for good: the agent's sessions there end, in the browser too.
    c.reg.take_over(USER_PAGE).unwrap();
    let out = c.reconcile();
    assert_eq!(agent_msgs(&out), vec![detached("LENTPAGE", USER_PAGE, Some("LENTTAB")), detached("LENTTAB", USER_TAB, None)]);
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["params"]["sessionId"], "LENTTAB");
    assert!(sent[0].get("sessionId").is_none());
}

#[test]
fn the_agent_detaching_its_frozen_tab_session_detaches_it_in_the_browser() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    let out = c.agent(cmd(70, "Target.detachFromTarget", json!({ "sessionId": tab_s }), None));
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["params"]["sessionId"], tab_s);
    assert!(sent[0]["id"].as_i64().unwrap() < 0, "the proxy's own");
    assert_eq!(
        agent_msgs(&out),
        vec![detached(frame_s, "OOPIF1", Some(page_s)), detached(page_s, A_PAGE, Some(tab_s)), detached(tab_s, A_TAB, None), answer(70, json!({}), None)]
    );
    // Handing back now has nothing to give back.
    c.reg.hand_back(A_PAGE).unwrap();
    assert!(c.reconcile().is_empty());
}

#[test]
fn a_hand_back_the_browser_refuses_ends_the_tab_session_and_attaches_the_tab_afresh() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    c.reg.hand_back(A_PAGE).unwrap();
    let swap = browser_msgs(&c.reconcile())[0]["id"].as_i64().unwrap();
    let out = c.browser(json!({ "id": swap, "error": { "code": -32000, "message": "Not allowed" }, "sessionId": tab_s }));
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["params"]["sessionId"], tab_s);
    assert_eq!(sent[1]["method"], "Target.attachToTarget");
    assert_eq!(sent[1]["params"]["targetId"], A_TAB);
    assert!(sent[1].get("sessionId").is_none());
    assert_eq!(agent_msgs(&out), vec![detached(frame_s, "OOPIF1", Some(page_s)), detached(page_s, A_PAGE, Some(tab_s)), detached(tab_s, A_TAB, None)]);
}

#[test]
fn a_lent_tab_appears_to_the_agent() {
    let mut c = Conn::a();
    c.puppeteer_start();
    c.reg.lend(USER_PAGE, &who("a")).unwrap();
    let out = c.reconcile();
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "{out:?}");
    assert_eq!(sent[0]["method"], "Target.attachToTarget");
    assert_eq!(sent[0]["params"]["targetId"], USER_TAB, "Puppeteer's auto-attach takes tabs");
    let created: Vec<String> = agent_msgs(&out).iter().map(|m| m["params"]["targetInfo"]["targetId"].as_str().unwrap().to_string()).collect();
    assert_eq!(created, vec![USER_TAB, USER_PAGE], "discovery announces the tab and its page");
    // Chrome's attach reaches the agent; reconciling again does not attach twice.
    let out = c.browser(attached("LENT", info(USER_TAB, "tab", "https://mail.example/"), false, None));
    assert_eq!(agent_msgs(&out).len(), 1);
    assert!(c.reconcile().is_empty());
    // B still cannot see it.
    let mut b = Conn::new(std::mem::take(&mut c.reg), "b", B_BROWSER);
    assert_error(&b.agent(cmd(1, "Target.attachToTarget", json!({ "targetId": USER_PAGE, "flatten": true }), None)), 1, -32602, "No target");
    // Taking a lent tab over gives it back to the user for good.
    b.reg.take_over(USER_PAGE).unwrap();
    assert_eq!(b.reg.id_vis(&who("a"), USER_PAGE), Vis::Foreign);
}

#[test]
fn popups_of_an_agents_page_are_its() {
    let mut reg = world();
    let mut mon = Monitor::default();
    for m in mon.start() {
        let id = serde_json::from_str::<Value>(&m).unwrap()["id"].as_i64().unwrap();
        mon.on_message(&mut reg, &answer(id, json!({}), None));
    }
    // A popup of A's page, as recorded (`openerId` on the page's targetCreated).
    let popup = "5A9B07D13B4F9954BB8961D48C8BBADE";
    mon.on_message(&mut reg, &json!({ "method": "Target.targetCreated", "params": { "targetInfo": popup_info(popup, A_PAGE) } }));
    assert_eq!(reg.id_vis(&who("a"), popup), Vis::Mine);
    assert_eq!(reg.id_vis(&who("b"), popup), Vis::Foreign);
    // A popup of the user's page is the user's.
    let users = "8217AE13340966408DD36338B924BB40";
    mon.on_message(&mut reg, &json!({ "method": "Target.targetCreated", "params": { "targetInfo": popup_info(users, USER_PAGE) } }));
    assert_eq!(reg.id_vis(&who("a"), users), Vis::Foreign);
    // A page the user opened from a page lent to A long before is not A's.
    let mut reg = world();
    let old = "053967FDF27FAE5B9B83A4564A86ACB1";
    reg.target_seen(&popup_info(old, USER_PAGE), false);
    reg.lend(USER_PAGE, &who("a")).unwrap();
    assert_eq!(reg.id_vis(&who("a"), old), Vis::Foreign);
}

#[test]
fn a_popup_attached_before_the_monitor_saw_it_waits_for_it() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let popup = "5A9B07D13B4F9954BB8961D48C8BBADE";
    // Legacy auto-attach (pages at the browser level, as omp's stealth session does).
    let out = c.browser(attached("POPUPSESSION", popup_info(popup, A_PAGE), true, None));
    assert!(out.is_empty());
    c.reg.target_seen(&popup_info(popup, A_PAGE), true);
    let out = c.reconcile();
    assert_eq!(agent_msgs(&out).len(), 1);
}

#[test]
fn browser_target_sessions_follow_the_browser_rules() {
    let mut c = Conn::a();
    c.agent(cmd(1, "Target.attachToTarget", json!({ "targetId": A_BROWSER, "flatten": true }), None));
    let out = c.browser(attached("BROWSERSESSION", info(A_BROWSER, "browser", ""), false, None));
    assert_eq!(agent_msgs(&out).len(), 1);
    c.browser(answer(1, json!({ "sessionId": "BROWSERSESSION" }), None));
    let s = Some("BROWSERSESSION");
    assert_error(&c.agent(cmd(2, "Browser.close", json!({}), s)), 2, -32000, "shared");
    // omp's stealth: auto-attach (pages) on a browser session; the user's page is released there.
    c.agent(cmd(3, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }), s));
    let out = c.browser(attached("U", info(USER_PAGE, "page", "https://mail.example/"), false, s));
    assert!(agent_msgs(&out).is_empty());
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Target.detachFromTarget");
    assert_eq!(sent[0]["sessionId"], "BROWSERSESSION");
    let out = c.browser(attached("P", info(A_PAGE, "page", "about:blank"), false, s));
    assert_eq!(agent_msgs(&out).len(), 1);
    // Tabs it creates there are its.
    c.agent(cmd(4, "Target.createTarget", json!({ "url": "about:blank" }), s));
    c.browser(answer(4, json!({ "targetId": "NEWPAGE" }), s));
    assert_eq!(c.reg.id_vis(&who("a"), "NEWPAGE"), Vis::Mine);
    // Another connection's browser target does not exist for it.
    assert_error(&c.agent(cmd(5, "Target.attachToTarget", json!({ "targetId": B_BROWSER, "flatten": true }), None)), 5, -32602, "No target");
}

#[test]
fn service_workers_under_the_agents_page_are_released() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let page_s = "16C396EC938E5612C76751EE737DAB50";
    c.browser(attached(page_s, info(A_PAGE, "page", "https://app.example/"), false, Some("1CF98BE4CA0A5A7A7E5CEF248DCB8E78")));
    let out = c.browser(attached("SW", info(WORKER, "service_worker", "https://app.example/sw.js"), true, Some(page_s)));
    assert!(agent_msgs(&out).is_empty());
    assert_eq!(browser_msgs(&out).len(), 2);
    // Its frames and dedicated workers are its.
    let out = c.browser(attached("IF", info("IFRAME1", "iframe", "https://ads.example/"), true, Some(page_s)));
    assert_eq!(agent_msgs(&out).len(), 1);
    let out = c.agent(cmd(60, "Runtime.runIfWaitingForDebugger", json!({}), Some("IF")));
    assert_eq!(browser_msgs(&out).len(), 1);
}

#[test]
fn a_page_connection_closes_when_the_user_takes_its_page_over() {
    let mut reg = world();
    let mut f = Filter::new(who("a"), 8, Root::Page(A_PAGE.into()));
    assert!(f.start().is_empty());
    let out = f.on_agent(&mut reg, &cmd(1, "Runtime.evaluate", json!({ "expression": "1" }), None).to_string(), 5);
    assert_eq!(browser_msgs(&out).len(), 1);
    reg.take_over(A_PAGE).unwrap();
    let out = f.reconcile(&mut reg, Instant::now());
    assert_eq!(out, vec![Out::Close(TAKEN_OVER.into())]);
    assert_error(&f.on_agent(&mut reg, &cmd(2, "Page.reload", json!({}), None).to_string(), 6), 2, -32000, TAKEN_OVER);
}

#[test]
fn malformed_and_reserved_ids_are_answered_here() {
    let mut c = Conn::a();
    let out = c.f.on_agent(&mut c.reg, "not json", 0);
    assert!(browser_msgs(&out).is_empty());
    let out = c.agent(cmd(-5, "Browser.getVersion", json!({}), None));
    assert!(browser_msgs(&out).is_empty(), "negative ids are the proxy's own");
    let out = c.agent(json!({ "id": 1, "params": {} }));
    assert!(browser_msgs(&out).is_empty());
}

#[test]
fn registry_tracks_owners_detach_and_page_swaps() {
    let mut reg = world();
    reg.lend(USER_PAGE, &who("b")).unwrap();
    assert!(reg.lend(A_PAGE, &who("b")).is_err(), "another agent's tab");
    assert!(reg.lend(UI_PAGE, &who("b")).is_err(), "not a tab");
    assert!(reg.lend(USER_PAGE, &who("zzz")).is_err(), "not attached");
    reg.detach(&who("b"));
    let tabs = reg.tabs();
    assert!(tabs.iter().all(|t| t.target_id != USER_PAGE), "a lent tab goes back to the user");
    let b = tabs.iter().find(|t| t.target_id == B_PAGE).unwrap();
    assert!(b.detached && !b.lent);
    reg.attach(&who("b"));
    assert!(!reg.tabs().iter().find(|t| t.target_id == B_PAGE).unwrap().detached);
    // A prerendered page activated in A's tab: still A's.
    reg.tab_shows(A_TAB, &info("NEWPAGEINTAB", "page", "https://next.example/"));
    assert_eq!(reg.id_vis(&who("a"), "NEWPAGEINTAB"), Vis::Mine);
    assert_eq!(reg.id_vis(&who("a"), A_TAB), Vis::Mine);
    // Closed: gone from the list.
    reg.target_gone("NEWPAGEINTAB");
    assert!(reg.tabs().iter().all(|t| t.target_id != "NEWPAGEINTAB"));
    assert!(reg.take_over("nope").is_err());
}

#[test]
fn monitor_maps_tabs_to_pages_and_reports_when_synced() {
    let mut reg = Registry::default();
    let mut mon = Monitor::default();
    let start: Vec<Value> = mon.start().iter().map(|m| serde_json::from_str(m).unwrap()).collect();
    assert_eq!(start[1]["params"]["waitForDebuggerOnStart"], json!(false), "the monitor never pauses a tab");
    mon.on_message(&mut reg, &json!({ "method": "Target.targetCreated", "params": { "targetInfo": info(USER_TAB, "tab", "") } }));
    mon.on_message(&mut reg, &answer(start[0]["id"].as_i64().unwrap(), json!({}), None));
    let cmds = mon.on_message(&mut reg, &attached("TS", info(USER_TAB, "tab", ""), false, None));
    let per_tab: Value = serde_json::from_str(&cmds[0]).unwrap();
    assert_eq!(per_tab["method"], "Target.setAutoAttach");
    assert_eq!(per_tab["sessionId"], "TS");
    mon.on_message(&mut reg, &answer(start[1]["id"].as_i64().unwrap(), json!({}), None));
    assert!(!reg.synced, "waits for the tab's page");
    let cmds = mon.on_message(&mut reg, &attached("PS", info(USER_PAGE, "page", ""), false, Some("TS")));
    let detach: Value = serde_json::from_str(&cmds[0]).unwrap();
    assert_eq!(detach["method"], "Target.detachFromTarget");
    assert_eq!(detach["params"]["sessionId"], "PS");
    mon.on_message(&mut reg, &answer(per_tab["id"].as_i64().unwrap(), json!({}), Some("TS")));
    assert!(reg.synced);
    assert_eq!(reg.page_of(USER_TAB), USER_PAGE);
    assert_eq!(reg.tab_of(USER_PAGE), Some(USER_TAB));
}

#[test]
fn urls_agents_may_open() {
    for ok in ["https://example.com/", "http://127.0.0.1:3000", "about:blank", "ABOUT:BLANK#x", "", "data:text/html,hi", "javascript:void 0", "blob:https://example.com/uuid"] {
        assert!(url_allowed(ok), "{ok}");
    }
    for no in [
        "chrome://settings",
        "about:settings",
        "  chrome://history",
        "file:///etc/passwd",
        "FILE:///C:/Users",
        "devtools://devtools/bundled/inspector.html",
        "chrome-extension://abc/popup.html",
        "chrome-untrusted://print/",
        "view-source:file:///etc/passwd",
        "edge://settings",
        "brave://settings",
        "blob:chrome://settings/x",
        "about:blank/../settings",
        "relative/path",
    ] {
        assert!(!url_allowed(no), "{no}");
    }
}

#[test]
fn target_filters_follow_chrome() {
    assert!(!filter_includes(None, "tab"));
    assert!(filter_includes(None, "page"));
    assert!(!filter_includes(None, "browser"));
    let puppeteer = json!([{ "type": "page", "exclude": true }, {}]);
    assert!(filter_includes(Some(&puppeteer), "tab"));
    assert!(!filter_includes(Some(&puppeteer), "page"));
    assert!(!filter_includes(Some(&json!([])), "page"));
}

#[test]
fn http_requests_hosts_and_lists() {
    let (r, n) = parse(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n\r\nrest").unwrap().unwrap();
    assert_eq!((r.method.as_str(), r.path.as_str(), r.host.as_deref(), n), ("GET", "/json/version", Some("127.0.0.1:9222"), 52));
    assert!(!r.upgrade && !r.close);
    let (r, _) = parse(
        b"GET /devtools/browser/x HTTP/1.1\r\nHost: localhost:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    .unwrap()
    .unwrap();
    assert!(r.upgrade);
    assert_eq!(r.ws_key.as_deref(), Some("dGhlIHNhbXBsZSBub25jZQ=="));
    assert!(parse(b"GET /json HTTP/1.1\r\nHost: x").unwrap().is_none());
    for ok in [None, Some("127.0.0.1:9222"), Some("localhost"), Some("[::1]:9222"), Some("LOCALHOST:1")] {
        assert!(host_ok(ok), "{ok:?}");
    }
    for no in ["evil.example:9222", "127.0.0.1.nip.io", "localhost.evil"] {
        assert!(!host_ok(Some(no)), "{no}");
    }
    let entries = vec![
        json!({ "id": A_PAGE, "type": "page", "url": "about:blank", "webSocketDebuggerUrl": format!("ws://127.0.0.1:9333/devtools/page/{A_PAGE}"),
                "devtoolsFrontendUrl": format!("https://chrome-devtools-frontend.appspot.com/serve_rev/@x/inspector.html?ws=127.0.0.1:9333/devtools/page/{A_PAGE}") }),
        json!({ "id": USER_PAGE, "type": "page", "url": "https://mail.example/" }),
        json!({ "id": UI_PAGE, "type": "browser_ui", "url": "chrome://webui-toolbar.top-chrome/" }),
    ];
    let reg = world();
    let list = list_for(entries, 9333, "127.0.0.1:41234", |id| reg.id_vis(&who("a"), id) == Vis::Mine);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["webSocketDebuggerUrl"], format!("ws://127.0.0.1:41234/devtools/page/{A_PAGE}"));
    assert!(list[0]["devtoolsFrontendUrl"].as_str().unwrap().contains("ws=127.0.0.1:41234/devtools/page/"));
}

#[test]
fn a_prerendered_page_keeps_the_tab_with_its_owner() {
    let mut reg = world();
    let pre = "PRERENDER0000000000000000000000AA";
    let mut pre_info = info(pre, "page", "https://next.example/");
    pre_info["subtype"] = json!("prerender");
    // Speculation rules prerender a page in A's tab: the tab still shows A's page.
    reg.target_seen(&pre_info, true);
    reg.tab_shows(A_TAB, &pre_info);
    assert_eq!(reg.page_of(A_TAB), A_PAGE);
    assert_eq!(reg.id_vis(&who("a"), pre), Vis::Mine, "the prerender is the tab owner's");
    assert_eq!(reg.id_vis(&who("b"), pre), Vis::Foreign);
    // Cancelled: A keeps its tab.
    reg.target_gone(pre);
    assert_eq!(reg.id_vis(&who("a"), A_TAB), Vis::Mine);
    assert!(reg.tabs().iter().any(|t| t.target_id == A_PAGE));
    // Another one activated (its subtype goes): it is A's tab's page, and A's.
    let next = "PRERENDER0000000000000000000000BB";
    let mut next_info = info(next, "page", "https://next.example/");
    next_info["subtype"] = json!("prerender");
    reg.target_seen(&next_info, true);
    reg.tab_shows(A_TAB, &next_info);
    reg.target_seen(&info(next, "page", "https://next.example/"), false);
    reg.target_gone(A_PAGE);
    assert_eq!(reg.page_of(A_TAB), next);
    assert_eq!(reg.id_vis(&who("a"), next), Vis::Mine);
    assert_eq!(reg.id_vis(&who("a"), A_TAB), Vis::Mine);
    assert!(reg.tabs().iter().any(|t| t.target_id == next && t.agent_id == "a"));
}

#[test]
fn a_monitor_that_reconnects_forgets_tabs_that_closed_meanwhile() {
    let mut reg = world();
    reg.resync();
    assert!(!reg.synced);
    assert_eq!(reg.tabs().len(), 2, "owners stay while the monitor reports again");
    // Only B's tab is still there.
    reg.target_seen(&info(B_TAB, "tab", "about:blank"), false);
    reg.tab_shows(B_TAB, &info(B_PAGE, "page", "about:blank"));
    reg.synced_now();
    let left: Vec<String> = reg.tabs().into_iter().map(|t| t.target_id).collect();
    assert_eq!(left, vec![B_PAGE.to_string()]);
    assert!(!reg.has_live_tab(&who("a")), "A gets a new first tab");
}

#[test]
fn an_agents_tab_released_undecided_is_attached_once_it_is_known() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let tab = "C92EA0088CFB51DCF1B5C8E06477795B";
    let page = "5A9B07D13B4F9954BB8961D48C8BBADE";
    // A's tab is attached (paused) but the monitor reports nothing about it in time.
    assert!(c.browser(attached("LATE", info(tab, "tab", ""), true, None)).is_empty());
    let out = c.browser_at(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": info(A_TAB, "tab", "x") } }), HOLD_MAX);
    let sent = browser_msgs(&out);
    assert_eq!(sent[0]["method"], "Runtime.runIfWaitingForDebugger", "never left paused");
    assert_eq!(sent[1]["method"], "Target.detachFromTarget");
    // Later it turns out to be A's (its page answers A's createTarget): A gets it attached.
    c.reg.target_seen(&info(tab, "tab", ""), true);
    c.reg.tab_shows(tab, &info(page, "page", "about:blank"));
    c.reg.opened(&who("a"), page);
    let out = c.reconcile();
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 1, "{out:?}");
    assert_eq!(sent[0]["method"], "Target.attachToTarget");
    assert_eq!(sent[0]["params"]["targetId"], tab);
    let out = c.browser(attached("LATE2", info(tab, "tab", ""), false, None));
    assert_eq!(agent_msgs(&out).len(), 1);
    assert!(c.reconcile().is_empty(), "attached once");
}

#[test]
fn the_agents_sessions_survive_a_monitor_resync() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let tab_s = "1CF98BE4CA0A5A7A7E5CEF248DCB8E78";
    // The monitor reconnects: it knows A's tab again before it knows the tab's page.
    c.reg.resync();
    c.reg.target_seen(&info(A_TAB, "tab", "about:blank"), false);
    let out = c.reconcile();
    assert!(out.is_empty(), "nothing is taken from A meanwhile: {out:?}");
    let out = c.agent(cmd(70, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }), Some(tab_s)));
    assert_eq!(browser_msgs(&out).len(), 1, "{out:?}");
    c.reg.tab_shows(A_TAB, &info(A_PAGE, "page", "about:blank"));
    c.reg.synced_now();
    assert!(c.reconcile().is_empty());
    assert_eq!(c.reg.id_vis(&who("a"), A_TAB), Vis::Mine);
}

#[test]
fn an_attachment_is_a_host_and_an_agent() {
    // The same agent id on another host is another attachment: `h1/a`'s tabs do not exist for it.
    let elsewhere = AttachKey { host_id: "h2".into(), agent_id: "a".into() };
    let mut reg = world();
    reg.attach(&elsewhere);
    reg.opened(&elsewhere, "H2PAGE");
    assert_eq!(reg.id_vis(&who("a"), A_PAGE), Vis::Mine);
    assert_eq!(reg.id_vis(&elsewhere, A_PAGE), Vis::Foreign);
    assert_eq!(reg.id_vis(&who("a"), "H2PAGE"), Vis::Foreign);
    let mut c = Conn::for_key(reg, elsewhere.clone(), B_BROWSER);
    assert_error(&c.agent(cmd(1, "Target.attachToTarget", json!({ "targetId": A_PAGE, "flatten": true }), None)), 1, -32602, "No target with given id found");
    assert_error(&c.agent(cmd(2, "Target.closeTarget", json!({ "targetId": A_PAGE }), None)), 2, -32602, "No target with given id found");
    // The app shows each tab with its own host, and detaching one attachment leaves the other's tabs.
    let owner = |reg: &Registry, page: &str| reg.tabs().into_iter().find(|t| t.target_id == page).map(|t| (t.host_id, t.agent_id, t.detached));
    assert_eq!(owner(&c.reg, A_PAGE), Some(("h1".into(), "a".into(), false)));
    assert_eq!(owner(&c.reg, "H2PAGE"), Some(("h2".into(), "a".into(), false)));
    c.reg.detach(&elsewhere);
    assert_eq!(owner(&c.reg, A_PAGE), Some(("h1".into(), "a".into(), false)));
    assert_eq!(owner(&c.reg, "H2PAGE"), Some(("h2".into(), "a".into(), true)));
}

#[test]
fn a_lent_tab_is_listed_attached_and_driven_like_the_agents_own() {
    let mut c = Conn::a();
    c.reg.lend(USER_PAGE, &who("a")).unwrap();
    // The browser's list holds every target; the lent tab is in A's, B's tab is not.
    c.agent(cmd(1, "Target.getTargets", json!({}), None));
    let all = vec![
        info(USER_TAB, "tab", "https://mail.example/"),
        info(USER_PAGE, "page", "https://mail.example/"),
        info(B_TAB, "tab", "about:blank"),
        info(B_PAGE, "page", "about:blank"),
        info(A_PAGE, "page", "about:blank"),
    ];
    let out = c.browser(answer(1, json!({ "targetInfos": all }), None));
    let mut want = vec![USER_TAB.to_string(), USER_PAGE.to_string(), A_PAGE.to_string()];
    want.sort();
    assert_eq!(ids(agent_msgs(&out)[0]["result"]["targetInfos"].as_array().unwrap()), want);
    // It attaches it by id and drives it; the app shows the work on it.
    let page_s = "LENTPAGESESSION00000000000000000A";
    let out = c.agent(cmd(2, "Target.attachToTarget", json!({ "targetId": USER_PAGE, "flatten": true }), None));
    assert_eq!(browser_msgs(&out).len(), 1);
    assert_eq!(agent_msgs(&c.browser(attached(page_s, info(USER_PAGE, "page", "https://mail.example/"), false, None))).len(), 1);
    let eval = cmd(3, "Runtime.evaluate", json!({ "expression": "document.title" }), Some(page_s));
    assert_eq!(browser_msgs(&c.agent(eval.clone())), vec![eval]);
    let lent = c.reg.tabs().into_iter().find(|t| t.target_id == USER_PAGE).unwrap();
    assert!(lent.lent && !lent.detached && !lent.taken_over);
    assert_eq!(lent.active_at, Some(1_000));
}

#[test]
fn a_popup_belongs_to_whoever_has_its_opener() {
    let mut reg = world();
    let mut mon = Monitor::default();
    for m in mon.start() {
        let id = serde_json::from_str::<Value>(&m).unwrap()["id"].as_i64().unwrap();
        mon.on_message(&mut reg, &answer(id, json!({}), None));
    }
    let mut opens = |reg: &mut Registry, popup: &str, opener: &str| {
        mon.on_message(reg, &json!({ "method": "Target.targetCreated", "params": { "targetInfo": popup_info(popup, opener) } }));
    };
    // A popup of a popup is the agent's too.
    opens(&mut reg, "POPUP1", A_PAGE);
    opens(&mut reg, "POPUP2", "POPUP1");
    assert_eq!((reg.id_vis(&who("a"), "POPUP1"), reg.id_vis(&who("a"), "POPUP2")), (Vis::Mine, Vis::Mine));
    assert!(reg.tabs().iter().any(|t| t.target_id == "POPUP2" && t.agent_id == "a" && !t.lent), "the app lists it as the agent's");
    // While the user has the page, what opens from it is the user's.
    reg.take_over(A_PAGE).unwrap();
    opens(&mut reg, "POPUP3", A_PAGE);
    assert_eq!(reg.id_vis(&who("a"), "POPUP3"), Vis::Foreign);
    assert!(reg.tabs().iter().all(|t| t.target_id != "POPUP3"));
    // Handed back, the agent's again.
    reg.hand_back(A_PAGE).unwrap();
    opens(&mut reg, "POPUP4", A_PAGE);
    assert_eq!(reg.id_vis(&who("a"), "POPUP4"), Vis::Mine);
}

#[test]
fn a_popup_of_the_users_page_attached_paused_at_the_browser_level_is_released_at_once() {
    let mut c = Conn::a();
    // Legacy auto-attach of pages at the browser level, waiting for the debugger.
    c.agent(cmd(1, "Target.setAutoAttach", json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }), None));
    c.browser(answer(1, json!({}), None));
    let popup = "8217AE13340966408DD36338B924BB40";
    let out = c.browser(attached("USERPOPUP", popup_info(popup, USER_PAGE), true, None));
    assert!(agent_msgs(&out).is_empty(), "{out:?}");
    let sent = browser_msgs(&out);
    assert_eq!(sent.len(), 2, "{sent:?}");
    assert_eq!((sent[0]["method"].as_str(), sent[0]["sessionId"].as_str()), (Some("Runtime.runIfWaitingForDebugger"), Some("USERPOPUP")));
    assert_eq!((sent[1]["method"].as_str(), sent[1]["params"]["sessionId"].as_str()), (Some("Target.detachFromTarget"), Some("USERPOPUP")));
}

#[test]
fn an_agent_may_only_move_the_windows_of_its_own_tabs() {
    let mut c = Conn::a();
    // Chrome tells it the window of its own tab.
    c.agent(cmd(1, "Browser.getWindowForTarget", json!({ "targetId": A_PAGE }), None));
    c.browser(answer(1, json!({ "windowId": 7, "bounds": { "left": 0, "top": 0, "width": 800, "height": 600, "windowState": "normal" } }), None));
    let resize = |id: i64, window: i64| cmd(id, "Browser.setWindowBounds", json!({ "windowId": window, "bounds": { "width": 1024, "height": 768 } }), None);
    assert_eq!(browser_msgs(&c.agent(resize(2, 7))).len(), 1);
    // The user's window (never shown to it) and another agent's do not exist for it.
    assert_error(&c.agent(resize(3, 3)), 3, -32000, "Browser window not found");
    assert_error(&c.agent(cmd(4, "Browser.getWindowBounds", json!({ "windowId": 3 }), None)), 4, -32000, "Browser window not found");
    let mut b = Conn::new(std::mem::take(&mut c.reg), "b", B_BROWSER);
    assert_error(&b.agent(resize(5, 7)), 5, -32000, "Browser window not found");
}

#[test]
fn dialogs_and_file_choosers_of_the_agents_tab_go_to_the_agent() {
    let mut c = Conn::a();
    let (_, page_s, _) = a_with_page(&mut c);
    let s = Some(page_s);
    // It asks for the file chooser instead of the browser's own dialog, and answers dialogs itself.
    let intercept = cmd(80, "Page.setInterceptFileChooserDialog", json!({ "enabled": true }), s);
    assert_eq!(browser_msgs(&c.agent(intercept.clone())), vec![intercept]);
    for ev in [
        json!({ "method": "Page.javascriptDialogOpening", "params": { "url": "https://app.example/", "message": "Delete the invoice?", "type": "confirm", "hasBrowserHandler": false, "defaultPrompt": "" }, "sessionId": page_s }),
        json!({ "method": "Page.fileChooserOpened", "params": { "frameId": A_PAGE, "mode": "selectSingle", "backendNodeId": 12 }, "sessionId": page_s }),
    ] {
        assert_eq!(agent_msgs(&c.browser(ev.clone())), vec![ev]);
    }
    let accept = cmd(81, "Page.handleJavaScriptDialog", json!({ "accept": true }), s);
    assert_eq!(browser_msgs(&c.agent(accept.clone())), vec![accept]);
    // A dialog in a tab that is not its own never reaches it.
    let theirs = json!({ "method": "Page.javascriptDialogOpening", "params": { "message": "hi", "type": "alert" }, "sessionId": "8D7BB6A6384FE96F56262F8DCDC57284" });
    assert!(c.browser(theirs).is_empty());
}

#[test]
fn the_user_closing_an_agents_tab_ends_its_sessions_and_tells_it() {
    let mut c = Conn::a();
    let (tab_s, page_s, frame_s) = a_with_page(&mut c);
    // Chrome closes the page: its sessions detach, innermost first, and its targets go.
    let gone = |id: &str| json!({ "method": "Target.targetDestroyed", "params": { "targetId": id } });
    for ev in [detached(frame_s, "OOPIF1", Some(page_s)), detached(page_s, A_PAGE, Some(tab_s)), detached(tab_s, A_TAB, None), gone(A_PAGE), gone(A_TAB)] {
        assert_eq!(agent_msgs(&c.browser(ev.clone())), vec![ev]);
    }
    c.reg.target_gone(A_PAGE);
    c.reg.target_gone(A_TAB);
    assert!(c.reg.tabs().iter().all(|t| t.target_id != A_PAGE), "the app's list forgets it");
    assert!(c.reconcile().is_empty());
    assert_error(&c.agent(cmd(90, "Runtime.evaluate", json!({ "expression": "1" }), Some(page_s))), 90, -32001, "Session with given id not found");
}

#[test]
fn an_agents_activity_is_recorded_at_most_every_two_seconds_and_only_on_its_own_tabs() {
    let mut reg = world();
    reg.shown_changed = false;
    let a = who("a");
    let at = |reg: &Registry, page: &str| reg.tabs().iter().find(|t| t.target_id == page).and_then(|t| t.active_at);
    reg.touch(&a, Some(A_PAGE), 10_000);
    assert!(std::mem::take(&mut reg.shown_changed), "the app shows it");
    assert_eq!((reg.active_at(&a), at(&reg, A_PAGE)), (Some(10_000), Some(10_000)));
    // A busy agent does not make the app redraw on every command.
    reg.touch(&a, Some(A_PAGE), 11_999);
    assert!(!reg.shown_changed);
    reg.touch(&a, Some(A_PAGE), 12_000);
    assert!(std::mem::take(&mut reg.shown_changed));
    assert_eq!((reg.active_at(&a), at(&reg, A_PAGE)), (Some(12_000), Some(12_000)));
    // A page that is another's is not marked, nor is another agent.
    reg.touch(&a, Some(B_PAGE), 20_000);
    assert_eq!((at(&reg, B_PAGE), reg.active_at(&who("b"))), (None, None));
}

#[test]
fn a_tab_lent_again_after_the_user_took_it_back_is_shown_to_the_agent_again() {
    let mut c = Conn::a();
    c.puppeteer_start();
    let lend = |c: &mut Conn| {
        c.reg.lend(USER_PAGE, &who("a")).unwrap();
        c.reconcile()
    };
    // The id of the attach of the lent tab the filter sent for the agent's auto-attach.
    let attach_asked = |out: &[Out]| {
        browser_msgs(out).iter().find(|m| m["method"] == "Target.attachToTarget" && m["params"]["targetId"] == USER_TAB).map(|m| m["id"].as_i64().unwrap())
    };
    let first = attach_asked(&lend(&mut c)).expect("Puppeteer's auto-attach takes the tab");
    c.browser(attached("LENTTAB", info(USER_TAB, "tab", "https://mail.example/"), false, None));
    c.browser(attached("LENTPAGE", info(USER_PAGE, "page", "https://mail.example/"), false, Some("LENTTAB")));
    c.browser(answer(first, json!({ "sessionId": "LENTTAB" }), None));
    // The user takes it back for good; the agent's sessions on it end.
    c.reg.take_over(USER_PAGE).unwrap();
    assert_eq!(agent_msgs(&c.reconcile()), vec![detached("LENTPAGE", USER_PAGE, Some("LENTTAB")), detached("LENTTAB", USER_TAB, None)]);
    // Lent again, on the same connection: the tab is attached for the agent again, as the first time.
    let again = attach_asked(&lend(&mut c)).expect("the tab is shown to the agent again");
    assert_eq!(agent_msgs(&c.browser(attached("LENTTAB2", info(USER_TAB, "tab", "https://mail.example/"), false, None))).len(), 1);
    assert_eq!(agent_msgs(&c.browser(attached("LENTPAGE2", info(USER_PAGE, "page", "https://mail.example/"), false, Some("LENTTAB2")))).len(), 1);
    c.browser(answer(again, json!({ "sessionId": "LENTTAB2" }), None));
    let eval = cmd(1, "Runtime.evaluate", json!({ "expression": "document.title" }), Some("LENTPAGE2"));
    assert_eq!(browser_msgs(&c.agent(eval.clone())), vec![eval]);
    assert!(c.reconcile().is_empty(), "attached once");
}

#[test]
fn a_tab_lent_before_the_agent_connects_is_attached_once() {
    let mut c = Conn::a();
    c.reg.lend(USER_PAGE, &who("a")).unwrap();
    // Chrome attaches every tab there is for the agent's auto-attach: the lent one is among its own.
    let out = c.puppeteer_start();
    let shown: Vec<String> = agent_msgs(&out)
        .iter()
        .filter(|m| m["method"] == "Target.attachedToTarget")
        .map(|m| m["params"]["targetInfo"]["targetId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(shown, vec![USER_TAB, A_TAB]);
    assert!(c.reconcile().is_empty(), "the filter does not attach it a second time");
}

#[test]
fn a_tab_can_be_taken_over_and_handed_back_again_and_again() {
    let mut c = Conn::a();
    let (tab_s, page_s, _) = a_with_page(&mut c);
    take_over_a(&mut c, tab_s, page_s);
    let hand_back = |c: &mut Conn, fresh: &str| -> Vec<Value> {
        c.reg.hand_back(A_PAGE).unwrap();
        let sent = browser_msgs(&c.reconcile());
        assert_eq!((sent.len(), sent[0]["method"].as_str(), sent[0]["sessionId"].as_str()), (1, Some("Target.attachToTarget"), Some(tab_s)));
        let a = agent_msgs(&c.browser(attached(fresh, info(A_PAGE, "page", "https://inbox.example/"), false, Some(tab_s))));
        c.browser(answer(sent[0]["id"].as_i64().unwrap(), json!({ "sessionId": fresh }), Some(tab_s)));
        a
    };
    // First hand back: the old page session ends, the new one arrives as an activated prerender.
    let a = hand_back(&mut c, "PAGE2");
    assert_eq!((a.len(), &a[0]["params"]["sessionId"], &a[1]["params"]["sessionId"]), (4, &json!("FRAMESESSION0000000000000000000A"), &json!(page_s)));
    assert_eq!(a[2]["params"]["sessionId"], "PAGE2");
    let eval = |id: i64, session: &str| cmd(id, "Runtime.evaluate", json!({ "expression": "document.title" }), Some(session));
    assert_eq!(browser_msgs(&c.agent(eval(60, "PAGE2"))).len(), 1);
    // Taken over again: the new page session is detached under the kept tab session, the agent is told nothing.
    c.reg.take_over(A_PAGE).unwrap();
    let out = c.reconcile();
    assert!(agent_msgs(&out).is_empty(), "{out:?}");
    let sent = browser_msgs(&out);
    assert_eq!((sent.len(), sent[0]["method"].as_str(), sent[0]["params"]["sessionId"].as_str(), sent[0]["sessionId"].as_str()), (1, Some("Target.detachFromTarget"), Some("PAGE2"), Some(tab_s)));
    assert!(c.browser(detached("PAGE2", A_PAGE, Some(tab_s))).is_empty());
    assert_error(&c.agent(eval(61, "PAGE2")), 61, -32000, TAKEN_OVER);
    assert_error(&c.agent(cmd(62, "Target.setAutoAttach", json!({ "autoAttach": true, "flatten": true }), Some(tab_s))), 62, -32000, TAKEN_OVER);
    // Second hand back: the same again.
    let a = hand_back(&mut c, "PAGE3");
    assert_eq!((a.len(), &a[0]["params"]["sessionId"], &a[1]["params"]["sessionId"]), (3, &json!("PAGE2"), &json!("PAGE3")), "{a:?}");
    assert_eq!(a[2]["method"], "Target.targetInfoChanged");
    assert_eq!(browser_msgs(&c.agent(eval(63, "PAGE3"))).len(), 1);
    assert_error(&c.agent(eval(64, "PAGE2")), 64, -32001, "Session with given id not found");
    assert_eq!(browser_msgs(&c.agent(cmd(65, "Target.setAutoAttach", json!({ "autoAttach": true, "flatten": true }), Some(tab_s)))).len(), 1);
}
