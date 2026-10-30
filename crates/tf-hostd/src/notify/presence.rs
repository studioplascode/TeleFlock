//! Apps connected to this daemon and what their users are doing (architecture §3.21).

use tf_proto::{DevicePresence, Millis, Presence, PresenceState};

use crate::clients::ClientHandle;

/// One connected app (past hello and its first snapshot).
pub struct Device {
    pub client: ClientHandle,
    /// herdr session it attached to: it gets that session's notifications.
    pub session: String,
    /// Its last report; `None` before the first one, and always for apps without `presence`.
    pub presence: Option<Presence>,
}

impl Device {
    pub fn capable(&self) -> bool {
        self.client.features().presence
    }

    pub fn view(&self, me: bool) -> DevicePresence {
        let info = self.client.info();
        DevicePresence { name: info.device.clone(), platform: info.platform.clone(), presence: self.presence.clone(), me }
    }
}

/// What the apps of one herdr session say about their users (`Notifier::presence`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PresenceSummary {
    /// Apps connected to the session, any version.
    pub apps: usize,
    /// Of those, apps that report presence (0.7.0 and later).
    pub reporting: usize,
    /// Devices whose user is active now.
    pub active: usize,
    /// Latest user input any device reported (now for an active one).
    pub last_active_at: Option<Millis>,
}

pub fn summarize<'a>(devices: impl Iterator<Item = &'a Device>, now: Millis) -> PresenceSummary {
    let mut s = PresenceSummary::default();
    for d in devices {
        s.apps += 1;
        let Some(p) = d.presence.as_ref().filter(|_| d.capable()) else { continue };
        s.reporting += 1;
        let at = if p.state == PresenceState::Active {
            s.active += 1;
            Some(now)
        } else {
            p.input_at
        };
        s.last_active_at = s.last_active_at.max(at);
    }
    s
}
