//! Windows toast notifications (WinRT, `windows` 0.62 — the same major tauri uses).
//!
//! * Body click: protocol activation of `teleflock://agent/<host>/<agent>?n=<id>`. Works from
//!   Action Center even after TeleFlock exited (the NSIS installer registers the scheme, and the
//!   single-instance plugin forwards the URL to a running instance).
//! * Buttons and the inline reply: foreground activation handled in-process through
//!   `ToastNotification.Activated` → `Engine::notification_action`. TeleFlock keeps running in the
//!   tray while its window is closed, and clears its toasts on quit, so no stale buttons remain.
//! * Handled elsewhere (request answered in the app, on another device, in omp; read in the
//!   app): the engine retracts the toast, which removes it from Action Center by tag + group.
//! * Closed by the user (`Dismissed` with `UserCanceled`) → `Engine::notification_dismissed`, so
//!   the app shows it read.
//!
//! The AUMID (`identifier` from tauri.conf.json) is registered under
//! `HKCU\Software\Classes\AppUserModelId\<aumid>` (display name + icon) so toasts work for both
//! installed and portable/dev builds.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::{IPropertyValue, TypedEventHandler},
    UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissalReason, ToastDismissedEventArgs, ToastNotification, ToastNotificationManager,
    },
    Win32::System::Com::CoIncrementMTAUsage,
    Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID,
    core::{HSTRING, IInspectable, Interface, Ref},
};

use crate::present::Presentation;
use crate::toastxml::{ARG_ACTION, ARG_REPLY, INPUT_ID, short_tag, toast_xml};

const GROUP: &str = "agents";

/// What the user did with a toast.
pub enum ToastEvent {
    /// A button (`action_id`) or the inline reply (`reply`).
    Activated { host_id: String, notification_id: String, action_id: Option<String>, reply: Option<String> },
    /// Closed by the user.
    Dismissed { host_id: String, notification_id: String },
}

pub type Sink = Arc<dyn Fn(ToastEvent) + Send + Sync>;

/// Live toasts by (short) tag: the notification id shown under that tag, and the COM object
/// (kept alive for its event handlers).
type Live = Mutex<HashMap<String, (String, ToastNotification)>>;

pub struct Toasts {
    aumid: HSTRING,
    sink: Sink,
    live: Arc<Live>,
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
        Self { aumid: HSTRING::from(aumid), sink, live: Arc::default() }
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
            let activated = |action_id, reply| ToastEvent::Activated {
                host_id: host.clone(),
                notification_id: nid.clone(),
                action_id,
                reply,
            };
            if let Some(action) = arguments.strip_prefix(ARG_ACTION) {
                sink(activated(Some(action.to_owned()), None));
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
                    sink(activated(None, Some(text)));
                }
            }
            // Protocol (body) activations arrive through the deep-link path instead.
            Ok(())
        }))?;
        let (sink, host, nid, live) =
            (Arc::clone(&self.sink), p.host_id.clone(), p.notification_id.clone(), Arc::downgrade(&self.live));
        let dismissed_tag = tag.clone();
        toast.Dismissed(&TypedEventHandler::new(move |_s: Ref<ToastNotification>, args: Ref<ToastDismissedEventArgs>| {
            // TimedOut: moved to Action Center. ApplicationHidden: our own retract / clear.
            if args.as_ref().and_then(|a| a.Reason().ok()) == Some(ToastDismissalReason::UserCanceled) {
                forget(&live, &dismissed_tag, &nid);
                sink(ToastEvent::Dismissed { host_id: host.clone(), notification_id: nid.clone() });
            }
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&self.aumid)?.Show(&toast)?;
        self.live.lock().unwrap_or_else(|e| e.into_inner()).insert(tag, (p.notification_id.clone(), toast));
        Ok(())
    }

    /// Removes the toast of notification `notification_id` (posted under `tag`) from the screen
    /// and Action Center; no-op when a newer toast replaced it under the same tag.
    pub fn retract(&self, tag: &str, notification_id: &str) {
        let tag = short_tag(tag);
        if !forget(&Arc::downgrade(&self.live), &tag, notification_id) {
            return;
        }
        let removed = ToastNotificationManager::History()
            .and_then(|h| h.RemoveGroupedTagWithId(&HSTRING::from(&tag), &HSTRING::from(GROUP), &self.aumid));
        if let Err(e) = removed {
            log::warn!("retracting toast {tag} failed: {e}");
        }
    }

    /// Removes every TeleFlock toast from Action Center (on quit: their buttons need the process).
    pub fn clear_all(&self) {
        self.live.lock().unwrap_or_else(|e| e.into_inner()).clear();
        if let Err(e) = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&self.aumid)) {
            log::warn!("clearing toasts failed: {e}");
        }
    }
}

/// Drops `tag` from the live toasts if it still shows `notification_id`.
fn forget(live: &Weak<Live>, tag: &str, notification_id: &str) -> bool {
    let Some(live) = live.upgrade() else { return false };
    let mut live = live.lock().unwrap_or_else(|e| e.into_inner());
    if live.get(tag).is_some_and(|(id, _)| id == notification_id) {
        live.remove(tag);
        true
    } else {
        false
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
