//! The platform-independent half of the macOS notifier (`mac_notify.rs`): which request belongs
//! to which notification, how a response maps to an engine event, and the notification
//! categories (UNNotificationCategory) that carry the buttons. Kept free of Objective-C so it is
//! unit-tested on every OS.

use std::collections::HashMap;

use crate::present::{Button, MAX_BUTTONS, Presentation, ToastEvent};

/// Identifier prefix of our button actions (system identifiers and the reply action never collide).
pub const ACTION_PREFIX: &str = "a:";
/// Identifier of the text-input (reply) action.
pub const ACTION_REPLY: &str = "reply";
/// Registered categories kept at most; the least recently used goes first. Action sets repeat
/// (approve/deny, answer options), so this is never reached in practice.
pub const MAX_CATEGORIES: usize = 32;

// ---------------------------------------------------------------------------------------------
// Live notifications by request identifier
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub host_id: String,
    pub notification_id: String,
    /// Quiet notification: list only, no banner (the delegate answers `willPresent` with it).
    pub silent: bool,
}

/// What the user did, with the action identifier resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Response {
    /// The body (the default action).
    Body,
    /// Swiped away / closed (`CustomDismissAction`).
    Dismiss,
    /// One of our buttons (`a:<id>`).
    Button(String),
    /// The text-input action with the text typed.
    Reply(String),
}

/// Resolves an `actionIdentifier` of `didReceiveNotificationResponse`; `default_id` and
/// `dismiss_id` are the system's `UNNotificationDefaultActionIdentifier` /
/// `UNNotificationDismissActionIdentifier`, `text` the user text of a text-input response.
pub fn classify(action: &str, default_id: &str, dismiss_id: &str, text: Option<&str>) -> Option<Response> {
    if action == default_id {
        Some(Response::Body)
    } else if action == dismiss_id {
        Some(Response::Dismiss)
    } else if action == ACTION_REPLY {
        text.map(|t| Response::Reply(t.to_owned()))
    } else {
        action.strip_prefix(ACTION_PREFIX).map(|id| Response::Button(id.to_owned()))
    }
}

#[derive(Debug, Default)]
pub struct Tags(HashMap<String, Live>);

impl Tags {
    pub fn record(&mut self, request_id: &str, live: Live) {
        self.0.insert(request_id.to_owned(), live);
    }

    pub fn get(&self, request_id: &str) -> Option<&Live> {
        self.0.get(request_id)
    }

    /// Forgets `request_id` if it still shows `notification_id`: true = remove it from the center.
    pub fn take_if_current(&mut self, request_id: &str, notification_id: &str) -> bool {
        if self.0.get(request_id).is_some_and(|l| l.notification_id == notification_id) {
            self.0.remove(request_id);
            true
        } else {
            false
        }
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    /// The engine event for a response to `request_id`. The notification is gone from the center
    /// after any response, so its entry goes too. Unknown requests (left from an earlier run)
    /// report nothing.
    pub fn respond(&mut self, request_id: &str, response: Response) -> Option<ToastEvent> {
        let live = self.0.get(request_id)?.clone();
        let (host_id, notification_id) = (live.host_id, live.notification_id);
        let activated = |action_id, reply| ToastEvent::Activated {
            host_id: host_id.clone(),
            notification_id: notification_id.clone(),
            action_id,
            reply,
        };
        let event = match response {
            Response::Body => activated(None, None),
            Response::Button(id) => activated(Some(id), None),
            Response::Reply(text) => {
                let text = text.trim();
                if text.is_empty() {
                    return None;
                }
                activated(None, Some(text.to_owned()))
            }
            Response::Dismiss => ToastEvent::Dismissed { host_id: host_id.clone(), notification_id: notification_id.clone() },
        };
        self.0.remove(request_id);
        Some(event)
    }
}

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

/// One action set (buttons in display order, plus the reply field). Notifications with the same
/// buttons share a category; its identifier spells the whole set out, so identical ids with
/// different labels never share one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategorySpec {
    pub id: String,
    pub buttons: Vec<Button>,
    pub reply: bool,
}

impl CategorySpec {
    pub fn for_presentation(p: &Presentation) -> Self {
        let buttons: Vec<Button> = p.buttons.iter().take(MAX_BUTTONS).cloned().collect();
        let mut id = String::from("tf");
        if p.reply {
            id.push_str("+reply");
        }
        for b in &buttons {
            id.push_str(&format!("|{}\u{1f}{}\u{1f}{}", b.id, b.label, u8::from(b.destructive)));
        }
        Self { id, buttons, reply: p.reply }
    }
}

#[derive(Debug, Default)]
pub struct Categories(Vec<CategorySpec>);

impl Categories {
    /// Makes `spec` part of the set. True when the set changed and must be registered again with
    /// `setNotificationCategories` (a used spec only moves to the back).
    pub fn ensure(&mut self, spec: &CategorySpec) -> bool {
        if let Some(i) = self.0.iter().position(|s| s.id == spec.id) {
            let s = self.0.remove(i);
            self.0.push(s);
            return false;
        }
        self.0.push(spec.clone());
        if self.0.len() > MAX_CATEGORIES {
            self.0.remove(0);
        }
        true
    }

    pub fn specs(&self) -> &[CategorySpec] {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::present::Category;

    fn presentation(buttons: &[(&str, &str, bool)], reply: bool) -> Presentation {
        Presentation {
            host_id: "h1".into(),
            notification_id: "n1".into(),
            tag: "h1/a".into(),
            category: Category::Needs,
            title: "t".into(),
            body: "b".into(),
            host_name: None,
            open_url: String::new(),
            buttons: buttons
                .iter()
                .map(|(id, label, destructive)| Button { id: (*id).into(), label: (*label).into(), destructive: *destructive })
                .collect(),
            reply,
            silent: false,
            sound: true,
            at: 0,
        }
    }

    fn live(nid: &str) -> Live {
        Live { host_id: "h1".into(), notification_id: nid.into(), silent: false }
    }

    #[test]
    fn actions_classify_against_the_system_identifiers() {
        let c = |a, text| classify(a, "sys.default", "sys.dismiss", text);
        assert_eq!(c("sys.default", None), Some(Response::Body));
        assert_eq!(c("sys.dismiss", None), Some(Response::Dismiss));
        assert_eq!(c("a:approve", None), Some(Response::Button("approve".into())));
        assert_eq!(c("reply", Some("go")), Some(Response::Reply("go".into())));
        assert_eq!(c("reply", None), None);
        assert_eq!(c("other", None), None);
        // A button named like a system identifier cannot be confused with it (prefix).
        assert_eq!(c("a:sys.default", None), Some(Response::Button("sys.default".into())));
    }

    #[test]
    fn responses_become_events_and_forget_the_request() {
        let activated = |nid: &str, action_id: Option<&str>, reply: Option<&str>| {
            Some(ToastEvent::Activated {
                host_id: "h1".into(),
                notification_id: nid.into(),
                action_id: action_id.map(Into::into),
                reply: reply.map(Into::into),
            })
        };
        let mut t = Tags::default();
        t.record("h1/a", live("n1"));
        assert_eq!(t.respond("h1/a", Response::Button("approve".into())), activated("n1", Some("approve"), None));
        assert_eq!(t.respond("h1/a", Response::Body), None, "forgotten after the first response");
        t.record("h1/a", live("n2"));
        assert_eq!(t.respond("h1/a", Response::Reply("   ".into())), None, "empty replies are dropped");
        assert_eq!(t.respond("h1/a", Response::Reply(" ship it ".into())), activated("n2", None, Some("ship it")));
        t.record("h1/b", live("n3"));
        assert_eq!(t.respond("h1/b", Response::Body), activated("n3", None, None));
        t.record("h1/c", live("n4"));
        assert_eq!(
            t.respond("h1/c", Response::Dismiss),
            Some(ToastEvent::Dismissed { host_id: "h1".into(), notification_id: "n4".into() })
        );
        assert_eq!(t.respond("unknown", Response::Dismiss), None);
    }

    #[test]
    fn retract_only_removes_the_current_notification() {
        let mut t = Tags::default();
        t.record("h1/a", live("n1"));
        t.record("h1/a", live("n2")); // the same identifier replaced n1 in place
        assert!(!t.take_if_current("h1/a", "n1"));
        assert!(t.get("h1/a").is_some());
        assert!(t.take_if_current("h1/a", "n2"));
        assert!(!t.take_if_current("h1/a", "n2"));
        t.record("h1/b", live("n3"));
        t.clear();
        assert!(t.get("h1/b").is_none());
    }

    #[test]
    fn category_ids_spell_out_the_action_set() {
        let a = CategorySpec::for_presentation(&presentation(&[("approve", "Approve", false), ("deny", "Deny", true)], false));
        let b = CategorySpec::for_presentation(&presentation(&[("approve", "Approve", false), ("deny", "Deny", true)], false));
        assert_eq!(a, b);
        let reply = CategorySpec::for_presentation(&presentation(&[("approve", "Approve", false), ("deny", "Deny", true)], true));
        let relabelled = CategorySpec::for_presentation(&presentation(&[("approve", "Allow", false), ("deny", "Deny", true)], false));
        let reordered = CategorySpec::for_presentation(&presentation(&[("deny", "Deny", true), ("approve", "Approve", false)], false));
        let none = CategorySpec::for_presentation(&presentation(&[], false));
        let ids = [&a.id, &reply.id, &relabelled.id, &reordered.id, &none.id];
        for (i, x) in ids.iter().enumerate() {
            for y in &ids[i + 1..] {
                assert_ne!(x, y);
            }
        }
        assert!(reply.reply && !a.reply);
        assert_eq!(none.id, "tf");
        assert!(none.buttons.is_empty());
        // Clamped like the notification itself.
        let many = CategorySpec::for_presentation(&presentation(
            &[("1", "1", false), ("2", "2", false), ("3", "3", false), ("4", "4", false)],
            false,
        ));
        assert_eq!(many.buttons.len(), MAX_BUTTONS);
    }

    #[test]
    fn category_set_is_bounded_and_reports_changes() {
        let spec = |i: usize| CategorySpec { id: format!("c{i}"), buttons: Vec::new(), reply: false };
        let mut c = Categories::default();
        assert!(c.ensure(&spec(0)));
        assert!(!c.ensure(&spec(0)), "known sets need no re-registration");
        for i in 1..MAX_CATEGORIES {
            assert!(c.ensure(&spec(i)));
        }
        assert_eq!(c.specs().len(), MAX_CATEGORIES);
        // Touch c0 so c1 is the least recently used, then overflow.
        assert!(!c.ensure(&spec(0)));
        assert!(c.ensure(&spec(MAX_CATEGORIES)));
        assert_eq!(c.specs().len(), MAX_CATEGORIES);
        assert!(c.specs().iter().any(|s| s.id == "c0"));
        assert!(!c.specs().iter().any(|s| s.id == "c1"));
    }
}
