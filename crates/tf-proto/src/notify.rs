//! Notifications that find you (architecture §3.21): device presence, the per-host routing policy
//! and push channels (ntfy, Pushover, a webhook).
//!
//! * Apps that negotiated [`crate::host::FEATURE_PRESENCE`] send a [`Presence`] after the welcome
//!   and whenever it changes, and tell tf-hostd which notifications they marked read
//!   (`notifyRead`). tf-hostd then alerts the device in use first (`notify.alert`), escalates an
//!   unseen notification after the policy's delay (`notifyAlert`) and retracts a notification on
//!   every other device once one device read it (`notifyDone`). Apps without the feature get
//!   every notification and alert for all of them, as before.
//! * Push channels deliver from tf-hostd itself, so they reach you with no app connected (and on
//!   an iPhone, which has no TeleFlock app). Their secrets stay on the host, owner-only, and are
//!   write-only over the wire: [`PushChannel`] lists which ones are stored, never their values.

use crate::model::NotifyKind;
use crate::Millis;

wire_enum! {
    /// What the user is doing with a device, as the device reports it.
    pub enum PresenceState {
        /// In use: input within the device's idle threshold.
        Active,
        /// On, but no input for a while (or TeleFlock in the background).
        Idle,
        /// Nobody is looking: the screen is locked.
        Away,
    }
}

wire_enum! {
    /// What a device is, for routing: escalations go to phones.
    pub enum DeviceKind { Desktop, Phone, Web }
}

wire_struct! {
    /// `presence` message of an app that negotiated the `presence` feature.
    pub struct Presence {
        pub state: PresenceState,
        pub device: DeviceKind,
        /// The user's last input on this device (ms since the epoch), when known.
        pub input_at: Option<Millis>,
        /// The app can show system notifications here (supported and allowed).
        pub os_notifications: bool,
    }
}

wire_struct! {
    /// `app.presence`: what the UI sees of the user (desktop window, browser tab, Android activity).
    /// The app core adds what the system knows (idle time, a locked screen) and the device settings.
    pub struct UiPresence {
        /// The window or tab is shown (not minimized, hidden to the tray or in the background).
        pub visible: bool,
        /// It has the keyboard focus.
        pub focused: bool,
        /// Last pointer, key or touch input in the app (ms since the epoch).
        pub input_at: Option<Millis>,
    }
}

wire_enum! {
    /// Which devices an unseen notification escalates to.
    pub enum EscalateTo {
        /// Phones; every device when no phone is connected.
        Phones,
        /// Every connected device.
        All,
    }
}

wire_struct! {
    /// How one host routes notifications to the connected devices (`notify.config`,
    /// `notify.setPolicy`).
    pub struct NotifyPolicy {
        /// Alert only the device in use (else the phones); the others list the notification
        /// quietly. Off: every device alerts, as before 0.7.0.
        pub route: bool,
        /// Seconds a needs-you, error or stall notification may stay unseen before it also alerts
        /// the escalation devices. 0: never.
        pub escalate_after_s: u32,
        pub escalate_to: EscalateTo,
    }
}

wire_enum! { pub enum PushKind { Ntfy, Pushover, Webhook } }

wire_enum! {
    /// When a push channel delivers.
    pub enum PushWhen {
        /// Only while no TeleFlock app is connected to this host.
        Offline,
        /// Also when a notification escalates: nobody saw it on a device in time.
        Unseen,
        /// Every notification.
        Always,
    }
}

wire_struct! {
    /// The outcome of one delivery to a push channel.
    pub struct PushResult {
        pub at: Millis,
        pub ok: bool,
        /// HTTP status, when the server answered.
        pub status: Option<u16>,
        /// What went wrong; never contains a secret.
        pub error: Option<String>,
        /// A `notify.test` delivery.
        #[serde(default)]
        pub test: bool,
    }
}

wire_struct! {
    /// A push channel as the app sees it: no secret values, only which ones are stored.
    pub struct PushChannel {
        pub id: String,
        pub kind: PushKind,
        pub name: String,
        pub enabled: bool,
        pub when: PushWhen,
        /// Notification kinds this channel sends.
        pub kinds: Vec<NotifyKind>,
        /// Only the agent's name and what happened leave the host, not the question or text.
        pub private: bool,
        /// Where it goes, secrets masked (`ntfy.sh · topic tf-…9z`, `Pushover`, `hooks.example.com`).
        pub target: String,
        /// Stored secret fields: `url`, `token`, `user`, `secret`.
        pub saved: Vec<String>,
        pub last: Option<PushResult>,
    }
}

wire_struct! {
    /// `notify.saveChannel`: creates a channel (`id` absent) or updates one. Secret fields: absent
    /// keeps the stored value, empty deletes it.
    pub struct PushChannelSave {
        pub id: Option<String>,
        pub kind: PushKind,
        pub name: String,
        pub enabled: bool,
        pub when: PushWhen,
        pub kinds: Vec<NotifyKind>,
        #[serde(default)]
        pub private: bool,
        /// ntfy: the topic URL (`https://ntfy.sh/<topic>`); webhook: the URL to POST to. Both are
        /// secrets: whoever knows a public topic or a hook URL can read or post to it.
        pub url: Option<String>,
        /// ntfy: an access token (protected topics); Pushover: the application's API token.
        pub token: Option<String>,
        /// Pushover: the user (or group) key.
        pub user: Option<String>,
        /// Webhook: the HMAC-SHA256 signing secret (`X-TeleFlock-Signature`).
        pub secret: Option<String>,
    }
}

wire_struct! { pub struct PushChannelRef { pub id: String } }

wire_struct! {
    /// An app connected to the host's herdr session, as `notify.config` lists it.
    pub struct DevicePresence {
        /// Device name (hello `client.device`).
        pub name: String,
        /// `windows` | `android` | `linux` | `macos` | `web`.
        pub platform: String,
        /// Absent: an app that reports no presence (before 0.7.0); it alerts for everything.
        pub presence: Option<Presence>,
        /// The app that asked.
        #[serde(default)]
        pub me: bool,
    }
}

wire_struct! {
    pub struct NotifyConfig {
        pub policy: NotifyPolicy,
        pub channels: Vec<PushChannel>,
        /// Apps connected to this herdr session now.
        pub devices: Vec<DevicePresence>,
    }
}

wire_struct! {
    /// `notify.test`: with `channelId`, a test push through that channel (also stored as its
    /// `last`); without, a test notification routed to this host's devices like a real one, which
    /// escalates per the policy when `escalate` is set.
    pub struct NotifyTestParams {
        pub channel_id: Option<String>,
        #[serde(default)]
        pub escalate: bool,
    }
}

wire_struct! {
    pub struct NotifyTestResult {
        /// A channel test's outcome.
        pub push: Option<PushResult>,
        /// A routed test: the devices that alerted at once.
        #[serde(default)]
        pub alerted: Vec<String>,
    }
}
