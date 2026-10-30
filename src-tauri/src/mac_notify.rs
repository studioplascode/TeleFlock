//! macOS notifications through `UNUserNotificationCenter` (`objc2-user-notifications`).
//!
//! * Needs a bundled app: `UNUserNotificationCenter` raises an exception for a process without a
//!   bundle identifier (`tauri dev`, a bare `target/debug` binary), so [`Notifier::new`] is `None`
//!   there and notifications stay in the app's inbox and tray badge. The first launch of a
//!   bundled app asks for the permission (alert, sound, badge); a denial turns
//!   `supports_notifications` off.
//! * One delegate for the whole process turns what the user does into [`ToastEvent`]s: the body
//!   (default action) also brings the main window forward, buttons carry their id, the text-input
//!   action carries the reply, the custom dismiss action reports a swipe-away. Every notification
//!   carries a category, so dismissals arrive without polling the delivered list.
//! * The request identifier is the per-agent short tag: re-adding it replaces the notification in
//!   place, and a retract removes it only while it still shows that notification. Notifications
//!   are grouped per host (`threadIdentifier`).
//! * Buttons live in categories, one per distinct action set (bounded, the whole set re-registered
//!   when it grows).
//! * Quit clears the delivered list: their buttons need this process, and a custom dismiss action
//!   of a dead app would launch it again.

use std::ptr::NonNull;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send, sel};
use objc2_foundation::{NSArray, NSBundle, NSError, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction, UNNotificationActionOptions,
    UNNotificationCategory, UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationDismissActionIdentifier, UNNotificationInterruptionLevel, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNTextInputNotificationAction,
    UNTextInputNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use crate::mac_model::{ACTION_PREFIX, ACTION_REPLY, Categories, CategorySpec, Live, Tags, classify};
use crate::present::{Presentation, Sink, ToastEvent};
use crate::toastxml::short_tag;

const AUTH_UNKNOWN: u8 = 0;
const AUTH_GRANTED: u8 = 1;
const AUTH_DENIED: u8 = 2;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct State {
    tags: Tags,
    categories: Categories,
}

struct Shared {
    sink: Sink,
    state: Mutex<State>,
    auth: AtomicU8,
}

impl Shared {
    fn emit(&self, event: ToastEvent) {
        // A panic must not unwind into Objective-C.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.sink)(event)));
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TeleFlockNotificationDelegate"]
    #[ivars = Arc<Shared>]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// Without this macOS drops notifications while the app is in front.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let request_id = notification.request().identifier().to_string();
            let silent = lock(&self.ivars().state).tags.get(&request_id).is_some_and(|l| l.silent);
            completion_handler.call((presentation_options(silent),));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let shared = self.ivars();
            let request_id = response.notification().request().identifier().to_string();
            let action = response.actionIdentifier().to_string();
            let text = {
                let any: &AnyObject = response.as_ref();
                any.downcast_ref::<UNTextInputNotificationResponse>().map(|r| r.userText().to_string())
            };
            // SAFETY: immutable system constants.
            let (default_id, dismiss_id) = unsafe {
                (UNNotificationDefaultActionIdentifier.to_string(), UNNotificationDismissActionIdentifier.to_string())
            };
            if let Some(r) = classify(&action, &default_id, &dismiss_id, text.as_deref()) {
                let event = lock(&shared.state).tags.respond(&request_id, r);
                if let Some(event) = event {
                    shared.emit(event);
                }
            }
            completion_handler.call(());
        }
    }
);

impl Delegate {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(shared);
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// Banner, list and sound; a quiet notification goes to the list only.
fn presentation_options(silent: bool) -> UNNotificationPresentationOptions {
    if silent {
        UNNotificationPresentationOptions::List
    } else {
        UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound
    }
}

/// Keeps the delegate alive (`UNUserNotificationCenter` holds it weakly).
struct DelegateHandle(#[allow(dead_code)] Retained<Delegate>);
// SAFETY: the handle is only dropped, never messaged; the delegate's ivars are `Send + Sync`.
unsafe impl Send for DelegateHandle {}
unsafe impl Sync for DelegateHandle {}

pub struct Notifier {
    shared: Arc<Shared>,
    _delegate: DelegateHandle,
}

impl Notifier {
    /// `None` when the process has no bundle identifier. Installs the delegate and requests the
    /// notification permission (the system prompt appears on first launch only).
    pub fn new(sink: Sink) -> Option<Self> {
        if NSBundle::mainBundle().bundleIdentifier().is_none() {
            log::info!("no bundle identifier (unbundled build): no desktop notifications");
            return None;
        }
        let shared = Arc::new(Shared { sink, state: Mutex::default(), auth: AtomicU8::new(AUTH_UNKNOWN) });
        let delegate = Delegate::new(Arc::clone(&shared));
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));

        let granted_shared = Arc::clone(&shared);
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &RcBlock::new(move |granted: Bool, err: *mut NSError| {
                let state = if granted.as_bool() { AUTH_GRANTED } else { AUTH_DENIED };
                granted_shared.auth.store(state, Ordering::Release);
                if let Some(err) = NonNull::new(err) {
                    // SAFETY: the system passes a valid NSError for the duration of the call.
                    log::warn!("notification permission request failed: {}", unsafe { err.as_ref() }.localizedDescription());
                } else if granted.as_bool() {
                    log::info!("notification permission granted");
                } else {
                    log::info!("notification permission denied: notifications stay in the app");
                }
            }),
        );
        Some(Self { shared, _delegate: DelegateHandle(delegate) })
    }

    /// Notifications can be shown (the permission was not denied).
    pub fn available(&self) -> bool {
        self.shared.auth.load(Ordering::Acquire) != AUTH_DENIED
    }

    pub fn show(&self, p: &Presentation) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let request_id = short_tag(&p.tag);
        let spec = CategorySpec::for_presentation(p);
        {
            let mut st = lock(&self.shared.state);
            if st.categories.ensure(&spec) {
                let built: Vec<_> = st.categories.specs().iter().map(build_category).collect();
                center.setNotificationCategories(&NSSet::from_retained_slice(&built));
            }
            // Recorded before the request is added so a fast response finds it.
            st.tags.record(
                &request_id,
                Live { host_id: p.host_id.clone(), notification_id: p.notification_id.clone(), silent: p.silent },
            );
        }

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&p.title));
        content.setBody(&NSString::from_str(&p.body));
        if let Some(h) = &p.host_name {
            content.setSubtitle(&NSString::from_str(h));
        }
        content.setThreadIdentifier(&NSString::from_str(&p.host_id));
        content.setCategoryIdentifier(&NSString::from_str(&spec.id));
        if p.sound && !p.silent {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        if p.silent && content.respondsToSelector(sel!(setInterruptionLevel:)) {
            // macOS 12+; the app supports 11.
            content.setInterruptionLevel(UNNotificationInterruptionLevel::Passive);
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&request_id), &content, None);
        center.addNotificationRequest_withCompletionHandler(
            &request,
            Some(&RcBlock::new(move |err: *mut NSError| {
                if let Some(err) = NonNull::new(err) {
                    // SAFETY: the system passes a valid NSError for the duration of the call.
                    log::warn!("notification request rejected: {}", unsafe { err.as_ref() }.localizedDescription());
                }
            })),
        );
    }

    /// Removes the notification of `notification_id` posted under `tag`; no-op when a newer one
    /// replaced it or it is gone.
    pub fn retract(&self, tag: &str, notification_id: &str) {
        let request_id = short_tag(tag);
        if !lock(&self.shared.state).tags.take_if_current(&request_id, notification_id) {
            return;
        }
        let ids = NSArray::from_retained_slice(&[NSString::from_str(&request_id)]);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.removeDeliveredNotificationsWithIdentifiers(&ids);
        center.removePendingNotificationRequestsWithIdentifiers(&ids);
    }

    /// Removes every TeleFlock notification from the notification center (on quit).
    pub fn clear_all(&self) {
        lock(&self.shared.state).tags.clear();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.removeAllDeliveredNotifications();
        center.removeAllPendingNotificationRequests();
    }
}

fn build_category(spec: &CategorySpec) -> Retained<UNNotificationCategory> {
    let mut actions: Vec<Retained<UNNotificationAction>> = spec
        .buttons
        .iter()
        .map(|b| {
            let options = if b.destructive { UNNotificationActionOptions::Destructive } else { UNNotificationActionOptions::empty() };
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(&format!("{ACTION_PREFIX}{}", b.id)),
                &NSString::from_str(&b.label),
                options,
            )
        })
        .collect();
    if spec.reply {
        actions.push(
            UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
                &NSString::from_str(ACTION_REPLY),
                &NSString::from_str("Reply"),
                UNNotificationActionOptions::empty(),
                &NSString::from_str("Send"),
                &NSString::from_str("Reply to the agent"),
            )
            .into_super(),
        );
    }
    UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(&spec.id),
        &NSArray::from_retained_slice(&actions),
        &NSArray::new(),
        UNNotificationCategoryOptions::CustomDismissAction,
    )
}
