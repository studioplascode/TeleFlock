//! The TeleFlock Browser: one persistent Chromium per desktop device that the user browses with
//! (logged in as themselves) and that omp agents drive only with the user's consent.
//!
//! * App methods (`browser.*`, served by the app core: `tf-client`, `browser` module) and
//!   [`crate::app::AppEvent::Browser`]: the browser's lifecycle and engine, the agents attached to it,
//!   the tabs they own and their pending requests ([`BrowserStatus`]). The UI renders the pages itself
//!   over the browser's own DevTools endpoint ([`BrowserStatus::ws_url`], open to the app's origins
//!   only).
//! * Agents never get that endpoint. `agent.browserAttach` makes tf-hostd listen on
//!   `127.0.0.1:<port>` on the agent's host and point the agent's omp at it (a runtime override of
//!   omp's `browser.cdpUrl`, never persisted). Each connection to that port is a forwarding stream
//!   ([`crate::forward::FwdEv`], kind [`crate::forward::ForwardKind::Browser`], wire feature
//!   [`crate::host::FEATURE_BROWSER`]) that tf-hostd opens towards the attaching app, whose DevTools
//!   proxy serves it: the agent sees and drives only the tabs it opened there and the tabs the user
//!   lent it ([`BrowserTabOwner`]), and browser-wide commands that would hurt the user or other
//!   agents are refused.
//! * The bridge tool `use_user_browser` asks the user: the agent's board card carries the request
//!   ([`AgentBrowser::request`]) and shows it as a needs-you question
//!   ([`crate::model::NeedsYou::browser`]); `browser.answer` allows (attaches) or denies it.

use crate::Millis;

wire_enum! {
    /// * `off`: not running (start it with `browser.start`, or attach an agent).
    /// * `starting`: launching, or restarting after a crash.
    /// * `running`: DevTools answer at [`BrowserStatus::cdp_port`].
    /// * `error`: it failed to start or kept crashing ([`BrowserStatus::message`]), or the
    ///   organization's policy blocks it ([`BrowserStatus::blocked`]).
    /// * `unavailable`: no engine on this device (`browser.installEngine` downloads Chrome for
    ///   Testing on consent), or a device without the browser (Android).
    pub enum BrowserState { Off, Starting, Running, Error, Unavailable }
}

wire_struct! {
    /// A Chromium-family browser the app can run.
    pub struct BrowserEngine {
        /// `Google Chrome`, `Chromium`, `Microsoft Edge`, `Brave`, `Chrome for Testing`, or the file
        /// name of a configured path.
        pub name: String,
        pub path: String,
        /// `x.y.z.w`, when known.
        pub version: Option<String>,
        /// TeleFlock's own browser: the Chrome for Testing it downloaded (`browser.installEngine`).
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub builtin: bool,
        /// The organization's policy blocked remote control of it the last time it was started here
        /// ([`BrowserBlocked`]): Automatic passes it over; choosing it tries it again.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub blocked: bool,
    }
}

wire_enum! {
    /// What TeleFlock does about an engine the organization's policy blocks ([`BrowserBlocked`]):
    /// * `switched`: it runs its own browser (Chrome for Testing) instead, the chosen engine from
    ///   now on.
    /// * `offer`: its own browser is not downloaded yet; `browser.installEngine {start: true}`
    ///   downloads it, chooses it and starts it.
    /// * `unavailable`: nothing is left: its own browser is blocked too, or has no build for this
    ///   computer.
    pub enum BrowserFallback { Switched, Offer, Unavailable }
}

wire_struct! {
    /// A start found the engine blocked for remote control by the organization's policy
    /// (`RemoteDebuggingAllowed` false; for Chrome for Testing also `ChromeForTestingAllowed` false):
    /// the browser said so on stderr (or exited with Chrome's "disallowed by policy" code) and was
    /// stopped at once. Kept until the next start or stop.
    pub struct BrowserBlocked {
        /// The engine that refused.
        pub engine: BrowserEngine,
        pub fallback: BrowserFallback,
        /// `offer`: TeleFlock's own browser, as it would be downloaded.
        pub download: Option<BrowserDownload>,
        pub at: Millis,
    }
}

wire_enum! {
    /// How long an agent may drive the browser: `session` until detached; `turn` until the
    /// agent's current turn ends ("Allow once").
    pub enum BrowserScope { Session, Turn }
}

wire_struct! {
    /// An agent that can drive this device's browser right now.
    pub struct BrowserAttachment {
        pub host_id: String,
        pub agent_id: String,
        pub agent_name: String,
        pub since: Millis,
        /// The port tf-hostd listens on, on the agent's host (`http://127.0.0.1:<hostPort>` is the
        /// agent's `browser.cdpUrl`).
        pub host_port: u16,
        pub scope: BrowserScope,
        /// DevTools connections the agent has open right now.
        pub connections: u32,
        /// When the agent last sent the browser a command (updated at most every ~2 s).
        pub active_at: Option<Millis>,
    }
}

wire_struct! {
    /// An agent asks to use the browser (`use_user_browser`): answer with `browser.answer`.
    pub struct BrowserRequest {
        pub id: String,
        pub host_id: String,
        pub agent_id: String,
        pub agent_name: String,
        /// Why, in the agent's words.
        pub reason: String,
        pub at: Millis,
        /// The user allowed it, but [`BrowserStatus::cap`] agents use the browser: it attaches when
        /// one of them is detached (oldest first), or now with `browser.answer {overCap: true}`.
        pub waiting: bool,
        /// The scope it was allowed with (`waiting`).
        pub scope: Option<BrowserScope>,
    }
}

wire_struct! {
    /// A tab that is not plainly the user's: an agent opened it, or the user lent it to one. Tabs
    /// missing from [`BrowserStatus::tabs`] are the user's, and no agent can see them.
    pub struct BrowserTabOwner {
        /// DevTools target id of the tab's page.
        pub target_id: String,
        pub host_id: String,
        pub agent_id: String,
        pub agent_name: String,
        /// The user's tab, lent to the agent ("Let <agent> use this tab"); `browser.takeOver` gives
        /// it back to the user.
        pub lent: bool,
        /// The user took it over: the agent cannot see or drive it until `browser.handBack`.
        pub taken_over: bool,
        /// The agent's attachment ended; the tab stays open ("from <agent>") until it is closed.
        pub detached: bool,
        /// When the agent last sent this tab a command (updated at most every ~2 s).
        pub active_at: Option<Millis>,
    }
}

wire_struct! {
    /// A Chrome for Testing download (`browser.installEngine`; `browser.cancelInstall` stops it).
    pub struct BrowserInstall {
        pub version: String,
        /// 0–100 while downloading and unpacking; absent before the size is known.
        pub progress: Option<u8>,
        /// Why it failed (the download is over then).
        pub error: Option<String>,
    }
}

wire_struct! {
    /// `browser.*` results and [`crate::app::AppEvent::Browser`].
    pub struct BrowserStatus {
        pub state: BrowserState,
        /// The engine it runs (or would run).
        pub engine: Option<BrowserEngine>,
        /// Runs in its own window ("Open in its own window") instead of headless.
        pub headed: bool,
        /// Its DevTools port on this device's loopback (`running`).
        pub cdp_port: Option<u16>,
        /// The browser target's DevTools WebSocket (`ws://127.0.0.1:<cdpPort>/devtools/browser/<id>`),
        /// open to the app's own origins only (`--remote-allow-origins`). Every tab, the user's and
        /// the agents'.
        pub ws_url: Option<String>,
        /// The persistent profile: cookies, logins, storage and history live here.
        pub profile_dir: String,
        /// Where downloads go (`Browser.setDownloadBehavior` `allow` with this path);
        /// `browser.revealDownload` opens paths under it.
        pub download_dir: Option<String>,
        /// Why it is `error` or `unavailable`, or what it is doing; `running` after a
        /// [`BrowserFallback::Switched`]: why it runs TeleFlock's own browser.
        pub message: Option<String>,
        /// The last start found an engine blocked by the organization's policy, and what TeleFlock
        /// did about it.
        pub blocked: Option<BrowserBlocked>,
        /// A Chrome for Testing download in progress or failed.
        pub install: Option<BrowserInstall>,
        /// How many agents may be attached at once ([`BrowserConfig::cap`]).
        pub cap: u32,
        pub attachments: Vec<BrowserAttachment>,
        pub requests: Vec<BrowserRequest>,
        pub tabs: Vec<BrowserTabOwner>,
    }
}

wire_struct! {
    /// `browser.start`: starts the browser, or relaunches it in the other mode.
    pub struct BrowserStartParams {
        /// In its own window (sites that refuse embedded or automated browsers: some sign-ins,
        /// passkeys); absent: [`BrowserConfig::headed`].
        pub headed: Option<bool>,
    }
}

wire_struct! {
    /// `browser.installEngine`: downloads TeleFlock's own browser (Chrome for Testing).
    pub struct BrowserInstallParams {
        /// Once it is downloaded, choose it as the engine and start the browser with it ("Use
        /// TeleFlock's browser").
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        #[ts(as = "Option<bool>", optional)]
        pub start: bool,
    }
}

wire_struct! {
    /// `browser.attach` / `browser.detach`.
    pub struct BrowserAgentParams {
        pub host_id: String,
        pub agent_id: String,
        /// `browser.attach`: attach even though [`BrowserStatus::cap`] agents use the browser
        /// (without it: `browser_busy`).
        pub over_cap: Option<bool>,
    }
}

wire_struct! {
    /// `browser.answer`: allow (attaching the agent, which starts the browser if needed) or deny a
    /// [`BrowserRequest`].
    pub struct BrowserAnswerParams {
        pub request_id: String,
        pub allow: bool,
        /// With `allow`; default `session`.
        pub scope: Option<BrowserScope>,
        /// With `allow`: attach now even at the cap (else the request waits for a free slot).
        pub over_cap: Option<bool>,
    }
}

wire_struct! {
    /// `browser.takeOver` / `browser.handBack`: one tab.
    pub struct BrowserTabParams {
        pub target_id: String,
    }
}

wire_struct! {
    /// `browser.lendTab`: lets an attached agent see and drive one of the user's tabs.
    pub struct BrowserLendParams {
        pub target_id: String,
        pub host_id: String,
        pub agent_id: String,
    }
}

wire_struct! {
    /// Chrome for Testing as this app pins it: TeleFlock's own browser (`browser.installEngine`).
    pub struct BrowserDownload {
        pub version: String,
        /// A build exists for this device's OS and CPU.
        pub available: bool,
        /// Already downloaded into the app's data dir.
        pub installed: bool,
        /// The download's size in bytes (`available`).
        pub size: Option<u64>,
    }
}

wire_struct! {
    /// `browser.config` / `browser.configSet` result.
    pub struct BrowserConfig {
        /// The engine the user chose; absent: the first one found that the organization's policy
        /// does not block.
        pub engine_path: Option<String>,
        /// Start in its own window when the app starts it (an attach, an allowed request,
        /// `browser.start` without `headed`).
        pub headed: bool,
        /// Agents attached at once; more wait for a free slot (default 4).
        pub cap: u32,
        /// Engines found on this device, in the order they are preferred.
        pub engines: Vec<BrowserEngine>,
        pub download: BrowserDownload,
    }
}

wire_struct! {
    /// `browser.configSet`: replaces the saved config (absent fields: defaults).
    pub struct BrowserConfigSetParams {
        pub engine_path: Option<String>,
        pub headed: Option<bool>,
        /// 1–16.
        pub cap: Option<u32>,
    }
}

wire_enum! {
    /// `browser.clearData`: `cookies` (signs out everywhere), `cache`, or `everything` (the whole
    /// profile: history, storage, logins, settings; the browser restarts with a new profile).
    pub enum BrowserClearWhat { Cookies, Cache, Everything }
}

wire_struct! {
    pub struct BrowserClearParams {
        pub what: BrowserClearWhat,
    }
}

wire_struct! {
    /// `browser.stageFile`: a file the UI picked for a page's file chooser, written where the
    /// browser can read it (`DOM.setFileInputFiles` takes paths on this device). At most 32 MiB;
    /// staged files go when the browser starts or stops.
    pub struct BrowserStageParams {
        pub name: String,
        /// Base64.
        pub data: String,
    }
}

wire_struct! {
    pub struct BrowserStaged {
        pub path: String,
    }
}

wire_struct! {
    /// `browser.revealDownload`: shows a downloaded file's folder in the system's file manager
    /// (only paths under [`BrowserStatus::download_dir`]).
    pub struct BrowserRevealParams {
        pub path: String,
    }
}

// ───────────────────────────── wire (tf-client ⇄ tf-hostd) ─────────────────────────────

wire_struct! {
    /// The TeleFlock Browser on an agent's board card ([`crate::model::Agent::browser`], hosts
    /// ≥ 0.9.0).
    pub struct AgentBrowser {
        /// Its pending `use_user_browser` request.
        pub request: Option<BrowserAsk>,
        /// The browser it can drive now.
        pub attached: Option<BrowserLent>,
    }
}

wire_struct! {
    /// A pending `use_user_browser` request.
    pub struct BrowserAsk {
        pub id: String,
        /// Why, in the agent's words.
        pub reason: String,
        pub at: Millis,
    }
}

wire_struct! {
    /// Whose browser an agent drives.
    pub struct BrowserLent {
        /// The device of the app that lent it ([`crate::host::ClientInfo::device`]).
        pub device: String,
        pub since: Millis,
        pub scope: BrowserScope,
    }
}

wire_struct! {
    /// `agent.browserAttach`: tf-hostd listens on `127.0.0.1:<port>` (`port` absent, 0 or taken: a
    /// free one), streams each connection to the calling app (kind `browser`), and sets the
    /// agent's omp `browser.cdpUrl` (runtime override) to it. Attaching again moves the attachment
    /// to the calling app. Answers the agent's pending request, if any, as allowed.
    pub struct BrowserAttachParams {
        pub agent_id: String,
        pub port: Option<u16>,
        /// Default `session`.
        pub scope: Option<BrowserScope>,
    }
}

wire_struct! {
    pub struct BrowserAttached {
        pub port: u16,
        /// What the agent's omp uses (`http://127.0.0.1:<port>`).
        pub cdp_url: String,
    }
}

wire_struct! {
    /// `agent.browserAnswer`: `allow: false` denies a pending request; `allow: true` answers it
    /// with the attachment the agent already has from this app (else `invalid_params`).
    pub struct BrowserAnswerHostParams {
        pub request_id: String,
        pub allow: bool,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_shapes() {
        let s = BrowserStatus {
            state: BrowserState::Running,
            engine: Some(BrowserEngine { name: "Chromium".into(), path: "/usr/bin/chromium".into(), version: None, builtin: false, blocked: false }),
            headed: false,
            cdp_port: Some(40123),
            ws_url: Some("ws://127.0.0.1:40123/devtools/browser/x".into()),
            profile_dir: "/d/browser/profile".into(),
            download_dir: None,
            message: None,
            blocked: None,
            install: None,
            cap: 4,
            attachments: vec![BrowserAttachment {
                host_id: "h".into(),
                agent_id: "a".into(),
                agent_name: "ada".into(),
                since: 1,
                host_port: 9300,
                scope: BrowserScope::Turn,
                connections: 0,
                active_at: None,
            }],
            requests: vec![],
            tabs: vec![],
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "running");
        assert_eq!(v["cdpPort"], 40123);
        assert_eq!(v["attachments"][0]["scope"], "turn");
        assert_eq!(v["attachments"][0]["hostPort"], 9300);
        assert!(v.get("downloadDir").is_none(), "None fields are left out");
        assert_eq!(v["engine"], serde_json::json!({ "name": "Chromium", "path": "/usr/bin/chromium" }), "false flags are left out");
        let chrome = BrowserEngine { name: "Google Chrome".into(), path: "/opt/google/chrome/chrome".into(), version: None, builtin: false, blocked: true };
        let download = BrowserDownload { version: "156.0.8078.80".into(), available: true, installed: false, size: Some(201_329_937) };
        let blocked = BrowserBlocked { engine: chrome, fallback: BrowserFallback::Offer, download: Some(download), at: 7 };
        let v = serde_json::to_value(&blocked).unwrap();
        assert_eq!((v["fallback"].as_str(), v["engine"]["blocked"].as_bool(), v["download"]["size"].as_u64()), (Some("offer"), Some(true), Some(201_329_937)));
        let i: BrowserInstallParams = serde_json::from_str("{}").unwrap();
        assert!(!i.start, "a plain download");
        assert!(serde_json::from_str::<BrowserInstallParams>(r#"{"start":true}"#).unwrap().start);
        let p: BrowserAttachParams = serde_json::from_str(r#"{"agentId":"a"}"#).unwrap();
        assert_eq!(p, BrowserAttachParams { agent_id: "a".into(), port: None, scope: None });
        let c: BrowserConfigSetParams = serde_json::from_str(r#"{"enginePath":null}"#).unwrap();
        assert_eq!((c.engine_path, c.headed, c.cap), (None, None, None));
        let w: BrowserClearParams = serde_json::from_str(r#"{"what":"everything"}"#).unwrap();
        assert_eq!(w.what, BrowserClearWhat::Everything);
        let b = AgentBrowser { request: Some(BrowserAsk { id: "r".into(), reason: "log in".into(), at: 5 }), attached: None };
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"request":{"id":"r","reason":"log in","at":5}}"#);
    }
}
