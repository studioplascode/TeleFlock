//! This device's presence (architecture §5.2): what the UI sees (`app.presence`) and what the
//! system knows (`Platform::system_presence`), reduced to the [`Presence`] the app reports to
//! hosts that negotiated the `presence` feature. Hosts alert the device in use first and escalate
//! to phones when nobody saw a notification in time.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tf_proto::{DeviceKind, Millis, Presence, PresenceState, Settings, UiPresence};

use crate::platform::{Platform, SystemPresence};

/// Minutes without input before a device counts as idle, unless the settings say otherwise.
pub const IDLE_AFTER_MIN: u16 = 3;
/// How often the engine re-reads the system's idle time and re-evaluates (an idle threshold is
/// crossed without any event).
pub const TICK: Duration = Duration::from_secs(15);

/// How long one read of the system's presence may take before it counts as unknown. The shell asks
/// desktop services (D-Bus on Linux) that can stop answering; the answer is not worth a stalled
/// refresh, and the next tick asks again.
pub const SYSTEM_DEADLINE: Duration = Duration::from_secs(3);

/// What this device is, by settings or platform.
pub fn device_kind(settings: &Settings, platform: &str) -> DeviceKind {
    settings.device_kind.unwrap_or(match platform {
        "android" => DeviceKind::Phone,
        "web" => DeviceKind::Web,
        _ => DeviceKind::Desktop,
    })
}

/// Shares presence with hosts (`settings.sharePresence`, on unless switched off).
pub fn sharing(settings: &Settings) -> bool {
    settings.share_presence != Some(false)
}

/// The presence to report.
/// - `away`: the screen is locked;
/// - `active`: input within the idle threshold, anywhere on the system when the shell can tell,
///   else in TeleFlock while its window is shown;
/// - `idle` otherwise.
pub fn compute(ui: &UiPresence, sys: SystemPresence, settings: &Settings, platform: &str, os_notifications: bool, now: Millis) -> Presence {
    let idle_after = i64::from(settings.idle_after_min.unwrap_or(IDLE_AFTER_MIN).clamp(1, 60)) * 60_000;
    let sys_input = sys.idle.map(|d| now - i64::try_from(d.as_millis()).unwrap_or(i64::MAX).min(now));
    // Input in a hidden window is stale; with the system's idle time it is part of that anyway.
    let ui_input = ui.input_at.filter(|_| ui.visible || ui.focused);
    let input_at = sys_input.max(ui_input);
    let state = if sys.locked == Some(true) {
        PresenceState::Away
    } else if input_at.is_some_and(|t| now - t <= idle_after) {
        PresenceState::Active
    } else {
        PresenceState::Idle
    };
    Presence { state, device: device_kind(settings, platform), input_at: input_at.or(ui.input_at), os_notifications }
}

/// Whether `next` says something hosts route by that `prev` did not (the input time alone, which
/// moves with every key press while active, does not).
pub fn changed(prev: Option<&Presence>, next: &Presence) -> bool {
    prev.is_none_or(|p| p.state != next.state || p.device != next.device || p.os_notifications != next.os_notifications)
}

/// Reads the system's presence off the async runtime; unknown when the platform doesn't answer
/// within `deadline` (its blocking call is left to finish on its own).
pub async fn read_system(platform: Arc<dyn Platform>, deadline: Duration) -> SystemPresence {
    match tokio::time::timeout(deadline, tokio::task::spawn_blocking(move || platform.system_presence())).await {
        Ok(read) => read.unwrap_or_default(),
        Err(_) => {
            log::warn!("presence: the system did not answer within {deadline:?}");
            SystemPresence::default()
        }
    }
}

/// Orders and coalesces presence refreshes. One refresh runs at a time, from reading the inputs
/// to handing the result to the links, so the newest read is always the last one a host gets
/// (two refreshes racing could deliver an older presence after a newer one, and the host keeps
/// the stale one: only a *change* is ever sent). Callers that must not wait ask with
/// [`Refresh::claim`] and run the refresh in a task of their own.
#[derive(Default)]
pub struct Refresh {
    gate: tokio::sync::Mutex<()>,
    queued: AtomicBool,
}

impl Refresh {
    /// `true` when the caller should start a refresh task: none is queued behind the running one
    /// yet (a queued one starts after this request, so it sees what changed).
    pub fn claim(&self) -> bool {
        !self.queued.swap(true, Ordering::AcqRel)
    }

    /// Runs `work` alone. A refresh queued by [`Refresh::claim`] counts as started.
    pub async fn exclusive<T>(&self, work: impl std::future::Future<Output = T>) -> T {
        let _turn = self.gate.lock().await;
        self.queued.store(false, Ordering::Release);
        work.await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_settings;

    const NOW: Millis = 10_000_000;

    fn ui(visible: bool, input_ago_ms: Option<i64>) -> UiPresence {
        UiPresence { visible, focused: visible, input_at: input_ago_ms.map(|a| NOW - a) }
    }

    #[test]
    fn input_anywhere_or_in_a_shown_window_means_in_use() {
        let s = default_settings("d".into());
        let none = SystemPresence::default();
        let p = compute(&ui(true, Some(60_000)), none, &s, "linux", true, NOW);
        assert_eq!((p.state, p.device, p.input_at), (PresenceState::Active, DeviceKind::Desktop, Some(NOW - 60_000)));
        assert_eq!(compute(&ui(true, Some(181_000)), none, &s, "linux", true, NOW).state, PresenceState::Idle, "3 min by default");
        assert_eq!(compute(&ui(false, Some(1_000)), none, &s, "linux", true, NOW).state, PresenceState::Idle, "hidden to the tray");
        // Typing in another app on the same desktop: the system says so.
        let busy = SystemPresence { idle: Some(Duration::from_secs(5)), locked: Some(false) };
        let p = compute(&ui(false, None), busy, &s, "windows", true, NOW);
        assert_eq!((p.state, p.input_at), (PresenceState::Active, Some(NOW - 5_000)));
        let locked = SystemPresence { idle: Some(Duration::from_secs(5)), locked: Some(true) };
        assert_eq!(compute(&ui(true, Some(0)), locked, &s, "macos", true, NOW).state, PresenceState::Away);
        let long = SystemPresence { idle: Some(Duration::from_secs(3600)), locked: None };
        assert_eq!(compute(&ui(true, Some(10_000)), long, &s, "linux", true, NOW).state, PresenceState::Active, "the newer input counts");
        assert_eq!(compute(&UiPresence { visible: false, focused: false, input_at: None }, SystemPresence::default(), &s, "android", false, NOW).state, PresenceState::Idle);
    }

    #[test]
    fn settings_choose_the_kind_and_the_threshold() {
        let mut s = default_settings("d".into());
        assert_eq!(device_kind(&s, "android"), DeviceKind::Phone);
        assert_eq!(device_kind(&s, "web"), DeviceKind::Web);
        s.device_kind = Some(DeviceKind::Phone);
        assert_eq!(device_kind(&s, "linux"), DeviceKind::Phone, "a tablet or a phone browser");
        s.idle_after_min = Some(10);
        assert_eq!(compute(&ui(true, Some(500_000)), SystemPresence::default(), &s, "linux", true, NOW).state, PresenceState::Active);
        assert!(sharing(&s));
        s.share_presence = Some(false);
        assert!(!sharing(&s));
    }

    #[test]
    fn only_what_routing_uses_counts_as_a_change() {
        let s = default_settings("d".into());
        let a = compute(&ui(true, Some(1_000)), SystemPresence::default(), &s, "linux", true, NOW);
        let b = compute(&ui(true, Some(2_000)), SystemPresence::default(), &s, "linux", true, NOW);
        assert!(changed(None, &a) && !changed(Some(&a), &b));
        let c = compute(&ui(true, Some(200_000)), SystemPresence::default(), &s, "linux", true, NOW);
        assert!(changed(Some(&a), &c));
    }

    struct Slow(Duration);
    impl Platform for Slow {
        fn notify(&self, _: Option<&tf_proto::HostProfile>, _: &tf_proto::Notification, _: crate::platform::NotifyStyle) {}
        fn open_external(&self, _: &str) -> Result<(), tf_proto::ApiError> {
            Ok(())
        }
        fn set_keep_alive(&self, _: bool) {}
        fn set_badge(&self, _: crate::platform::BadgeState) {}
        fn device_name(&self) -> String {
            "t".into()
        }
        fn system_presence(&self) -> SystemPresence {
            std::thread::sleep(self.0);
            SystemPresence { idle: Some(Duration::from_secs(7)), locked: None }
        }
    }

    /// A desktop service that never answers costs one deadline and reads as unknown.
    #[tokio::test]
    async fn a_silent_system_reads_as_unknown_after_the_deadline() {
        let t0 = std::time::Instant::now();
        let got = read_system(Arc::new(Slow(Duration::from_millis(600))), Duration::from_millis(50)).await;
        assert_eq!(got, SystemPresence::default());
        assert!(t0.elapsed() < Duration::from_millis(400), "{:?}", t0.elapsed());
        let got = read_system(Arc::new(Slow(Duration::ZERO)), Duration::from_secs(5)).await;
        assert_eq!(got.idle, Some(Duration::from_secs(7)));
    }

    /// Refreshes never overlap (so presence reaches hosts in the order it was read), and requests
    /// made while one is already queued join it instead of piling up.
    #[tokio::test]
    async fn refreshes_run_one_at_a_time_and_coalesce() {
        let r = Arc::new(Refresh::default());
        let running = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let runs = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut tasks = vec![];
        let mut claimed = 0;
        for _ in 0..10 {
            if r.claim() {
                claimed += 1;
                let (r, running, runs) = (r.clone(), running.clone(), runs.clone());
                tasks.push(tokio::spawn(async move {
                    r.exclusive(async {
                        assert_eq!(running.fetch_add(1, Ordering::SeqCst), 0, "two refreshes at once");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        runs.fetch_add(1, Ordering::SeqCst);
                        running.fetch_sub(1, Ordering::SeqCst);
                    })
                    .await
                }));
            }
        }
        assert_eq!(claimed, 1, "ten requests before the task started share one refresh");
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(r.claim(), "a request after it ran starts a new one");
        // A request that arrives while a refresh is running queues exactly one more, behind it.
        r.exclusive(async {}).await;
        r.exclusive(async {
            assert!(r.claim(), "queued while running");
            assert!(!r.claim());
        })
        .await;
    }
}
