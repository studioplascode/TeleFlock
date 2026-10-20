//! Which client opened which agent session (`session.open` / `session.close`).
//!
//! Delivery itself happens inside the omp session (see `omp::OmpSession::subscribe`) so
//! that the snapshot and the following live events are ordered under one lock; this
//! index only remembers what to undo on `session.close` or disconnect.

use std::collections::HashMap;
use std::sync::Mutex;

/// One open session subscription.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Sub {
    pub agent_id: String,
    /// omp session id the subscription is attached to.
    pub omp_session: String,
}

#[derive(Default)]
pub struct SessionSubs {
    by_client: Mutex<HashMap<String, Vec<Sub>>>,
}

impl SessionSubs {
    /// Records a subscription; returns the previous one of this client for the same agent.
    pub fn add(&self, client_id: &str, sub: Sub) -> Option<Sub> {
        let mut m = self.by_client.lock().unwrap_or_else(|p| p.into_inner());
        let list = m.entry(client_id.to_string()).or_default();
        let prev = list.iter().position(|s| s.agent_id == sub.agent_id).map(|i| list.remove(i));
        list.push(sub);
        prev
    }

    pub fn remove(&self, client_id: &str, agent_id: &str) -> Option<Sub> {
        let mut m = self.by_client.lock().unwrap_or_else(|p| p.into_inner());
        let list = m.get_mut(client_id)?;
        let i = list.iter().position(|s| s.agent_id == agent_id)?;
        Some(list.remove(i))
    }

    /// Forgets every subscription of a client and returns them.
    pub fn take_client(&self, client_id: &str) -> Vec<Sub> {
        self.by_client.lock().unwrap_or_else(|p| p.into_inner()).remove(client_id).unwrap_or_default()
    }

    /// All (client id, sub) pairs for an agent.
    pub fn for_agent(&self, agent_id: &str) -> Vec<(String, Sub)> {
        let m = self.by_client.lock().unwrap_or_else(|p| p.into_inner());
        m.iter()
            .flat_map(|(c, subs)| subs.iter().filter(|s| s.agent_id == agent_id).map(move |s| (c.clone(), s.clone())))
            .collect()
    }

    pub fn all(&self) -> Vec<(String, Sub)> {
        let m = self.by_client.lock().unwrap_or_else(|p| p.into_inner());
        m.iter().flat_map(|(c, subs)| subs.iter().map(move |s| (c.clone(), s.clone()))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_replace_remove() {
        let s = SessionSubs::default();
        assert!(s.add("c1", Sub { agent_id: "a".into(), omp_session: "s1".into() }).is_none());
        let prev = s.add("c1", Sub { agent_id: "a".into(), omp_session: "s2".into() }).unwrap();
        assert_eq!(prev.omp_session, "s1");
        assert_eq!(s.for_agent("a").len(), 1);
        assert_eq!(s.take_client("c1").len(), 1);
        assert!(s.remove("c1", "a").is_none());
    }
}
