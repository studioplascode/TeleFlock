//! When a downloaded desktop update (Windows, AppImage, `.deb`) is applied. Applying restarts the
//! app (Windows: the passive installer relaunches it) and the `.deb` also asks for the
//! administrator password, so an update the user didn't ask for must not do that while they are
//! working in the window.
//!
//! The decision ([`decide`]) is pure; `Updater` asks it after a download, whenever the main
//! window leaves the front and on quit.

// The desktop updater (Windows, Linux) is the only caller; Android and macOS compile it unused.
#![cfg_attr(not(desktop), allow(dead_code))]

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::release::Target;

/// Who started the check that found the update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// The user: **Check for updates**, **Update to vX**, **Restart now**, **Install**.
    Manual,
    /// The scheduler (`settings.autoUpdate`): launch, hourly and window-focus checks.
    Automatic,
}

/// What to do with a downloaded update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// Install and restart now.
    Now,
    /// Keep it ready (`UpdatePhase::Ready`) and ask again when the window leaves the front.
    Wait,
}

/// How long the window must stay out of the front before an automatic update restarts the app:
/// a quick alt-tab or a click on a notification is not "away".
pub const AWAY_GRACE: Duration = Duration::from_secs(20);

/// The main window is what the user is looking at: shown, not minimized, focused.
pub fn in_front(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
}

/// Quick capture is what the user is working in: they are typing in it while it is shown, it has
/// the focus, or it holds what a restart would lose (pasted images live in the page's memory only,
/// and a request waiting for the main window's answer is in flight), even if it was put away.
pub fn capture_in_front(visible: bool, focused: bool, typing: bool, unsaved: bool) -> bool {
    unsaved || (visible && (focused || typing))
}

/// Which departures from the front an installation may follow. Every return to the front (the main
/// window or Quick capture getting the focus, a capture opening or being typed in) and every
/// departure bumps one counter; a timer started for a departure is only good while the counter
/// still has the value it took, so the absence it measures is uninterrupted: alt-tab away at 0 s,
/// back at 5 s and away again at 19 s installs at 39 s, never at 20 s.
#[derive(Debug, Default)]
pub struct Away {
    events: AtomicU64,
}

/// What [`Away::left`] hands out: the count of events at the departure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Departure(u64);

impl Away {
    /// The user is back (or at work in a window of the app): any pending departure is void.
    pub fn returned(&self) {
        self.events.fetch_add(1, Ordering::SeqCst);
    }

    /// A window left the front now. Also voids an earlier departure's timer: it may have been
    /// started while the user was still in front of another window, and must not shorten this one.
    pub fn left(&self) -> Departure {
        Departure(self.events.fetch_add(1, Ordering::SeqCst) + 1)
    }

    /// Whether nothing happened since `since`: no return to the front and no later departure.
    pub fn unchanged(&self, since: Departure) -> bool {
        self.events.load(Ordering::SeqCst) == since.0
    }

    /// Waits `grace`, then says whether the absence went on without a break ([`Self::unchanged`]).
    pub async fn stayed_away(&self, since: Departure, grace: Duration) -> bool {
        tokio::time::sleep(grace).await;
        self.unchanged(since)
    }
}

/// A manual install always runs at once. An automatic one never runs the `.deb`'s `pkexec` password
/// prompt unattended (the user clicks **Install**), and otherwise waits while the user is in front.
/// Android and macOS never get here (the system installer / the browser take over).
pub fn decide(origin: Origin, target: Target, in_front: bool) -> Apply {
    match (origin, target) {
        (Origin::Manual, _) => Apply::Now,
        (Origin::Automatic, Target::Deb) => Apply::Wait,
        (Origin::Automatic, Target::Windows | Target::AppImage) if in_front => Apply::Wait,
        (Origin::Automatic, _) => Apply::Now,
    }
}

/// Installing asks the user for a password (`pkexec dpkg -i`): the UI offers **Install**, not
/// **Restart now**.
pub fn needs_password(target: Target) -> bool {
    target == Target::Deb
}

/// A downloaded update still waiting at quit is installed then. Only the AppImage does: replacing
/// its file doesn't restart anything. The Windows installer relaunches the app, which a quit must
/// not do, and the `.deb` needs the password prompt; both are downloaded again next time.
pub fn applies_on_quit(target: Target) -> bool {
    target == Target::AppImage
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Target; 5] = [Target::Windows, Target::AppImage, Target::Deb, Target::Android, Target::MacOs];

    #[test]
    fn a_manual_install_runs_at_once_everywhere() {
        for t in ALL {
            for front in [true, false] {
                assert_eq!(decide(Origin::Manual, t, front), Apply::Now, "{t:?} front={front}");
            }
        }
    }

    #[test]
    fn an_automatic_install_waits_while_the_user_is_in_front() {
        for t in [Target::Windows, Target::AppImage] {
            assert_eq!(decide(Origin::Automatic, t, true), Apply::Wait, "{t:?}");
            assert_eq!(decide(Origin::Automatic, t, false), Apply::Now, "{t:?}");
        }
    }

    #[test]
    fn the_deb_password_prompt_never_appears_unattended() {
        for front in [true, false] {
            assert_eq!(decide(Origin::Automatic, Target::Deb, front), Apply::Wait, "front={front}");
        }
        assert!(needs_password(Target::Deb));
        for t in [Target::Windows, Target::AppImage, Target::Android, Target::MacOs] {
            assert!(!needs_password(t), "{t:?}");
        }
    }

    #[test]
    fn only_a_shown_focused_window_counts_as_in_front() {
        assert!(in_front(true, false, true));
        assert!(!in_front(false, false, true), "hidden to the tray");
        assert!(!in_front(true, true, true), "minimized");
        assert!(!in_front(true, false, false), "another window has the focus");
    }

    #[test]
    fn only_the_appimage_installs_at_quit() {
        for t in ALL {
            assert_eq!(applies_on_quit(t), t == Target::AppImage, "{t:?}");
        }
    }

    #[test]
    fn quick_capture_counts_while_it_is_being_used() {
        // (visible, focused, typing, unsaved)
        assert!(capture_in_front(true, true, false, false), "focused, empty");
        assert!(capture_in_front(true, false, true, false), "shown, text typed, focus elsewhere");
        assert!(!capture_in_front(true, false, false, false), "shown but empty and unfocused");
        assert!(!capture_in_front(false, false, true, false), "put away with only text: it is kept across restarts");
        assert!(capture_in_front(false, false, false, true), "put away with pasted images: they live in memory only");
        assert!(capture_in_front(true, false, false, true), "a send waiting for the main window");
    }

    /// The main window hidden or unfocused and Quick capture in use is not "away": `decide` waits.
    #[test]
    fn capture_in_use_keeps_an_automatic_install_waiting() {
        let main = in_front(false, false, false);
        for t in [Target::Windows, Target::AppImage] {
            assert_eq!(decide(Origin::Automatic, t, main || capture_in_front(true, true, false, false)), Apply::Wait, "{t:?}");
            assert_eq!(decide(Origin::Automatic, t, main || capture_in_front(true, false, false, false)), Apply::Now, "{t:?}");
        }
    }

    /// Quitting is the user's own act and installing the AppImage restarts nothing: an open
    /// capture box (with images) neither delays nor changes it. Other targets never install then.
    #[test]
    fn a_capture_box_open_at_quit_does_not_change_what_quitting_installs() {
        let capture_open = capture_in_front(true, true, true, true);
        assert!(capture_open);
        for t in ALL {
            assert_eq!(applies_on_quit(t), t == Target::AppImage, "{t:?}");
        }
    }

    const GRACE: Duration = Duration::from_millis(90);
    const STEP: Duration = Duration::from_millis(30);

    fn run<F: Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn an_uninterrupted_absence_installs() {
        let away = Away::default();
        let started = std::time::Instant::now();
        let ticket = away.left();
        assert!(run(away.stayed_away(ticket, GRACE)));
        assert!(started.elapsed() >= GRACE, "never earlier than the grace");
    }

    /// Alt-tab away, back, away again: the first timer must not install after the second, shorter
    /// absence; only the latest departure's does, a whole grace after it.
    #[test]
    fn alt_tab_away_back_away_only_counts_the_last_absence() {
        let away = Away::default();
        let first = away.left();
        let (first_ok, (second_ok, second_absent)) = run(async {
            tokio::join!(away.stayed_away(first, GRACE), async {
                tokio::time::sleep(STEP).await;
                away.returned();
                tokio::time::sleep(STEP).await;
                let second = away.left();
                let at = std::time::Instant::now();
                let ok = away.stayed_away(second, GRACE).await;
                (ok, at.elapsed())
            })
        });
        assert!(!first_ok, "the absence it timed was interrupted by the return");
        assert!(second_ok, "the last absence went on for the whole grace");
        assert!(second_absent >= GRACE);
    }

    /// The main window loses the focus and Quick capture takes it: the departure's timer is void
    /// even though the main window stays hidden; once capture goes away a new full grace is needed.
    #[test]
    fn capture_focus_while_the_main_window_is_hidden_voids_the_pending_install() {
        let away = Away::default();
        let main_left = away.left();
        let (first_ok, (second_ok, absent)) = run(async {
            tokio::join!(away.stayed_away(main_left, GRACE), async {
                tokio::time::sleep(STEP).await;
                away.returned(); // capture shown and focused
                tokio::time::sleep(STEP).await;
                let capture_left = away.left(); // capture lost the focus / was hidden
                let at = std::time::Instant::now();
                let ok = away.stayed_away(capture_left, GRACE).await;
                (ok, at.elapsed())
            })
        });
        assert!(!first_ok);
        assert!(second_ok);
        assert!(absent >= GRACE);
    }

    /// A departure reported while the user was still in front of another window (capture hidden
    /// with the main window focused) must not make a later alt-tab install early.
    #[test]
    fn an_earlier_departure_never_shortens_a_later_one() {
        let away = Away::default();
        let capture_hidden_while_main_in_front = away.left();
        let (early_ok, (late_ok, absent)) = run(async {
            tokio::join!(away.stayed_away(capture_hidden_while_main_in_front, GRACE), async {
                tokio::time::sleep(STEP * 2).await;
                let alt_tab = away.left();
                let at = std::time::Instant::now();
                let ok = away.stayed_away(alt_tab, GRACE).await;
                (ok, at.elapsed())
            })
        });
        assert!(!early_ok, "its timer ends while the alt-tab absence is only 2/3 old");
        assert!(late_ok);
        assert!(absent >= GRACE);
    }

    /// Typing in the capture box counts as being back: pending timers die, and the install
    /// needs a new departure.
    #[test]
    fn activity_in_capture_voids_the_pending_install() {
        let away = Away::default();
        let left = away.left();
        let ok = run(async {
            tokio::join!(away.stayed_away(left, GRACE), async {
                tokio::time::sleep(STEP).await;
                away.returned();
            })
            .0
        });
        assert!(!ok);
    }
}
