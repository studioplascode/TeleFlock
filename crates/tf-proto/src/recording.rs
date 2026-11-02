//! Session recording: the user records their own tab(s) in the TeleFlock Browser panel (the
//! screencast's frames, their voice, the UI's log of what they did and what failed), reviews the
//! recording and sends it to an agent. Nothing leaves the device until the user sends it.
//!
//! The app core (`tf-client`, `recording` module) keeps each recording in
//! `<data_dir>/recordings/<id>/` and owns storage, the microphone, the video file and the
//! transcription; the UI owns the event log (opaque JSON values here) and the timeline. The video
//! (`recording.mov`) is QuickTime: the screencast's JPEGs as Photo-JPEG at a constant 10 fps (a
//! 100 ms slot whose picture did not change points at the previous frame's bytes) plus the voice
//! as 16 kHz mono 16-bit PCM, so `ffmpeg -ss T` returns the picture visible at T.
//!
//! Times (`t`, `startMs`/`endMs`, cuts) are ms of recording time: from
//! [`RecordingInfo::created_at`], pauses excluded.
//!
//! Limits: one recording at a time (`busy`); per recording 1 GiB or 60 minutes, all recordings
//! 2 GiB ([`RecordingList::budget`]). `recording.start` past the budget answers
//! `budget_exceeded`. The app core checks the limits of the recording that records every second,
//! whether or not appends come (a still page sends none, the voice still grows), and stops it at
//! one itself (state `processing`, [`crate::app::AppEvent::Recordings`]); `recording.append`
//! answers [`RecordingAppended::stop`] once a limit is reached, also after that stop.

use crate::Millis;

wire_enum! {
    /// * `recording`: `recording.append` takes frames, events and shots; the voice is recorded.
    /// * `paused`: recording time stands still until `recording.resume`.
    /// * `processing`: stopped; the video is written, then the voice transcribed.
    /// * `ready`: video and transcript are done; `recording.render` works.
    /// * `failed`: the video could not be written ([`RecordingInfo::message`]).
    pub enum RecordingState { Recording, Paused, Processing, Ready, Failed }
}

wire_enum! {
    /// * `on`: the microphone is (was) recorded.
    /// * `off`: the user recorded without voice.
    /// * `unavailable`: this build or device has no microphone capture (the message says so).
    /// * `failed`: the microphone could not start or delivered no audio (no device, permission
    ///   denied; the message says why).
    pub enum VoiceState { On, Off, Unavailable, Failed }
}

wire_struct! {
    pub struct RecordingVoice {
        pub state: VoiceState,
        pub message: Option<String>,
        /// Where the voice track starts in recording time (microphone start latency), ms. Known
        /// once audio flows.
        pub offset_ms: Option<u64>,
        /// Length of the voice track, ms. Known once stopped.
        pub duration_ms: Option<u64>,
    }
}

wire_enum! {
    /// * `none`: no voice to transcribe.
    /// * `waiting`: stopped, queued (one transcription runs at a time).
    /// * `running`: [`RecordingTranscript::progress`] tells how far.
    /// * `done`: [`RecordingTranscript::segments`].
    /// * `noModel`: no speech model is installed (Settings → Dictation); `recording.transcribe`
    ///   runs it again.
    /// * `unavailable`: this build has no speech engine.
    /// * `failed`: [`RecordingTranscript::message`]; `recording.transcribe` runs it again.
    pub enum TranscriptState { None, Waiting, Running, Done, NoModel, Unavailable, Failed }
}

wire_struct! {
    /// A transcribed stretch of the voice, in recording time (the voice track's own times plus
    /// [`RecordingVoice::offset_ms`]).
    pub struct TranscriptSegment {
        pub start_ms: u64,
        pub end_ms: u64,
        pub text: String,
    }
}

wire_struct! {
    pub struct RecordingTranscript {
        pub state: TranscriptState,
        /// 0–1 while running.
        pub progress: Option<f32>,
        pub message: Option<String>,
        #[serde(default)]
        pub segments: Vec<TranscriptSegment>,
    }
}

wire_struct! {
    pub struct RecordingInfo {
        /// `rec_` + 10 characters `[a-z0-9]`.
        pub id: String,
        pub title: String,
        /// Epoch ms of `recording.start`: t = 0 of every frame, event and segment.
        pub created_at: Millis,
        pub state: RecordingState,
        /// Recording time (pauses excluded), live while recording.
        pub duration_ms: u64,
        /// Distinct frames stored.
        pub frames: u32,
        pub shots: u32,
        pub events: u32,
        /// The recording's folder on disk.
        pub bytes: u64,
        /// The frames' size (the first frame's; every frame has it).
        pub width: Option<u32>,
        pub height: Option<u32>,
        pub voice: RecordingVoice,
        pub transcript: RecordingTranscript,
        /// `"recording.mov"` once written (for `recording.read`); absent while recording, and when
        /// there was neither a frame nor voice.
        pub video: Option<String>,
        pub video_bytes: Option<u64>,
        /// Why the recording `failed`.
        pub message: Option<String>,
        /// The UI's own document (`recording.update`), stored as given.
        #[ts(optional, type = "unknown")]
        pub doc: Option<serde_json::Value>,
    }
}

wire_struct! {
    /// `recording.list`, `recording.delete` and [`crate::app::AppEvent::Recordings`].
    pub struct RecordingList {
        /// Newest first.
        pub recordings: Vec<RecordingInfo>,
        /// All recordings on disk.
        pub bytes: u64,
        /// What all recordings may take (2 GiB).
        pub budget: u64,
    }
}

wire_struct! {
    /// `recording.start`: `busy` while another recording is recording or paused,
    /// `budget_exceeded` when the recordings already use the budget.
    pub struct RecordingStartParams {
        /// Absent: "Recording <date> <time>".
        pub title: Option<String>,
        /// Record the microphone (absent = true).
        pub voice: Option<bool>,
    }
}

wire_struct! {
    pub struct RecordingFrame {
        /// Recording time, ms; never before the previous frame (an older `t` counts as the
        /// previous frame's).
        pub t: u64,
        /// Base64 JPEG.
        pub data: String,
        /// Every frame of a recording has the first frame's size (`invalid_params` otherwise).
        pub width: u32,
        pub height: u32,
    }
}

wire_struct! {
    pub struct RecordingShot {
        /// `[A-Za-z0-9._-]`, at most 80, ending in `.jpg`, `.jpeg` or `.png`; the same name again
        /// replaces the shot.
        pub name: String,
        /// Base64 JPEG or PNG (as the name says).
        pub data: String,
    }
}

wire_struct! {
    /// `recording.append`: everything is checked before anything is written (`invalid_params`
    /// writes nothing).
    pub struct RecordingAppendParams {
        pub id: String,
        #[serde(default)]
        pub frames: Vec<RecordingFrame>,
        /// The UI's events, one `events.jsonl` line each, stored as given.
        #[serde(default)]
        #[ts(type = "unknown[]")]
        pub events: Vec<serde_json::Value>,
        #[serde(default)]
        pub shots: Vec<RecordingShot>,
    }
}

wire_struct! {
    pub struct RecordingAppended {
        /// The recording's folder on disk.
        pub bytes: u64,
        pub duration_ms: u64,
        /// A limit was reached (the sentence says which): the app core stopped the recording, or
        /// does within a second; `recording.stop` then answers the stopped recording. Frames
        /// past it are dropped.
        pub stop: Option<String>,
    }
}

wire_struct! {
    pub struct RecordingRef {
        pub id: String,
    }
}

wire_struct! {
    pub struct RecordingFrameRef {
        pub t: u64,
        pub size: u32,
    }
}

wire_struct! {
    pub struct RecordingShotRef {
        pub name: String,
        pub size: u64,
    }
}

wire_struct! {
    /// `recording.get`.
    pub struct RecordingDetail {
        pub info: RecordingInfo,
        /// `events.jsonl` in order.
        #[ts(type = "unknown[]")]
        pub events: Vec<serde_json::Value>,
        /// The distinct frames in order (`recording.frame` reads one by its index).
        pub frames: Vec<RecordingFrameRef>,
        /// By name.
        pub shots: Vec<RecordingShotRef>,
    }
}

wire_struct! {
    /// `recording.frame`: one frame by its index in [`RecordingDetail::frames`] →
    /// [`RecordingBytes`] (the whole JPEG).
    pub struct RecordingFrameParams {
        pub id: String,
        pub index: u32,
    }
}

wire_struct! {
    /// `recording.read`: a slice of one of the recording's files.
    pub struct RecordingReadParams {
        pub id: String,
        /// `recording.mov`, `voice.wav`, `shots/<name>` or `bundle/<render>/<name>`.
        pub file: String,
        pub offset: u64,
        /// At most 1 MiB.
        pub length: u32,
    }
}

wire_struct! {
    pub struct RecordingBytes {
        /// Base64.
        pub data: String,
        /// The whole file (frame).
        pub size: u64,
    }
}

wire_struct! {
    /// `recording.update`: absent fields stay.
    pub struct RecordingUpdateParams {
        pub id: String,
        pub title: Option<String>,
        #[ts(optional, type = "unknown")]
        pub doc: Option<serde_json::Value>,
    }
}

wire_struct! {
    /// A stretch of recording time left out, `[startMs, endMs)`.
    pub struct RecordingCut {
        pub start_ms: u64,
        pub end_ms: u64,
    }
}

wire_struct! {
    pub struct RecordingTextFile {
        /// File name in the render's folder: characters other than `[A-Za-z0-9._-]` become `_`.
        pub name: String,
        pub text: String,
    }
}

wire_struct! {
    /// `recording.render` (state `ready`): writes the bundle an agent gets into a folder of the
    /// render's own, `bundle/<render>` ([`RecordingBundle::dir`]), which stays until
    /// `recording.release` (or the next start of the app): sending the recording to several
    /// hosts at once renders it for each upload, and none writes over a file another reads.
    pub struct RecordingRenderParams {
        pub id: String,
        /// Left out of the video (trim and cuts); may overlap. Any cut: `recording.mov` in the
        /// render's folder without them, timed from the first kept ms; none: the video is the
        /// recording's own `recording.mov`.
        #[serde(default)]
        pub cuts: Vec<RecordingCut>,
        /// Written to the render's folder (timeline.md, timeline.json).
        #[serde(default)]
        pub files: Vec<RecordingTextFile>,
    }
}

wire_struct! {
    pub struct RecordingBundleFile {
        /// For `recording.read` (`recording.mov`, `bundle/<render>/<name>`).
        pub file: String,
        pub size: u64,
        /// Absolute path on this device.
        pub path: String,
    }
}

wire_struct! {
    pub struct RecordingBundle {
        /// The render's folder, `bundle/<render>`: `recording.release` frees it once its upload
        /// ended.
        pub dir: Option<String>,
        pub video: Option<RecordingBundleFile>,
        pub files: Vec<RecordingBundleFile>,
        /// Length of the video after the cuts.
        pub duration_ms: u64,
    }
}

wire_struct! {
    /// `recording.release`: the upload of a render ended (sent, failed or aborted); its folder
    /// goes. A folder that is gone already is fine.
    pub struct RecordingReleaseParams {
        pub id: String,
        /// [`RecordingBundle::dir`].
        pub dir: String,
    }
}
