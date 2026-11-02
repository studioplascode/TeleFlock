//! On-device dictation: the speech models of this device, its choices, and live sessions
//! (docs/architecture.md §6.16). Answered by the app core (`tf-client` `dictation/` on
//! `tf-dictation`, feature `voice`: the desktop app and lab devservers); other cores (Android,
//! builds without the engine) answer `unsupported`, older ones `unknown_method`. A session's events
//! reach every UI subscriber as `AppEvent::DictationSession`, named by the id the page chose in
//! `dictation.start`.

wire_enum! {
    /// Where a catalog model stands on this device.
    pub enum DictationModelPhase {
        /// In the catalog, not on this device.
        Available,
        /// Downloading (`DictationModel.downloaded` of `size` bytes).
        Downloading,
        /// Downloaded and verified (sha256 of every file).
        Installed,
    }
}

wire_struct! {
    pub struct DictationModel {
        pub id: String,
        pub name: String,
        /// What it is good at, one sentence.
        pub summary: String,
        /// The languages it knows, for people ("English, German, French, Spanish").
        pub languages: String,
        /// ISO 639-1 codes it can be told to expect. A model with `auto_language` hears these
        /// without being told.
        pub language_codes: Vec<String>,
        /// Detects the spoken language itself. Otherwise it needs a language from
        /// `DictationState.language` (`auto` falls back to its first language).
        pub auto_language: bool,
        /// Listens for the language chosen in `DictationState.language` (Whisper keeps to it,
        /// Canary needs one); the others ignore the choice.
        pub takes_language: bool,
        /// Download size in bytes.
        pub size: u64,
        /// Memory it needs while loaded, roughly, in MB.
        pub ram_mb: u32,
        /// Speed and accuracy, 1 (lowest) to 5, from the measurements in docs/architecture.md.
        pub speed: u8,
        pub accuracy: u8,
        /// Measured speed and accuracy in words ("about 0.2 s per sentence on a desktop CPU").
        pub notes: String,
        /// Recommended for this kind of device (`DictationState.device`).
        pub recommended: bool,
        pub phase: DictationModelPhase,
        /// Bytes on disk: of a download in progress (`downloading`), or of an interrupted one
        /// that resumes from there (`available`).
        pub downloaded: Option<u64>,
        /// Why the last download failed (shown until the next attempt).
        pub error: Option<String>,
    }
}

wire_struct! {
    pub struct DictationLanguage {
        /// `auto` or an ISO 639-1 code.
        pub code: String,
        pub name: String,
    }
}

wire_struct! {
    pub struct DictationState {
        /// This build runs speech models on the device (its speech engine is built in).
        pub supported: bool,
        /// `desktop` | `phone`: what `DictationModel.recommended` is for.
        pub device: String,
        pub models: Vec<DictationModel>,
        /// The installed model dictation uses. Absent: none chosen (the app's microphone then
        /// uses the system's speech recognition, where there is one).
        pub selected: Option<String>,
        /// The language to expect: `auto` or an ISO 639-1 code.
        pub language: String,
        /// The languages Settings offers (`auto` first).
        pub languages: Vec<DictationLanguage>,
        /// Engine and version (`sherpa-onnx 2.0.1`).
        pub engine: String,
        /// The microphone the user chose (`dictation.setMicrophone`; `default` is false here).
        /// Absent: the system's default input.
        pub microphone: Option<DictationMicrophone>,
    }
}

wire_struct! {
    pub struct DictationModelRef {
        pub model_id: String,
    }
}

wire_struct! {
    pub struct DictationSelectParams {
        /// Absent: none: the app's microphone uses the system's speech recognition.
        pub model_id: Option<String>,
    }
}

wire_struct! {
    pub struct DictationLanguageParams {
        /// `auto` or an ISO 639-1 code from `DictationState.languages`.
        pub language: String,
    }
}

wire_struct! {
    /// An input device of this device (`dictation.microphones`).
    pub struct DictationMicrophone {
        /// Stable where the system allows (`alsa:sysdefault:CARD=PCH`).
        pub id: String,
        pub name: String,
        /// The system's default input now.
        pub default: bool,
    }
}

wire_struct! {
    pub struct DictationMicrophones {
        /// The system's default first.
        pub microphones: Vec<DictationMicrophone>,
    }
}

wire_struct! {
    pub struct DictationMicrophoneParams {
        /// A `DictationMicrophone.id`; absent: the system's default input.
        pub id: Option<String>,
    }
}

wire_struct! {
    pub struct DictationStartParams {
        /// Names the session in its events; chosen by the page (random), so it can listen before
        /// the call returns. A session with this id still running → `invalid_params`.
        pub session: String,
        /// The device locale (`de-DE`): the language for a model that needs one while the choice
        /// is `auto`.
        pub locale: Option<String>,
    }
}

wire_struct! {
    pub struct DictationSessionRef {
        pub session: String,
    }
}

/// One event of a live dictation session (`AppEvent::DictationSession`): `listening` first, then
/// `partial` / `final` / `error` as they come, and always `end` last (after `dictation.stop`,
/// `dictation.cancel`, an error, a minute without speech, the microphone going away, another
/// session starting, or the page that started it closing).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum DictationEvent {
    /// The microphone is open: speech from now on is heard (the model may still be loading).
    Listening,
    /// What is being said so far in the utterance in progress; each replaces the previous one.
    Partial { text: String },
    /// A finished utterance, in order.
    Final { text: String },
    /// Why the session ends early (`no_device`, `permission`, `model`, …); `end` follows.
    Error { code: String, message: String },
    End,
}
