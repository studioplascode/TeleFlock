//! Host-OS integration supplied by the embedder (Tauri shell, devserver).

use tf_proto::{ApiError, HostProfile, Notification};

/// How a notification should be presented (derived from settings + quiet hours).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NotifyStyle {
    /// Play the platform sound (`settings.notifySound` and not in quiet hours).
    pub sound: bool,
    /// Quiet hours: post silently (no heads-up / toast popup, no sound); keep it in the shade.
    pub silent: bool,
    /// Offer an inline text reply (Android RemoteInput / toast input). Route the text to
    /// [`crate::Engine::notification_action`] with `reply: Some(text)`; the engine answers
    /// the pending request as free text or sends it as a prompt.
    pub reply: bool,
}

/// Aggregate counts across all connected hosts (tray badge, taskbar overlay,
/// Android foreground-service text "3 running · 2 need you").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BadgeState {
    /// Agents in the Needs-you column (the badge number).
    pub needs: u32,
    /// Agents in the Running column.
    pub running: u32,
}

/// Implemented by the embedder. All methods are called from tokio tasks and must not block
/// for long (dispatch to the UI thread internally if needed).
pub trait Platform: Send + Sync + 'static {
    /// Show an OS notification. Called only after the engine applied the notification
    /// settings (`notifyNeeds`/`notifyFinished`/`notifyErrors`). `n.actions` holds at most 3
    /// actions; route activations back through [`crate::Engine::notification_action`].
    /// `host` is `None` only for `app.notifyTest`.
    fn notify(&self, host: Option<&HostProfile>, n: &Notification, style: NotifyStyle);
    /// Open a URL in the system browser (Tailscale auth URLs, previews).
    fn open_external(&self, url: &str) -> Result<(), ApiError>;
    /// Android: hold the foreground service while `on`. Called when
    /// `settings.keepAlive && any host is connecting/online` changes.
    fn set_keep_alive(&self, on: bool);
    /// Called whenever the aggregate counts change.
    fn set_badge(&self, badge: BadgeState);
    /// Default device name (used when `settings.deviceName` is empty).
    fn device_name(&self) -> String;
    /// `AppCapabilities.notifications`.
    fn supports_notifications(&self) -> bool {
        true
    }
}
