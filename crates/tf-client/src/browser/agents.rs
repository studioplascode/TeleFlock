//! Agents and the browser, as state: who is attached (scope, host port), who is being attached,
//! whose allowed request waits for a free slot under the cap, and every agent's name. Talking to
//! hosts is `mod.rs`'s job.

use std::collections::{HashMap, HashSet};

use tf_proto::{Answer, BrowserScope, Millis, NotifyAction};

use super::proxy::AttachKey;

/// `NeedsYou.options` of a browser request (tf-hostd `browser.rs`).
pub(super) const CHOICE_SESSION: &str = "session";
pub(super) const CHOICE_TURN: &str = "turn";
pub(super) const CHOICE_DENY: &str = "deny";

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Attached {
    pub key: AttachKey,
    pub name: String,
    pub since: Millis,
    /// The port tf-hostd listens on for it, on its host (kept when it attaches again).
    pub host_port: u16,
    pub scope: BrowserScope,
    /// The link to its host that tf-hostd holds the attachment on (`Link::id`): it forgets it
    /// with that link.
    pub link: u64,
}

/// A request the user allowed while the cap was reached.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Waiting {
    pub request_id: String,
    pub key: AttachKey,
    pub scope: BrowserScope,
}

#[derive(Debug, Default)]
pub(super) struct Agents {
    pub attached: Vec<Attached>,
    /// Being attached right now: counted against the cap until the host answered.
    attaching: HashSet<AttachKey>,
    /// Allowed at the cap, oldest first.
    pub waiting: Vec<Waiting>,
    /// Every agent's last known name: tabs of a detached agent keep showing it.
    pub names: HashMap<AttachKey, String>,
}

impl Agents {
    pub fn get(&self, key: &AttachKey) -> Option<&Attached> {
        self.attached.iter().find(|a| a.key == *key)
    }

    /// Agents attached or being attached.
    fn in_use(&self) -> usize {
        self.attached.len() + self.attaching.iter().filter(|k| self.get(k).is_none()).count()
    }

    /// `key` may connect now: attached, or being attached (its host may hand over its first
    /// connection before this app read the host's answer).
    pub fn serves(&self, key: &AttachKey) -> bool {
        self.get(key).is_some() || self.attaching.contains(key)
    }

    /// `key` may attach now: it is attached or being attached already, there is room under
    /// `cap`, or the user wants it anyway (`over_cap`).
    pub fn admits(&self, key: &AttachKey, cap: u32, over_cap: bool) -> bool {
        over_cap || self.get(key).is_some() || self.attaching.contains(key) || self.in_use() < cap as usize
    }

    /// Claims a slot for `key` while its host attaches it; `false` at the cap.
    pub fn begin(&mut self, key: &AttachKey, cap: u32, over_cap: bool) -> bool {
        if !self.admits(key, cap, over_cap) {
            return false;
        }
        self.attaching.insert(key.clone());
        true
    }

    /// The host answered an attach of `key`: attached (`Some`), or not. An attached agent's
    /// waiting entries go.
    pub fn finish(&mut self, key: &AttachKey, attached: Option<Attached>) {
        self.attaching.remove(key);
        if let Some(a) = attached {
            self.names.insert(a.key.clone(), a.name.clone());
            self.waiting.retain(|w| w.key != a.key);
            match self.attached.iter_mut().find(|x| x.key == a.key) {
                Some(x) => *x = a,
                None => self.attached.push(a),
            }
        }
    }

    pub fn remove(&mut self, key: &AttachKey) -> Option<Attached> {
        let i = self.attached.iter().position(|a| a.key == *key)?;
        Some(self.attached.remove(i))
    }

    /// Queues an allowed request; one entry per agent (a newer request takes its place).
    pub fn wait(&mut self, w: Waiting) {
        match self.waiting.iter_mut().find(|x| x.key == w.key) {
            Some(x) => *x = w,
            None => self.waiting.push(w),
        }
    }

    /// The waiting requests that fit under `cap` now, oldest first, taken out of the queue.
    pub fn admissible(&mut self, cap: u32) -> Vec<Waiting> {
        let room = (cap as usize).saturating_sub(self.in_use());
        let n = room.min(self.waiting.len());
        self.waiting.drain(..n).collect()
    }

    /// Keeps the waiting requests that are still pending; `true` when one went.
    pub fn prune(&mut self, pending: impl Fn(&Waiting) -> bool) -> bool {
        let n = self.waiting.len();
        self.waiting.retain(|w| pending(w));
        self.waiting.len() != n
    }

    /// The link `link` to `host_id` went down, and with it the attachments tf-hostd held on it:
    /// turn-scoped ones are over (the turn may end meanwhile) and returned; session-scoped ones
    /// stay, to attach again on the next link ([`Agents::relink`]).
    pub fn link_lost(&mut self, host_id: &str, link: u64) -> Vec<Attached> {
        let (gone, kept) =
            std::mem::take(&mut self.attached).into_iter().partition(|a| a.key.host_id == host_id && a.link == link && a.scope == BrowserScope::Turn);
        self.attached = kept;
        gone
    }

    /// A new link `link` to `host_id` is up: its attachments made on older links are returned,
    /// the turn-scoped ones taken out (ended), the session-scoped ones kept to attach again.
    pub fn relink(&mut self, host_id: &str, link: u64) -> (Vec<Attached>, Vec<Attached>) {
        let stale = |a: &Attached| a.key.host_id == host_id && a.link != link;
        let again: Vec<Attached> = self.attached.iter().filter(|a| stale(a) && a.scope == BrowserScope::Session).cloned().collect();
        let (ended, kept) = std::mem::take(&mut self.attached).into_iter().partition(|a| stale(a) && a.scope == BrowserScope::Turn);
        self.attached = kept;
        (ended, again)
    }
}

/// What an `agent.answer` of a browser request means: allow with a scope (`Some(Some)`), deny
/// (`Some(None)`), or nothing a browser request takes (`None`).
pub(super) fn answer_scope(a: &Answer) -> Option<Option<BrowserScope>> {
    if a.cancel {
        return Some(None);
    }
    match a.choices.first().map(String::as_str) {
        Some(CHOICE_SESSION) => Some(Some(BrowserScope::Session)),
        Some(CHOICE_TURN) => Some(Some(BrowserScope::Turn)),
        Some(CHOICE_DENY) => Some(None),
        _ => None,
    }
}

/// A browser request's notification actions where it can only be denied: the ones that deny, and
/// the ones that only open the agent (no answer).
pub(super) fn deny_only(actions: &mut Vec<NotifyAction>) {
    actions.retain(|a| a.answer.as_ref().is_none_or(|ans| answer_scope(ans) == Some(None)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(host: &str, agent: &str) -> AttachKey {
        AttachKey { host_id: host.into(), agent_id: agent.into() }
    }

    fn attached(k: &AttachKey, scope: BrowserScope) -> Attached {
        Attached { key: k.clone(), name: format!("{}-name", k.agent_id), since: 1, host_port: 9300, scope, link: 1 }
    }

    fn attach(a: &mut Agents, k: &AttachKey, cap: u32, over: bool) -> bool {
        if !a.begin(k, cap, over) {
            return false;
        }
        a.finish(k, Some(attached(k, BrowserScope::Session)));
        true
    }

    /// The cap counts attached agents and those being attached; an attached agent attaching again
    /// takes no new slot; over the cap only on request.
    #[test]
    fn cap() {
        let mut a = Agents::default();
        let (k1, k2, k3) = (key("h", "a1"), key("h", "a2"), key("g", "a3"));
        assert!(attach(&mut a, &k1, 2, false));
        assert!(a.begin(&k2, 2, false), "a slot while the host answers");
        assert!(a.serves(&k2), "its first connection may come before the host's answer is read");
        assert!(!a.serves(&k3));
        assert!(!a.admits(&k3, 2, false), "the second slot is taken by the attach in flight");
        assert!(a.admits(&k1, 2, false), "attaching again (another scope) at the cap");
        a.finish(&k2, None);
        assert!(!a.serves(&k2));
        assert!(a.admits(&k3, 2, false), "a failed attach frees its slot");
        assert!(attach(&mut a, &k2, 2, false));
        assert!(!attach(&mut a, &k3, 2, false));
        assert!(attach(&mut a, &k3, 2, true), "over the cap when the user says so");
        assert_eq!(a.attached.len(), 3);
        assert_eq!(a.names.get(&k3).map(String::as_str), Some("a3-name"));
    }

    /// Allowed requests wait at the cap, oldest first; a slot that frees admits the oldest; a
    /// request answered elsewhere or withdrawn leaves the queue; an agent that attaches some
    /// other way leaves it too.
    #[test]
    fn queue() {
        let mut a = Agents::default();
        let ks: Vec<AttachKey> = (1..=5).map(|i| key("h", &format!("a{i}"))).collect();
        for k in &ks[..2] {
            assert!(attach(&mut a, k, 2, false));
        }
        for (i, k) in ks[2..].iter().enumerate() {
            a.wait(Waiting { request_id: format!("r{i}"), key: k.clone(), scope: BrowserScope::Turn });
        }
        a.wait(Waiting { request_id: "r0b".into(), key: ks[2].clone(), scope: BrowserScope::Session });
        assert_eq!(a.waiting.iter().map(|w| w.request_id.as_str()).collect::<Vec<_>>(), ["r0b", "r1", "r2"], "a newer request keeps the agent's place");
        assert!(a.admissible(2).is_empty(), "no room");
        a.remove(&ks[0]);
        let next = a.admissible(2);
        assert_eq!(next.len(), 1);
        assert_eq!((next[0].key.clone(), next[0].scope), (ks[2].clone(), BrowserScope::Session));
        assert!(a.prune(|w| w.request_id != "r2"));
        assert!(!a.prune(|_| true));
        assert_eq!(a.waiting.len(), 1);
        assert!(attach(&mut a, &ks[3], 2, true));
        assert!(a.waiting.is_empty(), "attached over the cap: its waiting request is done");
        a.remove(&ks[1]);
        a.remove(&ks[3]);
        a.wait(Waiting { request_id: "x".into(), key: ks[4].clone(), scope: BrowserScope::Turn });
        assert_eq!(a.admissible(3).len(), 1, "room for all");
    }

    /// A lost link ends the host's turn-scoped attachments made on it ("Allow once" must not
    /// outlive a turn that may end meanwhile); session-scoped ones attach again on the next link,
    /// and a turn-scoped one the lost link's end missed (the new link came first) ends there.
    #[test]
    fn links_and_scopes() {
        let mut a = Agents::default();
        let (s, t, other, late) = (key("h", "s"), key("h", "t"), key("g", "t"), key("h", "late"));
        a.finish(&s, Some(attached(&s, BrowserScope::Session)));
        a.finish(&t, Some(attached(&t, BrowserScope::Turn)));
        a.finish(&other, Some(attached(&other, BrowserScope::Turn)));
        a.finish(&late, Some(Attached { link: 2, ..attached(&late, BrowserScope::Turn) }));
        let gone = a.link_lost("h", 1);
        assert_eq!(gone.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [t]);
        assert_eq!(a.attached.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [s.clone(), other.clone(), late.clone()]);
        assert!(a.link_lost("h", 9).is_empty(), "another link's end");
        let (ended, again) = a.relink("h", 3);
        assert_eq!(ended.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [late]);
        assert_eq!(again.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [s.clone()]);
        assert_eq!(a.attached.iter().map(|x| x.key.clone()).collect::<Vec<_>>(), [s, other], "session-scoped stay to attach again");
    }

    #[test]
    fn answers() {
        let ans = |choices: &[&str], cancel: bool| Answer { choices: choices.iter().map(|c| c.to_string()).collect(), text: None, cancel, chat: false, back: false };
        assert_eq!(answer_scope(&ans(&["session"], false)), Some(Some(BrowserScope::Session)));
        assert_eq!(answer_scope(&ans(&["turn"], false)), Some(Some(BrowserScope::Turn)));
        assert_eq!(answer_scope(&ans(&["deny"], false)), Some(None));
        assert_eq!(answer_scope(&ans(&[], true)), Some(None), "a dismissal denies");
        assert_eq!(answer_scope(&ans(&["yes"], false)), None);
        assert_eq!(answer_scope(&ans(&[], false)), None);
    }

    /// Without the browser a request's notification offers Deny and Open, never an Allow.
    #[test]
    fn notification_deny_only() {
        let act = |id: &str, answer: bool| NotifyAction {
            id: id.into(),
            label: id.into(),
            answer: answer.then(|| Answer { choices: vec![id.into()], text: None, cancel: false, chat: false, back: false }),
        };
        let mut actions = vec![act(CHOICE_SESSION, true), act(CHOICE_TURN, true), act(CHOICE_DENY, true), act("open", false)];
        deny_only(&mut actions);
        assert_eq!(actions.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), [CHOICE_DENY, "open"]);
    }
}
