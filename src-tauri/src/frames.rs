//! What the app's webviews withhold from the frames presented documents run in (docs.rs; the app's
//! `src/features/session/artifacts/sandbox.ts`), beyond their Content-Security-Policy, which
//! covers neither WebRTC nor resource hints:
//!
//! - **WebRTC, every desktop.** [`plugin`] runs [`INIT_SCRIPT`] in every frame of every webview,
//!   before the frame's own scripts (wry: WebView2's document-created scripts, WebKit's user
//!   scripts in all frames). In a frame of an opaque origin, which every frame of a presented page
//!   is (sandboxed without `allow-same-origin`, as is every frame those create), it removes
//!   `RTCPeerConnection` and its kin. The page's own prelude does that for the page; this reaches
//!   the frames a page makes itself (an `srcdoc` frame runs its own scripts in a fresh window). The
//!   app's own frames (its page, preview tunnels) have real origins and keep WebRTC.
//! - **Linux (WebKitGTK).** [`harden`]: WebRTC off (WebKitGTK's default; set so that no wry change
//!   turns it on) and the `LinkPreconnect` feature off: WebKit opens a preconnect's connection
//!   whatever the page's CSP says. Explicit DNS prefetching is off by default there.

/// Removes WebRTC from a frame of an opaque origin before its own scripts run.
pub const INIT_SCRIPT: &str = r#"if (self.origin === "null") for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) { try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch (e) {} }"#;

/// The plugin that puts [`INIT_SCRIPT`] into every frame of every webview.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("tf-frames").js_init_script_on_all_frames(INIT_SCRIPT).build()
}

/// Linux: turns WebRTC and `<link rel=preconnect>` off in `window`'s webview (see the module docs).
#[cfg(target_os = "linux")]
pub fn harden<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let label = window.label().to_owned();
    let done = window.with_webview(|webview| {
        use webkit2gtk::{SettingsExt as _, WebViewExt as _};
        let Some(settings) = webview.inner().settings() else { return };
        settings.set_enable_webrtc(false);
        if !webkit::set_feature(&settings, "LinkPreconnect", false) {
            log::warn!("this WebKitGTK (before 2.42) has no LinkPreconnect switch: presented pages can preconnect");
        }
    });
    if let Err(e) = done {
        log::warn!("frames: no webview for window '{label}': {e}");
    }
}

/// WebKitGTK's feature switches (`webkit_settings_set_feature_enabled`, 2.42+), looked up when
/// called: webkit2gtk-rs binds up to 2.40, and an older WebKitGTK must still start the app.
#[cfg(target_os = "linux")]
mod webkit {
    use std::ffi::{CStr, c_char, c_int, c_void};

    use gtk::glib::object::ObjectType as _;

    /// A function of the loaded WebKitGTK, by name.
    fn symbol<T: Copy>(name: &CStr) -> Option<T> {
        // SAFETY: dlsym only looks the name up in what is loaded; every caller asks for a function
        // whose C signature `T` matches, and a function pointer is pointer-sized.
        unsafe {
            let p = libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr());
            (!p.is_null()).then(|| std::mem::transmute_copy::<*mut c_void, T>(&p))
        }
    }

    /// Runs `f` on the feature named `identifier`; None when WebKitGTK has no such feature (or no
    /// feature switches).
    fn with_feature<T>(identifier: &str, f: impl FnOnce(*mut c_void) -> T) -> Option<T> {
        type All = unsafe extern "C" fn() -> *mut c_void;
        type Length = unsafe extern "C" fn(*mut c_void) -> usize;
        type Get = unsafe extern "C" fn(*mut c_void, usize) -> *mut c_void;
        type Identifier = unsafe extern "C" fn(*mut c_void) -> *const c_char;
        type Unref = unsafe extern "C" fn(*mut c_void);
        let all = symbol::<All>(c"webkit_settings_get_all_features")?;
        let length = symbol::<Length>(c"webkit_feature_list_get_length")?;
        let get = symbol::<Get>(c"webkit_feature_list_get")?;
        let id_of = symbol::<Identifier>(c"webkit_feature_get_identifier")?;
        let unref = symbol::<Unref>(c"webkit_feature_list_unref")?;
        // SAFETY: the list is WebKitGTK's own (transfer full, released with its unref); a feature
        // (transfer none) and its identifier live as long as the list.
        unsafe {
            let list = all();
            if list.is_null() {
                return None;
            }
            let feature = (0..length(list)).map(|i| get(list, i)).find(|&feature| {
                let id = id_of(feature);
                !id.is_null() && CStr::from_ptr(id).to_bytes() == identifier.as_bytes()
            });
            let out = feature.map(f);
            unref(list);
            out
        }
    }

    /// Switches the feature named `identifier` on or off in `settings`; false when there is none.
    pub fn set_feature(settings: &webkit2gtk::Settings, identifier: &str, enabled: bool) -> bool {
        type Set = unsafe extern "C" fn(*mut c_void, *mut c_void, c_int);
        let Some(set) = symbol::<Set>(c"webkit_settings_set_feature_enabled") else { return false };
        // SAFETY: `settings` is a live WebKitSettings, the feature one of WebKitGTK's own.
        with_feature(identifier, |feature| unsafe { set(settings.as_ptr().cast(), feature, c_int::from(enabled)) }).is_some()
    }

    #[cfg(test)]
    pub fn feature_enabled(settings: &webkit2gtk::Settings, identifier: &str) -> Option<bool> {
        type Get = unsafe extern "C" fn(*mut c_void, *mut c_void) -> c_int;
        let get = symbol::<Get>(c"webkit_settings_get_feature_enabled")?;
        // SAFETY: as in `set_feature`.
        with_feature(identifier, |feature| unsafe { get(settings.as_ptr().cast(), feature) != 0 })
    }

    #[cfg(test)]
    pub fn has_feature(identifier: &str) -> bool {
        with_feature(identifier, |_| ()).is_some()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use webkit2gtk::SettingsExt as _;

    use super::webkit;

    /// Needs the WebKitGTK the app runs with (2.42 or newer has feature switches); the switching
    /// part needs a display too (a WebKitSettings reads GTK's), so it runs under X or Wayland only.
    #[test]
    fn webkitgtk_turns_preconnect_off() {
        assert!(webkit::has_feature("LinkPreconnect"));
        assert!(!webkit::has_feature("NoSuchFeature"));
        if gtk::init().is_err() {
            eprintln!("no display: switching LinkPreconnect off not checked");
            return;
        }
        let settings = webkit2gtk::Settings::new();
        assert_eq!(webkit::feature_enabled(&settings, "LinkPreconnect"), Some(true), "WebKitGTK preconnects by default");
        assert!(webkit::set_feature(&settings, "LinkPreconnect", false));
        assert_eq!(webkit::feature_enabled(&settings, "LinkPreconnect"), Some(false));
        assert!(!webkit::set_feature(&settings, "NoSuchFeature", false));
        assert!(!settings.enables_webrtc(), "WebKitGTK's WebRTC is off by default");
    }
}
