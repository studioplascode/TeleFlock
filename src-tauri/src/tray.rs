//! Desktop tray icon + taskbar indicators.
//!
//! * Tray icon: app icon with a comet while agents run (orbiting in Lively motion; still in Calm
//!   and Reduced, and always on Linux) and a pink count badge when agents need you. Tooltip
//!   "3 running · 2 need you". Menu: Answer next (n), Open, Quit.
//! * Windows taskbar: overlay badge (count / running dot), progress bar (while running: the
//!   indeterminate marquee in Lively, a still full bar otherwise; paused-yellow while something
//!   needs you) and a flash when a new agent needs you while the window is in the background.
//! * Closing the window hides it to the tray; Quit exits.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use tauri::{
    AppHandle, Manager, Runtime,
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tf_client::BadgeState;
use tf_proto::AppEvent;

use crate::{badge, core::CoreState, present};

const TRAY_ID: &str = "main";
const MENU_ANSWER: &str = "answer-next";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";
const FRAME_MS: u64 = 110;

static BASE_ICON: &[u8] = include_bytes!("../icons/32x32.png");

pub struct Tray<R: Runtime> {
    app: AppHandle<R>,
    base: Vec<u8>,
    state: Mutex<BadgeState>,
    answer_item: MenuItem<R>,
    animating: AtomicBool,
    /// Settings → Motion → Lively: only then do the comet orbit and the taskbar show a marquee.
    lively: AtomicBool,
}

/// The comet orbits (one icon swap every [`FRAME_MS`]) while agents run, in Lively only, and
/// never on Linux, where every tray frame is a PNG written to disk and re-read by the panel over
/// D-Bus (StatusNotifierItem).
fn animates(s: BadgeState, lively: bool) -> bool {
    lively && s.running > 0 && !cfg!(target_os = "linux")
}

/// Windows taskbar progress: full and paused (yellow) while something needs you; while agents
/// run, the indeterminate marquee in Lively and a still full bar otherwise (the shell animates the
/// marquee for as long as it shows); none when idle.
#[cfg(any(windows, test))]
fn taskbar_progress(s: BadgeState, lively: bool) -> (tauri::window::ProgressBarStatus, Option<u64>) {
    use tauri::window::ProgressBarStatus;
    if s.needs > 0 {
        (ProgressBarStatus::Paused, Some(100))
    } else if s.running > 0 && lively {
        (ProgressBarStatus::Indeterminate, None)
    } else if s.running > 0 {
        (ProgressBarStatus::Normal, Some(100))
    } else {
        (ProgressBarStatus::None, None)
    }
}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

impl<R: Runtime> Tray<R> {
    pub fn install(app: &AppHandle<R>) -> tauri::Result<Arc<Self>> {
        let base_img = Image::from_bytes(BASE_ICON)?;
        assert_eq!((base_img.width(), base_img.height()), (badge::SIZE, badge::SIZE));
        let base = base_img.rgba().to_vec();

        let answer_item = MenuItem::with_id(app, MENU_ANSWER, "Answer next", false, None::<&str>)?;
        let open = MenuItem::with_id(app, MENU_OPEN, "Open TeleFlock", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, MENU_QUIT, "Quit TeleFlock", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&answer_item, &open, &sep, &quit])?;

        TrayIconBuilder::with_id(TRAY_ID)
            .icon(Image::new_owned(base.clone(), badge::SIZE, badge::SIZE))
            .tooltip("TeleFlock")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, e| match e.id.as_ref() {
                MENU_ANSWER => {
                    show_main(app);
                    if let Some(core) = app.try_state::<CoreState>() {
                        core.ui_intent(AppEvent::AnswerNext);
                    }
                }
                MENU_OPEN => show_main(app),
                MENU_QUIT => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, e| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                    show_main(tray.app_handle());
                }
            })
            .build(app)?;

        Ok(Arc::new(Self {
            app: app.clone(),
            base,
            state: Mutex::new(BadgeState::default()),
            answer_item,
            animating: AtomicBool::new(false),
            lively: AtomicBool::new(false),
        }))
    }

    fn current(&self) -> BadgeState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_frame(&self, s: BadgeState, frame: usize) {
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let rgba = badge::tray(&self.base, s.running > 0, s.needs, frame);
            let _ = tray.set_icon(Some(Image::new_owned(rgba, badge::SIZE, badge::SIZE)));
        }
    }

    /// Follows Settings → Motion: Lively animates the tray and the taskbar, Calm and Reduced keep
    /// them still.
    pub fn set_lively(self: &Arc<Self>, lively: bool) {
        if self.lively.swap(lively, Ordering::AcqRel) != lively {
            let s = self.current();
            self.taskbar(s, s);
            self.refresh(s);
        }
    }

    /// Applies new aggregate counts.
    pub fn update(self: &Arc<Self>, s: BadgeState) {
        let prev = std::mem::replace(&mut *self.state.lock().unwrap_or_else(|e| e.into_inner()), s);
        if prev == s {
            return;
        }
        if let Some(tray) = self.app.tray_by_id(TRAY_ID) {
            let _ = tray.set_tooltip(Some(format!("TeleFlock · {}", present::summary(s.running, s.needs))));
        }
        let _ = self.answer_item.set_enabled(s.needs > 0);
        let _ = self.answer_item.set_text(if s.needs > 0 { format!("Answer next ({})", s.needs) } else { "Answer next".to_owned() });
        self.taskbar(prev, s);
        self.refresh(s);
    }

    /// Static frame, or (re)start the orbit animation while agents run.
    fn refresh(self: &Arc<Self>, s: BadgeState) {
        if !animates(s, self.lively.load(Ordering::Acquire)) {
            self.set_frame(s, 0);
            return;
        }
        if self.animating.swap(true, Ordering::AcqRel) {
            return; // the running loop picks up the new state
        }
        let me = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(FRAME_MS));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut frame = 0usize;
            loop {
                tick.tick().await;
                let s = me.current();
                if !animates(s, me.lively.load(Ordering::Acquire)) {
                    me.animating.store(false, Ordering::Release);
                    // A concurrent update may have restarted the need for animation.
                    me.set_frame(s, 0);
                    if animates(me.current(), me.lively.load(Ordering::Acquire)) && !me.animating.swap(true, Ordering::AcqRel) {
                        continue;
                    }
                    break;
                }
                me.set_frame(s, frame);
                frame = (frame + 1) % badge::FRAMES;
            }
        });
    }

    #[cfg(windows)]
    fn taskbar(&self, prev: BadgeState, s: BadgeState) {
        use tauri::{UserAttentionType, window::ProgressBarState};
        let Some(w) = self.app.get_webview_window("main") else { return };
        let overlay = badge::overlay(s.running, s.needs).map(|rgba| Image::new_owned(rgba, badge::SIZE, badge::SIZE));
        let _ = w.set_overlay_icon(overlay);
        let (status, progress) = taskbar_progress(s, self.lively.load(Ordering::Acquire));
        let _ = w.set_progress_bar(ProgressBarState { status: Some(status), progress });
        if s.needs > prev.needs && !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(UserAttentionType::Informational));
        }
    }

    #[cfg(not(windows))]
    fn taskbar(&self, _prev: BadgeState, _s: BadgeState) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::window::ProgressBarStatus as P;

    /// Calm (the default) and Reduced keep the tray icon and the taskbar still while agents run;
    /// Lively animates both. What needs you shows the same either way.
    #[test]
    fn only_lively_animates() {
        let (idle, running, needs) =
            (BadgeState::default(), BadgeState { needs: 0, running: 2 }, BadgeState { needs: 1, running: 2 });
        assert!(!animates(running, false));
        assert_eq!(animates(running, true), !cfg!(target_os = "linux"));
        assert!(!animates(idle, true));
        assert!(matches!(taskbar_progress(running, true), (P::Indeterminate, None)));
        assert!(matches!(taskbar_progress(running, false), (P::Normal, Some(100))));
        for lively in [false, true] {
            assert!(matches!(taskbar_progress(needs, lively), (P::Paused, Some(100))));
            assert!(matches!(taskbar_progress(idle, lively), (P::None, None)));
        }
    }
}
