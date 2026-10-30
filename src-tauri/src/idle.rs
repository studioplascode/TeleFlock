//! System presence for the desktop engine: how long ago the user last touched keyboard or
//! pointer anywhere in the session, and whether the screen is locked. The engine combines it with
//! what the UI reports into the device presence it sends to hosts (`Platform::system_presence`,
//! polled about every 15 s from `spawn_blocking`).
//!
//! * Windows: `GetLastInputInfo` against `GetTickCount` (per session); lock = the input desktop
//!   is not switchable (the Winlogon / secure desktop is in front), the way Chromium checks it.
//! * macOS: `CGEventSourceSecondsSinceLastEventType` on the combined session state. The lock state
//!   needs a CoreFoundation dictionary lookup that is not worth it: a locked Mac is idle and
//!   turns `away` through the idle time.
//! * Linux: D-Bus. Idle time from GNOME's `org.gnome.Mutter.IdleMonitor`, else KDE's
//!   `org.freedesktop.ScreenSaver.GetSessionIdleTime` (X11 only: KDE answers an error on Wayland);
//!   lock from `GetActive` of `org.freedesktop.ScreenSaver` or `org.gnome.ScreenSaver`. The source
//!   that answers is remembered; a desktop with none (sway, i3, xfce) reports unknown and the
//!   presence rests on what the window reports. A failed probe is repeated only every 5 minutes.

use std::time::Duration;

use tf_client::SystemPresence;

/// Reads the system presence of this OS (unknown on platforms without a source).
pub fn system_presence() -> SystemPresence {
    #[cfg(windows)]
    return win::read();
    #[cfg(target_os = "macos")]
    return mac::read();
    #[cfg(target_os = "linux")]
    return linux::read();
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    SystemPresence::default()
}

/// Seconds since the last input as reported by CoreGraphics; negative or non-finite = unknown.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn duration_from_secs(secs: f64) -> Option<Duration> {
    (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs))
}

#[cfg(windows)]
mod win {
    use std::time::Duration;

    use tf_client::SystemPresence;
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, DESKTOP_SWITCHDESKTOP, OpenInputDesktop, SwitchDesktop};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    pub fn read() -> SystemPresence {
        SystemPresence { idle: idle(), locked: Some(locked()) }
    }

    fn idle() -> Option<Duration> {
        let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: `info` is a valid LASTINPUTINFO with `cbSize` set.
        if !unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return None;
        }
        // Both are 32-bit tick counts that wrap together every 49.7 days.
        let ticks = unsafe { GetTickCount() }.wrapping_sub(info.dwTime);
        Some(Duration::from_millis(u64::from(ticks)))
    }

    /// The workstation is locked (or a secure desktop such as UAC is up) when the input desktop
    /// cannot be opened for switching: nobody can see a toast either way.
    fn locked() -> bool {
        // SAFETY: plain Win32 calls; the handle is closed before returning.
        unsafe {
            match OpenInputDesktop(Default::default(), false, DESKTOP_SWITCHDESKTOP) {
                Ok(desktop) => {
                    let switched = SwitchDesktop(desktop).is_ok();
                    let _ = CloseDesktop(desktop);
                    !switched
                }
                Err(_) => true,
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use tf_client::SystemPresence;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    /// `kCGEventSourceStateCombinedSessionState`.
    const COMBINED_SESSION_STATE: i32 = 0;
    /// `kCGAnyInputEventType`.
    const ANY_INPUT_EVENT_TYPE: u32 = !0;

    pub fn read() -> SystemPresence {
        // SAFETY: a pure query with plain integer arguments.
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT_TYPE) };
        SystemPresence { idle: super::duration_from_secs(secs), locked: None }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use tf_client::SystemPresence;
    use zbus::blocking::Connection;

    /// A desktop service that doesn't answer (GNOME Shell or kscreenlocker stuck across a suspend,
    /// heavy load) must not park the poller behind [`STATE`]: zbus waits forever by default.
    const CALL_TIMEOUT: Duration = Duration::from_secs(2);

    /// After a probe found no source, the next one waits this long.
    const REPROBE: Duration = Duration::from_secs(300);

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum IdleSource {
        /// GNOME Shell: `GetIdletime() -> u64` milliseconds.
        Mutter,
        /// KDE (X11): `GetSessionIdleTime() -> u32` milliseconds (`KIdleTime::idleTime`).
        KdeScreenSaver,
    }

    const IDLE_SOURCES: [IdleSource; 2] = [IdleSource::Mutter, IdleSource::KdeScreenSaver];

    /// (bus name = interface, object path) of a `GetActive() -> bool` screen saver.
    type LockSource = (&'static str, &'static str);
    const LOCK_SOURCES: [LockSource; 3] = [
        ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver"),
        ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"),
        ("org.freedesktop.ScreenSaver", "/ScreenSaver"),
    ];

    #[derive(Default)]
    struct State {
        conn: Option<Connection>,
        idle: Option<IdleSource>,
        lock: Option<LockSource>,
        /// No idle probe before this instant (None = probe now).
        idle_probe_after: Option<Instant>,
        lock_probe_after: Option<Instant>,
    }

    static STATE: Mutex<State> = Mutex::new(State { conn: None, idle: None, lock: None, idle_probe_after: None, lock_probe_after: None });

    pub fn read() -> SystemPresence {
        let mut s = STATE.lock().unwrap_or_else(|e| e.into_inner());
        if s.conn.is_none() {
            match zbus::blocking::connection::Builder::session().and_then(|b| b.method_timeout(CALL_TIMEOUT).build()) {
                Ok(c) => s.conn = Some(c),
                Err(e) => {
                    log::debug!("system presence: no D-Bus session bus: {e}");
                    return SystemPresence::default();
                }
            }
        }
        let Some(conn) = s.conn.clone() else { return SystemPresence::default() };
        let now = Instant::now();
        let idle = read_idle(&conn, &mut s, now);
        let locked = read_lock(&conn, &mut s, now);
        SystemPresence { idle, locked }
    }

    fn read_idle(conn: &Connection, s: &mut State, now: Instant) -> Option<Duration> {
        if let Some(src) = s.idle {
            if let Some(d) = query_idle(conn, src) {
                return Some(d);
            }
            log::info!("system presence: {src:?} stopped answering");
            s.idle = None;
            s.idle_probe_after = Some(now + REPROBE);
            return None;
        }
        if s.idle_probe_after.is_some_and(|t| now < t) {
            return None;
        }
        for src in IDLE_SOURCES {
            if let Some(d) = query_idle(conn, src) {
                log::info!("system presence: idle time from {src:?}");
                s.idle = Some(src);
                return Some(d);
            }
        }
        log::info!("system presence: this desktop offers no idle time over D-Bus; the window's own input is used");
        s.idle_probe_after = Some(now + REPROBE);
        None
    }

    fn read_lock(conn: &Connection, s: &mut State, now: Instant) -> Option<bool> {
        if let Some(src) = s.lock {
            if let Some(l) = query_lock(conn, src) {
                return Some(l);
            }
            s.lock = None;
            s.lock_probe_after = Some(now + REPROBE);
            return None;
        }
        if s.lock_probe_after.is_some_and(|t| now < t) {
            return None;
        }
        for src in LOCK_SOURCES {
            if let Some(l) = query_lock(conn, src) {
                log::info!("system presence: lock state from {}", src.0);
                s.lock = Some(src);
                return Some(l);
            }
        }
        s.lock_probe_after = Some(now + REPROBE);
        None
    }

    fn query_idle(conn: &Connection, src: IdleSource) -> Option<Duration> {
        let ms = match src {
            IdleSource::Mutter => conn
                .call_method(
                    Some("org.gnome.Mutter.IdleMonitor"),
                    "/org/gnome/Mutter/IdleMonitor/Core",
                    Some("org.gnome.Mutter.IdleMonitor"),
                    "GetIdletime",
                    &(),
                )
                .ok()?
                .body()
                .deserialize::<u64>()
                .ok()?,
            IdleSource::KdeScreenSaver => u64::from(
                conn.call_method(
                    Some("org.freedesktop.ScreenSaver"),
                    "/org/freedesktop/ScreenSaver",
                    Some("org.freedesktop.ScreenSaver"),
                    "GetSessionIdleTime",
                    &(),
                )
                .ok()?
                .body()
                .deserialize::<u32>()
                .ok()?,
            ),
        };
        Some(Duration::from_millis(ms))
    }

    fn query_lock(conn: &Connection, (name, path): LockSource) -> Option<bool> {
        conn.call_method(Some(name), path, Some(name), "GetActive", &()).ok()?.body().deserialize::<bool>().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coregraphics_seconds_become_durations() {
        assert_eq!(duration_from_secs(0.0), Some(Duration::ZERO));
        assert_eq!(duration_from_secs(2.5), Some(Duration::from_millis(2500)));
        assert_eq!(duration_from_secs(-1.0), None);
        assert_eq!(duration_from_secs(f64::NAN), None);
        assert_eq!(duration_from_secs(f64::INFINITY), None);
    }

    /// Whatever this machine offers, reading never panics and the idle time is plausible.
    #[test]
    fn reading_the_system_presence_is_safe() {
        let p = system_presence();
        if let Some(d) = p.idle {
            assert!(d < Duration::from_secs(60 * 60 * 24 * 365));
        }
    }
}
