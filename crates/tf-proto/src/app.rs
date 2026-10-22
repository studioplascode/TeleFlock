//! App-level types: host profiles, connection status, settings, tunnels, and the event
//! stream the app core pushes to the frontend.

use crate::model::{HostState, Notification, Pulse, StatePatch, ThinkingLevel};
use crate::session::SessionEvent;
use crate::term::TermEvent;
use crate::{ApiError, Millis};

wire_enum! {
    /// * `tailscaleSsh`: remote host over Tailscale SSH (no credentials; tailnet identity).
    /// * `local`: herdr on this desktop machine (Windows).
    /// * `wsl`: herdr inside a WSL distro on this desktop machine.
    /// * `demo`: built-in simulated host (handled entirely by the frontend).
    pub enum HostKind { TailscaleSsh, Local, Wsl, Demo }
}

wire_struct! {
    pub struct HostProfile {
        pub id: String,
        pub name: String,
        pub kind: HostKind,
        /// MagicDNS name or tailnet IP (`tailscaleSsh`).
        pub address: Option<String>,
        /// SSH user (`tailscaleSsh`); defaults to the tailnet policy's user mapping.
        pub user: Option<String>,
        pub port: Option<u16>,
        /// WSL distro name (`wsl`).
        pub distro: Option<String>,
        /// herdr session name (`default`).
        pub herdr_session: String,
        /// Accent hue for this host in multi-host views (CSS color).
        pub color: Option<String>,
        pub auto_connect: bool,
        /// Override for the relay port on the host.
        pub relay_port: Option<u16>,
    }
}

wire_enum! {
    /// `hostKey`: first connection to a host outside the tailnet address ranges; the user must
    /// confirm `ConnStatus.hostKey` with `hosts.trustKey` before the connection proceeds.
    pub enum ConnPhase {
        Idle, Connecting, Authenticating, AuthRequired, HostKey, Deploying, Starting, Online,
        Reconnecting, Offline, Error
    }
}

wire_struct! {
    pub struct HostKeyInfo {
        /// Resolved address the key was presented by.
        pub address: String,
        /// e.g. `ssh-ed25519`.
        pub algorithm: String,
        /// `SHA256:<base64>` (same format as `ssh-keygen -lf`).
        pub fingerprint: String,
    }
}

wire_struct! {
    pub struct ConnStatus {
        pub phase: ConnPhase,
        pub since: Millis,
        pub latency_ms: Option<u32>,
        /// Tailscale SSH check-mode URL the user must open to continue.
        pub auth_url: Option<String>,
        /// Human status line (e.g. `Uploading tf-hostd 0.1.0…`).
        pub message: Option<String>,
        pub error: Option<ApiError>,
        pub attempt: u32,
        pub next_retry_at: Option<Millis>,
        pub last_online_at: Option<Millis>,
        pub hostd_version: Option<String>,
        /// Unconfirmed host key (phase `hostKey`).
        pub host_key: Option<HostKeyInfo>,
    }
}

wire_struct! {
    pub struct HostStatusEntry {
        pub host_id: String,
        pub status: ConnStatus,
    }
}

wire_enum! {
    pub enum MotionPref { System, Full, Reduced }
}

wire_struct! {
    pub struct Settings {
        pub motion: MotionPref,
        pub notify_needs: bool,
        pub notify_finished: bool,
        pub notify_errors: bool,
        pub notify_sound: bool,
        /// `HH:MM` local time; notifications are silent between start and end.
        pub quiet_start: Option<String>,
        pub quiet_end: Option<String>,
        /// Android: keep host connections alive in a foreground service while backgrounded.
        pub keep_alive: bool,
        pub terminal_font_size: u16,
        pub default_model: Option<String>,
        pub default_thinking: Option<ThinkingLevel>,
        pub default_plan: bool,
        /// Device name shown as prompt author to other clients.
        pub device_name: String,
        /// Agents whose OS notifications are muted (`<hostId>::<agentId>` keys).
        #[serde(default)]
        pub muted_agents: Vec<String>,
        /// Saved agent presets for the new-agent / new-worktree / fan-out flows.
        #[serde(default)]
        pub templates: Vec<AgentTemplate>,
        /// Check GitHub releases on launch and install a newer version (Tauri app only).
        /// Settings files written before this field existed load with `true`.
        #[serde(default = "default_true")]
        pub auto_update: bool,
    }
}

fn default_true() -> bool {
    true
}

wire_struct! {
    /// A saved agent preset ("template"): model, thinking, plan mode and a prompt.
    pub struct AgentTemplate {
        pub id: String,
        pub name: String,
        pub description: Option<String>,
        /// `provider/id`.
        pub model: Option<String>,
        pub thinking: Option<ThinkingLevel>,
        pub plan: bool,
        /// Initial prompt (may be empty for a pure model preset).
        pub prompt: String,
    }
}

wire_struct! {
    pub struct TunnelInfo {
        pub tunnel_id: String,
        pub host_id: String,
        pub remote_host: String,
        pub remote_port: u16,
        pub local_port: u16,
        /// `http://127.0.0.1:<localPort>/`.
        pub url: String,
        pub opened_at: Millis,
    }
}

wire_enum! {
    pub enum DiagStatus { Ok, Warn, Fail, Skip }
}

wire_struct! {
    pub struct DiagStep {
        /// `resolve`, `tcp`, `ssh`, `auth`, `shell`, `herdr`, `omp`, `hostd`, `relay`, `attach`.
        pub id: String,
        pub label: String,
        pub status: DiagStatus,
        pub detail: Option<String>,
        pub ms: Option<u32>,
    }
}

wire_struct! {
    pub struct DiagReport {
        pub steps: Vec<DiagStep>,
    }
}

wire_struct! {
    pub struct WslDistro {
        pub name: String,
        pub is_default: bool,
        pub running: bool,
        pub version: u8,
    }
}

wire_struct! {
    pub struct AppCapabilities {
        pub local: bool,
        pub wsl: bool,
        pub tunnels: bool,
        pub notifications: bool,
        pub keep_alive: bool,
    }
}

wire_enum! {
    /// Self-update lifecycle of the app (Tauri shell, GitHub releases).
    pub enum UpdatePhase {
        Idle,
        Checking,
        UpToDate,
        /// A newer release with this platform's assets exists (`UpdateStatus.latest`).
        Available,
        Downloading,
        /// Windows: the installer is starting and the app exits. Android: the system install
        /// prompt is showing.
        Installing,
        /// Android: TeleFlock may not install apps yet; the "install unknown apps" settings
        /// screen was opened. The install resumes when the user comes back.
        NeedsPermission,
        Error,
    }
}

wire_struct! {
    pub struct UpdateStatus {
        /// Running app version (`X.Y.Z[-pre]`).
        pub current: String,
        /// This build looks for new releases (Windows, Android, Linux AppImage / .deb and macOS
        /// release builds).
        pub supported: bool,
        /// New versions are downloaded and installed by hand (macOS: no signed updater package):
        /// never installed automatically, and `app.updateInstall` opens the download instead.
        pub manual: bool,
        /// Why `supported` is false, for Settings (e.g. installed with pacman, or a debug build).
        pub unsupported_reason: Option<String>,
        pub phase: UpdatePhase,
        /// Newest release that is newer than `current` (no `v` prefix).
        pub latest: Option<String>,
        /// Download progress 0–100 while `downloading` (absent while the size is unknown).
        pub progress: Option<u8>,
        /// Last failure (`phase: error`), human readable.
        pub error: Option<String>,
        /// End of the last completed check.
        pub checked_at: Option<Millis>,
    }
}

wire_struct! {
    pub struct UpdateCheckParams {
        /// Launch check: runs once per process, only in release builds and only while
        /// `settings.autoUpdate` is on; a newer release is installed right away.
        #[serde(default)]
        pub launch: bool,
        /// Download and install right away when a newer release is found.
        #[serde(default)]
        pub install: bool,
    }
}

/// Everything the app core pushes to the frontend over its single event channel.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum AppEvent {
    Profiles { profiles: Vec<crate::app::HostProfile> },
    HostStatus { host_id: String, status: ConnStatus },
    HostSnapshot { host_id: String, rev: u64, state: HostState },
    HostPatch { host_id: String, rev: u64, ops: Vec<StatePatch> },
    Pulse { host_id: String, at: Millis, pulses: Vec<Pulse> },
    Session { host_id: String, agent_id: String, ev: SessionEvent },
    Term { host_id: String, term_id: String, ev: TermEvent },
    Notify { host_id: String, notification: Notification },
    /// Notifications that no longer need attention, on every surface (in-app toast and list,
    /// OS notification). `resolved`: the needs-you request they asked about was handled
    /// anywhere (answered here, on another device or in omp, cancelled, the agent stopped or
    /// went away), derived from host state. Otherwise they were read: acted on, opened, or
    /// dismissed in the OS.
    NotifyDone { host_id: String, ids: Vec<String>, resolved: bool },
    Tunnels { tunnels: Vec<TunnelInfo> },
    Settings { settings: Settings },
    /// Activated a notification action outside the app UI (Android notification button,
    /// Windows toast). The frontend navigates to the agent.
    OpenAgent { host_id: String, agent_id: String },
    /// Tray / notification "Answer next": the frontend opens the Answer-next HUD.
    AnswerNext,
    /// Self-update progress (emitted by the app shell; `app.updateStatus` returns the same).
    Update { status: UpdateStatus },
}
