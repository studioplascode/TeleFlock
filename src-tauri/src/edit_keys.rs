//! Linux: the editing keys WebKitGTK leaves undone because GTK 3 finds no key binding for them.
//!
//! WebKitGTK turns Ctrl+V, Shift+Insert, Backspace and the like into editing commands through
//! GTK's key bindings, which look a key up by its keycode in the keyboard's keymap. GTK 3's Wayland
//! backend never lists a keymap's highest keycode (`gdk_wayland_keymap_get_entries_for_keyval`
//! stops one short), and the virtual keyboard a dictation tool types with on a wlroots desktop
//! (wtype, the virtual-keyboard protocol) uploads a keymap of just the keys it sends, the last one
//! on that highest keycode. So the lone Ctrl+V or Shift+Insert such a tool sends after copying its
//! text binds to nothing, and so does a lone Backspace correcting a word: the field never changes.
//! Typed characters need no binding and arrive.
//!
//! WebKit hands a key event that nothing handled (no command ran, the page didn't prevent it) back
//! to GTK, where it reaches the view's after-handlers. There these keys run their command directly.
//! A key the page handled, or whose binding ran, never comes back, so nothing runs twice.

use gtk::gdk::{self, keys::constants as key, keys::Key, ModifierType};
use gtk::glib::prelude::*;
use tauri::{Runtime, WebviewWindow};
use webkit2gtk::WebViewExt;

/// The WebKit editing command for a key WebKit left unhandled, when it is one a dictation tool
/// sends: its paste chords (as GTK binds them: Ctrl+V, Ctrl+Shift+V, Shift+Insert) and the keys it
/// deletes with. Lock modifiers (Caps Lock, Num Lock) don't count.
pub fn command(keyval: Key, state: ModifierType) -> Option<&'static str> {
    let held = state
        & (ModifierType::SHIFT_MASK
            | ModifierType::CONTROL_MASK
            | ModifierType::MOD1_MASK
            | ModifierType::SUPER_MASK
            | ModifierType::HYPER_MASK
            | ModifierType::META_MASK);
    let ctrl = ModifierType::CONTROL_MASK;
    let shift = ModifierType::SHIFT_MASK;
    match keyval {
        key::v | key::V if held == ctrl || held == ctrl | shift => Some("Paste"),
        key::Insert | key::KP_Insert if held == shift => Some("Paste"),
        key::BackSpace if held.is_empty() => Some("DeleteBackward"),
        key::Delete | key::KP_Delete if held.is_empty() => Some("DeleteForward"),
        _ => None,
    }
}

/// Runs [`command`] for the keys `window`'s webview hands back unhandled (see the module docs).
pub fn install<R: Runtime>(window: &WebviewWindow<R>) {
    let label = window.label().to_owned();
    let installed = window.with_webview(|webview| {
        webview.inner().connect_local("key-press-event", true, |args| {
            let ran = (|| {
                let view = args.first()?.get::<webkit2gtk::WebView>().ok()?;
                let event = args.get(1)?.get::<gdk::Event>().ok()?;
                let key = event.downcast_ref::<gdk::EventKey>()?;
                let command = command(key.keyval(), key.state())?;
                view.execute_editing_command(command);
                Some(())
            })();
            Some(ran.is_some().to_value())
        });
    });
    if let Err(e) = installed {
        log::warn!("editing keys: no webview for window '{label}': {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: ModifierType = ModifierType::empty();
    const CTRL: ModifierType = ModifierType::CONTROL_MASK;
    const SHIFT: ModifierType = ModifierType::SHIFT_MASK;

    #[test]
    fn paste_chords_paste() {
        assert_eq!(command(key::v, CTRL), Some("Paste"));
        assert_eq!(command(key::V, CTRL | SHIFT), Some("Paste"));
        assert_eq!(command(key::Insert, SHIFT), Some("Paste"));
        assert_eq!(command(key::KP_Insert, SHIFT), Some("Paste"));
        // Caps Lock / Num Lock on: still the same chord.
        assert_eq!(command(key::v, CTRL | ModifierType::LOCK_MASK | ModifierType::MOD2_MASK), Some("Paste"));
    }

    #[test]
    fn deleting_keys_delete() {
        assert_eq!(command(key::BackSpace, NONE), Some("DeleteBackward"));
        assert_eq!(command(key::Delete, NONE), Some("DeleteForward"));
        assert_eq!(command(key::KP_Delete, ModifierType::MOD2_MASK), Some("DeleteForward"));
    }

    #[test]
    fn other_keys_and_chords_are_left_alone() {
        assert_eq!(command(key::v, NONE), None);
        assert_eq!(command(key::v, CTRL | ModifierType::MOD1_MASK), None);
        assert_eq!(command(key::v, CTRL | ModifierType::SUPER_MASK), None);
        // Ctrl+Insert copies, Shift+Delete cuts: not what a dictation tool sends.
        assert_eq!(command(key::Insert, CTRL), None);
        assert_eq!(command(key::Delete, SHIFT), None);
        assert_eq!(command(key::BackSpace, CTRL), None);
        assert_eq!(command(key::Return, NONE), None);
    }
}
