//! Which connected app alerts for a notification (pure; architecture §3.21).
//!
//! Apps that negotiated `presence` follow tf-hostd's `alert` flag; older apps alert for every
//! notification by themselves and are left alone. With routing on:
//! - devices in use (presence `active`) alert at once;
//! - with no device in use, the escalation devices alert at once: the phones (they go with you),
//!   or every device when the policy says so or no phone is connected.
//!
//! Whoever alerted first, an unseen needs-you, error or stall notification escalates after the
//! policy's delay: to the escalation devices that have not alerted yet, and to the push channels
//! that deliver unseen notifications (an iPhone with ntfy while the desktop app sits idle).

use tf_proto::{DeviceKind, EscalateTo, NotifyKind, NotifyPolicy, Presence, PresenceState};

/// One app connected to the notification's herdr session.
#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub id: &'a str,
    /// Negotiated `presence`: alerts only when told to.
    pub capable: bool,
    /// Its last report (`None`: not reported yet).
    pub presence: Option<&'a Presence>,
}

impl Candidate<'_> {
    fn active(&self) -> bool {
        self.presence.is_some_and(|p| p.state == PresenceState::Active)
    }

    fn phone(&self) -> bool {
        self.presence.is_some_and(|p| p.device == DeviceKind::Phone)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Decision {
    /// Presence-capable apps told to alert now.
    pub alert: Vec<String>,
    /// Arm the escalation timer.
    pub escalate_later: bool,
}

/// Kinds that escalate when nobody saw them: they wait on you or went wrong.
pub fn escalates(kind: NotifyKind) -> bool {
    matches!(kind, NotifyKind::Needs | NotifyKind::Error | NotifyKind::Quiet)
}

/// Routes a new notification. `escalatable` overrides [`escalates`] (routed tests).
pub fn route(policy: &NotifyPolicy, escalatable: bool, cands: &[Candidate]) -> Decision {
    let escalate_later = escalatable && policy.escalate_after_s > 0;
    let capable: Vec<&Candidate> = cands.iter().filter(|c| c.capable).collect();
    if !policy.route {
        return Decision { alert: capable.iter().map(|c| c.id.to_string()).collect(), escalate_later };
    }
    let in_use: Vec<String> = capable.iter().filter(|c| c.active()).map(|c| c.id.to_string()).collect();
    if !in_use.is_empty() {
        return Decision { alert: in_use, escalate_later };
    }
    // Nobody is using a device: alert where you are likely to be, now.
    Decision { alert: escalation_targets(policy, cands, &[]), escalate_later }
}

/// The apps an escalation alerts, minus the ones that alerted already.
pub fn escalation_targets(policy: &NotifyPolicy, cands: &[Candidate], alerted: &[String]) -> Vec<String> {
    let fresh = |c: &&Candidate| c.capable && !alerted.iter().any(|a| a == c.id);
    let all_capable = || cands.iter().filter(|c| c.capable);
    let phones = all_capable().any(|c| c.phone());
    match policy.escalate_to {
        // A phone notified already (it was the device in use) still counts: no desktop pile-on.
        EscalateTo::Phones if phones => cands.iter().filter(|c| c.phone()).filter(fresh).map(|c| c.id.to_string()).collect(),
        _ => cands.iter().filter(fresh).map(|c| c.id.to_string()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(route: bool, after: u32, to: EscalateTo) -> NotifyPolicy {
        NotifyPolicy { route, escalate_after_s: after, escalate_to: to }
    }

    fn p(state: PresenceState, device: DeviceKind) -> Presence {
        Presence { state, device, input_at: None, os_notifications: true }
    }

    fn c<'a>(id: &'a str, presence: Option<&'a Presence>) -> Candidate<'a> {
        Candidate { id, capable: true, presence }
    }

    #[test]
    fn the_device_in_use_alerts_and_the_rest_escalates_later() {
        let desk = p(PresenceState::Active, DeviceKind::Desktop);
        let phone = p(PresenceState::Idle, DeviceKind::Phone);
        let laptop = p(PresenceState::Idle, DeviceKind::Desktop);
        let cands = [c("desk", Some(&desk)), c("phone", Some(&phone)), c("laptop", Some(&laptop))];
        let pol = policy(true, 300, EscalateTo::Phones);
        assert_eq!(route(&pol, true, &cands), Decision { alert: vec!["desk".into()], escalate_later: true });
        assert_eq!(route(&pol, false, &cands), Decision { alert: vec!["desk".into()], escalate_later: false }, "finished never escalates");
        assert_eq!(escalation_targets(&pol, &cands, &["desk".into()]), ["phone"]);
        let all = policy(true, 300, EscalateTo::All);
        assert_eq!(escalation_targets(&all, &cands, &["desk".into()]), ["phone", "laptop"]);
        assert_eq!(route(&policy(true, 0, EscalateTo::Phones), true, &cands).escalate_later, false, "0 s: never");
    }

    #[test]
    fn nobody_in_use_goes_to_the_phones_at_once() {
        let desk = p(PresenceState::Idle, DeviceKind::Desktop);
        let phone = p(PresenceState::Away, DeviceKind::Phone);
        let cands = [c("desk", Some(&desk)), c("phone", Some(&phone))];
        // Still escalates when unseen: the push channels for unseen notifications take it then.
        assert_eq!(route(&policy(true, 300, EscalateTo::Phones), true, &cands), Decision { alert: vec!["phone".into()], escalate_later: true });
        assert_eq!(escalation_targets(&policy(true, 300, EscalateTo::Phones), &cands, &["phone".into()]), Vec::<String>::new(), "no desktop pile-on");
        assert_eq!(route(&policy(true, 300, EscalateTo::All), true, &cands).alert, ["desk", "phone"]);
        // No phone connected: every device, also the ones that have not reported yet.
        let cands = [c("desk", Some(&desk)), c("new", None)];
        assert_eq!(route(&policy(true, 300, EscalateTo::Phones), true, &cands).alert, ["desk", "new"]);
        assert!(!route(&policy(true, 300, EscalateTo::Phones), false, &cands).escalate_later, "finished never escalates");
    }

    #[test]
    fn older_apps_and_routing_off() {
        let desk = p(PresenceState::Active, DeviceKind::Desktop);
        let old = Candidate { id: "old", capable: false, presence: None };
        let cands = [c("desk", Some(&desk)), old];
        assert_eq!(route(&policy(true, 60, EscalateTo::All), true, &cands).alert, ["desk"], "older apps alert on their own");
        assert_eq!(escalation_targets(&policy(true, 60, EscalateTo::All), &cands, &["desk".into()]), Vec::<String>::new());
        let idle = p(PresenceState::Idle, DeviceKind::Desktop);
        let cands = [c("a", Some(&desk)), c("b", Some(&idle))];
        assert_eq!(route(&policy(false, 60, EscalateTo::Phones), true, &cands), Decision { alert: vec!["a".into(), "b".into()], escalate_later: true }, "every device alerted; unseen pushes still wait");
        assert!(escalation_targets(&policy(false, 60, EscalateTo::Phones), &cands, &["a".into(), "b".into()]).is_empty());
    }

    #[test]
    fn an_active_phone_is_the_device_in_use() {
        let desk = p(PresenceState::Idle, DeviceKind::Desktop);
        let phone = p(PresenceState::Active, DeviceKind::Phone);
        let cands = [c("desk", Some(&desk)), c("phone", Some(&phone))];
        let pol = policy(true, 120, EscalateTo::Phones);
        assert_eq!(route(&pol, true, &cands), Decision { alert: vec!["phone".into()], escalate_later: true });
        assert!(escalation_targets(&pol, &cands, &["phone".into()]).is_empty(), "the phone had it: no desktop pile-on");
        assert_eq!(escalation_targets(&policy(true, 120, EscalateTo::All), &cands, &["phone".into()]), ["desk"]);
    }
}
