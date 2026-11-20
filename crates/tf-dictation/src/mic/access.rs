//! Whether the system lets this app use the microphone, and telling a refusal apart from a missing
//! or failing device.
//!
//! - **Windows** decides per user in Settings → Privacy & security → Microphone: the device's
//!   switch, "Let desktop apps access your microphone", and on builds with permissions per desktop
//!   app (Insider builds since 26220.9836) a switch per app, set by the prompt Windows shows the
//!   first time an app opens the microphone. A refusal reaches the capture as `E_ACCESSDENIED` from
//!   `IAudioClient::Initialize`; [`access`] reads the setting without prompting through
//!   `AppCapability::CheckAccess("microphone")`.
//! - **macOS** keeps the answer to its prompt in TCC (System Settings → Privacy & Security →
//!   Microphone). A denied app's capture opens fine and hears silence, so [`ask`] reads
//!   `AVCaptureDevice`'s authorization before the device opens: denied is refused there, and an app
//!   macOS hasn't asked yet gets the prompt, and its answer, first.
//! - **Linux** keeps no such setting: a refusal is a device's (ALSA `EACCES`, PulseAudio's access
//!   denied), reported with the device's message.

use std::time::Duration;

use crate::VoiceError;

/// What the system says about this app's use of the microphone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Granted,
    /// Not decided yet: the system asks when the microphone opens.
    Prompt,
    /// Refused for this app, by the user at the system's prompt or in its privacy settings, or by
    /// a policy: only the system's settings give it back.
    Denied,
    /// The system keeps no such setting (Linux), or it couldn't be read.
    Unknown,
}

/// The system's answer for this process now, read without prompting (cheap: a system call, no
/// device opened).
pub fn access() -> Access {
    #[cfg(windows)]
    return win::access();
    #[cfg(target_os = "macos")]
    return av::status().map_or(Access::Unknown, macos_access);
    #[cfg(not(any(windows, target_os = "macos")))]
    Access::Unknown
}

/// How long the device may take to open (a driver waking up).
const OPEN_WAIT: Duration = Duration::from_secs(10);
/// How long a capture waits for the answer to the system's prompt. Unanswered by then, the start
/// fails; the prompt stays, and its answer counts from the next start.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
const PROMPT_WAIT: Duration = Duration::from_secs(60);

/// Before the device opens: refuses a capture the system won't feed, and has the system ask first
/// where it hasn't yet (macOS: a denied app would hear silence, and the prompt would come while the
/// capture already ran). Returns how long the device may then take to open: where Windows has
/// permissions per desktop app it asks inside the first capture, which may hold the capture until
/// the answer. Other refusals come from the device ([`refused`]).
pub(super) fn ask() -> Result<Duration, VoiceError> {
    #[cfg(target_os = "macos")]
    match av::status().map(macos_access) {
        Some(Access::Denied) => return Err(VoiceError::Permission("macOS keeps the microphone from TeleFlock".into())),
        Some(Access::Prompt) => {
            return match av::request(PROMPT_WAIT) {
                Some(true) => Ok(OPEN_WAIT),
                Some(false) => Err(VoiceError::Permission("not allowed at macOS's prompt".into())),
                None => Err(VoiceError::Permission("macOS's microphone prompt wasn't answered".into())),
            };
        }
        _ => {}
    }
    #[cfg(windows)]
    if win::access() == Access::Prompt {
        return Ok(PROMPT_WAIT);
    }
    Ok(OPEN_WAIT)
}

/// `E_ACCESSDENIED` (0x80070005) as cpal 0.18 writes a WASAPI failure: the HRESULT as an
/// `io::Error`, "Access is denied. (os error -2147024891)", the words before it in the system's
/// language. The hex form covers a message that carries the HRESULT itself.
const E_ACCESSDENIED: [&str; 2] = ["os error -2147024891", "0x80070005"];

/// Whether a capture error means the system refused this app the microphone rather than that
/// there is none: cpal's `PermissionDenied` (CoreAudio's unauthorized, ALSA's EACCES/EPERM,
/// PulseAudio's access denied) and WASAPI's `E_ACCESSDENIED`, which cpal 0.18 reports as an
/// unclassified backend error (Windows' privacy settings refused it).
pub(super) fn refused(kind: cpal::ErrorKind, message: &str) -> bool {
    kind == cpal::ErrorKind::PermissionDenied || E_ACCESSDENIED.iter().any(|code| message.contains(code))
}

/// Windows' `AppCapabilityAccessStatus`: DeniedBySystem 0 (the device's switch, a policy),
/// NotDeclaredByApp 1 (a packaged app without the capability; not this one), DeniedByUser 2,
/// UserPromptRequired 3, Allowed 4.
#[cfg(any(windows, test))]
fn windows_access(status: i32) -> Access {
    match status {
        4 => Access::Granted,
        3 => Access::Prompt,
        0 | 2 => Access::Denied,
        _ => Access::Unknown,
    }
}

/// macOS' `AVAuthorizationStatus`: NotDetermined 0, Restricted 1 (Screen Time, a device profile),
/// Denied 2, Authorized 3.
#[cfg(any(target_os = "macos", test))]
fn macos_access(status: isize) -> Access {
    match status {
        3 => Access::Granted,
        0 => Access::Prompt,
        1 | 2 => Access::Denied,
        _ => Access::Unknown,
    }
}

#[cfg(windows)]
mod win {
    use windows::{Security::Authorization::AppCapabilityAccess::AppCapability, core::HSTRING};

    use super::Access;

    /// `AppCapability::CheckAccess` never prompts. Windows 10 1903 and later; an error (older
    /// Windows, no WinRT) leaves it unknown and the capture's own error decides.
    pub(super) fn access() -> Access {
        match AppCapability::Create(&HSTRING::from("microphone")).and_then(|c| c.CheckAccess()) {
            Ok(status) => super::windows_access(status.0),
            Err(e) => {
                log::debug!("tf-dictation: microphone access unknown: {e}");
                Access::Unknown
            }
        }
    }
}

/// AVFoundation's `AVCaptureDevice` (macOS 10.14 and later), through the Objective-C runtime.
#[cfg(target_os = "macos")]
mod av {
    use std::{sync::mpsc, time::Duration};

    use block2::RcBlock;
    use objc2::{
        msg_send,
        runtime::{AnyClass, Bool},
    };
    use objc2_foundation::NSString;

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        /// `AVMediaType` (an `NSString`) of audio.
        static AVMediaTypeAudio: Option<&'static NSString>;
    }

    /// The class and the media type, once AVFoundation is loaded (it is linked).
    fn audio_capture() -> Option<(&'static AnyClass, &'static NSString)> {
        // SAFETY: a constant AVFoundation defines; read only.
        let audio = unsafe { AVMediaTypeAudio }?;
        Some((AnyClass::get(c"AVCaptureDevice")?, audio))
    }

    /// `+[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]`: never prompts.
    pub(super) fn status() -> Option<isize> {
        let (class, audio) = audio_capture()?;
        // SAFETY: a class method taking an NSString and returning an NSInteger.
        Some(unsafe { msg_send![class, authorizationStatusForMediaType: audio] })
    }

    /// Shows macOS' prompt (`NSMicrophoneUsageDescription`) and waits for the answer: `None` when
    /// none came within `wait`.
    pub(super) fn request(wait: Duration) -> Option<bool> {
        let (class, audio) = audio_capture()?;
        let (tx, rx) = mpsc::sync_channel(1);
        // Called once, on a queue of the system's (perhaps after `wait`: then nobody listens).
        let answered = RcBlock::new(move |granted: Bool| {
            let _ = tx.try_send(granted.as_bool());
        });
        // SAFETY: a class method taking an NSString and a block, which it copies.
        let () = unsafe { msg_send![class, requestAccessForMediaType: audio, completionHandler: &*answered] };
        rx.recv_timeout(wait).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows' privacy settings refuse a desktop app with `E_ACCESSDENIED` from
    /// `IAudioClient::Initialize`; cpal 0.18 keeps only the text of that HRESULT. A refusal must not
    /// read as "No microphone", whatever language Windows words it in.
    #[test]
    fn a_refusal_is_told_apart_from_a_missing_device() {
        let wasapi = [
            "Failed to initialize audio client: Access is denied. (os error -2147024891)",
            "Failed to initialize audio client: Zugriff verweigert (os error -2147024891)",
            "Failed to build audio client: Access is denied. (0x80070005)",
        ];
        for message in wasapi {
            assert!(refused(cpal::ErrorKind::BackendError, message), "{message}");
        }
        // CoreAudio unauthorized, ALSA EACCES, PulseAudio access denied: cpal classifies these.
        assert!(refused(cpal::ErrorKind::PermissionDenied, "Permission denied. Grant the required access and retry."));

        let not_refusals = [
            (cpal::ErrorKind::DeviceNotAvailable, "Default device not found"),
            (cpal::ErrorKind::DeviceBusy, "Failed to initialize audio client: (os error -2004287478)"),
            (cpal::ErrorKind::BackendError, "Failed to initialize audio client: The device is in use (os error -2147024890)"),
            (cpal::ErrorKind::HostUnavailable, "The audio service is not running (os error -2004287469)"),
        ];
        for (kind, message) in not_refusals {
            assert!(!refused(kind, message), "{kind:?}: {message}");
        }
    }

    #[test]
    fn windows_privacy_states_map_to_access() {
        // DeniedBySystem, NotDeclaredByApp, DeniedByUser, UserPromptRequired, Allowed.
        let got: Vec<Access> = (0..=4).map(windows_access).collect();
        assert_eq!(got, [Access::Denied, Access::Unknown, Access::Denied, Access::Prompt, Access::Granted]);
        assert_eq!(windows_access(5), Access::Unknown);
    }

    #[test]
    fn macos_authorization_maps_to_access() {
        // NotDetermined, Restricted, Denied, Authorized.
        let got: Vec<Access> = (0..=3).map(macos_access).collect();
        assert_eq!(got, [Access::Prompt, Access::Denied, Access::Denied, Access::Granted]);
        assert_eq!(macos_access(-1), Access::Unknown);
    }
}
