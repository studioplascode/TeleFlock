use std::fmt;

/// Why dictation, a recording or a transcription can't go on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    /// No speech model is installed and chosen on this device.
    NoModel,
    /// This build has no speech engine (built without the `engine` feature).
    NoEngine,
    /// No microphone, or it went away.
    NoDevice(String),
    /// The OS or the user refused the microphone.
    Permission(String),
    /// Stopped on request.
    Cancelled,
    /// A model's files are missing or the engine rejected them.
    Model(String),
    /// A model download failed.
    Download(String),
    Other(String),
}

impl VoiceError {
    /// Stable machine code (the webview's `{type: "error", code}`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoModel => "no_model",
            Self::NoEngine => "no_engine",
            Self::NoDevice(_) => "no_device",
            Self::Permission(_) => "permission",
            Self::Cancelled => "cancelled",
            Self::Model(_) => "model",
            Self::Download(_) => "download",
            Self::Other(_) => "internal",
        }
    }
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoModel => f.write_str("No speech model is installed: download one in Settings → Dictation"),
            Self::NoEngine => f.write_str("This build has no on-device speech engine"),
            Self::NoDevice(m) => write!(f, "No microphone: {m}"),
            Self::Permission(m) => write!(f, "Microphone access denied: {m}"),
            Self::Cancelled => f.write_str("Cancelled"),
            Self::Model(m) | Self::Download(m) | Self::Other(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for VoiceError {}
