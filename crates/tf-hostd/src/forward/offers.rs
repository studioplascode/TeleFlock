//! The rules connected apps offer this host as their from-host (`fwdOffer`): per name, the
//! newest offer wins; the offers of an app vanish with its connection.

use std::collections::{BTreeMap, HashMap};

use tf_proto::FwdOffer;

/// Every connected app's offers.
#[derive(Default)]
pub(crate) struct Offers {
    by_client: HashMap<String, ClientOffers>,
    /// Stamps offers: higher = newer.
    seq: u64,
}

struct ClientOffers {
    /// The app's device name (what `--list` and refusals show).
    device: String,
    /// Each offer with the stamp of when it last changed.
    entries: Vec<(FwdOffer, u64)>,
}

/// The offer that wins a name.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Winner {
    pub client: String,
    pub device: String,
    pub offer: FwdOffer,
}

impl Offers {
    /// Replaces `client`'s offers. An offer that is new, or differs from the one it replaces,
    /// becomes the newest of its name; an unchanged one keeps its place.
    pub fn set(&mut self, client: &str, device: &str, offers: Vec<FwdOffer>) {
        let old = self.by_client.remove(client).map(|c| c.entries).unwrap_or_default();
        let mut entries = Vec::with_capacity(offers.len());
        for offer in offers {
            if entries.iter().any(|(o, _): &(FwdOffer, u64)| o.name == offer.name) {
                continue;
            }
            let stamp = match old.iter().find(|(o, _)| *o == offer) {
                Some((_, s)) => *s,
                None => {
                    self.seq += 1;
                    self.seq
                }
            };
            entries.push((offer, stamp));
        }
        if !entries.is_empty() {
            self.by_client.insert(client.to_string(), ClientOffers { device: device.to_string(), entries });
        }
    }

    pub fn remove(&mut self, client: &str) {
        self.by_client.remove(client);
    }

    /// The names `client` offers.
    pub fn names_of(&self, client: &str) -> Vec<String> {
        self.by_client.get(client).map(|c| c.entries.iter().map(|(o, _)| o.name.clone()).collect()).unwrap_or_default()
    }

    /// Clients with offers.
    pub fn clients(&self) -> Vec<String> {
        self.by_client.keys().cloned().collect()
    }

    /// The newest offer of every name, by name.
    pub fn winners(&self) -> BTreeMap<String, Winner> {
        let mut best: BTreeMap<String, (u64, Winner)> = BTreeMap::new();
        for (client, c) in &self.by_client {
            for (offer, stamp) in &c.entries {
                if best.get(&offer.name).is_none_or(|(s, _)| stamp > s) {
                    let w = Winner { client: client.clone(), device: c.device.clone(), offer: offer.clone() };
                    best.insert(offer.name.clone(), (*stamp, w));
                }
            }
        }
        best.into_iter().map(|(k, (_, w))| (k, w)).collect()
    }

    pub fn winner(&self, name: &str) -> Option<Winner> {
        self.winners().remove(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer(name: &str, to: &str) -> FwdOffer {
        FwdOffer { name: name.into(), to: to.into(), shell: true, tools: vec![], ports: vec![], ready: true, reason: None }
    }

    #[test]
    fn the_newest_offer_of_a_name_wins_and_offers_vanish_with_their_app() {
        let mut o = Offers::default();
        o.set("c1", "laptop app", vec![offer("mac", "Mac A"), offer("pc", "PC")]);
        o.set("c2", "phone app", vec![offer("mac", "Mac B")]);
        assert_eq!(o.winner("mac").unwrap().client, "c2", "c2 offered mac last");
        assert_eq!(o.winner("pc").unwrap().device, "laptop app");
        // c1 re-sends the same offers (another rule changed): mac stays with c2.
        o.set("c1", "laptop app", vec![offer("mac", "Mac A"), offer("pc", "PC"), offer("nas", "NAS")]);
        assert_eq!(o.winner("mac").unwrap().client, "c2");
        // c1 changes its mac offer: now it is the newest.
        o.set("c1", "laptop app", vec![offer("mac", "Mac A2"), offer("pc", "PC")]);
        assert_eq!(o.winner("mac").unwrap().offer.to, "Mac A2");
        assert!(o.winner("nas").is_none(), "withdrawn");
        o.remove("c1");
        assert_eq!(o.winner("mac").unwrap().offer.to, "Mac B", "the other app takes over");
        assert!(o.winner("pc").is_none());
        o.set("c2", "phone app", vec![]);
        assert!(o.winners().is_empty() && o.clients().is_empty());
    }

    #[test]
    fn a_name_offered_twice_by_one_app_counts_once() {
        let mut o = Offers::default();
        o.set("c1", "d", vec![offer("mac", "first"), offer("mac", "second")]);
        assert_eq!(o.names_of("c1"), vec!["mac".to_string()]);
        assert_eq!(o.winner("mac").unwrap().offer.to, "first");
    }
}
