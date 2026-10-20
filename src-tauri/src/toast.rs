//! Windows toast notifications (WinRT, `windows` 0.62 — the same major tauri uses).
//!
//! * Body click: protocol activation of `teleflock://agent/<host>/<agent>?n=<id>`. Works from
//!   Action Center even after TeleFlock exited (the NSIS installer registers the scheme, and the
//!   single-instance plugin forwards the URL to a running instance).
//! * Buttons and the inline reply: foreground activation handled in-process through
//!   `ToastNotification.Activated` → `Engine::notification_action`. TeleFlock keeps running in the
//!   tray while its window is closed, and clears its toasts on quit, so no stale buttons remain.
//!
//! The AUMID (`identifier` from tauri.conf.json) is registered under
//! `HKCU\Software\Classes\AppUserModelId\<aumid>` (display name + icon) so toasts work for both
//! installed and portable/dev builds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::{IPropertyValue, TypedEventHandler},
    UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager},
    Win32::System::Com::CoIncrementMTAUsage,
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    core::{HSTRING, IInspectable, Interface, Ref},
};

use crate::present::Presentation;
use crate::toastxml::{ARG_ACTION, ARG_REPLY, INPUT_ID, short_tag, toast_xml};

const GROUP: &str = "agents";

/// Activation callback: (host_id, notification_id, action_id, reply).
pub type Sink = Arc<dyn Fn(String, String, Option<String>, Option<String>) + Send + Sync>;

pub struct Toasts {
    aumid: HSTRING,
    sink: Sink,
    /// Live toasts by tag: keeps the COM objects (and their Activated handlers) alive.
    live: Mutex<HashMap<String, ToastNotification>>,
}

impl Toasts {
    /// Registers the AUMID for this process and in HKCU, and makes WinRT callable from any thread.
    pub fn new(aumid: &str, display_name: &str, icon_png: Option<&std::path::Path>, sink: Sink) -> Self {
        unsafe {
            // Implicit MTA for every thread that never initialised COM (tokio workers).
            if let Err(e) = CoIncrementMTAUsage() {
                log::warn!("CoIncrementMTAUsage failed: {e}");
            }
            if let Err(e) = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(aumid)) {
                log::warn!("SetCurrentProcessExplicitAppUserModelID failed: {e}");
            }
        }
        if let Err(e) = register_aumid(aumid, display_name, icon_png) {
            log::warn!("registering AUMID {aumid} failed: {e}");
        }
        Self { aumid: HSTRING::from(aumid), sink, live: Mutex::new(HashMap::new()) }
    }

    pub fn show(&self, p: &Presentation) {
        if let Err(e) = self.try_show(p) {
            log::warn!("toast failed: {e}");
        }
    }

    fn try_show(&self, p: &Presentation) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(p)))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        let tag = short_tag(&p.tag);
        toast.SetTag(&HSTRING::from(&tag))?;
        toast.SetGroup(&HSTRING::from(GROUP))?;
        if p.silent {
            toast.SetSuppressPopup(true)?;
        }
        let (sink, host, nid) = (Arc::clone(&self.sink), p.host_id.clone(), p.notification_id.clone());
        toast.Activated(&TypedEventHandler::new(move |_s: Ref<ToastNotification>, args: Ref<IInspectable>| {
            let Some(args) = args.as_ref() else { return Ok(()) };
            let a: ToastActivatedEventArgs = args.cast()?;
            let arguments = a.Arguments()?.to_string();
            if let Some(action) = arguments.strip_prefix(ARG_ACTION) {
                sink(host.clone(), nid.clone(), Some(action.to_owned()), None);
            } else if arguments == ARG_REPLY {
                let text = a
                    .UserInput()
                    .ok()
                    .and_then(|vs| vs.Lookup(&HSTRING::from(INPUT_ID)).ok())
                    .and_then(|v| v.cast::<IPropertyValue>().ok())
                    .and_then(|pv| pv.GetString().ok())
                    .map(|s| s.to_string().trim().to_owned())
                    .filter(|s| !s.is_empty());
                if let Some(text) = text {
                    sink(host.clone(), nid.clone(), None, Some(text));
                }
            }
            // Protocol (body) activations arrive through the deep-link path instead.
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&self.aumid)?.Show(&toast)?;
        self.live.lock().unwrap_or_else(|e| e.into_inner()).insert(tag, toast);
        Ok(())
    }

    /// Removes every TeleFlock toast from Action Center (on quit: their buttons need the process).
    pub fn clear_all(&self) {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).clear();
        if let Err(e) = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&self.aumid)) {
            log::warn!("clearing toasts failed: {e}");
        }
    }
}

fn register_aumid(aumid: &str, display_name: &str, icon_png: Option<&std::path::Path>) -> windows_registry::Result<()> {
    let key = windows_registry::CURRENT_USER.create(format!(r"Software\Classes\AppUserModelId\{aumid}"))?;
    key.set_string("DisplayName", display_name)?;
    if let Some(icon) = icon_png {
        key.set_string("IconUri", icon.to_string_lossy().as_ref())?;
    }
    key.set_string("IconBackgroundColor", "FF0B0B10")?;
    Ok(())
}
