//! Platform-neutral presentation of a tf-proto [`Notification`] (Windows toast / Android
//! notification share it).

use tf_client::NotifyStyle;
use tf_proto::{HostProfile, Notification, NotifyKind};

use crate::deeplink;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Category {
    Needs,
    Finished,
    Error,
    Info,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub id: String,
    pub label: String,
    pub destructive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presentation {
    pub host_id: String,
    pub notification_id: String,
    /// One live notification per agent: re-posting with the same tag replaces it.
    pub tag: String,
    pub category: Category,
    pub title: String,
    pub body: String,
    /// Host name (shown as attribution / sub-text).
    pub host_name: Option<String>,
    /// Deep link for a tap on the body.
    pub open_url: String,
    /// At most 3 (the engine guarantees it; clamped again here).
    pub buttons: Vec<Button>,
    pub reply: bool,
    pub silent: bool,
    pub sound: bool,
    pub at: i64,
}

pub const MAX_BUTTONS: usize = 3;

fn is_destructive(label: &str, cancel: bool) -> bool {
    cancel || {
        let l = label.to_ascii_lowercase();
        ["deny", "reject", "cancel", "stop", "abort", "no"].iter().any(|w| l == *w || l.starts_with(&format!("{w} ")))
    }
}

pub fn present(host: Option<&HostProfile>, n: &Notification, style: NotifyStyle) -> Presentation {
    let host_id = host.map(|h| h.id.clone()).unwrap_or_default();
    let category = match n.kind {
        NotifyKind::Needs => Category::Needs,
        NotifyKind::Finished => Category::Finished,
        NotifyKind::Error => Category::Error,
        NotifyKind::Quiet | NotifyKind::Info => Category::Info,
    };
    let open_url = if host.is_some() && !n.agent_id.is_empty() {
        deeplink::agent_url(&host_id, &n.agent_id, Some(&n.id))
    } else {
        format!("{}://open", deeplink::SCHEME)
    };
    let buttons = if host.is_some() {
        n.actions
            .iter()
            .take(MAX_BUTTONS)
            .map(|a| Button {
                id: a.id.clone(),
                label: a.label.clone(),
                destructive: is_destructive(&a.label, a.answer.as_ref().is_some_and(|x| x.cancel)),
            })
            .collect()
    } else {
        Vec::new()
    };
    Presentation {
        tag: tag(&host_id, n),
        host_id,
        notification_id: n.id.clone(),
        category,
        title: n.title.clone(),
        body: n.body.clone(),
        host_name: host.map(|h| h.name.clone()),
        open_url,
        buttons,
        reply: style.reply && host.is_some(),
        silent: style.silent,
        sound: style.sound && !style.silent,
        at: n.at,
    }
}

/// OS identity of `n`'s notification (Windows toast tag, Android notification tag): one live
/// notification per agent, so a newer one replaces the older.
pub fn tag(host_id: &str, n: &Notification) -> String {
    if n.agent_id.is_empty() { format!("{host_id}/{}", n.id) } else { format!("{host_id}/{}", n.agent_id) }
}

/// What the user did with an OS notification (every desktop notifier reports through this).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastEvent {
    /// A button (`action_id`), the inline reply (`reply`), or the body itself (both `None`;
    /// only Linux and macOS report that: Windows routes body clicks through the deep link).
    Activated { host_id: String, notification_id: String, action_id: Option<String>, reply: Option<String> },
    /// Closed by the user.
    Dismissed { host_id: String, notification_id: String },
}

pub type Sink = std::sync::Arc<dyn Fn(ToastEvent) + Send + Sync>;

/// "3 running · 2 need you" (tray tooltip, Android keep-alive text).
pub fn summary(running: u32, needs: u32) -> String {
    match (running, needs) {
        (0, 0) => "All quiet".to_owned(),
        (r, 0) => format!("{r} running"),
        (0, n) => format!("{n} need{} you", if n == 1 { "s" } else { "" }),
        (r, n) => format!("{r} running · {n} need{} you", if n == 1 { "s" } else { "" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_proto::{Answer, HostKind, NotifyAction};

    fn host() -> HostProfile {
        serde_json::from_value(serde_json::json!({
            "id": "h1", "name": "forge", "kind": "tailscaleSsh", "herdrSession": "default", "autoConnect": true
        }))
        .unwrap()
    }

    fn notification(actions: Vec<NotifyAction>) -> Notification {
        Notification {
            id: "n1".into(),
            at: 5,
            kind: NotifyKind::Needs,
            agent_id: "w1:p2".into(),
            title: "Allow bash?".into(),
            body: "rm -rf build".into(),
            request_id: Some("r1".into()),
            actions,
        }
    }

    #[test]
    fn needs_with_actions() {
        let h = host();
        assert_eq!(h.kind, HostKind::TailscaleSsh);
        let act = |id: &str, label: &str, cancel: bool| NotifyAction {
            id: id.into(),
            label: label.into(),
            answer: Some(Answer { choices: vec![], text: None, cancel, chat: false }),
        };
        let n = notification(vec![act("a", "Allow", false), act("d", "Deny", true), act("x", "No thanks", false), act("y", "Extra", false)]);
        let p = present(Some(&h), &n, NotifyStyle { sound: true, silent: false, reply: true });
        assert_eq!(p.tag, "h1/w1:p2");
        assert_eq!(tag("h1", &n), p.tag, "retract finds what notify posted");
        assert_eq!(p.category, Category::Needs);
        assert_eq!(p.buttons.len(), 3);
        assert!(!p.buttons[0].destructive);
        assert!(p.buttons[1].destructive);
        assert!(p.buttons[2].destructive);
        assert!(p.reply && p.sound && !p.silent);
        assert_eq!(p.open_url, "teleflock://agent/h1/w1%3Ap2?n=n1");
        assert_eq!(p.host_name.as_deref(), Some("forge"));
    }

    #[test]
    fn test_notification_without_host() {
        let n = notification(vec![]);
        let p = present(None, &n, NotifyStyle { sound: true, silent: true, reply: true });
        assert!(p.buttons.is_empty() && !p.reply && !p.sound && p.silent);
        assert_eq!(p.open_url, "teleflock://open");
    }

    #[test]
    fn summaries() {
        assert_eq!(summary(0, 0), "All quiet");
        assert_eq!(summary(3, 0), "3 running");
        assert_eq!(summary(0, 1), "1 needs you");
        assert_eq!(summary(3, 2), "3 running · 2 need you");
    }
}
