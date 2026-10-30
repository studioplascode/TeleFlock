//! Linux desktop notifications: `org.freedesktop.Notifications` spoken directly over the session
//! bus (zbus, already in the build through the single-instance plugin; every desktop ships the
//! server: GNOME Shell, KDE Plasma, xfce4-notifyd, dunst, mako).
//!
//! * One connection both sends and receives (some servers, dunst among them, send a notification's
//!   signals only to the connection that posted it), a match rule on the server's signals and one
//!   listener thread. Calls (`Notify`, `CloseNotification`) run in order on a worker thread, so
//!   the engine's tokio tasks never wait on D-Bus.
//! * One live notification per agent: the same tag re-posts with the old server id as
//!   `replaces_id`. A retract closes the notification only while the tag still shows it.
//! * Body click = the `default` action (the shell brings the window forward). Buttons are
//!   `a:<id>` actions (servers with the `actions` capability only), the reply is KDE's inline
//!   reply (`inline-reply` capability, `NotificationReplied`). `NotificationClosed` with reason 2
//!   (dismissed by the user) reports [`ToastEvent::Dismissed`]; our own closes and expiry report
//!   nothing.
//! * Wayland focus: servers newer than spec 1.3 send an `ActivationToken` before `ActionInvoked`;
//!   GTK only reads such a token at startup, so a tap raises the window without one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak, mpsc};
use std::time::Duration;

use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::Value;

use crate::present::{Category, MAX_BUTTONS, Presentation, Sink, ToastEvent};

const DEST: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const APP_NAME: &str = "TeleFlock";
/// Basename of the desktop file the .deb / Arch package installs (`TeleFlock.desktop`).
const DESKTOP_ENTRY: &str = "TeleFlock";
/// Icon name the packages install under `hicolor/*/apps/`.
const THEME_ICON: &str = "teleflock";
const ACTION_DEFAULT: &str = "default";
const ACTION_REPLY: &str = "inline-reply";
const ACTION_PREFIX: &str = "a:";
const SOUND_NAME: &str = "message-new-instant";
const REPLY_PLACEHOLDER: &str = "Reply to the agent";
/// How long quitting waits for the notifications to be closed.
const CLEAR_WAIT: Duration = Duration::from_secs(2);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------------
// Identity: app icon and desktop entry
// ---------------------------------------------------------------------------------------------

/// How notifications identify TeleFlock to the server.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Identity {
    /// `app_icon`: the theme icon name when installed by a package, else an absolute PNG path
    /// (written once to the app's data dir), else empty.
    pub icon: String,
    /// `desktop-entry` hint (lets the shell group, mute and attribute); only when the package
    /// installed the desktop file.
    pub desktop_entry: Option<String>,
}

impl Identity {
    /// Looks for the packaged desktop file and icon in the XDG data dirs; falls back to
    /// `icon_png` written into `icon_dir` (AppImage, `cargo run`).
    pub fn detect(icon_dir: Option<&Path>, icon_png: &[u8]) -> Self {
        let dirs = data_dirs(
            std::env::var("XDG_DATA_HOME").ok().as_deref(),
            std::env::var("XDG_DATA_DIRS").ok().as_deref(),
            std::env::var("HOME").ok().as_deref(),
        );
        Self::from_dirs(&dirs, icon_dir, icon_png)
    }

    fn from_dirs(dirs: &[PathBuf], icon_dir: Option<&Path>, icon_png: &[u8]) -> Self {
        let desktop = dirs.iter().any(|d| d.join("applications").join(format!("{DESKTOP_ENTRY}.desktop")).is_file());
        let themed = dirs
            .iter()
            .any(|d| d.join("icons/hicolor/128x128/apps").join(format!("{THEME_ICON}.png")).is_file());
        let icon = if themed {
            THEME_ICON.to_owned()
        } else {
            icon_dir
                .and_then(|dir| {
                    let path = dir.join("teleflock-notification.png");
                    std::fs::create_dir_all(dir).ok()?;
                    std::fs::write(&path, icon_png).ok()?;
                    path.to_str().map(str::to_owned)
                })
                .unwrap_or_default()
        };
        Self { icon, desktop_entry: desktop.then(|| DESKTOP_ENTRY.to_owned()) }
    }
}

/// `$XDG_DATA_HOME` (default `~/.local/share`) then `$XDG_DATA_DIRS` (default
/// `/usr/local/share:/usr/share`).
fn data_dirs(data_home: Option<&str>, data_dirs: Option<&str>, home: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    match (data_home.filter(|s| !s.is_empty()), home.filter(|s| !s.is_empty())) {
        (Some(d), _) => out.push(PathBuf::from(d)),
        (None, Some(h)) => out.push(Path::new(h).join(".local/share")),
        (None, None) => {}
    }
    let system = data_dirs.filter(|s| !s.is_empty()).unwrap_or("/usr/local/share:/usr/share");
    out.extend(system.split(':').filter(|s| !s.is_empty()).map(PathBuf::from));
    out
}

// ---------------------------------------------------------------------------------------------
// Capabilities and the Notify request
// ---------------------------------------------------------------------------------------------

/// What the server lists in `GetCapabilities` that matters here.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Caps {
    actions: bool,
    body: bool,
    body_markup: bool,
    inline_reply: bool,
}

impl Caps {
    fn parse<S: AsRef<str>>(list: &[S]) -> Self {
        let has = |c: &str| list.iter().any(|s| s.as_ref() == c);
        Self { actions: has("actions"), body: has("body"), body_markup: has("body-markup"), inline_reply: has("inline-reply") }
    }
}

/// Arguments of one `Notify` call (everything but the app name and `replaces_id`).
#[derive(Debug, PartialEq)]
struct Request {
    summary: String,
    body: String,
    actions: Vec<String>,
    hints: HashMap<&'static str, Value<'static>>,
    expire_timeout: i32,
}

fn markup_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            c => out.push(c),
        }
    }
    out
}

fn category_hint(c: Category) -> Option<&'static str> {
    match c {
        Category::Needs => Some("im.received"),
        Category::Finished => Some("transfer.complete"),
        Category::Error => Some("im.error"),
        Category::Info => None,
    }
}

fn build(p: &Presentation, caps: &Caps, identity: &Identity) -> Request {
    let (mut summary, mut body) = (p.title.clone(), p.body.clone());
    if !caps.body {
        // A server that shows no body would drop the text: fold it into the title line.
        if !body.is_empty() {
            summary = format!("{summary} — {body}");
            body.clear();
        }
    } else if caps.body_markup {
        body = markup_escape(&body);
    }

    // Body click first: the `default` action is what the shell triggers on a click.
    let mut actions = vec![ACTION_DEFAULT.to_owned(), "Open".to_owned()];
    if caps.actions {
        for b in p.buttons.iter().take(MAX_BUTTONS) {
            actions.push(format!("{ACTION_PREFIX}{}", b.id));
            actions.push(b.label.clone());
        }
    }
    let inline_reply = p.reply && caps.inline_reply;
    if inline_reply {
        actions.push(ACTION_REPLY.to_owned());
        actions.push("Reply".to_owned());
    }

    let mut hints: HashMap<&'static str, Value<'static>> = HashMap::new();
    if let Some(d) = &identity.desktop_entry {
        hints.insert("desktop-entry", Value::from(d.clone()));
    }
    hints.insert("urgency", Value::U8(if p.silent { 0 } else { 1 }));
    if let Some(c) = category_hint(p.category) {
        hints.insert("category", Value::from(c));
    }
    if p.silent || !p.sound {
        hints.insert("suppress-sound", Value::Bool(true));
    } else {
        hints.insert("sound-name", Value::from(SOUND_NAME));
    }
    if inline_reply {
        hints.insert("x-kde-reply-placeholder-text", Value::from(REPLY_PLACEHOLDER));
    }
    if let Some(h) = &p.host_name {
        hints.insert("x-kde-origin-name", Value::from(h.clone()));
    }

    // Needs-you notifications stay until handled (a retract removes them); servers that ignore
    // the timeout (GNOME) keep their own policy.
    let expire_timeout = if p.category == Category::Needs { 0 } else { -1 };
    Request { summary, body, actions, hints, expire_timeout }
}

// ---------------------------------------------------------------------------------------------
// Live notifications by tag
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct Live {
    server_id: u32,
    host_id: String,
    notification_id: String,
    /// The user acted on it (button, reply, body): the server's close that follows is no dismissal.
    acted: bool,
}

#[derive(Debug, Default)]
struct Tags(HashMap<String, Live>);

impl Tags {
    /// Server id to replace when `tag` is posted again (0 = a new notification).
    fn replaces_id(&self, tag: &str) -> u32 {
        self.0.get(tag).map_or(0, |l| l.server_id)
    }

    fn record(&mut self, tag: &str, live: Live) {
        self.0.insert(tag.to_owned(), live);
    }

    /// Forgets `tag` if it still shows `notification_id`; returns the server id to close.
    fn take_if_current(&mut self, tag: &str, notification_id: &str) -> Option<u32> {
        if self.0.get(tag).is_some_and(|l| l.notification_id == notification_id) {
            self.0.remove(tag).map(|l| l.server_id)
        } else {
            None
        }
    }

    fn drain(&mut self) -> Vec<u32> {
        self.0.drain().map(|(_, l)| l.server_id).collect()
    }

    fn by_server_id(&mut self, server_id: u32) -> Option<&mut Live> {
        self.0.values_mut().find(|l| l.server_id == server_id)
    }

    /// `ActionInvoked`: the body (`default`) or one of our buttons.
    fn action_invoked(&mut self, server_id: u32, key: &str) -> Option<ToastEvent> {
        let live = self.by_server_id(server_id)?;
        let action_id = if key == ACTION_DEFAULT {
            None
        } else {
            Some(key.strip_prefix(ACTION_PREFIX)?.to_owned())
        };
        live.acted = true;
        Some(ToastEvent::Activated {
            host_id: live.host_id.clone(),
            notification_id: live.notification_id.clone(),
            action_id,
            reply: None,
        })
    }

    /// `NotificationReplied` (KDE inline reply).
    fn replied(&mut self, server_id: u32, text: &str) -> Option<ToastEvent> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let live = self.by_server_id(server_id)?;
        live.acted = true;
        Some(ToastEvent::Activated {
            host_id: live.host_id.clone(),
            notification_id: live.notification_id.clone(),
            action_id: None,
            reply: Some(text.to_owned()),
        })
    }

    /// `NotificationClosed`. Reasons: 1 expired (kept: some servers keep it listed, a later
    /// retract still closes it), 2 dismissed by the user, 3 closed by a call, 4 undefined.
    fn closed(&mut self, server_id: u32, reason: u32) -> Option<ToastEvent> {
        let (tag, live) = self.0.iter().find(|(_, l)| l.server_id == server_id).map(|(t, l)| (t.clone(), l.clone()))?;
        if reason == 1 && !live.acted {
            return None;
        }
        self.0.remove(&tag);
        (reason == 2 && !live.acted)
            .then(|| ToastEvent::Dismissed { host_id: live.host_id, notification_id: live.notification_id })
    }
}

// ---------------------------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------------------------

enum Cmd {
    Show(Box<Presentation>),
    Retract { tag: String, notification_id: String },
    Clear(mpsc::Sender<()>),
}

struct Inner {
    conn: Connection,
    caps: Caps,
    identity: Identity,
    tags: Mutex<Tags>,
    sink: Sink,
}

pub struct Notifier {
    tx: mpsc::Sender<Cmd>,
}

impl Notifier {
    /// Connects to the session bus and probes the notification server. `None` when there is no
    /// bus or no server (`GetServerInformation` fails). May take a moment while an activatable
    /// server starts, so call it off the setup thread.
    pub fn new(sink: Sink, identity: Identity) -> Option<Self> {
        let conn = match Connection::session() {
            Ok(c) => c,
            Err(e) => {
                log::info!("no D-Bus session bus, no desktop notifications: {e}");
                return None;
            }
        };
        Self::with_connection(conn, sink, identity)
    }

    fn with_connection(conn: Connection, sink: Sink, identity: Identity) -> Option<Self> {
        let info: (String, String, String, String) = match call(&conn, "GetServerInformation", &()) {
            Ok(i) => i,
            Err(e) => {
                log::info!("no notification server on the session bus, no desktop notifications: {e}");
                return None;
            }
        };
        let list: Vec<String> = call(&conn, "GetCapabilities", &()).unwrap_or_else(|e| {
            log::warn!("reading the notification server's capabilities failed: {e}");
            Vec::new()
        });
        let caps = Caps::parse(&list);
        log::info!("notification server {} {} ({}): {caps:?}", info.0, info.2, info.1);

        let inner = Arc::new(Inner { conn, caps, identity, tags: Mutex::default(), sink });
        listen(Arc::downgrade(&inner))?;
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("xdg-notify".into())
            .spawn(move || {
                while let Ok(cmd) = rx.recv() {
                    run(&inner, cmd);
                }
            })
            .ok()?;
        Some(Self { tx })
    }

    pub fn show(&self, p: &Presentation) {
        let _ = self.tx.send(Cmd::Show(Box::new(p.clone())));
    }

    /// Closes the notification of `notification_id` posted under `tag`; no-op when a newer one
    /// replaced it or it is gone.
    pub fn retract(&self, tag: &str, notification_id: &str) {
        let _ = self.tx.send(Cmd::Retract { tag: tag.to_owned(), notification_id: notification_id.to_owned() });
    }

    /// Closes every notification of this process (on quit: their buttons need the process).
    pub fn clear_all(&self) {
        let (ack, done) = mpsc::channel();
        if self.tx.send(Cmd::Clear(ack)).is_ok() {
            let _ = done.recv_timeout(CLEAR_WAIT);
        }
    }
}

fn call<B, R>(conn: &Connection, method: &str, body: &B) -> zbus::Result<R>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
    R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
{
    conn.call_method(Some(DEST), PATH, Some(DEST), method, body)?.body().deserialize()
}

fn run(inner: &Inner, cmd: Cmd) {
    match cmd {
        Cmd::Show(p) => {
            if let Err(e) = post(inner, &p) {
                log::warn!("desktop notification failed: {e}");
            }
        }
        Cmd::Retract { tag, notification_id } => {
            let id = lock(&inner.tags).take_if_current(&tag, &notification_id);
            if let Some(id) = id {
                close(inner, id);
            }
        }
        Cmd::Clear(ack) => {
            let ids = lock(&inner.tags).drain();
            for id in ids {
                close(inner, id);
            }
            let _ = ack.send(());
        }
    }
}

fn post(inner: &Inner, p: &Presentation) -> zbus::Result<()> {
    let replaces = lock(&inner.tags).replaces_id(&p.tag);
    let r = build(p, &inner.caps, &inner.identity);
    let server_id: u32 = call(
        &inner.conn,
        "Notify",
        &(APP_NAME, replaces, inner.identity.icon.as_str(), r.summary.as_str(), r.body.as_str(), &r.actions, &r.hints, r.expire_timeout),
    )?;
    log::debug!("notification {} posted as {server_id} (replaces {replaces})", p.tag);
    lock(&inner.tags).record(
        &p.tag,
        Live { server_id, host_id: p.host_id.clone(), notification_id: p.notification_id.clone(), acted: false },
    );
    Ok(())
}

fn close(inner: &Inner, server_id: u32) {
    if let Err(e) = call::<_, ()>(&inner.conn, "CloseNotification", &(server_id,)) {
        log::debug!("closing notification {server_id} failed: {e}");
    }
}

/// Subscribes to the server's signals (in place when this returns, so none of a later
/// notification is missed) and handles them on a thread of its own.
fn listen(inner: Weak<Inner>) -> Option<()> {
    let conn = inner.upgrade()?.conn.clone();
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .path(PATH)
        .ok()?
        .interface(DEST)
        .ok()?
        .build();
    let signals = MessageIterator::for_match_rule(rule, &conn, None).ok()?;
    std::thread::Builder::new()
        .name("xdg-notify-signals".into())
        .spawn(move || {
            for msg in signals.flatten() {
                let Some(inner) = inner.upgrade() else { return };
                let event = signal_event(&inner, &msg);
                if let Some(ev) = event {
                    // A panicking sink must not end the thread that reports the other signals.
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (inner.sink)(ev)));
                }
            }
        })
        .ok()?;
    Some(())
}

fn signal_event(inner: &Inner, msg: &zbus::message::Message) -> Option<ToastEvent> {
    let header = msg.header();
    let member = header.member()?.as_str();
    let body = msg.body();
    match member {
        "ActionInvoked" => {
            let (id, key): (u32, String) = body.deserialize().ok()?;
            lock(&inner.tags).action_invoked(id, &key)
        }
        "NotificationReplied" => {
            let (id, text): (u32, String) = body.deserialize().ok()?;
            lock(&inner.tags).replied(id, &text)
        }
        "NotificationClosed" => {
            let (id, reason): (u32, u32) = body.deserialize().ok()?;
            lock(&inner.tags).closed(id, reason)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Instant;

    use super::*;
    use crate::present::Button;

    fn presentation(tag: &str, nid: &str, category: Category) -> Presentation {
        Presentation {
            host_id: "h1".into(),
            notification_id: nid.into(),
            tag: tag.into(),
            category,
            title: "Agent <a> needs you".into(),
            body: "Run `rm -rf` & more?".into(),
            host_name: Some("devbox".into()),
            open_url: "teleflock://agent/h1/a".into(),
            buttons: vec![
                Button { id: "approve".into(), label: "Approve".into(), destructive: false },
                Button { id: "deny".into(), label: "Deny".into(), destructive: true },
            ],
            reply: true,
            silent: false,
            sound: true,
            at: 0,
        }
    }

    fn full_caps() -> Caps {
        Caps::parse(&["actions", "body", "body-markup", "inline-reply", "persistence"])
    }

    #[test]
    fn capabilities_parse() {
        assert_eq!(Caps::parse::<&str>(&[]), Caps::default());
        let c = Caps::parse(&["body", "actions", "icon-static"]);
        assert!(c.actions && c.body && !c.body_markup && !c.inline_reply);
        assert_eq!(full_caps(), Caps { actions: true, body: true, body_markup: true, inline_reply: true });
    }

    #[test]
    fn request_for_a_needs_notification() {
        let id = Identity { icon: "teleflock".into(), desktop_entry: Some("TeleFlock".into()) };
        let r = build(&presentation("h1/a", "n1", Category::Needs), &full_caps(), &id);
        assert_eq!(r.summary, "Agent <a> needs you");
        assert_eq!(r.body, "Run `rm -rf` &amp; more?");
        assert_eq!(
            r.actions,
            ["default", "Open", "a:approve", "Approve", "a:deny", "Deny", "inline-reply", "Reply"]
        );
        assert_eq!(r.expire_timeout, 0);
        assert_eq!(r.hints["desktop-entry"], Value::from("TeleFlock"));
        assert_eq!(r.hints["urgency"], Value::U8(1));
        assert_eq!(r.hints["category"], Value::from("im.received"));
        assert_eq!(r.hints["sound-name"], Value::from("message-new-instant"));
        assert!(!r.hints.contains_key("suppress-sound"));
        assert_eq!(r.hints["x-kde-reply-placeholder-text"], Value::from("Reply to the agent"));
        assert_eq!(r.hints["x-kde-origin-name"], Value::from("devbox"));
    }

    #[test]
    fn request_adapts_to_a_minimal_server() {
        let mut p = presentation("h1/a", "n1", Category::Finished);
        p.silent = true;
        let r = build(&p, &Caps::default(), &Identity::default());
        // No body support: the text moves into the title. No actions capability: body click only.
        assert_eq!(r.summary, "Agent <a> needs you — Run `rm -rf` & more?");
        assert_eq!(r.body, "");
        assert_eq!(r.actions, ["default", "Open"]);
        assert_eq!(r.expire_timeout, -1);
        assert_eq!(r.hints["urgency"], Value::U8(0));
        assert_eq!(r.hints["suppress-sound"], Value::Bool(true));
        assert!(!r.hints.contains_key("sound-name"));
        assert!(!r.hints.contains_key("desktop-entry"));
        assert!(!r.hints.contains_key("x-kde-reply-placeholder-text"));
        assert_eq!(r.hints["category"], Value::from("transfer.complete"));

        // Plain body (no markup capability): not escaped.
        let r = build(&p, &Caps { body: true, ..Caps::default() }, &Identity::default());
        assert_eq!(r.body, "Run `rm -rf` & more?");
        p.category = Category::Info;
        p.sound = false;
        p.silent = false;
        let r = build(&p, &Caps::default(), &Identity::default());
        assert!(!r.hints.contains_key("category"));
        assert_eq!(r.hints["suppress-sound"], Value::Bool(true));
    }

    fn live(server_id: u32, nid: &str) -> Live {
        Live { server_id, host_id: "h1".into(), notification_id: nid.into(), acted: false }
    }

    #[test]
    fn tags_replace_and_retract_only_the_current_notification() {
        let mut t = Tags::default();
        assert_eq!(t.replaces_id("h1/a"), 0);
        t.record("h1/a", live(7, "n1"));
        assert_eq!(t.replaces_id("h1/a"), 7);
        t.record("h1/a", live(7, "n2"));
        assert_eq!(t.take_if_current("h1/a", "n1"), None, "n1 was replaced by n2");
        assert_eq!(t.replaces_id("h1/a"), 7);
        assert_eq!(t.take_if_current("h1/a", "n2"), Some(7));
        assert_eq!(t.replaces_id("h1/a"), 0);
        assert_eq!(t.take_if_current("h1/a", "n2"), None);
        t.record("h1/a", live(8, "n3"));
        t.record("h1/b", live(9, "n4"));
        let mut ids = t.drain();
        ids.sort_unstable();
        assert_eq!(ids, [8, 9]);
    }

    #[test]
    fn signals_map_to_events() {
        let mut t = Tags::default();
        t.record("h1/a", live(7, "n1"));
        t.record("h1/b", live(8, "n2"));
        let activated = |nid: &str, action_id: Option<&str>, reply: Option<&str>| {
            Some(ToastEvent::Activated {
                host_id: "h1".into(),
                notification_id: nid.into(),
                action_id: action_id.map(Into::into),
                reply: reply.map(Into::into),
            })
        };
        assert_eq!(t.action_invoked(7, "a:approve"), activated("n1", Some("approve"), None));
        assert_eq!(t.action_invoked(7, "default"), activated("n1", None, None));
        assert_eq!(t.action_invoked(7, "inline-reply"), None);
        assert_eq!(t.action_invoked(99, "default"), None, "not ours");
        assert_eq!(t.replied(8, "  ship it \n"), activated("n2", None, Some("ship it")));
        assert_eq!(t.replied(8, "   "), None);
        // The server closes an acted-on notification with reason 2: no dismissal.
        assert_eq!(t.closed(7, 2), None);
        assert_eq!(t.replaces_id("h1/a"), 0);
        assert_eq!(t.closed(8, 3), None);
        t.record("h1/c", live(10, "n5"));
        assert_eq!(t.closed(10, 1), None, "expired: still listed");
        assert_eq!(t.replaces_id("h1/c"), 10);
        assert_eq!(t.closed(10, 2), Some(ToastEvent::Dismissed { host_id: "h1".into(), notification_id: "n5".into() }));
        assert_eq!(t.closed(10, 2), None);
    }

    #[test]
    fn data_dirs_follow_the_xdg_defaults() {
        assert_eq!(
            data_dirs(None, None, Some("/home/u")),
            [PathBuf::from("/home/u/.local/share"), "/usr/local/share".into(), "/usr/share".into()]
        );
        assert_eq!(data_dirs(Some("/x"), Some("/a::/b"), Some("/home/u")), [PathBuf::from("/x"), "/a".into(), "/b".into()]);
    }

    #[test]
    fn identity_prefers_the_installed_package() {
        let tmp = tempfile::tempdir().unwrap();
        let share = tmp.path().join("share");
        let icons = tmp.path().join("icons");
        let dirs = [share.clone()];
        // Nothing installed: the icon is written once and used by path.
        let id = Identity::from_dirs(&dirs, Some(&icons), b"png");
        assert_eq!(id.desktop_entry, None);
        assert_eq!(id.icon, icons.join("teleflock-notification.png").to_str().unwrap());
        assert_eq!(std::fs::read(&id.icon).unwrap(), b"png");
        assert_eq!(Identity::from_dirs(&dirs, None, b"png"), Identity::default());
        // Packaged: theme icon name and desktop entry.
        std::fs::create_dir_all(share.join("applications")).unwrap();
        std::fs::write(share.join("applications/TeleFlock.desktop"), "[Desktop Entry]").unwrap();
        std::fs::create_dir_all(share.join("icons/hicolor/128x128/apps")).unwrap();
        std::fs::write(share.join("icons/hicolor/128x128/apps/teleflock.png"), "x").unwrap();
        let id = Identity::from_dirs(&dirs, Some(&icons), b"png");
        assert_eq!(id, Identity { icon: "teleflock".into(), desktop_entry: Some("TeleFlock".into()) });
    }

    // --- integration: a private session bus with a mock notification server -------------------

    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Notify { replaces_id: u32, icon: String, summary: String, body: String, actions: Vec<String>, hints: Vec<String>, expire: i32, id: u32 },
        Close(u32),
    }

    struct Mock {
        calls: Arc<Mutex<Vec<Call>>>,
        next_id: AtomicU32,
        caps: Vec<String>,
    }

    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl Mock {
        fn get_server_information(&self) -> (String, String, String, String) {
            ("mock".into(), "teleflock-tests".into(), "1".into(), "1.2".into())
        }
        fn get_capabilities(&self) -> Vec<String> {
            self.caps.clone()
        }
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &self,
            _app_name: String,
            replaces_id: u32,
            app_icon: String,
            summary: String,
            body: String,
            actions: Vec<String>,
            hints: HashMap<String, zbus::zvariant::OwnedValue>,
            expire_timeout: i32,
        ) -> u32 {
            let id = if replaces_id != 0 { replaces_id } else { self.next_id.fetch_add(1, Ordering::SeqCst) };
            let mut hints: Vec<String> = hints.into_iter().map(|(k, v)| format!("{k}={v:?}")).collect();
            hints.sort();
            lock(&self.calls).push(Call::Notify {
                replaces_id,
                icon: app_icon,
                summary,
                body,
                actions,
                hints,
                expire: expire_timeout,
                id,
            });
            id
        }
        fn close_notification(&self, id: u32) {
            lock(&self.calls).push(Call::Close(id));
        }
    }

    struct Bus(Child);
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// A private session bus (`dbus-daemon`), or `None` where the daemon is not installed.
    fn private_bus() -> Option<(Bus, String)> {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut addr = String::new();
        BufReader::new(child.stdout.take()?).read_line(&mut addr).ok()?;
        let bus = Bus(child);
        let addr = addr.trim().to_owned();
        (!addr.is_empty()).then_some((bus, addr))
    }

    fn connect(addr: &str) -> Connection {
        zbus::blocking::connection::Builder::address(addr).unwrap().build().unwrap()
    }

    fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
        let end = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < end, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn emit<B: serde::Serialize + zbus::zvariant::DynamicType>(server: &Connection, member: &str, body: &B) {
        server.emit_signal(None::<&str>, PATH, DEST, member, body).unwrap();
    }

    #[test]
    fn talks_to_a_notification_server_over_a_private_bus() {
        let Some((_bus, addr)) = private_bus() else {
            eprintln!("skipped: dbus-daemon is not installed");
            return;
        };
        let calls: Arc<Mutex<Vec<Call>>> = Arc::default();
        let server = zbus::blocking::connection::Builder::address(addr.as_str())
            .unwrap()
            .name(DEST)
            .unwrap()
            .serve_at(
                PATH,
                Mock {
                    calls: Arc::clone(&calls),
                    next_id: AtomicU32::new(40),
                    caps: ["actions", "body", "body-markup", "inline-reply"].map(String::from).to_vec(),
                },
            )
            .unwrap()
            .build()
            .unwrap();

        let events: Arc<Mutex<Vec<ToastEvent>>> = Arc::default();
        let sink_events = Arc::clone(&events);
        let sink: Sink = Arc::new(move |e| lock(&sink_events).push(e));
        let identity = Identity { icon: "teleflock".into(), desktop_entry: Some("TeleFlock".into()) };
        let notifier = Notifier::with_connection(connect(&addr), sink, identity).expect("server is up");

        // Agent a: first post is new; the same tag again replaces it; agent b is separate.
        notifier.show(&presentation("h1/a", "n1", Category::Needs));
        wait_for("first Notify", || lock(&calls).len() == 1);
        notifier.show(&presentation("h1/a", "n2", Category::Needs));
        notifier.show(&presentation("h1/b", "m1", Category::Finished));
        wait_for("three Notify calls", || lock(&calls).len() == 3);
        let c = lock(&calls).clone();
        let Call::Notify { replaces_id, icon, summary, body, actions, hints, expire, id } = &c[0] else { panic!("{c:?}") };
        assert_eq!((*replaces_id, icon.as_str(), *expire, *id), (0, "teleflock", 0, 40));
        assert_eq!(summary, "Agent <a> needs you");
        assert_eq!(body, "Run `rm -rf` &amp; more?");
        assert_eq!(actions, &["default", "Open", "a:approve", "Approve", "a:deny", "Deny", "inline-reply", "Reply"]);
        assert!(hints.iter().any(|h| h.starts_with("desktop-entry=")), "{hints:?}");
        assert!(hints.iter().any(|h| h.starts_with("urgency=")), "{hints:?}");
        assert!(matches!(&c[1], Call::Notify { replaces_id: 40, id: 40, .. }), "{:?}", c[1]);
        assert!(matches!(&c[2], Call::Notify { replaces_id: 0, id: 41, expire: -1, .. }), "{:?}", c[2]);

        // A button, the body, and an inline reply on agent a (the notification shows n2 now).
        emit(&server, "ActionInvoked", &(40u32, "a:approve"));
        emit(&server, "ActionInvoked", &(40u32, "default"));
        emit(&server, "NotificationReplied", &(40u32, "go ahead"));
        emit(&server, "ActionInvoked", &(999u32, "a:approve"));
        wait_for("three activations", || lock(&events).len() == 3);
        let activated = |action_id: Option<&str>, reply: Option<&str>| ToastEvent::Activated {
            host_id: "h1".into(),
            notification_id: "n2".into(),
            action_id: action_id.map(Into::into),
            reply: reply.map(Into::into),
        };
        assert_eq!(
            *lock(&events),
            [activated(Some("approve"), None), activated(None, None), activated(None, Some("go ahead"))]
        );

        // Agent b: our own close (3) and expiry (1) report nothing, the user's (2) a dismissal.
        emit(&server, "NotificationClosed", &(41u32, 1u32));
        emit(&server, "NotificationClosed", &(41u32, 2u32));
        wait_for("dismissal", || lock(&events).len() == 4);
        assert_eq!(
            lock(&events)[3],
            ToastEvent::Dismissed { host_id: "h1".into(), notification_id: "m1".into() }
        );

        // Retract: a stale notification id closes nothing; the current one closes the server id.
        notifier.retract("h1/a", "n1");
        notifier.retract("h1/a", "n2");
        wait_for("CloseNotification", || lock(&calls).iter().any(|c| matches!(c, Call::Close(_))));
        assert_eq!(lock(&calls).iter().filter(|c| matches!(c, Call::Close(_))).collect::<Vec<_>>(), [&Call::Close(40)]);

        // clear_all closes what is left (agent c) and nothing else.
        notifier.show(&presentation("h1/c", "k1", Category::Error));
        wait_for("agent c", || lock(&calls).iter().any(|c| matches!(c, Call::Notify { id: 42, .. })));
        notifier.clear_all();
        let closes: Vec<_> = lock(&calls).iter().filter_map(|c| if let Call::Close(i) = c { Some(*i) } else { None }).collect();
        assert_eq!(closes, [40, 42]);
    }

    #[test]
    fn no_server_means_no_notifier() {
        let Some((_bus, addr)) = private_bus() else {
            eprintln!("skipped: dbus-daemon is not installed");
            return;
        };
        let sink: Sink = Arc::new(|_| {});
        assert!(Notifier::with_connection(connect(&addr), sink, Identity::default()).is_none());
    }
}
